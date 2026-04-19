import { chmod, mkdir, readFile, rename, writeFile } from "fs/promises";
import { dirname } from "path";
import { config } from "./config.ts";
import { open, seal } from "./crypto.ts";
import type { SealedRecord } from "./crypto.ts";

/**
 * Tokens we persist per Discord user. `refresh_token` is the sensitive
 * long-lived credential; the rest we just cache so we don't pointlessly
 * refresh.
 */
export type StoredTokens = {
  refresh_token: string;
  access_token?: string;
  expiry_date?: number;
  scope?: string;
  token_type?: string;
  id_token?: string;
  /** Google account email (fetched on login for audit/visibility). */
  email?: string;
  /** Optional Drive folder ID where meeting docs should be placed. */
  folderId?: string;
};

type FileShape = {
  version: 1;
  records: Record<string, SealedRecord>;
};

const EMPTY: FileShape = { version: 1, records: {} };

let cache: FileShape | null = null;
/** Serialize writes so concurrent saves don't race the temp-file rename. */
let writing: Promise<void> = Promise.resolve();

async function load(): Promise<FileShape> {
  if (cache) return cache;
  try {
    const raw = await readFile(config.oauth.tokenStorePath, "utf8");
    const parsed = JSON.parse(raw) as FileShape;
    if (parsed.version !== 1 || typeof parsed.records !== "object") {
      throw new Error("invalid token store shape");
    }
    cache = parsed;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      cache = { ...EMPTY, records: {} };
    } else {
      throw err;
    }
  }
  return cache;
}

async function persist(): Promise<void> {
  if (!cache) return;
  const dir = dirname(config.oauth.tokenStorePath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // best-effort: ensure the directory is 0700 even if it already existed
  try { await chmod(dir, 0o700); } catch {}
  const tmp = `${config.oauth.tokenStorePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(cache), { mode: 0o600 });
  await rename(tmp, config.oauth.tokenStorePath);
  try { await chmod(config.oauth.tokenStorePath, 0o600); } catch {}
}

export async function getTokens(userId: string): Promise<StoredTokens | null> {
  const store = await load();
  const rec = store.records[userId];
  if (!rec) return null;
  try {
    const plaintext = open(rec, userId);
    return JSON.parse(plaintext) as StoredTokens;
  } catch (err) {
    console.error(
      `[token-store] failed to decrypt record for user ${userId}. ` +
        `Key rotated or file tampered? Dropping record.`,
    );
    // Remove the corrupted record so subsequent runs don't repeat the error.
    delete store.records[userId];
    writing = writing.then(() => persist()).catch(() => undefined);
    await writing;
    return null;
  }
}

export async function saveTokens(
  userId: string,
  next: Partial<StoredTokens>,
): Promise<void> {
  const store = await load();
  const prior = await getTokens(userId);
  // Never accidentally overwrite refresh_token with undefined when Google
  // omits it on a refresh-token grant.
  const merged: StoredTokens = {
    refresh_token: next.refresh_token ?? prior?.refresh_token ?? "",
    access_token: next.access_token ?? prior?.access_token,
    expiry_date: next.expiry_date ?? prior?.expiry_date,
    scope: next.scope ?? prior?.scope,
    token_type: next.token_type ?? prior?.token_type,
    id_token: next.id_token ?? prior?.id_token,
    email: next.email ?? prior?.email,
    folderId: next.folderId ?? prior?.folderId,
  };
  if (!merged.refresh_token) {
    throw new Error("saveTokens called without a refresh_token and none was cached");
  }
  store.records[userId] = seal(JSON.stringify(merged), userId);
  writing = writing.then(() => persist());
  await writing;
}

/**
 * Set or clear the user's preferred Drive folder for meeting docs.
 * Returns the updated record, or null if the user has no stored tokens.
 */
export async function setFolderId(
  userId: string,
  folderId: string | null,
): Promise<StoredTokens | null> {
  const prior = await getTokens(userId);
  if (!prior) return null;
  const next: StoredTokens = { ...prior };
  if (folderId === null) {
    delete next.folderId;
  } else {
    next.folderId = folderId;
  }
  const store = await load();
  store.records[userId] = seal(JSON.stringify(next), userId);
  writing = writing.then(() => persist());
  await writing;
  return next;
}

export async function deleteTokens(userId: string): Promise<void> {
  const store = await load();
  if (!(userId in store.records)) return;
  delete store.records[userId];
  writing = writing.then(() => persist());
  await writing;
}
