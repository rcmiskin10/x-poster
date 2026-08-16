// version-parity.test.mjs — the five version carriers must agree.
//
// This repo ships through three channels, and each one demands the version in its own
// manifest format. Nothing reconciles them, so a partial bump publishes a build whose
// channels disagree about what they are — while vendor-sync and surface-parity both stay
// green, because neither looks at a manifest.
//
// Found by audit 2026-08-14: RELEASING guidance named 2 of the 5 carriers.
//
// The manifest below is the source of truth. Adding a carrier? Add a row.
// Dependency-free on purpose (no SDK, no network) so it runs in every surface's CI job.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../..", import.meta.url).pathname;

// ---------------------------------------------------------------------------
// THE MANIFEST — every file that carries the release version.
// ---------------------------------------------------------------------------
const CARRIERS = [
  { path: "package.json",                                 channel: "repo root / npm" },
  { path: "mcp/package.json",                             channel: "npm MCP server" },
  { path: "plugins/x-poster/package.json",                channel: "plugin package" },
  { path: "plugins/x-poster/.claude-plugin/plugin.json",  channel: "Claude Code plugin loader" },
  { path: "mcpb/manifest.json",                           channel: "the .mcpb connector bundle" },
];

// Not a carrier: it points at the plugin by path and declares no version of its own.
// Asserted below so it cannot quietly become a sixth carrier that nobody bumps.
const NON_CARRIER = ".claude-plugin/marketplace.json";

const readVersion = (rel) => {
  const raw = readFileSync(join(ROOT, rel), "utf8");
  return JSON.parse(raw).version;
};

test("every declared carrier actually declares a version", () => {
  for (const { path, channel } of CARRIERS) {
    const v = readVersion(path);
    assert.ok(
      typeof v === "string" && v.length > 0,
      `${path} (${channel}) has no "version" field — it can no longer carry the release version`,
    );
  }
});

test("all five version carriers agree", () => {
  const seen = CARRIERS.map(({ path, channel }) => ({ path, channel, version: readVersion(path) }));
  const [reference] = seen;

  const disagreeing = seen.filter((c) => c.version !== reference.version);
  assert.equal(
    disagreeing.length,
    0,
    disagreeing.length === 0
      ? ""
      : `version drift — ${reference.path} says ${reference.version}, but:\n` +
        disagreeing.map((c) => `  ${c.path} (${c.channel}) says ${c.version}`).join("\n") +
        `\nBump ALL ${CARRIERS.length} carriers, then rebuild the .mcpb if mcpb/ changed.`,
  );
});

test("versions are valid semver-ish (X.Y.Z)", () => {
  for (const { path } of CARRIERS) {
    assert.match(
      readVersion(path),
      /^\d+\.\d+\.\d+(?:[-+].+)?$/,
      `${path} version is not X.Y.Z — release tooling assumes it is`,
    );
  }
});

test("marketplace.json is still NOT a version carrier", () => {
  const marketplace = JSON.parse(readFileSync(join(ROOT, NON_CARRIER), "utf8"));
  assert.equal(
    marketplace.version,
    undefined,
    `${NON_CARRIER} gained a "version" field. Either add it to CARRIERS above so it is ` +
      `bumped with the rest, or remove it — an unbumped sixth carrier is exactly the drift ` +
      `this file exists to catch.`,
  );
});
