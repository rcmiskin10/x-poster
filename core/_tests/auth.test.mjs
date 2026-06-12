// Tests for core/auth.mjs — PKCE helpers + the in-process authorize session
// used by the MCP server's `authorize` tool. No real network: fetch is injected.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { generatePkce, buildAuthorizeUrl, startAuthSession, SCOPES } from "../auth.mjs";

test("generatePkce: challenge is base64url(sha256(verifier))", () => {
  const { codeVerifier, codeChallenge } = generatePkce();
  assert.ok(codeVerifier.length >= 43 && codeVerifier.length <= 128);
  assert.equal(codeChallenge, createHash("sha256").update(codeVerifier).digest("base64url"));
});

test("SCOPES carry offline.access (refresh token) and media.write (image upload)", () => {
  assert.ok(SCOPES.includes("offline.access"));
  assert.ok(SCOPES.includes("media.write"));
});

// ---------------------------------------------------------------------------
// startAuthSession — one-shot localhost callback listener (port 0 in tests)
// ---------------------------------------------------------------------------

const fakeFetchOk = async (url, opts) => {
  fakeFetchOk.lastCall = { url, opts };
  return {
    ok: true,
    json: async () => ({ refresh_token: "MINTED_REFRESH", access_token: "A" }),
  };
};

function startTestSession({ onToken, fetchImpl = fakeFetchOk, onDone } = {}) {
  return startAuthSession({
    clientId: "CID",
    clientSecret: "SECRET",
    port: 0,
    onToken: onToken ?? (() => {}),
    onDone,
    fetchImpl,
  });
}

test("startAuthSession: authorize URL is bound to the actual listening port", async () => {
  const session = await startTestSession();
  try {
    const u = new URL(session.authorizeUrl);
    assert.equal(u.origin + u.pathname, "https://x.com/i/oauth2/authorize");
    assert.equal(u.searchParams.get("client_id"), "CID");
    assert.equal(u.searchParams.get("code_challenge_method"), "S256");
    assert.ok(u.searchParams.get("state"));
    assert.ok(u.searchParams.get("scope").includes("offline.access"));
    const redirect = new URL(u.searchParams.get("redirect_uri"));
    assert.equal(redirect.hostname, "127.0.0.1");
    assert.equal(redirect.pathname, "/callback");
    assert.notEqual(redirect.port, "0", "must expose the real bound port");
    assert.equal(session.redirectUri, `http://127.0.0.1:${redirect.port}/callback`);
  } finally {
    session.close();
  }
});

test("startAuthSession: valid callback exchanges the code and persists the token", async () => {
  let persisted = null;
  let done = null;
  const session = await startTestSession({
    onToken: (t) => (persisted = t),
    onDone: (result) => (done = result),
  });
  try {
    const state = new URL(session.authorizeUrl).searchParams.get("state");
    const res = await fetch(`${session.redirectUri}?code=THECODE&state=${state}`);
    const body = await res.text();
    assert.equal(res.status, 200);
    assert.match(body, /[Aa]uthorized/);
    assert.equal(persisted, "MINTED_REFRESH");
    assert.equal(done?.ok, true);
    assert.equal(fakeFetchOk.lastCall.url, "https://api.x.com/2/oauth2/token");
    const sent = fakeFetchOk.lastCall.opts.body.toString();
    assert.match(sent, /code=THECODE/);
    assert.match(sent, /grant_type=authorization_code/);
  } finally {
    session.close();
  }
});

test("startAuthSession: state mismatch is rejected, token NOT persisted", async () => {
  let persisted = null;
  const session = await startTestSession({ onToken: (t) => (persisted = t) });
  try {
    const res = await fetch(`${session.redirectUri}?code=X&state=WRONG`);
    assert.equal(res.status, 400);
    assert.equal(persisted, null);
  } finally {
    session.close();
  }
});

test("startAuthSession: X error param surfaces to the user, token NOT persisted", async () => {
  let persisted = null;
  const session = await startTestSession({ onToken: (t) => (persisted = t) });
  try {
    const state = new URL(session.authorizeUrl).searchParams.get("state");
    const res = await fetch(`${session.redirectUri}?error=access_denied&state=${state}`);
    assert.equal(res.status, 400);
    assert.equal(persisted, null);
  } finally {
    session.close();
  }
});

test("startAuthSession: missing refresh_token in exchange response is an error", async () => {
  let persisted = null;
  const noRefresh = async () => ({ ok: true, json: async () => ({ access_token: "A" }) });
  const session = await startTestSession({ onToken: (t) => (persisted = t), fetchImpl: noRefresh });
  try {
    const state = new URL(session.authorizeUrl).searchParams.get("state");
    const res = await fetch(`${session.redirectUri}?code=X&state=${state}`);
    assert.equal(res.status, 500);
    assert.equal(persisted, null);
  } finally {
    session.close();
  }
});

test("startAuthSession: listener shuts down after a successful authorize", async () => {
  const session = await startTestSession();
  const state = new URL(session.authorizeUrl).searchParams.get("state");
  await fetch(`${session.redirectUri}?code=C&state=${state}`);
  await assert.rejects(() => fetch(`${session.redirectUri}?code=C2&state=${state}`), /fetch failed/);
});
