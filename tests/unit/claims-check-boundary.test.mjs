/**
 * `lib/claims/check.mjs`'s NORMATIVE boundary: no model/SDK client, no
 * network call. This is the point of Phase 2 lane 1 — the module header
 * says as much, and this test is what makes that a checked property rather
 * than a comment nobody enforces (`rule:enforcement-watches-itself`: a
 * hazard described fluently in prose is not a check for it).
 *
 * Reads the module's own SOURCE TEXT rather than importing it and
 * inspecting its exports, because the forbidden thing (a `fetch` call, an
 * SDK import) can exist in a code path this test's own call graph never
 * reaches — a source scan cannot be fooled by "well, nothing calls that
 * branch in this test run."
 *
 * WIDENED, PHASE 2A. The boundary is not a `check.mjs` property, it is a
 * `lib/claims/` property — every lane in this directory poses questions and
 * stores answers, none of them judges. Before this widening, `judge.mjs` and
 * `runs.mjs` each carried their OWN hand-copied version of these same four
 * assertions (`claims-judge.test.mjs`, `claims-runs.test.mjs`), and
 * `contradict.mjs` — landed in between — carried none at all: nobody had
 * copied the boilerplate for it. That is `rule:enforcement-watches-itself`
 * exactly: a check that must be manually re-added per new file is a check
 * that silently stops applying the day someone forgets, and it had already
 * happened once. So this file now walks every `.mjs` under `lib/claims/` and
 * applies the same four checks to each — `restate.mjs` (this phase) and any
 * lane added after it inherit the boundary for free, with no copy-paste step
 * to skip.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const MODULE_PATH = fileURLToPath(new URL("../../lib/claims/check.mjs", import.meta.url));
const SOURCE = readFileSync(MODULE_PATH, "utf8");

// Comments are stripped crudely (line + block) before scanning, so this
// test's OWN explanatory prose about the forbidden strings (which quotes
// them) can't accidentally trip the very check it defines. A perfect
// comment stripper isn't needed — only good enough that a real import or
// call, which must be on a live code line, still gets caught.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const CODE = stripComments(SOURCE);

test("lib/claims/check.mjs imports no model/SDK client", () => {
  for (const forbidden of ["@anthropic-ai", "openai", "anthropic", "langchain"]) {
    assert.doesNotMatch(
      CODE,
      new RegExp(`from\\s+["'][^"']*${forbidden}[^"']*["']`, "i"),
      `must not import anything matching "${forbidden}"`,
    );
  }
});

test("lib/claims/check.mjs makes no network call", () => {
  assert.doesNotMatch(CODE, /\bfetch\s*\(/, "must not call fetch()");
  assert.doesNotMatch(CODE, /from\s+["']node:https?["']/, "must not import node:http or node:https");
  assert.doesNotMatch(CODE, /require\(\s*["']https?["']\s*\)/, "must not require http/https");
});

test("lib/claims/check.mjs's only subprocess call is a local, read-only git ref check", () => {
  // execFileSync IS present (branch-citation check) — that's allowed; the
  // property under test is that every invocation is `git`, and every git
  // subcommand used is `rev-parse --verify` against a LOCAL ref path
  // (refs/heads/... or refs/remotes/origin/...), never `fetch`, `pull`,
  // `clone`, `push`, or `ls-remote` (the network-touching git verbs).
  const spawnCalls = [...CODE.matchAll(/execFileSync\(\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(spawnCalls.length > 0, "expected at least one execFileSync call (the branch check)");
  for (const bin of spawnCalls) assert.equal(bin, "git", `subprocess must be "git", found "${bin}"`);

  for (const verb of ["fetch", "pull", "clone", "push", "ls-remote", "remote"]) {
    assert.doesNotMatch(
      CODE,
      new RegExp(`["']${verb}["']`),
      `must not shell out to a network-touching git verb ("${verb}")`,
    );
  }
  assert.match(CODE, /"rev-parse"/, "expected the local rev-parse --verify pattern");
});

test("lib/claims/check.mjs does not print — rendering stays in commands/claims.mjs", () => {
  // commands/ansi.mjs's own header: "zero of 58 lib/ modules contain an
  // ANSI escape, and none of them print." This module is lib/, so it holds
  // to the same rule this repo already enforces elsewhere.
  assert.doesNotMatch(CODE, /console\.(log|error|warn|info)\s*\(/, "lib/claims/check.mjs must not print");
});

// ── widened: every module under lib/claims/ holds the same boundary ────────
//
// Deliberately generic rather than a growing hand-maintained list: a NEW file
// dropped into `lib/claims/` is covered the moment it exists, with nothing to
// remember to update here. `check.mjs`'s own additional assertions (it is the
// one module permitted a subprocess at all, and it must actually contain
// one) stay above, unchanged, as file-specific tests.
const CLAIMS_DIR = fileURLToPath(new URL("../../lib/claims/", import.meta.url));
const ALL_CLAIMS_MODULES = readdirSync(CLAIMS_DIR)
  .filter((f) => f.endsWith(".mjs"))
  .sort()
  .map((f) => path.join(CLAIMS_DIR, f));

for (const modPath of ALL_CLAIMS_MODULES) {
  const label = `lib/claims/${path.basename(modPath)}`;
  const code = stripComments(readFileSync(modPath, "utf8"));

  test(`${label} imports no model/SDK client`, () => {
    for (const forbidden of ["@anthropic-ai", "openai", "anthropic", "langchain"]) {
      assert.doesNotMatch(
        code,
        new RegExp(`from\\s+["'][^"']*${forbidden}[^"']*["']`, "i"),
        `${label} must not import anything matching "${forbidden}"`,
      );
    }
  });

  test(`${label} makes no network call`, () => {
    assert.doesNotMatch(code, /\bfetch\s*\(/, `${label} must not call fetch()`);
    assert.doesNotMatch(code, /from\s+["']node:https?["']/, `${label} must not import node:http or node:https`);
    assert.doesNotMatch(code, /require\(\s*["']https?["']\s*\)/, `${label} must not require http/https`);
  });

  test(`${label}'s only permitted subprocess, if any, is a local read-only git ref check`, () => {
    // Any of execFileSync/spawnSync/execSync is fine ONLY as a `git` call, and
    // only for the local, read-only verbs `check.mjs` already uses. A module
    // with zero such calls (every lane but `check.mjs`, today) trivially
    // passes — this does not require a subprocess to exist, only constrains
    // one if it does.
    const calls = [...code.matchAll(/\b(?:execFileSync|spawnSync|execSync)\s*\(\s*"([^"]+)"/g)].map((m) => m[1]);
    for (const bin of calls) assert.equal(bin, "git", `${label}: subprocess must be "git", found "${bin}"`);
    for (const verb of ["fetch", "pull", "clone", "push", "ls-remote", "remote"]) {
      assert.doesNotMatch(
        code,
        new RegExp(`["']${verb}["']`),
        `${label} must not shell out to a network-touching git verb ("${verb}")`,
      );
    }
  });

  test(`${label} does not print — rendering stays in commands/claims.mjs`, () => {
    assert.doesNotMatch(code, /console\.(log|error|warn|info)\s*\(/, `${label} must not print`);
  });
}

test("the widened scan actually covers more than just check.mjs", () => {
  // A check that silently scans one file forever is the exact failure this
  // widening exists to prevent — assert the corpus is not degenerate.
  assert.ok(ALL_CLAIMS_MODULES.length >= 5, `expected several lib/claims/ modules, found ${ALL_CLAIMS_MODULES.length}`);
  assert.ok(
    ALL_CLAIMS_MODULES.some((p) => p.endsWith("restate.mjs")),
    "the new Phase 2a lane must be part of what this scans",
  );
});
