/**
 * `propagate reminders sync` — CLI-level coverage for PR-022's verb
 * (T5, `docs/plans/2026-09-23-reminders-todo-bridge.md` "Part 1 — the
 * inserter"). Subprocess-based, isolated `PROPAGATE_STATE_DIR` per test —
 * same discipline as `tests/cli/reminders.test.mjs` and
 * `tests/cli/verify-ordering.test.mjs`.
 *
 * DRY-RUN IS THE DEFAULT, `--apply` IS REQUIRED TO WRITE, per
 * `rule:safety-flag-needs-a-test`: every dry-run case here snapshots the
 * WHOLE state directory, never trusting the word "dry" in a message.
 *
 * These tests use the REAL tag table (`lib/reminders/tags.mjs`) rather than
 * an injected one, because the CLI entry point exposes no override for it —
 * that is deliberate coverage of the wiring, not a gap: both real tags
 * (`#ccusage`, `#vipinkaushik`) resolve to REFUSALS on this tree
 * (held-no-register / held-ambiguous-register, both measured directly
 * against the filesystem while building this lane), so dry-run's mocked
 * write/rename never even attempt a real filesystem write, and no test here
 * ever needs `--apply` against a real register path. The full
 * insert/idempotency/write-order/refusal-disposition matrix, fully
 * hermetic against injected fake paths, lives in
 * tests/unit/reminders-sync.test.mjs.
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
      PROPAGATE_SEARCH_ROOTS: stateDir,
      ...(fixturePath ? { PROPAGATE_REMINDERS_FIXTURE: fixturePath } : {}),
    },
  });
}

async function setup() {
  const stateDir = await mkdtemp(path.join(tmpdir(), "reminders-sync-state-"));
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

// The two REAL live tags, one that measured held-no-register on this tree
// (no TODOS.md anywhere under Rupali/claude-usage-widget or its canonical
// state dir) and one that measured held-ambiguous-register (no canonical
// propagation/state/workspace/TODOS.md, only a differently-shaped
// Vipin Kaushik/TODOS.md at the repo root) -- see
// propagation/state/workspace/STATE.md's 2026-09-25 entries for the
// measurement.
const RECORDS = [
  { id: "id-1", name: "a ccusage item", body: "#ccusage", completed: false, completionDate: null, modificationDate: null },
  { id: "id-2", name: "a vipinkaushik item", body: "#vipinkaushik", completed: false, completionDate: null, modificationDate: null },
  { id: "id-3", name: "no tag at all", body: "", completed: false, completionDate: null, modificationDate: null },
  { id: "id-4", name: "unresolvable tag", body: "#nosuchtag", completed: false, completionDate: null, modificationDate: null },
];

// ---------------------------------------------------------------------------
// Dry-run writes nothing -- the whole state directory, byte for byte.
// ---------------------------------------------------------------------------

test("reminders sync (no --apply): writes nothing to the state directory", async (t) => {
  const stateDir = await setup();
  t.after(() => cleanup(stateDir));
  const fixturePath = await writeFixture(stateDir, "fixture.json", { status: 0, stdout: JSON.stringify(RECORDS), stderr: "" });

  const before = fullStateSnapshot(stateDir);
  const r = runCli(["reminders", "sync"], { stateDir, fixturePath });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fullStateSnapshot(stateDir), before, "a dry-run sync must not touch the state directory");
});

test("reminders sync --json (no --apply): writes nothing, and reports the real measured dispositions", async (t) => {
  const stateDir = await setup();
  t.after(() => cleanup(stateDir));
  const fixturePath = await writeFixture(stateDir, "fixture.json", { status: 0, stdout: JSON.stringify(RECORDS), stderr: "" });

  const before = fullStateSnapshot(stateDir);
  const r = runCli(["reminders", "sync", "--json"], { stateDir, fixturePath });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fullStateSnapshot(stateDir), before);

  const payload = JSON.parse(r.stdout.trim());
  assert.equal(payload.ok, true);
  assert.equal(payload.applied, false);

  const ccusage = payload.rows.find((row) => row.reminderId === "id-1");
  const vipinkaushik = payload.rows.find((row) => row.reminderId === "id-2");
  // If either of these two ever reports anything else, that is a finding to
  // explain, not to tune toward (per the plan's own verification item 7) --
  // the tree may have changed since this was measured.
  assert.equal(ccusage.disposition, "held-no-register", `expected held-no-register for #ccusage; got ${ccusage.disposition} (${ccusage.reason ?? "no reason"})`);
  assert.equal(
    vipinkaushik.disposition,
    "held-ambiguous-register",
    `expected held-ambiguous-register for #vipinkaushik; got ${vipinkaushik.disposition} (${vipinkaushik.reason ?? "no reason"})`,
  );
  assert.equal(payload.rows.find((row) => row.reminderId === "id-3").disposition, "held-untagged");
  assert.equal(payload.rows.find((row) => row.reminderId === "id-4").disposition, "held-unknown-tag");
});

// ---------------------------------------------------------------------------
// --apply, against fixtures that never reach a real register write (both
// real tags refuse before any register content is touched) -- still a real
// exercise of the --apply code path and the state directory it touches.
// ---------------------------------------------------------------------------

test("reminders sync --apply --json: still writes nothing when every routed item is a refusal before any register write", async (t) => {
  const stateDir = await setup();
  t.after(() => cleanup(stateDir));
  const fixturePath = await writeFixture(stateDir, "fixture.json", { status: 0, stdout: JSON.stringify(RECORDS), stderr: "" });

  const before = fullStateSnapshot(stateDir);
  const r = runCli(["reminders", "sync", "--apply", "--json"], { stateDir, fixturePath });
  assert.equal(r.status, 0, r.stderr);

  const payload = JSON.parse(r.stdout.trim());
  assert.equal(payload.ok, true);
  assert.equal(payload.applied, true);
  // held-no-register / held-ambiguous-register are resolved BEFORE any
  // register file is even read, so --apply here is safe by construction:
  // nothing to insert, so the identity map (still created since assignId
  // ran and the batched save runs once at the end) is the only touched file.
  const snapAfter = fullStateSnapshot(stateDir);
  assert.notEqual(snapAfter, before, "the identity map IS expected to be created (ids were minted for routed rows)");
  assert.doesNotMatch(snapAfter, /insert-log/, "no insert-log row may exist -- nothing was ever inserted");
});

// ---------------------------------------------------------------------------
// An inconclusive read is passed straight through, never silently zeroed.
// ---------------------------------------------------------------------------

test("reminders sync: an inconclusive read exits non-zero and writes nothing", async (t) => {
  const stateDir = await setup();
  t.after(() => cleanup(stateDir));
  const fixturePath = await writeFixture(stateDir, "fixture-denied.json", {
    status: 1, stdout: "", stderr: "Not authorized to send Apple events to Reminders. (-1743)",
  });

  const before = fullStateSnapshot(stateDir);
  const r = runCli(["reminders", "sync", "--apply"], { stateDir, fixturePath });
  assert.equal(r.status, 2);
  assert.equal(fullStateSnapshot(stateDir), before, "an inconclusive read must not touch the state directory even with --apply");
});

// ---------------------------------------------------------------------------
// The default `reminders` command (no subverb) is unaffected by adding
// `sync` -- same coverage tests/cli/reminders.test.mjs already asserts,
// re-checked here as a wiring smoke test that argv[0]==="sync" dispatch did
// not swallow the default path.
// ---------------------------------------------------------------------------

test("reminders (no subverb) still works after adding the sync subverb", async (t) => {
  const stateDir = await setup();
  t.after(() => cleanup(stateDir));
  const fixturePath = await writeFixture(stateDir, "fixture.json", { status: 0, stdout: JSON.stringify(RECORDS), stderr: "" });

  const before = fullStateSnapshot(stateDir);
  const r = runCli(["reminders", "--json"], { stateDir, fixturePath });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fullStateSnapshot(stateDir), before);
  const payload = JSON.parse(r.stdout.trim());
  assert.equal(payload.ok, true);
  assert.equal(payload.summary.total, 4);
});
