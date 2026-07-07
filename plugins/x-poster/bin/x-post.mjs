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
//   text only, no media; posts go out through YOUR vibedraft-connected X account):
//   node --env-file=./your.env x-post.mjs --confirm --at 2026-07-08T09:00:00Z --text "..."   # schedule instead of post
//   node --env-file=./your.env x-post.mjs --list-scheduled [--status pending]                # list rows (posted → posted_tweet_id)
//   node --env-file=./your.env x-post.mjs --cancel <id>                                      # cancel a pending row

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { buildPlan, postThread, uploadMedia, refreshAccessToken, persistRefreshToken, resolveMaxChars } from "./_poster.mjs";
import { resolveVibedraftConfig, validateSchedule, makeScheduleClient } from "./_scheduler.mjs";

// ---- CLI entry (only when run directly, not when imported by tests) ----
export function parseArgs(argv) { // exported for core/_tests/surface-parity.test.mjs
  const out = { dryRun: false, confirm: false, tweets: [], image: undefined, video: undefined, uploadOnly: false, at: undefined, listScheduled: false, status: undefined, since: undefined, cancel: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--confirm") out.confirm = true;
    else if (a === "--image") out.image = argv[++i];
    else if (a === "--video") out.video = argv[++i];
    else if (a === "--upload-only") { out.uploadOnly = true; out.image = argv[++i]; } // upload media, print id, no post
    else if (a === "--at") out.at = argv[++i]; // schedule via vibedraft instead of posting now
    else if (a === "--list-scheduled") out.listScheduled = true;
    else if (a === "--status") out.status = argv[++i];
    else if (a === "--since") out.since = argv[++i];
    else if (a === "--cancel") out.cancel = argv[++i];
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

  const maxChars = resolveMaxChars(process.env.X_MAX_TWEET_CHARS);
  const plan = buildPlan({ tweets: args.tweets, dryRun: args.dryRun, confirm: args.confirm, hasCreds, image: args.image, video: args.video, maxChars });

  // Schedule path — same explicit gate as posting: --confirm required, dry-run
  // prints the plan and schedules nothing. X creds are NOT required (vibedraft
  // posts through the user's own connected X account). Media is rejected by
  // validateSchedule (the API's v1 has no upload endpoint).
  if (args.at) {
    const errors = [
      ...validateSchedule({ tweets: args.tweets, scheduledFor: args.at, image: args.image, video: args.video }),
      ...plan.errors,
    ];
    if (errors.length) { console.error("VALIDATION ERRORS:", errors.join("; ")); process.exit(2); }
    if (!args.confirm || args.dryRun) {
      console.log(JSON.stringify({ wouldScheduleAt: args.at, tweets: args.tweets, estimatedCostUsdAtPostTime: plan.estimatedCostUsd }, null, 2));
      console.error(`NOT SCHEDULING (${args.dryRun ? "dry-run" : "missing --confirm"}).`);
      return;
    }
    const rows = await scheduleClientOrExit().schedulePosts({ tweets: args.tweets, scheduledFor: args.at });
    console.log(JSON.stringify({ scheduled: rows.map((r) => ({ id: r.id, scheduled_for: r.scheduled_for, status: r.status })) }, null, 2));
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

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
}
