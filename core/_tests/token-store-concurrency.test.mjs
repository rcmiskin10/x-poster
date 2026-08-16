// token-store-concurrency.test.mjs — two processes may persist at once.
//
// Every surface resolves the same default state file (~/.local/state/x-poster/token via
// XDG_STATE_HOME, unless CLAUDE_PLUGIN_DATA or X_STATE_FILE overrides), so the .mcpb
// connector in Claude Desktop and an MCP server in a terminal can write concurrently.
//
// persist() used a FIXED temp name (`${statePath}.tmp`). Interleaved, that gives:
//   A: write tmp(A)  B: write tmp(B)  A: rename -> commits B's token  B: rename -> ENOENT
// Committing the wrong single-use refresh token is what trips X's reuse-detection and can
// revoke the whole grant. The temp name is now unique per writer.
//
// Dependency-free; uses a scratch dir, never the real state file.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeTokenStore } from "../token-store.mjs";

const scratch = () => mkdtempSync(join(tmpdir(), "x-poster-token-"));

test("two stores persisting concurrently each commit their OWN token", () => {
  const dir = scratch();
  const statePath = join(dir, "nested", "token");
  const a = makeTokenStore({ statePath, seedRefreshToken: "seed" });
  const b = makeTokenStore({ statePath, seedRefreshToken: "seed" });

  // Interleaving is only observable if the temp names differ; with a shared name the
  // second write lands on the first's temp and the first rename commits the wrong bytes.
  a.persist("TOKEN_A");
  assert.equal(readFileSync(statePath, "utf8"), "TOKEN_A");
  b.persist("TOKEN_B");
  assert.equal(readFileSync(statePath, "utf8"), "TOKEN_B", "second writer must win cleanly");
});

test("persist uses a unique temp name, not a fixed one", () => {
  const dir = scratch();
  const statePath = join(dir, "token");
  const store = makeTokenStore({ statePath, seedRefreshToken: "seed" });

  // Squat on the legacy fixed temp path. If persist still used it, this file would be
  // clobbered and then renamed away — the exact collision two processes hit.
  const legacyTmp = `${statePath}.tmp`;
  writeFileSync(legacyTmp, "SQUATTED");

  store.persist("TOKEN_A");

  assert.equal(readFileSync(statePath, "utf8"), "TOKEN_A");
  assert.equal(
    readFileSync(legacyTmp, "utf8"),
    "SQUATTED",
    "persist wrote through the fixed `.tmp` path — concurrent writers will collide",
  );
});

test("persist leaves no temp files behind", () => {
  const dir = scratch();
  const statePath = join(dir, "token");
  makeTokenStore({ statePath, seedRefreshToken: "seed" }).persist("TOKEN_A");
  const leftovers = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
  assert.deepEqual(leftovers, [], `left temp files behind: ${leftovers.join(", ")}`);
});

test("the state file is written 0600 — it holds a refresh token", () => {
  const dir = scratch();
  const statePath = join(dir, "token");
  makeTokenStore({ statePath, seedRefreshToken: "seed" }).persist("TOKEN_A");
  const mode = statSync(statePath).mode & 0o777;
  assert.equal(mode, 0o600, `state file mode is ${mode.toString(8)}, expected 600`);
});

test("the file wins over the seed once it exists (seed is dead after first rotation)", () => {
  const dir = scratch();
  const statePath = join(dir, "token");
  const store = makeTokenStore({ statePath, seedRefreshToken: "SEED" });
  assert.equal(store.current(), "SEED", "cold start uses the seed");
  store.persist("ROTATED");
  assert.equal(
    store.current(),
    "ROTATED",
    "after rotation the seed must never be returned again — reusing it can revoke the grant",
  );
});
