/**
 * `status` — coverage is always stated, and the tick has to be earned.
 *
 * The defect this file exists for: `status` used to print
 * `✓ no open drift events` whenever the v1 ledger had no unclosed rows. That
 * sentence is true and useless — a workspace where NOTHING has ever been
 * verified prints it just as happily as one that is fully checked. Green was
 * reachable through absence of data, which is `rule:discernment-checks` §2
 * ("absence must be attributable") failing at the top-level command.
 *
 * Two invariants, and the first is the one that matters:
 *
 *   1. The coverage counts are printed on EVERY run — total edges, verified,
 *      never verified, needing attention. A reader can never see a verdict
 *      without simultaneously seeing how much of the tree it is based on.
 *   2. The tick is printed only when there is genuinely nothing outstanding:
 *      no actionable edges, nothing unevaluable, and nothing unverified.
 *
 * On (2): full coverage is achievable, not aspirational — PanditPawanKaushik
 * drove CLEAN 380 -> 516 with 1 DRIFTED in a single pass (their DECISIONS.md
 * 2026-08-15). And a missing tick is not an alarm: `status` has no red state
 * and exits 0 regardless. The tick is a badge to earn, not a gate to pass.
 *
 * Asserted against the COUNTS, not against prose, so rewording the output
 * cannot silently retire the check.
 *
 * Subprocess-based with PROPAGATE_STATE_DIR + PROPAGATE_SEARCH_ROOTS scoped to
 * a fresh tmpdir — nothing here may touch the real ~/.propagate store.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI_PATH = fileURLToPath(new URL("../cli.mjs", import.meta.url));

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

/** Two edges, A -> B -> C, all three files committed. */
async function makeWorkspace() {
  const searchRoot = await mkdtemp(path.join(tmpdir(), "status-cov-root-"));
  const stateDir = await mkdtemp(path.join(tmpdir(), "status-cov-state-"));
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
      "  B.md:",
      "    propagates_to:",
      "      - path: C.md",
      "        why: B feeds C",
      "        kind: prose",
      "",
    ].join("\n"),
  );
  git(["add", "."], ws);
  git(["commit", "-q", "-m", "init"], ws);

  return { searchRoot, stateDir, ws, env: { searchRoot, stateDir, cwd: ws } };
}

/** Pull the machine-readable coverage block rather than scraping prose. */
function coverage(env) {
  const r = runCli(["status", "--json"], env);
  assert.equal(r.status, 0, `status --json exited ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

function baselineEveryEdge(env) {
  const rows = JSON.parse(runCli(["reconcile", "--all", "--json"], env).stdout).rows;
  for (const row of rows) {
    runCli(
      ["verify", "--edge", row.edge_id, "--disposition", "baselined",
       "--reason", "test baseline", "--apply", "--json"],
      env,
    );
  }
  return rows.length;
}

test("coverage counts are reported even when nothing has ever been verified", async (t) => {
  const { searchRoot, stateDir, env } = await makeWorkspace();
  t.after(() => Promise.all([rm(searchRoot, { recursive: true, force: true }),
                             rm(stateDir, { recursive: true, force: true })]));

  const cov = coverage(env);
  assert.equal(cov.edges, 2, "both declared edges are counted");
  assert.equal(cov.verified, 0, "nothing verified yet");
  assert.equal(cov.never_verified, 2, "a fresh tree is entirely unverified, and says so");
  assert.equal(cov.actionable, 0, "unverified is not drift");
});

test("the tick is NOT earned by a tree nobody has verified", async (t) => {
  const { searchRoot, stateDir, env } = await makeWorkspace();
  t.after(() => Promise.all([rm(searchRoot, { recursive: true, force: true }),
                             rm(stateDir, { recursive: true, force: true })]));

  const cov = coverage(env);
  assert.equal(cov.actionable, 0, "precondition: nothing actionable");
  assert.ok(cov.never_verified > 0, "precondition: something is unverified");
  assert.equal(
    cov.ok, false,
    "0 actionable + 0 verified must NOT read as ok — this is the original defect",
  );
});

test("the tick IS earned once every edge is verified and clean", async (t) => {
  const { searchRoot, stateDir, env } = await makeWorkspace();
  t.after(() => Promise.all([rm(searchRoot, { recursive: true, force: true }),
                             rm(stateDir, { recursive: true, force: true })]));

  const n = baselineEveryEdge(env);
  assert.equal(n, 2, "precondition: both edges were baselined");

  const cov = coverage(env);
  assert.equal(cov.never_verified, 0, "nothing left unverified");
  assert.equal(cov.actionable, 0, "nothing drifted");
  assert.equal(cov.cannot_evaluate, 0, "nothing unevaluable");
  assert.equal(cov.ok, true, "fully covered and clean is the one state that earns it");
});

test("a drifted edge is actionable and withdraws the tick", async (t) => {
  const { searchRoot, stateDir, ws, env } = await makeWorkspace();
  t.after(() => Promise.all([rm(searchRoot, { recursive: true, force: true }),
                             rm(stateDir, { recursive: true, force: true })]));

  baselineEveryEdge(env);
  assert.equal(coverage(env).ok, true, "precondition: clean before the edit");

  // Move only A. A->B drifts; B->C stays clean.
  await writeFile(path.join(ws, "A.md"), "A v2 — source moved\n");
  git(["add", "."], ws);
  git(["commit", "-q", "-m", "edit A"], ws);

  const cov = coverage(env);
  assert.equal(cov.actionable, 1, "exactly one edge drifted");
  assert.equal(cov.verified, 1, "the untouched edge stays verified");
  assert.equal(cov.ok, false, "an actionable edge withdraws the tick");
});

test("an unevaluable edge is never counted as clean", async (t) => {
  const { searchRoot, stateDir, ws, env } = await makeWorkspace();
  t.after(() => Promise.all([rm(searchRoot, { recursive: true, force: true }),
                             rm(stateDir, { recursive: true, force: true })]));

  baselineEveryEdge(env);

  // Delete a downstream. The edge can no longer be evaluated; that is a
  // question we failed to answer, not a pass. Deliberate removal has its own
  // disposition (`decoupled`) — silence here would hide the difference.
  await rm(path.join(ws, "C.md"));
  git(["add", "-A"], ws);
  git(["commit", "-q", "-m", "delete C"], ws);

  const cov = coverage(env);
  assert.ok(cov.cannot_evaluate >= 1, "the missing downstream is surfaced, not swallowed");
  assert.equal(cov.verified + cov.actionable + cov.never_verified + cov.cannot_evaluate,
               cov.edges, "every edge lands in exactly one bucket");
  assert.equal(cov.ok, false, "unevaluable withdraws the tick");
});
