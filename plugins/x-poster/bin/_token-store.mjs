// token-store.mjs — authoritative store for X's rotating single-use refresh token.
// Precedence: the state FILE wins whenever it exists; the seed (keychain/env) is used
// ONLY on a cold start before any rotation. After the first persist the seed is dead —
// never fall back to it, or X reuse-detection can revoke the whole grant.
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";

export function makeTokenStore({ statePath, seedRefreshToken }) {
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
    const tmp = statePath + ".tmp";
    writeFileSync(tmp, token, { mode: 0o600 });   // atomic: write temp then rename
    renameSync(tmp, statePath);
  };
  // Serialize refresh: concurrent callers share one in-flight promise so we never
  // run two refreshes against the same single-use token (which would trip reuse-detection).
  const withRefresh = (doRefresh) => {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const { access, refresh } = await doRefresh(current());
        if (refresh && refresh !== current()) persist(refresh);
        return { access, refresh: refresh ?? current() };
      } finally { inflight = null; }
    })();
    return inflight;
  };
  return { current, persist, withRefresh };
}
