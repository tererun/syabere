import { Transform } from "stream";
import type { TransformCallback } from "stream";
import { oggCrc32 } from "./ogg-crc.ts";

/**
 * Minimal in-process Ogg Opus muxer.
 *
 * Writes a valid Ogg Opus logical bitstream (RFC 7845) from a stream of raw
 * Opus packets. We hand-roll this instead of using prism-media's
 * OggLogicalBitstream because that class depends on `node-crc`, a napi-rs
 * native module with no Bun-compatible prebuild.
 *
 * Usage:
 *     opusStream.pipe(new OggOpusMuxer({ channelCount: 2, sampleRate: 48000 }))
 *                .pipe(ffmpeg.stdin)
 *
 * Input: one Opus packet per write (object-mode writable).
 * Output: raw bytes of successive Ogg pages.
 */
export interface OggOpusMuxerOptions {
  channelCount: number;
  sampleRate: number;
  preSkip?: number;
  outputGain?: number;
  /** Group up to this many opus packets into a single Ogg page. */
  maxPacketsPerPage?: number;
  /** Vendor string in OpusTags. Informational only. */
  vendor?: string;
}

const OGGS = Buffer.from("OggS");
const OPUS_HEAD_MAGIC = Buffer.from("OpusHead");
const OPUS_TAGS_MAGIC = Buffer.from("OpusTags");

/**
 * Opus TOC config (upper 5 bits of the first byte of each packet) →
 * frame duration in tenths of a millisecond (to avoid 2.5ms fractions).
 *
 * One opus packet can contain multiple frames (encoded in lower 2 bits of
 * TOC), but Discord always sends single-frame packets so we only need the
 * per-frame duration here.
 */
const FRAME_DURATION_TENTHS_MS: readonly number[] = [
  // 0-11  : SILK @ 8/12/16 kHz, frame sizes 10/20/40/60 ms
  100, 200, 400, 600,
  100, 200, 400, 600,
  100, 200, 400, 600,
  // 12-15 : Hybrid @ 24 kHz, 10/20 ms
  100, 200,
  100, 200,
  // 16-31 : CELT @ 8/16/24/48 kHz, 2.5/5/10/20 ms
  25, 50, 100, 200,
  25, 50, 100, 200,
  25, 50, 100, 200,
  25, 50, 100, 200,
];

function samplesPerFrame48k(toc: number): number {
  const config = (toc >> 3) & 0x1f;
  const tenthsMs = FRAME_DURATION_TENTHS_MS[config] ?? 200;
  // 48 samples/ms × (tenthsMs / 10) = 4.8 × tenthsMs
  return Math.round((tenthsMs * 48) / 10);
}

function buildOpusHead(opts: OggOpusMuxerOptions): Buffer {
  const buf = Buffer.alloc(19);
  OPUS_HEAD_MAGIC.copy(buf, 0);
  buf.writeUInt8(1, 8); // version
  buf.writeUInt8(opts.channelCount, 9);
  buf.writeUInt16LE(opts.preSkip ?? 0, 10);
  buf.writeUInt32LE(opts.sampleRate, 12);
  buf.writeInt16LE(opts.outputGain ?? 0, 16);
  buf.writeUInt8(0, 18); // channel mapping family (0 = mono/stereo)
  return buf;
}

function buildOpusTags(vendor: string): Buffer {
  const v = Buffer.from(vendor, "utf8");
  const buf = Buffer.alloc(8 + 4 + v.length + 4);
  OPUS_TAGS_MAGIC.copy(buf, 0);
  buf.writeUInt32LE(v.length, 8);
  v.copy(buf, 12);
  buf.writeUInt32LE(0, 12 + v.length); // user-comment list length
  return buf;
}

function lacingFor(packet: Buffer): number[] {
  const out: number[] = [];
  let remaining = packet.length;
  while (remaining >= 255) {
    out.push(255);
    remaining -= 255;
  }
  out.push(remaining);
  return out;
}

export class OggOpusMuxer extends Transform {
  private readonly serial: number;
  private readonly maxPackets: number;
  private readonly vendor: string;
  private readonly opts: OggOpusMuxerOptions;
  private pageSeq = 0;
  private granulePos = 0;
  private headersWritten = false;
  private pending: Buffer[] = [];

  constructor(opts: OggOpusMuxerOptions) {
    super({ writableObjectMode: true });
    this.opts = opts;
    this.maxPackets = opts.maxPacketsPerPage ?? 10;
    this.vendor = opts.vendor ?? "syabere";
    // Random serial number per stream so ffmpeg can distinguish streams.
    this.serial = (Math.random() * 0x1_0000_0000) >>> 0;
  }

  private writePage(
    packets: Buffer[],
    flags: { first: boolean; last: boolean; granulePos: bigint | number },
  ): void {
    const lacing: number[] = [];
    for (const p of packets) {
      const l = lacingFor(p);
      if (lacing.length + l.length > 255) {
        throw new Error("OggOpusMuxer: lacing overflow (packet aggregation too aggressive)");
      }
      lacing.push(...l);
    }

    const headerType = (flags.first ? 0x02 : 0) | (flags.last ? 0x04 : 0);
    const body = packets.length ? Buffer.concat(packets) : Buffer.alloc(0);
    const header = Buffer.alloc(27 + lacing.length);

    OGGS.copy(header, 0);
    header.writeUInt8(0, 4);
    header.writeUInt8(headerType, 5);

    const gp = BigInt(flags.granulePos);
    header.writeBigInt64LE(gp, 6);

    header.writeUInt32LE(this.serial, 14);
    header.writeUInt32LE(this.pageSeq++, 18);
    header.writeUInt32LE(0, 22); // CRC placeholder (must be zero during CRC calc)
    header.writeUInt8(lacing.length, 26);
    for (let i = 0; i < lacing.length; i++) {
      header.writeUInt8(lacing[i] ?? 0, 27 + i);
    }

    const page = Buffer.concat([header, body]);
    const crc = oggCrc32(page);
    page.writeUInt32LE(crc, 22);
    this.push(page);
  }

  private ensureHeaders(): void {
    if (this.headersWritten) return;
    this.headersWritten = true;
    this.writePage([buildOpusHead(this.opts)], { first: true, last: false, granulePos: 0 });
    this.writePage([buildOpusTags(this.vendor)], { first: false, last: false, granulePos: 0 });
  }

  private flushPending(last: boolean): void {
    if (this.pending.length === 0 && !last) return;
    const pkts = this.pending;
    this.pending = [];
    this.writePage(pkts, { first: false, last, granulePos: this.granulePos });
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    try {
      this.ensureHeaders();
      // Advance granule position by this packet's audio duration (always
      // measured at 48 kHz per RFC 7845 regardless of sample rate setting).
      this.granulePos += samplesPerFrame48k(chunk[0] ?? 0);
      this.pending.push(chunk);
      if (this.pending.length >= this.maxPackets) this.flushPending(false);
      cb();
    } catch (err) {
      cb(err as Error);
    }
  }

  override _flush(cb: TransformCallback): void {
    try {
      this.ensureHeaders();
      this.flushPending(true);
      cb();
    } catch (err) {
      cb(err as Error);
    }
  }
}
