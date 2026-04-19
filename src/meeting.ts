import type { Guild, Message, VoiceBasedChannel } from "discord.js";
import type { VoiceConnection } from "@discordjs/voice";
import type { OAuth2Client } from "google-auth-library";
import { MeetingDoc } from "./docs.ts";
import { VoiceBridge } from "./voice.ts";
import { summarize } from "./gemini.ts";

export type Utterance = {
  kind: "speech" | "text";
  userId: string;
  displayName: string;
  text: string;
  at: Date;
};

export class Meeting {
  private readonly doc: MeetingDoc;
  private bridge: VoiceBridge | null = null;
  private msgHandler: ((m: Message) => void) | null = null;
  private disposed = false;
  /** kind:userId of the previous utterance; used to merge consecutive same-speaker segments. */
  private lastKey: string | null = null;

  constructor(
    private readonly guild: Guild,
    private readonly voiceChannel: VoiceBasedChannel,
    private readonly connection: VoiceConnection,
    /** The Discord user who started this meeting — their Drive receives the doc. */
    public readonly ownerUserId: string,
    auth: OAuth2Client,
    folderId: string | null = null,
  ) {
    this.doc = new MeetingDoc(auth, folderId);
  }

  async start(): Promise<string> {
    const now = new Date();
    const title = `会議録 ${this.voiceChannel.name} ${formatTitleDate(now)}`;
    const url = await this.doc.create(title);
    this.bridge = new VoiceBridge(this.connection, this.guild, this.voiceChannel, this);

    this.msgHandler = (m) => {
      if (m.channelId !== this.voiceChannel.id) return;
      if (m.author.bot) return;
      if (!m.content) return;
      const displayName = m.member?.displayName ?? m.author.username;
      this.addUtterance({
        kind: "text",
        userId: m.author.id,
        displayName,
        text: m.content,
        at: m.createdAt,
      });
    };
    this.guild.client.on("messageCreate", this.msgHandler);

    return url;
  }

  addUtterance(u: Utterance): void {
    const currentKey = `${u.kind}:${u.userId}`;
    if (currentKey === this.lastKey) {
      this.doc.append(` ${u.text}`);
      return;
    }
    const label =
      u.kind === "text" ? `@${u.displayName} (チャット)` : `@${u.displayName}`;
    const prefix = this.lastKey === null ? "" : "\n\n";
    this.doc.append(`${prefix}${label}: ${u.text}`);
    this.lastKey = currentKey;
  }

  /**
   * Stop recording: detach Discord handlers, close the audio pipeline, flush
   * any trailing transcript into the Doc. Cheap and fast — safe to await
   * before replying to the `/stop` interaction. The Gemini summary step is
   * deliberately NOT run here; call {@link finalizeWithSummary} in the
   * background after replying.
   */
  async stopRecording(): Promise<{ url: string; docId: string }> {
    if (this.disposed) return { url: this.doc.docUrl, docId: this.doc.docId };
    this.disposed = true;

    if (this.msgHandler) {
      this.guild.client.off("messageCreate", this.msgHandler);
      this.msgHandler = null;
    }

    if (this.bridge) {
      await this.bridge.shutdown();
      this.bridge = null;
    }

    try {
      this.connection.destroy();
    } catch {
      // already destroyed
    }

    // Let any trailing partial results land before we snapshot the doc.
    await sleep(3_000);

    // Drain the buffered appends so the full transcript is durable in Docs
    // even if the summary step fails or the process is killed.
    await this.doc.flush();

    return { url: this.doc.docUrl, docId: this.doc.docId };
  }

  /**
   * Generate the Gemini summary and prepend it at index=1 in the Doc. Slow
   * (network + LLM). Run this in the background after {@link stopRecording}
   * so the `/stop` reply isn't blocked on the LLM.
   */
  async finalizeWithSummary(): Promise<void> {
    const transcript = await this.doc.getPlainText();
    let summary: string;
    try {
      summary = await summarize(transcript);
    } catch (err) {
      console.error("[gemini] summarization failed:", err);
      summary = "(要約の生成に失敗しました)";
    }
    await this.doc.finalize(summary);
  }

  /** Convenience: full shutdown (recording stop + summary). Used by SIGINT. */
  async stop(): Promise<{ url: string; docId: string }> {
    const res = await this.stopRecording();
    await this.finalizeWithSummary();
    return res;
  }
}

function formatTitleDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
