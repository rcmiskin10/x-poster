---
description: "Draft (or take) a tweet/thread, optionally attach an image, score it against a built-in bookmarkability rubric, preview the cost, and post to X — ONLY after you explicitly confirm. Never auto-publishes. X pay-per-use (~$0.015/post, ~$0.20/post-with-URL)."
argument-hint: "<text to post | 'draft a post about X'> [--image <path>]"
allowed-tools: ["Bash", "Read"]
---

# /x-poster:x-post

Turn `$ARGUMENTS` into an X post, gate it, and (only on your explicit OK) post it via the bundled
`x-post.mjs`.

> ⛔ **HARD GATE — never auto-publish.** You MUST present the draft and get an explicit, affirmative
> confirmation ("ship it") in this conversation before any real post. There is no bypass. The bundled
> `x-post.mjs` independently refuses to post without `--confirm` + credentials — that is the backstop,
> not the gate. The gate is you showing the draft and the human approving it.

## Prerequisites (one-time, see README)
- The user has their own X app creds in a writable env file and has minted `X_REFRESH_TOKEN` via
  `x-auth.mjs`. Read the env-file path from `$X_ENV_FILE` (ask the user if unset).

## What this command does

1. **Resolve the input.** `$ARGUMENTS` is either text to post directly, or an instruction to draft
   ("draft a post about …"). If a `--image <path>` is present (or the user references an image),
   resolve it to an absolute path and **Read it to confirm it contains nothing the user wouldn't want
   public** before proceeding. Only one image; it attaches to the first tweet.

2. **Draft / refine (skip if the user gave final text).** Produce a single tweet or a linear thread
   (each tweet ≤280 chars). Score against `${CLAUDE_PLUGIN_ROOT}/config/rubric.md` (aim ≥4/5). If the
   user set `AVOID_SLOP_PATH`, also check that file's rules. If `VOICE_CONFIG_PATH` is set, read it and
   match that voice; otherwise write plainly in the user's own words — do not invent a persona.
   Per X's ranking, keep links OUT of the main post (put them in a reply).

3. **Cost + validation (dry-run, posts nothing):**
   ```bash
   node --env-file="$X_ENV_FILE" "${CLAUDE_PLUGIN_ROOT}/bin/x-post.mjs" \
     --dry-run [--image <abs-path>] --thread "<tweet 1>" "<tweet 2>" ...
   ```
   (Use `--text "<tweet>"` for a single post.) Surface `estimatedCostUsd`, `hasImage`, and any `errors`.

4. **PRESENT + STOP.** Show the full draft (each tweet), the rubric score, whether an image is
   attached, and the estimated cost. Ask: **"Reply 'ship it' to post, or tell me what to change."**
   Do not proceed until the human affirmatively confirms.

5. **Post (only on confirmation).** Set `X_ENV_FILE` so the rotated refresh token is persisted back:
   ```bash
   X_ENV_FILE="$X_ENV_FILE" node --env-file="$X_ENV_FILE" "${CLAUDE_PLUGIN_ROOT}/bin/x-post.mjs" \
     --confirm [--image <abs-path>] --thread "<tweet 1>" "<tweet 2>" ...
   ```
   Report the live URL(s) it returns. If creds are absent, say so and stop at the dry-run.

## Guardrails
- Never post without step 4's explicit confirmation.
- Always show the cost before posting (real money: ~$0.015/post, ~$0.20/post-with-URL).
- Image upload needs the `media.write` scope on the token; if it 403s, the user must enable it on
  their X app and re-mint via `x-auth.mjs`. Pre-flight with `--upload-only <image>` (no post, no cost).
