import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "crypto";
import { config } from "./config.ts";

/**
 * AES-256-GCM envelope for at-rest token storage.
 *
 * - 12-byte random IV per record (never reused with the same key)
 * - 16-byte GCM authentication tag
 * - AAD binds the ciphertext to a specific Discord user id, so swapping
 *   records between users in the store file fails authentication.
 */
export type SealedRecord = {
  v: 1;
  iv: string; // base64
  tag: string; // base64
  ct: string; // base64
};

export function seal(plaintext: string, aad: string): SealedRecord {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", config.oauth.encryptionKey, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ct: ct.toString("base64"),
  };
}

export function open(record: SealedRecord, aad: string): string {
  if (record.v !== 1) throw new Error("unsupported sealed record version");
  const iv = Buffer.from(record.iv, "base64");
  const tag = Buffer.from(record.tag, "base64");
  const ct = Buffer.from(record.ct, "base64");
  if (iv.length !== 12 || tag.length !== 16) {
    throw new Error("malformed sealed record");
  }
  const decipher = createDecipheriv("aes-256-gcm", config.oauth.encryptionKey, iv);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}

/** Constant-time comparison for short secrets (OAuth state, etc.). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
