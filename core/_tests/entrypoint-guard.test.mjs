// entrypoint-guard.test.mjs — the CLI must actually run when invoked.
//
// x-post.mjs and x-auth.mjs guard main() with a comparison against import.meta.url. The
// naive form, `file://${process.argv[1]}`, is wrong three ways and every one of them fails
// SILENTLY — main never runs, nothing is printed, nothing is posted, exit code 0:
//
//   1. a path containing a space: argv[1] has " ", import.meta.url has "%20"
//   2. a symlinked install:       argv[1] is the link, import.meta.url is the target
//   3. macOS /tmp:                itself a symlink to /private/tmp, so (2) fires there too
//
// Verified 2026-08-14: pre-fix, `x-post.mjs --dry-run --text "..."` under a spaced path
// printed nothing and exited 0. A user reads that as success.
//
// This asserts on SOURCE rather than spawning, so it stays dependency-free and fast, and
// pairs with the behavioural spawn check below which is the one that would actually catch
// a regression in a new entrypoint.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("../..", import.meta.url).pathname;
const ENTRYPOINTS = [
  "plugins/x-poster/bin/x-post.mjs",
  "plugins/x-poster/bin/x-auth.mjs",
];

test("no entrypoint uses the naive file:// + argv[1] guard", () => {
  for (const rel of ENTRYPOINTS) {
    const src = readFileSync(join(ROOT, rel), "utf8");
    assert.doesNotMatch(
      src,
      /import\.meta\.url === `file:\/\/\$\{process\.argv\[1\]\}`/,
      `${rel} uses the naive run guard — it silently no-ops on spaced paths, symlinked ` +
        `installs, and macOS /tmp. Use pathToFileURL(realpathSync(process.argv[1])).href`,
    );
  }
});

test("every entrypoint resolves argv[1] before comparing", () => {
  for (const rel of ENTRYPOINTS) {
    const src = readFileSync(join(ROOT, rel), "utf8");
    assert.match(
      src,
      /pathToFileURL\(realpathSync\(process\.argv\[1\]\)\)\.href/,
      `${rel} must compare against pathToFileURL(realpathSync(argv[1])).href`,
    );
  }
});

test("x-post.mjs actually produces output through a spaced, symlinked path", () => {
  // The behavioural check: this is what silently broke. A dry run needs no creds and
  // spends nothing.
  const dir = mkdtempSync(join(tmpdir(), "x poster guard ")); // NOTE: spaces are the point
  const link = join(dir, "plug");
  symlinkSync(join(ROOT, "plugins/x-poster"), link);

  const out = execFileSync(
    process.execPath,
    [join(link, "bin", "x-post.mjs"), "--dry-run", "--text", "guard check"],
    { encoding: "utf8" },
  );

  assert.notEqual(out.trim(), "", "CLI produced no output — the run guard did not fire");
  assert.match(out, /guard check/, "CLI ran but did not echo the plan");
});
