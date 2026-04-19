/**
 * OGG container CRC-32 (RFC 3533 §4).
 *
 * Pure-JS so we don't need prism-media's `node-crc` dependency (which is a
 * napi-rs native module requiring a Rust toolchain to build on Bun).
 *
 * Polynomial 0x04C11DB7, init 0, no input/output reflection, no XOR-out.
 */
const TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let r = n << 24;
    for (let k = 0; k < 8; k++) {
      r = ((r & 0x80000000) ? ((r << 1) ^ 0x04c11db7) : (r << 1)) >>> 0;
    }
    t[n] = r >>> 0;
  }
  return t;
})();

export function oggCrc32(buf: Buffer): number {
  let r = 0;
  for (let i = 0; i < buf.length; i++) {
    r = (((r << 8) >>> 0) ^ (TABLE[((r >>> 24) ^ (buf[i] ?? 0)) & 0xff] ?? 0)) >>> 0;
  }
  return r >>> 0;
}
