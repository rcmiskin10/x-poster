# Changelog

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
