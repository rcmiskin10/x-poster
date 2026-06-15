import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTools, resolveAuthPort, resolveMaxChars } from "../server.mjs";

const noNet = () => { throw new Error("network called during preview!"); };

test("resolveMaxChars: blank/invalid → 280; only ever raises; clamped to 25000", () => {
  assert.equal(resolveMaxChars(undefined), 280);
  assert.equal(resolveMaxChars(""), 280);          // unset optional .mcpb config
  assert.equal(resolveMaxChars("abc"), 280);
  assert.equal(resolveMaxChars("100"), 280);        // can't go BELOW 280 (won't break normal posts)
  assert.equal(resolveMaxChars("4000"), 4000);      // long-form raise
  assert.equal(resolveMaxChars("999999"), 25000);   // clamped to X's long-form ceiling
});

test("makeTools honors maxChars: a 400-char post previews clean when the limit is raised", async () => {
  const tools = makeTools({ postThread: async () => ["1"], statePath: "/tmp/x", elicit: null, maxChars: 25000 });
  const r = await tools.preview_post.handler({ text: "z".repeat(400) });
  assert.equal(r.errors.length, 0, "no char error under a raised limit");
  // And the default still blocks it.
  const dflt = makeTools({ postThread: async () => ["1"], statePath: "/tmp/x", elicit: null });
  const blocked = await dflt.preview_post.handler({ text: "z".repeat(400) });
  assert.ok(blocked.errors.some((e) => /exceeds 280/.test(e)));
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
