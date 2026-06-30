import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTools, resolveAuthPort, resolveMaxChars } from "../server.mjs";

const noNet = () => { throw new Error("network called during preview!"); };

test("resolveMaxChars: blank/invalid → long-form default (25000); explicit strict limit honored", () => {
  assert.equal(resolveMaxChars(undefined), 25000);  // default: don't block on 280
  assert.equal(resolveMaxChars(""), 25000);          // unset optional .mcpb config
  assert.equal(resolveMaxChars("abc"), 25000);
  assert.equal(resolveMaxChars("0"), 25000);         // nonsense → default
  assert.equal(resolveMaxChars("280"), 280);         // opt BACK into the classic limit
  assert.equal(resolveMaxChars("4000"), 4000);       // custom limit
  assert.equal(resolveMaxChars("999999"), 25000);    // clamped to X's hard ceiling
});

test("makeTools char limit: long-form by default, strict only when set", async () => {
  // Default: a 400-char post previews clean (char count doesn't block).
  const dflt = makeTools({ postThread: async () => ["1"], statePath: "/tmp/x", elicit: null });
  assert.equal((await dflt.preview_post.handler({ text: "z".repeat(400) })).errors.length, 0);
  // Opt-in strict limit still blocks.
  const strict = makeTools({ postThread: async () => ["1"], statePath: "/tmp/x", elicit: null, maxChars: 280 });
  assert.ok((await strict.preview_post.handler({ text: "z".repeat(400) })).errors.some((e) => /exceeds 280/.test(e)));
});

test("resolveAuthPort: blank/invalid → 8723 default; explicit values honored", () => {
  assert.equal(resolveAuthPort(undefined), 8723);
  assert.equal(resolveAuthPort(""), 8723);        // an UNSET optional .mcpb config field
  assert.equal(resolveAuthPort("   "), 8723);
  assert.equal(resolveAuthPort("abc"), 8723);
  assert.equal(resolveAuthPort("99999"), 8723);   // out of port range
  assert.equal(resolveAuthPort("0"), 0);          // tests bind an ephemeral port
  assert.equal(resolveAuthPort("9000"), 9000);
  assert.equal(resolveAuthPort(9000), 9000);      // tolerate a numeric too
});

test("preview_post performs zero network I/O and returns cost", async () => {
  const tools = makeTools({ postThread: noNet, refreshAccessToken: noNet, statePath: "/tmp/none", seed: "S" });
  const r = await tools.preview_post.handler({ text: "hello https://x.com/foo" });
  assert.equal(r.isThread, false);
  assert.equal(r.estimatedCostUsd, 0.2);
  assert.ok(r.confirm_nonce, "issues a nonce");
});

test("publish_post refuses on validation error (empty)", async () => {
  const tools = makeTools({ postThread: noNet, refreshAccessToken: noNet, statePath: "/tmp/none", seed: "S" });
  await assert.rejects(() => tools.publish_post.handler({ text: "" }), /empty|no tweets/i);
});

test("publish_post refuses without a valid nonce when elicitation unsupported", async () => {
  const tools = makeTools({ postThread: noNet, refreshAccessToken: noNet, statePath: "/tmp/none", seed: "S", elicit: null });
  await assert.rejects(() => tools.publish_post.handler({ text: "ok" }), /confirm|nonce/i);
});

test("publish_post recomputes cost server-side and posts with a valid nonce", async () => {
  let posted = null;
  const tools = makeTools({
    postThread: async (tweets) => { posted = tweets; return ["111"]; },
    refreshAccessToken: async () => "ACCESS", statePath: "/tmp/none", seed: "S", elicit: null,
  });
  const { confirm_nonce } = await tools.preview_post.handler({ text: "shipit" });
  const r = await tools.publish_post.handler({ text: "shipit", confirm_nonce });
  assert.deepEqual(posted, ["shipit"]);
  assert.match(r.urls[0], /x\.com/);
});

test("a nonce minted for one payload does not authorize a different payload", async () => {
  const tools = makeTools({ postThread: async()=>["1"], refreshAccessToken: async()=>"A", statePath:"/tmp/none", seed:"S", elicit:null });
  const { confirm_nonce } = await tools.preview_post.handler({ text: "A" });
  await assert.rejects(() => tools.publish_post.handler({ text: "B", confirm_nonce }), /confirm|nonce|mismatch/i);
});

test("video param is included in the nonce binding (preview → publish roundtrip)", async () => {
  let posted = null;
  const tools = makeTools({
    postThread: async (tweets, image, inReplyTo, video) => { posted = { tweets, video }; return ["999"]; },
    statePath: "/tmp/none",
    elicit: null,
  });
  // Use poster.mjs itself as a stand-in for a real video path (any existing file will do).
  const fakeVideo = new URL("../../core/poster.mjs", import.meta.url).pathname;
  const { confirm_nonce } = await tools.preview_post.handler({ text: "vid tweet", video: fakeVideo });
  // Nonce minted WITH video must verify WITH the same video.
  const r = await tools.publish_post.handler({ text: "vid tweet", video: fakeVideo, confirm_nonce });
  assert.deepEqual(posted.tweets, ["vid tweet"]);
  assert.equal(posted.video, fakeVideo);
  assert.match(r.urls[0], /x\.com/);
});

test("a nonce minted with video does not authorize a post without video", async () => {
  const tools = makeTools({ postThread: async () => ["1"], statePath: "/tmp/none", elicit: null });
  const fakeVideo = new URL("../../core/poster.mjs", import.meta.url).pathname;
  const { confirm_nonce } = await tools.preview_post.handler({ text: "A", video: fakeVideo });
  // Same text but no video → nonce mismatch.
  await assert.rejects(
    () => tools.publish_post.handler({ text: "A", confirm_nonce }),
    /confirm|nonce/i,
  );
});
