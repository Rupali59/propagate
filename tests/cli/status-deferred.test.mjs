/**
 * `status` — a deferred edge is not a baseline gap (ISSUES N71).
 *
 * The defect: `status` reported every NEVER_VERIFIED edge as "a baseline gap,
 * not drift. `bootstrap` to triage" — including edges that carry a `deferred`
 * event, which means someone already examined the edge and deliberately
 * parked it with a reason. `bootstrap` classifies on `state === "NEVER_VERIFIED"`
 * alone (lib/edges/bootstrap.mjs's `planBaseline`), so the remediation was not
 * merely unhelpful for a deferred edge, it was pointed at the wrong fix.
 *
 * This cost a real session ~390k subagent tokens re-deriving findings that
 * already existed in the recorded deferred reasons (ISSUES.md N71).
 *
 * Two invariants:
 *
 *   1. A deferred edge must NOT be counted in `never_verified` — it has an
 *      event (the deferred one), so "no event of any kind" is false for it.
 *      It gets its own `deferred` count instead.
 *   2. The human-readable `status` output must not print the `bootstrap`
 *      remediation line when every NEVER_VERIFIED edge in the workspace is
 *      deferred — that line is provably wrong for all of them.
 *
 * Subprocess-based with PROPAGATE_STATE_DIR + PROPAGATE_SEARCH_ROOTS scoped to
 * a fresh tmpdir — nothing here may touch the real ~/.propagate store (G56:
 * never run this file with a bare `node --test`, only via `npm test` or with
 * PROPAGATE_STATE_DIR set explicitly).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI_PATH = fileURLToPath(new URL("../../cli.mjs", import.meta.url));

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function runCli(argv, { searchRoot, stateDir, cwd }) {
  return spawnSync(process.execPath, [CLI_PATH, ...argv], {
    encoding: "utf8",
    cwd,
    env: { ...process.env, PROPAGATE_SEARCH_ROOTS: searchRoot, PROPAGATE_STATE_DIR: stateDir },
  });
}

/** Two edges, A -> B and A -> C, all three files committed, never verified. */
async function makeWorkspace() {
  const searchRoot = await mkdtemp(path.join(tmpdir(), "status-def-root-"));
  const stateDir = await mkdtemp(path.join(tmpdir(), "status-def-state-"));
  const ws = path.join(searchRoot, "ws");
  await mkdir(ws, { recursive: true });
  git(["init", "-q", "-b", "main"], ws);
  git(["config", "user.email", "t@example.com"], ws);
  git(["config", "user.name", "T"], ws);

  await writeFile(path.join(ws, "A.md"), "A v1\n");
  await writeFile(path.join(ws, "B.md"), "B v1\n");
  await writeFile(path.join(ws, "C.md"), "C v1\n");
  await writeFile(
    path.join(ws, ".propagates.yml"),
    [
      "workspace: true",
      "sources:",
      "  A.md:",
      "    propagates_to:",
      "      - path: B.md",
      "        why: A feeds B",
      "        kind: prose",
      "      - path: C.md",
      "        why: A feeds C",
      "        kind: prose",
      "",
    ].join("\n"),
  );
  git(["add", "."], ws);
  git(["commit", "-q", "-m", "init"], ws);

  // The plain (non --json) `status` output bails out early with "(no ledger
  // file yet)" before it ever calls coverageFrom/reconcile, so the prose
  // assertions below need the canonical v1 ledger pair to exist —
  // discovery.mjs only auto-scaffolds it from `setup`/`init`/`bootstrap`
  // (ledgerScaffoldingAllowed), none of which this fixture runs. Content is
  // irrelevant (v1 is frozen history for this test); only presence matters.
  const propagationDir = path.join(ws, "propagation");
  await mkdir(propagationDir, { recursive: true });
  await writeFile(path.join(propagationDir, "ledger.jsonl"), "");
  await writeFile(path.join(propagationDir, "ledger.md"), "# ledger\n");

  return { searchRoot, stateDir, ws, env: { searchRoot, stateDir, cwd: ws } };
}

function coverage(env) {
  const r = runCli(["status", "--json"], env);
  assert.equal(r.status, 0, `status --json exited ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

function cleanup(searchRoot, stateDir) {
  return Promise.all([
    rm(searchRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
    rm(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  ]);
}

test("a deferred edge is not counted as never_verified, and gets its own bucket", async (t) => {
  const { searchRoot, stateDir, env } = await makeWorkspace();
  t.after(() => cleanup(searchRoot, stateDir));

  const rows = JSON.parse(runCli(["reconcile", "--all", "--json"], env).stdout).rows;
  assert.equal(rows.length, 2, "precondition: two declared edges, both NEVER_VERIFIED");

  // Defer exactly one of the two edges, with a reason — the shape of every
  // real N71 row.
  const deferred = rows[0];
  const def = runCli(
    ["verify", "--edge", deferred.edge_id, "--disposition", "deferred",
     "--reason", "examined: B.md intentionally does not need A's change yet", "--apply"],
    env,
  );
  assert.equal(def.status, 0, `deferring should succeed: ${def.stderr}`);

  const cov = coverage(env);
  assert.equal(cov.edges, 2, "both declared edges are counted");
  assert.equal(cov.deferred, 1, "the deferred edge lands in its own bucket");
  assert.equal(
    cov.never_verified, 1,
    "only the genuinely untouched edge is never_verified — the deferred one is not",
  );
  assert.equal(
    cov.verified + cov.actionable + cov.never_verified + cov.cannot_evaluate + cov.deferred,
    cov.edges,
    "every edge still lands in exactly one bucket, deferred included",
  );
  assert.equal(cov.ok, false, "a deferred edge is examined but not resolved — still not ok");
});

test("status does not offer bootstrap for a workspace where every edge is deferred", async (t) => {
  const { searchRoot, stateDir, env } = await makeWorkspace();
  t.after(() => cleanup(searchRoot, stateDir));

  const rows = JSON.parse(runCli(["reconcile", "--all", "--json"], env).stdout).rows;
  for (const row of rows) {
    const r = runCli(
      ["verify", "--edge", row.edge_id, "--disposition", "deferred",
       "--reason", "examined and parked", "--apply"],
      env,
    );
    assert.equal(r.status, 0, `deferring ${row.edge_id} should succeed: ${r.stderr}`);
  }

  const cov = coverage(env);
  assert.equal(cov.never_verified, 0, "nothing is left in the genuine never-verified bucket");
  assert.equal(cov.deferred, 2, "both edges are deferred");

  const plain = runCli(["status"], env);
  assert.equal(plain.status, 0, `plain status exited ${plain.status}: ${plain.stderr}`);
  assert.ok(
    !plain.stdout.includes("bootstrap"),
    `status must not recommend bootstrap for edges that are all deferred:\n${plain.stdout}`,
  );
  assert.ok(
    !plain.stdout.includes("baseline gap"),
    `a deferred edge must not be described as a baseline gap:\n${plain.stdout}`,
  );
  assert.ok(
    plain.stdout.includes("deferred (2)") && plain.stdout.includes("examined, not resolved"),
    `deferred edges must get their own line naming the count:\n${plain.stdout}`,
  );
});

test("a mixed workspace still recommends bootstrap only for the genuinely unverified edge", async (t) => {
  const { searchRoot, stateDir, env } = await makeWorkspace();
  t.after(() => cleanup(searchRoot, stateDir));

  const rows = JSON.parse(runCli(["reconcile", "--all", "--json"], env).stdout).rows;
  const deferred = rows[0];
  const r = runCli(
    ["verify", "--edge", deferred.edge_id, "--disposition", "deferred",
     "--reason", "examined and parked", "--apply"],
    env,
  );
  assert.equal(r.status, 0, `deferring should succeed: ${r.stderr}`);

  const plain = runCli(["status"], env);
  assert.equal(plain.status, 0, `plain status exited ${plain.status}: ${plain.stderr}`);
  assert.ok(
    plain.stdout.includes("bootstrap") && plain.stdout.includes("never verified (1)"),
    `the one genuinely-unverified edge should still get the bootstrap remediation:\n${plain.stdout}`,
  );
  assert.ok(
    plain.stdout.includes("deferred (1)"),
    `the deferred edge should be named separately:\n${plain.stdout}`,
  );
});
