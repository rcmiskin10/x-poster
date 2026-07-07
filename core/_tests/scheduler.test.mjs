import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveVibedraftConfig,
  validateSchedule,
  makeScheduleClient,
  SCHEDULE_POSTS_MAX,
} from "../scheduler.mjs";

const NOW = new Date("2026-07-06T12:00:00.000Z");
const IN_3H = "2026-07-06T15:00:00.000Z";

// ---------------------------------------------------------------------------
// resolveVibedraftConfig
// ---------------------------------------------------------------------------

test("config: resolves from env, strips trailing slash", () => {
  const cfg = resolveVibedraftConfig({
    VIBEDRAFT_API_URL: "https://vibedraft.app/",
    VIBEDRAFT_API_TOKEN: "vd_pat_abc",
  });
  assert.equal(cfg.baseUrl, "https://vibedraft.app");
  assert.equal(cfg.token, "vd_pat_abc");
});

test("config: env wins over file; file fills gaps", () => {
  const cfg = resolveVibedraftConfig(
    { VIBEDRAFT_API_TOKEN: "vd_pat_env" },
    { VIBEDRAFT_API_URL: "https://vibedraft.app", VIBEDRAFT_API_TOKEN: "vd_pat_file" },
  );
  assert.equal(cfg.baseUrl, "https://vibedraft.app");
  assert.equal(cfg.token, "vd_pat_env");
});

test("config: missing vars throw the FIX (Settings → API tokens)", () => {
  assert.throws(() => resolveVibedraftConfig({}, {}), /Settings → API tokens/);
  assert.throws(() => resolveVibedraftConfig({ VIBEDRAFT_API_URL: "  " }, {}), /VIBEDRAFT_API_TOKEN/);
});

// ---------------------------------------------------------------------------
// validateSchedule
// ---------------------------------------------------------------------------

test("validate: happy paths (single, thread, reply)", () => {
  assert.deepEqual(validateSchedule({ tweets: ["hi"], scheduledFor: IN_3H }, NOW), []);
  assert.deepEqual(
    validateSchedule({ tweets: ["a", "b", "c"], scheduledFor: IN_3H }, NOW),
    [],
  );
  assert.deepEqual(
    validateSchedule({ tweets: ["reply"], scheduledFor: IN_3H, inReplyTo: "123456" }, NOW),
    [],
  );
});

test("validate: media is rejected up front (API v1 has no upload)", () => {
  const errs = validateSchedule(
    { tweets: ["x"], scheduledFor: IN_3H, image: "/a.png" },
    NOW,
  );
  assert.ok(errs.some((e) => /media/.test(e)));
  const errs2 = validateSchedule(
    { tweets: ["x"], scheduledFor: IN_3H, video: "/a.mp4" },
    NOW,
  );
  assert.ok(errs2.some((e) => /media/.test(e)));
});

test("validate: tweet count and emptiness", () => {
  assert.ok(validateSchedule({ tweets: [], scheduledFor: IN_3H }, NOW).some((e) => /no tweets/.test(e)));
  assert.ok(
    validateSchedule(
      { tweets: Array.from({ length: SCHEDULE_POSTS_MAX + 1 }, () => "x"), scheduledFor: IN_3H },
      NOW,
    ).some((e) => /capped at 6/.test(e)),
  );
  assert.ok(
    validateSchedule({ tweets: ["ok", "  "], scheduledFor: IN_3H }, NOW).some((e) => /tweet 2 is empty/.test(e)),
  );
});

test("validate: time bounds mirror the API (2min lead, 30-day cap, ISO required)", () => {
  assert.ok(validateSchedule({ tweets: ["x"], scheduledFor: "not-a-date" }, NOW).some((e) => /ISO 8601/.test(e)));
  assert.ok(
    validateSchedule(
      { tweets: ["x"], scheduledFor: new Date(NOW.getTime() + 60_000).toISOString() },
      NOW,
    ).some((e) => /2 minutes/.test(e)),
  );
  assert.ok(
    validateSchedule(
      { tweets: ["x"], scheduledFor: new Date(NOW.getTime() + 31 * 86_400_000).toISOString() },
      NOW,
    ).some((e) => /30 days/.test(e)),
  );
});

test("validate: reply constraints (single post only, numeric id)", () => {
  assert.ok(
    validateSchedule(
      { tweets: ["a", "b"], scheduledFor: IN_3H, inReplyTo: "123" },
      NOW,
    ).some((e) => /single scheduled post/.test(e)),
  );
  assert.ok(
    validateSchedule(
      { tweets: ["a"], scheduledFor: IN_3H, inReplyTo: "abc" },
      NOW,
    ).some((e) => /numeric tweet id/.test(e)),
  );
});

// ---------------------------------------------------------------------------
// makeScheduleClient — mocked fetch; asserts URLs, headers, payloads, errors
// ---------------------------------------------------------------------------

function mockFetch(handler) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, init });
    const r = handler(url, init);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
    };
  };
  return { impl, calls };
}

const CFG = { baseUrl: "https://vibedraft.app", token: "vd_pat_test" };

test("client: schedulePosts maps tweets → posts[] and carries auth + reply", async () => {
  const { impl, calls } = mockFetch(() => ({
    status: 201,
    body: { posts: [{ id: "p1", status: "pending" }] },
  }));
  const client = makeScheduleClient({ ...CFG, fetchImpl: impl });
  const rows = await client.schedulePosts({
    tweets: ["one", "two"],
    scheduledFor: IN_3H,
  });
  assert.deepEqual(rows, [{ id: "p1", status: "pending" }]);
  assert.equal(calls[0].url, "https://vibedraft.app/api/v1/scheduled-posts");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, "Bearer vd_pat_test");
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.posts, [{ content: "one" }, { content: "two" }]);
  assert.equal(body.scheduled_for, IN_3H);
  assert.equal(body.in_reply_to_tweet_id, undefined);

  await client.schedulePosts({ tweets: ["r"], scheduledFor: IN_3H, inReplyTo: "42" });
  assert.equal(JSON.parse(calls[1].init.body).in_reply_to_tweet_id, "42");
});

test("client: listScheduled builds query params and returns posts", async () => {
  const { impl, calls } = mockFetch(() => ({ status: 200, body: { posts: [{ id: "a" }] } }));
  const client = makeScheduleClient({ ...CFG, fetchImpl: impl });
  const rows = await client.listScheduled({ status: "posted", since: "2026-07-01T00:00:00Z", limit: 10 });
  assert.equal(rows.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/api/v1/scheduled-posts");
  assert.equal(url.searchParams.get("status"), "posted");
  assert.equal(url.searchParams.get("limit"), "10");

  await client.listScheduled();
  assert.equal(calls[1].url, "https://vibedraft.app/api/v1/scheduled-posts");
});

test("client: cancelScheduled DELETEs by id and returns canceled ids", async () => {
  const { impl, calls } = mockFetch(() => ({ status: 200, body: { canceled: ["x1", "x2"] } }));
  const client = makeScheduleClient({ ...CFG, fetchImpl: impl });
  const canceled = await client.cancelScheduled("x1");
  assert.deepEqual(canceled, ["x1", "x2"]);
  assert.equal(calls[0].url, "https://vibedraft.app/api/v1/scheduled-posts/x1");
  assert.equal(calls[0].init.method, "DELETE");
});

test("client: API error codes map to actionable messages", async () => {
  const cases = [
    [{ status: 401, body: { error: "invalid_token" } }, /revoked or expired/],
    [{ status: 403, body: { error: "insufficient_scope", message: "needs posts:write" } }, /posts:read \+ posts:write/],
    [{ status: 409, body: { error: "x_account_not_connected" } }, /connect X inside vibedraft/],
    [{ status: 409, body: { error: "not_cancelable", message: "already posted" } }, /only pending/i],
    [{ status: 404, body: { error: "not_found" } }, /no scheduled post with that id/],
    [{ status: 429, body: { error: "rate_limited" } }, /wait a minute/],
    [{ status: 422, body: { error: "validation_failed", message: "bad time" } }, /bad time/],
  ];
  for (const [resp, re] of cases) {
    const { impl } = mockFetch(() => resp);
    const client = makeScheduleClient({ ...CFG, fetchImpl: impl });
    await assert.rejects(() => client.listScheduled(), re);
  }
});

test("client: network failure names the base URL", async () => {
  const impl = async () => { throw new Error("ECONNREFUSED"); };
  const client = makeScheduleClient({ ...CFG, fetchImpl: impl });
  await assert.rejects(() => client.listScheduled(), /could not reach vibedraft at https:\/\/vibedraft\.app/);
});
