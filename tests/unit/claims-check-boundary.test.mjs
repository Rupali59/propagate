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
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
