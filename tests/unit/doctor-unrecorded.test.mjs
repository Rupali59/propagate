/**
 * doctor-unrecorded.test.mjs — #131, lib/report/doctor/unrecorded.mjs.
 *
 * Fixture repos are real git repos in a temp dir; ages are set with utimes, never by waiting.
 * Each guard has a hostile case written as a literal (a stale record that must be named, a
 * file edited today that must not be, a branch with no upstream that must not read as zero).
 *
 * Run: `PROPAGATE_STATE_DIR="${TMPDIR:-/tmp}/propagate-test-state" node --test
 * tests/unit/doctor-unrecorded.test.mjs` (G56).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Reporter } from "../../lib/report/doctor/reporter.mjs";
import { checkUnrecorded, isRecordPath, parseStatus, SEVERITY } from "../../lib/report/doctor/unrecorded.mjs";

const DAY = 86400000;
const NOW = Date.now();

const sh = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

function tmp() {
  return mkdtempSync(path.join(tmpdir(), "unrecorded-"));
}

/** A repo with one commit on `main`. */
function mkRepo(parent, name) {
  const dir = path.join(parent, name);
  mkdirSync(dir, { recursive: true });
  sh(dir, "init", "-q", "-b", "main");
  writeFileSync(path.join(dir, "README.md"), "x\n");
  sh(dir, "add", ".");
  sh(dir, "commit", "-q", "-m", "init");
  return dir;
}

/** Give `dir` a bare remote (kept outside the scan roots) and set main's upstream. */
function withUpstream(dir, bareParent) {
  const bare = path.join(bareParent, `${path.basename(dir)}.git`);
  sh(bareParent, "init", "-q", "--bare", bare);
  sh(dir, "remote", "add", "origin", bare);
  sh(dir, "push", "-q", "-u", "origin", "main");
}

function write(dir, rel, ageDays) {
  const f = path.join(dir, rel);
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, "record\n");
  if (ageDays > 0) {
    const t = new Date(NOW - ageDays * DAY);
    utimesSync(f, t, t);
  }
}

/** scan root + a sibling dir for bare remotes, so remotes are never mistaken for repos. */
function fixture() {
  const base = tmp();
  const root = path.join(base, "scan");
  const remotes = path.join(base, "remotes");
  mkdirSync(root);
  mkdirSync(remotes);
  return { base, root, remotes };
}

function run(root, opts = {}) {
  const reporter = new Reporter();
  const r = checkUnrecorded({ reporter, roots: [root], workspaces: [], now: NOW, ...opts });
  return { r, entries: reporter.drain(), problems: reporter.problems };
}
const warns = (e) => e.filter((x) => x.kind === "warn");
const text = (e) => e.map((x) => `${x.label} | ${x.detail}`).join("\n");

test("a stale uncommitted STATE.md is reported with repo, branch, file and age", () => {
  const { base, root, remotes } = fixture();
  const repo = mkRepo(root, "alpha");
  withUpstream(repo, remotes);
  write(repo, "propagation/STATE.md", 20);
  const { r, entries, problems } = run(root);
  assert.equal(r.stale, 1);
  const w = warns(entries).filter((x) => x.label === "record uncommitted past threshold");
  assert.equal(w.length, 1);
  assert.match(w[0].detail, /^alpha \(main\) propagation\/STATE\.md - untracked, 20 days old$/);
  assert.equal(problems, 0, "warn-only: doctor must not go red on a normal working day (#129)");
  rmSync(base, { recursive: true, force: true });
});

test("a clean repo passes, and the pass states what it scanned", () => {
  const { base, root, remotes } = fixture();
  const repo = mkRepo(root, "clean");
  withUpstream(repo, remotes);
  const { entries, problems } = run(root);
  assert.equal(warns(entries).length, 0, text(entries));
  const info = entries.find((x) => x.kind === "info");
  assert.ok(info, text(entries));
  assert.match(info.detail, /^nothing to report - scanned 1 repo\(s\)/);
  assert.equal(problems, 0);
  rmSync(base, { recursive: true, force: true });
});

test("a record edited today is excluded, even with the threshold at 0", () => {
  const { base, root, remotes } = fixture();
  const repo = mkRepo(root, "live");
  withUpstream(repo, remotes);
  write(repo, "STATE.md", 0);
  write(repo, "DECISIONS.md", 0);
  // now is later than the files' mtime; with now < mtime the age is negative and the guard is never needed
  const { r } = run(root, { days: 0, now: Date.now() + 5000 });
  assert.equal(r.stale, 0);
  rmSync(base, { recursive: true, force: true });
});

test("the age threshold: just under N days is excluded, N and over is reported", () => {
  const { base, root, remotes } = fixture();
  const repo = mkRepo(root, "edge");
  withUpstream(repo, remotes);
  write(repo, "GOTCHAS.md", 6);
  write(repo, "TODOS.md", 7);
  const { entries } = run(root, { days: 7 });
  const d = warns(entries).map((x) => x.detail).join("\n");
  assert.match(d, /TODOS\.md/);
  assert.doesNotMatch(d, /GOTCHAS\.md/);
  rmSync(base, { recursive: true, force: true });
});

test("a stale non-record file is not reported; modified, staged and untracked records are", () => {
  const { base, root } = fixture();
  const repo = mkRepo(root, "mix");
  write(repo, "notes.txt", 30);
  write(repo, "src/index.js", 30);
  write(repo, ".propagates.yml", 1);
  sh(repo, "add", ".propagates.yml");
  sh(repo, "commit", "-q", "-m", "sidecar");
  writeFileSync(path.join(repo, ".propagates.yml"), "changed\n"); // content differs, so git sees it modified
  const t15 = new Date(NOW - 15 * DAY);
  utimesSync(path.join(repo, ".propagates.yml"), t15, t15);
  write(repo, "docs/plans/p1.md", 40);
  sh(repo, "add", "docs/plans/p1.md"); // staged, uncommitted
  write(repo, "rules/some-rule.md", 12); // untracked rule
  const { entries } = run(root);
  const d = warns(entries).filter((x) => x.label === "record uncommitted past threshold").map((x) => x.detail);
  assert.equal(d.length, 3, d.join("\n"));
  assert.ok(d.some((x) => /\.propagates\.yml - modified, 15 days/.test(x)), d.join("\n"));
  assert.ok(d.some((x) => /docs\/plans\/p1\.md - staged, 40 days/.test(x)), d.join("\n"));
  assert.ok(d.some((x) => /rules\/some-rule\.md - untracked, 12 days/.test(x)), d.join("\n"));
  assert.ok(!d.some((x) => /notes\.txt|index\.js/.test(x)));
  rmSync(base, { recursive: true, force: true });
});

test("a record path with a space in its name is parsed whole (NUL-separated status)", () => {
  const { base, root } = fixture();
  const repo = mkRepo(root, "spaced");
  write(repo, "My Project/STATE.md", 9);
  const { entries } = run(root);
  assert.match(text(entries), /My Project\/STATE\.md/);
  rmSync(base, { recursive: true, force: true });
});

test("0 repos scanned says the scan is blind, and does not report clean", () => {
  const { base, root } = fixture(); // exists, holds no repos
  const { r, entries } = run(root);
  assert.equal(r.scanned, 0);
  assert.doesNotMatch(text(entries), /nothing to report/, "a blind scan must not read as clean");
  assert.match(text(entries), /scan is blind \| scanned 0 repos/);
  rmSync(base, { recursive: true, force: true });
});

test("a branch ahead of its upstream is reported with the count", () => {
  const { base, root, remotes } = fixture();
  const repo = mkRepo(root, "ahead");
  withUpstream(repo, remotes);
  writeFileSync(path.join(repo, "a.txt"), "1");
  sh(repo, "add", ".");
  sh(repo, "commit", "-q", "-m", "one");
  writeFileSync(path.join(repo, "b.txt"), "2");
  sh(repo, "add", ".");
  sh(repo, "commit", "-q", "-m", "two");
  const { r, entries } = run(root);
  assert.equal(r.branches, 1);
  assert.match(text(entries), /ahead \(main\) - 2 commit\(s\) not on origin\/main/);
  rmSync(base, { recursive: true, force: true });
});

test("a branch with no upstream says 'no upstream', never zero", () => {
  const { base, root } = fixture();
  mkRepo(root, "lonely"); // no remote at all
  const { r, entries } = run(root);
  assert.equal(r.branches, 1);
  assert.match(text(entries), /lonely \(main\) - no upstream/);
  assert.doesNotMatch(text(entries), /nothing to report/);
  rmSync(base, { recursive: true, force: true });
});

test("a branch whose upstream ref is gone is reported as such", () => {
  const { base, root, remotes } = fixture();
  const repo = mkRepo(root, "gone");
  withUpstream(repo, remotes);
  sh(repo, "checkout", "-q", "-b", "topic");
  sh(repo, "push", "-q", "-u", "origin", "topic");
  writeFileSync(path.join(repo, "t.txt"), "t");
  sh(repo, "add", ".");
  sh(repo, "commit", "-q", "-m", "topic work"); // on no remote
  sh(repo, "update-ref", "-d", "refs/remotes/origin/topic");
  const { entries } = run(root);
  assert.match(text(entries), /gone \(topic\) - upstream origin\/topic is gone; 1 commit\(s\) on no remote/);
  rmSync(base, { recursive: true, force: true });
});

test("a no-upstream branch whose commits are all on a remote is counted in the summary, not listed", () => {
  const { base, root, remotes } = fixture();
  const repo = mkRepo(root, "pushed");
  withUpstream(repo, remotes);
  sh(repo, "branch", "same-as-main"); // no upstream, but its commit is on origin/main
  const { r, entries } = run(root);
  assert.equal(r.branches, 0);
  assert.equal(warns(entries).length, 0, text(entries));
  assert.match(entries.find((x) => x.kind === "info").detail, /1 branch\(es\) without a usable upstream whose commits are all on a remote \(not listed\)/);
  rmSync(base, { recursive: true, force: true });
});

test("worktrees of one repo list their shared branches once", () => {
  const { base, root, remotes } = fixture();
  const repo = mkRepo(root, "main-checkout");
  withUpstream(repo, remotes);
  sh(repo, "checkout", "-q", "-b", "wip");
  writeFileSync(path.join(repo, "w.txt"), "w");
  sh(repo, "add", ".");
  sh(repo, "commit", "-q", "-m", "wip");
  sh(repo, "checkout", "-q", "main");
  sh(repo, "worktree", "add", "-q", path.join(root, "linked"), "wip");
  const { r, entries } = run(root);
  assert.equal(r.scanned, 2, "both checkouts are scanned for uncommitted records");
  assert.equal(r.branches, 1, text(entries));
  rmSync(base, { recursive: true, force: true });
});

test("a shared branch is listed under the main checkout, not under a worktree that sorts first", () => {
  const { base, root, remotes } = fixture();
  const repo = mkRepo(root, "z-main");
  withUpstream(repo, remotes);
  sh(repo, "checkout", "-q", "-b", "wip");
  writeFileSync(path.join(repo, "w.txt"), "w");
  sh(repo, "add", ".");
  sh(repo, "commit", "-q", "-m", "wip");
  sh(repo, "checkout", "-q", "main");
  sh(repo, "worktree", "add", "-q", path.join(root, "a-linked"), "wip");
  const { entries } = run(root);
  const w = warns(entries).filter((x) => x.label === "branch has commits not on its upstream");
  assert.equal(w.length, 1, text(entries));
  assert.match(w[0].detail, /^z-main \(wip\)/);
  rmSync(base, { recursive: true, force: true });
});

test("a repo git cannot read is reported, not skipped", () => {
  const { base, root } = fixture();
  mkdirSync(path.join(root, "broken", ".git"), { recursive: true }); // .git dir with no repo inside
  const { entries } = run(root);
  assert.match(text(entries), /repo unreadable \| broken:/);
  rmSync(base, { recursive: true, force: true });
});

test("repos nested under a census repo are scanned too", () => {
  const { base, root, remotes } = fixture();
  const ws = mkRepo(root, "ws");
  withUpstream(ws, remotes);
  const inner = mkRepo(ws, "proj");
  write(inner, "STATE.md", 25);
  const { entries } = run(root);
  assert.match(text(entries), /ws\/proj \(main\) STATE\.md - untracked, 25 days/);
  rmSync(base, { recursive: true, force: true });
});

test("isRecordPath and parseStatus: the matchers, by literal", () => {
  for (const p of ["STATE.md", "a/b/DECISIONS.md", "x/GOTCHAS.md", "HANDOVERS.md", "TODOS.md", "ISSUES.md", ".propagates.yml", "propagation/ledger.jsonl", "docs/plans/2026-01-x.md", "rules/r.md", "rules/sub/r.md"]) {
    assert.ok(isRecordPath(p), p);
  }
  for (const p of ["README.md", "src/state.js", "docs/guide.md", "plans.txt", "notrules/r.md"]) {
    assert.ok(!isRecordPath(p), p);
  }
  const raw = ["?? new file.md", "R  new/STATE.md", "old/STATE.md", " D gone.md", "A  s.md", ""].join("\0");
  assert.deepEqual(parseStatus(raw), [
    { path: "new file.md", state: "untracked" },
    { path: "new/STATE.md", state: "staged" },
    { path: "gone.md", state: "deleted" },
    { path: "s.md", state: "staged" },
  ]);
});

test("the section declares a severity", () => {
  assert.equal(SEVERITY, "S3");
});
