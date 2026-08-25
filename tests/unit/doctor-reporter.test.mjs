/**
 * Tests for lib/report/doctor/reporter.mjs.
 *
 * WHY THIS FILE EXISTS AT ALL. Before the doctor split, nine doctor test files
 * existed and **not one asserted any of doctor's 17 accumulators**. The exact
 * failure the split can introduce — a counter dropped at a module boundary —
 * had zero coverage: it renders as `0`, doctor still exits 0, and every other
 * test still passes. This file covers the one accumulator that decides the
 * exit code.
 *
 * Pure unit tests, no temp repos, no subprocess — the Reporter collects data
 * and prints nothing, which is exactly what makes that possible.
 *
 * Run: `npm test` (G56 — never bare `node --test`, that writes to the
 * production ledger; this file writes no events, but the rule is the file's
 * default, not a per-file judgement call).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Reporter, ENTRY_KINDS } from "../../lib/report/doctor/reporter.mjs";

test("check(label, false) increments problems; a passing check does not", () => {
  const r = new Reporter();
  assert.equal(r.problems, 0, "a fresh reporter has nothing to report");

  r.check("a passing thing", true);
  assert.equal(r.problems, 0, "a passing check must not count as a problem");

  r.check("a failing thing", false);
  assert.equal(r.problems, 1);

  r.check("another failing thing", false);
  assert.equal(r.problems, 2, "problems accumulates, it does not latch at 1");
});

test("warn() and info() must NEVER increment problems — the exit verdict depends on it", () => {
  // The load-bearing test in this file. `info` exists to restate failures
  // already reported above it (docs/ISSUES.md A2, GOTCHAS G20). If it voted,
  // every summarised defect would be counted twice — once by its own check and
  // again by the tally — and doctor's exit code would be wrong in the direction
  // that looks like diligence.
  const r = new Reporter();

  for (let i = 0; i < 5; i++) {
    r.warn(`warning ${i}`);
    r.info(`tally ${i}`);
  }

  assert.equal(r.problems, 0, "10 non-verdict entries must leave the run clean");
  assert.equal(r.entries.length, 10, "they are still reported to the reader, just not as verdicts");

  // And they must not mask a real failure either.
  r.check("a real failure", false);
  r.info("summary: 1 failure above");
  assert.equal(r.problems, 1, "the info summary must not add a second vote for the same defect");
});

test("check() returns its verdict, so a caller can branch without re-testing the condition", () => {
  const r = new Reporter();
  assert.equal(r.check("ok", true), true);
  assert.equal(r.check("not ok", false), false);
  // Truthiness is normalised — a caller passing a non-boolean must not produce
  // a `kind` of neither "pass" nor "fail".
  assert.equal(r.check("truthy", "yes"), true);
  assert.equal(r.check("falsy", 0), false);
  for (const e of r.entries) assert.ok(ENTRY_KINDS.includes(e.kind), `unknown kind ${e.kind}`);
});

test("entries are append-only and in call order — the orchestrator renders them as a sequence", () => {
  // Order is the property that keeps doctor's output byte-identical across the
  // split. If entries were bucketed by kind, or collected and sorted, the run
  // would reorder and every failure-mode diff would be noise.
  const r = new Reporter();
  r.info("first");
  r.check("second", false);
  r.warn("third");
  r.check("fourth", true);

  assert.deepEqual(
    r.entries.map((e) => [e.kind, e.label]),
    [
      ["info", "first"],
      ["fail", "second"],
      ["warn", "third"],
      ["pass", "fourth"],
    ],
  );
});

test("detail is carried through and defaults to empty, never undefined", () => {
  // `undefined` would render as the string "undefined" downstream. An absent
  // detail is a real, common case — most checks have none.
  const r = new Reporter();
  r.check("no detail", true);
  r.check("with detail", false, "because X");
  r.warn("warn detail", "w");
  r.info("info detail", "i");

  assert.equal(r.entries[0].detail, "");
  assert.equal(r.entries[1].detail, "because X");
  assert.equal(r.entries[2].detail, "w");
  assert.equal(r.entries[3].detail, "i");
  for (const e of r.entries) assert.equal(typeof e.detail, "string");
});

test("drain() empties the buffer but MUST NOT reset problems", () => {
  // The silent-zero this whole refactor exists to avoid. A reporter that
  // forgot its failures on drain would let doctor exit 0 after a failing
  // section — the module boundary swallowing a verdict, which is precisely the
  // failure mode with no coverage before this file.
  const r = new Reporter();
  r.check("module A failed", false);
  r.info("A summary");

  const first = r.drain();
  assert.equal(first.length, 2, "drain returns what was collected");
  assert.equal(r.entries.length, 0, "and clears the buffer for the next module");
  assert.equal(r.problems, 1, "but the run-global failure count SURVIVES the drain");

  r.check("module B passed", true);
  const second = r.drain();
  assert.equal(second.length, 1, "module B's entries do not include module A's");
  assert.deepEqual(
    second.map((e) => e.label),
    ["module B passed"],
  );
  assert.equal(r.problems, 1, "still 1 — B passing does not clear A's failure");
});

test("note() is a marker-less line, distinct from info, and never votes", () => {
  // `note` was added when the first extracted section needed it: doctor prints
  // "(no DECISIONS.md — tried ...)" as a bare dim line with no ✓/✗/!/· marker.
  // It is NOT info: info is a tally about checks that ran, note is context
  // about a check that could not run. Collapsing them would change output.
  const r = new Reporter();
  r.note("(no DECISIONS.md — tried a, b)");
  r.info("a tally");

  assert.equal(r.problems, 0, "context about an absent input is not a failure");
  assert.equal(r.entries[0].kind, "note");
  assert.equal(r.entries[1].kind, "info", "note and info must stay distinct kinds");
  assert.equal(r.entries[0].detail, "", "a note carries no detail — the whole line is the label");
  assert.ok(ENTRY_KINDS.includes("note"));
});

test("entriesOfKind filters without mutating", () => {
  const r = new Reporter();
  r.check("p", true);
  r.check("f", false);
  r.warn("w");
  r.info("i");

  assert.deepEqual(r.entriesOfKind("fail").map((e) => e.label), ["f"]);
  assert.deepEqual(r.entriesOfKind("pass").map((e) => e.label), ["p"]);
  assert.equal(r.entriesOfKind("nonexistent").length, 0, "an unknown kind is empty, not a throw");
  assert.equal(r.entries.length, 4, "filtering must not consume the buffer");
});
