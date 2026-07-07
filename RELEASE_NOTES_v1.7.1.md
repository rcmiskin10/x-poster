# v1.7.1 — fix: video uploads over 5 MB no longer fail with 413

## Fixed

- **Videos larger than 5 MB failed to upload** — X's media API rejected the first
  chunk with `413 Payload Too Large`. The APPEND limit applies to the whole
  multipart request, not just the file bytes, so a full 5 MB chunk plus form
  framing pushed every multi-chunk upload over the cap. Chunks are now 4 MB,
  leaving headroom for the multipart boundary and headers. Videos of any
  supported size (up to X's 512 MB cap) upload correctly again.

Applies to every surface: core library, MCP server, `.mcpb` desktop connector,
and the Claude Code plugin.

No new features, no API changes. If you only post text, images, or videos under
5 MB, nothing changes — but upgrading is recommended.

## Upgrade

- **Claude Desktop (.mcpb):** download `x-poster.mcpb` from this release and
  reinstall the connector.
- **Claude Code plugin / MCP:** pull latest `main`; restart Claude Code so the
  MCP server reloads.
