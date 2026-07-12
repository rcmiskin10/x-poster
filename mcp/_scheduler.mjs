// scheduler.mjs — zero-dep core client for vibedraft's scheduled-posts API.
//
// Pure library: no process.env, no CLI concerns (mirrors poster.mjs). The
// caller resolves config via resolveVibedraftConfig and injects it.
//
// Talks to the PAT-authenticated /api/v1/scheduled-posts API (vibedraft):
//   POST   /api/v1/scheduled-posts      — schedule a post or a 2-6 tweet thread
//   GET    /api/v1/scheduled-posts      — list rows incl. posted_tweet_id
//   DELETE /api/v1/scheduled-posts/:id  — cancel a pending row (whole thread)
//
// Scheduling posts via the USER's vibedraft X connection — cost is billed to
// vibedraft's X app at dispatch time, not to x-poster's app. Media rides along
// via the v1 media API (three steps, because Vercel's ~4.5MB request-body cap
// rules out proxying bytes through a route):
//   POST /api/v1/media                → media_id + a signed direct-to-storage URL
//   PUT  <signed_url>                 → the bytes (straight to Supabase storage)
//   POST /api/v1/media/{id}/complete  → marks the row ready
// then media_id goes on the FIRST post of the scheduled thread; the dispatcher
// attaches it at post time. Bulk stays text-only (rejected up front, never
// silently dropped).

import { existsSync, statSync, readFileSync } from "node:fs";

export const SCHEDULE_POSTS_MAX = 6; // mirrors the API's thread cap
export const BULK_ITEMS_MAX = 20; // bulk cap: max independent posts per scheduleBulk call
const MIN_LEAD_MS = 2 * 60_000; // API rejects <= now+2min; fail fast client-side
const MAX_AHEAD_MS = 30 * 24 * 60 * 60_000; // API rejects > 30 days out

// vibedraft's media limits (mirrors its v1 media API validation): images share
// X's 5MB static-image cap; mp4 matches X's 512MB ceiling. No GIF — vibedraft's
// pipeline doesn't carry it.
export const SCHEDULE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const SCHEDULE_VIDEO_MAX_BYTES = 512 * 1024 * 1024;
export const SCHEDULE_MEDIA_TYPES = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  mp4: "video/mp4",
};

// Map a path to the mime type vibedraft accepts for scheduling, or null.
export function scheduleMediaMime(p) {
  const ext = (String(p).split(".").pop() || "").toLowerCase();
  return SCHEDULE_MEDIA_TYPES[ext] ?? null;
}

// The API's posts[] is a THREAD (one shared time), so bulk = one POST per item.
// Codes where the whole batch is doomed — abort instead of burning 19 more calls.
const BULK_FATAL_CODES = new Set([
  "missing_bearer_token",
  "invalid_token",
  "insufficient_scope",
  "x_account_not_connected",
  "pending_post_limit_reached",
]);
const BULK_RATE_LIMIT_RETRIES = 2;
const BULK_RATE_LIMIT_WAIT_MS = 10_000;

// ---------------------------------------------------------------------------
// Config resolution — process.env style object + optional env-file fallback
// (same precedence rule as the X creds: live env always wins over the file).
// ---------------------------------------------------------------------------

export function resolveVibedraftConfig(env = {}, fileEnv = {}) {
  const norm = (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const baseUrl = norm(env.VIBEDRAFT_API_URL) ?? norm(fileEnv.VIBEDRAFT_API_URL);
  const token = norm(env.VIBEDRAFT_API_TOKEN) ?? norm(fileEnv.VIBEDRAFT_API_TOKEN);
  if (!baseUrl || !token) {
    throw new Error(
      "scheduling needs VIBEDRAFT_API_URL and VIBEDRAFT_API_TOKEN. " +
        "Create a token in vibedraft under Settings → API tokens, then add both " +
        "vars to your env file (the same one X_ENV_FILE points at).",
    );
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ""), token };
}

// ---------------------------------------------------------------------------
// Validation — pure; returns an array of human-actionable error strings.
// ---------------------------------------------------------------------------

export function validateSchedule({ tweets, scheduledFor, inReplyTo, image, video }, now = new Date()) {
  const errors = [];

  if (image && video) {
    errors.push("image and video are mutually exclusive; pass one or the other");
  }
  const media = image || video;
  if (media) {
    const mime = scheduleMediaMime(media);
    const mb = (n) => (n / 1024 / 1024).toFixed(1).replace(/\.0$/, "");
    if (!existsSync(media)) {
      // Same wording as buildPlan so composed callers dedupe to one line.
      errors.push(`${image ? "image" : "video"} not found: ${media}`);
    } else if (!mime) {
      errors.push(
        `unsupported media type for scheduling: ${media} — vibedraft accepts ` +
          "jpg/jpeg/png/webp images and .mp4 video",
      );
    } else if (image && !mime.startsWith("image/")) {
      errors.push(`image must be jpg/jpeg/png/webp (got ${mime}) — pass a .mp4 as video instead`);
    } else if (video && mime !== "video/mp4") {
      errors.push(`video must be .mp4 (got ${mime})`);
    } else {
      const size = statSync(media).size;
      const limit = mime === "video/mp4" ? SCHEDULE_VIDEO_MAX_BYTES : SCHEDULE_IMAGE_MAX_BYTES;
      if (size > limit) {
        errors.push(
          `media is too large (${mb(size)} MB, over vibedraft's ${mb(limit)} MB limit for ${mime}). ` +
            "Compress it, or post now instead of scheduling.",
        );
      }
    }
  }

  if (!Array.isArray(tweets) || tweets.length === 0) {
    errors.push("no tweets provided");
  } else {
    if (tweets.length > SCHEDULE_POSTS_MAX) {
      errors.push(`threads are capped at ${SCHEDULE_POSTS_MAX} posts (got ${tweets.length})`);
    }
    for (const [i, t] of tweets.entries()) {
      if (typeof t !== "string" || t.trim() === "") errors.push(`tweet ${i + 1} is empty`);
    }
  }

  const scheduledMs = new Date(scheduledFor ?? "").getTime();
  if (!scheduledFor || Number.isNaN(scheduledMs)) {
    errors.push(`scheduled_for must be an ISO 8601 timestamp (got: ${scheduledFor ?? "nothing"})`);
  } else if (scheduledMs <= now.getTime() + MIN_LEAD_MS) {
    errors.push("scheduled_for must be more than 2 minutes in the future");
  } else if (scheduledMs > now.getTime() + MAX_AHEAD_MS) {
    errors.push("scheduled_for must be within 30 days");
  }

  if (inReplyTo) {
    if (Array.isArray(tweets) && tweets.length > 1) {
      errors.push("in_reply_to only works for a single scheduled post, not a thread");
    }
    if (!/^\d{1,25}$/.test(String(inReplyTo))) {
      errors.push(`in_reply_to must be a numeric tweet id (got: ${inReplyTo})`);
    }
  }

  return errors;
}

// validateBulkSchedule — validate up to BULK_ITEMS_MAX independent items, each
// { tweets, scheduledFor, inReplyTo }. All-or-nothing by design: callers must
// refuse to submit ANY item while this returns errors, so a half-valid batch
// can never partially schedule. Stricter than the single-post path: every
// scheduled_for must carry an explicit offset or Z — 20 posts silently landing
// an hour off is the bulk footgun.
export function validateBulkSchedule(items, now = new Date()) {
  if (!Array.isArray(items) || items.length === 0) return ["no posts provided"];
  if (items.length > BULK_ITEMS_MAX) {
    return [`bulk scheduling is capped at ${BULK_ITEMS_MAX} posts per call (got ${items.length})`];
  }
  const errors = [];
  for (const [i, item] of items.entries()) {
    const prefix = `post ${i + 1}: `;
    // Bulk is text-only by design (one upload per item would turn a 20-post
    // batch into 60+ network calls with partial-failure ambiguity). Reject
    // explicitly so media never silently drops.
    if (item?.image || item?.video) {
      errors.push(`${prefix}bulk scheduling is text-only — schedule posts with media one at a time`);
    }
    for (const e of validateSchedule({ ...(item ?? {}), image: undefined, video: undefined }, now)) errors.push(prefix + e);
    const sf = item?.scheduledFor;
    if (typeof sf === "string" && !Number.isNaN(new Date(sf).getTime()) && !/(Z|[+-]\d{2}:?\d{2})$/.test(sf)) {
      errors.push(`${prefix}scheduled_for must include an explicit UTC offset or Z (got: ${sf})`);
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Error mapping — turn API error codes into the FIX, not the symptom.
// ---------------------------------------------------------------------------

function describeApiError(status, body) {
  const code = body?.error;
  const detail = body?.message ? ` (${body.message})` : "";
  switch (code) {
    case "missing_bearer_token":
    case "invalid_token":
      return "vibedraft rejected the API token — it may be revoked or expired. " +
        "Create a new one under Settings → API tokens and update VIBEDRAFT_API_TOKEN.";
    case "insufficient_scope":
      return `the API token is missing a required scope${detail} — create a new token with posts:read + posts:write.`;
    case "x_account_not_connected":
      return "your vibedraft account has no connected X account — connect X inside vibedraft first.";
    case "pending_post_limit_reached":
      return `vibedraft's pending-post cap was hit${detail}.`;
    case "not_cancelable":
      return `could not cancel${detail} — only pending posts can be canceled.`;
    case "not_found":
      return "no scheduled post with that id (or it belongs to a different vibedraft user).";
    case "rate_limited":
      return "vibedraft rate-limited the token — wait a minute and retry.";
    case "unsupported_media_type":
      return `vibedraft rejected the media type${detail} — jpg/jpeg/png/webp images (≤5 MB) and .mp4 video are supported.`;
    case "media_too_large":
      return `the media file exceeds vibedraft's size limit${detail}.`;
    case "media_not_found":
    case "media_not_ready":
      return `the media_id doesn't reference a completed upload${detail} — upload the file again and use the fresh media_id.`;
    case "upload_incomplete":
      return `vibedraft could not verify the uploaded bytes${detail} — retry the upload from the start.`;
    case "validation_failed":
      return `vibedraft rejected the request${detail}.`;
    default:
      return `vibedraft API error ${status}${detail || (code ? ` (${code})` : "")}`;
  }
}

// ---------------------------------------------------------------------------
// Client — fetch-based; fetchImpl injectable for tests.
// ---------------------------------------------------------------------------

export function makeScheduleClient({ baseUrl, token, fetchImpl = fetch }) {
  async function api(path, init = {}) {
    let res;
    try {
      res = await fetchImpl(`${baseUrl}/api/v1${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...init.headers,
        },
      });
    } catch (e) {
      throw new Error(`could not reach vibedraft at ${baseUrl}: ${e.message}`);
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      // non-JSON body (e.g. an HTML error page) — fall through to status handling
    }
    if (!res.ok) {
      // Machine-readable fields ride along so scheduleBulk can classify
      // (fatal / retryable / per-item) without parsing the human message.
      const err = new Error(describeApiError(res.status, body));
      err.status = res.status;
      err.apiCode = body?.error;
      throw err;
    }
    return body;
  }

  /**
   * Upload a media file for scheduling. Three steps against vibedraft's v1
   * media API: init (metadata → media_id + signed URL), a direct PUT of the
   * bytes to Supabase storage (bypasses Vercel's ~4.5MB body cap), complete
   * (server verifies the object and marks the row ready). Returns
   * { mediaId, media } — pass mediaId to schedulePosts.
   * Caller should validateSchedule first; this re-derives mime from the path
   * and fails fast on unsupported types so a raw call can't upload garbage.
   */
  async function uploadMedia({ filePath, readFileImpl = readFileSync }) {
    const mimeType = scheduleMediaMime(filePath);
    if (!mimeType) {
      throw new Error(
        `unsupported media type for scheduling: ${filePath} — vibedraft accepts ` +
          "jpg/jpeg/png/webp images and .mp4 video",
      );
    }
    let bytes;
    try {
      bytes = readFileImpl(filePath);
    } catch (e) {
      throw new Error(`could not read media file ${filePath}: ${e.message}`);
    }

    const init = await api("/media", {
      method: "POST",
      body: JSON.stringify({ mime_type: mimeType, size_bytes: bytes.length }),
    });
    const mediaId = init?.media_id;
    const upload = init?.upload ?? {};
    if (!mediaId || !upload.signed_url) {
      throw new Error(`vibedraft media init returned no media_id/signed_url: ${JSON.stringify(init)}`);
    }

    // Bytes go straight to storage with the signed URL — NOT through api()
    // (absolute URL, no bearer; auth is the signed token). If the API returns
    // the token separately and the URL doesn't already carry it, append it
    // (Supabase's uploadToSignedUrl query-param convention).
    let putUrl = upload.signed_url;
    if (upload.token && !/[?&]token=/.test(putUrl)) {
      putUrl += (putUrl.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(upload.token);
    }
    let putRes;
    try {
      putRes = await fetchImpl(putUrl, {
        method: "PUT",
        headers: { "Content-Type": mimeType },
        body: bytes,
      });
    } catch (e) {
      throw new Error(`media upload to storage failed: ${e.message}`);
    }
    if (!putRes.ok) {
      let detail = "";
      try { detail = JSON.stringify(await putRes.json()); } catch { /* non-JSON error body */ }
      throw new Error(`media upload to storage failed: ${putRes.status}${detail ? ` ${detail}` : ""}`);
    }

    const done = await api(`/media/${encodeURIComponent(mediaId)}/complete`, { method: "POST" });
    return { mediaId: String(done?.media?.id ?? mediaId), media: done?.media ?? null };
  }

  /**
   * Schedule a standalone post (1 tweet) or a thread (2-6 tweets) at an ISO
   * time. Returns the created rows — note scheduled_for may differ slightly
   * from the request: vibedraft applies the user's humanization jitter.
   * mediaId (optional, from uploadMedia) attaches to the FIRST post only —
   * mirrors publish, where media rides on the root tweet.
   */
  async function schedulePosts({ tweets, scheduledFor, inReplyTo, mediaId }) {
    const body = {
      posts: tweets.map((content, i) =>
        i === 0 && mediaId ? { content, media_id: String(mediaId) } : { content },
      ),
      scheduled_for: scheduledFor,
      ...(inReplyTo ? { in_reply_to_tweet_id: String(inReplyTo) } : {}),
    };
    const json = await api("/scheduled-posts", { method: "POST", body: JSON.stringify(body) });
    return json?.posts ?? [];
  }

  /**
   * Schedule up to BULK_ITEMS_MAX independent items (each its own post/thread
   * at its own time) via sequential schedulePosts calls. Per-item statuses:
   *   scheduled — created; ids + (jittered) scheduled_for captured
   *   failed    — API rejected this item (or rate-limit retries exhausted)
   *   skipped   — never attempted: an earlier fatal error doomed the batch
   *   unknown   — the request may or may not have landed (network error; the
   *               API has no idempotency key, so we never blind-retry these —
   *               check list_scheduled before resubmitting)
   * Aborts on BULK_FATAL_CODES, on a network error, or when rate_limited
   * persists after BULK_RATE_LIMIT_RETRIES waits.
   */
  async function scheduleBulk({ items, sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    const results = [];
    let aborted = false;
    let abortReason = null;

    for (const [index, item] of items.entries()) {
      if (aborted) {
        results.push({ index, ok: false, status: "skipped", error: `not attempted: ${abortReason}` });
        continue;
      }
      let retries = 0;
      for (;;) {
        try {
          const rows = await schedulePosts(item);
          results.push({
            index,
            ok: true,
            status: "scheduled",
            ids: rows.map((r) => r.id),
            scheduled_for: rows[0]?.scheduled_for ?? item.scheduledFor,
          });
        } catch (e) {
          if (e.apiCode === "rate_limited" && retries < BULK_RATE_LIMIT_RETRIES) {
            // 429 is rejected pre-insert, so retrying the same item is safe.
            retries += 1;
            await sleepImpl(BULK_RATE_LIMIT_WAIT_MS);
            continue;
          }
          const fatal = BULK_FATAL_CODES.has(e.apiCode);
          const network = e.status === undefined && e.apiCode === undefined;
          const stillRateLimited = e.apiCode === "rate_limited";
          if (network) {
            results.push({
              index,
              ok: false,
              status: "unknown",
              error: `${e.message} — the request may still have landed; check list_scheduled before resubmitting`,
            });
          } else {
            results.push({ index, ok: false, status: "failed", error: e.message });
          }
          if (fatal || network || stillRateLimited) {
            aborted = true;
            abortReason = e.message;
          }
        }
        break;
      }
    }

    return {
      results,
      scheduledCount: results.filter((r) => r.ok).length,
      failedCount: results.filter((r) => !r.ok).length,
      aborted,
      ...(abortReason ? { abortReason } : {}),
    };
  }

  return {
    uploadMedia,
    schedulePosts,
    scheduleBulk,

    /** List scheduled rows. status/since/limit optional; posted rows carry posted_tweet_id. */
    async listScheduled({ status, since, limit } = {}) {
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      if (since) params.set("since", since);
      if (limit) params.set("limit", String(limit));
      const qs = params.toString();
      const json = await api(`/scheduled-posts${qs ? `?${qs}` : ""}`);
      return json?.posts ?? [];
    },

    /** Cancel a pending post (canceling any thread member cancels the whole thread). */
    async cancelScheduled(id) {
      const json = await api(`/scheduled-posts/${encodeURIComponent(id)}`, { method: "DELETE" });
      return json?.canceled ?? [];
    },
  };
}
