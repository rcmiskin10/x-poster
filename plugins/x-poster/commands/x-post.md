---
description: "Draft (or take) a tweet/thread, optionally attach an image, score it against a built-in bookmarkability rubric, preview the cost, and post to X — ONLY after you explicitly confirm. Never auto-publishes. Can also SCHEDULE for later via vibedraft (single posts may carry one image or mp4 video; bulk is text-only), including BULK-scheduling up to 20 posts in one confirmed action. X pay-per-use (~$0.015/post, ~$0.20/post-with-URL)."
argument-hint: "<text to post | 'draft a post about X' | 'draft N posts about X and schedule them across the week'> [--image <path>] [--video <path>] [--reply-to <tweet-id>] [--at <ISO time | 'tomorrow 9am'>]"
allowed-tools: ["Read", "Bash", "mcp__x-poster__preview_post", "mcp__x-poster__publish_post", "mcp__x-poster__preview_bulk", "mcp__x-poster__schedule_bulk", "mcp__x-poster__schedule_post", "mcp__x-poster__list_scheduled", "mcp__x-poster__cancel_scheduled", "mcp__x-poster__authorize", "mcp__x-poster__auth_instructions"]
---

# /x-poster:x-post

Turn `$ARGUMENTS` into an X post via the x-poster MCP tools. Announce each step with its
one-line emoji status so the user always knows where the workflow is.

> ⛔ **HARD GATE — never auto-publish.** Present the preview and get an explicit, affirmative
> confirmation ("ship it" / "ship it at 9am") in this conversation before calling `publish_post`
> or `schedule_post`. No bypass. The server's nonce/elicitation check is the backstop, not the gate.

## Step 0 — route (decide deterministically, announce it)

- `$ARGUMENTS` contains final text (quoted, or "post this …") → `📋 route: fast — verbatim text, skipping draft + rubric`
- `$ARGUMENTS` is an instruction ("draft a post about …") → `📋 route: draft`
- A future time is named (`--at`, "at 9am", "tomorrow", "schedule for …") → add `📅 mode: schedule`
  to the route line. A scheduled post may carry ONE image (jpg/png/webp ≤ 5 MB) or mp4 video
  (≤ 512 MB) — pass `image`/`video` to `schedule_post`; the file uploads to vibedraft AFTER the
  gate, so a declined draft never spends an upload.
- MULTIPLE independent posts with times ("draft 5 posts and schedule them across the week",
  "schedule these 10, one per morning") → `📅 mode: bulk-schedule` (max 20 per batch). Bulk is
  TEXT-ONLY (items carrying media are rejected loudly — never silently drop media to make a batch
  work; say so and ask). Compute each post's concrete time yourself: resolve the user's spacing
  intent ("3/day at 9am/1pm/6pm starting tomorrow") to per-post ISO 8601 timestamps **with the
  user's local UTC offset** — the tools reject offset-less times. Keep items ≥30 min apart when
  posting order matters (vibedraft jitters each post ±a few min independently).

LLM work happens ONLY on the draft route (and the image screen). Everything else is plumbing —
do not editorialize, score, or reformat on the fast route.

## Steps

1. `📝 resolve` — extract the text/thread, reply target (`--reply-to` or "reply to <id>"),
   image/video path, and any scheduled time (resolve relative phrases like "tomorrow 9am" to an
   ISO 8601 timestamp in the user's local timezone; must be >2 min and <30 days out). If an image
   is given: Read it and confirm it contains nothing the user wouldn't want public. One image max;
   media attaches to the first tweet.

2. `✍️ draft` — **draft route only.** Single tweet or linear thread, each ≤280 chars. Score
   against `${CLAUDE_PLUGIN_ROOT}/config/rubric.md` (aim ≥4/5); honor `AVOID_SLOP_PATH` and
   `VOICE_CONFIG_PATH` if set, otherwise write plainly in the user's own words. Keep links OUT
   of the main post (put them in a reply).

3. `🔍 preview` — call `preview_post` (with `in_reply_to` for replies). **Relay its `render`
   block to the user VERBATIM — do not reformat it.** If `errors` is non-empty, stop and fix.
   In schedule mode, state the resolved fire time alongside the preview.

4. `🚦 gate` — STOP. Wait for an explicit affirmative ("ship it" / "ship it at 9am"). Anything
   else is feedback: apply it and re-preview (the nonce is payload-bound — any change needs a
   fresh preview). The user naming a NEW time is not a content change — no re-preview needed.

5. `🚀 publish` **or** `📅 schedule` — with the SAME payload + the `confirm_nonce` from step 3:
   - post now → `publish_post`
   - schedule mode → `schedule_post` with `scheduled_for` (the confirmed time) and the same
     `image`/`video` from the preview (the nonce binds media both directions — a text-only nonce
     can't schedule with media, and vice versa). Media uploads to vibedraft now and attaches to
     the first tweet at fire time. vibedraft's cron posts it at that time even if this machine is
     asleep; the stored time may shift ±a few minutes (deliberate humanization).
   Relay the `render` block verbatim either way.

### Bulk-schedule mode (steps 3-5 replaced)

3. `🔍 preview` — call `preview_bulk` with the full batch: `posts: [{text|thread, scheduled_for,
   in_reply_to?}]` (1-20 items, each at its own offset-bearing ISO time). Relay `render` VERBATIM
   — it lists every post, its time, per-item + total cost. If `errors` is non-empty, fix and
   re-preview; validation is all-or-nothing (one bad item blocks the whole batch, nothing submits).
4. `🚦 gate` — STOP. One explicit confirmation covers the whole batch. Content edits need a fresh
   preview (the nonce freezes batch content); moving TIMES alone does not.
5. `📅 schedule` — `schedule_bulk` with the SAME posts + the batch `confirm_nonce`. Relay `render`
   verbatim. It reports per-item results: on partial failure, tell the user exactly what was
   scheduled (with ids) vs failed/skipped, and offer `cancel_scheduled <id>` or a retry batch of
   only the failed items. An `unknown` item means a network blip — check `list_scheduled` BEFORE
   resubmitting it (never blind-resubmit).

Managing the queue (no gate — read-only / safe direction):
- "what's scheduled?" → `list_scheduled` (posted rows include `posted_tweet_id`).
- "cancel <id> / cancel that" → `cancel_scheduled` (pending rows only; canceling any thread
  member cancels the whole thread).

If a tool fails with "not connected", run `authorize`, present the link, then resume at step 3.
If `schedule_post` fails with "VIBEDRAFT_API_URL and VIBEDRAFT_API_TOKEN", the user must create a
token in vibedraft (Settings → API tokens) and add both vars to the env file `X_ENV_FILE` points at.

## Fallback — MCP server unavailable

Use the bundled CLI: `node --env-file="$ENV_FILE" "${CLAUDE_PLUGIN_ROOT}/bin/x-post.mjs" --dry-run …`
to preview, then `--confirm` to post (after the same gate), where
`ENV_FILE="${CLAUDE_PLUGIN_OPTION_ENV_FILE:-$X_ENV_FILE}"` and `X_ENV_FILE="$ENV_FILE"` is also
exported on the posting call so rotated tokens persist. Flags: `--text "<tweet>"` or
`--thread "<t1>" "<t2>" …`, `--image <abs-path>`. Scheduling: `--at <ISO>` (with `--confirm`; may
carry `--image` or `--video`), `--bulk <posts.json>` (up to 20 posts, each with its own
`scheduled_for`; text-only; dry-run without `--confirm`), `--list-scheduled [--status <s>]`,
`--cancel <id>`. Same gate, same rules. (Replies are MCP-only — the CLI has no `--reply-to`.)

## Guardrails

- Never post OR schedule without step 4's explicit confirmation.
- Always surface the cost before posting (real money: ~$0.015/post, ~$0.20/post-with-URL —
  scheduled posts bill the same at fire time, via the user's vibedraft-connected X app).
- Bulk scheduling is text-only — never silently drop media to make a batch work; ask. A single
  scheduled post takes one image (≤ 5 MB) or mp4 video (≤ 512 MB).
- Image upload needs the `media.write` scope; on 403, the user must enable it on their X app
  and re-run `authorize`.
- The ≤280 is *drafting* guidance only; the publish path no longer blocks on character count
  (long-form works, X enforces the real limit). Set `X_MAX_TWEET_CHARS=280` to re-impose a local cap.
