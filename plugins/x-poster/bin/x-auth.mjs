#!/usr/bin/env node
// x-auth.mjs — ONE-TIME OAuth 2.0 (PKCE) bootstrap to mint an X refresh token.
//
// Why this exists: x-post.mjs posts as YOU, which needs a user-context token.
// An app-only bearer token can't post. This runs the authorization-code-with-PKCE
// flow once, you click "Authorize" in the browser, and it prints X_REFRESH_TOKEN
// for you to paste into your env file. After that, x-post.mjs refreshes access tokens on its own.
//
// Verified against docs.x.com (OAuth 2.0 authorization-code):
//   authorize:  https://x.com/i/oauth2/authorize
//   token:      https://api.x.com/2/oauth2/token
//   scopes:     tweet.read tweet.write users.read media.write offline.access
//               (offline.access => refresh_token; media.write => image upload)
//   PKCE:       code_challenge_method=S256
//   confidential client (has secret): HTTP Basic auth on the token exchange.
//
// Prereq (one portal edit): in your X app's "User authentication settings", set App type =
//   Web App / Confidential client and add the EXACT redirect URI below to its Callback URLs.
//
// Usage:
//   node --env-file=./your.env x-auth.mjs
//     (reads X_CLIENT_ID, X_CLIENT_SECRET; optional X_AUTH_PORT / X_REDIRECT_URI)

import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

const AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
const TOKEN_URL = "https://api.x.com/2/oauth2/token";
// media.write is required for image upload (POST /2/media/upload); offline.access => refresh token.
const SCOPES = "tweet.read tweet.write users.read media.write offline.access";

// ---- Pure helpers (unit-tested in bin/_tests/x-auth.test.mjs) ----

const b64url = (buf) => buf.toString("base64url");

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

// ---- Side-effecting flow (not exercised by tests) ----

async function exchangeCode({ code, redirectUri, codeVerifier, clientId, clientSecret }) {
  const res = await fetch(TOKEN_URL, {
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

function openBrowser(url) {
  // macOS `open`; fall back to printing if it fails.
  try {
    spawn("open", [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* user opens the printed URL manually */
  }
}

async function main() {
  const clientId = process.env.X_CLIENT_ID;
  const clientSecret = process.env.X_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error("ERROR: X_CLIENT_ID and X_CLIENT_SECRET must be set. Run with: node --env-file=.env bin/x-auth.mjs");
    process.exit(2);
  }

  const port = Number(process.env.X_AUTH_PORT || 8723);
  const redirectUri = process.env.X_REDIRECT_URI || `http://127.0.0.1:${port}/callback`;
  const { codeVerifier, codeChallenge } = generatePkce();
  const state = b64url(randomBytes(16));
  const authorizeUrl = buildAuthorizeUrl({ clientId, redirectUri, scope: SCOPES, state, codeChallenge });

  console.error(`\nMake sure this EXACT redirect URI is registered in your X App's callback URLs:\n  ${redirectUri}\n`);

  const refreshToken = await new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, redirectUri);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end("not found");
        return;
      }
      const err = url.searchParams.get("error");
      if (err) {
        res.writeHead(400).end(`X returned an error: ${err}. You can close this tab.`);
        server.close();
        return reject(new Error(`authorize error: ${err} — ${url.searchParams.get("error_description") || ""}`));
      }
      if (url.searchParams.get("state") !== state) {
        res.writeHead(400).end("state mismatch (possible CSRF). You can close this tab.");
        server.close();
        return reject(new Error("state mismatch — aborting"));
      }
      try {
        const code = url.searchParams.get("code");
        const tok = await exchangeCode({ code, redirectUri, codeVerifier, clientId, clientSecret });
        res.writeHead(200, { "Content-Type": "text/html" }).end(
          "<h2>Authorized ✓</h2><p>Refresh token minted. Return to your terminal — you can close this tab.</p>"
        );
        server.close();
        resolve(tok.refresh_token);
      } catch (e) {
        res.writeHead(500).end("token exchange failed — check the terminal.");
        server.close();
        reject(e);
      }
    });
    server.listen(port, "127.0.0.1", () => {
      console.error(`Listening on ${redirectUri} — opening browser to authorize…`);
      console.error(`If the browser doesn't open, paste this URL:\n  ${authorizeUrl}\n`);
      openBrowser(authorizeUrl);
    });
    server.on("error", reject);
  });

  if (!refreshToken) {
    console.error("\nNo refresh_token returned. Did you include the 'offline.access' scope and approve it?");
    process.exit(1);
  }
  // Print on stdout so it's easy to capture; it's your own token on your own machine.
  console.error("\n✅ Success. Paste this line into your env file (replace any existing X_REFRESH_TOKEN):\n");
  console.log(`X_REFRESH_TOKEN=${refreshToken}`);
  console.error("\nThen test posting with:\n  node --env-file=./your.env x-post.mjs --dry-run --text \"hello from the terminal\"\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
}
