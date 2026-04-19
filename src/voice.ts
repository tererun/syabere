import { EndBehaviorType } from "@discordjs/voice";
import type { VoiceConnection } from "@discordjs/voice";
import type { Guild } from "discord.js";
import { FFmpeg } from "prism-media";
import type { Duplex, Readable } from "stream";
import { GizirokuStream } from "./giziroku.ts";
import type { Segment } from "./giziroku.ts";
import type { Meeting } from "./meeting.ts";
import { OggOpusMuxer } from "./ogg-opus.ts";

type UserSession = {
  giziroku: GizirokuStream;
  closing: boolean;
};

/**
 * Bridges Discord per-user voice streams into per-user giziroku WebSocket
 * sessions.
 *
 * Audio pipeline (per speaking session):
 *   Discord Opus packet
 *     → OggOpusMuxer (ours, pure JS) : wraps raw Opus in Ogg pages
 *     → ffmpeg subprocess             : decodes, resamples 48kHz/stereo → 16kHz/mono
 *     → giziroku WebSocket
 *
 * We own the Ogg muxing because the only good npm implementation pulls in
 * node-crc, a napi-rs native dep that can't build under Bun without Rust.
 */
export class VoiceBridge {
  private readonly sessions = new Map<string, UserSession>();

  constructor(
    private readonly connection: VoiceConnection,
    private readonly guild: Guild,
    private readonly meeting: Meeting,
  ) {
    this.connection.receiver.speaking.on("start", (userId) => {
      this.startUserSession(userId).catch((err) => {
        console.error(`[voice] startUserSession(${userId}) failed:`, err);
      });
    });
  }

  private async startUserSession(userId: string): Promise<void> {
    if (this.sessions.has(userId)) return;

    const member = await this.guild.members.fetch(userId).catch(() => null);
    const displayName = member?.displayName ?? member?.user.username ?? userId;

    const opusStream = this.connection.receiver.subscribe(userId, {
      // End a speaking session only after 2.5s of continuous silence.
      // Shorter values fragment natural pauses into separate giziroku jobs
      // and very short chunks transcribe poorly (Whisper needs context).
      end: { behavior: EndBehaviorType.AfterSilence, duration: 2500 },
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

    const session: UserSession = { giziroku, closing: false };
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
      }
    };

    pipeline.on("end", () => void cleanup());
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
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(
      sessions.map(async (s) => {
        if (s.closing) return;
        s.closing = true;
        await s.giziroku.flushAndClose().catch(() => undefined);
      }),
    );
  }
}
