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
- **`auth_instructions`** — returns the step-by-step command to mint a refresh token.

Cost: ~$0.015/post, ~$0.20/post-with-URL (X pay-per-use, billed to your own X app).

---

## Why it's basically free

x-poster doesn't run its own AI. The drafting happens inside *your* Claude Code session, so it's
covered by the Claude subscription you already pay for. The plugin itself calls no API and costs you
nothing. The only charge is X's own pay-per-use posting (~$0.015 a post), billed to your own X app.

You bring: a Claude Code subscription you already have, and a free X developer app. That's it.

## What it does

- **Draft by talking.** `/x-poster:x-post draft a post about what I shipped today` gives you a tweet
  in your voice. Or hand it final text and it posts that verbatim.
- **Single tweet, thread, or image.** Linear threads and one image (via X's v2 media upload).
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

## Install as a connector (Claude Desktop, Claude Code, or MCP-for-Windows)

The `.mcpb` bundle format works in **Claude Desktop, Claude Code, and MCP-for-Windows** — it is not
Desktop-only.

**Option A — use the pre-built bundle** (if `x-poster.mcpb` is present in this repo):
1. Drag `x-poster.mcpb` into Claude settings → Extensions (Desktop) / Connectors (Code), or
   double-click it.
2. Enter `X_CLIENT_ID`, `X_CLIENT_SECRET`, and `X_REFRESH_TOKEN` when prompted. These are stored
   in the OS keychain — you will not be asked again.

**Option B — build it yourself:**
```bash
cd _packages/x-poster
bash scripts/build-mcpb.sh          # outputs x-poster.mcpb
```
Then drag or double-click to install as above.

**What you enter at install time is the SEED** (see token rotation warning below).

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

## 1. Create your own X app

At [developer.x.com](https://developer.x.com), create a project/app, then in **User authentication
settings**:

- App type: **Web App / Confidential client**
- Add this **exact** callback URL: `http://127.0.0.1:8723/callback`
  (If port 8723 is taken, pick another, set `X_AUTH_PORT`, and register the matching URL.)
- Scopes: `tweet.read tweet.write users.read media.write offline.access`
  - `media.write` is **required** for image upload.
  - `offline.access` is **required** to receive a refresh token.
- Copy the app's **Client ID** and **Client Secret**.

## 2. Mint your refresh token (one time)

```bash
node --env-file=./x-poster.env bin/x-auth.mjs
```

A browser opens — click **Authorize**. The script prints `X_REFRESH_TOKEN=…`. Paste that line into
your env file. The token stays on your machine; nothing is committed.

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
- **If you delete or lose the state file, you must re-mint your refresh token** by re-running
  `bin/x-auth.mjs` and updating `X_REFRESH_TOKEN` in your env / keychain.
- **Do not run two posting sessions against the same seed concurrently.** The second post will burn
  the same token the first just rotated away, causing a 401.

---

## What it is NOT

- Not an autoposter. There is no "post while I sleep" mode, by design. The human gate is the point,
  and it's also what keeps it free (an always-on version would bill the API, not your subscription).
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
