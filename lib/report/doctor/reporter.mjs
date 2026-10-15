/**
 * reporter.mjs — the one thing doctor's grouped modules share.
 *
 * WHY THIS EXISTS. `doctor()` declared `check`/`warn`/`info` as closures over
 * 17 mutable locals (cli.mjs:1034-1075). Of those 17, exactly ONE is global to
 * the run: `problems`, which decides the exit code. The other sixteen cluster
 * by section — all three `sidecars*` belong to the workspace loop, both
 * `ledger*` to the ledger checks, all five `decisions*` to the DECISIONS
 * section. That is what makes the split viable, and it is why this class owns
 * `problems` and NOTHING else: a shared mutable context would let a module
 * write a counter another module reads, which is the coupling the closures
 * already had.
 *
 * WHY IT COLLECTS INSTEAD OF PRINTING. Measured before writing it: **no module
 * under `lib/` prints anything.** There is not one ANSI escape in the whole
 * tree — `lib/report/metrics.mjs` returns `evaluateExpectations(...)` and
 * `cli.mjs` renders it. Printing here would make this the first exception and
 * put a sixth copy of the colour constants in the codebase.
 *
 * Collecting is also the better test surface. A printing reporter can only be
 * tested by capturing stdout and regexing it; this one is asserted as data.
 *
 * ORDER IS PRESERVED BY THE CALLER, NOT BY BUFFERING EVERYTHING. `entries` is
 * append-only and in call order, so the orchestrator renders each module's
 * entries immediately after that module returns — same sequence, same section
 * headers, byte-identical output. Do not collect every module first and render
 * at the end; that would reorder the run.
 *
 *   module A ──> reporter.check(...)  ──┐
 *                reporter.info(...)     │  entries[] in call order
 *                                       ▼
 *   orchestrator ──> render(A.entries) ──> stdout   (then module B, ...)
 *                    problems accumulates across all modules
 *                                       ▼
 *                          process.exit(problems ? 1 : 0)
 *
 * THE INVARIANT WORTH TESTING. `check(label, false)` increments `problems`;
 * `warn` and `info` MUST NOT. `info` exists precisely because a run-level
 * summary that restates per-entry failures must not vote twice (docs/ISSUES.md
 * A2, GOTCHAS G20) — if it ever incremented, every summarised defect would be
 * counted once by its own check and again by the tally, and doctor's exit code
 * would be wrong in the direction that looks like diligence.
 */

/** The kinds an entry can be. `pass`/`fail` come from `check`; the other two are their own. */
export const ENTRY_KINDS = Object.freeze([
  "pass",
  "fail",
  "inconclusive",
  "warn",
  "info",
  "note",
  "header",
]);

/**
 * The optional `action` an entry may carry (E5, 2026-10-15): what a reader can DO
 * about it, as data, so a surface renders a button without parsing prose.
 *
 *   {kind: "open",    target: "<absolute file path>"}   open the file
 *   {kind: "link",    target: "<doc path>#<anchor>"}    a doc section that explains the fix
 *   {kind: "command", target: "<shell command>"}        something to copy and run
 *
 * It exists because D4's per-row action would otherwise key on label TEXT, and a
 * reworded label then silently loses its action ("no action mapped"). It is
 * attached where the check is built, which is the only place that knows the
 * fix. Absent on every entry that has none: the key is OMITTED, not null, so
 * existing deepEqual assertions on entries and the rendered text are untouched.
 */
export const ACTION_KINDS = Object.freeze(["open", "link", "command"]);

function withAction(entry, action) {
  if (action === undefined || action === null) return entry;
  if (!action || !ACTION_KINDS.includes(action.kind) || typeof action.target !== "string" || !action.target) {
    throw new Error(`doctor entry ${JSON.stringify(entry.label)}: action must be {kind: ${ACTION_KINDS.join("|")}, target: non-empty string}, got ${JSON.stringify(action)}`);
  }
  entry.action = { kind: action.kind, target: action.target };
  return entry;
}

/** Label prefix marking an accepted-exception line; structure.mjs counts it. See Reporter#accepted. */
export const ACCEPTED_PREFIX = "accepted: ";

export class Reporter {
  constructor() {
    /** @type {Array<{kind: string, label: string, detail: string}>} append-only, in call order */
    this.entries = [];
    /** The ONE run-global accumulator. Decides doctor's exit code. */
    this.problems = 0;
  }

  /**
   * A verdict. `ok === false` is the only thing in this file that can fail the run.
   *
   * Returns `ok` so a caller can branch without re-testing the condition —
   * `if (!r.check("x", cond)) return;` reads better than asserting twice, and
   * "assert twice" is how the two sides drift apart.
   *
   * @param {string} label
   * @param {boolean} ok
   * @param {string} [detail]
   * @param {{kind: "open"|"link"|"command", target: string}} [action] see ACTION_KINDS
   * @returns {boolean} `ok`, unchanged
   */
  check(label, ok, detail = "", action) {
    const pass = Boolean(ok);
    this.entries.push(withAction({ kind: pass ? "pass" : "fail", label, detail }, action));
    if (!pass) this.problems++;
    return pass;
  }

  /**
   * Something a reader should see that is NOT a verdict. Never affects the exit
   * code — see the module doc's note on double-voting.
   */
  warn(label, detail = "") {
    this.entries.push({ kind: "warn", label, detail });
  }

  /**
   * A THIRD outcome: the check could not run, so it has no verdict.
   *
   * WHY THIS IS NOT `pass`. `doctor`'s v3 conformance predicate is
   * `offenders.length === 0`, which is **vacuously true over an empty
   * population** — so it printed `✓ 0/0 conform`, a green tick for having
   * examined nothing, indistinguishable from `✓ 22/22 conform` to anyone
   * scanning the report. GOTCHAS G68; N82, raised to S1 on that evidence.
   *
   * WHY THIS IS NOT `fail` EITHER. Nothing is broken when a ledger file is
   * absent or a git remote is unconfigured. Calling it a failure sends someone
   * to fix code that is fine, and `rule:discernment-checks` §2 is explicit that
   * "no result" and "no result BECAUSE —" are different facts.
   *
   * WHY IT VOTES. An unmeasurable run must not exit 0. `GOALS.md` goal 1 names
   * `propagate doctor` as its derivation, so a tree nobody could measure would
   * otherwise satisfy a goal by returning nothing.
   *
   * THE REASON IS MANDATORY, and that is the whole point of the state. An
   * inconclusive with no reason is the silent zero wearing a new costume — it
   * says "I did not look" without saying why, which is exactly the absence it
   * exists to make attributable. Refused loudly rather than defaulted.
   *
   * @param {string} label
   * @param {string} reason why the check could not run
   */
  inconclusive(label, reason, action) {
    if (typeof reason !== "string" || reason.trim() === "") {
      throw new Error(
        `inconclusive(${JSON.stringify(label)}) requires a reason — an unexplained ` +
          "inconclusive is the silent zero it exists to prevent",
      );
    }
    this.entries.push(withAction({ kind: "inconclusive", label, detail: reason }, action));
    this.problems++;
  }

  /**
   * A tally or a restatement of failures already reported above it. Neutral
   * marker on purpose, so it reads as "here is the count", not "here is a new
   * failure". Never affects the exit code.
   */
  info(label, detail = "") {
    this.entries.push({ kind: "info", label, detail });
  }

  /**
   * A failing finding the owner has DELIBERATELY accepted (scripts/execution/health-exceptions.yml).
   * Counted, shown with its reason, NOT a failure: never affects `problems`.
   *
   * It is emitted as an `info` entry whose label starts with ACCEPTED_PREFIX, not as a new kind,
   * because cli.mjs `renderDoctorEntries` renders an unknown kind loudly as `?!` and the doctor
   * snapshot is parsed back from that rendered text (structure.mjs). The prefix is the contract
   * between the two: structure.mjs counts it as `accepted` per section.
   */
  accepted(label, detail = "", action) {
    this.entries.push(withAction({ kind: "info", label: `${ACCEPTED_PREFIX}${label}`, detail }, action));
  }

  /**
   * A dim, MARKER-LESS line — no ✓/✗/!/· prefix. Distinct from `info` because
   * doctor already prints both shapes and the difference is not decorative:
   * `info` is a tally about checks that ran, `note` is context about a check
   * that could not run ("(no DECISIONS.md — tried ...)"). Added when the first
   * extracted module needed it; discovering this from real output is what the
   * pilot module was for.
   *
   * Never affects the exit code.
   */
  note(label) {
    this.entries.push({ kind: "note", label, detail: "" });
  }

  /**
   * A section header (`# State`). Emitted as an ENTRY rather than printed by the
   * caller so that a module owning several consecutive sections keeps them in
   * order with the checks between them — the earlier modules each owned one
   * section, so their caller could print the header; this one owns three.
   *
   * `leadingBlank` is not decoration: doctor's first section has no blank line
   * above it and every later one does. Preserving that is the difference
   * between a byte-identical extraction and a diff.
   *
   * Never affects the exit code.
   */
  header(label, leadingBlank = true) {
    this.entries.push({ kind: "header", label, detail: "", leadingBlank });
  }

  /** Entries of one kind, for tests and for callers that render selectively. */
  entriesOfKind(kind) {
    return this.entries.filter((e) => e.kind === kind);
  }

  /**
   * Hand this module's output to the orchestrator and reset the buffer, so the
   * next module's entries do not re-render the previous module's.
   *
   * `problems` deliberately does NOT reset — it is the run-global tally, and a
   * reporter that forgot its failures on drain would report a clean exit after
   * a failing section. That is the exact silent-zero this refactor exists to
   * avoid, so it is asserted in the unit test.
   *
   * @returns {Array<{kind: string, label: string, detail: string}>}
   */
  drain() {
    const out = this.entries;
    this.entries = [];
    return out;
  }
}
