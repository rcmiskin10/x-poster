import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const ROOT = new URL("../..", import.meta.url).pathname;
const SURFACES = ["plugins/x-poster/bin", "mcp", "mcpb"];

// core/poster.mjs, core/token-store.mjs, and core/auth.mjs must be byte-identical across all three surfaces.
for (const f of ["poster.mjs", "token-store.mjs", "auth.mjs", "scheduler.mjs"]) {
  const src = readFileSync(join(ROOT, "core", f), "utf8");
  for (const s of SURFACES) {
    test(`vendored ${s}/_${f} matches core/${f}`, () => {
      assert.equal(readFileSync(join(ROOT, s, `_${f}`), "utf8"), src,
        `run scripts/vendor-core.sh — ${s}/_${f} drifted from core/${f}`);
    });
  }
}

// mcp/server.mjs must be byte-identical in the two distribution surfaces.
// (mcp/server.mjs IS the canonical; plugins/x-poster/bin/_mcp-server.mjs and mcpb/server.mjs are copies.)
const serverSrc = readFileSync(join(ROOT, "mcp", "server.mjs"), "utf8");
const serverCopies = [
  { surface: "plugins/x-poster/bin", name: "_mcp-server.mjs" },
  { surface: "mcpb",                 name: "server.mjs" },
];
for (const { surface, name } of serverCopies) {
  test(`vendored ${surface}/${name} matches mcp/server.mjs`, () => {
    assert.equal(
      readFileSync(join(ROOT, surface, name), "utf8"),
      serverSrc,
      `run scripts/vendor-core.sh — ${surface}/${name} drifted from mcp/server.mjs`,
    );
  });
}
