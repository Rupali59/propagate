/**
 * Tests for lib/report/doctor/reminders.mjs — D2,
 * `docs/plans/2026-09-23-reminders-todo-bridge.md:138-165`.
 *
 * A TCC denial etc. must land as `inconclusive`, never `pass` (a green tick
 * over an unmeasured population, GOTCHAS G68) and never `fail` (nothing is
 * broken). Every one of L4's seven `reason` strings gets its own message —
 * this file asserts they are all DISTINCT, so a future edit cannot quietly
 * collapse two of them onto the same text without a test noticing
 * (rule:discernment-checks §2: a TCC denial and a missing list are different
 * facts and must not share an output).
 *
 * Run: `PROPAGATE_STATE_DIR="${TMPDIR:-/tmp}/propagate-test-state" node --test
 * tests/unit/doctor-reminders.test.mjs` (G56).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { Reporter } from "../../lib/report/doctor/reporter.mjs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { checkReminders, bridgeDeployment } from "../../lib/report/doctor/reminders.mjs";

const OK_RESULT = {
  ok: true,
  list: "Claude TODO",
  items: [],
  summary: { total: 5, routed: 3, heldUntagged: 1, heldUnknownTag: 1 },
};

// L4's seven stable reason strings — lib/reminders/osascript.mjs's
// KNOWN_CODES (tcc-denied, missing-list, syntax-error, app-not-running) plus
// read.mjs's two synthesized ones (timeout, unparseable-output) and
// osascript.mjs's catch-all (osascript-error).
const ALL_REASONS = [
  "tcc-denied",
  "missing-list",
  "syntax-error",
  "app-not-running",
  "timeout",
  "osascript-error",
  "unparseable-output",
];

test("a healthy read passes and reports the summary, never votes as a failure", async () => {
  const r = new Reporter();
  const { counts } = await checkReminders({ reporter: r, readRemindersFn: async () => OK_RESULT });
  assert.equal(r.problems, 0);
  assert.deepEqual(counts, { remindersTotal: 5, remindersRouted: 3, remindersHeldUntagged: 1, remindersHeldUnknownTag: 1 });
  assert.ok(r.entries.some((e) => e.kind === "pass"), "the check must actually run, not be skipped");
  assert.ok(r.entries.some((e) => e.kind === "header" && /Reminders bridge/.test(e.label)));
});

for (const reason of ALL_REASONS) {
  test(`reason "${reason}" lands as INCONCLUSIVE, never pass or fail`, async () => {
    const r = new Reporter();
    const { counts } = await checkReminders({
      reporter: r,
      readRemindersFn: async () => ({ ok: false, reason, reasonDetail: `detail for ${reason}`, code: null }),
    });
    assert.equal(r.problems, 1, "inconclusive must still vote -- an unmeasured run must not exit 0");
    assert.equal(r.entries.filter((e) => e.kind === "fail").length, 0, "never a hard fail -- nothing is broken");
    assert.equal(r.entries.filter((e) => e.kind === "pass").length, 0, "never a pass -- G68's vacuous-green shape");
    const inconclusive = r.entries.find((e) => e.kind === "inconclusive");
    assert.ok(inconclusive, "must produce an inconclusive entry");
    assert.match(inconclusive.detail, new RegExp(`detail for ${reason}`), "the raw reasonDetail must survive to the reader");
    assert.deepEqual(counts, { remindersTotal: 0, remindersRouted: 0, remindersHeldUntagged: 0, remindersHeldUnknownTag: 0 });
  });
}

test("every known reason produces a DISTINCT message -- none are collapsed into one generic line", async () => {
  const details = [];
  for (const reason of ALL_REASONS) {
    const r = new Reporter();
    await checkReminders({
      reporter: r,
      readRemindersFn: async () => ({ ok: false, reason, reasonDetail: "x", code: null }),
    });
    const entry = r.entries.find((e) => e.kind === "inconclusive");
    // Strip the shared reasonDetail suffix so this compares only the
    // reason-specific advice text, which is the part that must differ.
    details.push(entry.detail.replace(/ — x$/, ""));
  }
  assert.equal(new Set(details).size, ALL_REASONS.length, `expected ${ALL_REASONS.length} distinct messages, got ${new Set(details).size}: ${JSON.stringify(details)}`);
});

test("an UNRECOGNISED reason is reported honestly, not folded into a known message", async () => {
  const r = new Reporter();
  await checkReminders({
    reporter: r,
    readRemindersFn: async () => ({ ok: false, reason: "some-future-reason", reasonDetail: "novel failure", code: null }),
  });
  const entry = r.entries.find((e) => e.kind === "inconclusive");
  assert.match(entry.detail, /unrecognised reason "some-future-reason"/);
  assert.match(entry.detail, /novel failure/);
});

test("the label names the reason, so two different failures are distinguishable in a scan of doctor output", async () => {
  const r1 = new Reporter();
  await checkReminders({ reporter: r1, readRemindersFn: async () => ({ ok: false, reason: "tcc-denied", reasonDetail: "x", code: null }) });
  const r2 = new Reporter();
  await checkReminders({ reporter: r2, readRemindersFn: async () => ({ ok: false, reason: "missing-list", reasonDetail: "x", code: null }) });
  const l1 = r1.entries.find((e) => e.kind === "inconclusive").label;
  const l2 = r2.entries.find((e) => e.kind === "inconclusive").label;
  assert.notEqual(l1, l2);
  assert.match(l1, /tcc-denied/);
  assert.match(l2, /missing-list/);
});

/* ── the deployment gate ───────────────────────────────────────────────────
 *
 * Added 2026-09-25 with the gate itself. Without it `doctor` reported a
 * permanent `inconclusive` for a bridge nobody had installed -- N87's own
 * disease ("warnings bury the one that fires") reappearing inside the check
 * built to cure it, for a component that does not run yet.
 *
 * The gate reads the INSTALLED plist rather than asking launchd, per G-O:
 * launchd never re-reads a bootstrapped job's file, so `launchctl list` stays
 * green against a plist truncated underneath it.
 */
test("gate: no installed plist is NOT-INSTALLED, and is not a problem", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rem-gate-"));
  const d = bridgeDeployment(path.join(dir, "nope.plist"));
  assert.equal(d.deployed, false);
  assert.match(d.why, /no digest plist/i, "absence must be attributable, not a bare false");
});

test("gate: a ONE-entry plist is not deployed — the reminders slot is the second entry", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rem-gate-"));
  const f = path.join(dir, "one.plist");
  writeFileSync(
    f,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>StartCalendarInterval</key>
<dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
</dict></plist>`,
  );
  const d = bridgeDeployment(f);
  assert.equal(d.deployed, false, "a well-formed plist with one schedule is still not the bridge");
  assert.match(d.why, /1 schedule entry/, "the reason must NAME the count, not just say no");
});

test("gate: a TWO-entry plist IS deployed — proving the gate can say yes", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rem-gate-"));
  const f = path.join(dir, "two.plist");
  writeFileSync(
    f,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>StartCalendarInterval</key><array>
<dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
<dict><key>Hour</key><integer>21</integer><key>Minute</key><integer>0</integer></dict>
</array></dict></plist>`,
  );
  const d = bridgeDeployment(f);
  assert.equal(d.deployed, true, "the gate must be able to return TRUE — otherwise it is unfailable in the other direction");
  assert.equal(d.why, null);
});

test("gate: a CORRUPT plist is not-deployed and says so — never read as healthy", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rem-gate-"));
  const f = path.join(dir, "bad.plist");
  writeFileSync(f, `["\\/bin\\/bash","sample.sh"]`); // the exact G-O truncation shape
  const d = bridgeDeployment(f);
  assert.equal(d.deployed, false);
  assert.ok(/does not parse|no StartCalendarInterval|schedule entry/.test(d.why), `attributable reason, got: ${d.why}`);
});
