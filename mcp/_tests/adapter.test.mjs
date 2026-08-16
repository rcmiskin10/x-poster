// Regression tests for makePostAdapter — the startServer post-path wiring.
// These lock in the three bugs the spec review caught: no double-refresh,
// current() supplies the refresh token, and rotation persists via onRotatedToken.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makePostAdapter, makeArticleAdapter } from "../server.mjs";

// Minimal fake token store mirroring core/token-store.mjs's surface.
function fakeStore(initial) {
  let token = initial;
  const calls = { current: 0, persist: [] };
  return {
    current: () => { calls.current++; return token; },
    persist: (t) => { calls.persist.push(t); token = t; },
    calls,
  };
}

test("adapter calls corePostThread exactly ONCE (no double refresh)", async () => {
  let postThreadCalls = 0;
  const corePostThread = async () => { postThreadCalls++; return ["1"]; };
  const store = fakeStore("REFRESH_0");

  const adapter = makePostAdapter({ tokenStore: store, corePostThread, clientId: "ID", clientSecret: "SECRET" });
  const ids = await adapter(["hi"], null);

  assert.equal(postThreadCalls, 1, "corePostThread must be invoked exactly once");
  assert.deepEqual(ids, ["1"], "ids pass straight through");
});

test("adapter passes tokenStore.current() as the refresh token and the real creds", async () => {
  let seenCreds = null;
  const corePostThread = async (tweets, creds) => { seenCreds = creds; return ["1"]; };
  const store = fakeStore("REFRESH_CURRENT");

  const adapter = makePostAdapter({ tokenStore: store, corePostThread, clientId: "CID", clientSecret: "CSECRET" });
  await adapter(["hi"], null);

  assert.equal(seenCreds.refreshToken, "REFRESH_CURRENT");
  assert.equal(seenCreds.clientId, "CID");
  assert.equal(seenCreds.clientSecret, "CSECRET");
});

test("adapter persists a rotated token via the onRotatedToken callback", async () => {
  // Simulate core.postThread rotating the single-use token mid-post.
  const corePostThread = async (tweets, creds, onRotatedToken) => {
    await onRotatedToken("REFRESH_ROTATED");
    return ["1"];
  };
  const store = fakeStore("REFRESH_0");

  const adapter = makePostAdapter({ tokenStore: store, corePostThread, clientId: "ID", clientSecret: "SECRET" });
  await adapter(["hi"], null);

  assert.deepEqual(store.calls.persist, ["REFRESH_ROTATED"], "rotated token persisted to the store");
  assert.equal(store.current(), "REFRESH_ROTATED", "store now returns the rotated token");
});

test("adapter forwards the image path (null when absent)", async () => {
  let seenImage = "untouched";
  const corePostThread = async (tweets, creds, onRotatedToken, image) => { seenImage = image; return ["1"]; };
  const store = fakeStore("R");

  const adapter = makePostAdapter({ tokenStore: store, corePostThread, clientId: "ID", clientSecret: "S" });
  await adapter(["hi"]);            // no image arg
  assert.equal(seenImage, null);

  await adapter(["hi"], "/tmp/pic.png");
  assert.equal(seenImage, "/tmp/pic.png");
});

test("adapter serializes concurrent calls (no interleaving)", async () => {
  // Tracks the number of corePostThread calls that are ACTIVE at the same time.
  let active = 0;
  let maxConcurrent = 0;
  const order = [];

  const corePostThread = async (tweets) => {
    active++;
    if (active > maxConcurrent) maxConcurrent = active;
    order.push(`start:${tweets[0]}`);
    // Yield to the microtask queue so a non-serialized second call could slip in.
    await Promise.resolve();
    order.push(`end:${tweets[0]}`);
    active--;
    return ["1"];
  };
  const store = fakeStore("R");

  const adapter = makePostAdapter({ tokenStore: store, corePostThread, clientId: "ID", clientSecret: "S" });

  // Fire both calls without awaiting — they are "concurrent" from the caller's POV.
  const p1 = adapter(["A"], null);
  const p2 = adapter(["B"], null);
  await Promise.all([p1, p2]);

  // Serialization means A must complete entirely before B starts.
  assert.deepEqual(order, ["start:A", "end:A", "start:B", "end:B"], "calls must not interleave");
  assert.equal(maxConcurrent, 1, "at most one corePostThread active at a time");
});

// ---------------------------------------------------------------------------
// makeArticleAdapter — cover attachment.
//
// The distribution article published with no banner because attaching one was
// a step a human had to remember. These pin the two rules that replace the
// remembering: a requested cover is uploaded and attached, and a cover that
// cannot be uploaded stops the article rather than shipping it bare.
// ---------------------------------------------------------------------------

function articleDeps(overrides = {}) {
  const calls = { uploads: [], drafts: [], publishes: [] };
  const deps = {
    tokenStore: { current: () => "refresh-tok", persist: () => {} },
    refresh: async () => "access-tok",
    uploadMedia: async (token, path) => {
      calls.uploads.push({ token, path });
      return "999";
    },
    createDraft: async (payload) => {
      calls.drafts.push(payload);
      return { id: "art-1" };
    },
    publishDraft: async (id) => {
      calls.publishes.push(id);
      return {};
    },
    clientId: "cid",
    clientSecret: "csec",
    ...overrides,
  };
  return { deps, calls };
}

test("article adapter uploads the cover and attaches it to the draft", async () => {
  const { deps, calls } = articleDeps();
  const post = makeArticleAdapter(deps);
  await post({ title: "t", contentState: { blocks: [], entities: [] }, coverPath: "/tmp/cover.png" });

  assert.equal(calls.uploads.length, 1);
  assert.equal(calls.uploads[0].path, "/tmp/cover.png");
  // The upload must use the token the refresh just minted, not the refresh token.
  assert.equal(calls.uploads[0].token, "access-tok");
  assert.deepEqual(calls.drafts[0].coverMedia, { media_category: "tweet_image", media_id: "999" });
});

test("article adapter passes no coverMedia when none was asked for", async () => {
  const { deps, calls } = articleDeps();
  const post = makeArticleAdapter(deps);
  await post({ title: "t", contentState: { blocks: [], entities: [] } });
  assert.equal(calls.uploads.length, 0);
  assert.equal(calls.drafts[0].coverMedia, null);
});

test("a failed cover upload does NOT create the article", async () => {
  // The tempting alternative is to create it anyway and warn. That is exactly
  // how an article ends up on X missing the image it was meant to have, and
  // drafts cannot be deleted through the API.
  const { deps, calls } = articleDeps({
    uploadMedia: async () => {
      throw new Error("media upload failed: 413 too large");
    },
  });
  const post = makeArticleAdapter(deps);
  await assert.rejects(
    () => post({ title: "t", contentState: { blocks: [], entities: [] }, coverPath: "/tmp/big.png" }),
    /media upload failed/,
  );
  assert.equal(calls.drafts.length, 0, "no draft may exist after a failed cover upload");
  assert.equal(calls.publishes.length, 0);
});

test("asking for a cover with no uploadMedia injected fails loudly", async () => {
  const { deps, calls } = articleDeps({ uploadMedia: undefined });
  const post = makeArticleAdapter(deps);
  await assert.rejects(
    () => post({ title: "t", contentState: { blocks: [], entities: [] }, coverPath: "/tmp/c.png" }),
    /no uploadMedia was injected/,
  );
  assert.equal(calls.drafts.length, 0);
});
