# Acceptance verification — x-poster MCP connector

Verified against the 6 criteria from `_planning/2026-06-01-x-poster-mcp-connector.md`.
Test suite baseline: **37/37 pass** (`npm test`).

---

## 1. Core is single source + vendored + existing tests pass unchanged

**PASS**

- Canonical source: `core/poster.mjs` and `core/token-store.mjs`.
- Vendored byte-for-byte into three surfaces: `plugins/x-poster/bin/`, `mcp/`, `mcpb/`.
- Drift is caught at test time by `core/_tests/vendor-sync.test.mjs` (tests 17–24):
  - `ok 17` – `vendored plugins/x-poster/bin/_poster.mjs matches core/poster.mjs`
  - `ok 18` – `vendored mcp/_poster.mjs matches core/poster.mjs`
  - `ok 19` – `vendored mcpb/_poster.mjs matches core/poster.mjs`
  - `ok 20` – `vendored plugins/x-poster/bin/_token-store.mjs matches core/token-store.mjs`
  - `ok 21` – `vendored mcp/_token-store.mjs matches core/token-store.mjs`
  - `ok 22` – `vendored mcpb/_token-store.mjs matches core/token-store.mjs`
  - `ok 23` – `vendored plugins/x-poster/bin/_mcp-server.mjs matches mcp/server.mjs`
  - `ok 24` – `vendored mcpb/server.mjs matches mcp/server.mjs`
- Original poster tests (tests 1–11) pass unchanged: `buildPlan`, `postCost`, `containsUrl`,
  `persistRefreshToken`, `mediaTypeForPath`.

---

## 2. `preview_post` provably zero network; `publish_post` is the only writer

**PASS**

- `mcp/_tests/server.test.mjs` injects `noNet = () => { throw new Error("network called during preview!") }` as the `postThread` dep for `preview_post`. Test passes without throwing → zero network I/O is structurally enforced (test 33):
  - `ok 33` – `preview_post performs zero network I/O and returns cost`
- `makeTools` in `mcp/server.mjs` exports three handlers: `preview_post` (calls only `buildPlan`, no I/O), `publish_post` (the one path that calls `injectedPostThread`), and `auth_instructions` (read-only). No other export touches the network or posts to X.

---

## 3. `publish_post` recomputes cost server-side + refuses without elicit/nonce

**PASS**

- Server-side recompute: `publishHandler` calls `buildPlan(...)` unconditionally before any post — never trusts the model-supplied cost (line 160 of `mcp/server.mjs`).
- Refuses empty text (test 34): `ok 34` – `publish_post refuses on validation error (empty)`
- Refuses with no valid nonce and no elicitation (test 35): `ok 35` – `publish_post refuses without a valid nonce when elicitation unsupported`
- Accepts a valid nonce and posts (test 36): `ok 36` – `publish_post recomputes cost server-side and posts with a valid nonce`
- Nonce is payload-bound; a nonce for payload A does not authorize payload B (test 37): `ok 37` – `a nonce minted for one payload does not authorize a different payload`

---

## 4. Token rotation: state file authoritative, seed-only cold start, atomic, serialized

**PASS**

- `core/_tests/token-store.test.mjs` (tests 12–16):
  - `ok 12` – `cold start with no state file uses the seed token`
  - `ok 13` – `state file is authoritative when present; seed is ignored`
  - `ok 14` – `persist writes atomically and becomes the new current()`
  - `ok 15` – `after first persist, the seed is never used again even on a new store`
  - `ok 16` – `refresh is serialized: concurrent callers share one in-flight refresh`
- `makePostAdapter` (tests 25–28) verifies the adapter calls `corePostThread` exactly once (no double-burn) and persists any rotated token via `tokenStore.persist`:
  - `ok 25` – `adapter calls corePostThread exactly ONCE (no double refresh)`
  - `ok 26` – `adapter passes tokenStore.current() as the refresh token and the real creds`
  - `ok 27` – `adapter persists a rotated token via the onRotatedToken callback`
  - `ok 28` – `adapter forwards the image path (null when absent)`

---

## 5. `.mcpb` builds; plugin-bundled server present; slash command still works

**PASS**

- `x-poster.mcpb` exists at `_packages/x-poster/x-poster.mcpb` (3.36 MB, built
  2026-06-04 by `scripts/build-mcpb.sh`).
- Plugin-bundled server: `plugins/x-poster/bin/_mcp-server.mjs` is present and byte-identical to
  `mcp/server.mjs` (verified by test 23 above).
- Slash command dry-run output (`node plugins/x-poster/bin/x-post.mjs --dry-run --text hi`):

```
{
  "tweets": ["hi"],
  "count": 1,
  "isThread": false,
  "image": null,
  "hasImage": false,
  "perPost": [{"chars": 2, "hasUrl": false, "cost": 0.015}],
  "estimatedCostUsd": 0.015,
  "dryRun": true,
  "willPost": false,
  "blockedReason": "dry-run",
  "errors": []
}
NOT POSTING (dry-run). Estimated cost if posted: $0.015.
```

Slash command exits 0 and reports the correct cost.

---

## 6. Plugin install path + SemVer intact; SDK deps SHA-pinned + isolated to mcp/mcpb

**PASS**

- Plugin `package.json` (`plugins/x-poster/package.json`) is at version `1.1.0`.
- `mcp/package-lock.json` exists (`lockfileVersion: 3`) with 92 `integrity` SHA-512 hash entries
  — every dep is pinned.
- `mcp/node_modules/` is gitignored by the root `.gitignore` (`mcp/node_modules/`). `mcpb/node_modules/`
  and `mcpb/package.json` are also gitignored (generated by `build-mcpb.sh`).
- The SDK (`@modelcontextprotocol/sdk@1.29.0`) is declared only in `mcp/package.json` and
  `plugins/x-poster/package.json` (plugin installs it to `${CLAUDE_PLUGIN_DATA}/node_modules` at
  runtime via the SessionStart hook). It is not present in `core/` or the root `package.json`.
  Core code and the slash command bin are zero-dependency.
