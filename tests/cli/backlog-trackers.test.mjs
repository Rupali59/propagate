/**
 * backlog-trackers.test.mjs — PR-034: a register that delegates to a GitHub tracker.
 *
 * `backlog` classified obsidian-vk-publish's register as `delegated` correctly and
 * then printed it as `(delegated, 0 total, 0 open)` — the destination reached
 * --json and nobody reading the command, and the tree total read as complete while
 * missing the project's 45+ open issues.
 *
 * Three things are pinned here:
 *   1. the destination is NAMED, and (since #104, DECISIONS 2026-10-19) `backlog` reads it by
 *      DEFAULT, refreshing a cache first; only --offline runs no gh (a fake gh writes a marker);
 *   2. the tracker is counted, and "could not read the tracker" is never "0 open";
 *   3. the URL parser refuses what it cannot count (a project board, one issue,
 *      another host) rather than guessing.
 *
 * INJECTION SEAM: every gh here is a fake via PROPAGATE_GH_BIN. The real gh path
 * is untested by construction (rule:name-what-no-test-executes); PR-034's closure
 * in TODOS.md records the one real run, checked against an independent gh count.
 */
// @size medium — starts processes (CLI or script); run when affected
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, chmodSync, readFileSync } from "node:fs";
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

// DELIBERATELY INVERTED (#104, DECISIONS 2026-10-19, which supersedes 2026-10-04's "--trackers is backlog's
// only network call, opt-in"). This test used to assert that gh was NOT run without --trackers. It now asserts
// the opposite: the work of every delegated register lives in GitHub issues, so plain `backlog` reads them
// (bounded, through a cache) -- and the old guarantee survives as `--offline`, tested right below.
test("backlog NAMES a delegated register's tracker and READS it by default; the ranked list carries the issues", () => {
  const root = delegatingTree();
  const stateDir = mkdtempSync(path.join(tmpdir(), "pr034-state-"));
  try {
    const gh = fakeGh(root, { stdout: JSON.stringify([{ number: 4, title: "first", html_url: "https://github.com/o/r/issues/4", labels: [{ name: "priority:P1" }] }, { number: 5, title: "second", html_url: "https://github.com/o/r/issues/5", labels: [] }, { number: 6, title: "a pull request", pull_request: {}, labels: [] }]) });
    const r = runBacklog([], { root, gh: gh.bin, stateDir });
    assert.equal(r.status, 0, r.stderr);
    const out = plain(r.stdout);
    assert.match(out, /\+ 2 open on GitHub in 1 delegated tracker\(s\) \(as of /);
    assert.match(out, new RegExp(`delegated .*TODOS\\.md → ${ISSUES.replace(/[.?]/g, "\\$&")}  2 open`));
    assert.match(out, /GitHub refresh: 1 fetched/);
    assert.match(out, /ranked \(2\)/);
    assert.match(out, /P1 #4 first {2}o\/r https:\/\/github\.com\/o\/r\/issues\/4/);
    assert.equal(existsSync(gh.marker), true, "control: plain backlog ran gh");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("backlog --offline runs NO gh at all, reads the last cache, and says how old it is -- or that there is none, which is not 0", () => {
  const root = delegatingTree();
  const stateDir = mkdtempSync(path.join(tmpdir(), "pr034-state-"));
  try {
    const gh = fakeGh(root, { stdout: JSON.stringify([{ number: 1, title: "from the last refresh", html_url: "https://github.com/o/r/issues/1", labels: [] }]) });

    // No cache yet: not-fetched, never a zero.
    const cold = runBacklog(["--offline"], { root, gh: gh.bin, stateDir });
    assert.equal(cold.status, 0, cold.stderr);
    const c = plain(cold.stdout);
    assert.equal(existsSync(gh.marker), false, "--offline must not run gh");
    assert.match(c, /not fetched/);
    assert.match(c, /--offline: GitHub read from the cache only \(no cache yet/);
    assert.doesNotMatch(c, /\+ 0 open/);
    assert.doesNotMatch(c, /0 open on GitHub/);

    // Warm the cache with a real (fake-gh) refresh, then go offline again: the rows come from the cache, gh stays untouched.
    runBacklog([], { root, gh: gh.bin, stateDir });
    assert.equal(existsSync(gh.marker), true, "control: the refresh ran gh");
    rmSync(gh.marker);
    const warm = runBacklog(["--offline", "--json"], { root, gh: gh.bin, stateDir });
    assert.equal(existsSync(gh.marker), false, "--offline with a warm cache still runs no gh");
    const j = JSON.parse(warm.stdout);
    assert.deepEqual(j.ranked.map((x) => [x.id, x.url, x.kind]), [["#1", "https://github.com/o/r/issues/1", "github"]]);
    assert.equal(j.refresh.offline, true);
    assert.equal(j.totals.trackers.cache.present, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("backlog names an unreadable tracker and its cache age; one that failed AFTER a good read keeps its rows, marked STALE -- never +0", () => {
  const root = delegatingTree();
  const stateDir = mkdtempSync(path.join(tmpdir(), "pr034-state-"));
  try {
    const ok = fakeGh(root, { stdout: JSON.stringify([{ number: 3, title: "kept", html_url: "https://github.com/o/r/issues/3", labels: [] }]) });
    const r = runBacklog(["--trackers"], { root, gh: ok.bin, stateDir });
    assert.equal(r.status, 0, r.stderr);
    assert.match(plain(r.stdout), /\+ 1 open on GitHub in 1 delegated tracker\(s\)/, "--trackers is kept as an alias for the default");

    const bad = fakeGh(root, { code: 1, stdout: "", stderr: "HTTP 401" });
    const b = plain(runBacklog(["--trackers"], { root, gh: bad.bin, stateDir }).stdout);
    assert.doesNotMatch(b, /\+ 0 open/, "an unread tracker must not render as a zero");
    assert.match(b, /1 delegated tracker\(s\) could not be read — not counted, and not 0/);
    assert.match(b, /unreadable — gh exited 1: HTTP 401/);
    assert.match(b, /showing the previous read \(1 issue\(s\), .*STALE/);
    assert.match(b, /1 tracker\(s\) are showing a previous read \(STALE\)/);
    assert.match(b, /#3 kept .*\(STALE\)/, "the kept row says it is stale");

    const j = JSON.parse(runBacklog(["--trackers", "--json"], { root, gh: ok.bin, stateDir }).stdout);
    assert.equal(j.delegatedTrackers.length, 1);
    assert.deepEqual([j.delegatedTrackers[0].status, j.delegatedTrackers[0].open], ["counted", 1]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a gh that hangs cannot hang `backlog`: the refresh is bounded and the command still answers (G53: a 60 s sleep is the signal)", () => {
  const root = delegatingTree();
  const stateDir = mkdtempSync(path.join(tmpdir(), "pr034-state-"));
  try {
    const n = ++fakeSeq;
    const bin = path.join(root, `gh-${n}`);
    writeFileSync(bin, "#!/bin/sh\nexec sleep 60\n");
    chmodSync(bin, 0o755);
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [CLI, "backlog"], {
      encoding: "utf8", timeout: 55000,
      env: { ...process.env, PROPAGATE_SEARCH_ROOTS: root, PROPAGATE_STATE_DIR: stateDir, PROPAGATE_GH_BIN: bin, NO_COLOR: "1" },
    });
    assert.ok(Date.now() - t0 < 50000, "the 20 s budget held; a broken bound would have waited the full minute");
    assert.equal(r.status, 0, r.stderr);
    assert.match(plain(r.stdout), /unreadable — timed out after /);
    assert.doesNotMatch(plain(r.stdout), /\+ 0 open/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

/* -- R1: `?q=label:` filters, counted once per (repo, filter) ---------------- */

/** A fake gh that appends its argv (one line per call) to `log`. */
function loggingGh(dir, stdout) {
  const n = ++fakeSeq;
  const bin = path.join(dir, `gh-${n}`);
  const log = path.join(dir, `gh-${n}-args.log`);
  writeFileSync(bin, `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\nprintf '%s' ${JSON.stringify(stdout)}\nexit 0\n`);
  chmodSync(bin, 0o755);
  return { bin, calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []) };
}

test("parseGithubIssuesUrl reads label: filters in every encoding gh users paste", () => {
  const u = "https://github.com/o/r/issues";
  assert.deepEqual(parseGithubIssuesUrl(`${u}?q=label:project:propagate`), { repo: "o/r", labels: ["project:propagate"] });
  assert.deepEqual(parseGithubIssuesUrl(`${u}?q=label%3Aproject%3Apropagate`), { repo: "o/r", labels: ["project:propagate"] });
  assert.deepEqual(parseGithubIssuesUrl(`${u}?q=is:open+label:"a b"`), { repo: "o/r", labels: ["a b"] });
  assert.deepEqual(parseGithubIssuesUrl(`${u}?q=is%3Aopen%20label%3A%22a%20b%22`), { repo: "o/r", labels: ["a b"] });
  assert.deepEqual(parseGithubIssuesUrl(`${u}?q=label:x+label:y`), { repo: "o/r", labels: ["x", "y"] });
  assert.deepEqual(parseGithubIssuesUrl(`${u}?q=-label:x`), { repo: "o/r" }, "a negated label is not a --label");
  assert.deepEqual(parseGithubIssuesUrl(`${u}?q=is%3Aopen`), { repo: "o/r" }, "no label term -> no labels key");
});

test("a label filter becomes `gh issue list --label`, one flag per label", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pr034-gh-"));
  try {
    const gh = loggingGh(dir, "[{},{}]");
    const [r] = readDelegatedTrackers(
      [{ file: "f", delegatedTo: `${ISSUES}?q=label:project:propagate+label:"two words"` }],
      { gh: gh.bin },
    );
    assert.deepEqual([r.status, r.open], ["counted", 2]);
    const [call] = gh.calls();
    assert.match(call, /--label project:propagate --label two words/);
    assert.match(call, /--repo o\/r/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two registers on the same repo AND filter count once; different filters each count", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pr034-gh-"));
  try {
    const gh = loggingGh(dir, "[{},{},{}]");
    const rows = readDelegatedTrackers(
      [
        { file: "a", delegatedTo: `${ISSUES}?q=label:project:p` },
        { file: "b", delegatedTo: `${ISSUES}?q=label%3Aproject%3Ap` }, // same filter, other spelling
        { file: "c", delegatedTo: `${ISSUES}?q=label:project:q` },
      ],
      { gh: gh.bin },
    );
    assert.equal(gh.calls().length, 2, "gh ran once per unique (repo, filter)");
    const sum = rows.filter((x) => x.status === "counted" && x.inSum !== false).reduce((n, x) => n + x.open, 0);
    assert.equal(sum, 6, "3 (p, once) + 3 (q); a naive per-register sum would say 9");
    assert.equal(rows[1].sharedWith, "a");
    assert.equal(rows[1].inSum, false);
    assert.equal(rows[2].inSum, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a bare repo link plus a filtered link on the same repo: both reported, the filtered one flagged as included", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pr034-gh-"));
  try {
    const gh = loggingGh(dir, "[{},{}]");
    const rows = readDelegatedTrackers(
      [
        { file: "bare", delegatedTo: ISSUES },
        { file: "filt", delegatedTo: `${ISSUES}?q=label:project:p` },
      ],
      { gh: gh.bin },
    );
    assert.equal(rows.length, 2);
    assert.equal(rows.every((x) => x.status === "counted"), true, "both reported");
    assert.deepEqual(rows[0].includes, [`${ISSUES}?q=label:project:p`]);
    assert.equal(rows[1].includedIn, "bare");
    assert.equal(rows[1].inSum, false, "the filtered count is inside the bare one: not summed twice");
    assert.equal(rows[0].inSum, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
