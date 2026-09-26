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
 * EVERY TEST HERE GETS ITS OWN HUB, and that is not tidiness -- it is the fix
 * for a real incident on 2026-09-25.
 *
 * This file used to rely on a PREMISE ABOUT THE LIVE FILESYSTEM, stated right
 * here: "both real tags resolve to REFUSALS on this tree ... no test here ever
 * needs `--apply` against a real register path." It was true when written. Then
 * `claude-usage-widget` gained a register so that `#ccusage` reminders had
 * somewhere to land, `#ccusage` stopped refusing, and the `--apply` test below
 * wrote `### PR-001 · a ccusage item` -- a FIXTURE RECORD from this file -- into
 * a human-authored `TODOS.md` in another repo.
 *
 * `PROPAGATE_STATE_DIR` was scoped per test and did not help, because the
 * register path was never derived from the state dir: `lib/reminders/sync.mjs`
 * built it from a HOME-derived guess at the hub that no scoping reached. That
 * guess is now `HUB_ROOT`, so `PROPAGATE_HUB_ROOT` below points the whole lane
 * at a temp tree and the real one is unreachable BY CONSTRUCTION rather than by
 * a sentence in a comment that a later change can quietly falsify.
 *
 * This is G56's family one level worse: there a bare `node --test` wrote the
 * production LEDGER; here a scoped test wrote a production REGISTER in a
 * different repository.
 *
 * The temp hub declares the same two tag shapes the real tree has, so the
 * coverage is unchanged: one tag that resolves to a usable register, and one
 * that is ambiguous. The full insert/idempotency/write-order matrix, hermetic
 * against injected paths, lives in tests/unit/reminders-sync.test.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { fullStateSnapshot } from "../helpers/full-state-snapshot.mjs";

const CLI_PATH = fileURLToPath(new URL("../../cli.mjs", import.meta.url));

function runCli(argv, { stateDir, hubDir, fixturePath }) {
  assert.ok(hubDir, "every runCli call must pass a temp hubDir — see this file's header");
  return spawnSync(process.execPath, [CLI_PATH, ...argv], {
    encoding: "utf8",
    env: {
      ...process.env,
      PROPAGATE_STATE_DIR: stateDir,
      PROPAGATE_SEARCH_ROOTS: stateDir,
      // The load-bearing one. Without it the reminders lane resolves registers
      // against the real tree; with it, nothing outside hubDir is reachable.
      PROPAGATE_HUB_ROOT: hubDir,
      ...(fixturePath ? { PROPAGATE_REMINDERS_FIXTURE: fixturePath } : {}),
    },
  });
}

/** The real register this file once wrote into. Asserted untouched, every test. */
const REAL_REGISTER = path.resolve(
  fileURLToPath(new URL("../../..", import.meta.url)),
  "Rupali/propagation/state/claude-usage-widget/TODOS.md",
);

function realRegisterFingerprint() {
  try { return readFileSync(REAL_REGISTER, "utf8"); } catch { return "<absent>"; }
}

/**
 * A temp hub carrying the two tag shapes the real tree has:
 *   #ccusage      -> a canonical register WITH the staging heading  => insertable
 *   #vipinkaushik -> no canonical register, a legacy one at the root => ambiguous
 */
async function makeHub() {
  const hubDir = await mkdtemp(path.join(tmpdir(), "reminders-sync-hub-"));

  const cuw = path.join(hubDir, "Rupali", "propagation", "state", "claude-usage-widget");
  await mkdir(cuw, { recursive: true });
  await mkdir(path.join(hubDir, "Rupali", "claude-usage-widget"), { recursive: true });
  await writeFile(path.join(cuw, ".sidecar.yml"), "project: claude-usage-widget\nreminder_tags:\n  - ccusage\n");
  await writeFile(path.join(cuw, "TODOS.md"), [
    "# TODOS — fixture",
    "",
    "## From Reminders (unreviewed)",
    "",
    "## Finished",
    "",
    "### PR-000 · seed, so the file elects id-keyed rather than unrecognised",
    "An empty register elects no format, and A3 refuses an insert that changes the election.",
    "",
  ].join("\n"));

  const vk = path.join(hubDir, "Vipin Kaushik", "propagation", "state", "workspace");
  await mkdir(vk, { recursive: true });
  await writeFile(path.join(vk, ".sidecar.yml"), "project: workspace\nreminder_tags:\n  - vipinkaushik\n");
  // A legacy repo-root register and no canonical one => held-ambiguous-register.
  await writeFile(path.join(hubDir, "Vipin Kaushik", "TODOS.md"), "# TODOS\n\n## Some Other Shape\n");

  return hubDir;
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
  const hubDir = await makeHub();
  const realBefore = realRegisterFingerprint();
  t.after(() => cleanup(stateDir, hubDir));
  t.after(() => assert.equal(realRegisterFingerprint(), realBefore,
    `this test modified ${REAL_REGISTER} — the temp hub is not containing it`));
  const fixturePath = await writeFixture(stateDir, "fixture.json", { status: 0, stdout: JSON.stringify(RECORDS), stderr: "" });

  const before = fullStateSnapshot(stateDir);
  const r = runCli(["reminders", "sync"], { stateDir, hubDir, fixturePath });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fullStateSnapshot(stateDir), before, "a dry-run sync must not touch the state directory");
});

test("reminders sync --json (no --apply): writes nothing, and reports the real measured dispositions", async (t) => {
  const stateDir = await setup();
  const hubDir = await makeHub();
  const realBefore = realRegisterFingerprint();
  t.after(() => cleanup(stateDir, hubDir));
  t.after(() => assert.equal(realRegisterFingerprint(), realBefore,
    `this test modified ${REAL_REGISTER} — the temp hub is not containing it`));
  const fixturePath = await writeFixture(stateDir, "fixture.json", { status: 0, stdout: JSON.stringify(RECORDS), stderr: "" });

  const before = fullStateSnapshot(stateDir);
  const r = runCli(["reminders", "sync", "--json"], { stateDir, hubDir, fixturePath });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fullStateSnapshot(stateDir), before);

  const payload = JSON.parse(r.stdout.trim());
  assert.equal(payload.ok, true);
  assert.equal(payload.applied, false);

  const ccusage = payload.rows.find((row) => row.reminderId === "id-1");
  const vipinkaushik = payload.rows.find((row) => row.reminderId === "id-2");
  // These describe the TEMP HUB `makeHub()` built, not this machine's tree.
  // They used to describe the real tree, and that is exactly what broke: the
  // expectation was `held-no-register` because no register existed under
  // `Rupali/claude-usage-widget`, and the day one did, this assertion was the
  // SECOND thing to notice -- the first was a fixture line appearing in that
  // register. A test whose expected value is a fact about someone's laptop is
  // not hermetic, however carefully it is commented.
  assert.equal(ccusage.disposition, "new",
    `#ccusage routes to a register WITH a staging heading in the temp hub, so it should plan an insert; got ${ccusage.disposition} (${ccusage.reason ?? "no reason"})`);
  assert.match(ccusage.wouldInsert ?? "", /^### PR-\d+ · a ccusage item$/,
    `the planned line must carry the reminder's real title: ${JSON.stringify(ccusage.wouldInsert)}`);
  assert.equal(
    vipinkaushik.disposition,
    "held-ambiguous-register",
    `expected held-ambiguous-register for #vipinkaushik; got ${vipinkaushik.disposition} (${vipinkaushik.reason ?? "no reason"})`,
  );
  assert.equal(payload.rows.find((row) => row.reminderId === "id-3").disposition, "held-untagged");
  assert.equal(payload.rows.find((row) => row.reminderId === "id-4").disposition, "held-unknown-tag");
});

// ---------------------------------------------------------------------------
// --apply, against the TEMP hub's register. This file could not cover the real
// write path before, because its only insertable target would have been a real
// human-authored file; the temp hub makes it both safe and meaningful, so the
// gap its header used to declare is closed rather than documented.
// ---------------------------------------------------------------------------

test("reminders sync --apply --json: inserts into the register, logs it, and is idempotent on a second run", async (t) => {
  const stateDir = await setup();
  const hubDir = await makeHub();
  const realBefore = realRegisterFingerprint();
  t.after(() => cleanup(stateDir, hubDir));
  t.after(() => assert.equal(realRegisterFingerprint(), realBefore,
    `this test modified ${REAL_REGISTER} — the temp hub is not containing it`));
  const fixturePath = await writeFixture(stateDir, "fixture.json", { status: 0, stdout: JSON.stringify(RECORDS), stderr: "" });

  const before = fullStateSnapshot(stateDir);
  const r = runCli(["reminders", "sync", "--apply", "--json"], { stateDir, hubDir, fixturePath });
  assert.equal(r.status, 0, r.stderr);

  const payload = JSON.parse(r.stdout.trim());
  assert.equal(payload.ok, true);
  assert.equal(payload.applied, true);
  assert.equal(payload.writesToRegister, true);

  // The register in the TEMP hub gained the line, under the staging heading.
  const reg = path.join(hubDir, "Rupali", "propagation", "state", "claude-usage-widget", "TODOS.md");
  const text = readFileSync(reg, "utf8");
  assert.match(text, /^### PR-\d+ · a ccusage item$/m, `the line was not inserted:\n${text}`);
  const staging = text.slice(text.indexOf("## From Reminders"), text.indexOf("## Finished"));
  assert.match(staging, /a ccusage item/, "the line landed OUTSIDE the staging section");

  // And the state dir records it: an identity map with insertedAt, and a log.
  const snapAfter = fullStateSnapshot(stateDir);
  assert.notEqual(snapAfter, before, "--apply must write");
  assert.match(snapAfter, /insertedAt/, "the identity map must record the insert, or the next run duplicates it");

  // Idempotency — R3's load-bearing guarantee, end to end through the CLI.
  const second = runCli(["reminders", "sync", "--apply", "--json"], { stateDir, hubDir, fixturePath });
  assert.equal(second.status, 0, second.stderr);
  const p2 = JSON.parse(second.stdout.trim());
  const again = p2.rows.find((row) => row.reminderId === "id-1");
  assert.equal(again.disposition, "already-inserted",
    `a second run must not re-insert; got ${again.disposition}`);
  assert.equal(readFileSync(reg, "utf8"), text,
    "the register must be byte-identical after the second run");
});

// ---------------------------------------------------------------------------
// An inconclusive read is passed straight through, never silently zeroed.
// ---------------------------------------------------------------------------

test("reminders sync: an inconclusive read exits non-zero and writes nothing", async (t) => {
  const stateDir = await setup();
  const hubDir = await makeHub();
  const realBefore = realRegisterFingerprint();
  t.after(() => cleanup(stateDir, hubDir));
  t.after(() => assert.equal(realRegisterFingerprint(), realBefore,
    `this test modified ${REAL_REGISTER} — the temp hub is not containing it`));
  const fixturePath = await writeFixture(stateDir, "fixture-denied.json", {
    status: 1, stdout: "", stderr: "Not authorized to send Apple events to Reminders. (-1743)",
  });

  const before = fullStateSnapshot(stateDir);
  const r = runCli(["reminders", "sync", "--apply"], { stateDir, hubDir, fixturePath });
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
  const hubDir = await makeHub();
  const realBefore = realRegisterFingerprint();
  t.after(() => cleanup(stateDir, hubDir));
  t.after(() => assert.equal(realRegisterFingerprint(), realBefore,
    `this test modified ${REAL_REGISTER} — the temp hub is not containing it`));
  const fixturePath = await writeFixture(stateDir, "fixture.json", { status: 0, stdout: JSON.stringify(RECORDS), stderr: "" });

  const before = fullStateSnapshot(stateDir);
  const r = runCli(["reminders", "--json"], { stateDir, hubDir, fixturePath });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fullStateSnapshot(stateDir), before);
  const payload = JSON.parse(r.stdout.trim());
  assert.equal(payload.ok, true);
  assert.equal(payload.summary.total, 4);
});
