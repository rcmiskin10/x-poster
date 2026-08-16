// token-store.mjs — authoritative store for X's rotating single-use refresh token.
// Precedence: the state FILE wins whenever it exists; the seed (keychain/env) is used
// ONLY on a cold start before any rotation. After the first persist the seed is dead —
// never fall back to it, or X reuse-detection can revoke the whole grant.
import {
  existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync,
  openSync, writeSync, closeSync, statSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

// Lock tuning. Exported so tests can reason about them instead of sleeping for real.
export const LOCK_TIMEOUT_MS = 10_000; // a token exchange is a single HTTPS round-trip
export const STALE_LOCK_MS = 30_000;   // older than this and the holder is dead
export const LOCK_POLL_MS = 50;

export function makeTokenStore({
  statePath,
  seedRefreshToken,
  lockTimeoutMs = LOCK_TIMEOUT_MS, // overridable so tests exercise the timeout without sleeping
  staleLockMs = STALE_LOCK_MS,
  lockPollMs = LOCK_POLL_MS,
}) {
  let inflight = null;
  const current = () => {
    if (existsSync(statePath)) {
      const v = readFileSync(statePath, "utf8").trim();
      if (v) return v;
    }
    if (!seedRefreshToken) throw new Error("no refresh token: state file absent and no seed provided");
    return seedRefreshToken;
  };
  const persist = (token) => {
    mkdirSync(dirname(statePath), { recursive: true }); // fresh installs have no state dir yet
    // The temp name must be UNIQUE per writer, not a fixed `${statePath}.tmp`. Surfaces
    // share one state file (~/.local/state/x-poster/token), so two processes can persist
    // at once — with a fixed name, B's write clobbers A's temp and A's rename then commits
    // B's token while B's rename dies ENOENT. Persisting the wrong single-use refresh token
    // is precisely what trips X's reuse-detection and revokes the grant.
    const tmp = `${statePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      writeFileSync(tmp, token, { mode: 0o600 }); // atomic: write temp then rename
      renameSync(tmp, statePath);
    } catch (err) {
      try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
      throw err;
    }
  };
  // --- cross-process lock -------------------------------------------------
  // The in-flight promise below only serializes callers inside ONE process. Every surface
  // resolves the same default state file, so the Desktop .mcpb connector and a terminal MCP
  // server are two processes sharing one single-use token. Without a lock both read the same
  // token and both exchange it, and X's reuse-detection revokes the grant.
  //
  // The lock is taken BEFORE the token is read, so whoever goes second reads the token the
  // first one just persisted rather than the stale one it saw on entry.
  const lockPath = statePath + ".lock";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const lockIsStale = () => {
    try {
      // A lock older than the longest plausible token exchange belongs to a dead process.
      return Date.now() - statSync(lockPath).mtimeMs > staleLockMs;
    } catch {
      return false; // vanished between check and stat: not stale, just gone
    }
  };

  const acquireLock = async () => {
    mkdirSync(dirname(lockPath), { recursive: true });
    const deadline = Date.now() + lockTimeoutMs;
    for (;;) {
      try {
        // wx is the atomic test-and-set: it fails if the file already exists.
        const fd = openSync(lockPath, "wx", 0o600);
        writeSync(fd, String(process.pid));
        closeSync(fd);
        return;
      } catch (err) {
        if (err.code !== "EEXIST") throw err;
        if (lockIsStale()) {
          try { unlinkSync(lockPath); } catch { /* another waiter broke it first */ }
          continue;
        }
        if (Date.now() >= deadline) {
          throw new Error(
            `token refresh lock held for ${lockTimeoutMs}ms by another x-poster process ` +
              `(${lockPath}). Refusing to refresh concurrently: spending the same single-use ` +
              `refresh token twice can revoke the X grant. Retry, or delete the lock if no ` +
              `other x-poster process is running.`,
          );
        }
        await sleep(lockPollMs);
      }
    }
  };

  const releaseLock = () => {
    try { unlinkSync(lockPath); } catch { /* already released or broken as stale */ }
  };

  // Serialize refresh: concurrent callers share one in-flight promise so we never
  // run two refreshes against the same single-use token (which would trip reuse-detection).
  const withRefresh = (doRefresh) => {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        await acquireLock();
        try {
          // Read AFTER the lock. If another process refreshed while we waited, this is its
          // freshly persisted token, not the dead one we would otherwise have replayed.
          const { access, refresh } = await doRefresh(current());
          if (refresh && refresh !== current()) persist(refresh);
          return { access, refresh: refresh ?? current() };
        } finally { releaseLock(); }
      } finally { inflight = null; }
    })();
    return inflight;
  };
  return { current, persist, withRefresh };
}
