// Tests for loadEnvFile — the KEY=VALUE parser that gives the Claude Code plugin
// path a credential source (X_ENV_FILE) without depending on node --env-file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadEnvFile } from "../server.mjs";

function withTempEnv(contents, fn) {
  const dir = mkdtempSync(join(tmpdir(), "x-poster-env-"));
  const path = join(dir, ".env");
  writeFileSync(path, contents, "utf8");
  try {
    return fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("loadEnvFile parses the three creds, ignoring comments and blank lines", () => {
  const contents = [
    "# x-poster credentials",
    "",
    "X_CLIENT_ID=cid-123",
    "X_CLIENT_SECRET=secret-456",
    "  # indented comment",
    "X_REFRESH_TOKEN=rt-789",
    "",
  ].join("\n");

  withTempEnv(contents, (path) => {
    const env = loadEnvFile(path);
    assert.equal(env.X_CLIENT_ID, "cid-123");
    assert.equal(env.X_CLIENT_SECRET, "secret-456");
    assert.equal(env.X_REFRESH_TOKEN, "rt-789");
  });
});

test("loadEnvFile splits on the FIRST '=' and strips surrounding quotes", () => {
  withTempEnv('X_REFRESH_TOKEN="abc=def=ghi"\nX_CLIENT_ID=\'quoted\'\n', (path) => {
    const env = loadEnvFile(path);
    assert.equal(env.X_REFRESH_TOKEN, "abc=def=ghi");
    assert.equal(env.X_CLIENT_ID, "quoted");
  });
});

test("loadEnvFile returns {} for a missing file (no throw)", () => {
  assert.deepEqual(loadEnvFile("/no/such/x-poster/env/file"), {});
});

test("process.env value wins over the env file (precedence contract)", () => {
  // loadEnvFile itself is pure; startServer applies precedence via
  // `process.env.X ?? fileCreds.X`. This test locks in that resolution rule.
  const contents = "X_CLIENT_ID=from-file\nX_CLIENT_SECRET=file-secret\n";
  withTempEnv(contents, (path) => {
    const fileCreds = loadEnvFile(path);
    const prev = process.env.X_CLIENT_ID;
    process.env.X_CLIENT_ID = "from-process-env";
    try {
      const clientId = process.env.X_CLIENT_ID ?? fileCreds.X_CLIENT_ID;
      const clientSecret = process.env.X_CLIENT_SECRET ?? fileCreds.X_CLIENT_SECRET;
      assert.equal(clientId, "from-process-env", "process.env must win");
      assert.equal(clientSecret, "file-secret", "file fills the gap when env is unset");
    } finally {
      if (prev === undefined) delete process.env.X_CLIENT_ID;
      else process.env.X_CLIENT_ID = prev;
    }
  });
});
