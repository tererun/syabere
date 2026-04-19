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
    this.bridge = new VoiceBridge(this.connection, this.guild, this);

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
    const label =
      u.kind === "text" ? `@${u.displayName} (チャット)` : `@${u.displayName}`;
    this.doc.append(`${label}: ${u.text}\n\n`);
  }

  async stop(): Promise<{ url: string; docId: string }> {
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

    // Drain the buffered appends so the summary sees the final utterances —
    // otherwise getPlainText() returns only what was already flushed to Docs
    // and Gemini summarizes a truncated transcript.
    await this.doc.flush();

    const transcript = await this.doc.getPlainText();
    let summary: string;
    try {
      summary = await summarize(transcript);
    } catch (err) {
      console.error("[gemini] summarization failed:", err);
      summary = "(要約の生成に失敗しました)";
    }
    await this.doc.finalize(summary);
    return { url: this.doc.docUrl, docId: this.doc.docId };
  }
}

function formatTitleDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
