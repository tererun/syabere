import WebSocket from "ws";
import { config } from "./config.ts";

export type Segment = {
  start: number;
  end: number;
  text: string;
};

type PartialMessage = {
  type: "partial";
  language?: string;
  offset?: number;
  text?: string;
  segments?: Segment[];
};

type SilenceMessage = { type: "silence"; offset?: number; duration?: number };
type FinalMessage = { type: "final" };

type ServerMessage = PartialMessage | SilenceMessage | FinalMessage;

export type GizirokuHandlers = {
  onSegments: (segs: Segment[]) => void;
  onError?: (err: Error) => void;
  onFinal?: () => void;
};

/**
 * One WebSocket session per speaker. Accepts 16kHz mono 16-bit LE PCM.
 * Buffers payloads until the socket is open, then streams them through.
 */
export class GizirokuStream {
  private ws: WebSocket;
  private opened = false;
  private closed = false;
  private pending: Buffer[] = [];
  private finalSignaled = false;

  constructor(private readonly handlers: GizirokuHandlers) {
    const url = new URL(`${config.giziroku.wsUrl}/stream/transcribe`);
    if (config.giziroku.apiKey) url.searchParams.set("api_key", config.giziroku.apiKey);
    if (config.giziroku.language) url.searchParams.set("language", config.giziroku.language);
    if (config.giziroku.initialPrompt) {
      url.searchParams.set("initial_prompt", config.giziroku.initialPrompt);
    }

    this.ws = new WebSocket(url.toString(), { maxPayload: 0 });

    this.ws.on("open", () => {
      this.opened = true;
      for (const buf of this.pending) {
        try {
          this.ws.send(buf);
        } catch (err) {
          this.fail(err);
          return;
        }
      }
      this.pending = [];
    });

    this.ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as ServerMessage;
        if (process.env.GIZIROKU_DEBUG) {
          console.log("[giziroku]", JSON.stringify(msg));
        }
        if (msg.type === "partial" && msg.segments?.length) {
          this.handlers.onSegments(msg.segments);
        } else if (msg.type === "final") {
          this.finalSignaled = true;
          this.handlers.onFinal?.();
        }
      } catch (err) {
        this.fail(err);
      }
    });

    this.ws.on("error", (err) => this.fail(err));
    this.ws.on("close", () => {
      this.closed = true;
      if (!this.finalSignaled) this.handlers.onFinal?.();
    });
  }

  private fail(err: unknown) {
    const e = err instanceof Error ? err : new Error(String(err));
    this.handlers.onError?.(e);
  }

  send(pcm: Buffer): void {
    if (this.closed) return;
    if (!this.opened) {
      this.pending.push(pcm);
      return;
    }
    try {
      this.ws.send(pcm);
    } catch (err) {
      this.fail(err);
    }
  }

  /** Send `flush`, wait briefly for `final`, then close. */
  async flushAndClose(timeoutMs = 15_000): Promise<void> {
    if (this.closed) return;
    if (!this.opened) {
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        this.ws.once("open", done);
        this.ws.once("error", done);
        this.ws.once("close", done);
      });
    }
    if (this.closed) return;

    try {
      this.ws.send("flush");
    } catch {
      // ignore — will close below
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          this.ws.close();
        } catch {}
        resolve();
      }, timeoutMs);
      this.ws.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
