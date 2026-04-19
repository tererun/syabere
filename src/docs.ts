import { google } from "googleapis";
import type { docs_v1, drive_v3 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { config } from "./config.ts";

const TRANSCRIPT_HEADER = "## 文字起こし\n\n";

/**
 * Google Docs writer scoped to one meeting, authenticated as a single
 * end-user via their OAuth2 credentials. The created document is owned by
 * that user and lives in their Drive — we never hold long-term ownership.
 *
 * Strategy:
 *   - create() makes a new doc, inserts "## 文字起こし\n\n" as the initial body.
 *   - append() queues text in-memory. A periodic flush (default 10s) sends
 *     one batchUpdate per interval, which keeps us well under the Docs write
 *     rate limit (~60/min/user) — ~6 req/min per active meeting.
 *   - finalize() stops the timer, drains the buffer, then prepends
 *     "## 要約\n<summary>\n\n" at index 1.
 */
export class MeetingDoc {
  private readonly docs: docs_v1.Docs;
  private readonly drive: drive_v3.Drive;
  private readonly folderId: string | null;
  private _docId = "";
  private _docUrl = "";
  private buffer = "";
  private flushTimer: NodeJS.Timeout | null = null;
  /** Chain of in-flight flushes so writes are strictly serialized. */
  private flushing: Promise<void> = Promise.resolve();

  constructor(auth: OAuth2Client, folderId: string | null = null) {
    this.docs = google.docs({ version: "v1", auth });
    this.drive = google.drive({ version: "v3", auth });
    this.folderId = folderId;
  }

  get docId(): string {
    return this._docId;
  }

  get docUrl(): string {
    return this._docUrl;
  }

  async create(title: string): Promise<string> {
    const res = await this.docs.documents.create({ requestBody: { title } });
    const id = res.data.documentId;
    if (!id) throw new Error("Docs API did not return a documentId");
    this._docId = id;
    this._docUrl = `https://docs.google.com/document/d/${id}/edit`;

    // Move the doc into the user's chosen folder. We created the file so
    // `drive.file` scope is sufficient to re-parent it.
    if (this.folderId) {
      try {
        await this.drive.files.update({
          fileId: id,
          addParents: this.folderId,
          removeParents: "root",
          fields: "id, parents",
        });
      } catch (err) {
        console.error(
          `[docs] failed to move doc into folder ${this.folderId} ` +
            `(user may lack access to that folder). Doc remains in Drive root.`,
          err,
        );
      }
    }

    await this.docs.documents.batchUpdate({
      documentId: id,
      requestBody: {
        requests: [
          { insertText: { location: { index: 1 }, text: TRANSCRIPT_HEADER } },
        ],
      },
    });

    this.flushTimer = setInterval(() => {
      this.flushNow().catch((err) => console.error("[docs] flush error:", err));
    }, config.docs.flushIntervalMs);

    return this._docUrl;
  }

  append(text: string): void {
    if (!text) return;
    this.buffer += text;
  }

  async flush(): Promise<void> {
    await this.flushNow();
  }

  private async flushNow(): Promise<void> {
    const next = this.flushing.then(async () => {
      if (!this.buffer) return;
      const text = this.buffer;
      this.buffer = "";
      try {
        const endIndex = await this.getEndIndex();
        await this.docs.documents.batchUpdate({
          documentId: this._docId,
          requestBody: {
            requests: [{ insertText: { location: { index: endIndex }, text } }],
          },
        });
      } catch (err) {
        // Put the text back so we retry on the next tick rather than losing it.
        this.buffer = text + this.buffer;
        throw err;
      }
    });
    this.flushing = next.catch(() => undefined);
    await next;
  }

  private async getEndIndex(): Promise<number> {
    const doc = await this.docs.documents.get({ documentId: this._docId });
    const content = doc.data.body?.content;
    if (!content?.length) return 1;
    const last = content[content.length - 1];
    // Docs API: body.endIndex points *past* the trailing newline of the final
    // paragraph. Inserting at (endIndex - 1) appends inside the document body.
    return Math.max(1, (last?.endIndex ?? 2) - 1);
  }

  async finalize(summary: string): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flushNow();

    const text = `## 要約\n${summary.trim()}\n\n`;
    await this.docs.documents.batchUpdate({
      documentId: this._docId,
      requestBody: {
        requests: [{ insertText: { location: { index: 1 }, text } }],
      },
    });
  }

  async getPlainText(): Promise<string> {
    const doc = await this.docs.documents.get({ documentId: this._docId });
    let out = "";
    for (const el of doc.data.body?.content ?? []) {
      const para = el.paragraph;
      if (!para?.elements) continue;
      for (const pe of para.elements) {
        if (pe.textRun?.content) out += pe.textRun.content;
      }
    }
    return out;
  }
}
