/**
 * release-kind (#234): the kind of a release is derived from its commits, the VERSION bump must match, and each
 * release carries generated notes. Fixture repos set user.email/user.name PER REPO and never touch the real
 * repo's git config; commits are written as literals.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { classify, bumpKind, checkBump, applyToChangelog, renderBody, hasVersion } from "../../lib/core/release-kind.mjs";
import { gateReleaseKind } from "../../lib/core/release.mjs";
import { commitMsgHook, releaseNotesCmd } from "../../cli/release-kind.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOOK = path.join(ROOT, ".githooks", "commit-msg");

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

/** A fixture repo with VERSION 0.1.0 committed and tagged v0.1.0 (a LIGHTWEIGHT tag, like propagate's). */
function fixture(extraCommits = []) {
  const dir = mkdtempSync(path.join(tmpdir(), "propagate-release-kind-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "fixture@example.invalid");
  git(dir, "config", "user.name", "Fixture");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "config", "core.hooksPath", "/dev/null");
  writeFileSync(path.join(dir, "VERSION"), "0.1.0\n");
  git(dir, "add", "VERSION");
  git(dir, "commit", "-q", "-m", "chore: init");
  git(dir, "tag", "v0.1.0");
  for (const m of extraCommits) git(dir, "commit", "-q", "--allow-empty", "-m", m);
  return dir;
}

function stageVersion(dir, v) {
  writeFileSync(path.join(dir, "VERSION"), `${v}\n`);
  git(dir, "add", "VERSION");
}

function runHook(dir, message, env = {}) {
  const msg = path.join(dir, ".git", "COMMIT_EDITMSG");
  writeFileSync(msg, message + "\n");
  const e = { ...process.env, ...env };
  if (!("PROPAGATE_SKIP_RELEASE_KIND" in env)) delete e.PROPAGATE_SKIP_RELEASE_KIND;
  return spawnSync(HOOK, [msg], { cwd: dir, encoding: "utf8", env: e });
}

const done = (dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });

// --- classify -------------------------------------------------------------------------------------------------

test("classify: feat is minor; fix and docs only is patch; nothing is none", () => {
  assert.equal(classify(["feat(costs): add window"]).required, "minor");
  assert.equal(classify(["fix: a", "docs: b", "chore(x): c", "test: d", "refactor: e", "perf: f", "build: g", "ci: h"]).required, "patch");
  assert.equal(classify([]).required, "none");
});

test("classify: `!` and a BREAKING CHANGE footer are breaking, minor pre-1.0, whatever the type", () => {
  const bang = classify(["feat!: drop the flag"]);
  assert.equal(bang.required, "minor"); assert.equal(bang.breaking, true);
  const bangFix = classify(["fix(api)!: change the exit code"]);
  assert.equal(bangFix.required, "minor"); assert.equal(bangFix.breaking, true);
  const footer = classify(["fix: tidy\n\nBody text.\n\nBREAKING CHANGE: the file moved"]);
  assert.equal(footer.required, "minor"); assert.equal(footer.breaking, true);
  const hyphen = classify(["docs: x\n\nBREAKING-CHANGE: y"]);
  assert.equal(hyphen.breaking, true);
  assert.equal(classify(["fix: a"]).breaking, false);
});

test("classify: an unknown prefix is listed by name and is NOT counted as a patch", () => {
  const c = classify(["Merge branch 'x'", "update stuff", "wip: thing"]);
  assert.deepEqual(c.unknown, ["Merge branch 'x'", "update stuff", "wip: thing"]);
  assert.equal(c.required, "none", "unknown subjects alone require nothing; they are listed, not guessed");
  assert.deepEqual(c.byType, {});
  const mixed = classify(["fix: a", "mystery commit"]);
  assert.equal(mixed.required, "patch");
  assert.deepEqual(mixed.unknown, ["mystery commit"]);
});

// --- bumpKind / checkBump ---------------------------------------------------------------------------------------

test("bumpKind", () => {
  assert.equal(bumpKind("0.15.58", "0.15.59"), "patch");
  assert.equal(bumpKind("0.15.59", "0.16.0"), "minor");
  assert.equal(bumpKind("0.16.0", "1.0.0"), "major");
  assert.equal(bumpKind("0.16.0", "0.16.0"), "none");
  assert.equal(bumpKind("0.16.0", "0.15.9"), "invalid");
  assert.equal(bumpKind("0.16.0", "banana"), "invalid");
});

test("checkBump: 0.15.58 -> 0.15.59 over a feat FAILS and names 0.16.0", () => {
  const r = checkBump("0.15.58", "0.15.59", ["feat: x"], { since: "v0.15.58" });
  assert.equal(r.ok, false);
  assert.equal(r.required, "minor");
  assert.equal(r.requiredVersion, "0.16.0");
  assert.match(r.why, /`feat:` since v0\.15\.58 needs a minor bump \(0\.16\.0\); VERSION was bumped to 0\.15\.59/);
});

test("checkBump: -> 0.16.0 passes; -> 1.0.0 passes and is noted as above the requirement", () => {
  const minor = checkBump("0.15.58", "0.16.0", ["feat: x"]);
  assert.equal(minor.ok, true); assert.equal(minor.above, false);
  const major = checkBump("0.15.58", "1.0.0", ["feat: x"]);
  assert.equal(major.ok, true); assert.equal(major.above, true);
  assert.match(major.why, /above the minor/);
});

test("checkBump: an equal version with commits present fails; fix-only needs only a patch", () => {
  const eq = checkBump("0.15.59", "0.15.59", ["fix: a"]);
  assert.equal(eq.ok, false);
  assert.match(eq.why, /is still 0\.15\.59/);
  assert.equal(checkBump("0.15.59", "0.15.60", ["fix: a", "docs: b"]).ok, true);
  assert.equal(checkBump("0.15.59", "0.15.59", []).ok, true, "no commits, no bump needed");
});

test("checkBump: breaking pre-1.0 is minor with the breaking flag; from 1.0 it is major", () => {
  const pre = checkBump("0.15.59", "0.15.60", ["fix!: x"]);
  assert.equal(pre.ok, false); assert.equal(pre.required, "minor"); assert.equal(pre.breaking, true);
  assert.equal(pre.requiredVersion, "0.16.0");
  const post = checkBump("1.2.3", "1.3.0", ["feat!: x"]);
  assert.equal(post.ok, false); assert.equal(post.required, "major"); assert.equal(post.requiredVersion, "2.0.0");
});

test("checkBump: unprefixed subjects are named in the result", () => {
  const r = checkBump("0.1.0", "0.1.1", ["fix: a", "tweak things"]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.unknown, ["tweak things"]);
  assert.match(r.why, /"tweak things"/);
});

// --- the commit-msg hook, on a fixture repo -------------------------------------------------------------------------

test("hook: a staged VERSION patch bump with a `feat:` message is refused (exit 1), names 0.2.0 and the bypass", () => {
  const dir = fixture();
  try {
    stageVersion(dir, "0.1.1");
    const r = runHook(dir, "feat: add a thing");
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /0\.2\.0/);
    assert.match(r.stderr, /PROPAGATE_SKIP_RELEASE_KIND=1/);
  } finally { done(dir); }
});

test("hook: the same patch bump with a `fix:` message passes (exit 0)", () => {
  const dir = fixture();
  try {
    stageVersion(dir, "0.1.1");
    const r = runHook(dir, "fix: repair a thing");
    assert.equal(r.status, 0, r.stderr);
  } finally { done(dir); }
});

test("hook: a feat committed since the tag also counts when this commit's own message is a fix", () => {
  const dir = fixture(["feat: earlier feature"]);
  try {
    stageVersion(dir, "0.1.1");
    const r = runHook(dir, "fix: release plumbing");
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /0\.2\.0/);
  } finally { done(dir); }
});

test("hook: no VERSION staged exits 0 without reading anything (silent)", () => {
  const dir = fixture(["feat: a feature"]);
  try {
    writeFileSync(path.join(dir, "other.txt"), "x\n");
    git(dir, "add", "other.txt");
    const r = runHook(dir, "feat: more");
    assert.equal(r.status, 0);
    assert.equal(r.stderr, "");
    assert.equal(r.stdout, "");
  } finally { done(dir); }
});

test("hook: the bypass variable lets the commit through and says it was bypassed", () => {
  const dir = fixture();
  try {
    stageVersion(dir, "0.1.1");
    const r = runHook(dir, "feat: add a thing", { PROPAGATE_SKIP_RELEASE_KIND: "1" });
    assert.equal(r.status, 0);
    assert.match(r.stderr, /BYPASSED/);
  } finally { done(dir); }
});

test("hook: through a real `git commit`, the refusal blocks the commit and nothing is created", () => {
  const dir = fixture();
  const hooks = mkdtempSync(path.join(tmpdir(), "propagate-release-kind-hooks-"));
  try {
    // A wrapper hooks dir pointing at the real hook, so only commit-msg runs (the real pre-commit would check THIS repo).
    writeFileSync(path.join(hooks, "commit-msg"), `#!/bin/sh\nexec "${HOOK}" "$@"\n`);
    chmodSync(path.join(hooks, "commit-msg"), 0o755);
    stageVersion(dir, "0.1.1");
    const before = git(dir, "rev-parse", "HEAD");
    const r = spawnSync("git", ["-c", `core.hooksPath=${hooks}`, "commit", "-q", "-m", "feat: a feature"], { cwd: dir, encoding: "utf8" });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /release-kind: REFUSED/);
    assert.equal(git(dir, "rev-parse", "HEAD"), before, "no commit was made");
    const ok = spawnSync("git", ["-c", `core.hooksPath=${hooks}`, "commit", "-q", "-m", "fix: a repair"], { cwd: dir, encoding: "utf8" });
    assert.equal(ok.status, 0, ok.stderr);
  } finally { done(dir); done(hooks); }
});

test("hook (function): a repo with no v* tag is not checked, and says so", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "propagate-release-kind-notag-"));
  try {
    git(dir, "init", "-q");
    git(dir, "config", "user.email", "fixture@example.invalid");
    git(dir, "config", "user.name", "Fixture");
    git(dir, "config", "commit.gpgsign", "false");
    git(dir, "config", "core.hooksPath", "/dev/null");
    writeFileSync(path.join(dir, "VERSION"), "0.1.0\n");
    git(dir, "add", "VERSION"); git(dir, "commit", "-q", "-m", "chore: init");
    stageVersion(dir, "0.1.1");
    const errs = [];
    const msg = path.join(dir, "msg"); writeFileSync(msg, "feat: x\n");
    assert.equal(commitMsgHook(msg, { cwd: dir, env: {}, out: () => {}, err: (s) => errs.push(s) }), 0);
    assert.match(errs.join("\n"), /no v\* tag reachable.*not checked/);
  } finally { done(dir); }
});

// --- the tag sits on the release commit ---------------------------------------------------------------------------------

test("tag on the release commit: `git describe --tags --exact-match HEAD` names the new tag; plain --exact-match misses a lightweight tag", () => {
  const dir = fixture(["feat: the feature"]);
  try {
    stageVersion(dir, "0.2.0");
    git(dir, "commit", "-q", "-m", "chore(release): 0.2.0");
    git(dir, "tag", "v0.2.0");
    assert.equal(git(dir, "describe", "--tags", "--exact-match", "HEAD").trim(), "v0.2.0");
    const plain = spawnSync("git", ["describe", "--exact-match", "HEAD"], { cwd: dir, encoding: "utf8" });
    assert.notEqual(plain.status, 0, "a lightweight tag is invisible to describe without --tags");
  } finally { done(dir); }
});

// --- the release-kind gate ------------------------------------------------------------------------------------------

test("gate: an equal VERSION with commits since the tag is FAILED, and says the pending type is hook-checked", () => {
  const dir = fixture(["feat: a feature"]);
  try {
    const g = gateReleaseKind({ skillDir: dir });
    assert.equal(g.name, "release-kind");
    assert.equal(g.status, "failed");
    assert.match(g.detail, /needs a minor bump \(0\.2\.0\)/);
    assert.match(g.detail, /\.githooks\/commit-msg/);
  } finally { done(dir); }
});

test("gate: a patch bump over a committed feat fails; a minor bump passes", () => {
  const dir = fixture(["feat: a feature"]);
  try {
    writeFileSync(path.join(dir, "VERSION"), "0.1.1\n");
    assert.equal(gateReleaseKind({ skillDir: dir }).status, "failed");
    writeFileSync(path.join(dir, "VERSION"), "0.2.0\n");
    const ok = gateReleaseKind({ skillDir: dir });
    assert.equal(ok.status, "passed", ok.detail);
    assert.match(ok.detail, /commit-msg/);
  } finally { done(dir); }
});

test("gate: no commits since the tag and VERSION == tag passes; no tag is could-not-run with a reason", () => {
  const dir = fixture();
  try {
    const g = gateReleaseKind({ skillDir: dir });
    assert.equal(g.status, "passed", g.detail);
    assert.match(g.detail, /no commits since v0\.1\.0/);
  } finally { done(dir); }
  const bare = mkdtempSync(path.join(tmpdir(), "propagate-release-kind-bare-"));
  try {
    writeFileSync(path.join(bare, "VERSION"), "0.1.0\n");
    const g = gateReleaseKind({ skillDir: bare });
    assert.equal(g.status, "could-not-run");
    assert.ok(g.reason && g.reason.length > 0);
  } finally { done(bare); }
});

// --- notes ------------------------------------------------------------------------------------------------------------

test("renderBody groups Breaking / Added / Fixed / Changed and names unprefixed subjects", () => {
  const body = renderBody(["feat(a): one", "fix: two", "docs: three", "feat!: four", "odd one"]);
  assert.match(body, /### Breaking\n\n- four/);
  assert.match(body, /### Added\n\n- a: one\n- four/);
  assert.match(body, /### Fixed\n\n- two/);
  assert.match(body, /### Changed\n\n- three\n- odd one \(unprefixed\)/);
});

test("applyToChangelog: refresh fills [Unreleased] at the top, below the header", () => {
  const start = "# Changelog\n\nintro\n\n## [Unreleased]\n\n## [0.1.0] — 2026-01-01\n\n### Added\n\n- old\n";
  const r = applyToChangelog(start, { body: "### Added\n\n- new", date: "2026-11-09" });
  assert.equal(r.ok, true);
  assert.ok(r.text.indexOf("## [Unreleased]") < r.text.indexOf("## [0.1.0]"));
  assert.match(r.text, /## \[Unreleased\]\n\n### Added\n\n- new\n\n## \[0\.1\.0\]/);
  const again = applyToChangelog(r.text, { body: "### Fixed\n\n- other", date: "2026-11-09" });
  assert.doesNotMatch(again.text, /- new/, "a refresh replaces the old draft");
  assert.match(again.text, /- other/);
});

test("applyToChangelog: --version renames [Unreleased] and opens an empty one; refuses a duplicate", () => {
  const start = "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- edited by a person\n\n## [0.1.0] — 2026-01-01\n\n- old\n";
  const r = applyToChangelog(start, { body: "### Added\n\n- generated", version: "0.2.0", date: "2026-11-09" });
  assert.equal(r.ok, true);
  assert.match(r.text, /## \[Unreleased\]\n\n## \[0\.2\.0\] — 2026-11-09\n\n### Added\n\n- edited by a person/);
  assert.doesNotMatch(r.text, /generated/, "the person's edits are kept, not overwritten");
  assert.equal(hasVersion(r.text, "0.2.0"), true);
  const dup = applyToChangelog(r.text, { body: "x", version: "0.2.0", date: "2026-11-09" });
  assert.equal(dup.ok, false);
  assert.match(dup.reason, /already has a "## \[0\.2\.0\]"/);
});

test("releaseNotesCmd --write on a fixture repo fills [Unreleased]; --write --version releases it; a second --version refuses", () => {
  const dir = fixture(["feat(x): a feature", "fix: a repair"]);
  const out = [], errs = [];
  const io = { root: dir, date: "2026-11-09", out: (s) => out.push(s), err: (s) => errs.push(s) };
  try {
    assert.equal(releaseNotesCmd(["--write"], io), 0, errs.join("\n"));
    const file = path.join(dir, "CHANGELOG.md");
    const t1 = readFileSync(file, "utf8");
    assert.match(t1, /## \[Unreleased\]\n\n### Added\n\n- x: a feature\n\n### Fixed\n\n- a repair/);

    assert.equal(releaseNotesCmd(["--write", "--version", "0.2.0"], io), 0, errs.join("\n"));
    const t2 = readFileSync(file, "utf8");
    assert.match(t2, /## \[Unreleased\]\n\n## \[0\.2\.0\] — 2026-11-09\n\n### Added/);

    errs.length = 0;
    assert.equal(releaseNotesCmd(["--write", "--version", "0.2.0"], io), 2);
    assert.match(errs.join("\n"), /already has a "## \[0\.2\.0\]"/);
    assert.equal(readFileSync(file, "utf8"), t2, "a refused write leaves the file byte-identical");
  } finally { done(dir); }
});

test("releaseNotesCmd without --write prints the draft and writes nothing; no tag and no --since is exit 2", () => {
  const dir = fixture(["fix: a repair"]);
  const out = [], errs = [];
  try {
    assert.equal(releaseNotesCmd([], { root: dir, date: "2026-11-09", out: (s) => out.push(s), err: (s) => errs.push(s) }), 0);
    assert.match(out.join("\n"), /1 commit\(s\) since v0\.1\.0; required bump pre-1\.0: patch/);
    assert.throws(() => readFileSync(path.join(dir, "CHANGELOG.md")), /ENOENT/);
  } finally { done(dir); }
  const bare = mkdtempSync(path.join(tmpdir(), "propagate-release-kind-bare2-"));
  try {
    git(bare, "init", "-q");
    assert.equal(releaseNotesCmd([], { root: bare, out: () => {}, err: (s) => errs.push(s) }), 2);
    assert.match(errs.join("\n"), /no v\* tag reachable/);
  } finally { done(bare); }
});
