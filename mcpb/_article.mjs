// article.mjs — zero-dep core library for publishing X Articles (long-form).
//
// Pure library: no process.env, no process.argv, no CLI concerns. Same contract
// as poster.mjs — the converter and the plan builder are pure and fully testable
// offline; only createArticleDraft / publishArticleDraft touch the network.
//
// TWO-STEP BY DESIGN. X's API creates a *private draft* first, then publishes it
// by id. We keep that seam rather than collapsing it: a draft is recoverable, a
// published article under your own byline is not. `publish_article` is the only
// writer that makes something public.
//
// COST: X's published pay-per-use price list (docs.x.com) covers posts —
// $0.015, or $0.20 with a URL. Articles are NOT on that list. We report cost as
// `null` (unknown) rather than inventing a number; see ARTICLE_COST_NOTE.
//
// REQUIRES X Premium on the authenticated account. Without it the draft call
// 403s; classifyArticleError turns that into a sentence a human can act on.

import { readFileSync } from "node:fs";

// Duplicated from poster.mjs rather than imported. Core modules are vendored
// into each surface with a flat `_` prefix (poster.mjs → _poster.mjs), so a
// relative cross-import resolves to a path that does not exist after vendoring.
// Every core module is self-contained on node builtins; keep it that way.
export const API_BASE = "https://api.x.com";

export const ARTICLE_DRAFT_URL = `${API_BASE}/2/articles/draft`;
export const articlePublishUrl = (id) => `${API_BASE}/2/articles/${encodeURIComponent(id)}/publish`;

export const ARTICLE_COST_NOTE =
  "X does not publish a per-article price. Articles are not billed per-post like tweets " +
  "($0.015, $0.20 with a URL), so the cost here is reported as unknown rather than guessed.";

// X renders long-form articles from a DraftJS-shaped `content_state`. Field
// names are snake_case; camelCase is accepted by the JSON parser and then
// silently ignored, which is why this is centralized in one place.
export const BLOCK_TYPES = new Set([
  "unstyled",
  "header-one",
  "header-two",
  "header-three",
  "unordered-list-item",
  "ordered-list-item",
  "blockquote",
  "atomic",
]);

// X publishes these types in the enum above and then rejects them at the
// backend. The tell is the status code: a rejected type answers 503, not 400,
// so it reads as an outage and every retry reproduces it.
//
//   header-three — reported by another developer at
//   devcommunity.x.com/t/post-2-articles-draft-returns-503-for-valid-header-three-blocks/271312
//   and reproduced independently here: for a 107-block article, the shortest
//   failing prefix was 27 blocks, which is exactly the shortest prefix that
//   contains a header-three. A 14-block prefix with none of them succeeded.
//
// BLOCK_TYPES above deliberately still lists it — that set mirrors X's spec and
// should not be edited to describe X's bugs. This map is the workaround layer,
// applied last so the markdown→semantics mapping stays honest. Delete an entry
// when X fixes it; the parity tests will keep the four surfaces in step.
export const DEGRADE_BLOCK_TYPE = new Map([["header-three", "unstyled"]]);

// Degrading a heading to `unstyled` alone would erase it visually, so carry the
// emphasis across as a bold span over the whole line — which is how the
// Articles renderer draws a subhead anyway.
export function degradeBlock(block) {
  const to = DEGRADE_BLOCK_TYPE.get(block.type);
  if (!to) return block;
  const out = { ...block, type: to };
  if (to === "unstyled" && out.text) {
    out.inline_style_ranges = [
      ...(out.inline_style_ranges ?? []),
      { offset: 0, length: out.text.length, style: "bold" },
    ];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Inline markdown → text + offset ranges
// ---------------------------------------------------------------------------
//
// Single left-to-right pass, building the OUTPUT string as it goes and recording
// every offset against that output. This is the load-bearing detail: the obvious
// implementation (regex-replace each marker class in sequence) records an offset
// against the text as it looked at that moment, and every later replacement
// shifts it. A link or a bold that happens to sit after an italic in the same
// paragraph then points at the wrong characters — X renders the style on the
// wrong words, and no test that only counts ranges will notice.
//
// Sticky regexes anchored at the cursor; nested markup recurses and is rebased.

const RE_LINK = /\[([^\]]+)\]\(([^)\s]+)\)/y;
const RE_BOLD = /\*\*([^*]+?)\*\*/y;
const RE_ITALIC = /\*([^*]+?)\*/y;
const RE_CODE = /`([^`]+)`/y;

export function parseInline(raw) {
  const text = [];
  const styles = [];
  const links = [];
  let len = 0;
  let i = 0;

  const at = (re) => {
    re.lastIndex = i;
    const m = re.exec(raw);
    return m && m.index === i ? m : null;
  };

  // Absorb a nested run, rebasing its offsets onto the output built so far.
  const absorb = (inner) => {
    const base = len;
    text.push(inner.text);
    len += inner.text.length;
    for (const s of inner.styles) styles.push({ ...s, offset: s.offset + base });
    for (const l of inner.links) links.push({ ...l, offset: l.offset + base });
    return { base, length: inner.text.length };
  };

  while (i < raw.length) {
    let m;
    if ((m = at(RE_LINK))) {
      const { base, length } = absorb(parseInline(m[1]));
      links.push({ offset: base, length, url: m[2] });
      i += m[0].length;
      continue;
    }
    if ((m = at(RE_BOLD))) {
      const { base, length } = absorb(parseInline(m[1]));
      styles.push({ offset: base, length, style: "bold" });
      i += m[0].length;
      continue;
    }
    if ((m = at(RE_CODE))) {
      // content_state has no code style. Keep the words, drop the backticks —
      // dropping the words would silently delete content.
      absorb({ text: m[1], styles: [], links: [] });
      i += m[0].length;
      continue;
    }
    if ((m = at(RE_ITALIC))) {
      const { base, length } = absorb(parseInline(m[1]));
      styles.push({ offset: base, length, style: "italic" });
      i += m[0].length;
      continue;
    }
    text.push(raw[i]);
    len += 1;
    i += 1;
  }

  return { text: text.join(""), styles, links };
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

// Returns { body, meta }. Lets a .md file authored for the blog be published as
// an article without hand-editing: the frontmatter block is stripped, and its
// `title` becomes the default article title.
export function stripFrontmatter(md) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md);
  if (!m) return { body: md, meta: {} };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^["'](.*)["']$/, "$1");
  }
  return { body: md.slice(m[0].length), meta };
}

// ---------------------------------------------------------------------------
// Markdown → content_state
// ---------------------------------------------------------------------------

function blockTypeFor(line) {
  if (line.startsWith("#### ")) return ["header-three", line.slice(5)]; // no header-four exists
  if (line.startsWith("### ")) return ["header-three", line.slice(4)];
  if (line.startsWith("## ")) return ["header-two", line.slice(3)];
  if (line.startsWith("# ")) return ["header-one", line.slice(2)];
  if (line.startsWith("> ")) return ["blockquote", line.slice(2)];
  if (/^[-*+] /.test(line)) return ["unordered-list-item", line.slice(2)];
  const ol = /^\d+\.\s+(.*)$/.exec(line);
  if (ol) return ["ordered-list-item", ol[1]];
  return ["unstyled", line];
}

export function mdToContentState(md) {
  const blocks = [];
  const entities = [];
  let key = 0;
  let inFence = false;

  for (const rawLine of md.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "");

    if (/^\s*(```|~~~)/.test(line)) {
      // No code-block type exists in content_state. Emit the fenced lines as
      // plain paragraphs and drop the fence markers themselves.
      inFence = !inFence;
      continue;
    }
    if (!line.trim()) continue;
    if (!inFence && /^\s*([-*_])\1{2,}\s*$/.test(line)) continue; // horizontal rule

    let type, body;
    if (inFence) {
      type = "unstyled";
      body = line; // verbatim: no inline parsing inside code
    } else {
      [type, body] = blockTypeFor(line);
    }

    const parsed = inFence
      ? { text: body, styles: [], links: [] }
      : parseInline(body);

    const block = { text: parsed.text, type };
    if (parsed.styles.length) block.inline_style_ranges = parsed.styles;
    if (parsed.links.length) {
      block.entity_ranges = parsed.links.map(({ offset, length, url }) => {
        entities.push({
          key: String(key),
          value: { type: "link", mutability: "mutable", data: { url } },
        });
        return { key: key++, offset, length };
      });
    }
    blocks.push(degradeBlock(block));
  }

  // `entities` is REQUIRED by X's schema even when empty — verified against
  // api.x.com/2/openapi.json, which lists content_state.required as
  // ["blocks", "entities"]. Omitting it on a link-free article (the natural
  // thing to do, and what this originally did) produces a body X rejects.
  return { blocks, entities };
}

// ---------------------------------------------------------------------------
// Plan — pure, zero network. Mirrors poster.buildPlan's contract.
// ---------------------------------------------------------------------------

export const DASH_RE = /[—–]/; // em / en dash

export function summarizeContentState(state) {
  const counts = {};
  for (const b of state.blocks) counts[b.type] = (counts[b.type] || 0) + 1;
  const text = state.blocks.map((b) => b.text).join(" ");
  return {
    blocks: state.blocks.length,
    blockCounts: counts,
    words: text.split(/\s+/).filter(Boolean).length,
    links: (state.entities || []).length,
    characters: text.length,
  };
}

export function buildArticlePlan({ title, markdown, dryRun = false, hasCreds = false }) {
  const errors = [];
  const warnings = [];

  const { body, meta } = stripFrontmatter(markdown || "");
  const resolvedTitle = (title || meta.title || "").trim();

  if (!resolvedTitle) errors.push("missing title (pass a title, or give the markdown a `title:` frontmatter key)");
  if (!body.trim()) errors.push("markdown body is empty");

  const state = mdToContentState(body);
  if (!state.blocks.length && body.trim()) errors.push("markdown produced no blocks");

  const stats = summarizeContentState(state);
  const allText = `${resolvedTitle} ${state.blocks.map((b) => b.text).join(" ")}`;

  // Warnings, not errors: these are house-style and voice checks. A dash should
  // never block a publish the user has already confirmed.
  if (DASH_RE.test(allText)) warnings.push("contains an em or en dash — house style for X is to use neither");
  for (const leftover of ["**", "](", "##"]) {
    if (allText.includes(leftover)) warnings.push(`unconverted markdown left in the text: ${leftover}`);
  }
  if (stats.blocks && !state.blocks.some((b) => b.type.startsWith("header"))) {
    warnings.push("no headings — long-form reads poorly on X without them");
  }
  for (const b of state.blocks) {
    if (!BLOCK_TYPES.has(b.type)) errors.push(`unsupported block type: ${b.type}`);
  }

  return {
    title: resolvedTitle,
    contentState: state,
    ...stats,
    // Articles are absent from X's published price list — see ARTICLE_COST_NOTE.
    estimatedCostUsd: null,
    costNote: ARTICLE_COST_NOTE,
    warnings,
    errors,
    action: errors.length
      ? "blocked"
      : dryRun
        ? "dry-run"
        : hasCreds
          ? "ready"
          : "missing credentials",
  };
}

export function loadArticleMarkdown(path) {
  return readFileSync(path, "utf8");
}

// ---------------------------------------------------------------------------
// Network. Thin on purpose — everything above is verifiable without a token.
// ---------------------------------------------------------------------------

// X's article errors are unusually load-bearing: the two most likely failures
// (no Premium, wrong token type) both surface as bare 401/403 with no hint.
export function classifyArticleError(status, bodyText) {
  const base = `${status} ${bodyText}`;
  if (status === 403) {
    return `X refused the article (403). The usual cause is that the authenticated account does not have X Premium, ` +
      `which Articles require. Second most likely: the token is missing the tweet.write scope. Raw: ${base}`;
  }
  if (status === 401) {
    return `X rejected the credentials (401). If this token works for posting, it is probably app-only — ` +
      `Articles need a USER token (OAuth 2.0 PKCE or OAuth 1.0a). Raw: ${base}`;
  }
  if (status === 400) {
    return `X rejected the article body (400). content_state field names must be snake_case ` +
      `(inline_style_ranges, entity_ranges) — camelCase parses and is then ignored. Raw: ${base}`;
  }
  return `article request failed: ${base}`;
}

async function articleFetch(url, accessToken, payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(payload ? { "Content-Type": "application/json" } : {}),
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(classifyArticleError(res.status, text));
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`article request returned non-JSON: ${text.slice(0, 400)}`);
  }
}

// Creates a PRIVATE draft. Returns { id, raw }. Nothing is public yet.
// An article cover is an ordinary uploaded image referenced by id. Build the
// object with this rather than inlining the shape: media_category is required
// and "tweet_image" is the value that works for a cover, which is not obvious
// from the name.
//
// Uploading is deliberately NOT done here. core modules are vendored by `cp`
// with no import rewriting (scripts/vendor-core.sh), so article.mjs cannot
// import uploadMedia from poster.mjs — the copy would reference a path that
// does not exist beside it. The callers can import both, so they upload and
// pass the id in.
export function coverMediaFor(mediaId) {
  if (!mediaId) return null;
  return { media_category: "tweet_image", media_id: String(mediaId) };
}

export async function createArticleDraft({ title, contentState, coverMedia }, accessToken) {
  const json = await articleFetch(ARTICLE_DRAFT_URL, accessToken, {
    title,
    content_state: contentState,
    // Omit the key entirely when there is no cover. X's schema declares
    // additionalProperties:false, and a null here is not the same as absent.
    ...(coverMedia ? { cover_media: coverMedia } : {}),
  });
  const id = json?.data?.id ?? json?.id ?? null;
  if (!id) throw new Error(`article draft returned no id: ${JSON.stringify(json).slice(0, 400)}`);
  return { id, raw: json };
}

// Makes an existing draft public. This is the irreversible step.
export async function publishArticleDraft(articleId, accessToken) {
  const json = await articleFetch(articlePublishUrl(articleId), accessToken, null);
  return { id: articleId, raw: json };
}
