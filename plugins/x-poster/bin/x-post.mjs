#!/usr/bin/env node
// x-post.mjs — CLI shim: post a tweet or a linear thread (with optional image) to X from the terminal.
//
// Dependency-free: Node's global fetch, no SDK, no node_modules. A single-account poster.
//
// SAFETY — never auto-publish:
//   * --dry-run (default when no creds) posts NOTHING — validates + prints plan + cost estimate.
//   * Real posting requires BOTH --confirm AND credentials present. No other path posts.
//
// COST (X pay-per-use, no free tier): $0.015/post, $0.20/post if it contains a URL
//   (worst-case: any URL => $0.20). A 5-tweet thread w/ one link ~= $0.26. See docs.x.com for current pricing.
//
// Auth (OAuth 2.0 user-context): env X_CLIENT_ID, X_CLIENT_SECRET, X_REFRESH_TOKEN (see env/.env.example).
//   Mint the refresh token once with x-auth.mjs. Refresh tokens ROTATE (single-use) — the new one is
//   persisted back to your env file automatically (set X_ENV_FILE; see onRotatedToken).
//
// Usage (pass YOUR env file with --env-file; nothing is read implicitly):
//   node --env-file=./your.env x-post.mjs --dry-run --text "single tweet"
//   node --env-file=./your.env x-post.mjs --dry-run --thread "tweet 1" "tweet 2 with https://x.com/foo"
//   node --env-file=./your.env x-post.mjs --confirm --image ./shot.png --text "..."   # REAL post; costs money

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { buildPlan, postThread, uploadMedia, refreshAccessToken, persistRefreshToken } from "./_poster.mjs";

// ---- CLI entry (only when run directly, not when imported by tests) ----
function parseArgs(argv) {
  const out = { dryRun: false, confirm: false, tweets: [], image: undefined, uploadOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--confirm") out.confirm = true;
    else if (a === "--image") out.image = argv[++i];
    else if (a === "--upload-only") { out.uploadOnly = true; out.image = argv[++i]; } // upload media, print id, no post
    else if (a === "--text") out.tweets.push(argv[++i]);
    else if (a === "--thread") { while (argv[i + 1] && !argv[i + 1].startsWith("--")) out.tweets.push(argv[++i]); }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const creds = {
    clientId: process.env.X_CLIENT_ID,
    clientSecret: process.env.X_CLIENT_SECRET,
    refreshToken: process.env.X_REFRESH_TOKEN,
  };
  const hasCreds = !!(creds.clientId && creds.clientSecret && creds.refreshToken);
  // Default to dry-run when creds are absent so a bare invocation can never spend.
  if (!hasCreds) args.dryRun = args.dryRun || !args.confirm;

  const envPath = process.env.X_ENV_FILE || resolve(process.cwd(), ".env");
  const onRotatedToken = async (newToken) => {
    try {
      persistRefreshToken(newToken, envPath);
      console.error(`Refresh token rotated — persisted new X_REFRESH_TOKEN to ${envPath}.`);
    } catch (e) {
      console.error(`WARN: refresh token rotated but could NOT persist to ${envPath}: ${e.message}`);
      console.error("The next post will fail until X_REFRESH_TOKEN is updated. Re-run bin/x-auth.mjs to re-mint.");
    }
  };

  // Isolated media-upload test: uploads the image and prints the media id. No tweet, nothing public,
  // no per-post cost — used to detect the known May-2026 OAuth2 /2/media/upload 403 before spending.
  if (args.uploadOnly) {
    if (!hasCreds) { console.error("upload-only needs credentials."); process.exit(2); }
    if (!args.image || !existsSync(args.image)) { console.error(`image not found: ${args.image}`); process.exit(2); }
    const token = await refreshAccessToken(creds, onRotatedToken);
    const id = await uploadMedia(token, args.image);
    console.log(JSON.stringify({ uploadOnly: true, media_id: id }, null, 2));
    return;
  }

  const plan = buildPlan({ tweets: args.tweets, dryRun: args.dryRun, confirm: args.confirm, hasCreds, image: args.image });

  console.log(JSON.stringify(plan, null, 2));
  if (plan.errors.length) { console.error("VALIDATION ERRORS:", plan.errors.join("; ")); process.exit(2); }

  if (!plan.willPost) {
    console.error(`NOT POSTING (${plan.blockedReason}). Estimated cost if posted: $${plan.estimatedCostUsd}.`);
    return;
  }

  console.error(`Posting ${plan.count} tweet(s)${plan.hasImage ? " with image" : ""}… estimated cost $${plan.estimatedCostUsd}.`);
  const ids = await postThread(args.tweets, creds, onRotatedToken, args.image);
  console.log(JSON.stringify({ posted: ids, urls: ids.map((id) => `https://x.com/i/web/status/${id}`) }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
}
