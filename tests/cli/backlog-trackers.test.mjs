/**
 * backlog-trackers.test.mjs — PR-034: a register that delegates to a GitHub tracker.
 *
 * `backlog` classified obsidian-vk-publish's register as `delegated` correctly and
 * then printed it as `(delegated, 0 total, 0 open)` — the destination reached
 * --json and nobody reading the command, and the tree total read as complete while
 * missing the project's 45+ open issues.
 *
 * Three things are pinned here:
 *   1. the destination is NAMED without any network call, and gh is NOT run
 *      unless --trackers is passed (a fake gh writes a marker when invoked);
 *   2. --trackers counts, and "could not read the tracker" is never "0 open";
 *   3. the URL parser refuses what it cannot count (a project board, one issue,
 *      another host) rather than guessing.
 *
 * INJECTION SEAM: every gh here is a fake via PROPAGATE_GH_BIN. The real gh path
 * is untested by construction (rule:name-what-no-test-executes); PR-034's closure
 * in TODOS.md records the one real run, checked against an independent gh count.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseGithubIssuesUrl, readDelegatedTrackers, TRACKER_LIMIT } from "../../lib/report/backlog.mjs";

const CLI = fileURLToPath(new URL("../../cli.mjs", import.meta.url));
const ISSUES = "https://github.com/o/r/issues";

/**
 * A fake gh: prints `stdout`, exits `code`, and touches `marker` when run.
 * Each call gets its OWN path. The first version wrote every fake to `dir/gh`,
 * so a later fake silently replaced an earlier one and three cases ran the last.
 */
let fakeSeq = 0;
function fakeGh(dir, { stdout = "[]", code = 0, stderr = "" } = {}) {
  const n = ++fakeSeq;
  const bin = path.join(dir, `gh-${n}`);
  const marker = path.join(dir, `gh-${n}-was-called`);
  writeFileSync(
    bin,
    `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nprintf '%s' ${JSON.stringify(stdout)}\nprintf '%s' ${JSON.stringify(stderr)} >&2\nexit ${code}\n`,
  );
  chmodSync(bin, 0o755);
  return { bin, marker };
}

function delegatingTree() {
  const root = mkdtempSync(path.join(tmpdir(), "pr034-"));
  const ws = path.join(root, "ws");
  mkdirSync(ws, { recursive: true });
  writeFileSync(
    path.join(ws, "TODOS.md"),
    `# TODOS\n\n**Open work lives in [GitHub issues](${ISSUES}), not in this file.**\n\nThis file was the ledger until 2026-09-18.\n`,
  );
  return root;
}

function runBacklog(argv, { root, gh, stateDir }) {
  return spawnSync(process.execPath, [CLI, "backlog", ...argv], {
    encoding: "utf8",
    env: { ...process.env, PROPAGATE_SEARCH_ROOTS: root, PROPAGATE_STATE_DIR: stateDir, PROPAGATE_GH_BIN: gh, NO_COLOR: "1" },
  });
}
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

/* -- parseGithubIssuesUrl -------------------------------------------------- */

test("parseGithubIssuesUrl takes an issues-list URL and refuses everything it cannot count", () => {
  assert.deepEqual(parseGithubIssuesUrl("https://github.com/Rupali59/obsidian-vk-publish/issues"), { repo: "Rupali59/obsidian-vk-publish" });
  assert.deepEqual(parseGithubIssuesUrl("https://github.com/o/r/issues/"), { repo: "o/r" });
  assert.deepEqual(parseGithubIssuesUrl("https://github.com/o/r/issues?q=is%3Aopen"), { repo: "o/r" });
  assert.equal(parseGithubIssuesUrl("https://github.com/users/Rupali59/projects/3"), null, "a project board");
  assert.equal(parseGithubIssuesUrl("https://github.com/o/r/issues/12"), null, "one issue, not the list");
  assert.equal(parseGithubIssuesUrl("https://gitlab.com/o/r/issues"), null, "another host");
  assert.equal(parseGithubIssuesUrl("an external tracker named in the file"), null, "the no-link fallback text");
});

/* -- readDelegatedTrackers: three states, never conflated ------------------- */

test("a readable tracker is counted, and an EMPTY one is counted 0 — distinct from unreadable", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pr034-gh-"));
  try {
    const two = fakeGh(dir, { stdout: "[{},{}]" });
    const [r] = readDelegatedTrackers([{ file: "f", delegatedTo: ISSUES }], { gh: two.bin });
    assert.deepEqual([r.status, r.open, r.capped, r.repo], ["counted", 2, false, "o/r"]);

    const none = fakeGh(dir, { stdout: "[]" });
    const [z] = readDelegatedTrackers([{ file: "f", delegatedTo: ISSUES }], { gh: none.bin });
    assert.deepEqual([z.status, z.open], ["counted", 0], "a real zero is a count");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every way of failing to read the tracker is `unreadable` with a reason, never a count", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pr034-gh-"));
  try {
    const cases = [
      ["gh exits non-zero", fakeGh(dir, { code: 4, stdout: "", stderr: "gh auth login required" }).bin, /gh exited 4: gh auth login required/],
      ["output is not JSON", fakeGh(dir, { stdout: "not json" }).bin, /not JSON/],
      ["output is JSON but not an array", fakeGh(dir, { stdout: "{}" }).bin, /not a JSON array/],
      ["gh is not installed", path.join(dir, "no-such-gh"), /ENOENT/],
    ];
    for (const [name, gh, reason] of cases) {
      const [r] = readDelegatedTrackers([{ file: "f", delegatedTo: ISSUES }], { gh });
      assert.equal(r.status, "unreadable", name);
      assert.equal(r.open, undefined, `${name}: an unreadable tracker carries no count at all`);
      assert.match(r.reason, reason, name);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a destination that is not a GitHub issues list is `unsupported`, and gh is never run for it", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pr034-gh-"));
  try {
    const gh = fakeGh(dir, { stdout: "[{}]" });
    const [r] = readDelegatedTrackers([{ file: "f", delegatedTo: "https://github.com/users/x/projects/3" }], { gh: gh.bin });
    assert.equal(r.status, "unsupported");
    assert.match(r.reason, /not a GitHub issues URL/);
    assert.equal(existsSync(gh.marker), false, "gh must not be invoked for an unsupported destination");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hitting the --limit cap is reported as a floor (capped), not as an exact count", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pr034-gh-"));
  try {
    const gh = fakeGh(dir, { stdout: JSON.stringify(Array.from({ length: TRACKER_LIMIT }, () => ({}))) });
    const [r] = readDelegatedTrackers([{ file: "f", delegatedTo: ISSUES }], { gh: gh.bin });
    assert.deepEqual([r.status, r.open, r.capped], ["counted", TRACKER_LIMIT, true]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* -- the CLI: named without network; counted only on request --------------- */

test("backlog NAMES a delegated register's tracker, and does not run gh without --trackers", () => {
  const root = delegatingTree();
  const stateDir = mkdtempSync(path.join(tmpdir(), "pr034-state-"));
  try {
    const gh = fakeGh(root, { stdout: "[{},{},{}]" });
    const r = runBacklog([], { root, gh: gh.bin, stateDir });
    assert.equal(r.status, 0, r.stderr);
    const out = plain(r.stdout);
    assert.match(out, /1 register\(s\) delegate to an external tracker/);
    assert.match(out, /NOT in the total above \(count it: --trackers\)/);
    assert.match(out, new RegExp(`delegated .*TODOS\\.md → ${ISSUES.replace(/[.?]/g, "\\$&")}`));
    assert.equal(existsSync(gh.marker), false, "gh must not run without --trackers: it is backlog's only network call");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("backlog --trackers adds the tracker's count beside the total; an unreadable one is never +0", () => {
  const root = delegatingTree();
  const stateDir = mkdtempSync(path.join(tmpdir(), "pr034-state-"));
  try {
    const ok = fakeGh(root, { stdout: "[{},{},{}]" });
    const r = runBacklog(["--trackers"], { root, gh: ok.bin, stateDir });
    assert.equal(r.status, 0, r.stderr);
    assert.match(plain(r.stdout), /\+ 3 open in 1 delegated tracker\(s\), not in the total above/);
    assert.match(plain(r.stdout), /→ https:\/\/github\.com\/o\/r\/issues {2}3 open/);
    assert.equal(existsSync(ok.marker), true, "control: --trackers did run gh");

    const bad = fakeGh(root, { code: 1, stdout: "", stderr: "HTTP 401" });
    const b = plain(runBacklog(["--trackers"], { root, gh: bad.bin, stateDir }).stdout);
    assert.doesNotMatch(b, /\+ 0 open/, "an unread tracker must not render as a zero");
    assert.match(b, /1 delegated tracker\(s\) could not be read — not counted, and not 0/);
    assert.match(b, /unreadable — gh exited 1: HTTP 401/);

    const j = JSON.parse(runBacklog(["--trackers", "--json"], { root, gh: ok.bin, stateDir }).stdout);
    assert.equal(j.delegatedTrackers.length, 1);
    assert.deepEqual([j.delegatedTrackers[0].status, j.delegatedTrackers[0].open], ["counted", 3]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});
