/**
 * The four metrics calibrated on 2026-09-30 (TODOS PR-029), and the two that were
 * deliberately not.
 *
 * `docs/OBSERVABILITY.md` §6 closes with the design rule these tests defend: *"a
 * metric without an expectation is decoration. Every gauge above ships with the
 * assertion that makes it alertable, or it does not ship."* Six of twelve were
 * decoration until this change.
 *
 * THE POINT OF EACH TEST IS THE FAILING INPUT, per rule:discernment-checks §1 —
 * every check ships with the input that makes it fail, constructed before shipping.
 * A threshold nobody has fed a violation to is a number, not a check.
 *
 * AND THE BOUNDARY MATTERS AS MUCH AS THE FAILURE. A threshold that also fires one
 * step inside it is noise, and noise is a hiding place (G23).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EXPECTATIONS, UNCALIBRATED, RETIRED_METRICS, evaluateExpectations, detectVanishedKeys,
} from "../../lib/report/metrics.mjs";

/** A record that violates nothing — the base every case mutates one key of. */
const CLEAN = Object.freeze({
  // ALL TWELVE KEYS, because four of the pre-existing expectations require the key to
  // be PRESENT rather than defaulting it — `graph.cycles`, `graph.duplicate_pairs`,
  // `ledger.unknown_types` and `sidecars.rejected` assert on the raw value, so an
  // absent key fails them. The first version of this fixture omitted them and the
  // negative control below caught it, which is the only reason the other cases here
  // are attributable to the key under test.
  "graph.cycles": 0,
  "graph.duplicate_pairs": 0,
  "ledger.unknown_types": 0,
  "sidecars.rejected": 0,
  "decisions.entries": 28,
  "decisions.with_tokens": 28,   // cross-key: must EQUAL decisions.entries
  "docs.supersedes_unresolvable": 0,
  "docs.supersession_prose_only": 34,
  "workspaces.discovered": 21,
  "ledger.malformed": 0,
  "doctor.duration_ms": 100_000,
  "sidecars.problems": 0,
  "sidecars.loaded": 49,
  "instructions.unexcepted_over": 0,
  "instructions.stale_exceptions": 0,
  "instructions.over_ceiling": 0,
});

const fires = (metrics, key) => evaluateExpectations(metrics).filter((v) => v.key === key);

test("the clean record violates nothing — without this the failing cases prove nothing", () => {
  // The negative control for every test below. If CLEAN itself violated something,
  // a `fires` result would not be attributable to the key under test.
  assert.deepEqual(evaluateExpectations(CLEAN), [], "the base record must be clean");
});

test("ledger.malformed == 0 fires on the first malformed line", () => {
  // 0 on all 1,092 records since 2026-08-13. readLedger SKIPS a malformed line
  // silently, so without this expectation the first one is invisible.
  assert.equal(fires({ ...CLEAN, "ledger.malformed": 1 }, "ledger.malformed").length, 1);
  assert.equal(fires(CLEAN, "ledger.malformed").length, 0);
});

test("doctor.duration_ms asserts the PATHOLOGY, not the design's p95 < 5s target", () => {
  // The decision this test exists to pin. OBSERVABILITY §1 wants p95 < 5s; measured
  // over 1,092 runs, 95.8% exceed 5s (p50 27s, p95 115s). An expectation at 5s would
  // be red on essentially every run, and a permanently-red doctor gets ignored.
  const exp = EXPECTATIONS.find((e) => e.key === "doctor.duration_ms");
  assert.ok(exp, "doctor.duration_ms must carry an expectation now");

  // A NORMAL run must not fire, or the check is the thing it was written to avoid.
  for (const ms of [280, 27_112, 114_801, 366_748, 1_799_999]) {
    assert.equal(
      fires({ ...CLEAN, "doctor.duration_ms": ms }, "doctor.duration_ms").length, 0,
      `${ms}ms is inside the observed distribution and must not fire`,
    );
  }
  // The 188-minute outlier — N91's actual worst — must.
  const v = fires({ ...CLEAN, "doctor.duration_ms": 11_272_497 }, "doctor.duration_ms");
  assert.equal(v.length, 1, "the 188-minute run must fire");
  assert.match(v[0].detail, /187\.9 min/, "the detail must name the duration, not just 'too slow'");
  assert.match(v[0].detail, /N91/, "and point at the issue it is evidence for");

  // Stated rather than implied: this threshold is NOT the design target.
  assert.doesNotMatch(exp.describe, /5000|5s/, "the assertion must not claim to enforce p95 < 5s");
  assert.match(exp.basis, /95\.8%/, "the basis must record why the design target was not used");
});

test("sidecars.problems is a RATCHET at the observed max, not an equality", () => {
  // 45 of 1,092 runs are non-zero, max 2. An equality would fail on a known and
  // accepted condition and become noise.
  assert.equal(fires({ ...CLEAN, "sidecars.problems": 2 }, "sidecars.problems").length, 0,
    "2 is the observed max and must not fire");
  assert.equal(fires({ ...CLEAN, "sidecars.problems": 3 }, "sidecars.problems").length, 1,
    "3 is new behaviour and must fire");
  assert.match(EXPECTATIONS.find((e) => e.key === "sidecars.problems").describe, /ratchet/);
});

test("sidecars.loaded is NOT calibrated — a flat floor broke every small install", () => {
  // A `>= 40` floor was derived from this machine's last 100 runs (47-53) and shipped
  // for about ten minutes. It broke 11 tests: a fixture workspace loads ONE sidecar,
  // and by the same arithmetic it would fail `doctor` on any real install smaller
  // than this one, including a fresh one.
  //
  // rule:enforcement-watches-itself §3 says to run the check with its inputs emptied.
  // This is that failure inverted — the check did not pass vacuously, it reported a
  // legitimate small install as broken — and the existing suite caught it because
  // those fixtures ARE the small install.
  //
  // Pinned as a test so the floor is not reintroduced: the next person to look at a
  // 47-53 band will have the same idea.
  assert.equal(EXPECTATIONS.find((e) => e.key === "sidecars.loaded"), undefined,
    "sidecars.loaded must NOT carry a flat-threshold expectation — it is scale-dependent");
  const u = UNCALIBRATED.find((x) => x.key === "sidecars.loaded");
  assert.ok(u, "it belongs in UNCALIBRATED, with the reason");
  assert.match(u.reason, /per-workspace/i, "and the reason must name the scale-free check that would work");
  assert.match(u.reason, /1 sidecar|\*\*1\*\*/, "and record what actually broke");
});

test("every new expectation carries a basis naming its derivation, never a bare number", () => {
  // G3/G16: an invented threshold is worse than none. The basis is what makes the
  // number auditable a month from now, and it is the difference between calibration
  // and guessing.
  for (const key of ["ledger.malformed", "doctor.duration_ms", "sidecars.problems"]) {
    const e = EXPECTATIONS.find((x) => x.key === key);
    assert.ok(e, `${key} must carry an expectation`);
    assert.match(e.basis, /1,092 record/, `${key}'s basis must cite the history it was derived from`);
    assert.ok(e.basis.length > 120, `${key}'s basis must explain, not assert`);
  }
});

test("the remaining UNCALIBRATED entries say why they are NOT waiting on history", () => {
  // The list's value is the distinction. "Needs more data" and "a per-run gate is the
  // wrong instrument" and "the subject was deleted" are three different facts, and
  // only the first is a matter of time.
  assert.equal(UNCALIBRATED.length, 3,
    "three were calibrated, one reverted as scale-dependent, and state.tracked_files was RETIRED " +
    "rather than exempted — four outcomes for six metrics, which is the point of keeping them apart; " +
    "instructions.chars.max (2026-10-02) is recorded for the trend and asserted by its three siblings instead");
  const byKey = Object.fromEntries(UNCALIBRATED.map((u) => [u.key, u.reason]));

  assert.ok("rows.open" in byKey);
  assert.match(byKey["rows.open"], /trend/i, "rows.open is a trend question");
  assert.match(byKey["rows.open"], /--since/, "and --since is where it is answered");

  // state.tracked_files is NOT here any more — it was retired, which is a third
  // state and has its own tests below. Asserting its absence is what stops it
  // quietly reappearing as "exempt" when the honest answer is "gone".
  assert.ok(!("state.tracked_files" in byKey), "a retired metric is not an exempt one");

  assert.ok("sidecars.loaded" in byKey);
  assert.match(byKey["sidecars.loaded"], /scale/i, "sidecars.loaded is scale-dependent, not pending data");

  // None of the four calibrated keys may linger here, or doctor would print a metric
  // as both asserted and exempt.
  for (const key of ["ledger.malformed", "doctor.duration_ms", "sidecars.problems"]) {
    assert.ok(!(key in byKey), `${key} is calibrated and must not also be listed uncalibrated`);
  }
});

test("no metric is both asserted and exempt", () => {
  const asserted = new Set(EXPECTATIONS.map((e) => e.key));
  for (const u of UNCALIBRATED) {
    assert.ok(!asserted.has(u.key), `${u.key} appears in both EXPECTATIONS and UNCALIBRATED`);
  }
});

// ── retirement (N115) ───────────────────────────────────────────────────────

test("a DECLARED retirement is not reported as a vanished signal", () => {
  // `detectVanishedKeys` is right to report a key that stops being emitted — R6's
  // silent absence. But it cannot tell a broken collector from a deliberate removal,
  // and without the distinction a retirement prints a doctor failure and the next
  // reader investigates a non-issue.
  assert.deepEqual(detectVanishedKeys({}, { "state.tracked_files": 0 }), [],
    "a retired key must not read as vanished");
  assert.deepEqual(detectVanishedKeys({}, { "rows.open": 0 }), ["rows.open"],
    "a real vanish still must");
});

test("every retirement carries a DATE and a reason, not just a key", () => {
  // The list's whole value is that absence stays attributable. A bare key would make
  // a retirement indistinguishable from a typo in the collector.
  assert.ok(RETIRED_METRICS.length >= 1);
  for (const r of RETIRED_METRICS) {
    assert.match(r.retired, /^20\d\d-\d\d-\d\d$/, `${r.key} needs a retirement date`);
    assert.ok(r.reason && r.reason.length > 60, `${r.key} needs a reason, not a bare key`);
  }
});

test("state.tracked_files is RETIRED, and is no longer collected, asserted or exempt", () => {
  // It measured ~/.propagate/state.json — the retired watcher's mtime baseline —
  // which does not exist: 208 until 2026-08-19, then 0 on 831 consecutive runs.
  const r = RETIRED_METRICS.find((x) => x.key === "state.tracked_files");
  assert.ok(r, "it belongs in RETIRED_METRICS");
  assert.match(r.reason, /831/, "and the reason must carry the measurement");
  assert.match(r.reason, /does not exist/, "and name why there is nothing to calibrate");

  assert.equal(EXPECTATIONS.find((e) => e.key === "state.tracked_files"), undefined,
    "a retired metric must not also be asserted");
  assert.equal(UNCALIBRATED.find((u) => u.key === "state.tracked_files"), undefined,
    "nor exempt — it is gone, which is a third state");
});

test("no key is in more than one of EXPECTATIONS, UNCALIBRATED and RETIRED_METRICS", () => {
  // Three mutually exclusive states: asserted, exempt, gone. A key in two of them
  // means doctor would describe one metric two ways.
  const seen = new Map();
  for (const [list, name] of [[EXPECTATIONS, "EXPECTATIONS"], [UNCALIBRATED, "UNCALIBRATED"], [RETIRED_METRICS, "RETIRED_METRICS"]]) {
    for (const x of list) {
      assert.ok(!seen.has(x.key), `${x.key} is in both ${seen.get(x.key)} and ${name}`);
      seen.set(x.key, name);
    }
  }
});
