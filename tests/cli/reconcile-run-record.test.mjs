/**
 * Tests for §3 of ~/.claude/plans/status-temporal-plum.md (lane W3): every
 * invocation of `propagate reconcile` appends one run record via
 * lib/core/runs.mjs, wired at the CALLER (cli.mjs's reconcileCmd), never
 * inside lib/edges/reconcile.mjs — that module's own header documents it as
 * READ-ONLY and this lane must not break that.
 *
 * Fixture discipline matches tests/cli/reconcile.test.mjs and
 * tests/cli/why.test.mjs: a real temp git repo + sidecar under
 * PROPAGATE_SEARCH_ROOTS, PROPAGATE_STATE_DIR scoped to a fresh tmpdir,
 * driven through the real CLI binary.
 *
 * Run: `npm test` (node --test tests/)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI_PATH = fileURLToPath(new URL("../../cli.mjs", import.meta.url));

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function commitAll(dir, msg = "snapshot") {
  git(["add", "."], dir);
  git(["commit", "-q", "-m", msg], dir);
}

async function makeFixtureWorkspace() {
  const searchRoot = await mkdtemp(path.join(tmpdir(), "run-record-search-"));
  const stateDir = await mkdtemp(path.join(tmpdir(), "run-record-state-"));
  const wsRoot = path.join(searchRoot, "run-record-ws");
  await mkdir(wsRoot, { recursive: true });
  git(["init", "-q", "-b", "main"], wsRoot);
  git(["config", "user.email", "test@example.com"], wsRoot);
  git(["config", "user.name", "Test"], wsRoot);
  await writeFile(path.join(wsRoot, "a.txt"), "a v1\n");
  await writeFile(path.join(wsRoot, "b.txt"), "b v1\n");
  await writeFile(
    path.join(wsRoot, ".propagates.yml"),
    `workspace: true
sources:
  a.txt:
    propagates_to:
      - path: b.txt
        why: "run-record fixture edge"
`,
  );
  await commitAll(wsRoot, "initial");
  return { searchRoot, stateDir, wsRoot };
}

function runCli(args, envVars) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], { encoding: "utf8", env: envVars });
}

async function readRunRecords(stateDir) {
  const runsDir = path.join(stateDir, "runs");
  let files;
  try {
    files = await readdir(runsDir);
  } catch {
    return [];
  }
  const rows = [];
  for (const f of files.filter((f) => f.endsWith(".jsonl"))) {
    const raw = await readFile(path.join(runsDir, f), "utf8");
    for (const line of raw.split("\n")) {
      if (line.trim()) rows.push(JSON.parse(line));
    }
  }
  return rows;
}

async function cleanup({ searchRoot, stateDir }) {
  await rm(searchRoot, { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
}

test("cli reconcile: one invocation appends exactly one run record", async () => {
  const fx = await makeFixtureWorkspace();
  try {
    const envVars = { ...process.env, PROPAGATE_SEARCH_ROOTS: fx.searchRoot, PROPAGATE_STATE_DIR: fx.stateDir };
    const result = runCli(["reconcile", "--all", "--json"], envVars);
    assert.equal(result.status, 0, `reconcile failed: ${result.stderr}`);

    const runs = await readRunRecords(fx.stateDir);
    assert.equal(runs.length, 1, "one reconcile invocation must append exactly one run record");
    assert.ok(typeof runs[0].run_id === "string" && runs[0].run_id.length > 0);
    assert.ok(typeof runs[0].ts === "string");
    assert.ok(Array.isArray(runs[0].roots) && runs[0].roots.length >= 1);
    assert.ok(runs[0].edge_counts && typeof runs[0].edge_counts === "object");
  } finally {
    await cleanup(fx);
  }
});

test("cli reconcile: a second invocation appends a second run record, not overwriting the first", async () => {
  const fx = await makeFixtureWorkspace();
  try {
    const envVars = { ...process.env, PROPAGATE_SEARCH_ROOTS: fx.searchRoot, PROPAGATE_STATE_DIR: fx.stateDir };
    runCli(["reconcile", "--all", "--json"], envVars);
    runCli(["reconcile", "--all", "--json"], envVars);

    const runs = await readRunRecords(fx.stateDir);
    assert.equal(runs.length, 2);
    assert.notEqual(runs[0].run_id, runs[1].run_id);
  } finally {
    await cleanup(fx);
  }
});

test("cli reconcile: does not break reconcile.mjs's read-only contract — reconcile itself still writes nothing", async () => {
  const fx = await makeFixtureWorkspace();
  try {
    // Snapshot the workspace's own files before/after: reconcile() (the
    // derivation) must not touch the sidecar or the source/downstream
    // files. The run record living under $STATE_DIR/runs is a CALLER
    // effect, not a reconcile() effect — this asserts the boundary held.
    const before = await readFile(path.join(fx.wsRoot, ".propagates.yml"), "utf8");
    const envVars = { ...process.env, PROPAGATE_SEARCH_ROOTS: fx.searchRoot, PROPAGATE_STATE_DIR: fx.stateDir };
    runCli(["reconcile", "--all", "--json"], envVars);
    const after = await readFile(path.join(fx.wsRoot, ".propagates.yml"), "utf8");
    assert.equal(before, after);
  } finally {
    await cleanup(fx);
  }
});
