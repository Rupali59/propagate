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
    describe: "docs.supersession_prose_only <= 101 (ratchet: must not grow)",
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
    assert: (m) => (m["docs.supersession_prose_only"] ?? 0) <= 101,
    basis:
      "Measured 2026-08-19: 101 docs say `supersede` in prose with no `supersedes:` " +
      "declaration, so the superseded doc never learns it was overruled. That is how " +
      "DECISIONS.md 2026-06-21 still read as current after PRIVACY-CONTENT.md:250 " +
      "superseded it — and counsel-owned legal copy was rewritten on that basis. The " +
      "baseline is a debt to shrink; lower it when it drops, never raise it.",
    detail: (m) => {
      const n = m["docs.supersession_prose_only"] ?? 0;
      return n <= 101 ? `${n} prose-only (baseline 101)` : `${n} — GREW past the 101 baseline`;
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
  {
    key: "rows.open",
    reason:
      "docs/OBSERVABILITY.md wants a 30-day trend (flat-or-falling), the exact shape 298 open " +
      "rows needed and never got. One run has no trend to compare against yet.",
  },
  {
    key: "doctor.duration_ms",
    reason:
      "target is p95 < 5s (docs/OBSERVABILITY.md §1); doctor just went from ~19s to ~0.45s warm " +
      "(GOTCHAS G5/G7) and a single post-fix data point is not a distribution.",
  },
  {
    key: "sidecars.loaded",
    reason: "gauge, not yet compared against a per-workspace expected count.",
  },
  {
    key: "sidecars.problems",
    reason: "rate-style — no basis yet for what count is normal vs. a regression.",
  },
  {
    key: "ledger.malformed",
    reason:
      "zero on every ledger observed so far, but one clean run is not a basis for asserting 0 " +
      "forever (G16) the way N1/N9's incident histories are.",
  },
  {
    key: "state.tracked_files",
    reason:
      "N13 (docs/ISSUES.md) wants a >20% run-over-run drop threshold; needs history to calibrate " +
      "against, same shape as rows.open.",
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
