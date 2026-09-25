/**
 * `propagate reminders` — CLI-level coverage.
 *
 * The load-bearing test in this file is "writes nothing": this command has
 * no `--apply` and no write path at all (see lib/reminders/read.mjs's module
 * doc), but per `rule:safety-flag-needs-a-test` the claim is only as good as
 * a test that measures the STORE, not the stdout wording — copying the shape
 * of tests/cli/verify-ordering.test.mjs's `storeSnapshot`, widened here to
 * the WHOLE state directory (every file, not just events/) because this
 * command touches no part of state at all, not just the ledger.
 *
 * Subprocess-based, isolated PROPAGATE_STATE_DIR per test — same discipline
 * as tests/cli/verify-ordering.test.mjs. Reminders access is never invoked
 * for real: every case drives `PROPAGATE_REMINDERS_FIXTURE`
 * (lib/reminders/read.mjs) so this suite runs the same on a machine with no
 * Reminders access and never triggers a TCC prompt.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fullStateSnapshot } from "../helpers/full-state-snapshot.mjs";

const CLI_PATH = fileURLToPath(new URL("../../cli.mjs", import.meta.url));

function runCli(argv, { stateDir, fixturePath }) {
  return spawnSync(process.execPath, [CLI_PATH, ...argv], {
    encoding: "utf8",
    env: {
      ...process.env,
      PROPAGATE_STATE_DIR: stateDir,
      PROPAGATE_SEARCH_ROOTS: stateDir, // no workspaces needed; reminders does not discover any
      ...(fixturePath ? { PROPAGATE_REMINDERS_FIXTURE: fixturePath } : {}),
    },
  });
}

async function setup() {
  const stateDir = await mkdtemp(path.join(tmpdir(), "reminders-state-"));
  // A little pre-existing state, so "writes nothing" is a real claim about an
  // occupied directory, not a vacuous one about an empty tmpdir.
  await writeFile(path.join(stateDir, "metrics.jsonl"), '{"pre":"existing"}\n');
  await mkdir(path.join(stateDir, "claims"), { recursive: true });
  await writeFile(path.join(stateDir, "claims", "2026-09.jsonl"), '{"seed":true}\n');
  return stateDir;
}

const cleanup = async (...dirs) => {
  for (const d of dirs) await rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
};

async function writeFixture(dir, name, content) {
  const p = path.join(dir, name);
  await writeFile(p, JSON.stringify(content));
  return p;
}

const OK_RECORDS = [
  { id: "id-1", name: "Add upcoming purnima and amavasya dates", body: "note\r#vipinkaushik", completed: false, completionDate: null, modificationDate: "2026-09-20T00:00:00.000Z" },
  { id: "id-2", name: "ccusage — spawnSync npx ETIMEDOUT, stale 38h", body: "#ccusage", completed: true, completionDate: "2026-09-18T00:00:00.000Z", modificationDate: "2026-09-18T00:00:00.000Z" },
  { id: "id-3", name: "US$236.00 / View invoice", body: "", completed: false, completionDate: null, modificationDate: null },
  { id: "id-4", name: "unresolvable project", body: "#nosuchproject", completed: false, completionDate: null, modificationDate: null },
];

// ---------------------------------------------------------------------------
// Test 4 — writes nothing, across every reachable outcome
// ---------------------------------------------------------------------------

test("propagate reminders writes nothing: a normal successful read (text mode)", async (t) => {
  const stateDir = await setup();
  t.after(() => cleanup(stateDir));
  const fixturePath = await writeFixture(stateDir, "fixture-ok.json", { status: 0, stdout: JSON.stringify(OK_RECORDS), stderr: "" });

  const before = fullStateSnapshot(stateDir);
  const r = runCli(["reminders"], { stateDir, fixturePath });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fullStateSnapshot(stateDir), before, "a successful read must not touch the state directory");
});

test("propagate reminders writes nothing: --json mode", async (t) => {
  const stateDir = await setup();
  t.after(() => cleanup(stateDir));
  const fixturePath = await writeFixture(stateDir, "fixture-ok.json", { status: 0, stdout: JSON.stringify(OK_RECORDS), stderr: "" });

  const before = fullStateSnapshot(stateDir);
  const r = runCli(["reminders", "--json"], { stateDir, fixturePath });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fullStateSnapshot(stateDir), before);
});

test("propagate reminders writes nothing: a genuinely empty list", async (t) => {
  const stateDir = await setup();
  t.after(() => cleanup(stateDir));
  const fixturePath = await writeFixture(stateDir, "fixture-empty.json", { status: 0, stdout: "[]", stderr: "" });

  const before = fullStateSnapshot(stateDir);
  const r = runCli(["reminders"], { stateDir, fixturePath });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fullStateSnapshot(stateDir), before);
});

test("propagate reminders writes nothing: an inconclusive (TCC-denied) read", async (t) => {
  const stateDir = await setup();
  t.after(() => cleanup(stateDir));
  const fixturePath = await writeFixture(stateDir, "fixture-denied.json", {
    status: 1, stdout: "", stderr: "Not authorized to send Apple events to Reminders. (-1743)",
  });

  const before = fullStateSnapshot(stateDir);
  // FAILING INPUT: reintroduce a write call anywhere on the inconclusive
  // path (e.g. logging the denial to a state file) — this snapshot would
  // change and the test goes red for exactly that reason.
  const r = runCli(["reminders"], { stateDir, fixturePath });
  assert.equal(r.status, 2, "inconclusive must exit non-zero and distinctly from ok/empty");
  assert.equal(fullStateSnapshot(stateDir), before, "even a refused/inconclusive read must not touch the state directory");
});

test("propagate reminders writes nothing: --json inconclusive", async (t) => {
  const stateDir = await setup();
  t.after(() => cleanup(stateDir));
  const fixturePath = await writeFixture(stateDir, "fixture-denied.json", {
    status: 1, stdout: "", stderr: "Not authorized to send Apple events to Reminders. (-1743)",
  });

  const before = fullStateSnapshot(stateDir);
  const r = runCli(["reminders", "--json"], { stateDir, fixturePath });
  assert.equal(r.status, 2);
  assert.equal(fullStateSnapshot(stateDir), before);
});

// ---------------------------------------------------------------------------
// F1 at the CLI boundary — distinct exit codes, reason is machine-readable
// ---------------------------------------------------------------------------

test("CLI: inconclusive (TCC denial) exits 2 and --json carries a machine-readable reason, never an empty items array", async (t) => {
  const stateDir = await setup();
  t.after(() => cleanup(stateDir));
  const fixturePath = await writeFixture(stateDir, "fixture-denied.json", {
    status: 1, stdout: "", stderr: "Not authorized to send Apple events to Reminders. (-1743)",
  });

  const r = runCli(["reminders", "--json"], { stateDir, fixturePath });
  assert.equal(r.status, 2);
  const payload = JSON.parse(r.stdout.trim());
  assert.equal(payload.ok, false);
  assert.equal(payload.reason, "tcc-denied");
  assert.equal("items" in payload, false, "must not carry an items array that a naive consumer could read as zero reminders");
});

test("CLI: a genuinely empty list exits 0 and --json carries items: [] explicitly", async (t) => {
  const stateDir = await setup();
  t.after(() => cleanup(stateDir));
  const fixturePath = await writeFixture(stateDir, "fixture-empty.json", { status: 0, stdout: "[]", stderr: "" });

  const r = runCli(["reminders", "--json"], { stateDir, fixturePath });
  assert.equal(r.status, 0);
  const payload = JSON.parse(r.stdout.trim());
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.items, []);
  assert.equal(payload.summary.total, 0);
});

test("CLI text mode: inconclusive output never reads as zero reminders", async (t) => {
  const stateDir = await setup();
  t.after(() => cleanup(stateDir));
  const fixturePath = await writeFixture(stateDir, "fixture-denied.json", {
    status: 1, stdout: "", stderr: "Not authorized to send Apple events to Reminders. (-1743)",
  });

  const r = runCli(["reminders"], { stateDir, fixturePath });
  assert.equal(r.status, 2);
  assert.match(r.stdout, /could not read/);
  assert.doesNotMatch(r.stdout, /\(0 items?\)/, "must not print the zero-items summary line used for a real empty list");
});

// ---------------------------------------------------------------------------
// F4 at the CLI boundary — unknown tag reported, not dropped
// ---------------------------------------------------------------------------

test("CLI --json: an unresolvable tag is present in items, never silently dropped", async (t) => {
  const stateDir = await setup();
  t.after(() => cleanup(stateDir));
  const fixturePath = await writeFixture(stateDir, "fixture-ok.json", { status: 0, stdout: JSON.stringify(OK_RECORDS), stderr: "" });

  const r = runCli(["reminders", "--json"], { stateDir, fixturePath });
  assert.equal(r.status, 0, r.stderr);
  const payload = JSON.parse(r.stdout.trim());
  const unresolved = payload.items.find((i) => i.id === "id-4");
  assert.ok(unresolved, "the unresolvable-tag reminder must still be in the payload");
  assert.equal(unresolved.route.kind, "held-unknown-tag");
  assert.equal(payload.summary.heldUnknownTag, 1);
});

test("CLI text mode: routes known tags under their project, and reports held items separately", async (t) => {
  const stateDir = await setup();
  t.after(() => cleanup(stateDir));
  const fixturePath = await writeFixture(stateDir, "fixture-ok.json", { status: 0, stdout: JSON.stringify(OK_RECORDS), stderr: "" });

  const r = runCli(["reminders"], { stateDir, fixturePath });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Vipin Kaushik/);
  assert.match(r.stdout, /Rupali\/claude-usage-widget/);
  assert.match(r.stdout, /HELD — unresolvable tag/);
  assert.match(r.stdout, /HELD — untagged/);
});
