import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTokenStore } from "../token-store.mjs";

function freshDir() { return mkdtempSync(join(tmpdir(), "xtok-")); }

test("cold start with no state file uses the seed token", () => {
  const dir = freshDir();
  const store = makeTokenStore({ statePath: join(dir, "token"), seedRefreshToken: "SEED" });
  assert.equal(store.current(), "SEED");
  rmSync(dir, { recursive: true });
});

test("state file is authoritative when present; seed is ignored", () => {
  const dir = freshDir();
  const p = join(dir, "token");
  writeFileSync(p, "ROTATED_LIVE");
  const store = makeTokenStore({ statePath: p, seedRefreshToken: "SEED" });
  assert.equal(store.current(), "ROTATED_LIVE");
  rmSync(dir, { recursive: true });
});

test("persist writes atomically and becomes the new current()", () => {
  const dir = freshDir();
  const p = join(dir, "token");
  const store = makeTokenStore({ statePath: p, seedRefreshToken: "SEED" });
  store.persist("NEW1");
  assert.equal(readFileSync(p, "utf8").trim(), "NEW1");
  assert.equal(store.current(), "NEW1");
  assert.ok(!existsSync(p + ".tmp"), "temp file cleaned up");
  rmSync(dir, { recursive: true });
});

test("after first persist, the seed is never used again even on a new store", () => {
  const dir = freshDir();
  const p = join(dir, "token");
  makeTokenStore({ statePath: p, seedRefreshToken: "SEED" }).persist("ROTATED");
  const store2 = makeTokenStore({ statePath: p, seedRefreshToken: "SEED" });
  assert.equal(store2.current(), "ROTATED", "must read live state, not fall back to stale seed");
  rmSync(dir, { recursive: true });
});

test("refresh is serialized: concurrent callers share one in-flight refresh", async () => {
  const dir = freshDir();
  const store = makeTokenStore({ statePath: join(dir, "token"), seedRefreshToken: "SEED" });
  let calls = 0;
  const doRefresh = async () => { calls++; await new Promise(r => setTimeout(r, 10)); return { access: "A", refresh: "R" + calls }; };
  const [a, b] = await Promise.all([store.withRefresh(doRefresh), store.withRefresh(doRefresh)]);
  assert.equal(calls, 1, "only one underlying refresh runs for concurrent callers");
  assert.equal(a.access, b.access);
  rmSync(dir, { recursive: true });
});
