/**
 * usage.mjs — which commands are used, and how often they fail.
 *
 * WHY THIS EXISTS. The run store was already live and recording the wrong things:
 * 330 records in `~/.propagate/runs`, every one shaped
 * `durationMs, edge_counts, refs, roots, run_id, ts`, written by a SINGLE
 * `appendRun` inside `reconcile`. So 1 of 32 commands was instrumented, it did not
 * record its own name, and nothing anywhere recorded a failure.
 *
 * `docs/SYSTEMS.md` carries the status `installed-never-invoked` and a human
 * assigns it by guessing. `rule:enforcement-watches-itself` says why that matters:
 * "A capability nobody invokes is indistinguishable from one that was never built,
 * and its tests pass either way." Its recorded instances include an update checker
 * written, verified across five behaviours, and invoked by nothing.
 *
 * PURE. Takes records and a command list, returns a report. No I/O, so the
 * aggregation is testable without a store — and the store's own reader stays the
 * one place that knows where records live.
 */

/** Outcomes a record may carry. Anything else is surfaced, never bucketed. */
export const OUTCOMES = Object.freeze(["ok", "refused", "error"]);

/**
 * The command the 330 pre-field records came from.
 *
 * Attributed EXPLICITLY, and counted, rather than inferred silently: the whole
 * corpus predates the `command` field, and a reader that quietly filled it in
 * would make the history look as though it always had one.
 */
export const LEGACY_COMMAND = "reconcile";

/** A duration in ms, under either field name, or null. */
function durationOf(run) {
  // The existing store writes `durationMs`; new records write `duration_ms`. A
  // reader that knows only one reports no timings for half the corpus and calls
  // that a measurement.
  for (const k of ["duration_ms", "durationMs"]) {
    const v = run?.[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

/** Nearest-rank percentile over a sorted array; null when there is nothing. */
function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, i)];
}

/**
 * @param {Array<object>} runs records from `readRuns`
 * @param {string[]} allCommands every command the CLI dispatches — the DENOMINATOR.
 *   Without it "never invoked" is unknowable: a command absent from the store and a
 *   command that does not exist look identical.
 * @param {{instrumented?: string[]}} [opts] which commands can WRITE a record.
 *   Anything not listed is `notInstrumented`, never `neverInvoked`.
 * @returns {{byCommand: Record<string, object>, neverInvoked: string[], notInstrumented: string[], instrumentedCoverage: number, legacyAttributed: number, totalRuns: number}}
 */
export function usageReport(runs = [], allCommands = [], opts = {}) {
  const byCommand = {};
  let legacyAttributed = 0;

  for (const run of runs) {
    let cmd = run?.command;
    if (typeof cmd !== "string" || cmd === "") {
      cmd = LEGACY_COMMAND;
      legacyAttributed++;
    }
    const b = (byCommand[cmd] ??= {
      invocations: 0,
      ok: 0,
      errors: 0,
      refusals: 0,
      unknownOutcome: 0,
      timed: 0,
      durations: [],
    });
    b.invocations++;

    const outcome = run?.outcome;
    if (outcome === undefined || outcome === null || outcome === "ok") b.ok++;
    else if (outcome === "error") b.errors++;
    else if (outcome === "refused") b.refusals++;
    else b.unknownOutcome++; // a value the writer can emit that this reader has no rule for

    const d = durationOf(run);
    if (d !== null) {
      b.timed++;
      b.durations.push(d);
    }
  }

  for (const b of Object.values(byCommand)) {
    const sorted = b.durations.sort((x, y) => x - y);
    // null, never 0. "0 ms" is a claim about speed; "no timings" is the absence of
    // one, and rendering them alike is the silent-zero this repo keeps paying for.
    b.p50 = percentile(sorted, 50);
    b.p95 = percentile(sorted, 95);
    b.failureRate = b.invocations ? b.errors / b.invocations : null;
    b.refusalRate = b.invocations ? b.refusals / b.invocations : null;
    delete b.durations;
  }

  // A command with no records gets NO entry and NO rate. Giving it `failureRate: 0`
  // would read as "runs fine" when the truth is "nobody has ever run it" —
  // rule:discernment-checks §2, and the exact distinction `SYSTEMS.md`'s
  // `installed-never-invoked` status exists to make.
  //
  // BUT SILENCE HAS TWO CAUSES AND ONLY ONE IS A FINDING. A command with no
  // records may never have been RUN, or may not be INSTRUMENTED — nothing writes a
  // record for it. Caught 2026-09-24 by running this against the live store, where
  // it printed "NEVER INVOKED — 31 of 32 commands": all 31 were uninstrumented,
  // because only `reconcile` called appendRun. Read as a verdict that would have
  // been 31 dead commands. rule:discernment-checks §6 — a reader that cannot report
  // its own blindness invents an answer.
  //
  // Absent an `instrumented` list the SAFE default is that nothing is covered:
  // assuming full coverage is how a report starts lying.
  const instrumented = new Set(opts.instrumented ?? []);
  const notInstrumented = allCommands.filter((c) => !instrumented.has(c));
  const neverInvoked = allCommands.filter((c) => instrumented.has(c) && !byCommand[c]);
  const instrumentedCoverage = allCommands.length
    ? allCommands.filter((c) => instrumented.has(c)).length / allCommands.length
    : 0;

  return {
    byCommand,
    neverInvoked,
    notInstrumented,
    instrumentedCoverage,
    legacyAttributed,
    totalRuns: runs.length,
  };
}
