/**
 * lib/metrics.mjs — persisting what `doctor` already computes
 * (docs/OBSERVABILITY.md §6 step 1).
 *
 * All file-touching tests use a temp path passed explicitly as
 * `metricsPath` — never the module's default METRICS_PATH, which (like
 * STATE_PATH/WATCHER_LOG in lib/config.mjs) resolves to the real skill dir
 * unless PROPAGATE_STATE_DIR is set. Same discipline as tests/state-gc.test.mjs
 * and tests/config-state-dir.test.mjs; see GOTCHAS G10.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  EXPECTATIONS,
  UNCALIBRATED,
  evaluateExpectations,
  detectVanishedKeys,
  appendMetricsRecord,
  readMetricsRecords,
  readLastMetricsRecord,
  trimMetricsFile,
} from "../lib/metrics.mjs";

const CLI_PATH = fileURLToPath(new URL("../cli.mjs", import.meta.url));

async function tempMetricsPath() {
  const dir = await mkdtemp(path.join(tmpdir(), "metrics-"));
  return path.join(dir, "metrics.jsonl");
}

/** A metrics object that satisfies every calibrated EXPECTATIONS entry. */
function cleanMetrics(overrides = {}) {
  return {
    "workspaces.discovered": 1,
    "sidecars.loaded": 3,
    "sidecars.rejected": 0,
    "sidecars.problems": 0,
    "ledger.unknown_types": 0,
    "ledger.malformed": 0,
    "rows.open": 5,
    "decisions.entries": 2,
    "decisions.with_tokens": 2,
    "plist.watchpaths": 1,
    "state.tracked_files": 10,
    "doctor.duration_ms": 450,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. A run appends exactly one record, with all declared keys present.
// ─────────────────────────────────────────────────────────────────────────────

test("appendMetricsRecord appends exactly one record with ts/run_id/metrics", async () => {
  const metricsPath = await tempMetricsPath();
  const metrics = cleanMetrics();
  const record = await appendMetricsRecord(metrics, { metricsPath });

  assert.ok(record.ts, "record carries a ts");
  assert.ok(record.run_id, "record carries a run_id");
  assert.deepEqual(record.metrics, metrics);

  const raw = await readFile(metricsPath, "utf8");
  const lines = raw.trim().split("\n");
  assert.equal(lines.length, 1, "exactly one JSON line appended");

  const parsed = JSON.parse(lines[0]);
  assert.ok(parsed.ts);
  assert.ok(parsed.run_id);
  for (const key of Object.keys(metrics)) {
    assert.ok(key in parsed.metrics, `declared key ${key} present in the persisted record`);
  }
});

test("appendMetricsRecord called twice appends two distinct records", async () => {
  const metricsPath = await tempMetricsPath();
  await appendMetricsRecord(cleanMetrics({ "rows.open": 1 }), { metricsPath });
  await appendMetricsRecord(cleanMetrics({ "rows.open": 2 }), { metricsPath });

  const records = await readMetricsRecords(metricsPath);
  assert.equal(records.length, 2);
  assert.notEqual(records[0].run_id, records[1].run_id);
  assert.equal(records[1].metrics["rows.open"], 2);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The record lands under PROPAGATE_STATE_DIR when set (via `doctor`).
// ─────────────────────────────────────────────────────────────────────────────

test("doctor writes metrics.jsonl under PROPAGATE_STATE_DIR, not the production skill dir", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "metrics-doctor-root-"));
  const stateDir = await mkdtemp(path.join(tmpdir(), "metrics-doctor-state-"));
  await writeFile(path.join(root, ".propagates.yml"), "workspace: true\nsources: {}\n", "utf8");

  const result = spawnSync(process.execPath, [CLI_PATH, "doctor"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PROPAGATE_SEARCH_ROOTS: root, PROPAGATE_STATE_DIR: stateDir },
  });

  const metricsPath = path.join(stateDir, "metrics.jsonl");
  assert.ok(existsSync(metricsPath), `metrics.jsonl created under PROPAGATE_STATE_DIR (doctor stdout: ${result.stdout})`);

  const records = await readMetricsRecords(metricsPath);
  assert.equal(records.length, 1);
  assert.equal(records[0].metrics["workspaces.discovered"], 1);
  assert.match(result.stdout, /metrics recorded/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Each equality/non-zero expectation fires on a violating fixture and
//    passes on a clean one.
// ─────────────────────────────────────────────────────────────────────────────

test("evaluateExpectations: clean metrics produce zero violations", () => {
  const violations = evaluateExpectations(cleanMetrics());
  assert.deepEqual(violations, []);
});

test("evaluateExpectations: workspaces.discovered < 1 violates N7's expectation", () => {
  const violations = evaluateExpectations(cleanMetrics({ "workspaces.discovered": 0 }));
  const hit = violations.find((v) => v.key === "workspaces.discovered");
  assert.ok(hit, "N7 expectation fires");
  assert.equal(hit.observed, 0);
  assert.match(hit.basis, /N7/);
});

test("evaluateExpectations: decisions.with_tokens != decisions.entries violates N12's expectation", () => {
  const violations = evaluateExpectations(cleanMetrics({ "decisions.entries": 8, "decisions.with_tokens": 0 }));
  const hit = violations.find((v) => v.key === "decisions.with_tokens");
  assert.ok(hit, "N12 expectation fires");
  assert.match(hit.basis, /N12/);
});

test("evaluateExpectations: ledger.unknown_types > 0 violates N1's expectation", () => {
  const violations = evaluateExpectations(cleanMetrics({ "ledger.unknown_types": 3 }));
  const hit = violations.find((v) => v.key === "ledger.unknown_types");
  assert.ok(hit);
  assert.equal(hit.observed, 3);
  assert.match(hit.basis, /N1/);
});

test("evaluateExpectations: sidecars.rejected > 0 violates N9's expectation", () => {
  const violations = evaluateExpectations(cleanMetrics({ "sidecars.rejected": 1 }));
  const hit = violations.find((v) => v.key === "sidecars.rejected");
  assert.ok(hit);
  assert.match(hit.basis, /N9/);
});

// ─────────────────────────────────────────────────────────────────────────────
// GOTCHAS G20: EXPECTATIONS is the sole assertion mechanism for its four
// subjects. This is the unit-level equivalent of "violate all subjects at
// once" — doctor's own architecture makes a true end-to-end all-five-at-once
// fixture impossible (workspaces.discovered == 0 means the per-workspace loop
// that feeds ledger.unknown_types/sidecars.rejected never runs at all), so
// the exhaustive count-violations check is done directly against
// evaluateExpectations() instead. tests/doctor.test.mjs covers the
// end-to-end "one ✗ per defect" shape for each subject individually, plus
// plist.watchpaths staying single-sourced via the inline check.
// ─────────────────────────────────────────────────────────────────────────────

test("evaluateExpectations: a metrics object violating all four EXPECTATIONS at once returns exactly one violation per key", () => {
  const violations = evaluateExpectations(
    cleanMetrics({
      "workspaces.discovered": 0,
      "decisions.entries": 8,
      "decisions.with_tokens": 0,
      "ledger.unknown_types": 3,
      "sidecars.rejected": 2,
    }),
  );
  assert.equal(violations.length, 4, "exactly one violation per EXPECTATIONS entry — no duplicates, none missed");
  const keys = violations.map((v) => v.key).sort();
  assert.deepEqual(keys, [
    "decisions.with_tokens",
    "ledger.unknown_types",
    "sidecars.rejected",
    "workspaces.discovered",
  ]);
});

test("evaluateExpectations: detail() carries the exact-offender context, matching what the retired inline check() used to print", () => {
  const context = {
    searchRoots: ["/tmp/root-a", "/tmp/root-b"],
    decisionsPath: "/tmp/docs/DECISIONS.md",
    decisionsZeroEntries: ["2026-08-02 missing tokens"],
    ledgerUnknownTypesDetails: ['/tmp/ws/docs/PROPAGATION_LEDGER.jsonl: "manual"×1 — unknown to readLedger'],
    sidecarsRejectedDetails: ["ws/.propagates.yml: trailing slash not allowed"],
  };
  const violations = evaluateExpectations(
    cleanMetrics({
      "workspaces.discovered": 0,
      "decisions.entries": 1,
      "decisions.with_tokens": 0,
      "ledger.unknown_types": 1,
      "sidecars.rejected": 1,
    }),
    EXPECTATIONS,
    context,
  );

  const byKey = Object.fromEntries(violations.map((v) => [v.key, v]));
  assert.match(byKey["workspaces.discovered"].detail, /root-a.*root-b/);
  assert.match(byKey["decisions.with_tokens"].detail, /DECISIONS\.md/);
  assert.match(byKey["decisions.with_tokens"].detail, /missing tokens/);
  assert.match(byKey["ledger.unknown_types"].detail, /PROPAGATION_LEDGER\.jsonl/);
  assert.match(byKey["ledger.unknown_types"].detail, /"manual"×1/);
  assert.match(byKey["sidecars.rejected"].detail, /trailing slash not allowed/);
});

test("evaluateExpectations: a missing detail() context degrades to an empty string, never throws", () => {
  const violations = evaluateExpectations(cleanMetrics({ "workspaces.discovered": 0 }));
  const hit = violations.find((v) => v.key === "workspaces.discovered");
  assert.ok(hit);
  assert.equal(typeof hit.detail, "string");
});

// plist.watchpaths is deliberately NOT in EXPECTATIONS (GOTCHAS G20): the
// inline "plist WatchPaths matches discovered workspaces" check in cli.mjs
// does exact set-equality (missing/extra paths), which a count floor
// (`plist.watchpaths >= workspaces.discovered`) cannot replace — a
// wrong-but-same-sized set would pass the floor while failing the real
// check. That check stayed inline and is exercised in tests/doctor.test.mjs,
// not here.

test("EXPECTATIONS table holds only sole-source assertions (no invented extras, no plist.watchpaths)", () => {
  // The list is enumerated rather than counted so that ADDING an expectation is a
  // deliberate edit here, with a reason, instead of a number quietly incrementing.
  //
  // 2026-08-15: +2 doc-structure entries. Both are sole-source (nothing else asserts
  // them), both carry a dated basis, and both have a constructed failing input in
  // tests/doc-expectations.test.mjs — the bar this guard exists to enforce. The
  // prose-only one is a RATCHET (<=107) rather than an equality, because asserting 0
  // would print 107 findings on day one and a wall of expected failures is where a real
  // one hides (G23).
  const keys = EXPECTATIONS.map((e) => e.key).sort();
  assert.deepEqual(keys, [
    "decisions.with_tokens",
    "docs.supersedes_unresolvable",
    "docs.supersession_prose_only",
    "ledger.unknown_types",
    "sidecars.rejected",
    "workspaces.discovered",
  ]);
  for (const exp of EXPECTATIONS) {
    assert.ok(exp.basis && exp.basis.length > 20, `${exp.key} carries a real basis, not a placeholder`);
    assert.ok(exp.describe, `${exp.key} carries a human-readable description`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. A metric key present in the previous record and absent now is reported
//    as a violation, distinct from an out-of-range value (R6).
// ─────────────────────────────────────────────────────────────────────────────

test("detectVanishedKeys: a key present before and missing now is reported", () => {
  const previous = { "rows.open": 5, "sidecars.loaded": 3 };
  const current = { "rows.open": 5 };
  const vanished = detectVanishedKeys(current, previous);
  assert.deepEqual(vanished, ["sidecars.loaded"]);
});

test("detectVanishedKeys: identical key sets report nothing vanished", () => {
  const previous = { "rows.open": 5, "sidecars.loaded": 3 };
  const current = { "rows.open": 6, "sidecars.loaded": 3 };
  assert.deepEqual(detectVanishedKeys(current, previous), []);
});

test("detectVanishedKeys: no previous record (first run) reports nothing vanished, not a false alarm", () => {
  assert.deepEqual(detectVanishedKeys({ "rows.open": 5 }, null), []);
  assert.deepEqual(detectVanishedKeys({ "rows.open": 5 }, undefined), []);
});

test("doctor reports a vanished metric distinctly from an out-of-range value", async () => {
  const metricsPath = await tempMetricsPath();
  // Seed a previous record with a key the current run will not emit.
  await appendMetricsRecord({ ...cleanMetrics(), "a.metric.that.will.vanish": 42 }, { metricsPath });

  const previous = await readLastMetricsRecord(metricsPath);
  const current = cleanMetrics(); // does not carry "a.metric.that.will.vanish"
  const vanished = detectVanishedKeys(current, previous.metrics);
  assert.deepEqual(vanished, ["a.metric.that.will.vanish"]);

  // And it must not ALSO surface as an expectation violation — those are two
  // different checks reporting two different facts.
  const violations = evaluateExpectations(current);
  assert.deepEqual(violations, [], "an unrelated vanished custom metric does not trip the calibrated table");
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. An `uncalibrated` expectation records the metric and does NOT produce a
//    false alert.
// ─────────────────────────────────────────────────────────────────────────────

test("UNCALIBRATED metrics are recorded (declared) but never asserted", () => {
  assert.ok(UNCALIBRATED.length > 0, "at least one metric is explicitly deferred");
  const calibratedKeys = new Set(EXPECTATIONS.map((e) => e.key));
  for (const u of UNCALIBRATED) {
    assert.ok(!calibratedKeys.has(u.key), `${u.key} must not appear in both EXPECTATIONS and UNCALIBRATED`);
    assert.ok(u.reason && u.reason.length > 10, `${u.key} carries a real reason, not a placeholder`);
  }
});

test("an extreme value on an uncalibrated metric produces zero violations (no invented threshold)", () => {
  // rows.open is uncalibrated — an enormous value must not fire anything,
  // because no basis for a threshold exists yet (G3/G16: an invented
  // threshold that false-positives is worse than none).
  const violations = evaluateExpectations(cleanMetrics({ "rows.open": 999999, "doctor.duration_ms": 999999 }));
  assert.deepEqual(violations, []);
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. The file is trimmed at the cap and keeps the newest records.
// ─────────────────────────────────────────────────────────────────────────────

test("trimMetricsFile keeps only the newest `cap` records, dropping the oldest", async () => {
  const metricsPath = await tempMetricsPath();
  const cap = 5;
  for (let i = 0; i < 8; i++) {
    await appendMetricsRecord(cleanMetrics({ "rows.open": i }), { metricsPath, runId: `run-${i}`, cap });
  }
  const records = await readMetricsRecords(metricsPath);
  assert.equal(records.length, cap, "trimmed to the cap after each append");
  const openValues = records.map((r) => r.metrics["rows.open"]);
  assert.deepEqual(openValues, [3, 4, 5, 6, 7], "kept the newest records, dropped the oldest");
});

test("trimMetricsFile is a no-op under the cap", async () => {
  const metricsPath = await tempMetricsPath();
  await appendMetricsRecord(cleanMetrics(), { metricsPath, cap: 100 });
  await appendMetricsRecord(cleanMetrics(), { metricsPath, cap: 100 });
  const dropped = await trimMetricsFile(metricsPath, 100);
  assert.equal(dropped, 0);
  const records = await readMetricsRecords(metricsPath);
  assert.equal(records.length, 2);
});

test("trimMetricsFile on a nonexistent file is a no-op, never throws", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "metrics-notrim-"));
  const dropped = await trimMetricsFile(path.join(dir, "does-not-exist.jsonl"), 10);
  assert.equal(dropped, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// readMetricsRecords tolerance
// ─────────────────────────────────────────────────────────────────────────────

test("readMetricsRecords skips malformed lines rather than throwing (same tolerance as ledger reads)", async () => {
  const metricsPath = await tempMetricsPath();
  await writeFile(
    metricsPath,
    [JSON.stringify({ ts: "t", run_id: "a", metrics: cleanMetrics() }), "{not valid json", ""].join("\n"),
    "utf8",
  );
  const records = await readMetricsRecords(metricsPath);
  assert.equal(records.length, 1);
});

test("readMetricsRecords on a nonexistent file returns an empty array, not a throw", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "metrics-noexist-"));
  const records = await readMetricsRecords(path.join(dir, "nope.jsonl"));
  assert.deepEqual(records, []);
});
