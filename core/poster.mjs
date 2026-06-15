// poster.mjs — zero-dep core library for posting to X.
//
// Pure library: no process.env, no process.argv, no CLI concerns.
// Imported by the CLI shim (plugins/x-poster/bin/_poster.mjs vendored copy)
// and by the MCP server (to be added).
//
// COST (X pay-per-use, no free tier): $0.015/post, $0.20/post if it contains a URL
//   (worst-case: any URL => $0.20). A 5-tweet thread w/ one link ~= $0.26. See docs.x.com for current pricing.

import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";

export const PRICE_PER_POST = 0.015;
export const PRICE_PER_POST_WITH_URL = 0.20;
export const API_BASE = "https://api.x.com";
export const MEDIA_UPLOAD_URL = `${API_BASE}/2/media/upload`;

// X's media size caps (docs.x.com): 5 MB for static images, 15 MB for GIF.
export const IMAGE_MAX_BYTES = { "image/gif": 15 * 1024 * 1024, default: 5 * 1024 * 1024 };

// Pre-flight size check so an oversized image fails with a clear, actionable
// message instead of an opaque 400 after a wasteful full-file base64 upload.
// Returns an error string, or null if the file is within X's limit.
export function imageSizeError(byteLength, mediaType) {
  const limit = IMAGE_MAX_BYTES[mediaType] ?? IMAGE_MAX_BYTES.default;
  if (byteLength <= limit) return null;
  const mb = (n) => (n / 1024 / 1024).toFixed(1).replace(/\.0$/, "");
  return `image is too large (${mb(byteLength)} MB, over X's ${mb(limit)} MB limit). ` +
    `Resize or compress it, or post without the image.`;
}

// Conservative URL detector — X shortens any link, so we flag bare domains too (worst-case cost).
export const URL_RE =
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

export async function refreshAccessToken({ clientId, clientSecret, refreshToken }, onRotatedToken) {
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
  const mediaType = mediaTypeForPath(filePath);
  const sizeErr = imageSizeError(bytes.length, mediaType);
  if (sizeErr) throw new Error(`media upload failed: ${sizeErr}`);
  const res = await fetch(MEDIA_UPLOAD_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      media: bytes.toString("base64"),
      media_category: "tweet_image",
      media_type: mediaType,
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

// inReplyToId (optional): an existing tweet id the root tweet replies to. The
// rest of the thread chains off the root as usual. null/undefined = new post.
export async function postThread(tweets, creds, onRotatedToken, imagePath, inReplyToId) {
  const accessToken = await refreshAccessToken(creds, onRotatedToken);
  let mediaIds;
  if (imagePath) mediaIds = [await uploadMedia(accessToken, imagePath)];
  const ids = [];
  let replyTo = inReplyToId || null;
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
