import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeTools } from "../server.mjs";

// schedule_post must go through the SAME human gate as publish_post: a nonce
// minted by preview_post for the exact payload, or an elicitation confirm.
// These tests exercise the SDK-free makeTools factory with a mock client.

const IN_3H = new Date(Date.now() + 3 * 60 * 60_000).toISOString();

// Real temp files — schedule-time media validation stats them.
const CLIP = join(tmpdir(), `sched-tools-${process.pid}.mp4`);
const SHOT = join(tmpdir(), `sched-tools-${process.pid}.png`);
before(() => {
  writeFileSync(CLIP, Buffer.alloc(2048));
  writeFileSync(SHOT, Buffer.alloc(1024));
});
after(() => {
  for (const f of [CLIP, SHOT]) rmSync(f, { force: true });
});

function makeMockClient() {
  const calls = { schedule: [], list: [], cancel: [], upload: [] };
  return {
    calls,
    uploadMedia: async (args) => {
      calls.upload.push(args);
      return { mediaId: "m-77", media: { id: "m-77", status: "ready" } };
    },
    schedulePosts: async (args) => {
      calls.schedule.push(args);
      return args.tweets.map((t, i) => ({
        id: `row-${i}`,
        content: t,
        scheduled_for: args.scheduledFor,
        status: "pending",
      }));
    },
    listScheduled: async (args) => {
      calls.list.push(args);
      return [{ id: "row-0", status: "posted", posted_tweet_id: "190000" }];
    },
    cancelScheduled: async (id) => {
      calls.cancel.push(id);
      return [id];
    },
  };
}

function makeScheduleTools(client = makeMockClient()) {
  const tools = makeTools({
    postThread: async () => { throw new Error("postThread must NOT be called by scheduling"); },
    statePath: "/tmp/x",
    elicit: null,
    getScheduleClient: () => client,
  });
  return { tools, client };
}

test("schedule_post: rejects without a nonce (no gate bypass)", async () => {
  const { tools } = makeScheduleTools();
  await assert.rejects(
    () => tools.schedule_post.handler({ text: "hi", scheduled_for: IN_3H }),
    /confirm_nonce/,
  );
});

test("schedule_post: preview nonce for the same payload verifies; client called; render says scheduled", async () => {
  const { tools, client } = makeScheduleTools();
  const preview = await tools.preview_post.handler({ text: "ship at nine" });
  const result = await tools.schedule_post.handler({
    text: "ship at nine",
    scheduled_for: IN_3H,
    confirm_nonce: preview.confirm_nonce,
  });
  assert.equal(client.calls.schedule.length, 1);
  assert.deepEqual(client.calls.schedule[0].tweets, ["ship at nine"]);
  assert.equal(result.scheduled.length, 1);
  assert.match(result.render, /📅 scheduled/);
  assert.match(result.render, /billed via vibedraft/);
});

test("schedule_post: nonce is payload-bound — different text does not verify", async () => {
  const { tools, client } = makeScheduleTools();
  const preview = await tools.preview_post.handler({ text: "original" });
  await assert.rejects(
    () => tools.schedule_post.handler({
      text: "tampered",
      scheduled_for: IN_3H,
      confirm_nonce: preview.confirm_nonce,
    }),
    /confirm_nonce/,
  );
  assert.equal(client.calls.schedule.length, 0);
});

test("schedule_post: video flows — nonce binds it, upload happens after the gate, media_id reaches the API", async () => {
  const { tools, client } = makeScheduleTools();
  const preview = await tools.preview_post.handler({ text: "demo drop", video: CLIP });
  assert.equal(preview.hasVideo, true);
  const result = await tools.schedule_post.handler({
    text: "demo drop",
    scheduled_for: IN_3H,
    video: CLIP,
    confirm_nonce: preview.confirm_nonce,
  });
  assert.deepEqual(client.calls.upload, [{ filePath: CLIP }]);
  assert.equal(client.calls.schedule[0].mediaId, "m-77");
  assert.equal(result.media_id, "m-77");
  assert.match(result.render, /🎬 video/);
  assert.match(result.render, /📎 media uploaded to vibedraft \(id m-77\)/);
});

test("schedule_post: image flows the same way", async () => {
  const { tools, client } = makeScheduleTools();
  const preview = await tools.preview_post.handler({ text: "with pic", image: SHOT });
  const result = await tools.schedule_post.handler({
    text: "with pic",
    scheduled_for: IN_3H,
    image: SHOT,
    confirm_nonce: preview.confirm_nonce,
  });
  assert.deepEqual(client.calls.upload, [{ filePath: SHOT }]);
  assert.equal(client.calls.schedule[0].mediaId, "m-77");
  assert.match(result.render, /🖼 image/);
});

test("schedule_post: the nonce is media-bound in BOTH directions", async () => {
  const { tools, client } = makeScheduleTools();
  // media-bound nonce must not authorize a text-only schedule
  const withMedia = await tools.preview_post.handler({ text: "same words", video: CLIP });
  await assert.rejects(
    () => tools.schedule_post.handler({ text: "same words", scheduled_for: IN_3H, confirm_nonce: withMedia.confirm_nonce }),
    /confirm_nonce/,
  );
  // text-only nonce must not authorize a schedule WITH media
  const textOnly = await tools.preview_post.handler({ text: "same words" });
  await assert.rejects(
    () => tools.schedule_post.handler({ text: "same words", scheduled_for: IN_3H, video: CLIP, confirm_nonce: textOnly.confirm_nonce }),
    /confirm_nonce/,
  );
  assert.equal(client.calls.upload.length, 0);
  assert.equal(client.calls.schedule.length, 0);
});

test("schedule_post: media validation failures never reach upload (missing file, oversized rejected upstream)", async () => {
  const { tools, client } = makeScheduleTools();
  const preview = await tools.preview_post.handler({ text: "ghost", video: "/tmp/nope.mp4" });
  await assert.rejects(
    () => tools.schedule_post.handler({
      text: "ghost",
      scheduled_for: IN_3H,
      video: "/tmp/nope.mp4",
      confirm_nonce: preview.confirm_nonce,
    }),
    /not found/,
  );
  assert.equal(client.calls.upload.length, 0);
  assert.equal(client.calls.schedule.length, 0);
});

test("schedule_post: thread nonce round-trips; rows map per tweet", async () => {
  const { tools, client } = makeScheduleTools();
  const thread = ["one", "two", "three"];
  const preview = await tools.preview_post.handler({ thread });
  const result = await tools.schedule_post.handler({
    thread,
    scheduled_for: IN_3H,
    confirm_nonce: preview.confirm_nonce,
  });
  assert.deepEqual(client.calls.schedule[0].tweets, thread);
  assert.equal(result.scheduled.length, 3);
  assert.match(result.render, /thread ×3/);
});

test("schedule_post: validation failures never reach the client", async () => {
  const { tools, client } = makeScheduleTools();
  const preview = await tools.preview_post.handler({ text: "soon" });
  await assert.rejects(
    () => tools.schedule_post.handler({
      text: "soon",
      scheduled_for: new Date(Date.now() + 30_000).toISOString(), // < 2min lead
      confirm_nonce: preview.confirm_nonce,
    }),
    /2 minutes/,
  );
  await assert.rejects(
    () => tools.schedule_post.handler({
      thread: ["a", "b"],
      scheduled_for: IN_3H,
      in_reply_to: "123",
      confirm_nonce: "irrelevant",
    }),
    /single scheduled post/,
  );
  assert.equal(client.calls.schedule.length, 0);
});

test("schedule_post: elicit branch — approval schedules, decline does not", async () => {
  const client = makeMockClient();
  const approvals = [];
  const makeWith = (approve) => makeTools({
    postThread: async () => { throw new Error("no posting"); },
    statePath: "/tmp/x",
    elicit: async ({ rendered }) => { approvals.push(rendered); return approve; },
    getScheduleClient: () => client,
  });

  const yes = makeWith(true);
  await yes.schedule_post.handler({ text: "elicited", scheduled_for: IN_3H });
  assert.equal(client.calls.schedule.length, 1);
  assert.match(approvals[0], /Schedule for:/);

  const no = makeWith(false);
  await assert.rejects(
    () => no.schedule_post.handler({ text: "elicited", scheduled_for: IN_3H }),
    /user declined/,
  );
  assert.equal(client.calls.schedule.length, 1);
});

test("list_scheduled: passes filters through and returns posts with posted_tweet_id", async () => {
  const { tools, client } = makeScheduleTools();
  const result = await tools.list_scheduled.handler({ status: "posted", limit: 10 });
  assert.deepEqual(client.calls.list[0], { status: "posted", since: undefined, limit: 10 });
  assert.equal(result.posts[0].posted_tweet_id, "190000");
});

test("cancel_scheduled: requires id, forwards to client", async () => {
  const { tools, client } = makeScheduleTools();
  await assert.rejects(() => tools.cancel_scheduled.handler({}), /id is required/);
  const result = await tools.cancel_scheduled.handler({ id: "row-9" });
  assert.deepEqual(client.calls.cancel, ["row-9"]);
  assert.deepEqual(result.canceled, ["row-9"]);
});

test("schedule tools: unconfigured client throws the actionable default", async () => {
  const tools = makeTools({ postThread: async () => ["1"], statePath: "/tmp/x", elicit: null });
  await assert.rejects(() => tools.list_scheduled.handler({}), /not configured/);
});
