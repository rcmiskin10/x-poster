import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTrackConfig, emitPublished } from "../track.mjs";

// ---------------------------------------------------------------------------
// resolveTrackConfig — null (not throw) when unconfigured; env beats file
// ---------------------------------------------------------------------------

test("resolveTrackConfig returns null when either var is missing", () => {
  assert.equal(resolveTrackConfig({}, {}), null);
  assert.equal(resolveTrackConfig({ VIBEDRAFT_API_URL: "https://v.app" }, {}), null);
  assert.equal(resolveTrackConfig({ VIBEDRAFT_API_TOKEN: "t" }, {}), null);
  assert.equal(resolveTrackConfig({ VIBEDRAFT_API_URL: "  " }, { VIBEDRAFT_API_TOKEN: "t" }), null);
});

test("resolveTrackConfig strips trailing slashes and prefers live env over file", () => {
  const cfg = resolveTrackConfig(
    { VIBEDRAFT_API_URL: "https://env.app//", VIBEDRAFT_API_TOKEN: "env-tok" },
    { VIBEDRAFT_API_URL: "https://file.app", VIBEDRAFT_API_TOKEN: "file-tok" },
  );
  assert.deepEqual(cfg, { baseUrl: "https://env.app", token: "env-tok" });
});

test("resolveTrackConfig falls back to the env file", () => {
  const cfg = resolveTrackConfig({}, { VIBEDRAFT_API_URL: "https://file.app", VIBEDRAFT_API_TOKEN: "file-tok" });
  assert.deepEqual(cfg, { baseUrl: "https://file.app", token: "file-tok" });
});

// ---------------------------------------------------------------------------
// emitPublished — passive in every failure mode, correct wire shape on success
// ---------------------------------------------------------------------------

const CFG = { baseUrl: "https://v.app", token: "tok" };

test("emitPublished no-ops without config or tweet id", async () => {
  assert.deepEqual(await emitPublished({ config: null, tweetId: "1" }), { emitted: false, reason: "unconfigured" });
  assert.deepEqual(await emitPublished({ config: CFG, tweetId: undefined }), { emitted: false, reason: "no_tweet_id" });
});

test("emitPublished sends the spec wire shape and reports success", async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return { ok: true, status: 202 };
  };
  const res = await emitPublished({
    config: CFG,
    tweetId: "111",
    postedAt: "2026-07-21T12:00:00.000Z",
    threadLen: 3,
    inReplyTo: "222",
    fetchImpl,
  });
  assert.deepEqual(res, { emitted: true, reason: null });
  assert.equal(captured.url, "https://v.app/api/v1/events");
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.headers.Authorization, "Bearer tok");
  assert.deepEqual(JSON.parse(captured.init.body), {
    type: "post.published",
    ref_id: "111",
    payload: {
      postedAt: "2026-07-21T12:00:00.000Z",
      source: "x-poster-direct",
      thread_len: 3,
      in_reply_to: "222",
    },
  });
});

test("emitPublished defaults threadLen=1 and inReplyTo=null", async () => {
  let body;
  const fetchImpl = async (_u, init) => ((body = JSON.parse(init.body)), { ok: true, status: 202 });
  await emitPublished({ config: CFG, tweetId: "1", postedAt: "t", fetchImpl });
  assert.equal(body.payload.thread_len, 1);
  assert.equal(body.payload.in_reply_to, null);
});

test("emitPublished swallows HTTP errors (endpoint not deployed yet)", async () => {
  const fetchImpl = async () => ({ ok: false, status: 404 });
  assert.deepEqual(await emitPublished({ config: CFG, tweetId: "1", postedAt: "t", fetchImpl }), {
    emitted: false,
    reason: "http_404",
  });
});

test("emitPublished swallows network failures", async () => {
  const fetchImpl = async () => {
    throw new TypeError("fetch failed");
  };
  assert.deepEqual(await emitPublished({ config: CFG, tweetId: "1", postedAt: "t", fetchImpl }), {
    emitted: false,
    reason: "network",
  });
});

test("emitPublished aborts slow endpoints and reports timeout", async () => {
  const fetchImpl = (_u, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        const e = new Error("aborted");
        e.name = "AbortError";
        reject(e);
      });
    });
  const t0 = Date.now();
  const res = await emitPublished({ config: CFG, tweetId: "1", postedAt: "t", fetchImpl });
  assert.deepEqual(res, { emitted: false, reason: "timeout" });
  assert.ok(Date.now() - t0 < 5000, "abort should fire at the 2s cap, not hang");
});
