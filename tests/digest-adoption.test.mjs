/**
 * The digest's ADOPTION section (task brief Component 1). Synthetic
 * snapshots only, mirroring tests/digest-inbound.test.mjs's fixture shape —
 * exercises computeDiff()+formatDigest() directly, never the real
 * docs/SYSTEMS.md.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeDiff, formatDigest } from "../digest.mjs";

function ws(name, { openRows = [], total, malformed = 0 } = {}) {
  const open = openRows.length;
  return {
    name,
    root: `/fake/${name}`,
    ledgerJsonl: `/fake/${name}/ledger.jsonl`,
    counts: { total: total ?? open, open, done: 0, wontfix: 0 },
    malformed,
    quietDays: 0,
    openRows,
  };
}

function baseSnapshot(overrides = {}) {
  return {
    generatedAt: "2026-08-14T09:00:00.000Z",
    degraded: false,
    suspiciousMarkers: [],
    watcher: { heartbeatMs: Date.now(), ageSeconds: 10, state: "alive" },
    workspaces: [ws("Alpha", { openRows: [] })],
    cross: ws("cross", { openRows: [] }),
    duplicateOpenAcrossLedgers: { count: 0, examples: [] },
    plist: { checked: true, mismatched: false },
    disk: { availKb: 79 * 1024 * 1024, usedPct: 83, caches: [], projects: [], truncated: false },
    ...overrides,
  };
}

function priorFrom(snapshot) {
  const workspaces = {};
  for (const w of snapshot.workspaces) {
    workspaces[w.name] = { total: w.counts.total, open: w.counts.open, done: w.counts.done, wontfix: w.counts.wontfix, openRows: w.openRows };
  }
  return {
    version: 1,
    lastRunAt: "2026-08-13T09:00:00.000Z",
    workspaces,
    cross: { total: snapshot.cross.counts.total, open: snapshot.cross.counts.open, done: snapshot.cross.counts.done, wontfix: snapshot.cross.counts.wontfix, openRows: snapshot.cross.openRows },
    disk: { availKb: snapshot.disk.availKb, usedPct: snapshot.disk.usedPct, caches: {}, projects: {} },
  };
}

const SAMPLE_ASK = {
  id: "queue-ui",
  status: "active-unadopted",
  liveness_probe: "curl -s localhost:8790",
  last_verified: "2026-08-10",
  daysUnverified: 4,
  isCircularityExample: false,
  candidateCount: 1,
};

test("adoption: renders exactly one ADOPTION block when there is something to ask", () => {
  const snapshot = baseSnapshot({ adoption: { available: true, ask: SAMPLE_ASK } });
  const diff = computeDiff(snapshot, priorFrom(snapshot));
  assert.equal(diff.adoptionLines.length > 0, true);

  const text = formatDigest(diff);
  assert.match(text, /ADOPTION — one question/);
  assert.match(text, /queue-ui/);
  // Exactly one block heading, never repeated / never a list of asks.
  const headingCount = (text.match(/ADOPTION — one question/g) || []).length;
  assert.equal(headingCount, 1);
});

test("adoption: renders nothing when there is nothing to ask", () => {
  const snapshot = baseSnapshot({ adoption: { available: true, ask: null } });
  const diff = computeDiff(snapshot, priorFrom(snapshot));
  assert.deepEqual(diff.adoptionLines, []);
  assert.doesNotMatch(formatDigest(diff), /ADOPTION/);
});

test("adoption: absent from the snapshot entirely (older buildSnapshot) renders nothing, not an error", () => {
  const snapshot = baseSnapshot(); // no `adoption` key at all
  const diff = computeDiff(snapshot, priorFrom(snapshot));
  assert.deepEqual(diff.adoptionLines, []);
  assert.doesNotMatch(formatDigest(diff), /ADOPTION/);
});

test("adoption: probe failure reports the vanished-signal line, not silence (G2)", () => {
  const snapshot = baseSnapshot({ adoption: { available: false, error: "SYSTEMS.md unreadable: boom" } });
  const diff = computeDiff(snapshot, priorFrom(snapshot));
  assert.equal(diff.adoptionLines.length, 1);
  assert.match(diff.adoptionLines[0], /adoption trigger unavailable/);
  assert.match(diff.adoptionLines[0], /boom/);
});

test("adoption: an open question alone breaks the quiet-day collapse", () => {
  const snapshot = baseSnapshot({ adoption: { available: true, ask: SAMPLE_ASK } });
  const diff = computeDiff(snapshot, priorFrom(snapshot));
  const text = formatDigest(diff);
  assert.doesNotMatch(text, /^propagate: no change/);
});

test("adoption: nothing to ask + nothing else changed still collapses to the one-line quiet form", () => {
  const snapshot = baseSnapshot({ adoption: { available: true, ask: null } });
  const diff = computeDiff(snapshot, priorFrom(snapshot));
  const text = formatDigest(diff);
  assert.match(text, /^propagate: no change, watcher: retired \(v2 reconcile ok\).*0 open$/);
});

test("adoption: never renders a proposed adoption_date value", () => {
  const snapshot = baseSnapshot({ adoption: { available: true, ask: SAMPLE_ASK } });
  const diff = computeDiff(snapshot, priorFrom(snapshot));
  const text = formatDigest(diff);
  assert.doesNotMatch(text, /adoption_date:\s*\d{4}-\d{2}-\d{2}/);
});
