# x-poster

**Post to X without leaving Claude Code. Just say what you're thinking.**

You're deep in a build session. A thought lands. A realization, a hot take, the thing you just
figured out. Normally it dies in the terminal, or in a notes file you never reopen.

x-poster gives that thought a mouth. You talk to Claude like you already do. It drafts the tweet in
your voice, shows you the cost, and posts only when you say "ship it."

No browser tab. No context switch. No autospam.

---

## What's new: MCP connector

The same posting capability is now available as MCP tools — usable in both **Claude Desktop** and
**Claude Code** (and MCP-for-Windows). Two tools surface the never-auto-publish contract at the
protocol level:

- **`preview_post`** — always call this first. Pure, zero network I/O. Returns a cost estimate and
  a `confirm_nonce` valid for 10 minutes.
- **`publish_post`** — the only writer. Recomputes cost server-side, then either uses MCP
  elicitation (if the client supports it) or requires the `confirm_nonce` from `preview_post`.
  Nothing posts without an explicit confirmation step.
- **`authorize`** — one-time account connection, right in the chat: it returns a link, you click
  Authorize on X, done. No terminal, no scripts.
- **`auth_instructions`** — setup help (the X-app checklist and auth options).

Cost: ~$0.015/post, ~$0.20/post-with-URL — X pay-per-use, billed to your own X app (set daily and
monthly caps in the X developer portal). Drafting is covered by your Claude subscription.

---

## What it costs

Two sides to the bill — one you already pay, one is small but real:

- **The AI side: covered by your Claude subscription.** x-poster doesn't run its own AI. Drafting
  happens inside *your* Claude Code session, so it's covered by the Claude subscription you already
  pay for — no separate AI API billing.
- **The posting side: X pay-per-use, billed to your own X app.** Roughly **$0.015 (about a cent and
  a half) per post**, and **~$0.20 per post that contains a URL**. This is X's pricing, not ours —
  you bring your own X developer app and the charges go straight to it. Every post shows you its
  estimated cost *before* you confirm, and with no credentials the poster cannot spend at all.
- **Set spending caps.** In the X developer portal you can set **daily and monthly spend limits**
  on your app, so a runaway bill is structurally impossible.

The software itself is open source (MIT) — no service fee, no hosted middleman.

You bring: a Claude Code subscription you already have, and your own pay-per-use X developer app.

## What it does

- **Draft by talking.** `/x-poster:x-post draft a post about what I shipped today` gives you a tweet
  in your voice. Or hand it final text and it posts that verbatim.
- **Single tweet, thread, image, or video.** Linear threads, one image (via X's v2 media upload),
  or one `.mp4` video (via X's chunked upload API — INIT → APPEND → FINALIZE → STATUS poll).
  Image and video are mutually exclusive. Note: X may reject silent video; mux an audio track first
  (`ffmpeg -i in.mp4 -f lavfi -i anullsrc=r=44100:cl=stereo -c:v copy -c:a aac -shortest out.mp4`).
- **Long-form ready.** Character count doesn't block posting — long-form (X Premium) content works
  out of the box, and X enforces your account's real limit at publish. Set `X_MAX_TWEET_CHARS=280`
  if you'd rather keep the classic limit enforced locally.
- **Cost preview before you spend.** Every draft is dry-run priced and character-checked first.
- **A hard never-auto-publish gate.** Nothing leaves your machine until you confirm. With no
  credentials the poster refuses to post at all, so a bare run literally cannot spend.
- **Your voice, your rules.** Point it at your own voice file and your own banned-phrase list.
- **Token hygiene built in.** OAuth2-PKCE bootstrap, refresh-token rotation persisted for you.

## Who it's for

Indie hackers vibing in Claude Code who have good thoughts mid-build and want them out in the world
the moment they land, without breaking flow to open X, write, and post. If your best material dies
in the terminal, this is for you.

---

## Set up in ~5 minutes — no terminal needed

Three steps, all in your browser and Claude. This is the recommended path for everyone.

### Step 1 — Create your X app

This is the only fiddly part, and it's a one-time copy-paste exercise. Signing up costs nothing;
posting bills your app pay-per-use (~$0.015/post — see [What it costs](#what-it-costs)).

1. Go to [developer.x.com](https://developer.x.com), sign in with your X account, and create a
   Project + App on the pay-per-use plan. While you're there, set **daily and monthly spend caps**
   on the app so your bill has a hard ceiling.
2. Open your app's **User authentication settings** → **Edit** and enter exactly:

   | Setting | Value |
   |---|---|
   | App permissions | **Read and write** |
   | Type of App | **Web App, Automated App or Bot** (confidential client) |
   | Callback URI / Redirect URL | `http://127.0.0.1:8723/callback` |
   | Website URL | anything, e.g. your X profile URL |

   If your portal shows a scopes picker, enable: `tweet.read`, `tweet.write`, `users.read`,
   `media.write` (image upload), `offline.access` (stay signed in).

3. Save, then copy the **Client ID** and **Client Secret** it shows you (Keys and tokens tab).
   Keep them somewhere safe for the next step.

### Step 2 — Install the connector

The `.mcpb` bundle **is** the Claude Desktop connector (a.k.a. a Desktop Extension) — a single file
that carries the server code and its dependencies. Installing it adds x-poster to Claude Desktop's
**Settings → Connectors / Extensions**.

1. Download `x-poster-<version>.mcpb` from the
   [latest release](https://github.com/rcmiskin10/x-poster/releases/latest).
2. Install it into **Claude Desktop**: double-click the file, or open Claude Desktop →
   **Settings → Extensions / Connectors → Install from file** and pick the `.mcpb`.
3. Paste the **Client ID** and **Client Secret** when prompted. **Leave the Refresh Token field
   blank.** They're stored in your OS keychain — you won't be asked again.

> On **Claude Code**? Skip the `.mcpb` and use the plugin instead — see
> [Use in Claude Code via the plugin](#use-in-claude-code-via-the-plugin).

### Step 3 — Connect your X account (in the chat)

Tell Claude:

> authorize x-poster

It replies with a link. Open it, click **Authorize app**, and you'll see "Authorized ✓ — you can
close this tab." That's it. Now try:

> post a tweet: hello from x-poster

Claude previews the post and the cost first, and nothing publishes until you say yes.

**Building the bundle yourself instead:** `bash scripts/build-mcpb.sh` outputs `x-poster.mcpb`;
install it the same way.

---

## Posting: text, threads, images & video

Once you're connected, you post the same four shapes from any surface — in chat (the Claude Desktop
connector / MCP tools), the Claude Code plugin, or the terminal CLI. **Every path previews the
content and cost first and never publishes until you confirm.**

### In chat (Claude Desktop connector or Claude Code)

Describe the post; Claude calls `preview_post` (shows the plan + cost), and only after you say yes,
`publish_post`. Both tools accept:

| Field | Meaning |
|---|---|
| `text` | a single tweet |
| `thread` | an array of tweets posted as a linear thread (use instead of `text`) |
| `image` | absolute path to one image; attaches to the first tweet |
| `video` | absolute path to one `.mp4`; attaches to the first tweet. **Mutually exclusive with `image`.** |
| `in_reply_to` | id of a tweet to reply to (optional) |

Things you can just say to Claude:

> post a tweet: shipped video upload today 🎬
>
> post a thread: (1) the bug that ate my morning … (2) the one-line fix
>
> post "new demo" with the video at /Users/me/clips/demo.mp4
>
> post "before / after" with the image /Users/me/Desktop/shot.png

### Terminal CLI (`x-post.mjs`)

Pass your env file explicitly with `--env-file`; nothing is read implicitly. `--dry-run` (the default
when no credentials are present) validates and prices without posting — a real post needs **both**
`--confirm` and credentials.

```bash
# single tweet
node --env-file=./x-poster.env x-post.mjs --confirm --text "shipped video upload today 🎬"

# thread (each quoted arg is one tweet)
node --env-file=./x-poster.env x-post.mjs --confirm --thread "tweet 1" "tweet 2 with a link"

# image (one file, attaches to the first tweet)
node --env-file=./x-poster.env x-post.mjs --confirm --image ./shot.png --text "before / after"

# video (.mp4; mutually exclusive with --image)
node --env-file=./x-poster.env x-post.mjs --confirm --video ./demo.mp4 --text "new demo"

# preview only — validate + price, post nothing
node --env-file=./x-poster.env x-post.mjs --dry-run --thread "draft 1" "draft 2"
```

Flags: `--text` · `--thread <t1> <t2> …` · `--image <path>` · `--video <path>` · `--confirm` ·
`--dry-run` · `--upload-only <image>` (upload media, print its id, post nothing).

### Scheduling for later (via vibedraft)

If you use [vibedraft](https://vibedraft.app), x-poster can hand a post to its scheduler instead of
posting immediately — the vibedraft cron fires it at the chosen time **even if your machine is
asleep**, through *your* vibedraft-connected X account (cost billed there, not to this app's keys).
Text and threads only — no media in v1. Setup: create a token in vibedraft under **Settings → API
tokens** and add `VIBEDRAFT_API_URL` + `VIBEDRAFT_API_TOKEN` to the same env file.

In chat, the flow mirrors posting: `preview_post` first, then — after you say "ship it at 9am" —
`schedule_post` (same content-frozen confirmation gate). `list_scheduled` shows your queue (posted
rows include `posted_tweet_id`); `cancel_scheduled` cancels a pending row.

```bash
# schedule instead of posting now (same --confirm gate; --dry-run schedules nothing)
node --env-file=./x-poster.env x-post.mjs --confirm --at 2026-07-08T09:00:00Z --text "..."

# list scheduled rows (add --status pending/posted/… or --since <ISO>)
node --env-file=./x-poster.env x-post.mjs --list-scheduled --status pending

# cancel a pending row before it fires
node --env-file=./x-poster.env x-post.mjs --cancel <id>
```

Note: vibedraft nudges `scheduled_for` by ±a few minutes (per your vibedraft humanization setting),
so the stored time may differ slightly from what you asked for. That's a feature.

### Bulk scheduling — up to 20 posts in one confirmed action

Draft a week of content, schedule it all at once. Each item is an independent post (or 2-6-tweet
thread) at **its own time** — `{text|thread, scheduled_for, in_reply_to?}`, max **20 per call**.
Text only, same as single scheduling. Times must be ISO 8601 **with an explicit offset or `Z`**
(stricter than single scheduling on purpose — 20 posts silently landing an hour off is the bulk
footgun).

In chat: `preview_bulk` shows every post, its time, per-item + total cost, and mints one
`confirm_nonce` for the whole batch; after you say "ship it", `schedule_bulk` submits. The nonce
freezes the batch **content** (you can still adjust times between preview and confirm); validation
is all-or-nothing — one invalid item and nothing submits.

```bash
# CLI flavor: a JSON file of posts; without --confirm it's a dry-run that schedules nothing
node --env-file=./x-poster.env x-post.mjs --bulk ./posts.json
node --env-file=./x-poster.env x-post.mjs --confirm --bulk ./posts.json
```

```json
{ "posts": [
  { "text": "monday 9am post", "scheduled_for": "2026-07-13T09:00:00-07:00" },
  { "thread": ["tuesday thread 1/2", "2/2"], "scheduled_for": "2026-07-14T09:00:00-07:00" }
] }
```

Submission is item-by-item (the vibedraft API takes one post/thread per call), so a batch can
**partially succeed**: the result lists per-item statuses — `scheduled` (with ids), `failed`,
`skipped` (batch aborted early on a fatal error like a revoked token), or `unknown` (network blip;
check `list_scheduled` before resubmitting — never blind-retry). Recovery is surgical:
`cancel_scheduled <id>` removes anything you didn't want, and re-running with only the failed items
finishes the job. Two practical notes: jitter applies per post, so keep items ≥30 min apart if
posting order matters, and vibedraft caps pending posts at 720 per account.

### The one video gotcha — silent clips

X's transcoder can **reject a video with no audio track**. Screen recordings are often silent, so if
a video post fails during processing, mux in a silent stereo track and post the muxed file:

```bash
ffmpeg -i in.mp4 -f lavfi -i anullsrc=r=44100:cl=stereo -c:v copy -c:a aac -shortest out.mp4
```

### Media notes

- **One** media item per post — one image **or** one video — attached to the **first** tweet.
- Video is `.mp4` (H.264 video / AAC audio), up to X's per-account limit (longer on Premium). Large
  files upload in chunks automatically (`initialize → append → finalize → status`).
- Uploading media needs the `media.write` scope on your token (enabled in Step 1).

---

## Use in Claude Code via the plugin

The plugin auto-registers the MCP server via `.mcp.json`; no `claude mcp add` needed. A
`SessionStart` hook installs the MCP SDK to `${CLAUDE_PLUGIN_DATA}/node_modules` on first launch
(needs network once; subsequent launches use the local cache).

**Credentials for the plugin MCP server.** The plugin has no GUI, so supply creds one of two ways:

- Set `X_ENV_FILE=/abs/path/to/x-poster.env` (the same file the `/x-poster:x-post` slash command
  uses). The MCP server reads it at startup.
- Or export `X_CLIENT_ID`, `X_CLIENT_SECRET`, `X_REFRESH_TOKEN` in your shell before launching
  Claude Code.

`process.env` always wins over the env file if both are present.

**Manual fallback** (if the plugin path is unavailable):
```bash
claude mcp add x-poster \
  -e X_ENV_FILE=/abs/path/x-poster.env \
  -- node /abs/path/_packages/x-poster/mcp/server.mjs
```

---

## The slash command (unchanged)

```bash
/plugin marketplace add rcmiskin10/x-poster
/plugin install x-poster@x-poster
```

Then a one-time setup: create your own X app, mint a refresh token, and point the plugin at your env
file with `/plugin configure x-poster`. Full steps in
[plugins/x-poster/README.md](plugins/x-poster/README.md), about 5 minutes.

```
/x-poster:x-post draft a post about the bug I just killed
```

It drafts, scores against a built-in bookmarkability rubric, dry-runs the cost, and asks "ship it?"
Nothing posts until you say so.

---

## CLI alternative: mint the refresh token in a terminal

Prefer env files over the in-chat `authorize` tool (e.g. for the slash-command path)? Same X app
as Step 1 above, then:

```bash
node --env-file=./x-poster.env bin/x-auth.mjs
```

A browser opens — click **Authorize**. The script prints `X_REFRESH_TOKEN=…`. Paste that line into
your env file. The token stays on your machine; nothing is committed.

(If port 8723 is taken, pick another, set `X_AUTH_PORT`, and register the matching callback URL.)

---

## ⚠️ Token rotation — read this before you start

X refresh tokens are **single-use and rotate**. Every post consumes the current token and X issues a
new one. x-poster persists the rotated token to a local state file so you are never locked out. The
resolution order for the state file is:

1. `X_STATE_FILE` env var (if set)
2. `${CLAUDE_PLUGIN_DATA}/token` (Claude Code plugin path)
3. `~/.local/state/x-poster/token` (XDG default)

**What this means in practice:**

- The `X_REFRESH_TOKEN` value you enter at install time (keychain) or in your env file is a
  **one-time seed**. After the first post, the live token lives in the state file — not the keychain
  or the env file.
- **If you delete or lose the state file, just re-connect**: run the `authorize` tool again (or
  re-run `bin/x-auth.mjs` and update `X_REFRESH_TOKEN` in your env / keychain).
- **Do not run two posting sessions against the same seed concurrently.** The second post will burn
  the same token the first just rotated away, causing a 401.

---

## What it is NOT

- Not an autoposter. There is no "post while I sleep" mode, by design. The human gate is the point,
  and it's also what keeps the AI side on your Claude subscription (an always-on version would bill
  the Claude API on top of X's per-post charges).
- Not a growth-hack bot. One thought, one confirmation, one post.
- Not a hosted service. It runs on your machine, with your keys, on your subscription.

## How it works

Three pieces, cleanly split:

- **Core** (`core/poster.mjs`, `core/token-store.mjs`): zero-dependency Node. OAuth, posting,
  threads, image upload, dry-run cost, token rotation. Calls no AI. Vendored byte-for-byte into
  every surface by `scripts/vendor-core.sh`; drift is caught by CI.
- **MCP server** (`mcp/server.mjs`): MCP stdio server. Exports `makeTools` (pure, testable),
  `makePostAdapter`, `startServer`. Requires `@modelcontextprotocol/sdk` (isolated to `mcp/`).
- **Plugin payload** (the `/x-poster:x-post` command): runs in your Claude session, does the
  drafting and scoring. This is where the "just by talking" comes from.

That split is why your subscription covers the smart part and the tool costs nothing to run.

## License

[MIT](LICENSE).
