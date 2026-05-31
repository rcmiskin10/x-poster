#!/usr/bin/env node
// x-post.mjs — post a tweet or a linear thread (with optional image) to X from the terminal.
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

import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const PRICE_PER_POST = 0.015;
const PRICE_PER_POST_WITH_URL = 0.20;
const API_BASE = "https://api.x.com";
const MEDIA_UPLOAD_URL = `${API_BASE}/2/media/upload`;

// Conservative URL detector — X shortens any link, so we flag bare domains too (worst-case cost).
const URL_RE =
  /(https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|io|app|dev|org|net|co|ai|gg|sh|xyz)\b)/i;

export function containsUrl(text) {
  return URL_RE.test(text || "");
}

export function postCost(text) {
  return containsUrl(text) ? PRICE_PER_POST_WITH_URL : PRICE_PER_POST;
}

export function costEstimate(tweets) {
  return Math.round(tweets.reduce((sum, t) => sum + postCost(t), 0) * 1000) / 1000;
}

// Pure planning core — no network. This is what the dry-run prints and what tests assert against.
export function buildPlan({ tweets, dryRun, confirm, hasCreds, image }) {
  const errors = [];
  if (!Array.isArray(tweets) || tweets.length === 0) errors.push("no tweets provided");
  for (const [i, t] of (tweets || []).entries()) {
    if (typeof t !== "string" || t.trim() === "") errors.push(`tweet ${i + 1} is empty`);
    if ((t || "").length > 280) errors.push(`tweet ${i + 1} exceeds 280 chars (${t.length})`);
  }
  if (image && !existsSync(image)) errors.push(`image not found: ${image}`);
  const willPost = !dryRun && confirm === true && hasCreds === true;
  return {
    tweets: tweets || [],
    count: (tweets || []).length,
    isThread: (tweets || []).length > 1,
    image: image || null,
    hasImage: !!image,
    perPost: (tweets || []).map((t) => ({ chars: t.length, hasUrl: containsUrl(t), cost: postCost(t) })),
    estimatedCostUsd: costEstimate(tweets || []),
    dryRun: !!dryRun,
    willPost,
    blockedReason: willPost
      ? null
      : dryRun
      ? "dry-run"
      : !confirm
      ? "missing --confirm"
      : !hasCreds
      ? "missing credentials"
      : "unknown",
    errors,
  };
}

// ---- Real posting path (fetch-based, gated). Not exercised in dry-run / tests. ----

async function refreshAccessToken({ clientId, clientSecret, refreshToken }, onRotatedToken) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  });
  const res = await fetch(`${API_BASE}/2/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
    },
    body,
  });
  if (!res.ok) throw new Error(`token refresh failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  // Refresh tokens rotate — persist the new one or the next run fails.
  if (json.refresh_token && json.refresh_token !== refreshToken && onRotatedToken) {
    await onRotatedToken(json.refresh_token);
  }
  return json.access_token;
}

// Map a file extension to the media_type X expects. Pure + tested.
export function mediaTypeForPath(p) {
  const ext = (p.split(".").pop() || "").toLowerCase();
  return { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" }[ext]
    || "application/octet-stream";
}

// Simple (single-request) v2 upload: JSON body with base64 `media`. Verified against docs.x.com —
// the v2 endpoint is JSON, NOT the v1.1 chunked command=INIT/APPEND/FINALIZE form. Returns media id.
// (media.write scope required, or this 403s.) Good for screenshots; large/video would need chunked.
export async function uploadMedia(accessToken, filePath) {
  const bytes = readFileSync(filePath);
  const res = await fetch(MEDIA_UPLOAD_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      media: bytes.toString("base64"),
      media_category: "tweet_image",
      media_type: mediaTypeForPath(filePath),
    }),
  });
  if (!res.ok) throw new Error(`media upload failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  const mediaId = json.data?.id || json.id;
  if (!mediaId) throw new Error(`media upload returned no id: ${JSON.stringify(json)}`);
  return String(mediaId);
}

async function postOne(accessToken, text, inReplyToId, mediaIds) {
  const payload = { text };
  if (inReplyToId) payload.reply = { in_reply_to_tweet_id: inReplyToId };
  if (mediaIds && mediaIds.length) payload.media = { media_ids: mediaIds };
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${API_BASE}/2/tweets`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.status === 429) {
      // Unpublished rate limit under pay-per-use — back off and retry.
      const wait = Math.min(2 ** attempt, 8) * 1000;
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) throw new Error(`post failed: ${res.status} ${await res.text()}`);
    const json = await res.json();
    return json.data.id;
  }
  throw new Error("post failed: rate-limited after retries");
}

export async function postThread(tweets, creds, onRotatedToken, imagePath) {
  const accessToken = await refreshAccessToken(creds, onRotatedToken);
  let mediaIds;
  if (imagePath) mediaIds = [await uploadMedia(accessToken, imagePath)];
  const ids = [];
  let replyTo = null;
  for (let i = 0; i < tweets.length; i++) {
    // Attach the image to the FIRST tweet only.
    const id = await postOne(accessToken, tweets[i], replyTo, i === 0 ? mediaIds : undefined);
    ids.push(id);
    replyTo = id; // chain the thread
  }
  return ids;
}

// Rotating refresh tokens are single-use: each refresh invalidates the old one (per X docs).
// So when one rotates we MUST write the new value back, or the next run fails auth.
// Rewrites only the X_REFRESH_TOKEN line, preserving every other line/comment; atomic via temp+rename.
export function persistRefreshToken(newToken, envPath) {
  const lines = existsSync(envPath) ? readFileSync(envPath, "utf8").split("\n") : [];
  const newLine = `X_REFRESH_TOKEN=${newToken}`;
  const idx = lines.findIndex((l) => /^\s*X_REFRESH_TOKEN\s*=/.test(l));
  if (idx >= 0) lines[idx] = newLine;
  else lines.push(newLine);
  const tmp = envPath + ".tmp";
  writeFileSync(tmp, lines.join("\n"), { mode: 0o600 });
  renameSync(tmp, envPath);
}

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
