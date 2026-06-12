// auth.mjs — OAuth 2.0 (PKCE) flow for minting X refresh tokens. Zero-dep.
//
// Two consumers, one source of truth:
//   - bin/x-auth.mjs (CLI)            — one-time terminal bootstrap
//   - mcp/server.mjs `authorize` tool — in-chat bootstrap: Claude hands the user
//     a link, the localhost callback exchanges the code and persists the token.
//
// Verified against docs.x.com (OAuth 2.0 authorization-code):
//   authorize:  https://x.com/i/oauth2/authorize
//   token:      https://api.x.com/2/oauth2/token
//   PKCE:       code_challenge_method=S256
//   confidential client (has secret): HTTP Basic auth on the token exchange.

import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";

export const AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
export const TOKEN_URL = "https://api.x.com/2/oauth2/token";
// media.write is required for image upload (POST /2/media/upload); offline.access => refresh token.
export const SCOPES = "tweet.read tweet.write users.read media.write offline.access";

export const b64url = (buf) => buf.toString("base64url");

export function generatePkce() {
  const codeVerifier = b64url(randomBytes(48)); // 64 base64url chars, within the 43–128 spec range
  const codeChallenge = b64url(createHash("sha256").update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

export function buildAuthorizeUrl({ clientId, redirectUri, scope, state, codeChallenge }) {
  const u = new URL(AUTHORIZE_URL);
  u.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  }).toString();
  return u.toString();
}

export function buildTokenExchangeBody({ code, redirectUri, codeVerifier, clientId }) {
  return new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
    client_id: clientId,
  });
}

export async function exchangeCode({ code, redirectUri, codeVerifier, clientId, clientSecret, fetchImpl = fetch }) {
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      // Confidential client: Basic auth = base64(client_id:client_secret).
      Authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
    },
    body: buildTokenExchangeBody({ code, redirectUri, codeVerifier, clientId }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
  return res.json();
}

const page = (title, body) =>
  `<!doctype html><meta charset="utf-8"><title>x-poster</title><body style="font-family:system-ui;max-width:34rem;margin:4rem auto;line-height:1.5"><h2>${title}</h2><p>${body}</p></body>`;

// ---------------------------------------------------------------------------
// startAuthSession — one-shot localhost callback listener.
//
// Resolves once listening, with { authorizeUrl, redirectUri, close }. When the
// user approves on X, the callback exchanges the code, calls onToken(refreshToken)
// (persist it there), shows a success page, and shuts the listener down. The
// listener also dies on its own after ttlMs so an abandoned authorize can't
// leave a port open. onDone({ok, error?}) fires once, after success or failure.
//
// port 0 binds an ephemeral port (tests). Real use must pass the port whose
// /callback URL is registered in the X app (default 8723).
// ---------------------------------------------------------------------------

export function startAuthSession({
  clientId,
  clientSecret,
  port = 8723,
  onToken,
  onDone,
  fetchImpl = fetch,
  ttlMs = 10 * 60 * 1000,
}) {
  const { codeVerifier, codeChallenge } = generatePkce();
  const state = b64url(randomBytes(16));
  let settled = false;

  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
      const url = new URL(req.url, redirectUri);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end("not found");
        return;
      }
      const finish = (result) => {
        server.close();
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          onDone?.(result);
        }
      };
      const err = url.searchParams.get("error");
      if (err) {
        res.writeHead(400, { "Content-Type": "text/html" }).end(
          page("Authorization failed", `X returned: <b>${err}</b>. Go back to Claude and try again. You can close this tab.`),
        );
        return finish({ ok: false, error: `authorize error: ${err}` });
      }
      if (url.searchParams.get("state") !== state) {
        res.writeHead(400, { "Content-Type": "text/html" }).end(
          page("Authorization failed", "State mismatch (stale or forged link). Go back to Claude and run authorize again."),
        );
        return finish({ ok: false, error: "state mismatch" });
      }
      try {
        const code = url.searchParams.get("code");
        const tok = await exchangeCode({ code, redirectUri, codeVerifier, clientId, clientSecret, fetchImpl });
        if (!tok.refresh_token) {
          throw new Error("no refresh_token returned — is the offline.access scope enabled on your X app?");
        }
        await onToken(tok.refresh_token);
        res.writeHead(200, { "Content-Type": "text/html" }).end(
          page("Authorized ✓", "x-poster is connected to your X account. You can close this tab and go back to Claude."),
        );
        finish({ ok: true });
      } catch (e) {
        res.writeHead(500, { "Content-Type": "text/html" }).end(
          page("Authorization failed", `${e.message}. Go back to Claude and try again.`),
        );
        finish({ ok: false, error: e.message });
      }
    });

    const timer = setTimeout(() => {
      server.close();
      if (!settled) {
        settled = true;
        onDone?.({ ok: false, error: "authorize timed out — run the authorize tool again" });
      }
    }, ttlMs);
    timer.unref?.();

    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
      const authorizeUrl = buildAuthorizeUrl({ clientId, redirectUri, scope: SCOPES, state, codeChallenge });
      resolve({
        authorizeUrl,
        redirectUri,
        close: () => {
          clearTimeout(timer);
          server.close();
        },
      });
    });
  });
}
