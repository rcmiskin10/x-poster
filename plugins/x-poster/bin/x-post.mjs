#!/usr/bin/env node
// x-post.mjs — CLI shim: post a tweet or a linear thread (with optional image) to X from the terminal.
//
// Dependency-free: Node's global fetch, no SDK, no node_modules. A single-account poster.
//
// SAFETY — never auto-publish:
//   * --dry-run (default when no creds) posts NOTHING — validates + prints plan + cost estimate.
//   * Real posting requires BOTH --confirm AND credentials present. No other path posts.
//
// COST (X pay-per-use, no free tier): $0.015/post, $0.20/post if it contains a URL
//   (worst-case: any URL => $0.20). A 5-tweet thread w/ one link ~= $0.26. See docs.x.com for current pricing.
//
// Auth (OAuth 2.0 user-context): env X_CLIENT_ID, X_CLIENT_SECRET, X_REFRESH_TOKEN (see env/.env.example).
//   Mint the refresh token once with x-auth.mjs. Refresh tokens ROTATE (single-use) — the new one is
//   persisted back to your env file automatically (set X_ENV_FILE; see onRotatedToken).
//
// Usage (pass YOUR env file with --env-file; nothing is read implicitly):
//   node --env-file=./your.env x-post.mjs --dry-run --text "single tweet"
//   node --env-file=./your.env x-post.mjs --dry-run --thread "tweet 1" "tweet 2 with https://x.com/foo"
//   node --env-file=./your.env x-post.mjs --confirm --image ./shot.png --text "..."   # REAL post; costs money
//   node --env-file=./your.env x-post.mjs --confirm --video ./clip.mp4 --text "..."   # video (mp4); image/video are mutually exclusive
//
// Scheduling (via vibedraft's API — needs VIBEDRAFT_API_URL + VIBEDRAFT_API_TOKEN in the env file;
//   posts go out through YOUR vibedraft-connected X account):
//   node --env-file=./your.env x-post.mjs --confirm --at 2026-07-08T09:00:00Z --text "..."   # schedule instead of post
//   node --env-file=./your.env x-post.mjs --confirm --at ... --video ./clip.mp4 --text "..." # scheduled WITH media (image jpg/png/webp ≤5MB, or mp4 ≤512MB)
//   node --env-file=./your.env x-post.mjs --bulk ./posts.json [--confirm]                    # bulk-schedule up to 20 posts, each at its own time (text only)
//     (posts.json = {"posts":[{"text":"...","scheduled_for":"2026-07-10T09:00:00Z"}, ...]}; without --confirm it's a dry-run)
//   node --env-file=./your.env x-post.mjs --list-scheduled [--status pending]                # list rows (posted → posted_tweet_id)
//   node --env-file=./your.env x-post.mjs --cancel <id>                                      # cancel a pending row

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildPlan, postThread, uploadMedia, refreshAccessToken, persistRefreshToken, resolveMaxChars } from "./_poster.mjs";
import { resolveVibedraftConfig, validateSchedule, validateBulkSchedule, makeScheduleClient } from "./_scheduler.mjs";
import { buildArticlePlan, createArticleDraft, publishArticleDraft, loadArticleMarkdown, coverMediaFor } from "./_article.mjs";

// ---- CLI entry (only when run directly, not when imported by tests) ----
export function parseArgs(argv) { // exported for core/_tests/surface-parity.test.mjs
  const out = { dryRun: false, confirm: false, tweets: [], image: undefined, video: undefined, uploadOnly: false, at: undefined, bulk: undefined, listScheduled: false, status: undefined, since: undefined, cancel: undefined, article: undefined, title: undefined, publish: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--confirm") out.confirm = true;
    else if (a === "--image") out.image = argv[++i];
    else if (a === "--video") out.video = argv[++i];
    else if (a === "--upload-only") { out.uploadOnly = true; out.image = argv[++i]; } // upload media, print id, no post
    else if (a === "--at") out.at = argv[++i]; // schedule via vibedraft instead of posting now
    else if (a === "--bulk") out.bulk = argv[++i]; // JSON file of posts to bulk-schedule via vibedraft
    else if (a === "--list-scheduled") out.listScheduled = true;
    else if (a === "--status") out.status = argv[++i];
    else if (a === "--since") out.since = argv[++i];
    else if (a === "--cancel") out.cancel = argv[++i];
    else if (a === "--article") out.article = argv[++i]; // path to a .md file to publish as a long-form X Article
    else if (a === "--title") out.title = argv[++i];     // article title (optional if the md has title: frontmatter)
    else if (a === "--publish") out.publish = true;      // article only: go PUBLIC (default is a private draft)
    else if (a === "--cover") out.cover = argv[++i];      // article only: path to the banner image (5:2, 1920x768)
    else if (a === "--text") out.tweets.push(argv[++i]);
    else if (a === "--thread") { while (argv[i + 1] && !argv[i + 1].startsWith("--")) out.tweets.push(argv[++i]); }
  }
  return out;
}

// Resolve the vibedraft schedule client from process.env (the user passed
// --env-file, so VIBEDRAFT_* are live env here). Exits with the fix when unset.
function scheduleClientOrExit() {
  try {
    return makeScheduleClient(resolveVibedraftConfig(process.env));
  } catch (e) {
    console.error("ERROR:", e.message);
    process.exit(2);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const creds = {
    clientId: process.env.X_CLIENT_ID,
    clientSecret: process.env.X_CLIENT_SECRET,
    refreshToken: process.env.X_REFRESH_TOKEN,
  };
  const hasCreds = !!(creds.clientId && creds.clientSecret && creds.refreshToken);
  // Default to dry-run when creds are absent so a bare invocation can never spend.
  if (!hasCreds) args.dryRun = args.dryRun || !args.confirm;

  const envPath = process.env.X_ENV_FILE || resolve(process.cwd(), ".env");
  const onRotatedToken = async (newToken) => {
    try {
      persistRefreshToken(newToken, envPath);
      console.error(`Refresh token rotated — persisted new X_REFRESH_TOKEN to ${envPath}.`);
    } catch (e) {
      console.error(`WARN: refresh token rotated but could NOT persist to ${envPath}: ${e.message}`);
      console.error("The next post will fail until X_REFRESH_TOKEN is updated. Re-run bin/x-auth.mjs to re-mint.");
    }
  };

  // Isolated media-upload test: uploads the image and prints the media id. No tweet, nothing public,
  // no per-post cost — used to detect the known May-2026 OAuth2 /2/media/upload 403 before spending.
  if (args.uploadOnly) {
    if (!hasCreds) { console.error("upload-only needs credentials."); process.exit(2); }
    if (!args.image || !existsSync(args.image)) { console.error(`image not found: ${args.image}`); process.exit(2); }
    const token = await refreshAccessToken(creds, onRotatedToken);
    const id = await uploadMedia(token, args.image);
    console.log(JSON.stringify({ uploadOnly: true, media_id: id }, null, 2));
    return;
  }

  // Scheduled-posts read paths — no X creds needed, only the vibedraft token.
  if (args.listScheduled) {
    const rows = await scheduleClientOrExit().listScheduled({ status: args.status, since: args.since });
    console.log(JSON.stringify({ posts: rows }, null, 2));
    return;
  }
  if (args.cancel) {
    const canceled = await scheduleClientOrExit().cancelScheduled(args.cancel);
    console.log(JSON.stringify({ canceled }, null, 2));
    return;
  }

  // Article path — long-form. Two gates, not one: --confirm creates a PRIVATE
  // draft, and --publish is what makes it public. A draft is readable in X's
  // editor and discardable; a published article under your byline is neither,
  // so the irreversible step gets its own flag rather than riding on --confirm.
  if (args.article) {
    if (!existsSync(args.article)) { console.error(`ERROR: article not found: ${args.article}`); process.exit(2); }
    // Check the cover before doing any work. A missing banner discovered after
    // the draft exists means an article on X without the image it was meant to
    // have, and drafts cannot be deleted through the API.
    if (args.cover && !existsSync(args.cover)) { console.error(`ERROR: cover not found: ${args.cover}`); process.exit(2); }
    const plan = buildArticlePlan({
      title: args.title,
      markdown: loadArticleMarkdown(args.article),
      dryRun: args.dryRun,
      hasCreds,
    });
    console.log(JSON.stringify({
      title: plan.title,
      blocks: plan.blocks,
      blockCounts: plan.blockCounts,
      words: plan.words,
      characters: plan.characters,
      links: plan.links,
      estimatedCostUsd: plan.estimatedCostUsd,
      costNote: plan.costNote,
      warnings: plan.warnings,
      errors: plan.errors,
      action: plan.action,
    }, null, 2));
    for (const w of plan.warnings) console.error(`WARN: ${w}`);
    if (plan.errors.length) { console.error("VALIDATION ERRORS:", plan.errors.join("; ")); process.exit(2); }

    if (!args.confirm || args.dryRun) {
      console.error(`NOT CREATING ARTICLE (${args.dryRun ? "dry-run" : "missing --confirm"}).`);
      return;
    }
    if (!hasCreds) { console.error("ERROR: article publishing needs credentials."); process.exit(2); }

    const token = await refreshAccessToken(creds, onRotatedToken);
    let coverMedia = null;
    if (args.cover) {
      console.error(`Uploading cover: ${args.cover}…`);
      coverMedia = coverMediaFor(await uploadMedia(token, args.cover));
    }
    console.error(`Creating a private draft: "${plan.title}" (${plan.words} words)…`);
    const draft = await createArticleDraft({ title: plan.title, contentState: plan.contentState, coverMedia }, token);
    if (!args.publish) {
      console.log(JSON.stringify({ articleId: draft.id, published: false }, null, 2));
      console.error(`Draft created (id ${draft.id}). Nothing is public. Re-run with --publish to go live.`);
      return;
    }
    await publishArticleDraft(draft.id, token);
    const url = `https://x.com/i/article/${draft.id}`;
    console.log(JSON.stringify({ articleId: draft.id, published: true, url }, null, 2));
    console.error(`Published: ${url}`);
    return;
  }

  const maxChars = resolveMaxChars(process.env.X_MAX_TWEET_CHARS);

  // Bulk schedule path — up to 20 independent posts from a JSON file, each at
  // its own offset-bearing ISO time. Same explicit gate as posting: --confirm
  // required; without it (or with --dry-run) the plan prints and NOTHING is
  // scheduled. Validation is all-or-nothing — one bad item blocks the batch.
  if (args.bulk) {
    let spec;
    try {
      spec = JSON.parse(readFileSync(args.bulk, "utf8"));
    } catch (e) {
      console.error(`ERROR: could not read bulk file ${args.bulk}: ${e.message}`);
      process.exit(2);
    }
    if (!Array.isArray(spec?.posts) || spec.posts.length === 0) {
      console.error(`ERROR: ${args.bulk} must contain {"posts": [{"text"|"thread", "scheduled_for", "in_reply_to"?}, ...]}`);
      process.exit(2);
    }
    const shapeErrors = [];
    const items = spec.posts.map((p, i) => {
      const hasText = p?.text !== undefined && p?.text !== null;
      const hasThread = Array.isArray(p?.thread) && p.thread.length > 0;
      if (hasText === hasThread) {
        shapeErrors.push(`post ${i + 1}: provide either text or thread${hasText ? ", not both" : ""}`);
        return null;
      }
      // image/video ride along so validateBulkSchedule rejects them explicitly (bulk is text-only).
      return { tweets: hasThread ? p.thread : [p.text], scheduledFor: p?.scheduled_for, inReplyTo: p?.in_reply_to || null, image: p?.image || null, video: p?.video || null };
    });
    if (shapeErrors.length) { console.error("VALIDATION ERRORS:", shapeErrors.join("; ")); process.exit(2); }

    const errors = validateBulkSchedule(items);
    const perItem = items.map((it, i) => {
      const itemPlan = buildPlan({ tweets: it.tweets, dryRun: true, maxChars });
      errors.push(...itemPlan.errors.map((e) => `post ${i + 1}: ${e}`));
      return itemPlan;
    });
    if (errors.length) { console.error("VALIDATION ERRORS:", errors.join("; ")); process.exit(2); }

    const totalEstimatedCostUsd = perItem.reduce((s, p) => s + p.estimatedCostUsd, 0);
    if (!args.confirm || args.dryRun) {
      console.log(JSON.stringify({
        wouldSchedule: items.map((it, i) => ({ scheduled_for: it.scheduledFor, tweets: it.tweets, estimatedCostUsd: perItem[i].estimatedCostUsd })),
        totalEstimatedCostUsdAtPostTime: totalEstimatedCostUsd,
      }, null, 2));
      console.error(`NOT SCHEDULING ${items.length} post(s) (${args.dryRun ? "dry-run" : "missing --confirm"}).`);
      return;
    }
    const out = await scheduleClientOrExit().scheduleBulk({ items });
    console.log(JSON.stringify(out, null, 2));
    console.error(`Scheduled ${out.scheduledCount}/${items.length} via vibedraft${out.aborted ? ` — ABORTED EARLY: ${out.abortReason}` : ""}.`);
    if (out.failedCount > 0 || out.aborted) process.exit(1);
    return;
  }

  const plan = buildPlan({ tweets: args.tweets, dryRun: args.dryRun, confirm: args.confirm, hasCreds, image: args.image, video: args.video, maxChars });

  // Schedule path — same explicit gate as posting: --confirm required, dry-run
  // prints the plan and schedules nothing. X creds are NOT required (vibedraft
  // posts through the user's own connected X account). --image/--video are
  // uploaded to vibedraft AFTER the gate and attach to the first tweet at
  // post time (jpg/png/webp ≤5MB, mp4 ≤512MB — validateSchedule enforces).
  if (args.at) {
    const errors = validateSchedule({ tweets: args.tweets, scheduledFor: args.at, image: args.image, video: args.video });
    for (const e of plan.errors) if (!errors.includes(e)) errors.push(e);
    if (errors.length) { console.error("VALIDATION ERRORS:", errors.join("; ")); process.exit(2); }
    const media = args.image || args.video;
    if (!args.confirm || args.dryRun) {
      console.log(JSON.stringify({ wouldScheduleAt: args.at, tweets: args.tweets, ...(media ? { media } : {}), estimatedCostUsdAtPostTime: plan.estimatedCostUsd }, null, 2));
      console.error(`NOT SCHEDULING (${args.dryRun ? "dry-run" : "missing --confirm"}).`);
      return;
    }
    const client = scheduleClientOrExit();
    let mediaId;
    if (media) {
      console.error(`Uploading ${args.video ? "video" : "image"} to vibedraft…`);
      ({ mediaId } = await client.uploadMedia({ filePath: media }));
      console.error(`Uploaded (media_id ${mediaId}) — it attaches to the first tweet at post time.`);
    }
    const rows = await client.schedulePosts({ tweets: args.tweets, scheduledFor: args.at, mediaId });
    console.log(JSON.stringify({ scheduled: rows.map((r) => ({ id: r.id, scheduled_for: r.scheduled_for, status: r.status })), ...(mediaId ? { media_id: mediaId } : {}) }, null, 2));
    console.error(`Scheduled ${rows.length} row(s) via vibedraft — it posts even if this machine is asleep.`);
    return;
  }

  console.log(JSON.stringify(plan, null, 2));
  if (plan.errors.length) { console.error("VALIDATION ERRORS:", plan.errors.join("; ")); process.exit(2); }

  if (!plan.willPost) {
    console.error(`NOT POSTING (${plan.blockedReason}). Estimated cost if posted: $${plan.estimatedCostUsd}.`);
    return;
  }

  const mediaNote = plan.hasVideo ? " with video" : plan.hasImage ? " with image" : "";
  console.error(`Posting ${plan.count} tweet(s)${mediaNote}… estimated cost $${plan.estimatedCostUsd}.`);
  const ids = await postThread(args.tweets, creds, onRotatedToken, args.image, null, args.video);
  console.log(JSON.stringify({ posted: ids, urls: ids.map((id) => `https://x.com/i/web/status/${id}`) }, null, 2));
}

// Run guard. `file://${process.argv[1]}` is WRONG three ways and each one fails silently
// (main never runs, exit 0, no output, nothing posted): a path containing a space compares
// a literal " " against import.meta.url's "%20"; a symlinked install compares the link
// against the resolved target; and on macOS /tmp is itself a symlink to /private/tmp.
// pathToFileURL handles the encoding, realpathSync handles the symlinks.
if (import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
}
