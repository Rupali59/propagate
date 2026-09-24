/**
 * usage.test.mjs — which commands are used, and how often they fail.
 *
 * The store already existed and recorded the wrong things: 330 records in
 * `~/.propagate/runs`, every one shaped `durationMs, edge_counts, refs, roots,
 * run_id, ts`, written by ONE `appendRun` inside `reconcile`. So 1 of 32 commands
 * was instrumented, it did not record its own name, and nothing recorded a
 * failure.
 *
 * `docs/SYSTEMS.md` has the status `installed-never-invoked` and a human assigns
 * it by guessing. `rule:enforcement-watches-itself`: "A capability nobody invokes
 * is indistinguishable from one that was never built, and its tests pass either
 * way." This makes it derivable.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { usageReport } from "../../lib/report/usage.mjs";

const run = (o) => ({ run_id: "r" + Math.random(), ts: "2026-09-24T00:00:00Z", ...o });

test("counts invocations per command", () => {
  const r = usageReport(
    [run({ command: "doctor" }), run({ command: "doctor" }), run({ command: "status" })],
    ["doctor", "status"],
  );
  assert.equal(r.byCommand.doctor.invocations, 2);
  assert.equal(r.byCommand.status.invocations, 1);
});

test("a REFUSAL is not a FAILURE — counting the tool working as breakage buries the real ones", () => {
  // `verify` declining a DIVERGED edge and `rollup` refusing a hand-edited file
  // (exit 3) are the tool doing its job. N87 is about signal buried in noise;
  // this is the same mistake one layer down.
  const r = usageReport(
    [
      run({ command: "verify", outcome: "refused" }),
      run({ command: "verify", outcome: "refused" }),
      run({ command: "verify", outcome: "ok" }),
      run({ command: "verify", outcome: "error" }),
    ],
    ["verify"],
  );
  const v = r.byCommand.verify;
  assert.equal(v.invocations, 4);
  assert.equal(v.errors, 1, "only `error` is a failure");
  assert.equal(v.refusals, 2);
  assert.equal(v.failureRate, 0.25, "1 error of 4 invocations");
  assert.equal(v.refusalRate, 0.5);
});

test("a command with ZERO invocations is never-invoked, NOT 0% failure", () => {
  // rule:discernment-checks §2. A healthy-looking zero over an empty population
  // is the defect this whole plan exists to stop.
  // `instrumented` is required for a never-invoked verdict — see the coverage tests
  // below. Without it this test asserted the pre-coverage contract, where silence
  // and blindness were the same thing.
  const r = usageReport([run({ command: "doctor", outcome: "ok" })], ["doctor", "graph", "claims"], {
    instrumented: ["doctor", "graph", "claims"],
  });
  assert.deepEqual(r.neverInvoked.sort(), ["claims", "graph"]);
  assert.equal(r.byCommand.graph, undefined, "an uninvoked command gets no rate at all");
});

test("legacy records with no `command` read as reconcile, and say so", () => {
  // The 330 existing records predate the field. Inferring silently would make the
  // history look like it always had one.
  const r = usageReport([run({ durationMs: 10 }), run({ durationMs: 20 })], ["reconcile"]);
  assert.equal(r.byCommand.reconcile.invocations, 2);
  assert.equal(r.legacyAttributed, 2, "the count of records attributed by absence must be reported");
});

test("durations report p50 and p95, and tolerate both field names", () => {
  // The existing store uses `durationMs`; new records use `duration_ms`. A reader
  // that knows only one silently reports no timings for half the corpus.
  const runs = [];
  for (let i = 1; i <= 20; i++) runs.push(run({ command: "doctor", duration_ms: i * 100 }));
  runs.push(run({ command: "doctor", durationMs: 9999 }));
  const d = usageReport(runs, ["doctor"]).byCommand.doctor;
  assert.equal(d.invocations, 21);
  assert.ok(d.p50 > 0 && d.p95 >= d.p50, `p50=${d.p50} p95=${d.p95}`);
  assert.equal(d.timed, 21, "every record carried a duration under one name or the other");
});

test("a record with no duration is counted as invoked but not timed", () => {
  const d = usageReport([run({ command: "doctor" })], ["doctor"]).byCommand.doctor;
  assert.equal(d.invocations, 1);
  assert.equal(d.timed, 0);
  assert.equal(d.p50, null, "no timings must be null, never 0 — 0 ms is a claim");
});

test("an unknown outcome is surfaced, not silently bucketed as ok", () => {
  const r = usageReport([run({ command: "doctor", outcome: "weird" })], ["doctor"]);
  assert.equal(r.byCommand.doctor.unknownOutcome, 1);
  assert.equal(r.byCommand.doctor.errors, 0);
});

test("NOT INSTRUMENTED is not NEVER INVOKED — the distinction this report was one run from botching", () => {
  // Found by running the report against the live store: it printed "NEVER
  // INVOKED — 31 of 32 commands". Those 31 are not unused; nothing WRITES a
  // record for them yet, because only `reconcile` calls appendRun. Rendering
  // "nobody ran it" and "nothing can record it" the same way is
  // rule:discernment-checks §6 — a reader that cannot report its own blindness
  // invents an answer, and this one would have been read as "31 dead commands".
  const r = usageReport([run({ command: "reconcile" })], ["reconcile", "doctor", "graph"], {
    instrumented: ["reconcile"],
  });
  assert.deepEqual(r.neverInvoked, [], "no command can be called never-invoked while uninstrumented");
  assert.deepEqual(r.notInstrumented.sort(), ["doctor", "graph"]);
  assert.equal(r.instrumentedCoverage, 1 / 3, "the report must state how much of the surface it can see");
});

test("once instrumented, silence becomes a real never-invoked finding", () => {
  const r = usageReport([run({ command: "reconcile" })], ["reconcile", "doctor"], {
    instrumented: ["reconcile", "doctor"],
  });
  assert.deepEqual(r.neverInvoked, ["doctor"], "instrumented and silent IS the finding");
  assert.deepEqual(r.notInstrumented, []);
  assert.equal(r.instrumentedCoverage, 1);
});

test("with no instrumentation list, EVERY command is unknown rather than assumed covered", () => {
  // The safe default. Assuming full coverage is how a report starts lying.
  const r = usageReport([run({ command: "reconcile" })], ["reconcile", "doctor"]);
  assert.deepEqual(r.neverInvoked, [], "unknown coverage cannot yield a never-invoked verdict");
  assert.deepEqual(r.notInstrumented.sort(), ["doctor", "reconcile"]);
  assert.equal(r.instrumentedCoverage, 0);
});
