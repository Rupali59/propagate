/**
 * `node cli.mjs plans --check` — root handling and the JSON contract, exercised
 * as a real subprocess so the argv parsing in commands/plans.mjs and the
 * dispatch arm in cli.mjs are covered, not just the pure lib functions.
 *
 * Fixtures only, never the live tree — the default (no --root) corpus is
 * exercised in tests/unit/plans.test.mjs against temp repos; here the point is
 * the CLI surface: exit codes, --root repeated, and bad-root vs. empty-root
 * wording.
 *
 * Run: `npm test` (G56 — never bare `node --test`).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(REPO, "cli.mjs");

function tmp(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function put(root, rel, body) {
  const p = path.join(root, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, body, "utf8");
  return p;
}

function run(args, opts = {}) {
  try {
    const stdout = execFileSync("node", [CLI, ...args], { encoding: "utf8", cwd: REPO, ...opts });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status, stdout: err.stdout?.toString() ?? "", stderr: err.stderr?.toString() ?? "" };
  }
}

test("plans --check --root <missing path> exits non-zero and names the path", () => {
  const bogus = "/definitely/does/not/exist/plans-cli-test";
  const r = run(["plans", "--check", "--root", bogus]);
  assert.notEqual(r.code, 0);
  assert.match(r.stdout, /missing/);
  assert.ok(r.stdout.includes(bogus), "the offending path must be named in the output, not just 'a root failed'");
});

test("plans --check --root <a file, not a directory> exits non-zero", () => {
  const dir = tmp("plans-cli-notdir-");
  const file = put(dir, "not-a-dir.md", "x");
  const r = run(["plans", "--check", "--root", file]);
  assert.notEqual(r.code, 0);
  assert.match(r.stdout, /not-a-directory/);
});

test("plans --check --root <valid, empty dir> exits 0 with wording DIFFERENT from the bad-root case", () => {
  const dir = tmp("plans-cli-empty-");
  const r = run(["plans", "--check", "--root", dir]);
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.stdout, /missing|not-a-directory|unreadable/, "an empty-but-valid root must not print any bad-root reason");
  assert.match(r.stdout, /none classified as a plan/);
});

test("plans --check --root A --root B walks BOTH, not just the last one", () => {
  const a = tmp("plans-cli-multi-a-");
  const b = tmp("plans-cli-multi-b-");
  put(a, "plans/slug-one.md", "# one");
  put(b, "plans/slug-two.md", "# two");
  const r = run(["plans", "--check", "--root", a, "--root", b, "--json"]);
  assert.equal(r.code, 0);
  const report = JSON.parse(r.stdout);
  assert.equal(report.results.length, 2, "both --root arguments must produce a result, not just the last");
  const roots = report.results.map((x) => x.root);
  assert.ok(roots.includes(a) && roots.includes(b));
  const totalPlans = report.results.reduce((n, x) => n + (x.plans?.length ?? 0), 0);
  assert.equal(totalPlans, 2, "one plan from each root");
});

test("plans --check --root marks every plan external (path-classified), regardless of dated basename", () => {
  const root = tmp("plans-cli-external-");
  put(root, "plans/undated-slug.md", "# a session plan, no date, no frontmatter");
  const r = run(["plans", "--check", "--root", root, "--json"]);
  const report = JSON.parse(r.stdout);
  assert.equal(report.results[0].external, true);
  assert.equal(report.results[0].plans.length, 1, "an undated slug under plans/ must still be classified as a plan for an external root");
});

test("plans --check with no --root at all classifies the in-repo corpus (external: false)", () => {
  const r = run(["plans", "--check", "--json"]);
  assert.equal(r.code, 0);
  const report = JSON.parse(r.stdout);
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0].external, false);
  assert.equal(report.results[0].root, REPO);
});

test("plans is listed in cli.mjs's usage string", () => {
  const r = run(["not-a-real-mode"]);
  assert.notEqual(r.code, 0);
  // Usage prints to stderr via console.error; execFileSync captured stdout above
  // is empty on failure for other commands, so re-run capturing stderr directly.
  const out = (() => {
    try {
      execFileSync("node", [CLI, "not-a-real-mode"], { encoding: "utf8", cwd: REPO });
    } catch (err) {
      return err.stderr?.toString() ?? "";
    }
    return "";
  })();
  assert.match(out, /\bplans\b/, "the usage string printed on an unknown mode must mention 'plans'");
});
