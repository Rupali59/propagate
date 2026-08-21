/**
 * Tests for `bootstrap` — lib/bootstrap.mjs + cli.mjs's `bootstrap` command
 * (plan Part 1: ~/.claude/plans/jolly-waddling-sphinx.md).
 *
 * Two strategies, split the same way tests/verify.test.mjs and
 * tests/content-id.test.mjs split theirs:
 *
 *   - PURE / DIRECT: buildCommitFileMap, findCoCommit, planBaseline, gitStage
 *     are tested by importing lib/bootstrap.mjs directly against real temp
 *     git repos. None of these call appendEvent, so none of them can write
 *     into whatever EVENTS_DIR this process resolved at import time — safe
 *     to import at the top of this file (same reasoning tests/verify.test.mjs
 *     already relies on for cli.mjs's pure exports). `applyBaseline` is
 *     NEVER called in-process in this file for exactly that reason (GOTCHAS
 *     G21: a leaked write into the real default store is a landmine with a
 *     timer) — every test that writes an event goes through a `bootstrap`
 *     CLI subprocess with PROPAGATE_SEARCH_ROOTS/PROPAGATE_STATE_DIR scoped
 *     to a fresh tmpdir, exactly like tests/verify.test.mjs's `runCli`.
 *
 *   - SUBPROCESS: the full pipeline (git stage -> reconcile -> plan ->
 *     apply -> verify-after-write) via `node cli.mjs bootstrap ...`.
 *
 * Run: `npm test` (node --test tests/)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readdir, rm } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  gitStage,
  buildCommitFileMap,
  findCoCommit,
  planBaseline,
  BASELINE_POLICIES,
  DEFAULT_WALK_COMMITS,
  __getSpawnCountForTests,
  __resetSpawnCountForTests,
} from "../../lib/edges/bootstrap.mjs";
import { computeVerifyAfterWrite } from "../../cli.mjs";

const CLI_PATH = fileURLToPath(new URL("../../cli.mjs", import.meta.url));

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function makeRepo(prefix = "bootstrap-test-") {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "Test"], dir);
  return dir;
}

async function commitAll(dir, msg = "snapshot") {
  git(["add", "."], dir);
  git(["commit", "-q", "-m", msg], dir);
  return git(["rev-parse", "HEAD"], dir);
}

async function makeWorkspace(searchRoot, name) {
  const wsRoot = path.join(searchRoot, name);
  await mkdir(wsRoot, { recursive: true });
  git(["init", "-q", "-b", "main"], wsRoot);
  git(["config", "user.email", "test@example.com"], wsRoot);
  git(["config", "user.name", "Test"], wsRoot);
  return wsRoot;
}

function runCli(argv, { searchRoot, stateDir }) {
  return spawnSync(process.execPath, [CLI_PATH, ...argv], {
    encoding: "utf8",
    env: { ...process.env, PROPAGATE_SEARCH_ROOTS: searchRoot, PROPAGATE_STATE_DIR: stateDir },
  });
}

function runBootstrapJson(argv, env) {
  const r = runCli(["bootstrap", ...argv, "--json"], env);
  assert.equal(r.status === 0 || r.status === 1, true, `bootstrap --json crashed: ${r.stderr}\n${r.stdout}`);
  return { result: JSON.parse(r.stdout.trim()), status: r.status, stderr: r.stderr };
}

function runReconcileJson(env) {
  const r = runCli(["reconcile", "--all", "--json"], env);
  assert.equal(r.status, 0, `reconcile --json failed: ${r.stderr}`);
  return JSON.parse(r.stdout.trim());
}

async function withFixture(fn) {
  const searchRoot = await mkdtemp(path.join(tmpdir(), "bootstrap-search-"));
  const stateDir = await mkdtemp(path.join(tmpdir(), "bootstrap-state-"));
  try {
    await fn({ searchRoot, stateDir });
  } finally {
    await rm(searchRoot, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// PURE: buildCommitFileMap / findCoCommit — co-commit detection (test #3).
// ─────────────────────────────────────────────────────────────────────────

test("findCoCommit — a shared commit is found; files never committed together are not", async () => {
  const repo = await makeRepo();

  await writeFile(path.join(repo, "src.txt"), "src v1\n");
  await writeFile(path.join(repo, "dst.txt"), "dst v1\n");
  const coCommitSha = await commitAll(repo, "src + dst together");

  await writeFile(path.join(repo, "other.txt"), "unrelated\n");
  await commitAll(repo, "unrelated change");

  const repoMap = buildCommitFileMap(repo);
  assert.equal(findCoCommit(repoMap, "src.txt", "dst.txt"), coCommitSha);
  assert.equal(findCoCommit(repoMap, "src.txt", "other.txt"), null, "never committed together");
  assert.equal(findCoCommit(repoMap, "nope.txt", "dst.txt"), null, "file never existed");
});

// ─────────────────────────────────────────────────────────────────────────
// PURE: bound-reached reported distinctly from no-co-commit (test #4).
// ─────────────────────────────────────────────────────────────────────────

test("buildCommitFileMap — truncated is true only when history exceeds the bound", async () => {
  const repo = await makeRepo();
  await writeFile(path.join(repo, "a.txt"), "a\n");
  await commitAll(repo, "one commit");

  const small = buildCommitFileMap(repo, 400);
  assert.equal(small.truncated, false, "1 commit against a 400 bound is never truncated");
  assert.equal(small.totalCommits, 1);
});

test("planBaseline — an old co-commit pushed outside the bound reports bound-reached, distinct from no-co-commit", async () => {
  const repo = await makeRepo();
  await writeFile(path.join(repo, "src.txt"), "src v1\n");
  await writeFile(path.join(repo, "dst.txt"), "dst v1\n");
  await commitAll(repo, "src + dst together (will fall outside the window)");

  // Push the co-commit outside a small bound with unrelated commits.
  for (let i = 0; i < 5; i++) {
    await writeFile(path.join(repo, `filler-${i}.txt`), `filler ${i}\n`);
    await commitAll(repo, `filler ${i}`);
  }

  const nodeId = `${path.basename(repo)}:src.txt`;
  const boundRow = {
    state: "NEVER_VERIFIED",
    sameRepo: true,
    edge_id: "bound-edge",
    node_id: nodeId,
    source: { path: path.join(repo, "src.txt") },
    downstream: { path: path.join(repo, "dst.txt") },
  };

  const { outcomes } = planBaseline([boundRow], "baseline-from-git", { bound: 3 });
  assert.equal(outcomes.baselined.length, 0);
  assert.equal(outcomes.boundReached.length, 1, "the co-commit exists but predates the walk window");
  assert.equal(outcomes.noCoCommit.length, 0, "must not be folded into no-co-commit — that is the G2 ambiguity this reports against");

  // Same edge, full-history bound -> found and baselined.
  const { outcomes: fullOutcomes } = planBaseline([boundRow], "baseline-from-git", { bound: 400 });
  assert.equal(fullOutcomes.baselined.length, 1);
  assert.match(fullOutcomes.baselined[0].reason, /co-committed at [0-9a-f]{40}/);
});

test("planBaseline — genuinely no shared commit, within the window, reports no-co-commit (not bound-reached)", async () => {
  const repo = await makeRepo();
  await writeFile(path.join(repo, "src.txt"), "src v1\n");
  await commitAll(repo, "src only");
  await writeFile(path.join(repo, "dst.txt"), "dst v1\n");
  await commitAll(repo, "dst only, separate commit");

  const row = {
    state: "NEVER_VERIFIED",
    sameRepo: true,
    edge_id: "no-share-edge",
    node_id: `${path.basename(repo)}:src.txt`,
    source: { path: path.join(repo, "src.txt") },
    downstream: { path: path.join(repo, "dst.txt") },
  };

  const { outcomes } = planBaseline([row], "baseline-from-git", { bound: 400 });
  assert.equal(outcomes.baselined.length, 0);
  assert.equal(outcomes.noCoCommit.length, 1);
  assert.equal(outcomes.boundReached.length, 0, "full history was searched — this is a definitive miss, not a bound artifact");
});

// ─────────────────────────────────────────────────────────────────────────
// PURE: cross-repo edges report ineligible-cross-repo, not failure (test #5).
// ─────────────────────────────────────────────────────────────────────────

test("planBaseline — cross-repo edges are reported ineligible-cross-repo, never as a failure", () => {
  const rows = [
    {
      state: "NEVER_VERIFIED",
      sameRepo: false,
      edge_id: "cross-edge",
      node_id: "repoA:src.txt",
      source: { path: "/tmp/repoA/src.txt" },
      downstream: { path: "/tmp/repoB/dst.txt" },
    },
  ];
  const { outcomes, neverVerifiedCount } = planBaseline(rows, "baseline-from-git", {});
  assert.equal(neverVerifiedCount, 1);
  assert.equal(outcomes.ineligibleCrossRepo.length, 1);
  assert.equal(outcomes.baselined.length, 0);
  assert.equal(outcomes.noCoCommit.length, 0);
  assert.equal(outcomes.boundReached.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────
// PURE: batching — spawn count is O(repos), not O(edges) (test #10).
// ─────────────────────────────────────────────────────────────────────────

test("planBaseline (baseline-from-git) — git spawn count is O(1) per repo, not O(edges)", async () => {
  const repo = await makeRepo();
  await writeFile(path.join(repo, "src.txt"), "src v1\n");
  await writeFile(path.join(repo, "dst.txt"), "dst v1\n");
  const sha = await commitAll(repo, "src + dst");

  // 20 edges, ALL resolving into the same repo (a glob-expansion-shaped
  // scenario) — the batching claim is that this costs the same git spawns
  // as 1 edge would, never 20x.
  const rows = [];
  for (let i = 0; i < 20; i++) {
    rows.push({
      state: "NEVER_VERIFIED",
      sameRepo: true,
      edge_id: `edge-${i}`,
      node_id: `${path.basename(repo)}:src.txt`,
      source: { path: path.join(repo, "src.txt") },
      downstream: { path: path.join(repo, "dst.txt") },
    });
  }

  __resetSpawnCountForTests();
  const { outcomes } = planBaseline(rows, "baseline-from-git", { bound: 400 });
  const spawnCount = __getSpawnCountForTests();

  assert.equal(outcomes.baselined.length, 20, "every edge in the repo resolves against the same evidence");
  assert.ok(outcomes.baselined.every((b) => b.reason.includes(sha)));
  // ONE `git log` + ONE `git rev-list --count` per repo — 2 spawns total for
  // 20 edges in 1 repo, never 20 (or 40) spawns. Asserted by count, never by
  // timing (G6: "assert it with an injected spawn counter, never with timing").
  assert.equal(spawnCount, 2, "must be O(repos) (2 spawns for 1 repo), not O(edges) (would be 20+)");
});

test("planBaseline — multiple repos each cost their own O(1) spawns, still not O(edges)", async () => {
  const repoA = await makeRepo("bootstrap-repoA-");
  const repoB = await makeRepo("bootstrap-repoB-");
  for (const repo of [repoA, repoB]) {
    await writeFile(path.join(repo, "src.txt"), "src v1\n");
    await writeFile(path.join(repo, "dst.txt"), "dst v1\n");
    await commitAll(repo, "src + dst");
  }

  const rows = [];
  for (const repo of [repoA, repoB]) {
    for (let i = 0; i < 10; i++) {
      rows.push({
        state: "NEVER_VERIFIED",
        sameRepo: true,
        edge_id: `${path.basename(repo)}-edge-${i}`,
        node_id: `${path.basename(repo)}:src.txt`,
        source: { path: path.join(repo, "src.txt") },
        downstream: { path: path.join(repo, "dst.txt") },
      });
    }
  }

  __resetSpawnCountForTests();
  const { outcomes } = planBaseline(rows, "baseline-from-git", { bound: 400 });
  assert.equal(outcomes.baselined.length, 20);
  assert.equal(__getSpawnCountForTests(), 4, "2 repos x 2 spawns each = 4, for 20 total edges");
});

// ─────────────────────────────────────────────────────────────────────────
// PURE: --none and --baseline-all never touch git.
// ─────────────────────────────────────────────────────────────────────────

test("planBaseline — --none classifies nothing and never spawns git", () => {
  const rows = [
    {
      state: "NEVER_VERIFIED",
      sameRepo: true,
      edge_id: "e1",
      node_id: "n1",
      source: { path: "/tmp/x/src.txt" },
      downstream: { path: "/tmp/x/dst.txt" },
    },
  ];
  __resetSpawnCountForTests();
  const { outcomes, neverVerifiedCount } = planBaseline(rows, "none", {});
  assert.equal(neverVerifiedCount, 1);
  assert.equal(outcomes.baselined.length, 0);
  assert.equal(__getSpawnCountForTests(), 0);
});

test("planBaseline — --baseline-all baselines every NEVER_VERIFIED row without touching git", () => {
  const rows = [
    { state: "NEVER_VERIFIED", sameRepo: true, edge_id: "e1", node_id: "n1", source: { path: "a" }, downstream: { path: "b" } },
    { state: "NEVER_VERIFIED", sameRepo: false, edge_id: "e2", node_id: "n2", source: { path: "c" }, downstream: { path: "d" } },
    { state: "CLEAN", sameRepo: true, edge_id: "e3", node_id: "n3", source: { path: "e" }, downstream: { path: "f" } },
  ];
  __resetSpawnCountForTests();
  const { outcomes, neverVerifiedCount } = planBaseline(rows, "baseline-all", {});
  assert.equal(neverVerifiedCount, 2, "only NEVER_VERIFIED rows are eligible; the CLEAN row is left alone");
  assert.equal(outcomes.baselined.length, 2);
  assert.ok(outcomes.baselined.every((b) => /baseline-all/.test(b.reason)));
  assert.equal(__getSpawnCountForTests(), 0, "--baseline-all never touches git");
});

// ─────────────────────────────────────────────────────────────────────────
// PURE: the git stage — non-git directory offers init, states the ref lens
// does not apply, never throws (test #8).
// ─────────────────────────────────────────────────────────────────────────

test("gitStage — a non-git directory offers `git init`, never throws, and is not run without apply", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bootstrap-nogit-"));
  try {
    const entries = await gitStage([{ root: dir }], { apply: false });
    assert.equal(entries.length, 1);
    const [entry] = entries;
    assert.equal(entry.existedAsRepoBefore, false);
    assert.equal(entry.isRepoNow, false, "the ref lens does not apply here — never silently treated as a repo");
    assert.equal(entry.created, false, "must never run git init without apply");
    assert.equal(entry.offeredInitCommand, `git init "${dir}"`);
    assert.equal(entry.branches, 0);
    assert.equal(entry.worktrees, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("gitStage — apply:true on a non-git directory runs `git init` and it becomes a repo", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bootstrap-nogit-apply-"));
  try {
    const entries = await gitStage([{ root: dir }], { apply: true });
    const [entry] = entries;
    assert.equal(entry.existedAsRepoBefore, false);
    assert.equal(entry.created, true);
    assert.equal(entry.isRepoNow, true);
    assert.equal(entry.offeredInitCommand, null, "already a repo now — nothing left to offer");
    assert.equal(entry.initError, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("gitStage — an existing repo is reported as such, with branch/worktree counts, never re-init'd", async () => {
  const repo = await makeRepo();
  await writeFile(path.join(repo, "a.txt"), "a\n");
  await commitAll(repo, "initial");

  const entries = await gitStage([{ root: repo }], { apply: true });
  const [entry] = entries;
  assert.equal(entry.existedAsRepoBefore, true);
  assert.equal(entry.created, false, "must never re-init an existing repo");
  assert.equal(entry.isRepoNow, true);
  assert.equal(entry.branches, 1, "the one commit lives on `main`");
  assert.equal(entry.refsError, null);
});

// ─────────────────────────────────────────────────────────────────────────
// PURE: verify-after-write catches an edge that did not move (test #9).
// Reuses cli.mjs's computeVerifyAfterWrite — bootstrap's own write path
// (applyBaseline's `applied` shape: disposition "baselined") is exactly the
// shape this function already expects, so the failure mode is tested
// directly against it rather than re-implemented.
// ─────────────────────────────────────────────────────────────────────────

test("computeVerifyAfterWrite — a baselined edge that did not reach CLEAN is reported as failed, not silently accepted", () => {
  const applied = [
    { edge_id: "e1", node_id: "n1", disposition: "baselined", priorState: "NEVER_VERIFIED", event_id: "ev1" },
    { edge_id: "e2", node_id: "n2", disposition: "baselined", priorState: "NEVER_VERIFIED", event_id: "ev2" },
  ];
  const afterRows = [
    { edge_id: "e1", state: "NEVER_VERIFIED" }, // the write "returned" but didn't take
    { edge_id: "e2", state: "CLEAN" },
  ];
  const { confirmed, failed } = computeVerifyAfterWrite(applied, afterRows);
  assert.equal(confirmed.length, 1);
  assert.equal(confirmed[0].edge_id, "e2");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].edge_id, "e1");
  assert.match(failed[0].error, /expected state CLEAN.*got NEVER_VERIFIED/);
});

// ─────────────────────────────────────────────────────────────────────────
// SUBPROCESS: dry-run writes nothing (test #1).
// ─────────────────────────────────────────────────────────────────────────

test("bootstrap dry-run — writes nothing; the event store stays untouched", async () => {
  await withFixture(async (env) => {
    const ws = await makeWorkspace(env.searchRoot, "ws-dry");
    await writeFile(path.join(ws, "src.txt"), "src v1\n");
    await writeFile(path.join(ws, "dst.txt"), "dst v1\n");
    await writeFile(
      path.join(ws, ".propagates.yml"),
      `workspace: true
sources:
  src.txt:
    propagates_to:
      - path: dst.txt
        why: "dry run pairing"
`,
    );
    await commitAll(ws, "initial");

    const { result, status } = runBootstrapJson(["--baseline-from-git"], env);
    assert.equal(status, 0);
    assert.equal(result.apply, false);
    assert.ok(result.outcomeCounts.baselined >= 1, "at least the co-committed pairing should be classified baselineable");
    assert.equal(result.applied.length, 0, "dry-run must never apply anything");

    // The store directory either doesn't exist yet, or exists with no
    // shard files — either is "untouched", both are asserted so a stray
    // mkdir with no write still counts as a pass, never a false failure.
    let shardFiles = [];
    try {
      shardFiles = (await readdir(path.join(env.stateDir, "events"))).filter((f) => f.endsWith(".jsonl"));
    } catch {
      shardFiles = [];
    }
    assert.equal(shardFiles.length, 0, "no event shard file may exist after a dry run");

    const after = runReconcileJson(env);
    assert.ok(after.rows.every((r) => r.state === "NEVER_VERIFIED"), "reconcile must still see every edge as NEVER_VERIFIED");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// SUBPROCESS: --apply writes one baselined event per eligible edge, each
// carrying its SHA (test #2), and after --apply no edge reads "verified" —
// baselined is distinguishable (test #6).
// ─────────────────────────────────────────────────────────────────────────

test("bootstrap --apply — writes one baselined event per eligible edge, citing its SHA; never reads as verified", async () => {
  await withFixture(async (env) => {
    const ws = await makeWorkspace(env.searchRoot, "ws-apply");
    await writeFile(path.join(ws, "src.txt"), "src v1\n");
    await writeFile(path.join(ws, "dst.txt"), "dst v1\n");
    await writeFile(
      path.join(ws, ".propagates.yml"),
      `workspace: true
sources:
  src.txt:
    propagates_to:
      - path: dst.txt
        why: "apply pairing"
`,
    );
    const sha = await commitAll(ws, "src + dst together");

    const { result, status } = runBootstrapJson(["--baseline-from-git", "--apply"], env);
    assert.equal(status, 0, JSON.stringify(result));
    assert.equal(result.apply, true);
    assert.equal(result.applied.length, 1);
    assert.equal(result.confirmed.length, 1);
    assert.equal(result.failed.length, 0);
    assert.equal(result.verifyFailed.length, 0);

    const after = runReconcileJson(env);
    assert.equal(after.rows.length, 1);
    const row = after.rows[0];
    assert.equal(row.state, "CLEAN", "a baselined edge with unchanged content reads CLEAN");
    assert.equal(row.last.disposition, "baselined", "never any other disposition — DISPOSITIONS has no 'verified'");
    assert.notEqual(row.last.disposition, "verified");
    assert.match(row.last.reason, new RegExp(sha), "the reason must name the exact co-commit SHA");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// SUBPROCESS: lib/edges/bootstrap.mjs's applyBaseline routes through
// lib/edges/provenance.mjs too (lane W1, status-temporal-plum.md §1+§2) —
// same helper cli.mjs's verify command uses, so a `baselined` event carries
// the same provenance shape as a `verify`-written one.
// ─────────────────────────────────────────────────────────────────────────

test("bootstrap --apply — the baselined event carries provenance: working-tree ref, real commit position, by_kind bootstrap", async () => {
  await withFixture(async (env) => {
    const ws = await makeWorkspace(env.searchRoot, "ws-prov");
    await writeFile(path.join(ws, "src.txt"), "src v1\n");
    await writeFile(path.join(ws, "dst.txt"), "dst v1\n");
    await writeFile(
      path.join(ws, ".propagates.yml"),
      `workspace: true
sources:
  src.txt:
    propagates_to:
      - path: dst.txt
        why: "provenance pairing"
`,
    );
    await commitAll(ws, "src + dst together");
    const realSha = git(["rev-parse", "HEAD"], ws);

    const { status } = runBootstrapJson(["--baseline-from-git", "--apply"], env);
    assert.equal(status, 0);

    const after = runReconcileJson(env);
    assert.equal(after.rows.length, 1);
    const last = after.rows[0].last;

    assert.equal(last.observed_on_ref, "working-tree");
    assert.equal(last.observed_at_commit, realSha);
    assert.equal(last.observed_on_branch, "main");
    // `bootstrap` scaffolds a `.propagation/` directory (v1 ledger
    // side effect, STATE.md P1's `ledgerScaffoldingAllowed()`) as an
    // untracked directory BEFORE applyBaseline writes its events, so the
    // tree is genuinely dirty at write time — verified directly against a
    // real repo: `git status --porcelain` shows `?? .propagation/` right
    // after `bootstrap --apply` runs, before this test existed. Asserting
    // `false` here would have been the same "assume clean" mistake this
    // wedge exists to catch, just baked into the fixture instead of the code.
    assert.equal(last.observed_dirty, true);
    assert.equal(last.by_kind, "bootstrap", "bootstrap's own default, distinct from verify's 'human'");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// SUBPROCESS: --none leaves everything NEVER_VERIFIED (test #7).
// ─────────────────────────────────────────────────────────────────────────

test("bootstrap --none --apply — leaves every edge NEVER_VERIFIED; nothing is written", async () => {
  await withFixture(async (env) => {
    const ws = await makeWorkspace(env.searchRoot, "ws-none");
    await writeFile(path.join(ws, "src.txt"), "src v1\n");
    await writeFile(path.join(ws, "dst.txt"), "dst v1\n");
    await writeFile(
      path.join(ws, ".propagates.yml"),
      `workspace: true
sources:
  src.txt:
    propagates_to:
      - path: dst.txt
        why: "none pairing"
`,
    );
    await commitAll(ws, "src + dst together");

    const { result, status } = runBootstrapJson(["--none", "--apply"], env);
    assert.equal(status, 0);
    assert.equal(result.outcomeCounts.baselined, 0);
    assert.equal(result.applied.length, 0);

    const after = runReconcileJson(env);
    assert.ok(after.rows.every((r) => r.state === "NEVER_VERIFIED"));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// SUBPROCESS: the git stage runs inside a real (already-git) workspace and
// reports what existed, distinct from what this run created.
// ─────────────────────────────────────────────────────────────────────────

test("bootstrap — git stage reports an already-existing repo's branch count, without re-creating it", async () => {
  await withFixture(async (env) => {
    const ws = await makeWorkspace(env.searchRoot, "ws-gitstage");
    await writeFile(path.join(ws, "src.txt"), "src v1\n");
    await writeFile(path.join(ws, ".propagates.yml"), `workspace: true\nsources: {}\n`);
    await commitAll(ws, "initial");

    const { result, status } = runBootstrapJson(["--none"], env);
    assert.equal(status, 0);
    const entry = result.gitStage.find((s) => s.root === ws);
    assert.ok(entry, "the workspace root must appear in the git stage report");
    assert.equal(entry.existedAsRepoBefore, true);
    assert.equal(entry.created, false);
    assert.equal(entry.isRepoNow, true);
    assert.equal(entry.branches, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Argument validation.
// ─────────────────────────────────────────────────────────────────────────

test("bootstrap — mutually exclusive policy flags are rejected", async () => {
  await withFixture(async (env) => {
    await makeWorkspace(env.searchRoot, "ws-badargs");
    const r = runCli(["bootstrap", "--baseline-all", "--none"], env);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /choose exactly one of/);
  });
});

test("BASELINE_POLICIES — exposes the three documented policies", () => {
  assert.deepEqual([...BASELINE_POLICIES], ["baseline-from-git", "baseline-all", "none"]);
});

test("DEFAULT_WALK_COMMITS — matches the plan's documented bound", () => {
  assert.equal(DEFAULT_WALK_COMMITS, 400);
});
