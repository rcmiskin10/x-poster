// surface-parity.test.mjs — every core capability must be wired into EVERY surface.
//
// Born from two real drift incidents the ordinary suites stayed green through:
//   1. A port based on a stale core silently dropped imageSizeError / resolveMaxChars /
//      resolveAuthPort — nothing asserted they exist.
//   2. core.postThread + the MCP tools gained `video`, but the CLI's parseArgs never
//      learned --video — `x-post.mjs --video clip.mp4` parsed cleanly and posted
//      WITHOUT the video. A silent no-op in production.
//
// The manifest below is the source of truth. Adding a capability to core?
// Add a row; the test then names every surface you forgot to wire.
// Dependency-free on purpose (no SDK, no network): behavioral where a surface
// exposes a pure entry point (parseArgs, makeTools), source-level where it
// can't be imported without the SDK (the zod registerTool shapes).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import * as core from "../poster.mjs";
import { makeTools, resolveAuthPort } from "../../mcp/server.mjs";
import { parseArgs } from "../../plugins/x-poster/bin/x-post.mjs";

const pkgPath = (rel) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const CLI_SRC = readFileSync(pkgPath("plugins/x-poster/bin/x-post.mjs"), "utf8");
const MCP_SRC = readFileSync(pkgPath("mcp/server.mjs"), "utf8");

// ---------------------------------------------------------------------------
// THE MANIFEST — one row per user-facing capability.
//   cliFlag:   flag the CLI must parse (null = capability intentionally not in CLI)
//   cliKey:    key parseArgs must populate
//   mcpField:  field both preview_post and publish_post zod shapes must declare
//   coreParam: named param that must appear in core.postThread's signature
// ---------------------------------------------------------------------------
const CAPABILITIES = [
  { name: "single tweet", cliFlag: "--text",   cliKey: "tweets", mcpField: "text",        coreParam: "tweets" },
  { name: "thread",       cliFlag: "--thread", cliKey: "tweets", mcpField: "thread",      coreParam: "tweets" },
  { name: "image",        cliFlag: "--image",  cliKey: "image",  mcpField: "image",       coreParam: "imagePath" },
  { name: "video",        cliFlag: "--video",  cliKey: "video",  mcpField: "video",       coreParam: "videoPath" },
  { name: "reply",        cliFlag: null,       cliKey: null,     mcpField: "in_reply_to", coreParam: "inReplyToId" },
];

// ---------------------------------------------------------------------------
// Core surface — the capabilities must exist at the source of truth.
// ---------------------------------------------------------------------------

test("core: postThread signature carries every capability param", () => {
  const sig = core.postThread.toString().split("\n")[0];
  for (const cap of CAPABILITIES) {
    assert.match(sig, new RegExp(`\\b${cap.coreParam}\\b`),
      `core.postThread is missing the "${cap.name}" param (${cap.coreParam})`);
  }
});

test("core: standalone-only features that once regressed are exported and behave", () => {
  // incident-1 trio — existence IS the assertion (import failure also fails this file)
  assert.equal(typeof core.imageSizeError, "function", "imageSizeError missing from core");
  assert.ok(core.IMAGE_MAX_BYTES?.default > 0, "IMAGE_MAX_BYTES missing from core");
  assert.equal(core.resolveMaxChars("280"), 280, "resolveMaxChars must honor X_MAX_TWEET_CHARS");
  assert.equal(core.resolveMaxChars(undefined), core.LONGFORM_TWEET_CHARS,
    "resolveMaxChars must default to long-form");
  assert.equal(typeof core.uploadVideoChunked, "function", "uploadVideoChunked missing from core");
  // blank-safe .mcpb auth port (lives in the MCP surface, same regression class)
  assert.equal(resolveAuthPort(""), 8723, "resolveAuthPort must default a blank port");
  assert.equal(resolveAuthPort("9001"), 9001, "resolveAuthPort must honor an explicit port");
});

test("core: buildPlan understands image + video and enforces mutual exclusivity", () => {
  const plan = core.buildPlan({ tweets: ["x"], dryRun: true, image: "/nope.png", video: "/nope.mp4" });
  assert.ok(plan.hasImage && plan.hasVideo, "buildPlan must surface hasImage/hasVideo");
  assert.ok(plan.errors.some(e => /mutually exclusive/.test(e)),
    "buildPlan must reject image+video together");
});

// ---------------------------------------------------------------------------
// CLI surface — behavioral: exercise the real parser, then check passthrough.
// ---------------------------------------------------------------------------

test("CLI: parseArgs wires every flagged capability", () => {
  for (const cap of CAPABILITIES.filter(c => c.cliFlag)) {
    const argv = cap.cliFlag === "--thread" ? ["--thread", "a", "b"] : [cap.cliFlag, "val"];
    const out = parseArgs(argv);
    const got = out[cap.cliKey];
    assert.ok(got !== undefined && (Array.isArray(got) ? got.length > 0 : true),
      `CLI drift: parseArgs([${cap.cliFlag}]) does not populate .${cap.cliKey} — ` +
      `"${cap.name}" would silently no-op (this is the exact --video incident)`);
  }
  assert.equal(parseArgs(["--video", "f.mp4"]).video, "f.mp4");
  assert.deepEqual(parseArgs(["--thread", "a", "b"]).tweets, ["a", "b"]);
  assert.equal(parseArgs(["--confirm"]).confirm, true);
  assert.equal(parseArgs(["--dry-run"]).dryRun, true);
});

test("CLI: parsed media args actually reach buildPlan and postThread", () => {
  // parseArgs proving the flag exists is not enough — the value must flow through.
  // Anchor on the main-path call (tweets: args.tweets) — the bulk branch has its
  // own per-item buildPlan calls that intentionally carry no media.
  const buildPlanCall = CLI_SRC.match(/buildPlan\(\{ tweets: args\.tweets[\s\S]*?\}\)/)?.[0] ?? "";
  const postThreadCall = CLI_SRC.match(/await postThread\([\s\S]*?\)/)?.[0] ?? "";
  for (const key of ["image", "video"]) {
    assert.match(buildPlanCall, new RegExp(`\\b${key}: args\\.${key}\\b`),
      `CLI drift: args.${key} is parsed but never passed to buildPlan`);
    assert.match(postThreadCall, new RegExp(`args\\.${key}\\b`),
      `CLI drift: args.${key} is parsed but never passed to postThread`);
  }
});

// ---------------------------------------------------------------------------
// MCP surface — schema (source-level: zod shapes live inside startServer, which
// needs the SDK) and handlers (behavioral via the SDK-free makeTools factory).
// ---------------------------------------------------------------------------

function registerToolBlock(toolName) {
  const start = MCP_SRC.indexOf(`"${toolName}"`);
  assert.ok(start > -1, `MCP drift: no registerTool block for ${toolName}`);
  const rest = MCP_SRC.slice(start);
  const end = rest.indexOf("registerTool", 1);
  return end === -1 ? rest : rest.slice(0, end);
}

test("MCP: preview_post and publish_post schemas declare every capability field", () => {
  for (const toolName of ["preview_post", "publish_post"]) {
    const block = registerToolBlock(toolName);
    for (const cap of CAPABILITIES) {
      assert.match(block, new RegExp(`\\b${cap.mcpField}: z\\.`),
        `MCP drift: ${toolName} schema is missing "${cap.mcpField}" — ` +
        `models cannot pass "${cap.name}" even though core supports it`);
    }
  }
  assert.match(registerToolBlock("publish_post"), /\bconfirm_nonce: z\./,
    "MCP drift: publish_post schema lost the confirm_nonce gate field");
});

test("MCP: handlers thread video end-to-end (preview reports it, publish passes it on)", async () => {
  const clip = join(tmpdir(), `parity-clip-${process.pid}.mp4`);
  const otherClip = join(tmpdir(), `parity-clip-other-${process.pid}.mp4`);
  writeFileSync(clip, Buffer.alloc(1024));
  writeFileSync(otherClip, Buffer.alloc(2048));
  try {
    const calls = [];
    const tools = makeTools({
      postThread: async (tweets, image, inReplyTo, video) => {
        calls.push({ tweets, image, inReplyTo, video });
        return ["123"];
      },
      statePath: join(tmpdir(), `parity-state-${process.pid}`),
    });

    const preview = await tools.preview_post.handler({ text: "hi", video: clip });
    assert.equal(preview.hasVideo, true, "preview_post must report hasVideo");
    assert.ok(preview.videoBytes > 0, "preview_post must report videoBytes");
    assert.ok(preview.confirm_nonce, "preview_post must mint a nonce");

    await tools.publish_post.handler({ text: "hi", video: clip, confirm_nonce: preview.confirm_nonce });
    assert.equal(calls.length, 1, "publish_post must call postThread exactly once");
    assert.equal(calls[0].video, clip,
      "MCP drift: publish_post accepted a video but did not pass it to postThread");

    // nonce is payload-bound: a nonce minted for THIS clip must not authorize another
    await assert.rejects(
      () => tools.publish_post.handler({ text: "hi", video: otherClip, confirm_nonce: preview.confirm_nonce }),
      /confirm_nonce/,
      "publish_post must reject a nonce minted for a different video");
  } finally {
    rmSync(clip, { force: true });
    rmSync(otherClip, { force: true });
  }
});

// ---------------------------------------------------------------------------
// Scheduling surface (milestone 4 — vibedraft API client). Its own section
// because scheduling is a different tool family (schedule_post / list_scheduled /
// cancel_scheduled), not fields on preview/publish.
// ---------------------------------------------------------------------------

test("core: scheduler exports exist (client, validation, config resolution)", async () => {
  const scheduler = await import("../scheduler.mjs");
  assert.equal(typeof scheduler.makeScheduleClient, "function", "makeScheduleClient missing from core");
  assert.equal(typeof scheduler.validateSchedule, "function", "validateSchedule missing from core");
  assert.equal(typeof scheduler.resolveVibedraftConfig, "function", "resolveVibedraftConfig missing from core");
});

test("CLI: parseArgs wires every scheduling flag", () => {
  assert.equal(parseArgs(["--at", "2026-07-08T09:00:00Z"]).at, "2026-07-08T09:00:00Z",
    "CLI drift: --at does not populate .at — scheduling would silently post-now");
  assert.equal(parseArgs(["--list-scheduled"]).listScheduled, true,
    "CLI drift: --list-scheduled does not populate .listScheduled");
  assert.equal(parseArgs(["--cancel", "row-1"]).cancel, "row-1",
    "CLI drift: --cancel does not populate .cancel");
  assert.equal(parseArgs(["--status", "posted"]).status, "posted",
    "CLI drift: --status does not populate .status");
});

test("MCP: scheduling tools registered with schemas; schedule_post keeps the nonce gate", () => {
  for (const toolName of ["schedule_post", "list_scheduled", "cancel_scheduled"]) {
    const block = registerToolBlock(toolName);
    assert.ok(block, `MCP drift: no registerTool block for ${toolName}`);
  }
  const scheduleBlock = registerToolBlock("schedule_post");
  assert.match(scheduleBlock, /\bscheduled_for: z\./,
    "MCP drift: schedule_post schema lost scheduled_for");
  assert.match(scheduleBlock, /\bconfirm_nonce: z\./,
    "MCP drift: schedule_post schema lost the confirm_nonce gate field");
});

test("MCP: makeTools exposes the schedule handler family", () => {
  const tools = makeTools({ postThread: async () => ["1"], statePath: "/tmp/parity-x" });
  for (const name of ["schedule_post", "list_scheduled", "cancel_scheduled"]) {
    assert.equal(typeof tools[name]?.handler, "function", `makeTools missing ${name}`);
  }
});

// ---------------------------------------------------------------------------
// Scheduled-media surface (v1.9.0 — image/video on schedule_post via the
// vibedraft v1 media API). Same drift class as the --video incident: every
// surface must WIRE the capability, not just parse it.
// ---------------------------------------------------------------------------

test("core: scheduler media exports exist and the client exposes uploadMedia", async () => {
  const scheduler = await import("../scheduler.mjs");
  assert.equal(typeof scheduler.scheduleMediaMime, "function", "scheduleMediaMime missing from core");
  assert.ok(scheduler.SCHEDULE_IMAGE_MAX_BYTES > 0, "SCHEDULE_IMAGE_MAX_BYTES missing from core");
  assert.ok(scheduler.SCHEDULE_VIDEO_MAX_BYTES > 0, "SCHEDULE_VIDEO_MAX_BYTES missing from core");
  const client = scheduler.makeScheduleClient({ baseUrl: "https://x", token: "t", fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  assert.equal(typeof client.uploadMedia, "function", "makeScheduleClient client is missing uploadMedia");
});

test("CLI: --at path threads media to uploadMedia and mediaId to schedulePosts", () => {
  // parseArgs already wires --image/--video (asserted above); the schedule
  // branch must USE them — upload first, then pass the id on.
  assert.match(CLI_SRC, /client\.uploadMedia\(\{ filePath: media \}\)/,
    "CLI drift: --at accepts media but never calls client.uploadMedia — it would schedule text-only silently");
  assert.match(CLI_SRC, /schedulePosts\(\{ tweets: args\.tweets, scheduledFor: args\.at, mediaId \}\)/,
    "CLI drift: uploaded media_id is not passed to schedulePosts");
});

test("MCP: schedule_post schema declares image + video and the handler threads them", async () => {
  const block = registerToolBlock("schedule_post");
  for (const field of ["image", "video"]) {
    assert.match(block, new RegExp(`\\b${field}: z\\.`),
      `MCP drift: schedule_post schema is missing "${field}" — models cannot schedule with media even though core supports it`);
  }

  // Behavioral: preview nonce with video → schedule uploads then passes mediaId.
  const clip = join(tmpdir(), `parity-sched-clip-${process.pid}.mp4`);
  writeFileSync(clip, Buffer.alloc(1024));
  try {
    const calls = { upload: [], schedule: [] };
    const tools = makeTools({
      postThread: async () => { throw new Error("scheduling must not post directly"); },
      statePath: join(tmpdir(), `parity-sched-state-${process.pid}`),
      getScheduleClient: () => ({
        uploadMedia: async (args) => { calls.upload.push(args); return { mediaId: "m-parity", media: null }; },
        schedulePosts: async (args) => { calls.schedule.push(args); return [{ id: "row-1", scheduled_for: "t" }]; },
      }),
    });
    const preview = await tools.preview_post.handler({ text: "hi", video: clip });
    const inTwoHours = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
    await tools.schedule_post.handler({ text: "hi", video: clip, scheduled_for: inTwoHours, confirm_nonce: preview.confirm_nonce });
    assert.equal(calls.upload.length, 1, "MCP drift: schedule_post accepted a video but never uploaded it");
    assert.equal(calls.schedule[0]?.mediaId, "m-parity",
      "MCP drift: schedule_post uploaded media but did not pass mediaId to schedulePosts");
  } finally {
    rmSync(clip, { force: true });
  }
});

// ---------------------------------------------------------------------------
// Bulk scheduling surface (v1.8.0 — up to BULK_ITEMS_MAX independent posts per
// call, each at its own time, one confirmed action).
// ---------------------------------------------------------------------------

test("core: bulk scheduler exports exist and the client exposes scheduleBulk", async () => {
  const scheduler = await import("../scheduler.mjs");
  assert.equal(typeof scheduler.validateBulkSchedule, "function", "validateBulkSchedule missing from core");
  assert.equal(scheduler.BULK_ITEMS_MAX, 20, "BULK_ITEMS_MAX missing from core (or cap changed silently)");
  const client = scheduler.makeScheduleClient({ baseUrl: "https://x", token: "t", fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  assert.equal(typeof client.scheduleBulk, "function", "makeScheduleClient client is missing scheduleBulk");
});

test("CLI: parseArgs wires --bulk and the value flows to scheduleBulk", () => {
  assert.equal(parseArgs(["--bulk", "posts.json"]).bulk, "posts.json",
    "CLI drift: --bulk does not populate .bulk — bulk scheduling would silently no-op");
  assert.match(CLI_SRC, /scheduleBulk\(\{ items \}\)/,
    "CLI drift: --bulk is parsed but never calls client.scheduleBulk");
  assert.match(CLI_SRC, /validateBulkSchedule\(/,
    "CLI drift: bulk path skips validateBulkSchedule");
});

test("MCP: bulk tools registered with schemas; schedule_bulk keeps the nonce gate", () => {
  for (const toolName of ["preview_bulk", "schedule_bulk"]) {
    const block = registerToolBlock(toolName);
    assert.match(block, /\bposts: z\./,
      `MCP drift: ${toolName} schema is missing the posts array`);
  }
  assert.match(registerToolBlock("schedule_bulk"), /\bconfirm_nonce: z\./,
    "MCP drift: schedule_bulk schema lost the confirm_nonce gate field");
});

test("MCP: makeTools exposes the bulk handler pair", () => {
  const tools = makeTools({ postThread: async () => ["1"], statePath: "/tmp/parity-x" });
  for (const name of ["preview_bulk", "schedule_bulk"]) {
    assert.equal(typeof tools[name]?.handler, "function", `makeTools missing ${name}`);
  }
});
