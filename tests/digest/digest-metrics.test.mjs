/**
 * digest.mjs's METRICS section (docs/OBSERVABILITY.md §6 step 4): delivery
 * over what `doctor` already persisted to metrics.jsonl (lib/metrics.mjs),
 * not a second computation. Follows tests/digest.test.mjs's fixture-builder
 * pattern — synthetic snapshots/prior states only, never a real ledger or a
 * real metrics.jsonl.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeDiff, formatDigest } from "../../digest.mjs";

function ws(name, { openRows = [] } = {}) {
  return {
    name,
    root: `/fake/${name}`,
    ledgerJsonl: `/fake/${name}/ledger.jsonl`,
    counts: { total: openRows.length, open: openRows.length, done: 0, wontfix: 0 },
    malformed: 0,
    quietDays: 0,
    openRows,
  };
}

function baseSnapshot(overrides = {}) {
  return {
    generatedAt: "2026-08-13T09:00:00.000Z",
    degraded: false,
    suspiciousMarkers: [],
    watcher: { heartbeatMs: Date.now(), ageSeconds: 10, state: "alive" },
    workspaces: [ws("Alpha")],
    cross: ws("cross"),
    duplicateOpenAcrossLedgers: { count: 0, examples: [] },
    plist: { checked: true, mismatched: false },
    ...overrides,
  };
}

const CLEAN_METRICS = {
  "workspaces.discovered": 1,
  "sidecars.loaded": 3,
  "sidecars.rejected": 0,
  "ledger.unknown_types": 0,
  "decisions.entries": 2,
  "decisions.with_tokens": 2,
  "plist.watchpaths": 1,
  "rows.open": 5,
  "doctor.duration_ms": 450,
};

// ─────────────────────────────────────────────────────────────────────────────
// Violations render into BROKEN.
// ─────────────────────────────────────────────────────────────────────────────

test("computeDiff: a metrics violation from the latest doctor run is reported as broken", () => {
  const snapshot = baseSnapshot({
    metrics: {
      available: true,
      latest: { run_id: "run-1", ts: "2026-08-13T09:00:00.000Z", metrics: { ...CLEAN_METRICS, "sidecars.rejected": 2 } },
      violations: [
        {
          key: "sidecars.rejected",
          describe: "sidecars.rejected == 0",
          basis: "N9 — a schema rejection silently killed 40 edges.",
          observed: 2,
        },
      ],
    },
  });
  const diff = computeDiff(snapshot, null);
  const hit = diff.broken.find((b) => b.kind === "metricExpectation");
  assert.ok(hit, "violation surfaces in diff.broken");
  assert.match(hit.detail, /sidecars\.rejected/);
});

test("computeDiff: zero violations from the latest doctor run add nothing to broken", () => {
  const snapshot = baseSnapshot({
    metrics: { available: true, latest: { run_id: "run-1", ts: "t", metrics: CLEAN_METRICS }, violations: [] },
  });
  const diff = computeDiff(snapshot, null);
  assert.equal(diff.broken.filter((b) => b.kind === "metricExpectation").length, 0);
});

test("computeDiff: no metrics recorded yet (doctor never run) is tolerated, not a crash or a false broken", () => {
  const snapshot = baseSnapshot({ metrics: { available: false, error: "no doctor runs recorded yet" } });
  const diff = computeDiff(snapshot, null);
  assert.equal(diff.broken.filter((b) => b.kind === "metricExpectation").length, 0);
});

test("computeDiff: missing metrics key entirely on the snapshot (older shape) does not throw", () => {
  const snapshot = baseSnapshot(); // no `metrics` key at all
  assert.doesNotThrow(() => computeDiff(snapshot, null));
});

// ─────────────────────────────────────────────────────────────────────────────
// Material change reporting (metricLines) — diff-only, like disk/skills.
// ─────────────────────────────────────────────────────────────────────────────

test("computeDiff: a changed metric value since the prior digest is reported in metricLines", () => {
  const snapshot = baseSnapshot({
    metrics: {
      available: true,
      latest: { run_id: "run-2", ts: "t2", metrics: { ...CLEAN_METRICS, "rows.open": 9 } },
      violations: [],
    },
  });
  const prior = {
    version: 1,
    lastRunAt: "2026-08-12T09:00:00.000Z",
    workspaces: { Alpha: { total: 0, open: 0, done: 0, wontfix: 0, openRows: [] } },
    cross: { total: 0, open: 0, done: 0, wontfix: 0, openRows: [] },
    metrics: { runId: "run-1", ts: "t1", values: { ...CLEAN_METRICS, "rows.open": 5 } },
  };
  const diff = computeDiff(snapshot, prior);
  assert.ok(diff.metricLines.some((l) => l.includes("rows.open") && l.includes("5 -> 9")));
});

test("computeDiff: same run_id as last digest (no new doctor run) produces zero metricLines", () => {
  const snapshot = baseSnapshot({
    metrics: { available: true, latest: { run_id: "run-1", ts: "t1", metrics: CLEAN_METRICS }, violations: [] },
  });
  const prior = {
    version: 1,
    lastRunAt: "2026-08-12T09:00:00.000Z",
    workspaces: { Alpha: { total: 0, open: 0, done: 0, wontfix: 0, openRows: [] } },
    cross: { total: 0, open: 0, done: 0, wontfix: 0, openRows: [] },
    metrics: { runId: "run-1", ts: "t1", values: CLEAN_METRICS },
  };
  const diff = computeDiff(snapshot, prior);
  assert.deepEqual(diff.metricLines, []);
});

test("computeDiff: identical values across a new run_id produce zero metricLines (nothing changed)", () => {
  const snapshot = baseSnapshot({
    metrics: { available: true, latest: { run_id: "run-2", ts: "t2", metrics: CLEAN_METRICS }, violations: [] },
  });
  const prior = {
    version: 1,
    lastRunAt: "2026-08-12T09:00:00.000Z",
    workspaces: { Alpha: { total: 0, open: 0, done: 0, wontfix: 0, openRows: [] } },
    cross: { total: 0, open: 0, done: 0, wontfix: 0, openRows: [] },
    metrics: { runId: "run-1", ts: "t1", values: CLEAN_METRICS },
  };
  const diff = computeDiff(snapshot, prior);
  assert.deepEqual(diff.metricLines, []);
});

// ─────────────────────────────────────────────────────────────────────────────
// formatDigest: renders the METRICS section on violations/changes, renders
// nothing extra when there are none.
// ─────────────────────────────────────────────────────────────────────────────

test("formatDigest: renders nothing extra when there are no violations and no metric changes", () => {
  const snapshot = baseSnapshot({
    metrics: { available: true, latest: { run_id: "run-1", ts: "t1", metrics: CLEAN_METRICS }, violations: [] },
  });
  const prior = {
    version: 1,
    lastRunAt: "2026-08-12T09:00:00.000Z",
    workspaces: { Alpha: { total: 0, open: 0, done: 0, wontfix: 0, openRows: [] } },
    cross: { total: 0, open: 0, done: 0, wontfix: 0, openRows: [] },
    metrics: { runId: "run-1", ts: "t1", values: CLEAN_METRICS },
  };
  const diff = computeDiff(snapshot, prior);
  const text = formatDigest(diff);
  assert.doesNotMatch(text, /METRICS \(doctor\)/);
  assert.match(text, /no change/, "falls through to the quiet-day one-liner");
});

test("formatDigest: a metrics violation appears under BROKEN, ahead of NEW/CLOSED", () => {
  const snapshot = baseSnapshot({
    metrics: {
      available: true,
      latest: { run_id: "run-1", ts: "t1", metrics: { ...CLEAN_METRICS, "ledger.unknown_types": 1 } },
      violations: [
        { key: "ledger.unknown_types", describe: "ledger.unknown_types == 0", basis: "N1 — a manual row invisible for months.", observed: 1 },
      ],
    },
  });
  const diff = computeDiff(snapshot, null);
  const text = formatDigest(diff);
  assert.match(text, /BROKEN/);
  assert.match(text, /ledger\.unknown_types/);
  const brokenIdx = text.indexOf("BROKEN");
  const newIdx = text.indexOf("NEW DRIFT");
  assert.ok(brokenIdx !== -1 && (newIdx === -1 || brokenIdx < newIdx));
});

test("formatDigest: a material metric change renders under METRICS (doctor):", () => {
  const snapshot = baseSnapshot({
    metrics: {
      available: true,
      latest: { run_id: "run-2", ts: "t2", metrics: { ...CLEAN_METRICS, "sidecars.loaded": 7 } },
      violations: [],
    },
  });
  const prior = {
    version: 1,
    lastRunAt: "2026-08-12T09:00:00.000Z",
    workspaces: { Alpha: { total: 0, open: 0, done: 0, wontfix: 0, openRows: [] } },
    cross: { total: 0, open: 0, done: 0, wontfix: 0, openRows: [] },
    metrics: { runId: "run-1", ts: "t1", values: CLEAN_METRICS },
  };
  const diff = computeDiff(snapshot, prior);
  const text = formatDigest(diff);
  assert.match(text, /METRICS \(doctor\):/);
  assert.match(text, /sidecars\.loaded: 3 -> 7/);
});
