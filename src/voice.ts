import { EndBehaviorType } from "@discordjs/voice";
import type { VoiceConnection } from "@discordjs/voice";
import type { Guild, VoiceBasedChannel } from "discord.js";
import { FFmpeg } from "prism-media";
import type { Duplex, Readable } from "stream";
import { GizirokuStream } from "./giziroku.ts";
import type { Segment } from "./giziroku.ts";
import type { Meeting } from "./meeting.ts";
import { OggOpusMuxer } from "./ogg-opus.ts";

type UserSession = {
  giziroku: GizirokuStream;
  opusStream: Readable;
  ogg: OggOpusMuxer;
  done: Promise<void>;
  closing: boolean;
};

/**
 * Bridges Discord per-user voice streams into per-user giziroku WebSocket
 * sessions.
 *
 * Audio pipeline (per user, lives for the whole meeting):
 *   Discord Opus packet
 *     → OggOpusMuxer (ours, pure JS) : wraps raw Opus in Ogg pages
 *     → ffmpeg subprocess             : decodes, resamples 48kHz/stereo → 16kHz/mono
 *     → giziroku WebSocket
 *
 * We use EndBehaviorType.Manual and keep one subscription per user for the
 * entire meeting. AfterSilence tore the stream down every 2.5s, which dropped
 * audio between a session closing and the next speaking.start firing — so the
 * earliest seconds of every speech burst were silently discarded.
 */
export class VoiceBridge {
  private readonly sessions = new Map<string, UserSession>();
  private readonly speakingHandler: (userId: string) => void;

  constructor(
    private readonly connection: VoiceConnection,
    private readonly guild: Guild,
    private readonly voiceChannel: VoiceBasedChannel,
    private readonly meeting: Meeting,
  ) {
    // Subscribe proactively for everyone already in the VC — speaking.start
    // only fires on a fresh silence→speech edge, so a user who was already
    // talking when the bot joined would otherwise never be captured.
    for (const member of this.voiceChannel.members.values()) {
      if (member.user.bot) continue;
      this.startUserSession(member.id).catch((err) => {
        console.error(`[voice] startUserSession(${member.id}) failed:`, err);
      });
    }

    this.speakingHandler = (userId) => {
      this.startUserSession(userId).catch((err) => {
        console.error(`[voice] startUserSession(${userId}) failed:`, err);
      });
    };
    this.connection.receiver.speaking.on("start", this.speakingHandler);
  }

  private async startUserSession(userId: string): Promise<void> {
    if (this.sessions.has(userId)) return;

    const member = await this.guild.members.fetch(userId).catch(() => null);
    if (member?.user.bot) return;
    const displayName = member?.displayName ?? member?.user.username ?? userId;

    const opusStream = this.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.Manual },
    });

    // One packet per Ogg page = ~20 ms of audio reaches ffmpeg immediately,
    // reducing startup latency for short speaking bursts.
    const ogg = new OggOpusMuxer({
      channelCount: 2,
      sampleRate: 48_000,
      maxPacketsPerPage: 1,
    });

    // NOTE: prism-media's FFmpeg appends a final "pipe:1" argument for us;
    // adding one here ourselves produces a second ambiguous output.
    const ffmpeg = new FFmpeg({
      args: [
        "-hide_banner",
        "-loglevel", "error",
        // Reduce input/output buffering so PCM starts flowing to giziroku
        // as soon as opus packets arrive instead of after ffmpeg's default
        // demuxer buffer (can be several seconds) fills.
        "-fflags", "nobuffer",
        "-flags", "low_delay",
        "-probesize", "32",
        "-analyzeduration", "0",
        "-f", "ogg",
        "-i", "pipe:0",
        "-ar", "16000",
        "-ac", "1",
        "-c:a", "pcm_s16le",
        "-f", "s16le",
        "-flush_packets", "1",
      ],
    });

    const giziroku = new GizirokuStream({
      onSegments: (segs) => this.handleSegments(userId, displayName, segs),
      onError: (err) => console.error(`[giziroku ${displayName}]`, err),
    });

    let resolveDone!: () => void;
    const done = new Promise<void>((r) => {
      resolveDone = r;
    });

    const session: UserSession = { giziroku, opusStream, ogg, done, closing: false };
    this.sessions.set(userId, session);

    // prism-media's FFmpeg is a Duplex at runtime but its shipped typings
    // erase the stream methods — cast once at the pipe boundary.
    const pipeline: Readable = opusStream.pipe(ogg).pipe(ffmpeg as unknown as Duplex);

    pipeline.on("data", (chunk: Buffer) => {
      giziroku.send(chunk);
    });

    const cleanup = async () => {
      if (session.closing) return;
      session.closing = true;
      try {
        await giziroku.flushAndClose();
      } finally {
        this.sessions.delete(userId);
        resolveDone();
      }
    };

    pipeline.on("end", () => void cleanup());
    pipeline.on("close", () => void cleanup());
    pipeline.on("error", (err) => {
      console.error(`[voice ${displayName}] pipeline error:`, err);
      void cleanup();
    });
    opusStream.on("error", (err: unknown) => {
      console.error(`[voice ${displayName}] opus stream error:`, err);
    });
  }

  private handleSegments(userId: string, displayName: string, segs: Segment[]): void {
    for (const seg of segs) {
      const text = seg.text.trim();
      if (!text) continue;
      this.meeting.addUtterance({
        kind: "speech",
        userId,
        displayName,
        text,
        at: new Date(),
      });
    }
  }

  async shutdown(): Promise<void> {
    this.connection.receiver.speaking.off("start", this.speakingHandler);
    const sessions = [...this.sessions.values()];
    await Promise.all(
      sessions.map(async (s) => {
        // opusStream.destroy() only emits 'close' — it does NOT propagate
        // EOF through pipe(), so ogg/ffmpeg would hang waiting for input
        // and pipeline 'end' would never fire. Unpipe the source, then
        // call ogg.end() so the Transform's _flush runs, propagating EOF
        // to ffmpeg's stdin → ffmpeg drains PCM → pipeline 'end' →
        // cleanup() → giziroku.flushAndClose.
        s.opusStream.unpipe();
        s.opusStream.destroy();
        s.ogg.end();
        await s.done;
      }),
    );
  }
}
