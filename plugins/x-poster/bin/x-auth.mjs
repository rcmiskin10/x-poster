#!/usr/bin/env node
// x-auth.mjs — ONE-TIME OAuth 2.0 (PKCE) bootstrap to mint an X refresh token (CLI path).
//
// Why this exists: x-post.mjs posts as YOU, which needs a user-context token.
// An app-only bearer token can't post. This runs the authorization-code-with-PKCE
// flow once, you click "Authorize" in the browser, and it prints X_REFRESH_TOKEN
// for you to paste into your env file. After that, x-post.mjs refreshes access tokens on its own.
//
// The flow itself lives in _auth.mjs (vendored from core/auth.mjs) — shared with
// the MCP server's `authorize` tool, which does the same thing without a terminal.
//
// Prereq (one portal edit): in your X app's "User authentication settings", set App type =
//   Web App / Confidential client and add the EXACT redirect URI below to its Callback URLs.
//
// Usage:
//   node --env-file=./your.env x-auth.mjs
//     (reads X_CLIENT_ID, X_CLIENT_SECRET; optional X_AUTH_PORT)

import { spawn } from "node:child_process";
import { startAuthSession } from "./_auth.mjs";

// Re-exported for bin/_tests/x-auth.test.mjs and any external consumers.
export { generatePkce, buildAuthorizeUrl, buildTokenExchangeBody, SCOPES } from "./_auth.mjs";

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

  const refreshToken = await new Promise(async (resolve, reject) => {
    let session;
    try {
      session = await startAuthSession({
        clientId,
        clientSecret,
        port,
        onToken: resolve,
        onDone: (r) => { if (!r.ok) reject(new Error(r.error)); },
      });
    } catch (e) {
      return reject(e);
    }
    console.error(`\nMake sure this EXACT redirect URI is registered in your X App's callback URLs:\n  ${session.redirectUri}\n`);
    console.error(`Listening on ${session.redirectUri} — opening browser to authorize…`);
    console.error(`If the browser doesn't open, paste this URL:\n  ${session.authorizeUrl}\n`);
    openBrowser(session.authorizeUrl);
  });

  // Print on stdout so it's easy to capture; it's your own token on your own machine.
  console.error("\n✅ Success. Paste this line into your env file (replace any existing X_REFRESH_TOKEN):\n");
  console.log(`X_REFRESH_TOKEN=${refreshToken}`);
  console.error("\nThen test posting with:\n  node --env-file=./your.env x-post.mjs --dry-run --text \"hello from the terminal\"\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
}
