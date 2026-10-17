/**
 * tasks-plan.test.mjs — `planExport` (R1 of the tasks-on-GitHub plan): a READ-ONLY plan.
 *
 * Hermetic: a temp hub of real `git init` repos with fake origins, a fake gh that logs its argv
 * and answers `repo view` from canned JSON, and an identity map in a temp state dir.
 *
 * Pinned here (rule:safety-flag-needs-a-test — measure the side effect, not the output):
 *   1. INERT: sha256 of every file + the path list is identical before/after, and the gh log
 *      holds only `repo view` lines (an allowlist: `gh api -f` is a POST).
 *   2. duplicate-id is HELD, and the unaffected sibling is still planned.
 *   3. a public target is scrubbed on title, labels and body; a planted forbidden literal
 *      (built at runtime, G76) is held `forbidden`; a missing identity map holds the file.
 *   4. issues-disabled names the fallback; other-owner and no-remote are held, not dropped.
 *   5. handovers: an open section is planned, an unknown one held, a closed one skipped.
 *
 * G76: no literal the make-public gate refuses appears in this file — it is assembled below.
 */
// @size medium — runs git and a fake gh; run when affected
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { backlog } from "../../lib/report/backlog.mjs";
import { planExport, BODY_LIMIT } from "../../lib/tasks/plan.mjs";

// Assembled at runtime so this file never carries the literal the gate refuses.
const FORBIDDEN_LITERAL = ["rupali", "b"].join(".");

let root, hub, stateDir, emptyState, ghBin, ghLog;

function git(dir, ...args) {
  const r = spawnSync("git", ["-c", "commit.gpgsign=false", "-C", dir, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
}

function repo(dir, origin) {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  if (origin) git(dir, "remote", "add", "origin", origin);
}

function put(rel, text) {
  const p = path.join(hub, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, text);
  return p;
}

/** sha256 of every file's bytes + the full sorted path list. Any create/delete/edit changes it. */
function snapshot(...dirs) {
  const rows = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { rows.push(`D ${p}`); walk(p); }
      else rows.push(`F ${p} ${createHash("sha256").update(readFileSync(p)).digest("hex")}`);
    }
  };
  for (const d of dirs) walk(d);
  return createHash("sha256").update(rows.sort().join("\n")).digest("hex") + ` (${rows.length} entries)`;
}

function plan(extra = {}) {
  const res = backlog({ searchRoots: [hub] });
  return planExport({ all: true, backlogResult: res, gh: ghBin, hubRoot: hub, stateDirPath: stateDir, today: "2026-10-17", ...extra });
}
const fileOf = (p, suffix) => p.files.find((f) => f.file.endsWith(suffix));

before(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "tasks-plan-"));
  hub = path.join(root, "hub");
  stateDir = path.join(root, "state");
  emptyState = path.join(root, "state-empty");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(emptyState, { recursive: true });
  writeFileSync(path.join(stateDir, "identity-map.json"), JSON.stringify({ names: { "Acme Client": "client-a" }, allow: [] }));

  // hub = a private repo the owner `hubowner` owns, with a commit so HEAD resolves
  repo(hub, "https://github.com/hubowner/hub.git");
  git(hub, "commit", "-q", "--allow-empty", "-m", "init");

  // alpha: id-keyed TODOS in the hub. PR-001 plain; PR-003 appears open AND closed (duplicate).
  put("propagation/state/alpha/TODOS.md", [
    "# TODOS", "",
    "## Open", "",
    "### PR-001 · First thing P1", "",
    `See [the doc](../../../docs/x.md#top) and ${os.homedir()}/notes/a.md.`, "",
    "```", "## not a heading, an illustration", "```", "",
    "Tail line of PR-001.", "",
    "### PR-003 · Dup that is still open", "", "body three", "",
    "### PR-003 · Dup that was done — RESOLVED", "", "old body", "",
    "### PR-009 · Huge", "", "x".repeat(BODY_LIMIT + 10), "",
  ].join("\n"));
  put("docs/x.md", "# x\n");

  // checkbox file
  put("propagation/state/boxes/TODOS.md", "# TODOS\n\n- [ ] checkbox one P2\n  continuation line\n- [x] done box\n");

  // ISSUES with severity + upstream
  put("propagation/state/alpha/ISSUES.md", [
    "# ISSUES", "",
    "### N1 · A defect **S2**", "", "**Status:** upstream", "", "details", "",
    "### N2 · Quiet one", "", "plain", "",
  ].join("\n"));

  // staged file: a proposed entry under the staging heading
  put("propagation/state/stagedproj/TODOS.md", [
    "# TODOS", "",
    "## Open", "", "### PR-040 · Real open", "", "b", "",
    "## From Reminders (unreviewed)", "", "### PR-050 · Not yet triaged", "", "b", "",
  ].join("\n"));

  // handovers in the hub
  put("HANDOVERS.md", [
    "# HANDOVERS", "",
    "## 2026-10-01 · Open one", "**Done when:** it is run", "", "body A", "",
    "## 2026-10-02 · Unknown one", "just prose, no marker", "",
    "## 2026-10-03 · Closed one", "**Resolved:** 2026-10-04 finished", "",
  ].join("\n"));

  // public repo: dir name carries a mapped client name, so the project LABEL needs scrubbing
  const pub = path.join(hub, "Acme Client");
  repo(pub, "https://github.com/hubowner/pubrepo.git");
  git(pub, "commit", "-q", "--allow-empty", "-m", "init");
  put("Acme Client/TODOS.md", [
    "# TODOS", "",
    "### PR-101 · Ship the Acme Client portal", "", "Ask Acme Client about it.", "",
    "### PR-102 · Leaky", "", `contact ${FORBIDDEN_LITERAL} for access`, "",
  ].join("\n"));

  // issues disabled (fallback = the hub repo that encloses it)
  repo(path.join(hub, "nodisc"), "https://github.com/hubowner/nodisc.git");
  put("nodisc/TODOS.md", "# TODOS\n\n### ND-001 · Needs a home\n\nbody\n");

  // another owner
  repo(path.join(hub, "foreign"), "https://github.com/someoneelse/foreign.git");
  put("foreign/TODOS.md", "# TODOS\n\n### FG-001 · Not ours\n\nbody\n");

  // no remote at all
  repo(path.join(hub, "noremote"), null);
  put("noremote/TODOS.md", "# TODOS\n\n### NR-001 · Orphan\n\nbody\n");

  // fake gh: logs argv, answers `repo view` only, anything else exits 9 (and is in the log)
  ghLog = path.join(root, "gh.log");
  ghBin = path.join(root, "gh");
  writeFileSync(
    ghBin,
    `#!/bin/sh
echo "$@" >> "${ghLog}"
[ "$1 $2" = "repo view" ] || { echo "unexpected gh call" >&2; exit 9; }
case "$3" in
  hubowner/hub) printf '%s' '{"visibility":"PRIVATE","hasIssuesEnabled":true,"owner":{"login":"hubowner"}}';;
  hubowner/pubrepo) printf '%s' '{"visibility":"PUBLIC","hasIssuesEnabled":true,"owner":{"login":"hubowner"}}';;
  hubowner/nodisc) printf '%s' '{"visibility":"PRIVATE","hasIssuesEnabled":false,"owner":{"login":"hubowner"}}';;
  someoneelse/foreign) printf '%s' '{"visibility":"PRIVATE","hasIssuesEnabled":true,"owner":{"login":"someoneelse"}}';;
  *) echo "no such repo" >&2; exit 1;;
esac
`,
  );
  chmodSync(ghBin, 0o755);
});

after(() => rmSync(root, { recursive: true, force: true }));

test("INERT: the plan changes no file, creates none, and gh sees only `repo view`", () => {
  const before = snapshot(hub, stateDir);
  const p = plan();
  assert.equal(p.ok, true);
  assert.ok(p.files.length >= 8, `only ${p.files.length} register files planned — the scan has gone blind`);
  assert.equal(snapshot(hub, stateDir), before, "tasks export must not touch the hub or the state dir");
  const log = readFileSync(ghLog, "utf8").trim().split("\n");
  assert.ok(log.length >= 4, "gh was never asked about any repo");
  for (const line of log) {
    assert.match(line, /^repo view [\w.-]+\/[\w.-]+ --json visibility,hasIssuesEnabled,owner$/, `non-allowlisted gh call: ${line}`);
  }
  assert.equal(new Set(log).size, log.length, "repo view is cached per repo per run");
});

test("an entry is planned with key, labels, rewritten links and home path, and a fence-aware body", () => {
  const f = fileOf(plan(), "alpha/TODOS.md");
  assert.equal(f.target.repo, "hubowner/hub");
  assert.equal(f.project, "alpha");
  assert.equal(f.repoRel, "propagation/state/alpha/TODOS.md");
  const it = f.items.find((i) => i.id === "PR-001");
  assert.equal(it.held.length, 0);
  assert.equal(it.key, "propagation/state/alpha/TODOS.md#PR-001");
  assert.deepEqual(it.labels, ["task", "kind:todo", "project:alpha", "priority:P1"]);
});

test("body: link -> blob URL at HEAD, home path -> ~, fenced heading kept, footer and key present", () => {
  const f = fileOf(plan(), "alpha/TODOS.md");
  const it = f.items.find((i) => i.id === "PR-001");
  const sha = spawnSync("git", ["-C", hub, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  assert.match(sha, /^[0-9a-f]{40}$/);
  assert.equal(f.target.head, sha);
  assert.ok(it.body.includes(`](https://github.com/hubowner/hub/blob/${sha}/docs/x.md#top)`), it.body);
  assert.ok(it.body.includes("~/notes/a.md") && !it.body.includes(os.homedir()), "home path must become ~");
  assert.ok(it.body.includes("## not a heading, an illustration"), "a fenced heading must not end the entry (G77)");
  assert.ok(it.body.includes("Tail line of PR-001."), "the entry runs past its quoted fence");
  assert.ok(!it.body.includes("First thing"), "the heading line is excluded from the body");
  assert.ok(!it.body.includes("body three"), "the next entry must not leak in");
  assert.ok(it.body.includes("_Moved 2026-10-17 from `propagation/state/alpha/TODOS.md` entry PR-001; the register keeps a pointer line._"));
  assert.ok(it.body.endsWith("<!-- propagate-task key=propagation/state/alpha/TODOS.md#PR-001 -->"));
  assert.equal(it.bodyLength, it.body.length);
});

test("duplicate-id is HELD for the id that heads two entries; its sibling is still planned", () => {
  const f = fileOf(plan(), "alpha/TODOS.md");
  const dup = f.items.find((i) => i.id === "PR-003");
  assert.ok(dup, "PR-003 (open) must be listed, not dropped");
  assert.deepEqual(dup.held.map((h) => h.reason), ["duplicate-id"]);
  assert.equal(f.items.find((i) => i.id === "PR-001").held.length, 0);
});

test("oversize: a body over the GitHub limit is held", () => {
  const f = fileOf(plan(), "alpha/TODOS.md");
  const big = f.items.find((i) => i.id === "PR-009");
  assert.ok(big.bodyLength > BODY_LIMIT);
  assert.deepEqual(big.held.map((h) => h.reason), ["oversize"]);
});

test("checkbox items key on a short hash of their text; continuation lines count toward the body", () => {
  const f = fileOf(plan(), "boxes/TODOS.md");
  assert.equal(f.items.length, 1, "the checked box is closed, not an item");
  const it = f.items[0];
  assert.match(it.id, /^[0-9a-f]{10}$/);
  assert.ok(it.labels.includes("priority:P2") && it.labels.includes("kind:todo"));
});

test("ISSUES: severity from the heading and the upstream status become labels", () => {
  const f = fileOf(plan(), "alpha/ISSUES.md");
  const n1 = f.items.find((i) => i.id === "N1");
  assert.ok(n1.labels.includes("kind:issue") && n1.labels.includes("severity:S2") && n1.labels.includes("upstream"), n1.labels.join());
  const n2 = f.items.find((i) => i.id === "N2");
  assert.ok(!n2.labels.some((l) => l.startsWith("severity:") || l === "upstream"));
});

test("staged: a file with proposed entries is held as a whole, its open item still listed", () => {
  const f = fileOf(plan(), "stagedproj/TODOS.md");
  assert.ok(f.held.some((h) => h.reason === "staged"), JSON.stringify(f.held));
  assert.ok(f.items.some((i) => i.id === "PR-040"));
});

test("public target: title, label and body are scrubbed, and the scrub is SHOWN", () => {
  const f = fileOf(plan(), "Acme Client/TODOS.md");
  assert.equal(f.target.isPublic, true);
  const it = f.items.find((i) => i.id === "PR-101");
  assert.ok(!it.title.includes("Acme Client") && it.title.includes("client-a"), it.title);
  assert.ok(it.labels.includes("project:client-a"), it.labels.join());
  assert.ok(it.scrub.title && it.scrub.body && it.scrub.labels, "scrub diff must name title, body and labels");
  assert.deepEqual(it.held, []);
});

test("public target: a planted forbidden literal survives the scrub and is HELD `forbidden`", () => {
  const f = fileOf(plan(), "Acme Client/TODOS.md");
  const leak = f.items.find((i) => i.id === "PR-102");
  assert.deepEqual(leak.held.map((h) => h.reason), ["forbidden"]);
  assert.match(leak.held[0].detail, /home-dir username/);
});

test("public target with no identity map: the file is held `no-identity-map`, nothing is planned silently", () => {
  const f = fileOf(plan({ stateDirPath: emptyState }), "Acme Client/TODOS.md");
  assert.ok(f.held.some((h) => h.reason === "no-identity-map"), JSON.stringify(f.held));
  const private_ = fileOf(plan({ stateDirPath: emptyState }), "alpha/TODOS.md");
  assert.ok(!private_.held.some((h) => h.reason === "no-identity-map"), "a private target does not need the map");
});

test("issues-disabled: held, with the enclosing workspace repo named as the proposed target", () => {
  const f = fileOf(plan(), "nodisc/TODOS.md");
  assert.ok(f.held.some((h) => h.reason === "issues-disabled"));
  assert.equal(f.fallback.repo, "hubowner/hub");
  assert.match(f.fallback.reason, /enclosing workspace repo/);
});

test("other-owner and no-remote are held with their reason", () => {
  const p = plan();
  assert.ok(fileOf(p, "foreign/TODOS.md").held.some((h) => h.reason === "other-owner"));
  const nr = fileOf(p, "noremote/TODOS.md");
  assert.ok(nr.held.some((h) => h.reason === "no-remote"));
  assert.equal(nr.target, null);
  assert.equal(nr.items.length, 1, "a held file still lists its items");
});

test("handovers: an open section is planned, an unknown one is held, a closed one is skipped and counted", () => {
  const f = fileOf(plan(), "HANDOVERS.md");
  assert.equal(f.kind, "handover");
  const open = f.items.find((i) => i.title === "Open one");
  assert.equal(open.held.length, 0);
  assert.deepEqual(open.labels.slice(0, 3), ["task", "kind:handover", "project:hub"]);
  assert.match(open.key, /^HANDOVERS\.md#2026-10-01-1$/);
  const unknown = f.items.find((i) => i.title === "Unknown one");
  assert.deepEqual(unknown.held.map((h) => h.reason), ["unknown-status"]);
  assert.equal(f.skipped.closed, 1);
  assert.ok(!f.items.some((i) => i.title === "Closed one"));
});

test("summary: per-repo counts and the writes estimate against GitHub's hourly limit", () => {
  const s = plan().summary;
  const hubRepo = s.repos.find((r) => r.repo === "hubowner/hub");
  assert.ok(hubRepo.planned > 0 && hubRepo.held > 0);
  assert.equal(hubRepo.estimatedWrites, hubRepo.planned * 2 + hubRepo.labels);
  assert.equal(s.totalEstimatedWrites, s.repos.reduce((n, r) => n + r.estimatedWrites, 0));
  assert.equal(s.writesPerHour, 500);
  assert.ok(s.repos.some((r) => r.repo === "(no target)"), "the no-remote file is counted, not dropped");
});

test("--file selects one register; a path that is not a discovered register is an error, not an empty plan", () => {
  const one = plan({ all: false, file: path.join(hub, "foreign/TODOS.md") });
  assert.equal(one.files.length, 1);
  const bad = plan({ all: false, file: path.join(hub, "nope.md") });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /not a register/);
  const none = planExport({ backlogResult: backlog({ searchRoots: [hub] }), stateDirPath: stateDir });
  assert.equal(none.ok, false);
  assert.match(none.error, /--file.*--all/);
});

test("statSync sanity: the fixture hub is a real directory tree (guards a vacuous run)", () => {
  assert.ok(statSync(hub).isDirectory());
});
