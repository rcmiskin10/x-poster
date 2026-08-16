// article.test.mjs — the pure half of X Articles support.
//
// Everything here runs with no token and no network. The network half
// (createArticleDraft / publishArticleDraft) is deliberately thin so that the
// part worth testing is the part that can be tested.
//
// The central assertion style: SLICE THE OUTPUT TEXT BY THE RECORDED OFFSET and
// compare it to the words that were supposed to be styled. Counting ranges is
// not enough — the bug this file was written against produced exactly the right
// NUMBER of ranges pointing at the wrong characters.

import test from "node:test";
import assert from "node:assert/strict";

import {
  parseInline,
  mdToContentState,
  stripFrontmatter,
  buildArticlePlan,
  summarizeContentState,
  coverMediaFor,
  createArticleDraft,
  classifyArticleError,
  BLOCK_TYPES,
  ARTICLE_DRAFT_URL,
  articlePublishUrl,
} from "../article.mjs";

// Resolve every range back to the substring it points at.
const styled = (r) => r.styles.map((s) => [r.text.slice(s.offset, s.offset + s.length), s.style]);
const linked = (r) => r.links.map((l) => [r.text.slice(l.offset, l.offset + l.length), l.url]);

// ---------------------------------------------------------------------------
// Inline offsets — the regression the sequential-replace approach caused
// ---------------------------------------------------------------------------

test("bold keeps its offset when an italic earlier in the line was stripped first", () => {
  // Sequential replacement removed the italic's two asterisks AFTER recording
  // bold's offset, sliding the bold two characters to the right onto " wo".
  const r = parseInline("an *italic* then a **bold** word");
  assert.equal(r.text, "an italic then a bold word");
  assert.deepEqual(styled(r), [["italic", "italic"], ["bold", "bold"]]);
});

test("link offsets survive bold stripping elsewhere in the line", () => {
  const r = parseInline("**heads up** see [the docs](https://docs.x.com) now");
  assert.equal(r.text, "heads up see the docs now");
  assert.deepEqual(linked(r), [["the docs", "https://docs.x.com"]]);
  assert.deepEqual(styled(r), [["heads up", "bold"]]);
});

test("many mixed markers all still resolve to their own words", () => {
  const r = parseInline("*a* **b** `c` [d](https://e.com) **f** *g*");
  assert.equal(r.text, "a b c d f g");
  assert.deepEqual(styled(r), [["a", "italic"], ["b", "bold"], ["f", "bold"], ["g", "italic"]]);
  assert.deepEqual(linked(r), [["d", "https://e.com"]]);
});

test("nested markup inside a link label is rebased onto the label", () => {
  const r = parseInline("read [the **real** spec](https://x.com/spec) first");
  assert.equal(r.text, "read the real spec first");
  assert.deepEqual(linked(r), [["the real spec", "https://x.com/spec"]]);
  assert.deepEqual(styled(r), [["real", "bold"]]);
});

test("bold wins over italic on a double asterisk", () => {
  const r = parseInline("**not italic**");
  assert.deepEqual(styled(r), [["not italic", "bold"]]);
});

test("code keeps its words and drops only the backticks", () => {
  const r = parseInline("run `npm test` now");
  assert.equal(r.text, "run npm test now");
  assert.deepEqual(styled(r), [], "content_state has no code style");
});

test("an unpaired asterisk is literal, not a swallowed style", () => {
  const r = parseInline("2 * 3 = 6");
  assert.equal(r.text, "2 * 3 = 6");
  assert.deepEqual(styled(r), []);
});

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

test("every markdown block maps to a type X actually supports", () => {
  const md = [
    "# One",
    "## Two",
    "### Three",
    "plain paragraph",
    "> a quote",
    "- bullet",
    "1. numbered",
  ].join("\n\n");
  const state = mdToContentState(md);
  assert.deepEqual(
    state.blocks.map((b) => [b.type, b.text]),
    [
      ["header-one", "One"],
      ["header-two", "Two"],
      // h3 is degraded — see the header-three tests below.
      ["unstyled", "Three"],
      ["unstyled", "plain paragraph"],
      ["blockquote", "a quote"],
      ["unordered-list-item", "bullet"],
      ["ordered-list-item", "numbered"],
    ],
  );
  for (const b of state.blocks) assert.ok(BLOCK_TYPES.has(b.type), `${b.type} is not a real content_state type`);
});

// ---------------------------------------------------------------------------
// header-three is in X's published enum and rejected by X's backend with a 503.
// These tests exist so nobody "simplifies" the degradation back out; the whole
// article fails to publish if a single header-three survives.
// ---------------------------------------------------------------------------

test("no header-three ever survives into content_state", () => {
  const md = ["### a", "#### b", "## real h2", "### c"].join("\n\n");
  const types = mdToContentState(md).blocks.map((b) => b.type);
  assert.equal(types.includes("header-three"), false);
  assert.deepEqual(types, ["unstyled", "unstyled", "header-two", "unstyled"]);
});

test("a degraded h3 keeps its emphasis as a full-span bold range", () => {
  const [b] = mdToContentState("### the heading").blocks;
  assert.equal(b.type, "unstyled");
  assert.deepEqual(b.inline_style_ranges, [{ offset: 0, length: "the heading".length, style: "bold" }]);
  // The range must resolve to the WHOLE line, not a prefix of it.
  assert.equal(b.text.slice(0, b.inline_style_ranges[0].length), "the heading");
});

test("degrading preserves inline styles already parsed out of the heading", () => {
  const [b] = mdToContentState("### plain *em* tail").blocks;
  const resolved = b.inline_style_ranges.map((s) => [b.text.slice(s.offset, s.offset + s.length), s.style]);
  assert.deepEqual(resolved, [
    ["em", "italic"],
    ["plain em tail", "bold"],
  ]);
});

test("h4 degrades too — it routes through header-three, which is itself degraded", () => {
  assert.equal(mdToContentState("#### Four").blocks[0].type, "unstyled");
});

test("BLOCK_TYPES still mirrors X's published enum, bugs and all", () => {
  // This set documents X's spec, not X's behaviour. Removing header-three here
  // to "fix" the 503 would be recording a vendor bug as if it were the contract.
  assert.ok(BLOCK_TYPES.has("header-three"));
});

test("fenced code becomes plain paragraphs and the fence markers disappear", () => {
  const state = mdToContentState("before\n\n```js\nconst x = 1;\n```\n\nafter");
  assert.deepEqual(state.blocks.map((b) => b.text), ["before", "const x = 1;", "after"]);
  assert.ok(!state.blocks.some((b) => b.text.includes("```")));
});

test("markdown inside a fence is left verbatim", () => {
  const state = mdToContentState("```\nnot **bold** here\n```");
  assert.equal(state.blocks[0].text, "not **bold** here");
  assert.equal(state.blocks[0].inline_style_ranges, undefined);
});

test("horizontal rules are dropped, not rendered as text", () => {
  assert.deepEqual(mdToContentState("a\n\n---\n\nb").blocks.map((b) => b.text), ["a", "b"]);
});

test("entities are keyed consistently between the map and the ranges", () => {
  const state = mdToContentState("[one](https://a.com) and [two](https://b.com)");
  const ranges = state.blocks.flatMap((b) => b.entity_ranges ?? []);
  assert.equal(state.entities.length, 2);
  assert.equal(ranges.length, 2);
  for (const r of ranges) {
    const entity = state.entities.find((e) => e.key === String(r.key));
    assert.ok(entity, `entity_range key ${r.key} has no matching entity`);
    assert.equal(entity.value.type, "link");
  }
  assert.deepEqual(state.entities.map((e) => e.value.data.url), ["https://a.com", "https://b.com"]);
});

test("entity keys keep incrementing across separate blocks", () => {
  const state = mdToContentState("[a](https://a.com)\n\n[b](https://b.com)");
  const keys = state.blocks.flatMap((b) => b.entity_ranges.map((r) => r.key));
  assert.deepEqual(keys, [0, 1], "a per-block counter would emit [0, 0] and collide");
});

test("content_state uses snake_case, which X silently ignores if camelCased", () => {
  const state = mdToContentState("**b** and [l](https://a.com)");
  const json = JSON.stringify(state);
  assert.match(json, /"inline_style_ranges"/);
  assert.match(json, /"entity_ranges"/);
  assert.ok(!/inlineStyleRanges|entityRanges/.test(json));
});

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

test("frontmatter is stripped and supplies a default title", () => {
  const { body, meta } = stripFrontmatter('---\ntitle: "my post"\ndate: "2026-08-04"\n---\nhello\n');
  assert.equal(meta.title, "my post");
  assert.equal(body.trim(), "hello");
});

test("markdown with no frontmatter passes through untouched", () => {
  const { body, meta } = stripFrontmatter("# hello\n");
  assert.equal(body, "# hello\n");
  assert.deepEqual(meta, {});
});

test("a leading horizontal rule is not mistaken for frontmatter", () => {
  const { body } = stripFrontmatter("---\n\n# real heading\n");
  assert.match(body, /real heading/);
});

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

test("plan blocks on a missing title and on an empty body", () => {
  const p = buildArticlePlan({ title: "", markdown: "" });
  assert.equal(p.action, "blocked");
  assert.ok(p.errors.some((e) => /title/.test(e)));
  assert.ok(p.errors.some((e) => /empty/.test(e)));
});

test("plan falls back to the frontmatter title", () => {
  const p = buildArticlePlan({ markdown: '---\ntitle: "from frontmatter"\n---\n# hi\n\nbody text' });
  assert.equal(p.title, "from frontmatter");
  assert.deepEqual(p.errors, []);
});

test("plan reports cost as unknown instead of guessing a per-post price", () => {
  const p = buildArticlePlan({ title: "t", markdown: "# h\n\nbody" });
  assert.equal(p.estimatedCostUsd, null);
  assert.match(p.costNote, /not billed per-post|does not publish a per-article price/i);
});

test("dashes and unconverted markdown warn but never block", () => {
  const p = buildArticlePlan({ title: "t", markdown: "# h\n\nan em dash — here" });
  assert.deepEqual(p.errors, [], "a dash must not block a publish the user already confirmed");
  assert.ok(p.warnings.some((w) => /dash/.test(w)));
});

test("a headingless article warns about readability", () => {
  const p = buildArticlePlan({ title: "t", markdown: "just one flat paragraph" });
  assert.ok(p.warnings.some((w) => /heading/.test(w)));
});

test("plan action reflects credentials and dry-run", () => {
  const md = "# h\n\nbody";
  assert.equal(buildArticlePlan({ title: "t", markdown: md }).action, "missing credentials");
  assert.equal(buildArticlePlan({ title: "t", markdown: md, hasCreds: true }).action, "ready");
  assert.equal(buildArticlePlan({ title: "t", markdown: md, dryRun: true, hasCreds: true }).action, "dry-run");
});

test("summary counts words across blocks, not per block", () => {
  const s = summarizeContentState(mdToContentState("# one two\n\nthree four five"));
  assert.equal(s.blocks, 2);
  assert.equal(s.words, 5);
  assert.equal(s.blockCounts["header-one"], 1);
});

// ---------------------------------------------------------------------------
// Errors + URLs
// ---------------------------------------------------------------------------

test("403 names Premium, the actual cause, before the raw body", () => {
  const msg = classifyArticleError(403, '{"detail":"forbidden"}');
  assert.match(msg, /Premium/);
  assert.match(msg, /forbidden/, "the raw body must survive for debugging");
});

test("401 names the app-only-token trap", () => {
  assert.match(classifyArticleError(401, "x"), /USER token/);
});

test("400 names the snake_case trap", () => {
  assert.match(classifyArticleError(400, "x"), /snake_case/);
});

test("endpoints match the documented article routes", () => {
  assert.equal(ARTICLE_DRAFT_URL, "https://api.x.com/2/articles/draft");
  assert.equal(articlePublishUrl("123"), "https://api.x.com/2/articles/123/publish");
});

test("API_BASE stays in sync with poster.mjs despite being duplicated", async () => {
  // article.mjs cannot import poster.mjs (vendoring renames it to _poster.mjs),
  // so the constant is duplicated on purpose. This is the guard against drift.
  const poster = await import("../poster.mjs");
  const article = await import("../article.mjs");
  assert.equal(article.API_BASE, poster.API_BASE,
    "article.mjs API_BASE drifted from poster.mjs — update both");
});

test("entities is always present, even with no links", () => {
  // X's schema lists content_state.required as ["blocks", "entities"], verified
  // against api.x.com/2/openapi.json. Omitting it on a link-free article is the
  // natural implementation and the one X rejects — this is the regression guard.
  const state = mdToContentState("# heading\n\nno links at all here");
  assert.ok(Array.isArray(state.entities), "entities must exist even when empty");
  assert.deepEqual(state.entities, []);
  assert.deepEqual(Object.keys(state).sort(), ["blocks", "entities"]);
});

test("a link-free plan still serializes entities", () => {
  const p = buildArticlePlan({ title: "t", markdown: "# h\n\nbody with no links" });
  assert.equal(p.links, 0);
  assert.match(JSON.stringify(p.contentState), /"entities":\[\]/);
});

// ---------------------------------------------------------------------------
// Cover media. The distribution article shipped with no banner because
// attaching one was a manual step nobody remembered, so the shape and the
// omission are both worth pinning.
// ---------------------------------------------------------------------------

test("coverMediaFor builds the shape X's schema requires", () => {
  assert.deepEqual(coverMediaFor("123"), { media_category: "tweet_image", media_id: "123" });
});

test("coverMediaFor stringifies a numeric id", () => {
  // X returns ids that exceed Number.MAX_SAFE_INTEGER; a number here would be
  // silently rounded and reference a different upload, or none.
  assert.equal(coverMediaFor(2086589587413987328).media_id.length > 15, true);
  assert.equal(typeof coverMediaFor(123).media_id, "string");
});

test("coverMediaFor returns null for no id, so callers omit the key", () => {
  for (const empty of [null, undefined, "", 0]) assert.equal(coverMediaFor(empty), null);
});

test("createArticleDraft OMITS cover_media when there is no cover", async () => {
  // Not "sends null" — X declares additionalProperties:false on the request and
  // an explicit null is not the same as an absent key.
  let sent = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => {
    sent = JSON.parse(opts.body);
    return { ok: true, status: 201, text: async () => JSON.stringify({ data: { id: "1" } }) };
  };
  try {
    await createArticleDraft({ title: "t", contentState: { blocks: [], entities: [] } }, "tok");
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal("cover_media" in sent, false);
  assert.deepEqual(Object.keys(sent).sort(), ["content_state", "title"]);
});

test("createArticleDraft sends cover_media when given one", async () => {
  let sent = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => {
    sent = JSON.parse(opts.body);
    return { ok: true, status: 201, text: async () => JSON.stringify({ data: { id: "1" } }) };
  };
  try {
    await createArticleDraft(
      { title: "t", contentState: { blocks: [], entities: [] }, coverMedia: coverMediaFor("999") },
      "tok",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(sent.cover_media, { media_category: "tweet_image", media_id: "999" });
});
