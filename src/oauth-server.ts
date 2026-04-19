import { config } from "./config.ts";
import { handleCallback } from "./oauth.ts";

/**
 * Local HTTP server that receives Google's OAuth authorization-code redirect.
 *
 * By default binds to 127.0.0.1 so the endpoint isn't reachable from the
 * network. If you front this with a reverse proxy, set OAUTH_SERVER_HOST
 * and make sure the proxy terminates TLS — the redirect_uri you register
 * with Google should be the public HTTPS URL.
 */
export function startOAuthServer(): void {
  Bun.serve({
    hostname: config.oauth.serverHost,
    port: config.oauth.serverPort,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method !== "GET" || url.pathname !== "/oauth/callback") {
        return new Response("not found", { status: 404 });
      }

      const error = url.searchParams.get("error");
      if (error) {
        // Google may also include error_description, but echoing it risks
        // reflecting attacker-controlled values — show a fixed message.
        return page(400, "連携に失敗しました。Discord に戻って再度 /login を実行してください。");
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state) {
        return page(400, "不正なコールバックです。");
      }

      try {
        const { email } = await handleCallback(code, state);
        const who = email ? htmlEscape(email) : "(アカウント情報を取得できませんでした)";
        return page(
          200,
          `<strong>${who}</strong> として Google アカウントを連携しました。<br>` +
            `このウィンドウを閉じ、Discord で <code>/start</code> を実行してください。`,
        );
      } catch (err) {
        // Deliberately do not reflect err.message to the response (it could
        // contain code/state fragments). Log server-side instead.
        console.error("[oauth] callback error:", err);
        return page(400, "連携に失敗しました。もう一度 /login からやり直してください。");
      }
    },
    error(err) {
      console.error("[oauth-server] internal error:", err);
      return new Response("internal error", { status: 500 });
    },
  });

  console.log(
    `[oauth] callback server listening on http://${config.oauth.serverHost}:${config.oauth.serverPort}`,
  );
}

function page(status: number, bodyHtml: string): Response {
  const html =
    `<!doctype html><html lang="ja"><head>` +
    `<meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="referrer" content="no-referrer">` +
    `<title>syabere</title>` +
    `<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:4em auto;padding:0 1em;line-height:1.7;color:#222}code{background:#f3f4f6;padding:2px 6px;border-radius:4px}</style>` +
    `</head><body><h1>syabere</h1><p>${bodyHtml}</p></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    },
  });
}

function htmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default: return c;
    }
  });
}
