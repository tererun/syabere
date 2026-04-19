import "dotenv/config";

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function optNum(name: string, def: number): number {
  const v = process.env[name];
  if (!v) return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Invalid number for env ${name}: ${v}`);
  return n;
}

function reqKey(name: string, bytes: number): Buffer {
  const raw = req(name);
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== bytes) {
    throw new Error(
      `env ${name} must be base64-encoded ${bytes} bytes (got ${buf.length}). ` +
        `Generate one with: bun -e "console.log(require('crypto').randomBytes(${bytes}).toString('base64'))"`,
    );
  }
  return buf;
}

export const config = {
  discord: {
    token: req("DISCORD_TOKEN"),
    clientId: req("DISCORD_CLIENT_ID"),
    /** Optional: when set, slash commands are registered to this guild only (fast iteration). */
    guildId: process.env.DISCORD_GUILD_ID,
  },
  giziroku: {
    wsUrl: process.env.GIZIROKU_WS_URL ?? "ws://localhost:8000",
    apiKey: process.env.GIZIROKU_API_KEY ?? "",
    language: process.env.GIZIROKU_LANGUAGE ?? "ja",
    initialPrompt: process.env.GIZIROKU_INITIAL_PROMPT ?? "",
  },
  oauth: {
    clientId: req("GOOGLE_OAUTH_CLIENT_ID"),
    clientSecret: req("GOOGLE_OAUTH_CLIENT_SECRET"),
    /** Must exactly match what you registered in Google Cloud Console. */
    redirectUri: req("GOOGLE_OAUTH_REDIRECT_URI"),
    /** Host the local callback server binds to. Default 127.0.0.1 (localhost only). */
    serverHost: process.env.OAUTH_SERVER_HOST ?? "127.0.0.1",
    serverPort: optNum("OAUTH_SERVER_PORT", 3000),
    tokenStorePath: process.env.TOKEN_STORE_PATH ?? "./.data/google-tokens.json",
    /** 32-byte AES-256-GCM key, base64 encoded. Required. */
    encryptionKey: reqKey("TOKEN_ENCRYPTION_KEY", 32),
  },
  docs: {
    flushIntervalMs: optNum("DOCS_FLUSH_INTERVAL_MS", 10_000),
    /** Default Drive folder for meeting docs. Users can override via /folder. */
    defaultFolderId: process.env.GOOGLE_DOCS_FOLDER_ID || null,
  },
  gemini: {
    apiKey: req("GEMINI_API_KEY"),
    model: process.env.GEMINI_MODEL ?? "gemini-2.5-flash",
  },
};
