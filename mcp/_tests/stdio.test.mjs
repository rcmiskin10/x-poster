// Live stdio handshake against the real server process. Guards the tool
// REGISTRATION layer (registerTool schemas), which the handler-level tests
// in server.test.mjs bypass — a bad inputSchema kills the server at startup
// and surfaces in clients as "MCP error -32000: Connection closed".
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const serverPath = join(dirname(fileURLToPath(import.meta.url)), "..", "server.mjs");

test("server completes an MCP stdio handshake and lists every tool", async () => {
  const child = spawn(process.execPath, [serverPath], {
    env: {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      X_CLIENT_ID: "test-client-id",
      X_CLIENT_SECRET: "test-client-secret",
      // No X_REFRESH_TOKEN on purpose: a fresh install has no token yet, and
      // publish must fail with an actionable "authorize first" message.
      X_AUTH_PORT: "0",
      X_STATE_FILE: join(tmpdir(), `x-poster-stdio-test-${process.pid}`),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));

  const lines = [];
  let buf = "";
  let notify = null;
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) lines.push(JSON.parse(line));
    }
    notify?.();
  });
  child.on("exit", () => notify?.());

  const nextMessage = async () => {
    while (lines.length === 0) {
      if (child.exitCode !== null) {
        throw new Error(`server exited (code ${child.exitCode}) before replying. stderr: ${stderr}`);
      }
      await new Promise((r) => (notify = r));
    }
    return lines.shift();
  };

  const rpc = (msg) => child.stdin.write(JSON.stringify(msg) + "\n");

  try {
    rpc({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "stdio-test", version: "0" } },
    });
    const init = await nextMessage();
    assert.equal(init.id, 1);
    assert.ok(init.result, `initialize failed: ${JSON.stringify(init.error)}`);

    rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
    rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const list = await nextMessage();
    assert.ok(list.result, `tools/list failed: ${JSON.stringify(list.error)}`);

    const byName = Object.fromEntries(list.result.tools.map((t) => [t.name, t]));
    assert.deepEqual(
      Object.keys(byName).sort(),
      ["auth_instructions", "authorize", "cancel_scheduled", "list_scheduled", "preview_bulk", "preview_post", "publish_post", "schedule_bulk", "schedule_post"],
    );
    // Schemas must survive the zod → JSON Schema round-trip with params intact.
    for (const tool of ["preview_post", "publish_post"]) {
      assert.ok(byName[tool].inputSchema?.properties?.text, `${tool} exposes 'text'`);
      assert.ok(byName[tool].inputSchema?.properties?.thread, `${tool} exposes 'thread'`);
    }
    assert.ok(byName.publish_post.inputSchema.properties.confirm_nonce, "publish_post exposes 'confirm_nonce'");
    assert.ok(byName.schedule_post.inputSchema?.properties?.scheduled_for, "schedule_post exposes 'scheduled_for'");
    assert.ok(byName.schedule_post.inputSchema?.properties?.confirm_nonce, "schedule_post exposes 'confirm_nonce'");
    assert.ok(byName.cancel_scheduled.inputSchema?.properties?.id, "cancel_scheduled exposes 'id'");
    assert.ok(byName.preview_bulk.inputSchema?.properties?.posts, "preview_bulk exposes 'posts'");
    assert.ok(byName.schedule_bulk.inputSchema?.properties?.posts, "schedule_bulk exposes 'posts'");
    assert.ok(byName.schedule_bulk.inputSchema?.properties?.confirm_nonce, "schedule_bulk exposes 'confirm_nonce'");

    // authorize: starts a local listener (ephemeral port via X_AUTH_PORT=0) and
    // returns a clickable X authorize link. No network I/O happens here.
    rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "authorize", arguments: {} } });
    const auth = await nextMessage();
    assert.ok(auth.result, `authorize failed: ${JSON.stringify(auth.error)}`);
    const payload = JSON.parse(auth.result.content[0].text);
    assert.match(payload.authorize_url, /^https:\/\/x\.com\/i\/oauth2\/authorize\?/);
    assert.match(payload.authorize_url, /code_challenge_method=S256/);

    // publish with a VALID nonce but no token must fail with an actionable
    // "authorize first" error, not an opaque OAuth failure. (An invalid nonce
    // would fail earlier, at nonce verification — that path is already tested.)
    rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "preview_post", arguments: { text: "hi" } } });
    const prev = await nextMessage();
    const { confirm_nonce } = JSON.parse(prev.result.content[0].text);
    rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "publish_post", arguments: { text: "hi", confirm_nonce } } });
    const pub = await nextMessage();
    const pubText = JSON.stringify(pub);
    assert.match(pubText, /authorize/i, "error points at the authorize tool, got: " + pubText);
  } finally {
    child.kill();
  }
});

test("server with no client credentials exits fast with an actionable fatal message", async () => {
  const child = spawn(process.execPath, [serverPath], {
    // No X_CLIENT_ID / X_CLIENT_SECRET, and no X_ENV_FILE to read them from:
    // a fresh install with nothing configured. The server must fail BEFORE the
    // handshake with a message that names the fix, not an opaque crash.
    env: { HOME: process.env.HOME, PATH: process.env.PATH, X_ENV_FILE: "" },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));

  const exitCode = await new Promise((resolve) => child.on("exit", resolve));
  assert.notEqual(exitCode, 0, "must exit non-zero when creds are missing");
  assert.match(stderr, /missing X_CLIENT_ID\/X_CLIENT_SECRET/, "fatal message names the missing vars");
  assert.match(stderr, /\.mcpb|X_ENV_FILE|auth_instructions/, "fatal message points at how to fix it");
});

test("blank-string credentials are treated as missing (normalized), not accepted", async () => {
  const child = spawn(process.execPath, [serverPath], {
    // Empty strings are exactly what an unset .mcpb user_config field injects.
    env: {
      HOME: process.env.HOME, PATH: process.env.PATH,
      X_CLIENT_ID: "   ", X_CLIENT_SECRET: "", X_ENV_FILE: "",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));

  const exitCode = await new Promise((resolve) => child.on("exit", resolve));
  assert.notEqual(exitCode, 0, "blank creds must not be accepted as real");
  assert.match(stderr, /missing X_CLIENT_ID\/X_CLIENT_SECRET/);
});
