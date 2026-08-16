# v1.12.0

Two new surfaces, and six bugs that failed silently.

## Upgrade first if you use OAuth

`v1.12.0` fixes a bug that could **revoke your X connection**. X issues single-use refresh
tokens: spending one invalidates the last. When two surfaces refreshed at the same moment —
the CLI and the MCP server, or two MCP clients — both could read the same token from disk and
spend it twice. X treats the second spend as a replay and revokes the whole grant, so you were
signed out with nothing explaining why.

Refreshes are now serialized through a lock taken *before* the network call, with stale-lock
detection and a bounded timeout so a crashed process can't wedge the next one.

## New

- **X Articles.** Draft, preview, and publish long-form Articles, with a cover banner generated
  for every surface.
- **Post tracking.** Published posts emit a `post.published` event, so downstream tooling can
  pick up what shipped without polling.

## Fixed

- **The CLI printed nothing and exited 0** when run through a symlink or from a path containing
  spaces — the two most common ways a globally-installed tool is invoked. It looked like success
  and did nothing. Both `x-post` and `x-auth` were affected.
- **Concurrent token writes could persist the wrong token.** The store wrote through a fixed
  temp filename, so two writers raced and the loser's token won.
- **The vendor guard had stopped guarding.** Its check passed whether or not the vendored copies
  matched the core, which meant a stale or divergent copy could ship unnoticed.
- **Version drift shipped unchecked.** Five files carry the version; nothing verified they agreed.
  They're now asserted equal, and the release fails if they aren't.
- **Dependency advisories** cleared — `npm audit` reports 0.

## Notes

- The `.mcpb` connector is rebuilt for this release (`core/` and `mcp/`, including the lockfile,
  both changed). Re-download it from the release assets; the plugin updates itself.
- No configuration changes. No breaking changes to any command or MCP tool.
