import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveVibedraftConfig,
  validateSchedule,
  validateBulkSchedule,
  makeScheduleClient,
  scheduleMediaMime,
  SCHEDULE_POSTS_MAX,
  BULK_ITEMS_MAX,
  SCHEDULE_IMAGE_MAX_BYTES,
} from "../scheduler.mjs";

const NOW = new Date("2026-07-06T12:00:00.000Z");
const IN_3H = "2026-07-06T15:00:00.000Z";

// Real temp files — validateSchedule stats them for size/type.
const PNG = join(tmpdir(), `sched-media-${process.pid}.png`);
const MP4 = join(tmpdir(), `sched-media-${process.pid}.mp4`);
const GIF = join(tmpdir(), `sched-media-${process.pid}.gif`);
const BIG_PNG = join(tmpdir(), `sched-media-big-${process.pid}.png`);
before(() => {
  writeFileSync(PNG, Buffer.alloc(1024));
  writeFileSync(MP4, Buffer.alloc(2048));
  writeFileSync(GIF, Buffer.alloc(64));
  writeFileSync(BIG_PNG, Buffer.alloc(SCHEDULE_IMAGE_MAX_BYTES + 1));
});
after(() => {
  for (const f of [PNG, MP4, GIF, BIG_PNG]) rmSync(f, { force: true });
});

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

test("validate: media happy paths (png image, mp4 video)", () => {
  assert.deepEqual(validateSchedule({ tweets: ["x"], scheduledFor: IN_3H, image: PNG }, NOW), []);
  assert.deepEqual(validateSchedule({ tweets: ["x"], scheduledFor: IN_3H, video: MP4 }, NOW), []);
});

test("validate: media matrix — missing, unsupported, wrong-flag, oversized, both", () => {
  // missing-file wording matches buildPlan's ("image/video not found") so
  // composed callers dedupe to one line
  assert.ok(
    validateSchedule({ tweets: ["x"], scheduledFor: IN_3H, image: "/nope.png" }, NOW)
      .some((e) => /image not found/.test(e)),
  );
  assert.ok(
    validateSchedule({ tweets: ["x"], scheduledFor: IN_3H, video: "/nope.mp4" }, NOW)
      .some((e) => /video not found/.test(e)),
  );
  assert.ok(
    validateSchedule({ tweets: ["x"], scheduledFor: IN_3H, image: GIF }, NOW)
      .some((e) => /unsupported media type/.test(e)),
  );
  assert.ok(
    validateSchedule({ tweets: ["x"], scheduledFor: IN_3H, image: MP4 }, NOW)
      .some((e) => /pass a \.mp4 as video/.test(e)),
  );
  assert.ok(
    validateSchedule({ tweets: ["x"], scheduledFor: IN_3H, video: PNG }, NOW)
      .some((e) => /video must be \.mp4/.test(e)),
  );
  assert.ok(
    validateSchedule({ tweets: ["x"], scheduledFor: IN_3H, image: BIG_PNG }, NOW)
      .some((e) => /too large/.test(e)),
  );
  assert.ok(
    validateSchedule({ tweets: ["x"], scheduledFor: IN_3H, image: PNG, video: MP4 }, NOW)
      .some((e) => /mutually exclusive/.test(e)),
  );
});

test("scheduleMediaMime: extension map, case-insensitive, null for unknown", () => {
  assert.equal(scheduleMediaMime("/a/b/clip.MP4"), "video/mp4");
  assert.equal(scheduleMediaMime("shot.jpeg"), "image/jpeg");
  assert.equal(scheduleMediaMime("shot.webp"), "image/webp");
  assert.equal(scheduleMediaMime("anim.gif"), null);
  assert.equal(scheduleMediaMime("noext"), null);
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

test("client: schedulePosts puts media_id on the FIRST post only", async () => {
  const { impl, calls } = mockFetch(() => ({ status: 201, body: { posts: [{ id: "p1" }] } }));
  const client = makeScheduleClient({ ...CFG, fetchImpl: impl });
  await client.schedulePosts({ tweets: ["root", "reply"], scheduledFor: IN_3H, mediaId: "m-9" });
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.posts, [{ content: "root", media_id: "m-9" }, { content: "reply" }]);
});

// ---------------------------------------------------------------------------
// uploadMedia — init → signed-URL PUT → complete, with the bytes going DIRECT
// to storage (never through the bearer-authed API path).
// ---------------------------------------------------------------------------

function mockUploadFetch({ initBody, putStatus = 200, completeBody } = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.endsWith("/api/v1/media")) {
      return { ok: true, status: 201, json: async () => initBody ?? {
        media_id: "m-1",
        upload: { signed_url: "https://storage.example/upload/sign/compose-media/u1/m-1.mp4?token=tok123" },
      } };
    }
    if (url.includes("storage.example")) {
      return { ok: putStatus < 300, status: putStatus, json: async () => ({ error: "put failed" }) };
    }
    if (url.endsWith("/complete")) {
      return { ok: true, status: 200, json: async () => completeBody ?? { media: { id: "m-1", status: "ready" } } };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  return { impl, calls };
}

test("uploadMedia: init carries mime+size, bytes PUT to the signed URL, complete marks ready", async () => {
  const { impl, calls } = mockUploadFetch();
  const client = makeScheduleClient({ ...CFG, fetchImpl: impl });
  const readCalls = [];
  const out = await client.uploadMedia({
    filePath: "/videos/demo.mp4",
    readFileImpl: (p) => { readCalls.push(p); return Buffer.alloc(2048); },
  });
  assert.deepEqual(readCalls, ["/videos/demo.mp4"]);
  assert.equal(out.mediaId, "m-1");
  assert.equal(out.media.status, "ready");

  assert.equal(calls.length, 3);
  // 1. init — bearer-authed API call with metadata only (no bytes)
  assert.equal(calls[0].url, "https://vibedraft.app/api/v1/media");
  assert.equal(calls[0].init.headers.Authorization, "Bearer vd_pat_test");
  assert.deepEqual(JSON.parse(calls[0].init.body), { mime_type: "video/mp4", size_bytes: 2048 });
  // 2. PUT — direct to storage, token in the URL, NO vibedraft bearer
  assert.match(calls[1].url, /^https:\/\/storage\.example\/.*token=tok123/);
  assert.equal(calls[1].init.method, "PUT");
  assert.equal(calls[1].init.headers["Content-Type"], "video/mp4");
  assert.equal(calls[1].init.headers.Authorization, undefined);
  assert.equal(calls[1].init.body.length, 2048);
  // 3. complete — back on the bearer-authed API
  assert.equal(calls[2].url, "https://vibedraft.app/api/v1/media/m-1/complete");
  assert.equal(calls[2].init.method, "POST");
});

test("uploadMedia: separate token is appended when the signed URL lacks one", async () => {
  const { impl, calls } = mockUploadFetch({
    initBody: { media_id: "m-2", upload: { signed_url: "https://storage.example/upload/sign/x", token: "sep-tok" } },
    completeBody: { media: { id: "m-2", status: "ready" } },
  });
  const client = makeScheduleClient({ ...CFG, fetchImpl: impl });
  await client.uploadMedia({ filePath: "/a.png", readFileImpl: () => Buffer.alloc(8) });
  assert.match(calls[1].url, /\?token=sep-tok$/);
});

test("uploadMedia: unsupported type and unreadable file fail before any network call", async () => {
  const { impl, calls } = mockUploadFetch();
  const client = makeScheduleClient({ ...CFG, fetchImpl: impl });
  await assert.rejects(() => client.uploadMedia({ filePath: "/a.gif" }), /unsupported media type/);
  await assert.rejects(
    () => client.uploadMedia({ filePath: "/a.png", readFileImpl: () => { throw new Error("EACCES"); } }),
    /could not read media file/,
  );
  assert.equal(calls.length, 0);
});

test("uploadMedia: storage PUT failure surfaces status + detail, complete never called", async () => {
  const { impl, calls } = mockUploadFetch({ putStatus: 403 });
  const client = makeScheduleClient({ ...CFG, fetchImpl: impl });
  await assert.rejects(
    () => client.uploadMedia({ filePath: "/a.mp4", readFileImpl: () => Buffer.alloc(8) }),
    /media upload to storage failed: 403.*put failed/,
  );
  assert.equal(calls.length, 2); // init + PUT only
});

test("uploadMedia: malformed init response names the problem", async () => {
  const { impl } = mockUploadFetch({ initBody: { nope: true } });
  const client = makeScheduleClient({ ...CFG, fetchImpl: impl });
  await assert.rejects(
    () => client.uploadMedia({ filePath: "/a.mp4", readFileImpl: () => Buffer.alloc(8) }),
    /no media_id\/signed_url/,
  );
});

test("client: media API error codes map to actionable messages", async () => {
  const cases = [
    [{ status: 415, body: { error: "unsupported_media_type" } }, /jpg\/jpeg\/png\/webp images/],
    [{ status: 413, body: { error: "media_too_large" } }, /size limit/],
    [{ status: 409, body: { error: "media_not_ready" } }, /upload the file again/],
    [{ status: 409, body: { error: "upload_incomplete" } }, /retry the upload/],
  ];
  for (const [resp, re] of cases) {
    const { impl } = mockFetch(() => resp);
    const client = makeScheduleClient({ ...CFG, fetchImpl: impl });
    await assert.rejects(() => client.listScheduled(), re);
  }
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

test("client: API errors carry machine-readable status + apiCode", async () => {
  const { impl } = mockFetch(() => ({ status: 422, body: { error: "validation_failed", message: "bad" } }));
  const client = makeScheduleClient({ ...CFG, fetchImpl: impl });
  try {
    await client.listScheduled();
    assert.fail("should have thrown");
  } catch (e) {
    assert.equal(e.status, 422);
    assert.equal(e.apiCode, "validation_failed");
  }
});

// ---------------------------------------------------------------------------
// validateBulkSchedule
// ---------------------------------------------------------------------------

const ITEM = { tweets: ["hi"], scheduledFor: IN_3H };

test("bulk validate: happy path — mixed singles and threads", () => {
  assert.deepEqual(
    validateBulkSchedule(
      [ITEM, { tweets: ["a", "b"], scheduledFor: "2026-07-07T09:00:00+02:00" }],
      NOW,
    ),
    [],
  );
});

test("bulk validate: empty and over-cap arrays", () => {
  assert.deepEqual(validateBulkSchedule([], NOW), ["no posts provided"]);
  assert.deepEqual(validateBulkSchedule(undefined, NOW), ["no posts provided"]);
  const over = Array.from({ length: BULK_ITEMS_MAX + 1 }, () => ITEM);
  assert.ok(validateBulkSchedule(over, NOW)[0].includes(`capped at ${BULK_ITEMS_MAX}`));
  assert.deepEqual(validateBulkSchedule(Array.from({ length: BULK_ITEMS_MAX }, () => ITEM), NOW), []);
});

test("bulk validate: per-item errors carry a 'post N:' prefix", () => {
  const errs = validateBulkSchedule(
    [ITEM, { tweets: [], scheduledFor: IN_3H }, { tweets: ["x"], scheduledFor: "not-a-date" }],
    NOW,
  );
  assert.ok(errs.some((e) => e.startsWith("post 2: ") && /no tweets/.test(e)));
  assert.ok(errs.some((e) => e.startsWith("post 3: ") && /ISO 8601/.test(e)));
  assert.ok(!errs.some((e) => e.startsWith("post 1: ")));
});

test("bulk validate: offset-less scheduled_for is rejected (bulk is stricter)", () => {
  const errs = validateBulkSchedule([{ tweets: ["x"], scheduledFor: "2026-07-06T15:00:00" }], NOW);
  assert.ok(errs.some((e) => /explicit UTC offset or Z/.test(e)));
  // Both Z and numeric offsets are fine
  assert.deepEqual(
    validateBulkSchedule(
      [
        { tweets: ["x"], scheduledFor: "2026-07-06T15:00:00Z" },
        { tweets: ["x"], scheduledFor: "2026-07-06T15:00:00-07:00" },
      ],
      NOW,
    ),
    [],
  );
});

test("bulk validate: media is rejected explicitly (text-only), never silently dropped", () => {
  const errs = validateBulkSchedule(
    [ITEM, { tweets: ["x"], scheduledFor: IN_3H, image: PNG }, { tweets: ["y"], scheduledFor: IN_3H, video: MP4 }],
    NOW,
  );
  assert.ok(errs.some((e) => e.startsWith("post 2: ") && /text-only/.test(e)));
  assert.ok(errs.some((e) => e.startsWith("post 3: ") && /text-only/.test(e)));
  assert.ok(!errs.some((e) => e.startsWith("post 1: ")));
  // the text-only rejection is the ONLY media error (no confusing type/size noise)
  assert.equal(errs.length, 2);
});

test("bulk validate: reply constraints apply per item", () => {
  const errs = validateBulkSchedule(
    [{ tweets: ["a", "b"], scheduledFor: IN_3H, inReplyTo: "123" }],
    NOW,
  );
  assert.ok(errs.some((e) => e.startsWith("post 1: ") && /single scheduled post/.test(e)));
});

// ---------------------------------------------------------------------------
// scheduleBulk — sequential loop, per-item results, abort semantics
// ---------------------------------------------------------------------------

function bulkItems(n) {
  return Array.from({ length: n }, (_, i) => ({
    tweets: [`post ${i + 1}`],
    scheduledFor: `2026-07-0${(i % 3) + 7}T0${i % 10}:00:00Z`,
  }));
}

test("bulk client: all-success preserves order and captures jittered times + ids", async () => {
  let n = 0;
  const { impl, calls } = mockFetch(() => {
    n += 1;
    return { status: 201, body: { posts: [{ id: `p${n}`, scheduled_for: `jittered-${n}` }] } };
  });
  const client = makeScheduleClient({ ...CFG, fetchImpl: impl });
  const out = await client.scheduleBulk({ items: bulkItems(3) });
  assert.equal(calls.length, 3);
  assert.equal(out.scheduledCount, 3);
  assert.equal(out.failedCount, 0);
  assert.equal(out.aborted, false);
  assert.deepEqual(out.results.map((r) => r.status), ["scheduled", "scheduled", "scheduled"]);
  assert.deepEqual(out.results.map((r) => r.ids), [["p1"], ["p2"], ["p3"]]);
  assert.deepEqual(out.results.map((r) => r.scheduled_for), ["jittered-1", "jittered-2", "jittered-3"]);
  // sequential: item 1's body went first
  assert.equal(JSON.parse(calls[0].init.body).posts[0].content, "post 1");
});

test("bulk client: per-item 422 records failure and continues", async () => {
  let n = 0;
  const { impl, calls } = mockFetch(() => {
    n += 1;
    if (n === 2) return { status: 422, body: { error: "validation_failed", message: "bad time" } };
    return { status: 201, body: { posts: [{ id: `p${n}` }] } };
  });
  const client = makeScheduleClient({ ...CFG, fetchImpl: impl });
  const out = await client.scheduleBulk({ items: bulkItems(3) });
  assert.equal(calls.length, 3); // item 3 still attempted
  assert.equal(out.scheduledCount, 2);
  assert.equal(out.failedCount, 1);
  assert.equal(out.aborted, false);
  assert.equal(out.results[1].status, "failed");
  assert.match(out.results[1].error, /bad time/);
});

test("bulk client: fatal code aborts — remaining items skipped, never sent", async () => {
  let n = 0;
  const { impl, calls } = mockFetch(() => {
    n += 1;
    if (n === 2) return { status: 401, body: { error: "invalid_token" } };
    return { status: 201, body: { posts: [{ id: `p${n}` }] } };
  });
  const client = makeScheduleClient({ ...CFG, fetchImpl: impl });
  const out = await client.scheduleBulk({ items: bulkItems(4) });
  assert.equal(calls.length, 2); // items 3+4 never sent
  assert.equal(out.aborted, true);
  assert.match(out.abortReason, /revoked or expired/);
  assert.deepEqual(out.results.map((r) => r.status), ["scheduled", "failed", "skipped", "skipped"]);
  assert.match(out.results[2].error, /not attempted/);
});

test("bulk client: 429 sleeps and retries the SAME item, then succeeds", async () => {
  const sleeps = [];
  let n = 0;
  const { impl, calls } = mockFetch(() => {
    n += 1;
    if (n === 1) return { status: 429, body: { error: "rate_limited" } };
    return { status: 201, body: { posts: [{ id: `p${n}` }] } };
  });
  const client = makeScheduleClient({ ...CFG, fetchImpl: impl });
  const out = await client.scheduleBulk({
    items: bulkItems(2),
    sleepImpl: async (ms) => sleeps.push(ms),
  });
  assert.equal(calls.length, 3); // item1 twice + item2 once
  assert.deepEqual(sleeps, [10_000]);
  assert.equal(out.scheduledCount, 2);
  assert.equal(out.aborted, false);
  // retried call resent the same content
  assert.equal(JSON.parse(calls[1].init.body).posts[0].content, "post 1");
});

test("bulk client: persistent 429 exhausts retries then aborts", async () => {
  const sleeps = [];
  const { impl, calls } = mockFetch(() => ({ status: 429, body: { error: "rate_limited" } }));
  const client = makeScheduleClient({ ...CFG, fetchImpl: impl });
  const out = await client.scheduleBulk({
    items: bulkItems(3),
    sleepImpl: async (ms) => sleeps.push(ms),
  });
  assert.equal(calls.length, 3); // 1 attempt + 2 retries, all on item 1
  assert.equal(sleeps.length, 2);
  assert.deepEqual(out.results.map((r) => r.status), ["failed", "skipped", "skipped"]);
  assert.equal(out.aborted, true);
});

test("bulk client: network error marks the item unknown and aborts", async () => {
  let n = 0;
  const impl = async (url, init) => {
    n += 1;
    if (n === 2) throw new Error("socket hang up");
    return { ok: true, status: 201, json: async () => ({ posts: [{ id: `p${n}` }] }) };
  };
  const client = makeScheduleClient({ ...CFG, fetchImpl: impl });
  const out = await client.scheduleBulk({ items: bulkItems(3) });
  assert.equal(n, 2);
  assert.deepEqual(out.results.map((r) => r.status), ["scheduled", "unknown", "skipped"]);
  assert.match(out.results[1].error, /list_scheduled before resubmitting/);
  assert.equal(out.aborted, true);
});
