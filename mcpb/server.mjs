// mcp/server.mjs — X Poster MCP server
// Exports:
//   makeTools(deps)    — pure factory; testable with no SDK and no network
//   loadEnvFile(path)  — parse a KEY=VALUE env file (no --env-file dependency)
//   startServer()      — wires real deps + SDK stdio transport; run guard at bottom

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildPlan, costEstimate, containsUrl, postCost, resolveMaxChars, STANDARD_TWEET_CHARS, LONGFORM_TWEET_CHARS } from "./_poster.mjs";
import { makeTokenStore } from "./_token-store.mjs";
import { startAuthSession } from "./_auth.mjs";
import { resolveVibedraftConfig, validateSchedule, validateBulkSchedule, makeScheduleClient, BULK_ITEMS_MAX } from "./_scheduler.mjs";

// ---------------------------------------------------------------------------
// loadEnvFile — minimal KEY=VALUE parser (mirrors the CLI's X_ENV_FILE support
// without depending on node's --env-file flag, which the plugin path can't set).
// Returns an object of parsed pairs; ignores blank lines and # comments.
// Splits on the FIRST '=' only (values may contain '='). Strips one layer of
// surrounding single/double quotes. Returns {} if the file can't be read.
// ---------------------------------------------------------------------------

export function loadEnvFile(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key) continue;
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Nonce helpers (per-process secret; payload-bound; 10-min TTL)
// ---------------------------------------------------------------------------

function makeNonceFns(secret) {
  // Order-preserving canonical form of the normalized payload. in_reply_to and
  // video are bound so a nonce minted for one payload can't be replayed for another.
  function canonical(tweets, image, inReplyTo, video) {
    return JSON.stringify({ tweets, image: image || null, in_reply_to: inReplyTo || null, video: video || null });
  }

  // Bulk canonical wraps under a distinct top-level key so a single-post nonce
  // can never verify for a bulk payload or vice versa. Content-bound, TIME-FREE
  // (same semantics as single-post: content is frozen at the nonce; the times
  // are chosen at confirm).
  function canonicalBulk(items) {
    return JSON.stringify({
      bulk: items.map((it) => ({ tweets: it.tweets, in_reply_to: it.inReplyTo || null })),
    });
  }

  function mintFor(payload) {
    const ts = Date.now();
    const sig = createHmac("sha256", secret).update(`${payload}.${ts}`).digest("hex");
    const hash = createHmac("sha256", secret).update(payload).digest("hex");
    return `${hash}.${ts}.${sig}`;
  }

  function verifyFor(nonce, payload) {
    if (!nonce || typeof nonce !== "string") return false;
    const parts = nonce.split(".");
    // Format: payloadHash.ts.sig — sig (64-char hex) last, ts second-to-last, payloadHash everything before.
    if (parts.length < 3) return false;
    const sig = parts[parts.length - 1];
    const ts = parseInt(parts[parts.length - 2], 10);
    const hash = parts.slice(0, parts.length - 2).join(".");

    if (isNaN(ts)) return false;
    if (Date.now() - ts >= 600_000) return false; // 10-min TTL

    const expectedHash = createHmac("sha256", secret).update(payload).digest("hex");
    const expectedSig = createHmac("sha256", secret).update(`${payload}.${ts}`).digest("hex");

    // Constant-time comparisons
    let hashMatch = false;
    let sigMatch = false;
    try {
      hashMatch = timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(expectedHash, "hex"));
      sigMatch = timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expectedSig, "hex"));
    } catch {
      return false;
    }
    return hashMatch && sigMatch;
  }

  const mintNonce = (tweets, image, inReplyTo, video) => mintFor(canonical(tweets, image, inReplyTo, video));
  const verifyNonce = (nonce, tweets, image, inReplyTo, video) => verifyFor(nonce, canonical(tweets, image, inReplyTo, video));
  const mintBulkNonce = (items) => mintFor(canonicalBulk(items));
  const verifyBulkNonce = (nonce, items) => verifyFor(nonce, canonicalBulk(items));

  return { mintNonce, verifyNonce, mintBulkNonce, verifyBulkNonce };
}

// ---------------------------------------------------------------------------
// resolveAuthPort — the authorize callback port.
// An UNSET optional .mcpb user_config field arrives as "" (not undefined), and
// Number("") is 0 → an ephemeral port → a callback URL that won't match the
// http://127.0.0.1:8723/callback registered in the X app. So treat blank/invalid
// as the 8723 default. An explicit "0" is honored (tests bind an ephemeral port).
// ---------------------------------------------------------------------------

export function resolveAuthPort(raw) {
  const v = (raw ?? "").toString().trim();
  if (v === "") return 8723;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : 8723;
}

// resolveMaxChars + the char-limit constants live in core (single source of
// truth, shared with the CLI). Re-exported here so callers and tests that
// import from the server keep working.
export { resolveMaxChars, STANDARD_TWEET_CHARS, LONGFORM_TWEET_CHARS };

// ---------------------------------------------------------------------------
// normalize: text|thread → tweets[], error if both or neither
// ---------------------------------------------------------------------------

function normalize({ text, thread }) {
  const hasText = text !== undefined && text !== null;
  const hasThread = Array.isArray(thread) && thread.length > 0;

  if (hasText && hasThread) throw new Error("provide either text or thread, not both");
  if (!hasText && !hasThread) throw new Error("provide either text or thread");

  const tweets = hasThread ? thread : [text];
  return tweets;
}

// normalizeBulk: posts[] → [{tweets, scheduledFor, inReplyTo}], all-or-nothing.
// image/video ride along so validateBulkSchedule can REJECT them explicitly —
// bulk is text-only, and dropping a media field silently is the --video-incident
// failure class.
function normalizeBulk(posts) {
  if (!Array.isArray(posts) || posts.length === 0) throw new Error("provide a posts array with 1-" + BULK_ITEMS_MAX + " items");
  const errors = [];
  const items = posts.map((p, i) => {
    try {
      const tweets = normalize({ text: p?.text, thread: p?.thread });
      return { tweets, scheduledFor: p?.scheduled_for, inReplyTo: p?.in_reply_to || null, image: p?.image || null, video: p?.video || null };
    } catch (e) {
      errors.push(`post ${i + 1}: ${e.message}`);
      return null;
    }
  });
  if (errors.length) throw new Error(errors.join("; "));
  return items;
}

// ---------------------------------------------------------------------------
// renderDashboard — preformatted step-tracker block for tool responses.
// Clients relay it VERBATIM, so the workflow display is deterministic and
// identical across sessions — the model never reformats preview data.
// stage: "preview" | "published" | "scheduled"
// ---------------------------------------------------------------------------

export function renderDashboard({ stage, tweets, perPost, estimatedCostUsd, hasImage, hasVideo, inReplyTo, errors = [], urls = [], scheduledFor = null, scheduledIds = [], mediaId = null }) {
  const isThread = tweets.length > 1;
  const kind = isThread ? `thread ×${tweets.length}` : "post";
  const header = `🐦 x-poster ▸ ${kind}${inReplyTo ? ` ▸ reply → ${inReplyTo}` : ""}`;

  const rule = "─".repeat(44);
  const body = tweets.map((t, i) => `${i + 1}│ ${t}`).join("\n");

  const ok = errors.length === 0;
  const steps =
    stage === "published" ? "✅ resolve   ✅ validate   ✅ gate   ✅ publish"
    : stage === "scheduled" ? "✅ resolve   ✅ validate   ✅ gate   📅 scheduled"
    : ok                  ? "✅ resolve   ✅ validate   🟡 gate   ⚪ publish"
    :                       "✅ resolve   ❌ validate   ⚪ gate   ⚪ publish";

  const chars = perPost.reduce((n, p) => n + p.chars, 0);
  const hasUrl = perPost.some((p) => p.hasUrl);
  const mediaLabel = hasVideo ? "🎬 video" : hasImage ? "🖼 image" : "🖼 none";
  const stats = `📝 ${tweets.length} tweet${isThread ? "s" : ""} · ${chars} chars · ${mediaLabel} · ${hasUrl ? "🔗 url" : "🔗 none"}`;
  const cost = stage === "published"
    ? `💸 $${estimatedCostUsd.toFixed(3)} charged`
    : stage === "scheduled"
    ? `💸 est. $${estimatedCostUsd.toFixed(3)} at post time (billed via vibedraft's X app)`
    : `💸 est. $${estimatedCostUsd.toFixed(3)}`;

  const lines = [header, rule, body, rule, steps, stats, cost];
  if (stage === "published") {
    for (const u of urls) lines.push(`🚀 live: ${u}`);
  } else if (stage === "scheduled") {
    lines.push(`📅 fires at ${scheduledFor} (vibedraft may nudge by ±a few min to look human)`);
    if (mediaId) lines.push(`📎 media uploaded to vibedraft (id ${mediaId}) — attaches to the first tweet at post time`);
    for (const id of scheduledIds) lines.push(`🗂 scheduled id: ${id}`);
  } else if (ok) {
    lines.push(`🚦 awaiting explicit confirmation — reply "ship it" to publish`);
  } else {
    for (const e of errors) lines.push(`⚠️ ${e}`);
    lines.push("⛔ fix validation errors, then preview again");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// renderBulkDashboard — the bulk sibling of renderDashboard. One line per item;
// clients relay it VERBATIM. stage: "preview" | "scheduled"
// items: [{tweets, scheduledFor, estimatedCostUsd}]; results align by index
// (scheduled stage only, from core scheduleBulk).
// ---------------------------------------------------------------------------

const BULK_SNIPPET_CHARS = 40;

function bulkSnippet(tweets) {
  const first = (tweets[0] ?? "").replace(/\s+/g, " ").trim();
  return first.length > BULK_SNIPPET_CHARS ? `${first.slice(0, BULK_SNIPPET_CHARS)}…` : first;
}

export function renderBulkDashboard({ stage, items, totalEstimatedCostUsd, errors = [], results = [], aborted = false }) {
  const header = `🐦 x-poster ▸ bulk ×${items.length}`;
  const rule = "─".repeat(44);
  const pad = (n) => String(n).padStart(2, " ");

  const lines = [header, rule];
  if (stage === "scheduled") {
    const byIndex = new Map(results.map((r) => [r.index, r]));
    items.forEach((it, i) => {
      const r = byIndex.get(i);
      const mark =
        r?.status === "scheduled" ? `✅ ${r.scheduled_for} · id ${r.ids?.[0]}`
        : r?.status === "failed" ? `❌ ${r.error}`
        : r?.status === "unknown" ? `❓ ${r.error}`
        : "⏭ skipped";
      lines.push(`${pad(i + 1)}│ ${mark} · ${bulkSnippet(it.tweets)}`);
    });
  } else {
    items.forEach((it, i) => {
      const kind = it.tweets.length > 1 ? `thread ×${it.tweets.length}` : "post";
      lines.push(`${pad(i + 1)}│ ${it.scheduledFor} · ${kind} · $${it.estimatedCostUsd.toFixed(3)} · ${bulkSnippet(it.tweets)}`);
    });
  }
  lines.push(rule);

  const ok = errors.length === 0;
  const totalTweets = items.reduce((n, it) => n + it.tweets.length, 0);
  if (stage === "scheduled") {
    const scheduled = results.filter((r) => r.ok).length;
    const failed = results.length - scheduled;
    lines.push(failed === 0 ? "✅ resolve   ✅ validate   ✅ gate   📅 scheduled" : "✅ resolve   ✅ validate   ✅ gate   ⚠️ partial");
    lines.push(`📅 ${scheduled}/${items.length} scheduled${failed ? ` · ${failed} not scheduled` : ""}${aborted ? " · batch aborted early" : ""}`);
    lines.push(`💸 est. $${totalEstimatedCostUsd.toFixed(3)} total at post time (billed via vibedraft's X app)`);
    if (failed) lines.push("🧹 recovery: fix the failed items and re-run preview_bulk with ONLY them; cancel_scheduled <id> removes any scheduled one");
  } else if (ok) {
    lines.push("✅ resolve   ✅ validate   🟡 gate   ⚪ schedule");
    lines.push(`📝 ${items.length} posts · ${totalTweets} tweets · 💸 est. $${totalEstimatedCostUsd.toFixed(3)} total at post time`);
    lines.push(`🕰 times may shift ±a few min (vibedraft humanization jitter)`);
    lines.push(`🚦 awaiting explicit confirmation — reply "ship it" to schedule all ${items.length}`);
  } else {
    lines.push("✅ resolve   ❌ validate   ⚪ gate   ⚪ schedule");
    for (const e of errors) lines.push(`⚠️ ${e}`);
    lines.push("⛔ fix validation errors, then preview_bulk again — nothing was submitted");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// makeTools — pure factory; no SDK, no network required
// deps = { postThread, statePath, elicit?, maxChars?, getScheduleClient? }
//   postThread(tweets, image?, inReplyTo?, video?) → ids[]   (injected; may be mock)
//   elicit is either null or async ({rendered, costUsd}) => boolean
//   maxChars is the per-tweet character limit (default 25000; X's hard ceiling)
//   getScheduleClient() → vibedraft schedule client (throws an actionable error
//     when VIBEDRAFT_API_URL/TOKEN are unset — resolution is LAZY so the server
//     works fine for users who never schedule)
// ---------------------------------------------------------------------------

export function makeTools(deps) {
  const {
    postThread: injectedPostThread,
    statePath,
    elicit = null,
    maxChars = LONGFORM_TWEET_CHARS,
    getScheduleClient = () => {
      throw new Error("scheduling is not configured for this server instance");
    },
  } = deps;

  // Per-factory random secret for nonces
  const nonceSecret = randomBytes(32);
  const { mintNonce, verifyNonce, mintBulkNonce, verifyBulkNonce } = makeNonceFns(nonceSecret);

  // -------------------------------------------------------------------------
  // preview_post — PURE, zero network
  // -------------------------------------------------------------------------
  async function previewHandler({ text, thread, image, video, in_reply_to }) {
    const tweets = normalize({ text, thread });
    const plan = buildPlan({ tweets, dryRun: true, image: image || null, video: video || null, maxChars });
    const confirm_nonce = mintNonce(tweets, image || null, in_reply_to || null, video || null);
    return {
      tweets: plan.tweets,
      perPost: plan.perPost,
      estimatedCostUsd: plan.estimatedCostUsd,
      isThread: plan.isThread,
      hasImage: plan.hasImage,
      hasVideo: plan.hasVideo,
      videoBytes: plan.videoBytes,
      errors: plan.errors,
      confirm_nonce,
      render: renderDashboard({
        stage: "preview",
        tweets: plan.tweets,
        perPost: plan.perPost,
        estimatedCostUsd: plan.estimatedCostUsd,
        hasImage: plan.hasImage,
        hasVideo: plan.hasVideo,
        inReplyTo: in_reply_to || null,
        errors: plan.errors,
      }),
    };
  }

  // -------------------------------------------------------------------------
  // publish_post — the ONLY writer
  // -------------------------------------------------------------------------
  async function publishHandler({ text, thread, image, video, confirm_nonce, in_reply_to }) {
    const tweets = normalize({ text, thread });
    if (tweets.length === 0 || tweets.every(t => !t || !t.trim())) {
      throw new Error("no tweets: text is empty");
    }

    // Server-side recompute of cost — never trust model-supplied cost
    const plan = buildPlan({ tweets, dryRun: false, confirm: true, hasCreds: true, image: image || null, video: video || null, maxChars });
    if (plan.errors.length) throw new Error(plan.errors.join("; "));

    // Confirmation gate
    if (typeof elicit === "function") {
      const reply = in_reply_to ? `\n\n(reply to tweet ${in_reply_to})` : "";
      const rendered = tweets.join("\n---\n") + reply;
      const approved = await elicit({ rendered, costUsd: plan.estimatedCostUsd });
      if (!approved) throw new Error("user declined");
    } else {
      if (!verifyNonce(confirm_nonce, tweets, image || null, in_reply_to || null, video || null)) {
        throw new Error("missing/invalid confirm_nonce — call preview_post first to get a nonce");
      }
    }

    // Post via injected postThread
    const ids = await injectedPostThread(tweets, image || null, in_reply_to || null, video || null);
    const urls = ids.map(id => `https://x.com/i/web/status/${id}`);
    return {
      posted: ids,
      urls,
      render: renderDashboard({
        stage: "published",
        tweets,
        perPost: plan.perPost,
        estimatedCostUsd: plan.estimatedCostUsd,
        hasImage: plan.hasImage,
        hasVideo: plan.hasVideo,
        inReplyTo: in_reply_to || null,
        urls,
      }),
    };
  }

  // -------------------------------------------------------------------------
  // schedule_post — writes to vibedraft, not X. Same human gate as publish:
  // the preview_post nonce (bound to the exact tweets + image/video +
  // in_reply_to) must verify, or an elicitation-capable client confirms
  // in-form. The user's "ship at T" IS the publish approval — content is
  // frozen at the nonce; only the time is chosen at confirm. Media is
  // uploaded AFTER the gate (never spend an upload on an unconfirmed post)
  // and attaches to the first tweet at dispatch time.
  // -------------------------------------------------------------------------
  async function scheduleHandler({ text, thread, scheduled_for, in_reply_to, image, video, confirm_nonce }) {
    const tweets = normalize({ text, thread });

    const errors = validateSchedule({
      tweets,
      scheduledFor: scheduled_for,
      inReplyTo: in_reply_to || null,
      image: image || null,
      video: video || null,
    });
    // Char-limit + cost come from the same planner as publish. Dedupe: both
    // validators flag missing files / image+video exclusivity.
    const plan = buildPlan({ tweets, dryRun: true, image: image || null, video: video || null, maxChars });
    for (const e of plan.errors) if (!errors.includes(e)) errors.push(e);
    if (errors.length) throw new Error(errors.join("; "));

    // Confirmation gate — identical branches to publish_post. The nonce is the
    // one preview_post minted for this exact payload, media included.
    if (typeof elicit === "function") {
      const reply = in_reply_to ? `\n\n(reply to tweet ${in_reply_to})` : "";
      const media = video ? `\n\n(attach video: ${video})` : image ? `\n\n(attach image: ${image})` : "";
      const rendered = tweets.join("\n---\n") + reply + media + `\n\nSchedule for: ${scheduled_for}`;
      const approved = await elicit({ rendered, costUsd: plan.estimatedCostUsd });
      if (!approved) throw new Error("user declined");
    } else {
      if (!verifyNonce(confirm_nonce, tweets, image || null, in_reply_to || null, video || null)) {
        throw new Error("missing/invalid confirm_nonce — call preview_post first to get a nonce");
      }
    }

    const client = getScheduleClient();
    let mediaId = null;
    if (image || video) {
      ({ mediaId } = await client.uploadMedia({ filePath: image || video }));
    }
    const rows = await client.schedulePosts({
      tweets,
      scheduledFor: scheduled_for,
      inReplyTo: in_reply_to || null,
      ...(mediaId ? { mediaId } : {}),
    });
    // vibedraft applies the user's humanization jitter server-side.
    const actualFor = rows[0]?.scheduled_for ?? scheduled_for;
    return {
      scheduled: rows,
      scheduled_for: actualFor,
      ...(mediaId ? { media_id: mediaId } : {}),
      render: renderDashboard({
        stage: "scheduled",
        tweets,
        perPost: plan.perPost,
        estimatedCostUsd: plan.estimatedCostUsd,
        hasImage: plan.hasImage,
        hasVideo: plan.hasVideo,
        inReplyTo: in_reply_to || null,
        scheduledFor: actualFor,
        scheduledIds: rows.map((r) => r.id),
        mediaId,
      }),
    };
  }

  // -------------------------------------------------------------------------
  // preview_bulk / schedule_bulk — up to BULK_ITEMS_MAX independent posts,
  // each at its own time, in ONE confirmed action. Client-side loop over the
  // vibedraft API (its posts[] is a thread, not a bulk list). Validation is
  // all-or-nothing; submission reports per-item results and never throws on
  // partial failure so the caller can relay what happened + how to recover.
  // -------------------------------------------------------------------------
  function planBulk(posts) {
    const items = normalizeBulk(posts);
    const errors = validateBulkSchedule(items);
    const withPlans = items.map((it, i) => {
      const plan = buildPlan({ tweets: it.tweets, dryRun: true, maxChars });
      errors.push(...plan.errors.map((e) => `post ${i + 1}: ${e}`));
      return { ...it, perPost: plan.perPost, estimatedCostUsd: plan.estimatedCostUsd };
    });
    const totalEstimatedCostUsd = withPlans.reduce((s, it) => s + it.estimatedCostUsd, 0);
    return { items: withPlans, errors, totalEstimatedCostUsd };
  }

  async function previewBulkHandler({ posts }) {
    const { items, errors, totalEstimatedCostUsd } = planBulk(posts);
    const confirm_nonce = mintBulkNonce(items);
    return {
      items: items.map((it) => ({
        tweets: it.tweets,
        scheduled_for: it.scheduledFor,
        in_reply_to: it.inReplyTo,
        perPost: it.perPost,
        estimatedCostUsd: it.estimatedCostUsd,
      })),
      totalEstimatedCostUsd,
      errors,
      confirm_nonce,
      render: renderBulkDashboard({ stage: "preview", items, totalEstimatedCostUsd, errors }),
    };
  }

  async function scheduleBulkHandler({ posts, confirm_nonce }) {
    const { items, errors, totalEstimatedCostUsd } = planBulk(posts);
    if (errors.length) throw new Error(errors.join("; "));

    // Confirmation gate — same branches as schedule_post. The bulk nonce is
    // content-bound (not time-bound) and cannot cross-verify with single-post
    // nonces. Elicit message truncates each item for display; the gate still
    // covers the full payload because this handler re-validated it above.
    if (typeof elicit === "function") {
      const rendered = items
        .map((it, i) => {
          const first = it.tweets.join(" / ");
          const snippet = first.length > 80 ? `${first.slice(0, 80)}…` : first;
          return `${i + 1}. [${it.scheduledFor}] ${snippet}`;
        })
        .join("\n");
      const approved = await elicit({ rendered: `Bulk schedule ${items.length} posts:\n${rendered}`, costUsd: totalEstimatedCostUsd });
      if (!approved) throw new Error("user declined");
    } else {
      if (!verifyBulkNonce(confirm_nonce, items)) {
        throw new Error("missing/invalid confirm_nonce — call preview_bulk first to get a nonce");
      }
    }

    const client = getScheduleClient();
    const out = await client.scheduleBulk({ items });
    return {
      ...out,
      totalEstimatedCostUsd,
      render: renderBulkDashboard({
        stage: "scheduled",
        items,
        totalEstimatedCostUsd,
        results: out.results,
        aborted: out.aborted,
      }),
    };
  }

  // -------------------------------------------------------------------------
  // list_scheduled — read-only; how callers learn posted_tweet_id
  // -------------------------------------------------------------------------
  async function listScheduledHandler({ status, since, limit } = {}) {
    const client = getScheduleClient();
    const posts = await client.listScheduled({ status, since, limit });
    return { posts };
  }

  // -------------------------------------------------------------------------
  // cancel_scheduled — the "safe direction" (prevents a post); no gate needed
  // -------------------------------------------------------------------------
  async function cancelScheduledHandler({ id }) {
    if (!id || typeof id !== "string") throw new Error("id is required");
    const client = getScheduleClient();
    const canceled = await client.cancelScheduled(id);
    return { canceled };
  }

  // -------------------------------------------------------------------------
  // auth_instructions — read-only
  // -------------------------------------------------------------------------
  async function authHandler() {
    return {
      easiest_path: [
        "1. One-time, in a browser: create a free X Developer App at https://developer.x.com.",
        "   In 'User authentication settings' set App type = Web App / Confidential client,",
        "   add the EXACT callback URL http://127.0.0.1:8723/callback,",
        "   and enable scopes: tweet.read tweet.write users.read media.write offline.access.",
        "2. Give this MCP server the app's Client ID and Client Secret (the .mcpb install dialog asks for them).",
        "3. Run the `authorize` tool — it returns a link. Open it, click Authorize, done. No terminal needed.",
      ],
      cli_alternative: {
        command: "node --env-file=.env bin/x-auth.mjs",
        note: "Prints X_REFRESH_TOKEN=... to paste into your env file. Same flow, terminal flavor.",
      },
      envVars: ["X_CLIENT_ID", "X_CLIENT_SECRET"],
      optionalEnvVars: {
        X_REFRESH_TOKEN: "Seed token — only needed if you skip the authorize tool",
        X_STATE_FILE: "Path to persist the rotating refresh token (default: ~/.local/state/x-poster/token)",
        X_AUTH_PORT: "Callback port for authorize (default 8723; must match the registered callback URL)",
      },
    };
  }

  return {
    preview_post: { handler: previewHandler },
    publish_post: { handler: publishHandler },
    schedule_post: { handler: scheduleHandler },
    preview_bulk: { handler: previewBulkHandler },
    schedule_bulk: { handler: scheduleBulkHandler },
    list_scheduled: { handler: listScheduledHandler },
    cancel_scheduled: { handler: cancelScheduledHandler },
    auth_instructions: { handler: authHandler },
  };
}

// ---------------------------------------------------------------------------
// makePostAdapter — pure factory for the injected postThread.
// core.postThread(tweets, creds, onRotatedToken, image, inReplyTo, video) ALREADY
// owns refresh + rotation. So the adapter must:
//   - call corePostThread EXACTLY ONCE (no extra refresh → no double-burn),
//   - pass tokenStore.current() as the refresh token,
//   - persist any rotated token via tokenStore.persist.
// Serialize posts: X refresh tokens are single-use; two concurrent posts could
// double-burn the token and trip reuse-detection (revokes the whole grant).
// Testable with no SDK and no network (inject a fake corePostThread).
// ---------------------------------------------------------------------------

// Module-level promise chain: ensures posts are executed one at a time.
let _postChain = Promise.resolve();

export function makePostAdapter({ tokenStore, corePostThread, clientId, clientSecret }) {
  return (tweets, image, inReplyTo, video) => {
    // Fail with the FIX, not the symptom: a fresh install has no refresh token
    // yet, and the cure is one authorize call — not an opaque OAuth 400.
    try {
      tokenStore.current();
    } catch {
      return Promise.reject(new Error(
        "Not connected to your X account yet — run the authorize tool first. " +
        "It returns a link; open it, click Authorize, done. No terminal needed.",
      ));
    }
    const run = _postChain.then(() =>
      corePostThread(
        tweets,
        { clientId, clientSecret, refreshToken: tokenStore.current() },
        (newToken) => tokenStore.persist(newToken),
        image || null,
        inReplyTo || null,
        video || null,
      )
    );
    // Keep the chain alive whether this call succeeds or errors.
    _postChain = run.then(() => {}, () => {});
    return run;
  };
}

// ---------------------------------------------------------------------------
// startServer — wires real deps + SDK stdio transport
// ---------------------------------------------------------------------------

export async function startServer() {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { z } = await import("zod");

  // Credential resolution. The .mcpb bundle injects creds via user_config → env.
  // The Claude Code plugin path has no UI for that, so it can point X_ENV_FILE at
  // the SAME env file the CLI uses. process.env always wins over the file.
  // Blank .mcpb user_config fields arrive as empty strings — treat as unset.
  const norm = (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const fileCreds = process.env.X_ENV_FILE ? loadEnvFile(process.env.X_ENV_FILE) : {};
  const clientId = norm(process.env.X_CLIENT_ID) ?? norm(fileCreds.X_CLIENT_ID);
  const clientSecret = norm(process.env.X_CLIENT_SECRET) ?? norm(fileCreds.X_CLIENT_SECRET);

  // Fail fast with an actionable message rather than letting a missing client
  // credential surface as an opaque 401 at publish time.
  if (!clientId || !clientSecret) {
    throw new Error(
      "missing X_CLIENT_ID/X_CLIENT_SECRET. Either install the .mcpb bundle " +
        "(enter keys in the Claude UI) or set X_ENV_FILE to your env file / export " +
        "the vars before launching. Run auth_instructions for help.",
    );
  }

  const XDG_STATE_HOME = process.env.XDG_STATE_HOME || `${process.env.HOME}/.local/state`;
  const defaultStatePath = `${process.env.CLAUDE_PLUGIN_DATA || `${XDG_STATE_HOME}/x-poster`}/token`;
  const statePath = process.env.X_STATE_FILE || defaultStatePath;
  const seedRefreshToken = norm(process.env.X_REFRESH_TOKEN) ?? norm(fileCreds.X_REFRESH_TOKEN);

  const tokenStore = makeTokenStore({ statePath, seedRefreshToken });

  const { postThread: corePostThread } = await import("./_poster.mjs");

  const server = new McpServer({ name: "x-poster", version: "0.1.0" });

  // The post adapter is stable across connections; only `elicit` varies per
  // request (client elicitation capability is per-connection). So we build a
  // fresh tools instance per publish call with the right `elicit`, but reuse
  // this one adapter so corePostThread is called exactly once per post.
  const injectedPostThread = makePostAdapter({ tokenStore, corePostThread, clientId, clientSecret });

  // Char count doesn't block by default (long-form works); X_MAX_TWEET_CHARS can
  // opt back into a stricter limit like 280.
  const maxChars = resolveMaxChars(process.env.X_MAX_TWEET_CHARS);

  // vibedraft schedule client — resolved LAZILY on first schedule/list/cancel
  // call so the server boots fine without VIBEDRAFT_* config (scheduling is
  // optional). Same env-file fallback as the X creds.
  let scheduleClient = null;
  const getScheduleClient = () => {
    if (!scheduleClient) {
      const cfg = resolveVibedraftConfig(process.env, fileCreds);
      scheduleClient = makeScheduleClient(cfg);
    }
    return scheduleClient;
  };

  // makeTools(elicit) — factory bound to the stable deps, parameterized on elicit.
  const buildTools = (elicit) =>
    makeTools({ postThread: injectedPostThread, statePath, elicit, maxChars, getScheduleClient });

  // preview_post / auth_instructions never elicit, so a nonce-mode instance is fine.
  // IMPORTANT: nonces are bound to a per-factory random secret, so preview_post and
  // publish_post (nonce branch) must share ONE tools instance, or a preview nonce
  // won't verify at publish. Use this shared instance for both.
  const nonceTools = buildTools(null);

  // Register tools with zod raw-shape inputs (SDK 1.29 rejects plain JSON Schema
  // in registerTool — it only accepts Zod schemas / raw shapes).
  server.registerTool(
    "preview_post",
    {
      description: "Preview an X post or thread. Returns cost estimate, a confirm_nonce for publish_post, and a `render` dashboard block — show `render` to the user VERBATIM (do not reformat). PURE — no network I/O.",
      inputSchema: {
        text: z.string().optional().describe("Single tweet text (mutually exclusive with thread)"),
        thread: z.array(z.string()).optional().describe("Array of tweet texts for a thread (mutually exclusive with text)"),
        image: z.string().optional().describe("Absolute path to an image file to attach to the first tweet (mutually exclusive with video)"),
        video: z.string().optional().describe("Absolute path to a .mp4 video file to attach to the first tweet via chunked upload (mutually exclusive with image)"),
        in_reply_to: z.string().optional().describe("Existing tweet ID to reply to — the post (or first tweet of a thread) becomes a reply to it"),
      },
    },
    async (args) => {
      const result = await nonceTools.preview_post.handler(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    "publish_post",
    {
      description: "Publish an X post or thread. Re-validates and recomputes cost server-side. Requires a valid confirm_nonce from preview_post (when elicitation not supported by client). Returns a `render` dashboard block — show it to the user VERBATIM.",
      inputSchema: {
        text: z.string().optional().describe("Single tweet text (mutually exclusive with thread)"),
        thread: z.array(z.string()).optional().describe("Array of tweet texts for a thread (mutually exclusive with text)"),
        image: z.string().optional().describe("Absolute path to an image file to attach to the first tweet (mutually exclusive with video)"),
        video: z.string().optional().describe("Absolute path to a .mp4 video file to attach to the first tweet via chunked upload (mutually exclusive with image). Must match the video passed to preview_post (the nonce is bound to it)."),
        in_reply_to: z.string().optional().describe("Existing tweet ID to reply to — must match the in_reply_to passed to preview_post (the nonce is bound to it)"),
        confirm_nonce: z.string().optional().describe("Nonce issued by preview_post for the SAME payload. Required when client does not support elicitation."),
      },
    },
    async (args, ctx) => {
      // Per-connection capability check. Elicitation-capable client → elicit confirm.
      // Non-capable client → fall through to nonce verification (reachable path).
      const supportsElicitation = !!ctx?.clientCapabilities?.elicitation;

      let tools;
      if (supportsElicitation) {
        const elicit = async ({ rendered, costUsd }) => {
          const result = await ctx.mcpReq.elicitInput({
            mode: "form",
            message: `Confirm posting to X:\n\n${rendered}\n\nEstimated cost: $${costUsd.toFixed(3)}`,
            requestedSchema: {
              type: "object",
              properties: {
                confirm: {
                  type: "boolean",
                  title: "Confirm post",
                  description: "Set to true to approve posting",
                },
              },
              required: ["confirm"],
            },
          });
          return result.action === "accept" && result.content?.confirm === true;
        };
        tools = buildTools(elicit);
      } else {
        // Reuse the shared nonce-mode instance so a confirm_nonce minted by
        // preview_post verifies (nonce secret is per-factory).
        tools = nonceTools;
      }

      const result = await tools.publish_post.handler(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    "schedule_post",
    {
      description:
        "Schedule an X post or thread for a future time via the user's vibedraft account. Supports one image (jpg/png/webp ≤5MB) or one .mp4 video (≤512MB) on the first tweet — uploaded to vibedraft at schedule time, attached at post time. " +
        "The cron dispatcher posts it at the scheduled time even if this machine is asleep. " +
        "Requires a valid confirm_nonce from preview_post for the SAME payload (text/thread + image/video + in_reply_to) — the user's 'ship it at <time>' is the approval; content is frozen at the nonce. " +
        "Returns a `render` dashboard block — show it to the user VERBATIM.",
      inputSchema: {
        text: z.string().optional().describe("Single tweet text (mutually exclusive with thread)"),
        thread: z.array(z.string()).optional().describe("Array of 2-6 tweet texts for a thread (mutually exclusive with text)"),
        scheduled_for: z.string().describe("ISO 8601 timestamp (with offset or Z) — must be >2 minutes and <30 days from now. vibedraft applies a small human-looking jitter."),
        image: z.string().optional().describe("Absolute path to a jpg/png/webp image (≤5MB) to attach to the first tweet (mutually exclusive with video) — must match the image passed to preview_post"),
        video: z.string().optional().describe("Absolute path to a .mp4 video (≤512MB) to attach to the first tweet (mutually exclusive with image) — must match the video passed to preview_post"),
        in_reply_to: z.string().optional().describe("Existing tweet ID to reply to — single post only, must match the in_reply_to passed to preview_post"),
        confirm_nonce: z.string().optional().describe("Nonce issued by preview_post for the SAME payload, media included. Required when client does not support elicitation."),
      },
    },
    async (args, ctx) => {
      const supportsElicitation = !!ctx?.clientCapabilities?.elicitation;
      let tools;
      if (supportsElicitation) {
        const elicit = async ({ rendered, costUsd }) => {
          const result = await ctx.mcpReq.elicitInput({
            mode: "form",
            message: `Confirm SCHEDULING via vibedraft:\n\n${rendered}\n\nEstimated cost at post time: $${costUsd.toFixed(3)}`,
            requestedSchema: {
              type: "object",
              properties: {
                confirm: {
                  type: "boolean",
                  title: "Confirm schedule",
                  description: "Set to true to approve scheduling",
                },
              },
              required: ["confirm"],
            },
          });
          return result.action === "accept" && result.content?.confirm === true;
        };
        tools = buildTools(elicit);
      } else {
        tools = nonceTools;
      }
      const result = await tools.schedule_post.handler(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  // Shared zod shape for a bulk item — text|thread (exactly one), an explicit
  // offset-bearing time, optional reply target.
  const bulkPostShape = z.object({
    text: z.string().optional().describe("Single tweet text (mutually exclusive with thread)"),
    thread: z.array(z.string()).optional().describe("Array of 2-6 tweet texts for a thread (mutually exclusive with text)"),
    scheduled_for: z.string().describe("ISO 8601 timestamp WITH an explicit offset or Z — each post gets its own time; must be >2 minutes and <30 days from now"),
    in_reply_to: z.string().optional().describe("Existing tweet ID to reply to — single post only"),
  });

  server.registerTool(
    "preview_bulk",
    {
      description:
        `Preview a bulk batch of up to ${BULK_ITEMS_MAX} independent X posts (each its own time) to be scheduled via vibedraft. ` +
        "Text only — no media. Returns per-item validation + cost, a total, a confirm_nonce for schedule_bulk, and a `render` dashboard block — show `render` to the user VERBATIM. PURE — no network I/O.",
      inputSchema: {
        posts: z.array(bulkPostShape).min(1).max(BULK_ITEMS_MAX).describe(`1-${BULK_ITEMS_MAX} posts, each {text|thread, scheduled_for, in_reply_to?}`),
      },
    },
    async (args) => {
      const result = await nonceTools.preview_bulk.handler(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    "schedule_bulk",
    {
      description:
        `Schedule up to ${BULK_ITEMS_MAX} independent X posts (each at its own time) via the user's vibedraft account, in one confirmed action. Text only — no media. ` +
        "Validation is all-or-nothing (a half-valid batch submits nothing); submission reports per-item results and does NOT throw on partial failure — relay failures and offer cancel_scheduled recovery. " +
        "Requires a valid confirm_nonce from preview_bulk for the SAME posts (content is frozen at the nonce; times may be adjusted before confirming). " +
        "vibedraft applies ±a few minutes of humanization jitter per post. Returns a `render` dashboard block — show it VERBATIM.",
      inputSchema: {
        posts: z.array(bulkPostShape).min(1).max(BULK_ITEMS_MAX).describe(`1-${BULK_ITEMS_MAX} posts, each {text|thread, scheduled_for, in_reply_to?}`),
        confirm_nonce: z.string().optional().describe("Nonce issued by preview_bulk for the SAME posts. Required when client does not support elicitation."),
      },
    },
    async (args, ctx) => {
      const supportsElicitation = !!ctx?.clientCapabilities?.elicitation;
      let tools;
      if (supportsElicitation) {
        const elicit = async ({ rendered, costUsd }) => {
          const result = await ctx.mcpReq.elicitInput({
            mode: "form",
            message: `Confirm BULK SCHEDULING via vibedraft:\n\n${rendered}\n\nTotal estimated cost at post time: $${costUsd.toFixed(3)}`,
            requestedSchema: {
              type: "object",
              properties: {
                confirm: {
                  type: "boolean",
                  title: "Confirm bulk schedule",
                  description: "Set to true to approve scheduling ALL listed posts",
                },
              },
              required: ["confirm"],
            },
          });
          return result.action === "accept" && result.content?.confirm === true;
        };
        tools = buildTools(elicit);
      } else {
        tools = nonceTools;
      }
      const result = await tools.schedule_bulk.handler(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    "list_scheduled",
    {
      description:
        "List the user's vibedraft scheduled posts. Read-only. Posted rows include posted_tweet_id (use it to link/tag the live tweet). " +
        "since= filters on last update, so polling with since catches pending→posted transitions.",
      inputSchema: {
        status: z.enum(["draft", "pending", "posting", "posted", "failed", "canceled"]).optional().describe("Filter by status"),
        since: z.string().optional().describe("ISO 8601 timestamp — only rows updated at/after this time"),
        limit: z.number().int().min(1).max(200).optional().describe("Max rows (default 100)"),
      },
    },
    async (args) => {
      const result = await nonceTools.list_scheduled.handler(args ?? {});
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    "cancel_scheduled",
    {
      description:
        "Cancel a pending vibedraft scheduled post before it fires (canceling any thread member cancels the whole thread). " +
        "Safe direction — prevents a post; no confirmation needed. Fails with 'only pending' if it already posted or is posting.",
      inputSchema: {
        id: z.string().describe("The scheduled post id (from schedule_post or list_scheduled)"),
      },
    },
    async (args) => {
      const result = await nonceTools.cancel_scheduled.handler(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    "auth_instructions",
    {
      description: "Returns the steps and command to mint an X OAuth 2.0 refresh token for use with this MCP server.",
      inputSchema: {},
    },
    async () => {
      const result = await nonceTools.auth_instructions.handler();
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  // authorize — in-chat OAuth bootstrap. Replaces the terminal x-auth.mjs step:
  // returns a link, the localhost callback exchanges the code and persists the
  // refresh token into the token store. One active session at a time.
  let activeAuthSession = null;
  server.registerTool(
    "authorize",
    {
      description:
        "Connect x-poster to the user's X account. Returns a link the user must open and approve — present it as a clickable link. " +
        "Run this on first-time setup, or when posting fails with 'not connected'. No terminal needed.",
      inputSchema: {},
    },
    async () => {
      activeAuthSession?.close();
      activeAuthSession = null;
      const port = resolveAuthPort(process.env.X_AUTH_PORT);
      let session;
      try {
        session = await startAuthSession({
          clientId,
          clientSecret,
          port,
          onToken: (token) => tokenStore.persist(token),
          onDone: () => { activeAuthSession = null; },
        });
      } catch (e) {
        const hint = e.code === "EADDRINUSE"
          ? ` Port ${port} is busy — close whatever is using it, or set X_AUTH_PORT to a free port AND register http://127.0.0.1:<port>/callback in your X app.`
          : "";
        throw new Error(`could not start the authorize listener: ${e.message}.${hint}`);
      }
      activeAuthSession = session;
      const result = {
        action_required: "Open this link in your browser and click 'Authorize app'.",
        authorize_url: session.authorizeUrl,
        expires: "The link is valid for 10 minutes.",
        after_approving: "X redirects to a local page saying 'Authorized ✓'. Come back here and post — setup is done.",
        troubleshooting: `If X shows a callback/redirect error, make sure ${session.redirectUri} is registered EXACTLY in your X app's callback URLs.`,
      };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Run guard
if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  startServer().catch((err) => {
    process.stderr.write(`x-poster-mcp: fatal: ${err.message}\n`);
    process.exit(1);
  });
}
