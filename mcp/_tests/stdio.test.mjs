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

test("server completes an MCP stdio handshake and lists all three tools", async () => {
  const child = spawn(process.execPath, [serverPath], {
    env: {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      X_CLIENT_ID: "test-client-id",
      X_CLIENT_SECRET: "test-client-secret",
      X_REFRESH_TOKEN: "test-refresh-token",
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
      ["auth_instructions", "preview_post", "publish_post"],
    );
    // Schemas must survive the zod → JSON Schema round-trip with params intact.
    for (const tool of ["preview_post", "publish_post"]) {
      assert.ok(byName[tool].inputSchema?.properties?.text, `${tool} exposes 'text'`);
      assert.ok(byName[tool].inputSchema?.properties?.thread, `${tool} exposes 'thread'`);
    }
    assert.ok(byName.publish_post.inputSchema.properties.confirm_nonce, "publish_post exposes 'confirm_nonce'");
  } finally {
    child.kill();
  }
});
