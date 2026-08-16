// track.mjs — zero-dep post.published emit for the observation pipeline.
//
// Direct publishes (publish_post) happen client-side against the X API, so
// vibedraft's scheduler never sees them; this module relays the publish event
// to vibedraft's events API (POST /api/v1/events), which owns the real emit()
// (events row + Hatchet push) server-side. Scheduled posts need no client
// emit — vibedraft's scheduler fires them and emits at dispatch.
//
// Non-negotiable (observation-pipeline spec §6): tracking is PASSIVE. Absent
// config, endpoint 404 (not yet deployed), timeout, or any network failure is
// a silent no-op — publishing has already succeeded by the time this runs and
// its result must never be affected. This function never throws.
//
// Threads: the FIRST tweet id is the tracked ref (it carries the hook and the
// impressions); thread length rides along as a payload feature.

const EMIT_TIMEOUT_MS = 2000;

// Same env + env-file precedence as resolveVibedraftConfig (scheduler.mjs),
// but absent config returns null instead of throwing: scheduling without
// config is a user error, tracking without config is simply "not enabled".
export function resolveTrackConfig(env = {}, fileEnv = {}) {
  const norm = (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const baseUrl = norm(env.VIBEDRAFT_API_URL) ?? norm(fileEnv.VIBEDRAFT_API_URL);
  const token = norm(env.VIBEDRAFT_API_TOKEN) ?? norm(fileEnv.VIBEDRAFT_API_TOKEN);
  if (!baseUrl || !token) return null;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), token };
}

// emitPublished({config, tweetId, postedAt, threadLen?, inReplyTo?, fetchImpl?})
//   → { emitted: boolean, reason: string|null }  (reason set when not emitted)
export async function emitPublished({
  config,
  tweetId,
  postedAt,
  threadLen = 1,
  inReplyTo = null,
  fetchImpl = fetch,
}) {
  if (!config) return { emitted: false, reason: "unconfigured" };
  if (!tweetId) return { emitted: false, reason: "no_tweet_id" };
  let timer;
  try {
    const ctrl = new AbortController();
    timer = setTimeout(() => ctrl.abort(), EMIT_TIMEOUT_MS);
    const res = await fetchImpl(`${config.baseUrl}/api/v1/events`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "post.published",
        ref_id: tweetId,
        payload: {
          postedAt,
          source: "x-poster-direct",
          thread_len: threadLen,
          in_reply_to: inReplyTo,
        },
      }),
      signal: ctrl.signal,
    });
    return { emitted: res.ok, reason: res.ok ? null : `http_${res.status}` };
  } catch (e) {
    return { emitted: false, reason: e?.name === "AbortError" ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}
