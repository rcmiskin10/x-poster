// Tests for core/poster.mjs — pure planning/cost core (no network). Run: node --test core/_tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { containsUrl, postCost, costEstimate, buildPlan, persistRefreshToken, mediaTypeForPath, imageSizeError, IMAGE_MAX_BYTES } from "../poster.mjs";

test("containsUrl detects links and bare domains, not plain text", () => {
  assert.equal(containsUrl("just a normal tweet about shipping"), false);
  assert.equal(containsUrl("check https://x.com/foo"), true);
  assert.equal(containsUrl("see mysite.app for more"), true);
  assert.equal(containsUrl("www.example.com"), true);
});

test("postCost: $0.015 plain, $0.20 with URL (URL replaces, not adds)", () => {
  assert.equal(postCost("plain"), 0.015);
  assert.equal(postCost("link https://x.com"), 0.20);
});

test("costEstimate matches the research examples", () => {
  // single plain
  assert.equal(costEstimate(["hi"]), 0.015);
  // 5-tweet thread, one link ⇒ 4*0.015 + 0.20 = 0.26
  assert.equal(costEstimate(["a", "b", "c", "d", "link https://x.com/x"]), 0.26);
  // all 5 carry a link ⇒ 5*0.20 = 1.00
  assert.equal(costEstimate(Array(5).fill("see https://x.com/x")), 1.0);
});

test("buildPlan: dry-run never posts", () => {
  const p = buildPlan({ tweets: ["hello"], dryRun: true, confirm: true, hasCreds: true });
  assert.equal(p.willPost, false);
  assert.equal(p.blockedReason, "dry-run");
  assert.equal(p.estimatedCostUsd, 0.015);
});

test("buildPlan: posts ONLY with confirm + creds + not dry-run", () => {
  assert.equal(buildPlan({ tweets: ["x"], dryRun: false, confirm: true, hasCreds: true }).willPost, true);
  assert.equal(buildPlan({ tweets: ["x"], dryRun: false, confirm: false, hasCreds: true }).willPost, false);
  assert.equal(buildPlan({ tweets: ["x"], dryRun: false, confirm: true, hasCreds: false }).willPost, false);
});

test("buildPlan: flags empty and over-length tweets", () => {
  const empty = buildPlan({ tweets: [""], dryRun: true });
  assert.ok(empty.errors.some((e) => e.includes("empty")));
  const long = buildPlan({ tweets: ["x".repeat(281)], dryRun: true });
  assert.ok(long.errors.some((e) => e.includes("280")));
});

test("buildPlan: thread detection + per-post breakdown", () => {
  const p = buildPlan({ tweets: ["one", "two with https://x.com"], dryRun: true });
  assert.equal(p.isThread, true);
  assert.equal(p.count, 2);
  assert.equal(p.perPost[1].hasUrl, true);
});

test("persistRefreshToken: replaces the existing line, preserves all others", () => {
  const f = join(tmpdir(), "x-post-test-env-replace");
  writeFileSync(f, "# comment\nX_CLIENT_ID=abc\nX_REFRESH_TOKEN=OLD\nX_CLIENT_SECRET=def\n");
  try {
    persistRefreshToken("NEW", f);
    const out = readFileSync(f, "utf8");
    assert.match(out, /X_REFRESH_TOKEN=NEW/);
    assert.doesNotMatch(out, /OLD/);
    assert.match(out, /# comment/);
    assert.match(out, /X_CLIENT_ID=abc/);
    assert.match(out, /X_CLIENT_SECRET=def/);
    // exactly one X_REFRESH_TOKEN line
    assert.equal((out.match(/^X_REFRESH_TOKEN=/gm) || []).length, 1);
  } finally {
    rmSync(f, { force: true });
  }
});

test("mediaTypeForPath: maps common image extensions", () => {
  assert.equal(mediaTypeForPath("shot.png"), "image/png");
  assert.equal(mediaTypeForPath("/a/b/c.JPG"), "image/jpeg");
  assert.equal(mediaTypeForPath("x.jpeg"), "image/jpeg");
  assert.equal(mediaTypeForPath("y.gif"), "image/gif");
  assert.equal(mediaTypeForPath("z.webp"), "image/webp");
  assert.equal(mediaTypeForPath("noext"), "application/octet-stream");
});

test("imageSizeError: flags oversized images with a friendly, actionable message", () => {
  // Under the limit → no error.
  assert.equal(imageSizeError(1 * 1024 * 1024, "image/png"), null);
  assert.equal(imageSizeError(IMAGE_MAX_BYTES.default, "image/jpeg"), null); // exactly at limit is OK
  // Over the static-image limit → friendly message naming the limit and a way out.
  const err = imageSizeError(6 * 1024 * 1024, "image/png");
  assert.match(err, /too large|over/i);
  assert.match(err, /5 MB/);
  assert.match(err, /resize|compress|without the image/i);
  // GIFs get the higher limit.
  assert.equal(imageSizeError(10 * 1024 * 1024, "image/gif"), null);
  assert.match(imageSizeError(20 * 1024 * 1024, "image/gif"), /15 MB/);
});

test("buildPlan: char limit is configurable for long-form (Premium) accounts", () => {
  const long = "x".repeat(400);
  // Default limit (280) blocks a long-form post.
  assert.ok(buildPlan({ tweets: [long], dryRun: true }).errors.some((e) => /exceeds 280/.test(e)));
  // A raised limit lets it through (no char error).
  const raised = buildPlan({ tweets: [long], dryRun: true, maxChars: 25000 });
  assert.equal(raised.errors.filter((e) => /exceeds/.test(e)).length, 0);
  // Still blocks beyond the raised limit, naming the right number.
  assert.ok(
    buildPlan({ tweets: ["y".repeat(30000)], dryRun: true, maxChars: 25000 })
      .errors.some((e) => /exceeds 25000/.test(e)),
  );
});

test("buildPlan: image presence + missing-image validation", () => {
  const p = buildPlan({ tweets: ["hi"], dryRun: true, image: "/definitely/not/here.png" });
  assert.equal(p.hasImage, true);
  assert.equal(p.image, "/definitely/not/here.png");
  assert.ok(p.errors.some((e) => e.includes("image not found")));
  const none = buildPlan({ tweets: ["hi"], dryRun: true });
  assert.equal(none.hasImage, false);
  assert.equal(none.image, null);
});

test("persistRefreshToken: appends when no line exists", () => {
  const f = join(tmpdir(), "x-post-test-env-append");
  writeFileSync(f, "X_CLIENT_ID=abc\n");
  try {
    persistRefreshToken("MINTED", f);
    const out = readFileSync(f, "utf8");
    assert.match(out, /X_CLIENT_ID=abc/);
    assert.match(out, /X_REFRESH_TOKEN=MINTED/);
  } finally {
    rmSync(f, { force: true });
  }
});
