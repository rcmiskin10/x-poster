---
description: "Draft (or take) a tweet/thread, optionally attach an image, score it against a built-in bookmarkability rubric, preview the cost, and post to X — ONLY after you explicitly confirm. Never auto-publishes. X pay-per-use (~$0.015/post, ~$0.20/post-with-URL)."
argument-hint: "<text to post | 'draft a post about X'> [--image <path>] [--reply-to <tweet-id>]"
allowed-tools: ["Read", "Bash", "mcp__x-poster__preview_post", "mcp__x-poster__publish_post", "mcp__x-poster__authorize", "mcp__x-poster__auth_instructions"]
---

# /x-poster:x-post

Turn `$ARGUMENTS` into an X post via the x-poster MCP tools. Announce each step with its
one-line emoji status so the user always knows where the workflow is.

> ⛔ **HARD GATE — never auto-publish.** Present the preview and get an explicit, affirmative
> confirmation ("ship it") in this conversation before calling `publish_post`. No bypass.
> The server's nonce/elicitation check is the backstop, not the gate.

## Step 0 — route (decide deterministically, announce it)

- `$ARGUMENTS` contains final text (quoted, or "post this …") → `📋 route: fast — verbatim text, skipping draft + rubric`
- `$ARGUMENTS` is an instruction ("draft a post about …") → `📋 route: draft`

LLM work happens ONLY on the draft route (and the image screen). Everything else is plumbing —
do not editorialize, score, or reformat on the fast route.

## Steps

1. `📝 resolve` — extract the text/thread, reply target (`--reply-to` or "reply to <id>"), and
   image path. If an image is given: Read it and confirm it contains nothing the user wouldn't
   want public. One image max; it attaches to the first tweet.

2. `✍️ draft` — **draft route only.** Single tweet or linear thread, each ≤280 chars. Score
   against `${CLAUDE_PLUGIN_ROOT}/config/rubric.md` (aim ≥4/5); honor `AVOID_SLOP_PATH` and
   `VOICE_CONFIG_PATH` if set, otherwise write plainly in the user's own words. Keep links OUT
   of the main post (put them in a reply).

3. `🔍 preview` — call `preview_post` (with `in_reply_to` for replies). **Relay its `render`
   block to the user VERBATIM — do not reformat it.** If `errors` is non-empty, stop and fix.

4. `🚦 gate` — STOP. Wait for an explicit affirmative ("ship it"). Anything else is feedback:
   apply it and re-preview (the nonce is payload-bound — any change needs a fresh preview).

5. `🚀 publish` — call `publish_post` with the SAME payload + the `confirm_nonce` from step 3.
   Relay its `render` block verbatim.

If a tool fails with "not connected", run `authorize`, present the link, then resume at step 3.

## Fallback — MCP server unavailable

Use the bundled CLI: `node --env-file="$ENV_FILE" "${CLAUDE_PLUGIN_ROOT}/bin/x-post.mjs" --dry-run …`
to preview, then `--confirm` to post (after the same gate), where
`ENV_FILE="${CLAUDE_PLUGIN_OPTION_ENV_FILE:-$X_ENV_FILE}"` and `X_ENV_FILE="$ENV_FILE"` is also
exported on the posting call so rotated tokens persist. Flags: `--text "<tweet>"` or
`--thread "<t1>" "<t2>" …`, `--image <abs-path>`. Same gate, same rules. (Replies are
MCP-only — the CLI has no `--reply-to`.)

## Guardrails

- Never post without step 4's explicit confirmation.
- Always surface the cost before posting (real money: ~$0.015/post, ~$0.20/post-with-URL).
- Image upload needs the `media.write` scope; on 403, the user must enable it on their X app
  and re-run `authorize`.
