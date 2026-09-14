/**
 * `propagate claims judge` / `propagate claims answer` at the CLI boundary —
 * Phase 1 "honest degradation": judged / unjudged / unanswerable rendered
 * distinctly, and the answering-run log recorded only by explicit CLI calls
 * the caller makes (never by propagate probing anything — Premise 1).
 *
 * THE LOAD-BEARING ASSERTION in this file is the first test: a fresh file
 * with a judgeable block and ZERO answering runs ever recorded must render
 * the exact substring "unjudged, 0 runs", and must NEVER render "0 findings"
 * — those are different facts (no verdicts exist vs. nothing was looked at),
 * and conflating them is the exact failure Phase 1 exists to stop.
 *
 * Isolated via `PROPAGATE_STATE_DIR` per test, same discipline as
 * `verify-ordering.test.mjs` — nothing here may touch the real `~/.propagate`
 * store (G54).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, readdir, readFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI_PATH = fileURLToPath(new URL("../../cli.mjs", import.meta.url));

function runCli(argv, stateDir) {
  return spawnSync(process.execPath, [CLI_PATH, ...argv], {
    encoding: "utf8",
    env: { ...process.env, PROPAGATE_STATE_DIR: stateDir },
  });
}

/** Every byte of every `.jsonl` shard directly inside `dir`, sorted and joined. */
async function storeSnapshot(dir) {
  if (!existsSync(dir)) return "";
  const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl")).sort();
  const parts = [];
  for (const f of files) parts.push(await readFile(path.join(dir, f), "utf8"));
  return parts.join("");
}

async function freshState() {
  return mkdtemp(path.join(tmpdir(), "claims-judge-runs-state-"));
}

async function docWithOneClaim(dir, name = "DOC.md") {
  const file = path.join(dir, name);
  await writeFile(file, "This is one judgeable prose claim about the system.\n");
  return file;
}

// ── THE required failing input ─────────────────────────────────────────────

test("no brain, no answering run recorded: says 'unjudged, 0 runs', never '0 findings'", async () => {
  const stateDir = await freshState();
  const srcDir = await mkdtemp(path.join(tmpdir(), "claims-judge-runs-src-"));
  const file = await docWithOneClaim(srcDir);

  const r = runCli(["claims", "judge", file], stateDir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /unjudged, 0 runs/, "the exact failing-input string must appear");
  assert.doesNotMatch(r.stdout, /0 findings/, '"0 findings" would misreport "never looked" as "looked, found nothing"');
});

test("the same case in --json: counts.unanswerable is 0 and runs.status is \"never\"", async () => {
  const stateDir = await freshState();
  const srcDir = await mkdtemp(path.join(tmpdir(), "claims-judge-runs-src-"));
  const file = await docWithOneClaim(srcDir);

  const r = runCli(["claims", "judge", file, "--json"], stateDir);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.counts.unjudged, 1);
  assert.equal(out.counts.unanswerable, 0);
  assert.equal(out.runs.status, "never");
  assert.equal(out.runs.count, 0);
});

// ── the write path: `claims answer` ────────────────────────────────────────

test("claims answer start/end round-trips, and judge then reports unanswerable", async () => {
  const stateDir = await freshState();
  const srcDir = await mkdtemp(path.join(tmpdir(), "claims-judge-runs-src-"));
  const file = await docWithOneClaim(srcDir);

  const start = runCli(["claims", "answer", file, "start", "--json"], stateDir);
  assert.equal(start.status, 0, start.stderr);
  const { run_id } = JSON.parse(start.stdout);
  assert.match(run_id, /^[0-9A-HJKMNP-TV-Z]{26}$/);

  const end = runCli(
    ["claims", "answer", file, "end", "--run", run_id, "--outcome", "no-brain", "--reason", "no brain on this device", "--json"],
    stateDir,
  );
  assert.equal(end.status, 0, end.stderr);
  assert.equal(JSON.parse(end.stdout).outcome, "no-brain");

  const judge = runCli(["claims", "judge", file, "--json"], stateDir);
  const out = JSON.parse(judge.stdout);
  assert.equal(out.counts.unjudged, 0);
  assert.equal(out.counts.unanswerable, 1);
  assert.equal(out.runs.status, "completed");
  assert.equal(out.runs.outcome, "no-brain");
});

test("claims answer end without a prior start's run_id still requires --outcome, and rejects an unknown one", async () => {
  const stateDir = await freshState();
  const srcDir = await mkdtemp(path.join(tmpdir(), "claims-judge-runs-src-"));
  const file = await docWithOneClaim(srcDir);

  const missingArgs = runCli(["claims", "answer", file, "end", "--run", "R1"], stateDir);
  assert.equal(missingArgs.status, 2);

  const badOutcome = runCli(["claims", "answer", file, "end", "--run", "R1", "--outcome", "maybe"], stateDir);
  assert.equal(badOutcome.status, 2);
});

test("an outcome of no-brain/error without --reason is rejected, not silently accepted", async () => {
  const stateDir = await freshState();
  const srcDir = await mkdtemp(path.join(tmpdir(), "claims-judge-runs-src-"));
  const file = await docWithOneClaim(srcDir);

  const start = runCli(["claims", "answer", file, "start", "--json"], stateDir);
  const { run_id } = JSON.parse(start.stdout);

  const end = runCli(["claims", "answer", file, "end", "--run", run_id, "--outcome", "no-brain"], stateDir);
  assert.equal(end.status, 2, "no-brain with no reason must be refused");
});

// ── store gate: a read-only `claims judge` must never write ───────────────

test("`claims judge` never writes to either the claims store or the run-log store", async () => {
  const stateDir = await freshState();
  const srcDir = await mkdtemp(path.join(tmpdir(), "claims-judge-runs-src-"));
  const file = await docWithOneClaim(srcDir);

  // Prime both stores with one real write each, so "before" is non-trivially
  // non-empty and a `judge` that clobbers or appends is actually visible.
  const start = runCli(["claims", "answer", file, "start", "--json"], stateDir);
  const { run_id } = JSON.parse(start.stdout);
  runCli(["claims", "answer", file, "end", "--run", run_id, "--outcome", "ok"], stateDir);

  const claimsDir = path.join(stateDir, "claims");
  const runsDir = path.join(stateDir, "claims", "runs");
  const before = { claims: await storeSnapshot(claimsDir), runs: await storeSnapshot(runsDir) };

  runCli(["claims", "judge", file], stateDir);
  runCli(["claims", "judge", file, "--json"], stateDir);

  const after = { claims: await storeSnapshot(claimsDir), runs: await storeSnapshot(runsDir) };

  assert.equal(after.claims, before.claims, "claims store must be byte-identical after a read-only judge");
  assert.equal(after.runs, before.runs, "run-log store must be byte-identical after a read-only judge");
});

// ── `claims answer` usage errors ────────────────────────────────────────────

test("claims answer with no file and no mode is a usage error, not a silent no-op", async () => {
  const stateDir = await freshState();
  const r = runCli(["claims", "answer"], stateDir);
  assert.equal(r.status, 2);
});

test("claims answer <file> with neither start nor end is a usage error", async () => {
  const stateDir = await freshState();
  const srcDir = await mkdtemp(path.join(tmpdir(), "claims-judge-runs-src-"));
  const file = await docWithOneClaim(srcDir);

  const r = runCli(["claims", "answer", file], stateDir);
  assert.equal(r.status, 2);
});

// ── plain-text (non --json) rendering ───────────────────────────────────────

test("claims answer start/end plain-text output names the run id and the follow-up command", async () => {
  const stateDir = await freshState();
  const srcDir = await mkdtemp(path.join(tmpdir(), "claims-judge-runs-src-"));
  const file = await docWithOneClaim(srcDir);

  const start = runCli(["claims", "answer", file, "start"], stateDir);
  assert.equal(start.status, 0, start.stderr);
  assert.match(start.stdout, /started/);
  const runIdMatch = start.stdout.match(/run ([0-9A-HJKMNP-TV-Z]{26})/);
  assert.ok(runIdMatch, `plain output must still name the run id:\n${start.stdout}`);

  const end = runCli(
    ["claims", "answer", file, "end", "--run", runIdMatch[1], "--outcome", "ok"],
    stateDir,
  );
  assert.equal(end.status, 0, end.stderr);
  assert.match(end.stdout, /recorded/);
  assert.match(end.stdout, /"ok"/);
});

test('plain-text judge output warns on a crashed run and lists the unanswerable block(s)', async () => {
  const stateDir = await freshState();
  const srcDir = await mkdtemp(path.join(tmpdir(), "claims-judge-runs-src-"));
  const file = await docWithOneClaim(srcDir);

  const start = runCli(["claims", "answer", file, "start", "--json"], stateDir);
  assert.equal(start.status, 0, start.stderr);
  // deliberately never ended -> crashed

  const judge = runCli(["claims", "judge", file], stateDir);
  assert.equal(judge.status, 0, judge.stderr);
  assert.match(judge.stdout, /latest answering run for this file has no end record/);
  assert.match(judge.stdout, /unanswerable \(1\)/);
  assert.match(judge.stdout, /nothing else awaiting judgment/);
});

test('plain-text judge output warns when the latest completed run ended "error"', async () => {
  const stateDir = await freshState();
  const srcDir = await mkdtemp(path.join(tmpdir(), "claims-judge-runs-src-"));
  const file = await docWithOneClaim(srcDir);

  const start = runCli(["claims", "answer", file, "start", "--json"], stateDir);
  const { run_id } = JSON.parse(start.stdout);
  const end = runCli(
    ["claims", "answer", file, "end", "--run", run_id, "--outcome", "error", "--reason", "boom"],
    stateDir,
  );
  assert.equal(end.status, 0, end.stderr);

  const judge = runCli(["claims", "judge", file], stateDir);
  assert.equal(judge.status, 0, judge.stderr);
  assert.match(judge.stdout, /latest answering run ended "error"/);
});

// ── readRuns real filtering and resilience ──────────────────────────────────

test("readRuns filters by file: a crashed run on one file does not bleed into another's judge output", async () => {
  const stateDir = await freshState();
  const srcDir = await mkdtemp(path.join(tmpdir(), "claims-judge-runs-src-"));
  const fileA = await docWithOneClaim(srcDir, "A.md");
  const fileB = await docWithOneClaim(srcDir, "B.md");

  const startB = runCli(["claims", "answer", fileB, "start", "--json"], stateDir);
  assert.equal(startB.status, 0, startB.stderr); // B crashes; A never gets a run at all

  const judgeA = JSON.parse(runCli(["claims", "judge", fileA, "--json"], stateDir).stdout);
  assert.equal(judgeA.runs.status, "never", "A must not inherit B's crashed run");
  assert.equal(judgeA.counts.unanswerable, 0);

  const judgeB = JSON.parse(runCli(["claims", "judge", fileB, "--json"], stateDir).stdout);
  assert.equal(judgeB.runs.status, "crashed");
  assert.equal(judgeB.counts.unanswerable, 1);
});

test("a corrupt line in the run-log shard is read past — the valid start/end pair still resolves", async () => {
  const stateDir = await freshState();
  const srcDir = await mkdtemp(path.join(tmpdir(), "claims-judge-runs-src-"));
  const file = await docWithOneClaim(srcDir);

  const start = runCli(["claims", "answer", file, "start", "--json"], stateDir);
  const { run_id } = JSON.parse(start.stdout);
  const end = runCli(["claims", "answer", file, "end", "--run", run_id, "--outcome", "ok"], stateDir);
  assert.equal(end.status, 0, end.stderr);

  const runsDir = path.join(stateDir, "claims", "runs");
  const shards = (await readdir(runsDir)).filter((f) => f.endsWith(".jsonl"));
  assert.ok(shards.length > 0, "precondition: at least one run-log shard exists");
  await appendFile(path.join(runsDir, shards[0]), "{not valid json\n");

  const judge = runCli(["claims", "judge", file, "--json"], stateDir);
  assert.equal(judge.status, 0, judge.stderr);
  const out = JSON.parse(judge.stdout);
  assert.equal(out.runs.status, "completed", "the corrupt line must not derail the valid pair's fold");
  assert.equal(out.runs.outcome, "ok");
});
