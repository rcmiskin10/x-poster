import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTools, renderBulkDashboard } from "../server.mjs";

// preview_bulk / schedule_bulk: up to 20 independent posts, one confirmed
// action. Same gate discipline as schedule_post — bulk nonce is content-bound
// (times excluded) and can never cross-verify with a single-post nonce.

const IN_3H = new Date(Date.now() + 3 * 60 * 60_000).toISOString();
const IN_5H = new Date(Date.now() + 5 * 60 * 60_000).toISOString();

function makeMockClient() {
  const calls = { bulk: [] };
  return {
    calls,
    scheduleBulk: async ({ items }) => {
      calls.bulk.push(items);
      return {
        results: items.map((it, index) => ({
          index,
          ok: true,
          status: "scheduled",
          ids: [`row-${index}`],
          scheduled_for: it.scheduledFor,
        })),
        scheduledCount: items.length,
        failedCount: 0,
        aborted: false,
      };
    },
  };
}

function makeBulkTools(client = makeMockClient()) {
  const tools = makeTools({
    postThread: async () => { throw new Error("postThread must NOT be called by bulk scheduling"); },
    statePath: "/tmp/x",
    elicit: null,
    getScheduleClient: () => client,
  });
  return { tools, client };
}

const TWO_POSTS = [
  { text: "first post", scheduled_for: IN_3H },
  { text: "second post", scheduled_for: IN_5H },
];

test("preview_bulk: returns per-item plans, total cost, nonce, and a verbatim render", async () => {
  const { tools } = makeBulkTools();
  const preview = await tools.preview_bulk.handler({ posts: TWO_POSTS });
  assert.equal(preview.items.length, 2);
  assert.equal(preview.errors.length, 0);
  assert.ok(preview.confirm_nonce);
  assert.ok(Math.abs(preview.totalEstimatedCostUsd - 0.03) < 1e-9);
  assert.match(preview.render, /bulk ×2/);
  assert.match(preview.render, /est\. \$0\.030 total/);
  assert.match(preview.render, /awaiting explicit confirmation/);
});

test("preview_bulk: validation errors are per-item prefixed and block nothing silently", async () => {
  const { tools } = makeBulkTools();
  const preview = await tools.preview_bulk.handler({
    posts: [
      { text: "fine", scheduled_for: IN_3H },
      { text: "bad time", scheduled_for: "2030-01-01T09:00:00" }, // no offset
    ],
  });
  assert.ok(preview.errors.some((e) => e.startsWith("post 2: ") && /offset/.test(e)));
  assert.match(preview.render, /❌ validate/);
  assert.match(preview.render, /nothing was submitted/);
});

test("schedule_bulk: rejects without a nonce (no gate bypass)", async () => {
  const { tools, client } = makeBulkTools();
  await assert.rejects(
    () => tools.schedule_bulk.handler({ posts: TWO_POSTS }),
    /confirm_nonce.*preview_bulk/,
  );
  assert.equal(client.calls.bulk.length, 0);
});

test("schedule_bulk: preview_bulk nonce for the same posts verifies; client called once with all items", async () => {
  const { tools, client } = makeBulkTools();
  const preview = await tools.preview_bulk.handler({ posts: TWO_POSTS });
  const result = await tools.schedule_bulk.handler({ posts: TWO_POSTS, confirm_nonce: preview.confirm_nonce });
  assert.equal(client.calls.bulk.length, 1);
  assert.equal(client.calls.bulk[0].length, 2);
  assert.deepEqual(client.calls.bulk[0][0].tweets, ["first post"]);
  assert.equal(result.scheduledCount, 2);
  assert.match(result.render, /2\/2 scheduled/);
});

test("schedule_bulk: nonce is content-bound — mutating, adding, or removing an item breaks it", async () => {
  const { tools, client } = makeBulkTools();
  const preview = await tools.preview_bulk.handler({ posts: TWO_POSTS });

  await assert.rejects(
    () => tools.schedule_bulk.handler({
      posts: [{ text: "TAMPERED", scheduled_for: IN_3H }, TWO_POSTS[1]],
      confirm_nonce: preview.confirm_nonce,
    }),
    /confirm_nonce/,
  );
  await assert.rejects(
    () => tools.schedule_bulk.handler({
      posts: [...TWO_POSTS, { text: "smuggled in", scheduled_for: IN_5H }],
      confirm_nonce: preview.confirm_nonce,
    }),
    /confirm_nonce/,
  );
  await assert.rejects(
    () => tools.schedule_bulk.handler({ posts: [TWO_POSTS[0]], confirm_nonce: preview.confirm_nonce }),
    /confirm_nonce/,
  );
  assert.equal(client.calls.bulk.length, 0);
});

test("schedule_bulk: changing ONLY times still verifies (content frozen, time chosen at confirm)", async () => {
  const { tools, client } = makeBulkTools();
  const preview = await tools.preview_bulk.handler({ posts: TWO_POSTS });
  const shifted = TWO_POSTS.map((p) => ({ ...p, scheduled_for: IN_5H }));
  const result = await tools.schedule_bulk.handler({ posts: shifted, confirm_nonce: preview.confirm_nonce });
  assert.equal(result.scheduledCount, 2);
  assert.equal(client.calls.bulk[0][0].scheduledFor, IN_5H);
});

test("schedule_bulk: a preview_post (single) nonce never authorizes a bulk call", async () => {
  const { tools, client } = makeBulkTools();
  const single = await tools.preview_post.handler({ text: "first post" });
  await assert.rejects(
    () => tools.schedule_bulk.handler({
      posts: [{ text: "first post", scheduled_for: IN_3H }],
      confirm_nonce: single.confirm_nonce,
    }),
    /confirm_nonce/,
  );
  // and the reverse: a bulk nonce never authorizes schedule_post
  const bulk = await tools.preview_bulk.handler({ posts: [{ text: "first post", scheduled_for: IN_3H }] });
  await assert.rejects(
    () => tools.schedule_post.handler({
      text: "first post",
      scheduled_for: IN_3H,
      confirm_nonce: bulk.confirm_nonce,
    }),
    /confirm_nonce/,
  );
  assert.equal(client.calls.bulk.length, 0);
});

test("schedule_bulk: validation is all-or-nothing — one bad item, client never called", async () => {
  const { tools, client } = makeBulkTools();
  const posts = [
    { text: "fine", scheduled_for: IN_3H },
    { text: "too soon", scheduled_for: new Date(Date.now() + 30_000).toISOString() },
  ];
  const preview = await tools.preview_bulk.handler({ posts });
  await assert.rejects(
    () => tools.schedule_bulk.handler({ posts, confirm_nonce: preview.confirm_nonce }),
    /post 2: .*2 minutes/,
  );
  assert.equal(client.calls.bulk.length, 0);
});

test("schedule_bulk: over-cap and both-text-and-thread are rejected before the gate", async () => {
  const { tools, client } = makeBulkTools();
  const over = Array.from({ length: 21 }, (_, i) => ({ text: `p${i}`, scheduled_for: IN_3H }));
  await assert.rejects(() => tools.schedule_bulk.handler({ posts: over }), /capped at 20/);
  await assert.rejects(
    () => tools.schedule_bulk.handler({ posts: [{ text: "x", thread: ["a", "b"], scheduled_for: IN_3H }] }),
    /post 1: .*not both/,
  );
  assert.equal(client.calls.bulk.length, 0);
});

test("schedule_bulk: partial failure RESOLVES with per-item statuses and recovery hint", async () => {
  const client = {
    calls: { bulk: [] },
    scheduleBulk: async ({ items }) => {
      client.calls.bulk.push(items);
      return {
        results: [
          { index: 0, ok: true, status: "scheduled", ids: ["row-0"], scheduled_for: items[0].scheduledFor },
          { index: 1, ok: false, status: "failed", error: "vibedraft rejected the request (bad)" },
          { index: 2, ok: false, status: "skipped", error: "not attempted: boom" },
        ],
        scheduledCount: 1,
        failedCount: 2,
        aborted: true,
        abortReason: "boom",
      };
    },
  };
  const { tools } = makeBulkTools(client);
  const posts = [
    { text: "a", scheduled_for: IN_3H },
    { text: "b", scheduled_for: IN_3H },
    { text: "c", scheduled_for: IN_3H },
  ];
  const preview = await tools.preview_bulk.handler({ posts });
  const result = await tools.schedule_bulk.handler({ posts, confirm_nonce: preview.confirm_nonce });
  assert.equal(result.aborted, true);
  assert.equal(result.scheduledCount, 1);
  assert.match(result.render, /1\/3 scheduled/);
  assert.match(result.render, /⚠️ partial/);
  assert.match(result.render, /cancel_scheduled/);
  assert.match(result.render, /⏭ skipped/);
});

test("schedule_bulk: elicit branch — approval schedules all, decline schedules none, message truncates items", async () => {
  const client = makeMockClient();
  const rendereds = [];
  const makeWith = (approve) => makeTools({
    postThread: async () => { throw new Error("no posting"); },
    statePath: "/tmp/x",
    elicit: async ({ rendered }) => { rendereds.push(rendered); return approve; },
    getScheduleClient: () => client,
  });

  const longText = "x".repeat(300);
  const posts = [{ text: longText, scheduled_for: IN_3H }, { text: "short", scheduled_for: IN_5H }];

  const yes = makeWith(true);
  await yes.schedule_bulk.handler({ posts });
  assert.equal(client.calls.bulk.length, 1);
  assert.match(rendereds[0], /Bulk schedule 2 posts/);
  assert.ok(rendereds[0].includes("…"), "long items are truncated for display");

  const no = makeWith(false);
  await assert.rejects(() => no.schedule_bulk.handler({ posts }), /user declined/);
  assert.equal(client.calls.bulk.length, 1);
});

test("renderBulkDashboard: preview lists one line per item with time, kind, and cost", () => {
  const render = renderBulkDashboard({
    stage: "preview",
    items: [
      { tweets: ["hello world"], scheduledFor: "2026-07-10T09:00:00Z", estimatedCostUsd: 0.015 },
      { tweets: ["one", "two"], scheduledFor: "2026-07-10T13:00:00Z", estimatedCostUsd: 0.03 },
    ],
    totalEstimatedCostUsd: 0.045,
    errors: [],
  });
  assert.match(render, /bulk ×2/);
  assert.match(render, / 1│ 2026-07-10T09:00:00Z · post · \$0\.015 · hello world/);
  assert.match(render, / 2│ 2026-07-10T13:00:00Z · thread ×2 · \$0\.030/);
  assert.match(render, /2 posts · 3 tweets/);
  assert.match(render, /humanization jitter/);
});

test("bulk tools: unconfigured client throws the actionable default", async () => {
  const tools = makeTools({ postThread: async () => ["1"], statePath: "/tmp/x", elicit: null });
  const preview = await tools.preview_bulk.handler({ posts: [{ text: "x", scheduled_for: IN_3H }] });
  await assert.rejects(
    () => tools.schedule_bulk.handler({ posts: [{ text: "x", scheduled_for: IN_3H }], confirm_nonce: preview.confirm_nonce }),
    /not configured/,
  );
});
