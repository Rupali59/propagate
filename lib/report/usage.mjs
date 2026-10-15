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

/**
 * Where a run came from. `interactive` is the default (a person at a terminal, or
 * Claude driving one); the rest are set by PROPAGATE_ORIGIN in widget/collect.sh
 * (`widget`), the monitor plist (`monitor`) and .githooks/* (`hook`). `backfill`
 * is written only by `usage --backfill`.
 */
export const ORIGINS = Object.freeze(["interactive", "widget", "monitor", "hook", "backfill"]);
export const DEFAULT_ORIGIN = "interactive";

/** Meta-name for a help request: it is not a use of the command it asks about. */
export const HELP_COMMAND = "help";

/** `ok` / `refused` / `error` from an exit code. 3 is propagate's documented refusal
 *  (cli.mjs: "Refuse (exit 3)"; rollup on a hand-edited file); anything else non-zero,
 *  including an uncaught exception (1), is an error. */
export function outcomeForExit(code) {
  const n = typeof code === "number" ? code : 0;
  if (n === 0) return "ok";
  if (n === 3) return "refused";
  return "error";
}

/**
 * The one record the exit hook writes. PURE: the caller supplies the resolver so
 * this module stays free of the command table's import graph.
 *
 * NEVER argv, never a reason: a verify note is a justification and may name a
 * person or a file. The command NAME is resolved against the registry and an
 * unresolvable one is "unknown", so a typo cannot leak into the store as text.
 *
 * @param {{argv: string[], exitCode: number|undefined, durationMs: number, origin?: string, resolve: Function, isHelp?: boolean, now?: Date}} a
 */
export function buildCommandRecord({ argv, exitCode, durationMs, origin, resolve, isHelp = false, now = new Date() }) {
  let command;
  if (isHelp) command = HELP_COMMAND;
  else if (!argv.length) command = "status"; // cli.mjs: `process.argv[2] || "status"`
  else command = resolve(argv)?.name ?? "unknown";
  return {
    ts: now.toISOString(),
    command,
    outcome: outcomeForExit(exitCode),
    duration_ms: durationMs,
    origin: ORIGINS.includes(origin) ? origin : DEFAULT_ORIGIN,
    kind: "command",
  };
}

/**
 * Tool-call counts from ONE transcript's text: Bash `tool_use` blocks whose command
 * runs `cli.mjs <command>`. Returns one entry per (tool call, distinct command), with
 * the call's id and timestamp -- and NO command text. Only commands the registry
 * resolves are kept, which is what drops `cli.mjs echo` style false matches.
 *
 * @param {string} text a .jsonl transcript
 * @param {Function} resolve resolveCommand
 * @returns {Array<{id: string, ts: string, command: string}>}
 */
export function countCommandCalls(text, resolve) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.includes("cli.mjs")) continue; // cheap prefilter before JSON.parse
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const blocks = Array.isArray(row?.message?.content) ? row.message.content : [];
    for (const b of blocks) {
      if (b?.type !== "tool_use" || b?.name !== "Bash") continue;
      const cmd = b?.input?.command;
      if (typeof cmd !== "string" || typeof b.id !== "string") continue;
      const seen = new Set();
      for (const m of cmd.matchAll(/cli\.mjs((?:\s+[a-z][a-z-]*){1,2})/g)) {
        const hit = resolve(m[1].trim().split(/\s+/));
        if (hit && !seen.has(hit.name)) {
          seen.add(hit.name);
          out.push({ id: `${b.id}:${hit.name}`, ts: typeof row.timestamp === "string" ? row.timestamp : null, command: hit.name });
        }
      }
    }
  }
  return out;
}

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
 * @param {{instrumented?: string[], origin?: string}} [opts] `instrumented`: which
 *   commands can WRITE a record; anything not listed is `notInstrumented`, never
 *   `neverInvoked`. `origin`: keep only records from that origin (default
 *   "interactive"; "all" keeps everything). A record with NO origin predates the
 *   field and is counted as interactive -- and counted in `legacyOrigin`, not hidden.
 * @returns {{byCommand: Record<string, object>, neverInvoked: string[], notInstrumented: string[], instrumentedCoverage: number, legacyAttributed: number, totalRuns: number}}
 */
export function usageReport(runs = [], allCommands = [], opts = {}) {
  const byCommand = {};
  let legacyAttributed = 0;
  let legacyOrigin = 0;
  const wanted = opts.origin ?? DEFAULT_ORIGIN;
  const byOrigin = {};
  const totalBeforeFilter = runs.length;
  runs = runs.filter((r) => {
    const hasOrigin = typeof r?.origin === "string" && r.origin !== "";
    const o = hasOrigin ? r.origin : DEFAULT_ORIGIN;
    if (!hasOrigin) legacyOrigin++;
    byOrigin[o] = (byOrigin[o] ?? 0) + 1;
    return wanted === "all" || o === wanted;
  });

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
      unrecorded: 0,
      timed: 0,
      durations: [],
    });
    b.invocations++;

    const outcome = run?.outcome;
    // `undefined` = a legacy record that never carried the field (read as ok, as
    // before). An explicit `null` is a backfill count: the outcome was never
    // observed, so it is NOT an ok -- it lands in `unrecorded`.
    if (outcome === null) b.unrecorded++;
    else if (outcome === undefined || outcome === "ok") b.ok++;
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
    // Rates are over OBSERVED outcomes: a backfill count carries none, and dividing
    // by it would dilute a real failure rate with runs nobody saw end.
    const observed = b.invocations - b.unrecorded;
    b.failureRate = observed ? b.errors / observed : null;
    b.refusalRate = observed ? b.refusals / observed : null;
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
    legacyOrigin,
    origin: wanted,
    byOrigin,
    totalBeforeFilter,
    totalRuns: runs.length,
  };
}
