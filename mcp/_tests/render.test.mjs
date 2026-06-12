// Tests for the render dashboard: a server-formatted step-tracker block that
// clients relay verbatim, making the workflow display deterministic. Covers
// the preview/published/error tracker states and that both handlers attach it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTools, renderDashboard } from "../server.mjs";

const perPost = (chars, hasUrl = false) => [{ chars, hasUrl, cost: 0.015 }];

test("preview render: pending gate, cost, stats, confirm prompt", () => {
  const r = renderDashboard({
    stage: "preview",
    tweets: ["hello world"],
    perPost: perPost(11),
    estimatedCostUsd: 0.015,
    hasImage: false,
    inReplyTo: null,
  });
  assert.match(r, /🐦 x-poster ▸ post/);
  assert.match(r, /✅ resolve {3}✅ validate {3}🟡 gate {3}⚪ publish/);
  assert.match(r, /1│ hello world/);
  assert.match(r, /1 tweet · 11 chars · 🖼 none · 🔗 none/);
  assert.match(r, /est\. \$0\.015/);
  assert.match(r, /🚦 awaiting explicit confirmation/);
});

test("preview render: reply target and thread count in the header", () => {
  const r = renderDashboard({
    stage: "preview",
    tweets: ["one", "two"],
    perPost: [...perPost(3), ...perPost(3)],
    estimatedCostUsd: 0.03,
    hasImage: true,
    inReplyTo: "ROOT123",
  });
  assert.match(r, /thread ×2 ▸ reply → ROOT123/);
  assert.match(r, /2 tweets · 6 chars · 🖼 image/);
});

test("validation errors: ❌ validate, error lines, no confirm prompt", () => {
  const r = renderDashboard({
    stage: "preview",
    tweets: ["x".repeat(300)],
    perPost: perPost(300),
    estimatedCostUsd: 0.015,
    hasImage: false,
    inReplyTo: null,
    errors: ["tweet 1 exceeds 280 chars (300)"],
  });
  assert.match(r, /✅ resolve {3}❌ validate {3}⚪ gate {3}⚪ publish/);
  assert.match(r, /⚠️ tweet 1 exceeds 280 chars/);
  assert.match(r, /⛔ fix validation errors/);
  assert.doesNotMatch(r, /🚦/);
});

test("published render: all steps green, live URL, cost charged", () => {
  const r = renderDashboard({
    stage: "published",
    tweets: ["hello"],
    perPost: perPost(5),
    estimatedCostUsd: 0.015,
    hasImage: false,
    inReplyTo: "ROOT123",
    urls: ["https://x.com/i/web/status/42"],
  });
  assert.match(r, /✅ resolve {3}✅ validate {3}✅ gate {3}✅ publish/);
  assert.match(r, /🚀 live: https:\/\/x\.com\/i\/web\/status\/42/);
  assert.match(r, /\$0\.015 charged/);
  assert.doesNotMatch(r, /🚦/);
});

test("preview handler attaches a render block", async () => {
  const tools = makeTools({ postThread: async () => ["1"], statePath: "/tmp/x", elicit: null });
  const res = await tools.preview_post.handler({ text: "yo", in_reply_to: "R1" });
  assert.match(res.render, /🟡 gate/);
  assert.match(res.render, /reply → R1/);
});

test("publish handler attaches a render block with the live URL", async () => {
  const tools = makeTools({ postThread: async () => ["77"], statePath: "/tmp/x", elicit: null });
  const { confirm_nonce } = await tools.preview_post.handler({ text: "yo" });
  const res = await tools.publish_post.handler({ text: "yo", confirm_nonce });
  assert.match(res.render, /✅ publish/);
  assert.match(res.render, /🚀 live: https:\/\/x\.com\/i\/web\/status\/77/);
});
