# Releasing x-poster

Maintainer runbook. Short version: **the `.mcpb` is a frozen snapshot** — it only contains what was
packed into it, so know when a change requires a rebuild and when it doesn't.

## What ships where

| Surface | Contents | Updated by |
|---|---|---|
| `.mcpb` release asset | `mcp/server.mjs` + vendored core (`_poster.mjs`, `_auth.mjs`, `_token-store.mjs`) + production `node_modules` + `manifest.json` | `bash scripts/build-mcpb.sh` + uploading the new asset |
| Git clone / source tarball | everything in the repo | merging to `main` (tarball: whatever the tag points at) |
| Claude Code plugin | `plugins/x-poster/**` (CLI + vendored core) | merging to `main` (plugin installs track the repo) |

`core/*.mjs` is the single source of truth; `scripts/vendor-core.sh` copies it into `mcp/`,
`mcpb/`, and `plugins/x-poster/bin/` as `_*.mjs`. Never edit the vendored `_*.mjs` copies directly.

## Does this change need a `.mcpb` rebuild?

- Changed anything under **`core/`** or **`mcp/`** (including deps in `mcp/package.json`)?
  → **YES — rebuild and replace the asset** (steps below).
- Changed only **`README.md`, docs, `plugins/`, or `scripts/`**?
  → **No rebuild.** The installed connector doesn't contain those files.

## Release sequence

From a clean clone of `main`:

```bash
# 1. deps clean? fix INSIDE mcp/ (never --force: it can major-bump the MCP SDK)
cd mcp && npm audit
npm audit fix        # only if needed; then commit the lockfile bump
cd ..

# 2. build the bundle — NOTE: output lands at the REPO ROOT, not mcpb/
bash scripts/build-mcpb.sh   # → ./x-poster.mcpb

# 3. tag + release with the asset
gh release create v<X.Y.Z> x-poster.mcpb --title "v<X.Y.Z>" --notes-file RELEASE_NOTES_v<X.Y.Z>.md

# replacing the asset on an EXISTING release (e.g. a dep patch, no code change):
gh release upload v<X.Y.Z> x-poster.mcpb --clobber
```

Before tagging a feature release, bump the version in `mcpb/manifest.json` (what Claude Desktop
shows) and keep `package.json` versions in sync.

## Tag hygiene

- **Code change merged after the latest tag** (even a small CLI fix) → cut a **patch tag**, so the
  release source tarball matches what a clone of `main` gets.
- **Docs-only change** → no new tag needed.
- If the connector code is unchanged since the last release, a patch release may **reuse the
  previous `.mcpb` asset** — say so in the release notes.

## Sanity checks before announcing

- `npm audit` in `mcp/` reports 0 vulnerabilities.
- The pack step printed the expected version and a ~3 MB package size.
- Core tests pass: `node --test plugins/x-poster/bin/_tests/` (remember: the suite mocks `fetch`,
  so it proves wiring, **not** the live X API — verify protocol changes with a real call).
- Video posts need an audio track (X may reject silent clips) — keep the ffmpeg mux one-liner in
  the README intact.
