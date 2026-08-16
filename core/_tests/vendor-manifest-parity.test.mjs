// vendor-manifest-parity.test.mjs — the vendor script, its guard, and the filesystem must
// agree on WHAT gets vendored and WHERE.
//
// vendor-sync.test.mjs proves the copies match their sources. It cannot prove the list is
// complete: it iterates its own hardcoded array, so a module missing from that array is a
// module it never checks. The same list is hardcoded again in scripts/vendor-core.sh, and
// the surface list is hardcoded in both too. Four lists, zero cross-checks.
//
// Concretely, adding core/foo.mjs and wiring only the script yields:
//   - vendor-core.sh copies it            → the copies exist
//   - vendor-sync never asserts it        → drift in foo.mjs is invisible forever
// A guard that silently stops guarding is worse than no guard, because the suite is green.
//
// This file derives the truth from the filesystem and asserts both hardcoded lists match it.
// Dependency-free on purpose.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../..", import.meta.url).pathname;

const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const sorted = (xs) => [...xs].sort();

// --- source of truth: what is actually in core/ -----------------------------
const actualModules = sorted(
  readdirSync(join(ROOT, "core")).filter((f) => f.endsWith(".mjs")),
);

// --- list 1: scripts/vendor-core.sh  `for f in a.mjs b.mjs …; do` -----------
const vendorSh = read("scripts/vendor-core.sh");
const shModules = sorted(
  (vendorSh.match(/for f in ([^;]+);/)?.[1] ?? "").trim().split(/\s+/).filter(Boolean),
);

// --- list 2: scripts/vendor-core.sh  `for dest in "a" "b" "c"; do` ----------
const shSurfaces = sorted(
  [...(vendorSh.match(/for dest in ((?:"[^"]+"\s*)+);/)?.[1] ?? "").matchAll(/"([^"]+)"/g)]
    .map((m) => m[1]),
);

// --- list 3 & 4: the guard's own hardcoded arrays ---------------------------
const syncSrc = read("core/_tests/vendor-sync.test.mjs");
const syncModules = sorted(
  [...(syncSrc.match(/for \(const f of \[([^\]]+)\]\)/)?.[1] ?? "").matchAll(/"([^"]+)"/g)]
    .map((m) => m[1]),
);
const syncSurfaces = sorted(
  [...(syncSrc.match(/const SURFACES = \[([^\]]+)\]/)?.[1] ?? "").matchAll(/"([^"]+)"/g)]
    .map((m) => m[1]),
);

test("the parser found all four lists (guards this file against silently passing)", () => {
  // If a refactor changes the shape of either file the regexes stop matching, and every
  // assertion below would compare garbage — reporting "the lists disagree" when the real
  // fault is "the parser broke". Non-empty is NOT enough: indirecting the loop through a
  // shell variable (`for f in $MODULES`) yields a plausible-looking one-element list.
  // So assert the parsed values are SHAPED like what they claim to be.
  const lists = {
    "scripts/vendor-core.sh module list": shModules,
    "core/_tests/vendor-sync.test.mjs module list": syncModules,
  };
  for (const [where, list] of Object.entries(lists)) {
    assert.ok(list.length > 0, `could not parse the ${where} — the regex matched nothing`);
    for (const m of list) {
      assert.match(
        m,
        /^[a-z0-9-]+\.mjs$/,
        `parsed "${m}" from the ${where}, which is not a module filename — the parser is ` +
          `reading a shape it does not understand, so every check below is meaningless`,
      );
    }
  }

  const surfaceLists = {
    "scripts/vendor-core.sh surface list": shSurfaces,
    "core/_tests/vendor-sync.test.mjs SURFACES": syncSurfaces,
  };
  for (const [where, list] of Object.entries(surfaceLists)) {
    assert.ok(list.length > 0, `could not parse the ${where} — the regex matched nothing`);
    for (const s of list) {
      assert.match(
        s,
        /^[a-z0-9\-/.]+$/i,
        `parsed "${s}" from the ${where}, which is not a directory path`,
      );
    }
  }
});

test("vendor-core.sh vendors every module in core/", () => {
  assert.deepEqual(
    shModules,
    actualModules,
    "scripts/vendor-core.sh:4 disagrees with the contents of core/ — a new module there is " +
      "never copied to any surface, so the surfaces silently run stale code",
  );
});

test("vendor-sync.test.mjs checks every module in core/", () => {
  assert.deepEqual(
    syncModules,
    actualModules,
    "core/_tests/vendor-sync.test.mjs:9 disagrees with the contents of core/ — the missing " +
      "module is copied but never asserted, so drift in it is invisible",
  );
});

test("the two surface lists agree", () => {
  assert.deepEqual(
    syncSurfaces,
    shSurfaces,
    "scripts/vendor-core.sh:5 and core/_tests/vendor-sync.test.mjs:6 disagree on the " +
      "surface list — a surface is either unvendored or unchecked",
  );
});

test("every declared surface exists on disk", () => {
  for (const s of shSurfaces) {
    assert.doesNotThrow(
      () => readdirSync(join(ROOT, s)),
      `surface "${s}" is declared in scripts/vendor-core.sh but does not exist`,
    );
  }
});
