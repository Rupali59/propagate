/**
 * F2 — the guard that stands between reconcileReminders() and two recorded
 * incidents (H2, `docs/plans/2026-09-23-reminders-todo-bridge.md:93-97`):
 * N44 (2 junk events, permanent) and the 2026-08-17 incident (11 spurious
 * events, 3 silently-closed worklist items).
 *
 * `rule:safety-flag-needs-a-test` in full: not "the flag is read", not "the
 * happy path works" — construct the input that would take the unsafe path
 * and assert it does not. The load-bearing assertion measures the STORE
 * (every byte under the reminders state subtree), never the return value's
 * wording, and it is looped across every disposition `reconcileReminders`
 * can produce, per F2's own warning that all three recorded instances were
 * one guarded path beside one unguarded path — a single-case test would
 * have passed every one of them.
 *
 * NOT CLI-LEVEL, AND THAT IS A DELIBERATE, REPORTED GAP. The spec's F2
 * pseudocode shows `runCli(["reminders", "--reconcile"], env)`. No such
 * subcommand exists: `commands/reminders.mjs` (L4) has no --apply/--reconcile
 * path, and `cli.mjs`'s dispatch does not route one — both files are
 * explicitly outside this lane's ownership. `reconcileReminders()` is
 * exercised directly instead; wiring a `reminders reconcile` CLI verb is
 * follow-up work for whoever owns cli.mjs next. See this lane's handback.
 *
 * Run: `PROPAGATE_STATE_DIR="${TMPDIR:-/tmp}/propagate-test-state" node --test
 * tests/unit/reminders-reconcile.test.mjs` (G56 — never bare `node --test`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { reconcileReminders, DISPOSITIONS } from "../../lib/reminders/reconcile.mjs";
import { identityMapPath, saveIdentityMap } from "../../lib/reminders/identity-map.mjs";
import { reconcileLogPath } from "../../lib/reminders/reconcile-log.mjs";
import { fullStateSnapshot } from "../helpers/full-state-snapshot.mjs";

async function freshStateDir() {
  const d = await mkdtemp(path.join(tmpdir(), "reminders-reconcile-"));
  // Pre-existing, unrelated state -- "writes nothing" must be a claim about
  // an OCCUPIED directory, not a vacuous one about an empty tmpdir (same
  // discipline as tests/cli/reminders.test.mjs's setup()).
  await writeFile(path.join(d, "metrics.jsonl"), '{"pre":"existing"}\n');
  return d;
}
const cleanup = (d) => rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });

function fixtureFor(items) {
  return async () => ({ ok: true, list: "Claude TODO", items, summary: {} });
}

const ROUTED = (over = {}) => ({
  id: "reminder-1",
  title: "test item",
  body: "#ccusage",
  completed: false,
  completedAt: null,
  modifiedAt: null,
  tags: ["ccusage"],
  route: { kind: "routed", tag: "ccusage", project: "Rupali/claude-usage-widget", path: "/x" },
  ...over,
});
const HELD_UNTAGGED = { ...ROUTED(), id: "reminder-2", tags: [], route: { kind: "held-untagged" } };
const HELD_UNKNOWN = {
  ...ROUTED(),
  id: "reminder-3",
  tags: ["nosuchproject"],
  route: { kind: "held-unknown-tag", tag: "nosuchproject" },
};

// ---------------------------------------------------------------------------
// Per-disposition scenarios. Each returns { fixture, seed } where `seed`
// optionally pre-populates the identity map (via a real `apply:true` run, or
// a direct write) so the disposition under test is the one that fires.
// ---------------------------------------------------------------------------

const SCENARIOS = {
  new: { items: [ROUTED()], seed: null },
  "no-change": {
    items: [ROUTED({ completed: false })],
    seed: { completed: false, completedAt: null },
  },
  completed: {
    items: [ROUTED({ completed: true, completedAt: "2026-09-25T00:00:00.000Z" })],
    seed: { completed: false, completedAt: null },
  },
  reopened: {
    items: [ROUTED({ completed: false, completedAt: null })],
    seed: { completed: true, completedAt: "2026-09-20T00:00:00.000Z" },
  },
  "held-untagged": { items: [HELD_UNTAGGED], seed: null },
  "held-unknown-tag": { items: [HELD_UNKNOWN], seed: null },
};

test("every SCENARIO key matches DISPOSITIONS exactly -- the loop below is not silently short", () => {
  assert.deepEqual(Object.keys(SCENARIOS).sort(), [...DISPOSITIONS].sort());
});

for (const [disposition, { items, seed }] of Object.entries(SCENARIOS)) {
  test(`F2 dry-run [${disposition}]: WITHOUT apply, the reminders store is byte-identical before and after`, async () => {
    const stateDir = await freshStateDir();
    try {
      if (seed) {
        await saveIdentityMap(
          { version: 1, nextSeq: 2, entries: { "reminder-1": { id: "PR-001", firstSeen: "2026-09-01T00:00:00.000Z", lastObserved: seed } } },
          stateDir,
        );
      }
      const before = fullStateSnapshot(stateDir);

      const result = await reconcileReminders({ readRemindersFn: fixtureFor(items), stateDir, apply: false });

      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.applied, false);
      assert.equal(
        result.rows.some((r) => r.disposition === disposition),
        true,
        `fixture for "${disposition}" did not actually produce that disposition -- rows: ${JSON.stringify(result.rows)}`,
      );

      const after = fullStateSnapshot(stateDir);
      assert.equal(after, before, `[${disposition}] WITHOUT apply must not touch the reminders store`);
    } finally {
      await cleanup(stateDir);
    }
  });
}

test("F2 dry-run: an INCONCLUSIVE read never writes either, regardless of apply", async () => {
  const stateDir = await freshStateDir();
  try {
    const inconclusive = async () => ({ ok: false, reason: "tcc-denied", reasonDetail: "(-1743)", code: "-1743" });

    const before = fullStateSnapshot(stateDir);
    const dry = await reconcileReminders({ readRemindersFn: inconclusive, stateDir, apply: false });
    assert.equal(dry.ok, false);
    assert.equal(fullStateSnapshot(stateDir), before, "inconclusive + apply:false must not write");

    // The sharper case: apply:true on an INCONCLUSIVE read must ALSO write
    // nothing -- "could not look" must never be treated as "nothing to
    // reconcile, so proceed".
    const wet = await reconcileReminders({ readRemindersFn: inconclusive, stateDir, apply: true });
    assert.equal(wet.ok, false);
    assert.equal(fullStateSnapshot(stateDir), before, "inconclusive + apply:true must ALSO not write");
  } finally {
    await cleanup(stateDir);
  }
});

// ---------------------------------------------------------------------------
// The positive control: rule:discernment-checks §1, a check that cannot fail
// is worse than no check. If apply:true never wrote anything either, every
// assertion above would be trivially true and prove nothing. This is what
// makes the dry-run assertions meaningful.
// ---------------------------------------------------------------------------

test("positive control: apply:true actually writes the identity map AND the reconciliation log", async () => {
  const stateDir = await freshStateDir();
  try {
    const before = fullStateSnapshot(stateDir);
    const result = await reconcileReminders({ readRemindersFn: fixtureFor([ROUTED()]), stateDir, apply: true });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.applied, true);

    const after = fullStateSnapshot(stateDir);
    assert.notEqual(after, before, "apply:true must change the store -- otherwise the dry-run tests above prove nothing");

    const { existsSync } = await import("node:fs");
    assert.equal(existsSync(identityMapPath(stateDir)), true, "identity-map.json must exist after apply");
    assert.equal(existsSync(reconcileLogPath(stateDir)), true, "reconcile-log.jsonl must exist after apply");
  } finally {
    await cleanup(stateDir);
  }
});

test("writesToRegister is always false -- this reconciler does not yet mutate a project's TODO register", async () => {
  const stateDir = await freshStateDir();
  try {
    const dry = await reconcileReminders({ readRemindersFn: fixtureFor([ROUTED()]), stateDir, apply: false });
    assert.equal(dry.writesToRegister, false);
    const wet = await reconcileReminders({ readRemindersFn: fixtureFor([ROUTED()]), stateDir, apply: true });
    assert.equal(wet.writesToRegister, false);
  } finally {
    await cleanup(stateDir);
  }
});

test("held items never mint an identity", async () => {
  const stateDir = await freshStateDir();
  try {
    await reconcileReminders({ readRemindersFn: fixtureFor([HELD_UNTAGGED, HELD_UNKNOWN]), stateDir, apply: true });
    const { readFile } = await import("node:fs/promises");
    const map = JSON.parse(await readFile(identityMapPath(stateDir), "utf8"));
    assert.deepEqual(map.entries, {}, "held items must never appear in the identity map");
  } finally {
    await cleanup(stateDir);
  }
});
