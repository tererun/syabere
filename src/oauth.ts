import { randomBytes } from "crypto";
import { OAuth2Client } from "google-auth-library";
import { google } from "googleapis";
import { config } from "./config.ts";
import { safeEqual } from "./crypto.ts";
import {
  deleteTokens,
  getTokens,
  saveTokens,
} from "./token-store.ts";
import type { StoredTokens } from "./token-store.ts";

/**
 * Minimal scopes:
 *   - documents   : required to create/edit Google Docs
 *   - drive.file  : restricted to files this app creates; the user's
 *                   existing Drive content stays invisible to us
 *   - openid + userinfo.email : used ONLY to display "linked as <email>"
 *                   on the callback page so the user can confirm the
 *                   correct Google account got attached to their
 *                   Discord id. We do not store or transmit the email
 *                   anywhere else.
 */
const SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/drive.file",
];

const STATE_TTL_MS = 10 * 60 * 1000;

type PendingState = {
  userId: string;
  expiresAt: number;
};

/** In-memory only; state is one-shot with a 10-minute TTL. */
const pending = new Map<string, PendingState>();

function sweepPending(): void {
  const now = Date.now();
  for (const [k, v] of pending) {
    if (v.expiresAt <= now) pending.delete(k);
  }
}

function newClient(): OAuth2Client {
  return new OAuth2Client({
    clientId: config.oauth.clientId,
    clientSecret: config.oauth.clientSecret,
    redirectUri: config.oauth.redirectUri,
  });
}

export function buildAuthUrl(userId: string): string {
  sweepPending();
  // 32 bytes == 256 bits of entropy — far beyond what's necessary to prevent
  // CSRF, but cheap insurance.
  const state = randomBytes(32).toString("hex");
  pending.set(state, { userId, expiresAt: Date.now() + STATE_TTL_MS });
  return newClient().generateAuthUrl({
    access_type: "offline",
    // Force the consent screen so Google reliably issues a refresh_token
    // (otherwise it's only returned the first time the user ever authorizes).
    prompt: "consent",
    scope: SCOPES,
    state,
    include_granted_scopes: true,
  });
}

export type CallbackResult = {
  userId: string;
  email: string | null;
};

export async function handleCallback(
  code: string,
  state: string,
): Promise<CallbackResult> {
  sweepPending();
  // Find matching state via constant-time compare (mitigates timing oracles
  // against short-lived tokens in memory).
  let matched: { key: string; entry: PendingState } | null = null;
  for (const [k, v] of pending) {
    if (safeEqual(k, state)) {
      matched = { key: k, entry: v };
      break;
    }
  }
  if (!matched) throw new Error("invalid or expired oauth state");
  // One-shot: burn it before doing any network I/O.
  pending.delete(matched.key);
  if (matched.entry.expiresAt <= Date.now()) {
    throw new Error("invalid or expired oauth state");
  }

  const client = newClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error(
      "Google did not return a refresh_token. Revoke prior access at " +
        "https://myaccount.google.com/permissions and retry.",
    );
  }

  // Fetch the email so we can surface "linked as <you@example.com>" —
  // lets the user confirm nobody else's account got attached to their Discord id.
  client.setCredentials(tokens);
  let email: string | null = null;
  try {
    const oauth2 = google.oauth2({ version: "v2", auth: client });
    const info = await oauth2.userinfo.get();
    email = info.data.email ?? null;
  } catch (err) {
    console.error("[oauth] failed to fetch userinfo (non-fatal):", err);
  }

  const toSave: StoredTokens = {
    refresh_token: tokens.refresh_token,
    access_token: tokens.access_token ?? undefined,
    expiry_date: tokens.expiry_date ?? undefined,
    scope: tokens.scope ?? undefined,
    token_type: tokens.token_type ?? undefined,
    id_token: tokens.id_token ?? undefined,
    email: email ?? undefined,
  };
  await saveTokens(matched.entry.userId, toSave);
  return { userId: matched.entry.userId, email };
}

/**
 * Build an OAuth2Client for the given Discord user. Returns null if the user
 * has not linked their Google account. Auto-refreshed access tokens are
 * written back to disk via the 'tokens' event.
 */
export async function getUserAuth(
  userId: string,
): Promise<{ client: OAuth2Client; email: string | null } | null> {
  const tokens = await getTokens(userId);
  if (!tokens?.refresh_token) return null;

  const client = newClient();
  client.setCredentials({
    refresh_token: tokens.refresh_token,
    access_token: tokens.access_token,
    expiry_date: tokens.expiry_date,
    scope: tokens.scope,
    token_type: tokens.token_type,
    id_token: tokens.id_token,
  });

  client.on("tokens", (t) => {
    // Persist refreshed access tokens. Do NOT wipe refresh_token if missing.
    void saveTokens(userId, {
      refresh_token: t.refresh_token ?? tokens.refresh_token,
      access_token: t.access_token ?? undefined,
      expiry_date: t.expiry_date ?? undefined,
      scope: t.scope ?? undefined,
      token_type: t.token_type ?? undefined,
      id_token: t.id_token ?? undefined,
    }).catch((err) =>
      console.error("[oauth] failed to persist refreshed tokens:", err),
    );
  });

  return { client, email: tokens.email ?? null };
}

export async function revokeUser(userId: string): Promise<boolean> {
  const existing = await getUserAuth(userId);
  if (!existing) return false;
  try {
    await existing.client.revokeCredentials();
  } catch (err) {
    // Revocation may fail if the token is already invalid — proceed to wipe
    // local state anyway so the user isn't stuck.
    console.error("[oauth] revoke failed (removing local record anyway):", err);
  }
  await deleteTokens(userId);
  return true;
}
