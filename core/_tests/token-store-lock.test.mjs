// token-store-lock.test.mjs — cross-process refresh serialization.
//
// withRefresh's in-flight promise only covers ONE process. Surfaces share a state file, so
// the Desktop .mcpb connector and a terminal MCP server can refresh at the same moment.
// Both would read the same single-use refresh token and both would exchange it, and X's
// reuse-detection revokes the whole grant. An O_EXCL lockfile taken BEFORE the token is read
// makes the second caller read what the first just persisted.
//
// A lock is only safe if it also cannot wedge: these tests cover the stale-holder and
// timeout paths, not just the happy path.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, writeFileSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeTokenStore, LOCK_TIMEOUT_MS, STALE_LOCK_MS } from "../token-store.mjs";

const scratch = () => mkdtempSync(join(tmpdir(), "x-poster-lock-"));
const setup = () => {
  const dir = scratch();
  const statePath = join(dir, "token");
  return { dir, statePath, lockPath: statePath + ".lock" };
};

test("two stores refreshing concurrently do NOT spend the same token twice", async () => {
  const { statePath } = setup();
  writeFileSync(statePath, "T0");

  const spent = [];
  let n = 0;
  // Each exchange records the token it was handed and returns a new one, like X does.
  const doRefresh = async (token) => {
    spent.push(token);
    await new Promise((r) => setTimeout(r, 25)); // hold the lock across an await
    const next = `T${++n}`;
    return { access: `access-${next}`, refresh: next };
  };

  // Two independent stores == two processes: separate in-flight promises, one state file.
  const a = makeTokenStore({ statePath, seedRefreshToken: "seed" });
  const b = makeTokenStore({ statePath, seedRefreshToken: "seed" });
  await Promise.all([a.withRefresh(doRefresh), b.withRefresh(doRefresh)]);

  assert.equal(spent.length, 2, "both callers should have refreshed");
  assert.notEqual(
    spent[0],
    spent[1],
    `both processes exchanged the same token (${spent[0]}) — reuse-detection would revoke the grant`,
  );
  assert.equal(spent[1], "T1", "the second caller must use the token the first persisted");
});

test("the lock is released after a successful refresh", async () => {
  const { statePath, lockPath } = setup();
  writeFileSync(statePath, "T0");
  const store = makeTokenStore({ statePath, seedRefreshToken: "seed" });
  await store.withRefresh(async () => ({ access: "a", refresh: "T1" }));
  assert.equal(existsSync(lockPath), false, "lock leaked after success");
});

test("the lock is released when the refresh THROWS (no wedge on network failure)", async () => {
  const { statePath, lockPath } = setup();
  writeFileSync(statePath, "T0");
  const store = makeTokenStore({ statePath, seedRefreshToken: "seed" });

  await assert.rejects(
    () => store.withRefresh(async () => { throw new Error("network down"); }),
    /network down/,
  );
  assert.equal(
    existsSync(lockPath),
    false,
    "a failed refresh left the lock behind — every later refresh would block until it went stale",
  );

  // and the store still works afterwards
  const out = await store.withRefresh(async () => ({ access: "a", refresh: "T1" }));
  assert.equal(out.refresh, "T1");
});

test("a stale lock from a dead process is broken, not waited on", async () => {
  const { statePath, lockPath } = setup();
  writeFileSync(statePath, "T0");
  // A lock file left by a process that died mid-refresh, aged past the stale threshold.
  writeFileSync(lockPath, "999999");
  const old = (Date.now() - STALE_LOCK_MS - 5_000) / 1000;
  utimesSync(lockPath, old, old);

  const store = makeTokenStore({ statePath, seedRefreshToken: "seed" });
  const started = Date.now();
  const out = await store.withRefresh(async () => ({ access: "a", refresh: "T1" }));

  assert.equal(out.refresh, "T1");
  assert.ok(
    Date.now() - started < LOCK_TIMEOUT_MS,
    "waited on a stale lock instead of breaking it — a crashed process would wedge auth",
  );
  assert.equal(readFileSync(statePath, "utf8"), "T1");
});

test("a FRESH lock held by someone else is respected, then times out with a clear error", async () => {
  const { statePath, lockPath } = setup();
  writeFileSync(statePath, "T0");
  writeFileSync(lockPath, "12345"); // fresh mtime: a live holder

  // Short timeout so this asserts the behaviour without spending 10s of CI wall-clock.
  const store = makeTokenStore({ statePath, seedRefreshToken: "seed", lockTimeoutMs: 250 });
  let refreshed = false;

  await assert.rejects(
    () => store.withRefresh(async () => { refreshed = true; return { access: "a", refresh: "T1" }; }),
    (err) => {
      assert.match(err.message, /lock held/i);
      assert.match(err.message, /revoke/i, "the error must say WHY it refused, not just that it timed out");
      return true;
    },
  );
  assert.equal(refreshed, false, "refreshed anyway while another process held the lock");
});
