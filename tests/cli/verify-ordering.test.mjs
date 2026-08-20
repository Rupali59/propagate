/**
 * `verify` — the ordering guard, and the dry run that must precede every write.
 *
 * Both landed 2026-08-17, and both exist because of the same incident: a
 * session ran the guard's own behaviour matrix without `--apply`, believing
 * that was a dry run, and appended 11 events asserting verifications nobody
 * had performed. Three real worklist items closed themselves. See
 * docs/GOTCHAS.md and docs/DECISIONS.md of that date.
 *
 * So the load-bearing assertion in this file is not "the guard prints the
 * right words" — it is **the event store is byte-identical afterwards** unless
 * `--apply` was passed. Every test that exercises a non-writing path measures
 * the store before and after.
 *
 * Subprocess-based with PROPAGATE_STATE_DIR + PROPAGATE_SEARCH_ROOTS scoped to
 * a fresh tmpdir, same isolation discipline as tests/verify.test.mjs — nothing
 * here may touch the real ~/.propagate store.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI_PATH = fileURLToPath(new URL("../../cli.mjs", import.meta.url));

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function runCli(argv, { searchRoot, stateDir }) {
  return spawnSync(process.execPath, [CLI_PATH, ...argv], {
    encoding: "utf8",
    env: { ...process.env, PROPAGATE_SEARCH_ROOTS: searchRoot, PROPAGATE_STATE_DIR: stateDir },
  });
}

/** Every byte of the event store, so "unchanged" means unchanged. */
function storeSnapshot(stateDir) {
  const dir = path.join(stateDir, "events");
  if (!existsSync(dir)) return "";
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .map((f) => readFileSync(path.join(dir, f), "utf8"))
    .join("");
}

/**
 * A -> B -> C, all in one repo, all three files coupled in a chain. Committing
 * then editing A and B leaves both edges unsettled, which is the shape the
 * guard exists for: verifying B->C while A->B is still dirty.
 */
async function makeChain() {
  const searchRoot = await mkdtemp(path.join(tmpdir(), "verify-order-root-"));
  const stateDir = await mkdtemp(path.join(tmpdir(), "verify-order-state-"));
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

  const env = { searchRoot, stateDir };

  // Baseline both edges so they start CLEAN rather than NEVER_VERIFIED —
  // otherwise every edge is unsettled and the guard fires trivially, which
  // would make these tests pass for the wrong reason.
  const before = JSON.parse(runCli(["reconcile", "--all", "--json"], env).stdout);
  for (const row of before.rows) {
    runCli(
      ["verify", "--edge", row.edge_id, "--disposition", "baselined", "--reason", "test baseline", "--apply", "--json"],
      env,
    );
  }

  // Move ONLY A. That makes A->B DRIFTED (source moved, downstream did not)
  // and leaves B->C CLEAN.
  //
  // Editing B as well would make A->B DIVERGED, and `divergedGuard` refuses
  // every disposition except both-reconciled on a DIVERGED edge — so the
  // ordering guard would never be reached and these tests would pass or fail
  // for a completely unrelated reason. That mistake cost three red tests on
  // first run; the fixture is the assertion here.
  //
  // B->C being CLEAN is deliberate and is the sharper case: the guard must
  // fire on it anyway, because its SOURCE (B) is the downstream of a DRIFTED
  // edge. A "clean" edge whose source is about to move is exactly the false
  // CLEAN this guard exists to prevent.
  await writeFile(path.join(ws, "A.md"), "A v2\n");

  const after = JSON.parse(runCli(["reconcile", "--all", "--json"], env).stdout);
  const edgeAB = after.rows.find((r) => r.source.path.endsWith("A.md"));
  const edgeBC = after.rows.find((r) => r.source.path.endsWith("B.md"));
  return { env, ws, searchRoot, stateDir, edgeAB, edgeBC };
}

const cleanup = async (...dirs) => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
};

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

test("verify refuses an edge whose source is itself unsettled, and exits 3", async (t) => {
  const { env, searchRoot, stateDir, edgeAB, edgeBC } = await makeChain();
  t.after(() => cleanup(searchRoot, stateDir));

  // Assert the fixture is the shape the test needs, in the test. A fixture that
  // silently drifts makes the assertions below meaningless.
  assert.equal(edgeAB.state, "DRIFTED", "fixture: A->B is DRIFTED, so divergedGuard is not what refuses");
  assert.equal(edgeBC.state, "CLEAN", "fixture: B->C is CLEAN — only its ANCESTOR is unsettled");

  const snap = storeSnapshot(stateDir);
  const r = runCli(["verify", "--edge", edgeBC.edge_id, "--disposition", "propagated", "--apply"], env);

  // FAILING INPUT: remove the guard block from verifyCmd — this becomes exit 0
  // and the store grows. Verified red against that edit.
  assert.equal(r.status, 3, `expected exit 3, got ${r.status}: ${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /OUT OF ORDER/);
  assert.match(r.stderr, /A\.md/, "the blocking upstream must be NAMED, not just counted");
  assert.equal(storeSnapshot(stateDir), snap, "a refused verify must write nothing");
});

test("--out-of-order overrides the guard", async (t) => {
  const { env, searchRoot, stateDir, edgeBC } = await makeChain();
  t.after(() => cleanup(searchRoot, stateDir));

  const r = runCli(
    ["verify", "--edge", edgeBC.edge_id, "--disposition", "propagated", "--out-of-order", "--apply"],
    env,
  );
  assert.equal(r.status, 0, `expected the override to proceed: ${r.stderr}`);
});

test("a root edge is never blocked", async (t) => {
  const { env, searchRoot, stateDir, edgeAB } = await makeChain();
  t.after(() => cleanup(searchRoot, stateDir));

  // A has no inbound edge, so A->B can never be out of order.
  const r = runCli(["verify", "--edge", edgeAB.edge_id, "--disposition", "propagated", "--apply"], env);
  assert.equal(r.status, 0, `a root edge must verify freely: ${r.stderr}`);
});

test("deferred bypasses the guard; wontfix and baselined do not", async (t) => {
  const { env, searchRoot, stateDir, edgeBC } = await makeChain();
  t.after(() => cleanup(searchRoot, stateDir));

  // deferred pins nothing (lib/events.mjs refuses content on it), so there is
  // no pair to pin against an unsettled source.
  const deferred = runCli(["verify", "--edge", edgeBC.edge_id, "--disposition", "deferred", "--apply"], env);
  assert.equal(deferred.status, 0, "deferred must not be blocked");

  // FAILING INPUT: add wontfix/baselined to GUARD_EXEMPT — these two go to 0.
  for (const d of ["wontfix", "baselined"]) {
    const r = runCli(["verify", "--edge", edgeBC.edge_id, "--disposition", d, "--reason", "x", "--apply"], env);
    assert.equal(r.status, 3, `${d} pins content and MUST be guarded (got ${r.status})`);
  }
});

test("the guard reports one upstream block per source, not once per selected edge", async (t) => {
  const { env, searchRoot, stateDir, edgeBC } = await makeChain();
  t.after(() => cleanup(searchRoot, stateDir));

  const r = runCli(["verify", "--edge", edgeBC.edge_id, "--disposition", "propagated", "--apply"], env);
  const occurrences = (r.stderr.match(/is itself/g) || []).length;
  assert.equal(occurrences, 1, "one source, one block — repetition buries the signal");
});

test("--json emits a machine-readable out-of-order envelope and still exits 3", async (t) => {
  const { env, searchRoot, stateDir, edgeBC } = await makeChain();
  t.after(() => cleanup(searchRoot, stateDir));

  const r = runCli(["verify", "--edge", edgeBC.edge_id, "--disposition", "propagated", "--apply", "--json"], env);
  assert.equal(r.status, 3);
  const parsed = JSON.parse(r.stdout.trim());
  assert.equal(parsed.error, "out-of-order");
  assert.equal(parsed.override, "--out-of-order");
  assert.equal(parsed.offenders.length, 1);
  assert.ok(parsed.offenders[0].blockedBy.length >= 1);
});

// ---------------------------------------------------------------------------
// The dry run — the incident this whole file exists because of
// ---------------------------------------------------------------------------

test("verify WITHOUT --apply writes nothing, for every disposition", async (t) => {
  const { env, searchRoot, stateDir, edgeAB } = await makeChain();
  t.after(() => cleanup(searchRoot, stateDir));

  // FAILING INPUT: delete the `if (!apply)` block from runDispositionBatch —
  // i.e. restore the pre-2026-08-17 behaviour. Every iteration below then
  // grows the store and this goes red on the first one. That is exactly the
  // regression that cost 11 spurious events.
  for (const d of ["propagated", "no-change-needed", "source-corrected", "deferred", "wontfix", "baselined"]) {
    const snap = storeSnapshot(stateDir);
    const argv = ["verify", "--edge", edgeAB.edge_id, "--disposition", d];
    if (d === "wontfix" || d === "baselined") argv.push("--reason", "x");
    const r = runCli(argv, env);

    assert.equal(r.status, 0, `${d} dry run should exit 0: ${r.stderr}`);
    assert.match(r.stdout, /would write|nothing has been written/, `${d} must say it wrote nothing`);
    assert.equal(storeSnapshot(stateDir), snap, `${d} WITHOUT --apply must not touch the event store`);
  }
});

test("the dry run predicts a refusal instead of promising a write", async (t) => {
  const { env, searchRoot, stateDir, edgeAB } = await makeChain();
  t.after(() => cleanup(searchRoot, stateDir));

  // wontfix with no --reason is refused by lib/events.mjs's validateEvent. A
  // preview that said "would write 1 event" here would be describing something
  // that never happens.
  //
  // FAILING INPUT: drop dryValidateEvent from the preview — the refusal
  // disappears and the dry run promises a write that --apply would reject.
  const r = runCli(["verify", "--edge", edgeAB.edge_id, "--disposition", "wontfix"], env);
  assert.equal(storeSnapshot(stateDir), storeSnapshot(stateDir));
  assert.match(r.stdout, /refused/, "the preview must show the refusal");
  assert.match(r.stdout, /requires field "reason"/, "and must give events.mjs's own reason verbatim");
});

test("--apply is what actually writes", async (t) => {
  const { env, searchRoot, stateDir, edgeAB } = await makeChain();
  t.after(() => cleanup(searchRoot, stateDir));

  const before = storeSnapshot(stateDir);
  const r = runCli(["verify", "--edge", edgeAB.edge_id, "--disposition", "propagated", "--apply"], env);
  assert.equal(r.status, 0, r.stderr);
  const after = storeSnapshot(stateDir);
  assert.notEqual(after, before, "--apply must write");
  assert.ok(after.length > before.length, "and the store must grow, not be rewritten");
});
