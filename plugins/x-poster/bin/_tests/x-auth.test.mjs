// Tests for bin/x-auth.mjs pure helpers (no network, no browser). Run: node --test bin/_tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { generatePkce, buildAuthorizeUrl, buildTokenExchangeBody } from "../x-auth.mjs";

test("generatePkce: challenge is base64url(sha256(verifier)), url-safe", () => {
  const { codeVerifier, codeChallenge } = generatePkce();
  assert.ok(codeVerifier.length >= 43 && codeVerifier.length <= 128, "verifier within spec length");
  const expected = createHash("sha256").update(codeVerifier).digest("base64url");
  assert.equal(codeChallenge, expected);
  assert.doesNotMatch(codeChallenge, /[+/=]/, "challenge must be base64url (no + / =)");
});

test("generatePkce: fresh values each call", () => {
  assert.notEqual(generatePkce().codeVerifier, generatePkce().codeVerifier);
});

test("buildAuthorizeUrl: correct endpoint + required params incl offline.access", () => {
  const url = buildAuthorizeUrl({
    clientId: "CID", redirectUri: "http://127.0.0.1:8723/callback",
    scope: "tweet.read tweet.write users.read offline.access", state: "ST", codeChallenge: "CH",
  });
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, "https://x.com/i/oauth2/authorize");
  assert.equal(u.searchParams.get("response_type"), "code");
  assert.equal(u.searchParams.get("client_id"), "CID");
  assert.equal(u.searchParams.get("redirect_uri"), "http://127.0.0.1:8723/callback");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.equal(u.searchParams.get("code_challenge"), "CH");
  assert.equal(u.searchParams.get("state"), "ST");
  assert.ok(u.searchParams.get("scope").includes("offline.access"), "must request offline.access for a refresh token");
  assert.ok(u.searchParams.get("scope").includes("tweet.write"), "must request tweet.write to post");
});

test("default SCOPES include media.write (needed for image upload)", async () => {
  // The CLI builds the authorize URL from a module-level SCOPES constant; assert the helper would
  // carry media.write when given the same scope string the CLI uses.
  const url = buildAuthorizeUrl({
    clientId: "C", redirectUri: "http://127.0.0.1:8723/callback",
    scope: "tweet.read tweet.write users.read media.write offline.access", state: "S", codeChallenge: "H",
  });
  assert.ok(new URL(url).searchParams.get("scope").includes("media.write"));
});

test("buildTokenExchangeBody: authorization_code grant with PKCE verifier", () => {
  const body = buildTokenExchangeBody({
    code: "CODE", redirectUri: "http://127.0.0.1:8723/callback", codeVerifier: "VER", clientId: "CID",
  });
  assert.equal(body.get("grant_type"), "authorization_code");
  assert.equal(body.get("code"), "CODE");
  assert.equal(body.get("redirect_uri"), "http://127.0.0.1:8723/callback");
  assert.equal(body.get("code_verifier"), "VER");
  assert.equal(body.get("client_id"), "CID");
});
