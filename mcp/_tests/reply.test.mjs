// Tests for in_reply_to support: the post/thread root can reply to an existing
// tweet. Covers nonce binding (a reply nonce can't be replayed as a standalone
// post) and that the id is forwarded through the publish handler + adapter.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTools, makePostAdapter } from "../server.mjs";

function fakeStore(initial) {
  let token = initial;
  return { current: () => token, persist: (t) => { token = t; } };
}

test("publish forwards in_reply_to to the post path", async () => {
  let seen;
  const postThread = async (tweets, image, inReplyTo) => { seen = { tweets, image, inReplyTo }; return ["99"]; };
  const tools = makeTools({ postThread, statePath: "/tmp/x", elicit: null });

  const { confirm_nonce } = await tools.preview_post.handler({ text: "yo", in_reply_to: "ROOT123" });
  const res = await tools.publish_post.handler({ text: "yo", in_reply_to: "ROOT123", confirm_nonce });

  assert.deepEqual(res.posted, ["99"]);
  assert.equal(seen.inReplyTo, "ROOT123", "the reply target reaches postThread");
});

test("a reply nonce does NOT verify as a standalone post (binding holds)", async () => {
  const postThread = async () => ["1"];
  const tools = makeTools({ postThread, statePath: "/tmp/x", elicit: null });

  // Nonce minted FOR a reply...
  const { confirm_nonce } = await tools.preview_post.handler({ text: "yo", in_reply_to: "ROOT123" });

  // ...must be rejected when publish omits in_reply_to (different payload).
  await assert.rejects(
    () => tools.publish_post.handler({ text: "yo", confirm_nonce }),
    /confirm_nonce/,
    "reply nonce must not authorize a non-reply post",
  );
});

test("standalone posts still work (in_reply_to omitted → null)", async () => {
  let seen;
  const postThread = async (tweets, image, inReplyTo) => { seen = inReplyTo; return ["7"]; };
  const tools = makeTools({ postThread, statePath: "/tmp/x", elicit: null });

  const { confirm_nonce } = await tools.preview_post.handler({ text: "plain" });
  await tools.publish_post.handler({ text: "plain", confirm_nonce });
  assert.equal(seen, null, "no reply target → null root");
});

test("adapter forwards in_reply_to to corePostThread as the 5th arg", async () => {
  let seen = "untouched";
  const corePostThread = async (tweets, creds, onRotated, image, inReplyTo) => { seen = inReplyTo; return ["1"]; };
  const adapter = makePostAdapter({ tokenStore: fakeStore("R"), corePostThread, clientId: "I", clientSecret: "S" });

  await adapter(["hi"], null, "ROOT999");
  assert.equal(seen, "ROOT999");

  await adapter(["hi"], null);              // omitted → null
  assert.equal(seen, null);
});
