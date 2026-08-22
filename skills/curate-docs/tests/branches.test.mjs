/**
 * A citation to a file that exists on another branch is EARLY, not broken.
 *
 * Both instances came from one real session on marketing-intel, and both were about to be
 * mis-reported: `docs/local-scheduler.md` (cited by CLAUDE.md and DECISIONS.md, present only
 * on `feat/social-post-ingest`) and `docs/plans/instagram-app-review.md`. Reported as
 * DANGLING, the obvious fix is to delete a correct forward reference.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { classifyDangling, otherRefs } from "../lib/branches.mjs";

const git = (d, ...a) => execFileSync("git", ["-C", d, ...a], { stdio: ["ignore", "pipe", "ignore"] });

/** main has a doc citing two absent files; one exists on a feature branch, one nowhere. */
function repo() {
  const d = mkdtempSync(path.join(tmpdir(), "cd-br-"));
  git(d, "init", "-q", "-b", "main");
  git(d, "config", "user.email", "t@t"); git(d, "config", "user.name", "t");
  mkdirSync(path.join(d, "docs"));
  writeFileSync(path.join(d, "STATE.md"), "# hub\nsee [sched](./docs/local-scheduler.md) and [gone](./docs/never.md)\n");
  git(d, "add", "-A"); git(d, "commit", "-qm", "init");

  git(d, "checkout", "-qb", "feat/scheduler");
  writeFileSync(path.join(d, "docs/local-scheduler.md"), "# scheduler\n");
  git(d, "add", "-A"); git(d, "commit", "-qm", "add scheduler doc");
  git(d, "checkout", "-q", "main");
  return d;
}

const dang = (d) => [
  { from: path.join(d, "STATE.md"), cites: "./docs/local-scheduler.md" },
  { from: path.join(d, "STATE.md"), cites: "./docs/never.md" },
];

test("a citation present on another branch is UNMERGED, not broken", () => {
  const d = repo();
  const r = classifyDangling(d, dang(d));
  assert.equal(r.status, "ok");
  assert.deepEqual(r.unmerged.map((u) => u.cites), ["./docs/local-scheduler.md"]);
  assert.deepEqual(r.unmerged[0].refs, ["feat/scheduler"], "the branch carrying it must be named");
  assert.equal(r.unmerged[0].rel, "docs/local-scheduler.md");
});

test("a citation present on NO ref stays broken — the check must not excuse everything", () => {
  const d = repo();
  const r = classifyDangling(d, dang(d));
  assert.deepEqual(r.broken.map((b) => b.cites), ["./docs/never.md"]);
});

test("the current branch is excluded from the refs searched", () => {
  const d = repo();
  const { refs } = otherRefs(d);
  assert.ok(!refs.includes("main"), "finding a file on the branch you are already on proves nothing");
  assert.ok(refs.includes("feat/scheduler"));
});

test("how many refs were actually searched is REPORTED, never assumed", () => {
  const d = repo();
  const r = classifyDangling(d, dang(d));
  assert.equal(r.refsChecked, 1, "0 refs checked and 0 found are different facts");
});

test("in a non-git directory the status says so and nothing is silently excused", () => {
  const d = mkdtempSync(path.join(tmpdir(), "cd-nogit-"));
  writeFileSync(path.join(d, "STATE.md"), "# x\n");
  const r = classifyDangling(d, [{ from: path.join(d, "STATE.md"), cites: "./docs/x.md" }]);
  assert.equal(r.status, "no-git");
  assert.equal(r.refsChecked, 0);
  assert.equal(r.broken.length, 1, "with no refs to check, every dangling citation stays broken");
  assert.equal(r.unmerged.length, 0);
});

test("a repo with no other branches leaves every dangling citation broken", () => {
  const d = repo();
  git(d, "branch", "-qD", "feat/scheduler");
  const r = classifyDangling(d, dang(d));
  assert.equal(r.unmerged.length, 0);
  assert.equal(r.broken.length, 2);
});
