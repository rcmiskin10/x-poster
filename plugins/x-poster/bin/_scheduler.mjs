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
// vibedraft's X app at dispatch time, not to x-poster's app. Media is NOT
// supported by the API's v1 (no upload endpoint); validateSchedule rejects it
// up front so the media never silently drops.

export const SCHEDULE_POSTS_MAX = 6; // mirrors the API's thread cap
const MIN_LEAD_MS = 2 * 60_000; // API rejects <= now+2min; fail fast client-side
const MAX_AHEAD_MS = 30 * 24 * 60 * 60_000; // API rejects > 30 days out

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

  if (image || video) {
    errors.push(
      "scheduled posts don't support media yet (vibedraft API v1 has no upload " +
        "endpoint) — drop the attachment, or post now instead of scheduling",
    );
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
    if (!res.ok) throw new Error(describeApiError(res.status, body));
    return body;
  }

  return {
    /**
     * Schedule a standalone post (1 tweet) or a thread (2-6 tweets) at an ISO
     * time. Returns the created rows — note scheduled_for may differ slightly
     * from the request: vibedraft applies the user's humanization jitter.
     */
    async schedulePosts({ tweets, scheduledFor, inReplyTo }) {
      const body = {
        posts: tweets.map((content) => ({ content })),
        scheduled_for: scheduledFor,
        ...(inReplyTo ? { in_reply_to_tweet_id: String(inReplyTo) } : {}),
      };
      const json = await api("/scheduled-posts", { method: "POST", body: JSON.stringify(body) });
      return json?.posts ?? [];
    },

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
