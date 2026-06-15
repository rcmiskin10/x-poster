# Changelog

## 1.4.1
- **Fix the most common install failure: `X_AUTH_PORT` is now configurable from the `.mcpb` install
  dialog.** If port 8723 was already in use, Desktop/connector users had no GUI way to change it.
  It's now an optional install field (default 8723) with a note that you must register the matching
  `http://127.0.0.1:<port>/callback` in your X app. Hardened the port parsing so a blank value
  (what an unset optional field injects) correctly falls back to 8723 instead of binding a random
  port — which would have silently broken the authorize callback.
- **Friendlier oversized-image error.** Attaching an image over X's limit (5 MB photos / 15 MB GIF)
  now fails before upload with "image is too large… resize or compress it, or post without the
  image" instead of an opaque HTTP 400.
- **Install dialog reminds you to authorize.** The Client ID field now says to ask Claude to
  "authorize x-poster" after installing.
- Tests: blank-string credential normalization and the missing-creds fast-fail are now covered at
  the live-process level (the server exits with an actionable message, never an opaque crash).

## 1.4.0
- **Deterministic step dashboard.** `preview_post` and `publish_post` now return a `render`
  block — a server-formatted emoji step tracker (resolve → validate → gate → publish) with the
  draft, char counts, cost, and (after posting) live URLs. Clients relay it verbatim, so the
  workflow display is identical every run and the model never reformats preview data.
- **MCP-first `/x-post` command.** The slash command routes through the MCP tools instead of
  the bundled CLI; the CLI remains as a documented fallback. New deterministic route rule:
  verbatim text takes a fast path (no drafting, no rubric — straight to preview), and LLM work
  happens only on the draft route. Each step announces itself with a one-line emoji status.
- Replies (`in_reply_to`) documented as MCP-only; the CLI has no `--reply-to` flag.

## 1.3.0
- **No-terminal setup: new `authorize` MCP tool.** Connecting your X account no longer requires
  cloning the repo, creating an env file, or running `bin/x-auth.mjs`. Ask Claude to authorize,
  click the link it returns, approve on X — the localhost callback exchanges the code and persists
  the refresh token automatically. The `.mcpb` refresh-token field is now optional (leave it blank).
- The OAuth-PKCE flow moved to `core/auth.mjs` (single source of truth, vendored like the rest of
  core); `bin/x-auth.mjs` now consumes it and remains as the CLI alternative.
- Friendlier failure: publishing before authorizing now says "run the authorize tool" instead of
  surfacing an opaque OAuth error. Token-store creates its state directory on first persist
  (fresh installs no longer need a pre-existing `~/.local/state/x-poster/`).

## 1.2.1
- Fix: the MCP server crashed at startup ("inputSchema must be a Zod schema or raw shape"),
  surfacing in clients as `MCP error -32000: Connection closed`. `registerTool` was passed plain
  JSON Schema objects, which `@modelcontextprotocol/sdk` 1.29 rejects — tool inputs are now zod
  raw shapes (`zod` added as an explicit pinned dependency). Caught by a new live stdio handshake
  test (`mcp/_tests/stdio.test.mjs`); the prior tests exercised handlers directly and never hit
  the registration layer.

## 1.2.0
- Add an **MCP server** so x-poster works as a Claude Desktop connector and directly inside Claude
  Code, alongside the existing `/x-poster:x-post` CLI command. Two tools with a safety gate:
  `preview_post` (network-free — returns the post plan + API cost estimate + a confirmation nonce)
  and `publish_post` (the only writer — recomputes cost server-side and confirms via MCP
  elicitation, or a payload-bound TTL'd HMAC nonce for clients without elicitation support).
- Bundle the MCP server into the plugin (`.mcp.json` + `bin/x-mcp.mjs`) and ship a one-click `.mcpb`
  bundle (`mcpb/manifest.json`) for Claude Desktop / Code install. Bring your own X app; the server
  never auto-publishes.
- Extract the posting/auth logic into a zero-dep `core/` (single source of truth) consumed by the
  CLI, the plugin, and the `.mcpb` via committed byte-identical vendored copies, guarded by a
  drift test (`scripts/vendor-core.sh`).

## 1.1.0
- Add `env_file` plugin userConfig: set your credentials env-file path once via
  `/plugin configure x-poster` (or `--config env_file=...` at install) instead of exporting
  `X_ENV_FILE` by hand. The command resolves the path as
  `${CLAUDE_PLUGIN_OPTION_ENV_FILE:-$X_ENV_FILE}`, so existing `X_ENV_FILE` setups keep working
  with no change.
- Secrets stay in your own writable env file (never in Claude config or git) — chosen over
  storing them in `sensitive` userConfig because the refresh token rotates on every post and must
  be written back, which secure-storage userConfig can't do.

## 1.0.0
- Initial package: `/x-poster:x-post` command + `x-post.mjs` (single/thread posting, optional image
  via X v2 media upload, dry-run cost preview, 429 backoff, rotating-refresh-token persistence) +
  `x-auth.mjs` (one-time OAuth2-PKCE refresh-token bootstrap).
- Built-in minimal bookmarkability rubric; bring-your-own voice/avoid-slop via env vars.
- Never-auto-publish gate enforced at both the command and the poster.
- MIT, published at github.com/rcmiskin10/x-poster.
