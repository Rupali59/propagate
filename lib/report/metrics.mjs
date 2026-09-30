/**
 * Persist what `doctor` already computes (docs/OBSERVABILITY.md §6 step 1).
 *
 * `doctor` gathers workspaces/sidecars/ledger/decisions/plist/state numbers
 * every run, prints them, and throws them away — so there is nothing to
 * derive here, only to persist, assert, and (via digest.mjs) deliver. This
 * module owns three things:
 *
 *   1. `metrics.jsonl` — one JSON line per `doctor` run, capped (never the
 *      next unbounded artifact — see GOTCHAS G3/the-298-rows-lesson for what
 *      an unbounded, unread store costs).
 *   2. `EXPECTATIONS` — the calibrated assertion table (GOTCHAS G3: "a metric
 *      without an expected range is decoration"). Every entry carries the
 *      concrete observation that motivated it, because GOTCHAS G16 is explicit
 *      that a threshold is a *prediction*, not a target to tune toward.
 *   3. `detectVanishedKeys` — OBSERVABILITY.md R6: a signal that stops being
 *      emitted is the same silent absence one level up from a signal at zero.
 *
 * Respects `PROPAGATE_STATE_DIR` (lib/config.mjs) — never hardcode a path
 * here. Does not touch watcher.mjs, lib/ledger.mjs, or lib/frontmatter.mjs.
 */

import { appendFile, readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { STATE_DIR, SKILL_DIR } from "../core/config.mjs";

/** Same STATE_DIR-or-SKILL_DIR fallback pattern as STATE_PATH/WATCHER_LOG in lib/config.mjs. */
export const METRICS_PATH = STATE_DIR
  ? path.join(STATE_DIR, "metrics.jsonl")
  : path.join(SKILL_DIR, "metrics.jsonl");

/**
 * Bound on retained records. `doctor` runs at most a few times a day by hand
 * — a few thousand lines is years of history, and trimming keeps this file
 * from becoming the next artifact nobody bounds (GOTCHAS G3's whole point:
 * accuracy was never the problem, an ever-growing unread store is).
 */
export const METRICS_CAP = 3000;

/**
 * Calibrated expectations (docs/OBSERVABILITY.md §1, §6 step 1's "start with
 * the ones that need no guessing" list). Each `assert` returns true when the
 * expectation HOLDS. `basis` is mandatory prose naming the concrete incident
 * and date that motivated the number — per GOTCHAS G16, a threshold with no
 * basis is a guess wearing a check's clothes.
 *
 * Deliberately NOT exhaustive against docs/OBSERVABILITY.md §1's full table —
 * only the equality/non-zero checks that need no rate-style guessing.
 * Everything else doctor now records lives in UNCALIBRATED below, explicitly,
 * rather than being silently omitted (which would just be N7's failure mode
 * one level up: an expectation that was never declared reads as "no opinion",
 * indistinguishable from "checked and fine").
 *
 * GOTCHAS G20: this table is the SOLE assertion for each of its subjects.
 * `cli.mjs`'s `doctor()` used to also carry an inline `check()` asserting the
 * identical fact (workspaces.discovered, decisions.with_tokens,
 * ledger.unknown_types, sidecars.rejected) — meaning one real defect printed
 * two `✗` lines. Those inline checks were downgraded to `info()` restatements
 * and the detail they used to carry (exact path/type/count) now flows through
 * each entry's optional `detail(metrics, context)` — see `evaluateExpectations`.
 * `plist.watchpaths` is the one exception: `doctor`'s inline "plist WatchPaths
 * matches discovered workspaces" check does exact-set-equality (missing/extra
 * paths), which genuinely catches failures this count-floor cannot (e.g. a
 * wrong-but-same-sized set) — so that check stayed inline and was NOT
 * duplicated here. One fact, one assertion, either place, never both.
 */
export const EXPECTATIONS = [
  {
    key: "docs.supersedes_unresolvable",
    describe: "docs.supersedes_unresolvable == 0",
    assert: (m) => (m["docs.supersedes_unresolvable"] ?? 0) === 0,
    basis:
      "A declared `supersedes:` naming a path that does not exist is worse than prose — " +
      "it looks machine-checked and is not. 0 today because declarations are new; the " +
      "value of the check is that it stays 0 as they are added. Motivated 2026-08-15 by " +
      "11 of 78 doc links in VipinKaushik being broken, every one the same off-by-one " +
      "(`../../STATE.md` from docs/content/intent/, which needs a third `../`).",
    detail: (m) =>
      (m["docs.supersedes_unresolvable"] ?? 0) === 0
        ? ""
        : `${m["docs.supersedes_unresolvable"]} supersedes: target(s) do not resolve`,
  },
  {
    key: "docs.supersession_prose_only",
    describe: "docs.supersession_prose_only <= 34 (ratchet: must not grow)",
    // A ratchet, not an equality. Failing on all of them would print 105 findings on
    // day one, and noise is a hiding place (G23). Failing only on GROWTH makes the
    // check honest and still able to fail.
    //
    // Lowered 107 -> 105 on 2026-08-18, per this entry's own rule ("lower it when it
    // drops, never raise it"). The drop is a measurement fix, not doc work: the
    // detector counted the archival FILENAME mandated by STATE_MANAGEMENT.md §88-93
    // (`<name>-superseded-<date>.md`), so following the convention — and every doc
    // that correctly linked to an archived file — grew a ratchet declared "must not
    // grow". Archiving 14 plans that day took it 107 -> 108 entirely on filenames.
    // Fixed in lib/doc-kind.mjs stripPaths(); regression test in tests/doc-kind.test.mjs
    // covers both under-stripping and over-stripping.
    // Lowered 105 -> 103 on 2026-08-19, per this entry's own rule. Real doc work, not a
    // measurement fix: five docs whose prose already named a resolvable target gained a
    // `supersedes:` frontmatter declaration, so the superseded doc now learns it was
    // overruled via buildSupersessionIndex instead of the claim being one-way prose.
    // Declared supersessions in the tree went 1 -> 6. The remaining ~103 split into two
    // kinds: claims naming no file at all (the metric's own "75 of 105"), and detector
    // false positives — `README.md`'s "never prune; supersede by appending" convention
    // line, and one plan that literally reads "**Supersedes nothing.**". Do not reword
    // prose to move this number; declare a target or leave it.
    // Lowered 103 -> 101 on 2026-08-19 when the detector stopped counting fenced code
    // blocks. Not doc work and not a measurement fix in the usual sense: the 4 that left
    // were never claims — a TOML comment, a `"superseded": 0` JSON key in daemon-generated
    // output that regenerates every tick, and two more samples. Before the change the
    // metric could not reach zero, because documenting it tripped it.
    // Lowered 101 -> 34 on 2026-09-10. A measurement fix, in the same family as the
    // two above, and the largest because it removes a whole class rather than a few
    // stragglers: the detector now also requires the line to NAME a `.md` target.
    //
    // The trigger was the ratchet going red at 111. It looked like ten documents had
    // rotted. Measured instead: 96 of the 111 already existed at the 2026-08-19
    // baseline, 15 were newly written, and 5 of the original 101 had actually been
    // FIXED. Nothing rotted. The count rose because docs were WRITTEN — which this
    // entry's own note had already predicted twice, once for the archival filename
    // convention and once for widening the scan, without connecting it to the word
    // itself being ordinary English.
    //
    // 77 of the 111 named no target at all: "never prune; supersede by appending"
    // (a convention line), "stuck-claim supersession, superseded-owner silence" (a
    // watcher protocol, not a document), "**Supersedes nothing.**". None of those can
    // gain a `supersedes:` key — there is nothing to put in it — so counting them in a
    // ratchet whose stated remedy is "declare a target" made the number unactionable
    // AND made it grow with authorship. A debt counter that rises when you write is
    // measuring output, not debt.
    //
    // Deliberately still a COUNT, not a rate. A rate was considered and rejected:
    // every one of the remaining 34 is a real, fixable claim, so a count is the
    // correct shape for a debt counter. Converting it to a rate would let absolute
    // debt grow silently as long as the doc tree grew faster.
    assert: (m) => (m["docs.supersession_prose_only"] ?? 0) <= 34,
    basis:
      "Measured 2026-09-10: 34 docs name a `.md` target in prose while declaring no " +
      "`supersedes:` key, so the superseded doc never learns it was overruled. That is " +
      "how DECISIONS.md 2026-06-21 still read as current after PRIVACY-CONTENT.md:250 " +
      "superseded it — and counsel-owned legal copy was rewritten on that basis. Every " +
      "one of the 34 is fixable by declaring the target it already names. The baseline " +
      "is a debt to shrink; lower it when it drops, never raise it.",
    detail: (m) => {
      const n = m["docs.supersession_prose_only"] ?? 0;
      return n <= 34 ? `${n} prose-only (baseline 34)` : `${n} — GREW past the 34 baseline`;
    },
  },
  {
    key: "workspaces.discovered",
    describe: "workspaces.discovered >= 1",
    assert: (m) => typeof m["workspaces.discovered"] === "number" && m["workspaces.discovered"] >= 1,
    basis:
      "N7 (docs/ISSUES.md) — zero discovered workspaces silently read as healthy; every " +
      "per-workspace check below it trivially 'passed' by not running. Observed range on this " +
      "machine has always been >= 1 as of 2026-08-13.",
    // Prefer the shared explanation (config.searchRootsExplain) when the caller
    // passes it: "root does not exist" and "root has no markers" have different
    // fixes, and three call sites describing them three ways is GOTCHAS G20.
    detail: (m, ctx) =>
      (ctx?.searchRootsExplain ||
        `SEARCH_ROOTS=[${(ctx?.searchRoots || []).join(", ")}] — zero workspaces found`) +
      ` — every per-workspace check below silently did not run`,
  },
  {
    key: "decisions.with_tokens",
    describe: "decisions.with_tokens == decisions.entries",
    assert: (m) => m["decisions.with_tokens"] === m["decisions.entries"],
    basis:
      "N12 (docs/ISSUES.md) — 8 live DECISIONS.md entries parsed to 0 Affects tokens for weeks, " +
      "a pre-commit gate passing on an empty set. Equality is the only sound bar: a healthy file " +
      "has every entry attributed, not 'most'.",
    detail: (m, ctx) => {
      const zero = ctx?.decisionsZeroEntries || [];
      const total = m["decisions.entries"];
      return `${ctx?.decisionsPath || "docs/DECISIONS.md"}: ${zero.length} of ${total} ` +
        `entries have zero Affects tokens — ${zero.join("; ") || "(entries unavailable)"}`;
    },
  },
  {
    key: "graph.cycles",
    describe: "graph.cycles == 0",
    assert: (m) => m["graph.cycles"] === 0,
    basis:
      "A mutually-declared pair has no canonical direction, so no fix order exists for it and " +
      "propagation cannot terminate: whichever side you verify first, the other re-arms it. " +
      "Measured 2026-08-17 on the first run of `graph`: 1 cycle, between two SSJK-mb plan specs " +
      "of the same date that each declare the other. The pair is condensed to one node so the " +
      "rest of the graph stays computable — that is a rendering accommodation, not a fix. One " +
      "side still has to be named canonical. Equality, not a ratchet: the honest target is 0 " +
      "and there is exactly one instance to clear.",
    detail: (m, ctx) => {
      if (m["graph.cycles"] === null || m["graph.cycles"] === undefined) {
        return "graph derivation did not run — reconcile failed, see \"reconcile completes\" above";
      }
      const members = ctx?.graphCycleMembers || [];
      return members.length ? members.join(" · ") : "(cycle members unavailable)";
    },
  },
  {
    key: "graph.duplicate_pairs",
    describe: "graph.duplicate_pairs == 0",
    assert: (m) => m["graph.duplicate_pairs"] === 0,
    basis:
      "The same (source, downstream) declared twice produces two edge_ids over one coupling. " +
      "Each is verified separately and each pins the same content pair, so closing one leaves " +
      "the other open forever and the worklist never empties. Found 2026-08-17: 711 edge records " +
      "over 710 distinct pairs — brand-system.md -> components/README.md, declared twice with " +
      "two restatements of the same reason. Never auto-merged: which `why` survives is a human's " +
      "call, and silently dropping one would delete a declared intent.",
    detail: (m, ctx) => {
      if (m["graph.duplicate_pairs"] === null || m["graph.duplicate_pairs"] === undefined) {
        return "graph derivation did not run — reconcile failed, see \"reconcile completes\" above";
      }
      const d = ctx?.graphDuplicateDetails || [];
      return d.length ? d.join(" · ") : "(duplicate pairs unavailable)";
    },
  },
  {
    key: "ledger.unknown_types",
    describe: "ledger.unknown_types == 0",
    assert: (m) => m["ledger.unknown_types"] === 0,
    basis:
      "N1 (docs/ISSUES.md) — a hand-authored 'manual' row type was invisible to readLedger for " +
      "two months; readLedgerWithStats counted it and every caller threw the count away.",
    detail: (m, ctx) => (ctx?.ledgerUnknownTypesDetails || []).join("; "),
  },
  {
    key: "sidecars.rejected",
    describe: "sidecars.rejected == 0",
    assert: (m) => m["sidecars.rejected"] === 0,
    basis:
      "N9 (docs/ISSUES.md) — a schema constraint rejecting a trailing '/' turned one bad path " +
      "into 40 edges across 10 sources inert for ~2 hours (GOTCHAS G9).",
    detail: (m, ctx) => (ctx?.sidecarsRejectedDetails || []).join("; "),
  },
  // ── CALIBRATED 2026-09-30 from 1,092 records (TODOS PR-029) ──────────────
  //
  // Every UNCALIBRATED entry below said the same thing — "needs history to calibrate
  // against" — and each was written when the history was one run. There are now 1,092
  // records spanning 2026-08-13..09-30, so the blocker those reasons named has lifted.
  // G3/G16 still hold: every number here is DERIVED from that history and the
  // derivation is stated, never invented.
  {
    key: "ledger.malformed",
    describe: "ledger.malformed == 0",
    assert: (m) => (m["ledger.malformed"] ?? 0) === 0,
    basis:
      "0 on all 1,092 records since 2026-08-13 — not one malformed ledger line in seven weeks. " +
      "Its former reason was that one clean run is no basis for asserting 0 forever (G16), which " +
      "was true of one run and is not the situation now. readLedger silently skips a malformed " +
      "line, so without this the first one is invisible.",
    detail: (m) =>
      (m["ledger.malformed"] ?? 0) === 0 ? "" : `${m["ledger.malformed"]} malformed ledger line(s)`,
  },
  {
    key: "doctor.duration_ms",
    describe: "doctor.duration_ms < 1800000 (30 min)",
    assert: (m) => (m["doctor.duration_ms"] ?? 0) < 1_800_000,
    // DELIBERATELY NOT THE DESIGN TARGET, and that is the decision rather than a
    // shortcut. docs/OBSERVABILITY.md §1 wants p95 < 5s; measured over 1,092 runs
    // **95.8% exceed 5s**, p50 is 27s and p95 is 115s. An expectation at 5s would be
    // red on essentially every run, and a permanently-red doctor trains people to
    // ignore it — the reasoning already written at doctor/workspaces.mjs:340-343.
    //
    // So this catches PATHOLOGY, not the aspiration. p99 is 367s (6 min); only 4 of
    // 1,092 runs exceed 30 min, 2 exceed an hour, and the worst is 11,272,497 ms —
    // 188 minutes. 30 min sits ~5x above p99 and below every real outlier, so it
    // fires on N91's shape and never on a normal run.
    //
    // The gap between 5s and reality is a FINDING, not something this papers over:
    // it is recorded in N91 and in OBSERVABILITY §1.
    basis:
      "Derived from 1,092 records: p50 27s, p95 115s, p99 367s, max 11,272,497ms (188 min); 4 " +
      "runs over 30 min, 2 over an hour. OBSERVABILITY §1's p95 < 5s is missed by 95.8% of runs, " +
      "so asserting IT would be permanently red and therefore ignored. This asserts the pathology " +
      "instead, and is the first thing in the codebase that can fail on N91.",
    detail: (m) => {
      const v = m["doctor.duration_ms"] ?? 0;
      return v < 1_800_000 ? "" : `doctor took ${(v / 60000).toFixed(1)} min — N91's shape`;
    },
  },
  {
    key: "sidecars.problems",
    describe: "sidecars.problems <= 2 (ratchet: must not grow)",
    assert: (m) => (m["sidecars.problems"] ?? 0) <= 2,
    // A ratchet rather than == 0, copying docs.supersession_prose_only's idiom above
    // for its reason: 45 of 1,092 runs are non-zero, so an equality would fail on a
    // known-and-accepted condition and become noise (G23). Lower it when it drops;
    // never raise it.
    basis:
      "Max 2 across 1,092 records spanning 2026-08-13..2026-09-30, non-zero in 45 of them. " +
      "Its former reason was that no basis " +
      "existed for normal-vs-regression; the basis now says the normal band is 0-2, so a third " +
      "simultaneous problem sidecar is new behaviour and worth a line.",
    detail: (m) =>
      (m["sidecars.problems"] ?? 0) <= 2
        ? ""
        : `${m["sidecars.problems"]} problem sidecars — above the observed max of 2`,
  },
];

/**
 * `plist.watchpaths` is deliberately NOT in EXPECTATIONS. `doctor`'s inline
 * "plist WatchPaths matches discovered workspaces" check (cli.mjs) does exact
 * set-equality against `expectedWatchPaths()` (missing/extra paths named
 * individually) — strictly richer than, and not implied by, a count floor
 * (`plist.watchpaths >= workspaces.discovered` can hold even when the set is
 * wrong, e.g. one stale entry offsetting one missing one). Recorded here only
 * as documentation of the decision (GOTCHAS G20) — the assertion itself lives
 * solely in cli.mjs.
 */

/**
 * Metrics `doctor` now records but does NOT assert on — recorded with an
 * explicit reason rather than omitted. Per GOTCHAS G3/G16: an invented
 * threshold that false-positives is worse than none. These need run-over-run
 * history (rate/trend) or a calibration pass this session did not do.
 */
export const UNCALIBRATED = [
  // FOUR LEFT THIS LIST ON 2026-09-30 (TODOS PR-029) — ledger.malformed,
  // doctor.duration_ms, sidecars.problems and sidecars.loaded now carry expectations
  // derived from 1,092 records. Each of their former reasons said "needs history";
  // the history arrived. The two below are NOT waiting on history, and saying which
  // is the point of keeping this list separate from a TODO.
  {
    key: "rows.open",
    reason:
      "a TREND question, and a per-run gate is the wrong instrument for it. " +
      "docs/OBSERVABILITY.md wants 30-day flat-or-falling — the shape 298 open rows needed and " +
      "never got — which no single record can assert: measured over 1,092 records, rows.open is " +
      "0 at p95 and non-zero in only 50 runs, so any per-run threshold either never fires or " +
      "fires on an ordinary drain. `doctor --since 30d` (PR-028) answers the trend directly, " +
      "which is where this belongs rather than here.",
  },
  {
    key: "sidecars.loaded",
    reason:
      "A FLAT FLOOR WAS TRIED ON 2026-09-30 AND REVERTED THE SAME DAY, which is more useful than " +
      "the original reason. `sidecars.loaded >= 40` was derived from the last 100 runs on this " +
      "machine (47-53) and broke 11 tests immediately: a fixture workspace loads **1** sidecar, so " +
      "the check fired on it — and by the same arithmetic it would fail `doctor` on any real " +
      "install smaller than this one, including a fresh one. That is " +
      "`rule:enforcement-watches-itself` §3 inverted: a threshold derived from one machine's SCALE " +
      "reports a legitimate small install as broken. The failure direction is still downward (N9: " +
      "a rejected sidecar silently loads no edges), so the check worth having is the one this " +
      "entry always named — a PER-WORKSPACE expected count, which is scale-free — and not a global " +
      "number.",
  },
  {
    key: "state.tracked_files",
    reason:
      "IT MEASURES A DELETED FILE, so there is nothing to calibrate. Measured 2026-09-30: 208 " +
      "on every run from 2026-08-13 to 08-19, then **0 on all 831 runs since 08-20, without " +
      "exception**. `STATE_PATH` is `~/.propagate/state.json` — the retired watcher's mtime " +
      "baseline — and that file does not exist. So the gauge has faithfully reported zero for " +
      "six weeks about a subject that was removed, and being exempt from assertion is exactly " +
      "why nothing could say so. `detectVanishedKeys` cannot catch this: the KEY is still " +
      "present, it is the SUBJECT that is gone. N13's wanted >20% run-over-run drop threshold " +
      "is moot for the same reason. The fix is retirement, not a number — tracked as N115.",
  },
];

/**
 * Evaluate EXPECTATIONS against one metrics object. Returns violations only —
 * an empty array means every calibrated expectation held.
 *
 * `context` carries the concrete data an expectation's optional `detail()`
 * needs to name the exact offender (a ledger path, an offending row type, a
 * rejected sidecar's message) — the same detail the inline `check()` calls
 * this table replaced used to print (GOTCHAS G20). Only computed for
 * expectations that actually violate, and only if the entry declares one.
 * @param {Record<string, number>} metrics
 * @param {typeof EXPECTATIONS} [expectations]
 * @param {Record<string, unknown>} [context]
 * @returns {Array<{key: string, describe: string, basis: string, observed: unknown, detail: string}>}
 */
export function evaluateExpectations(metrics, expectations = EXPECTATIONS, context = {}) {
  const violations = [];
  for (const exp of expectations) {
    let ok;
    try {
      ok = exp.assert(metrics);
    } catch {
      ok = false;
    }
    if (!ok) {
      let detail = "";
      try {
        detail = exp.detail ? exp.detail(metrics, context) : "";
      } catch {
        detail = "";
      }
      violations.push({
        key: exp.key,
        describe: exp.describe,
        basis: exp.basis,
        observed: metrics[exp.key],
        detail,
      });
    }
  }
  return violations;
}

/**
 * R6 (docs/OBSERVABILITY.md): a metric key present in the previous record and
 * absent from the current one is a violation distinct from an out-of-range
 * value — a gauge that stops being emitted is the same silent absence one
 * level up from a gauge stuck at zero (GOTCHAS G1/G2 applied to telemetry
 * itself).
 * @param {Record<string, unknown>} currentMetrics
 * @param {Record<string, unknown>|null|undefined} previousMetrics
 * @returns {string[]} keys present before, absent now
 */
export function detectVanishedKeys(currentMetrics, previousMetrics) {
  if (!previousMetrics || typeof previousMetrics !== "object") return [];
  const vanished = [];
  for (const key of Object.keys(previousMetrics)) {
    if (!(key in currentMetrics)) vanished.push(key);
  }
  return vanished;
}

/** Parse metrics.jsonl, skipping unparseable lines (same convention as ledger reads). */
export async function readMetricsRecords(metricsPath = METRICS_PATH) {
  if (!existsSync(metricsPath)) return [];
  const raw = await readFile(metricsPath, "utf8");
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // malformed line — skip, same tolerance as lib/ledger.mjs's readLedger
    }
  }
  return out;
}

/** The most recent record, or null if the file doesn't exist / is empty. */
export async function readLastMetricsRecord(metricsPath = METRICS_PATH) {
  const records = await readMetricsRecords(metricsPath);
  return records.length ? records[records.length - 1] : null;
}

/**
 * Trim metrics.jsonl to the newest `cap` records when it exceeds that count.
 * Atomic write via temp+rename (matches lib/state.mjs / lib/ledger.mjs).
 * @returns {number} records dropped (0 if under cap or file absent)
 */
export async function trimMetricsFile(metricsPath = METRICS_PATH, cap = METRICS_CAP) {
  if (!existsSync(metricsPath)) return 0;
  const raw = await readFile(metricsPath, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length <= cap) return 0;
  const kept = lines.slice(lines.length - cap);
  const tmp = `${metricsPath}.tmp.${process.pid}`;
  await writeFile(tmp, kept.join("\n") + "\n", "utf8");
  await rename(tmp, metricsPath);
  return lines.length - kept.length;
}

/**
 * Append one run record ({ts, run_id, metrics}) and trim to the cap. This is
 * the only writer of metrics.jsonl — `doctor` calls it once per run, after
 * every check() (including the expectation/vanished-key checks this module
 * adds) has already updated the metrics object, so `metrics["doctor.problems"]`
 * reflects the true final count.
 * @param {Record<string, unknown>} metrics
 * @param {{runId?: string, ts?: string, metricsPath?: string, cap?: number}} [opts]
 * @returns {Promise<{ts: string, run_id: string, metrics: Record<string, unknown>}>}
 */
export async function appendMetricsRecord(metrics, opts = {}) {
  const {
    runId = crypto.randomUUID(),
    ts = new Date().toISOString(),
    metricsPath = METRICS_PATH,
    cap = METRICS_CAP,
  } = opts;
  const record = { ts, run_id: runId, metrics };
  await mkdir(path.dirname(metricsPath), { recursive: true });
  if (!existsSync(metricsPath)) await appendFile(metricsPath, "");
  await appendFile(metricsPath, JSON.stringify(record) + "\n", "utf8");
  await trimMetricsFile(metricsPath, cap);
  return record;
}

// ── `doctor --since <t>` (OBSERVABILITY §6 step 4, TODOS PR-028) ────────────
//
// WHY THIS EXISTS. §6 step 1 states its own limitation: *"`doctor` is a manual/
// point-in-time check; nothing in this codebase runs it on a schedule… a metric
// that regresses between `doctor` invocations is invisible until someone runs
// `doctor` again."* §6 names step 4 as the thing that closes it, and describes the
// work honestly: *"a thin CLI layer over data that already exists, not a new
// storage problem."* `readMetricsRecords` above is that data.
//
// IT DOES NOT RUN ANY CHECKS, and the output has to say so. A metrics summary
// printed under the word `doctor` reads as "doctor ran and is happy" — which is the
// N87 failure (green means the checks it ran, over the workspaces it listed) in a
// new place. The renderer leads with the disclaimer for that reason.

/** Accepted relative units for `--since`, smallest first. */
const SINCE_UNITS = Object.freeze({ m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 });

/**
 * Resolve a `--since` spec to an epoch-ms bound.
 *
 * Accepts a relative span (`30m`, `24h`, `7d`, `2w`) or anything `Date` parses
 * (`2026-09-30`, a full ISO timestamp). THROWS on anything else rather than
 * defaulting, because a silently-wide window turns "no records" into "nothing
 * wrong" — the exact collapse `rule:discernment-checks` §2 forbids, and the reason
 * a bad spec must not be tolerated.
 */
export function parseSince(spec, now = Date.now()) {
  if (typeof spec !== "string" || !spec.trim()) {
    throw new Error("--since needs a value: a span like 7d / 24h / 30m / 2w, or a date like 2026-09-30");
  }
  const rel = /^(\d+)([mhdw])$/.exec(spec.trim());
  if (rel) {
    const n = Number(rel[1]);
    if (n === 0) throw new Error(`--since ${spec} is a zero-width window; use 1m or wider`);
    return { at: now - n * SINCE_UNITS[rel[2]], label: `the last ${n}${rel[2]}` };
  }
  // A BARE NUMBER IS THE MOST LIKELY TYPO AND THE MOST DANGEROUS INPUT.
  // `Date.parse` reads 1-3 digits as a YEAR: "7" is 2001-06-30, "0" is 1999,
  // "99" is 1998. So `--since 7` — the unit forgotten — would open a 25-year
  // window and report it as a normal result, which is exactly the silently-wide
  // window this function refuses to produce. Found by the test that loops the bad
  // inputs rather than asserting one. A real 4-digit year still works.
  const bare = /^\d{1,3}$/.exec(spec.trim());
  if (bare) {
    throw new Error(
      `--since ${spec} has no unit. Date.parse reads a bare number as a year ` +
        `(${spec} is ${new Date(Date.parse(spec.trim())).toISOString().slice(0, 10)}), ` +
        `which would be a far wider window than you meant — did you mean ${spec.trim()}d?`,
    );
  }
  const t = Date.parse(spec);
  if (Number.isNaN(t)) {
    throw new Error(
      `--since ${JSON.stringify(spec)} is not a span or a date. ` +
        "Spans are <n>m|h|d|w (30m, 24h, 7d, 2w); dates are anything Date.parse accepts (2026-09-30).",
    );
  }
  if (t > now) throw new Error(`--since ${spec} is in the future; nothing can have been recorded yet`);
  return { at: t, label: `since ${new Date(t).toISOString()}` };
}

/**
 * Summarise every metric's movement across a window of `metrics.jsonl` records.
 *
 * Returns `{ window, runs, records, metrics, reason }`. `reason` is set — and
 * `metrics` empty — when the window holds nothing, so "no records in that window"
 * and "every metric held steady" are DIFFERENT outputs. They are different facts
 * and only one of them is reassuring.
 *
 * `appeared` / `vanished` are reported per key rather than folded into the value
 * diff: `detectVanishedKeys` above exists because a key present last run and absent
 * this one is its own failure, and across a window the same distinction holds — a
 * metric that stopped being recorded is not a metric that went to zero.
 */
export function summariseSince(records, sinceAt, { label = "" } = {}) {
  const inWindow = (records || []).filter((r) => {
    const t = Date.parse(r?.ts ?? "");
    return !Number.isNaN(t) && t >= sinceAt;
  });
  if (inWindow.length === 0) {
    return {
      window: label,
      runs: 0,
      records: (records || []).length,
      metrics: [],
      // ATTRIBUTABLE, never an empty section. Naming the total is what lets a
      // reader tell "doctor has not run in that window" from "metrics.jsonl is
      // empty" — and the second is a broken collector, not a quiet week.
      reason:
        (records || []).length === 0
          ? "metrics.jsonl holds no records at all — the collector has never run, or the store is scoped elsewhere"
          : `no doctor runs in ${label || "that window"} (${(records || []).length} record(s) exist, all older)`,
    };
  }
  const first = inWindow[0];
  const last = inWindow[inWindow.length - 1];
  const keys = new Set();
  for (const r of inWindow) for (const k of Object.keys(r.metrics ?? {})) keys.add(k);

  const metrics = [];
  for (const key of [...keys].sort()) {
    const seen = inWindow.filter((r) => key in (r.metrics ?? {}));
    const nums = seen.map((r) => r.metrics[key]).filter((v) => typeof v === "number");
    metrics.push({
      key,
      runsSeen: seen.length,
      first: first.metrics?.[key],
      last: last.metrics?.[key],
      delta: typeof first.metrics?.[key] === "number" && typeof last.metrics?.[key] === "number"
        ? last.metrics[key] - first.metrics[key]
        : null,
      min: nums.length ? Math.min(...nums) : null,
      max: nums.length ? Math.max(...nums) : null,
      // Present at the start of the window and gone by the end, or the reverse.
      vanished: key in (first.metrics ?? {}) && !(key in (last.metrics ?? {})),
      appeared: !(key in (first.metrics ?? {})) && key in (last.metrics ?? {}),
    });
  }
  return {
    window: label,
    runs: inWindow.length,
    records: (records || []).length,
    from: first.ts,
    to: last.ts,
    metrics,
    reason: null,
  };
}
