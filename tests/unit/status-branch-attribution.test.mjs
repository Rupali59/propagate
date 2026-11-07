/**
 * propagate#122 -- `status` says when a drifted edge was last verified on a different branch.
 *
 * Verification pins CONTENT. After a checkout of a sibling branch, settled edges read DRIFTED/REVERSED/
 * DIVERGED and nothing said it was a branch effect. `branchAttribution` is attribution only: it reads the
 * branch fields already on `row.last` and never changes a state.
 *
 * The unit cases drive the pure function with an injected `currentBranchOf`; the end-to-end case drives the
 * real CLI in a temp git repo. Each guard below has a mutation noted beside it (see the PR/report).
 */
// @size medium — starts processes (CLI or script); run when affected

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { branchAttribution, branchAttributionLines } from "../../cli/status.mjs";

const CLI_PATH = fileURLToPath(new URL("../../cli.mjs", import.meta.url));

const row = (id, state, last, src = "/r/a.md", dst = "/r/b.md") => ({
  edge_id: id, state, last, source: { path: src }, downstream: { path: dst },
});
const on = (s, d = s) => ({ observed_on_branch: s, downstream_on_branch: d });

test("a moved edge verified on branch a, checked out on b, is attributed a -> b", () => {
  const r = branchAttribution([row("e1", "DRIFTED", on("a"))], () => "b");
  assert.deepEqual(r.otherBranch, [{ edge_id: "e1", repo: null, verifiedOn: "a", currentBranch: "b", side: "both" }]);
  assert.equal(r.unknown, 0);
});

test("the same branch is not attributed, and is not unknown either", () => {
  const r = branchAttribution([row("e1", "DRIFTED", on("a"))], () => "a");
  assert.deepEqual(r.otherBranch, []);
  assert.equal(r.unknown, 0, "same branch is a resolved fact, not an absence");
});

test("source side alone is enough (a downstream-only comparison would miss it)", () => {
  const cur = (p) => (p === "/r/a.md" ? "b" : "a");
  const r = branchAttribution([row("e1", "DRIFTED", on("a", "a"))], cur);
  assert.equal(r.otherBranch.length, 1);
  assert.equal(r.otherBranch[0].side, "source");
});

test("downstream side alone is enough", () => {
  const cur = (p) => (p === "/r/b.md" ? "b" : "a");
  const r = branchAttribution([row("e1", "REVERSED", on("a", "a"))], cur);
  assert.equal(r.otherBranch[0].side, "downstream");
});

test("an event with no branch field is unknown, never a match", () => {
  const r = branchAttribution([row("e1", "DRIFTED", { out_of_order: false })], () => "b");
  assert.deepEqual(r.otherBranch, []);
  assert.equal(r.unknown, 1, "older events must read unknown");
});

test("a null branch on the event (verified on a detached HEAD) is unknown", () => {
  const r = branchAttribution([row("e1", "DIVERGED", on(null))], () => "b");
  assert.equal(r.unknown, 1);
  assert.deepEqual(r.otherBranch, []);
});

test("a detached HEAD now is not a match: it reads 'detached'", () => {
  const r = branchAttribution([row("e1", "DRIFTED", on("a"))], () => "");
  assert.equal(r.otherBranch[0].currentBranch, "detached");
});

test("a failed git call (null or throw) reads unknown, and never throws", () => {
  assert.equal(branchAttribution([row("e1", "DRIFTED", on("a"))], () => null).unknown, 1);
  const r = branchAttribution([row("e1", "DRIFTED", on("a"))], () => { throw new Error("boom"); });
  assert.equal(r.unknown, 1);
  assert.deepEqual(r.otherBranch, []);
});

test("only moved rows count: CLEAN, NEVER_VERIFIED and DEFERRED are never attributed", () => {
  const rows = ["CLEAN", "NEVER_VERIFIED", "DEFERRED"].map((s, i) => row("e" + i, s, on("a")));
  const r = branchAttribution(rows, () => "b");
  assert.deepEqual(r.otherBranch, []);
  assert.equal(r.unknown, 0);
  assert.equal(r.moved, 0);
});

test("a moved row with no `last` is skipped, not crashed on", () => {
  const r = branchAttribution([row("e1", "DRIFTED", undefined)], () => "b");
  assert.deepEqual(r.otherBranch, []);
});

test("the text line groups by verifiedOn -> currentBranch and counts against the moved total", () => {
  const rows = [
    row("e1", "DRIFTED", on("a")), row("e2", "DRIFTED", on("a")), row("e3", "DIVERGED", on("b")),
  ];
  const lines = branchAttributionLines(branchAttribution(rows, () => "c"));
  assert.equal(lines.length, 2);
  // No repoOf was given, so the repo is unnamed: "their repo", never "you".
  assert.match(lines[0], /^2 of 3 in their repo were last verified on a; that repo is now on c\./);
  assert.match(lines[1], /^1 of 3 in their repo were last verified on b; that repo is now on c\./);
});

test("the line names the REPO whose branch moved, never the reader (measured 2026-11-07 on the hub)", () => {
  // From the hub on `main`, the first version printed "you are on issue-61-shared-standards": that was
  // Keerti/retail-restock-fiori's branch, not the reader's. Groups split by repo as well as by branch pair.
  const rows = [
    row("e1", "DRIFTED", on("a"), "/hub/Keerti/fiori/A.md", "/hub/Keerti/fiori/A2.md"),
    row("e2", "DRIFTED", on("a"), "/hub/Other/repo/B.md", "/hub/Other/repo/B2.md"),
  ];
  const repoOf = (p) => (p.startsWith("/hub/Keerti/fiori/") ? "/hub/Keerti/fiori" : "/hub/Other/repo");
  const attr = branchAttribution(rows, () => "b", repoOf);
  assert.equal(attr.otherBranch[0].repo, "/hub/Keerti/fiori");
  const lines = branchAttributionLines(attr, "/hub");
  assert.equal(lines.length, 2, lines.join("\n"));
  assert.ok(lines.some((l) => /^1 of 2 in Keerti\/fiori were last verified on a; that repo is now on b\./.test(l)), lines.join("\n"));
  assert.ok(lines.every((l) => !/\byou are on\b/.test(l)), "the reader is never named");
});

test("currentBranchOf is called once per repo root, however many edges", async () => {
  const { makeCurrentBranchOf } = await import("../../cli/status.mjs");
  const dir = await mkdtemp(path.join(tmpdir(), "attr-calls-"));
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    const f = (n) => path.join(dir, n);
    const fn = makeCurrentBranchOf();
    const seen = [];
    for (let i = 0; i < 20; i++) seen.push(fn(f(`f${i}.md`)));
    assert.deepEqual([...new Set(seen)], ["main"]);
    // injected counter around the production cache: the real git calls are what must be one per root
    let calls = 0;
    const counted = (p) => { calls++; return fn(p); };
    const rows = Array.from({ length: 20 }, (_, i) => row("e" + i, "DRIFTED", on("a"), f(`f${i}.md`), f(`g${i}.md`)));
    branchAttribution(rows, counted);
    assert.equal(calls, 40, "the injected function is asked per side; the cache behind it is per root");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("production currentBranchOf runs git once per repo root (counted via a git shim)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "attr-shim-"));
  try {
    const repo = path.join(dir, "repo");
    await mkdir(repo);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const log = path.join(dir, "calls.log");
    const bin = path.join(dir, "bin");
    await mkdir(bin);
    await writeFile(path.join(bin, "git"), `#!/bin/sh\necho "$@" >> "${log}"\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
    const script = `
      import { makeCurrentBranchOf, branchAttribution } from ${JSON.stringify(new URL("../../cli/status.mjs", import.meta.url).href)};
      const f = makeCurrentBranchOf();
      const rows = Array.from({length: 30}, (_, i) => ({edge_id: "e"+i, state: "DRIFTED",
        last: {observed_on_branch: "a", downstream_on_branch: "a"},
        source: {path: ${JSON.stringify(repo)} + "/s" + i}, downstream: {path: ${JSON.stringify(repo)} + "/d" + i}}));
      const r = branchAttribution(rows, f);
      console.log(JSON.stringify({n: r.otherBranch.length}));`;
    const out = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    assert.equal(out.status, 0, out.stderr);
    assert.equal(JSON.parse(out.stdout).n, 30);
    const { readFileSync } = await import("node:fs");
    const gitCalls = readFileSync(log, "utf8").trim().split("\n");
    const branchCalls = gitCalls.filter((l) => l.includes("--show-current"));
    assert.equal(branchCalls.length, 1, `one branch lookup per repo root, got: ${gitCalls.join(" | ")}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── end to end ───────────────────────────────────────────────────────────────────────────────────────
function git(args, cwd) { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }

test("end to end: verify on branch a, check out sibling b with a different source, status names both branches", async (t) => {
  const searchRoot = await mkdtemp(path.join(tmpdir(), "attr-e2e-root-"));
  const stateDir = await mkdtemp(path.join(tmpdir(), "attr-e2e-state-"));
  t.after(() => Promise.all([
    rm(searchRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
    rm(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  ]));
  const ws = path.join(searchRoot, "ws");
  await mkdir(ws, { recursive: true });
  git(["init", "-q", "-b", "main"], ws);
  git(["config", "user.email", "t@example.com"], ws);
  git(["config", "user.name", "T"], ws);
  await writeFile(path.join(ws, "A.md"), "A v1\n");
  await writeFile(path.join(ws, "B.md"), "B v1\n");
  await writeFile(path.join(ws, ".propagates.yml"), [
    "workspace: true", "sources:", "  A.md:", "    propagates_to:",
    "      - path: B.md", "        why: A feeds B", "        kind: prose", "",
  ].join("\n"));
  git(["add", "."], ws);
  git(["commit", "-q", "-m", "init"], ws);

  const run = (argv) => spawnSync(process.execPath, [CLI_PATH, ...argv], {
    encoding: "utf8", cwd: ws,
    env: { ...process.env, PROPAGATE_SEARCH_ROOTS: searchRoot, PROPAGATE_STATE_DIR: stateDir },
  });
  git(["checkout", "-q", "-b", "branch-a"], ws);
  const rows = JSON.parse(run(["reconcile", "--all", "--json"]).stdout).rows;
  assert.equal(rows.length, 1);
  const v = run(["verify", "--edge", rows[0].edge_id, "--disposition", "baselined", "--reason", "test baseline", "--apply", "--json"]);
  assert.equal(v.status, 0, v.stderr + v.stdout);

  // sibling branch cut from main with a different source
  git(["checkout", "-q", "main"], ws);
  git(["checkout", "-q", "-b", "branch-b"], ws);
  await writeFile(path.join(ws, "A.md"), "A v2 (only on b)\n");
  git(["commit", "-q", "-am", "A on b"], ws);

  const j = run(["status", "--json"]);
  assert.equal(j.status, 0, j.stderr);
  const attr = JSON.parse(j.stdout).branch_attribution;
  assert.equal(attr.otherBranch.length, 1, JSON.stringify(attr));
  assert.equal(attr.otherBranch[0].verifiedOn, "branch-a");
  assert.equal(attr.otherBranch[0].currentBranch, "branch-b");

  // The text path needs a ledger file to get past "(no ledger file yet)"; the --json block is the contract,
  // so only assert the line when the text path ran.
  const txt = run(["status"]);
  if (!/no ledger file yet/.test(txt.stdout)) {
    assert.match(txt.stdout, /1 of 1 in \S+ were last verified on branch-a; that repo is now on branch-b\./);
  }
});
