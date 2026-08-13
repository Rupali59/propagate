/**
 * The digest's inbound section (2026-08 plan Part 2). Synthetic snapshots
 * only, mirroring tests/digest-disk.test.mjs's fixture shape — never real
 * reconcile()/WORKSPACES. Exercises computeDiff()+formatDigest() directly.
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
    generatedAt: "2026-08-13T09:00:00.000Z",
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
    lastRunAt: "2026-08-12T09:00:00.000Z",
    workspaces,
    cross: { total: snapshot.cross.counts.total, open: snapshot.cross.counts.open, done: snapshot.cross.counts.done, wontfix: snapshot.cross.counts.wontfix, openRows: snapshot.cross.openRows },
    disk: { availKb: snapshot.disk.availKb, usedPct: snapshot.disk.usedPct, caches: {}, projects: {} },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 6. Renders when inbound drift exists.
// ─────────────────────────────────────────────────────────────────────────

test("inbound: renders an INBOUND section listing the drifted cross-repo edge", () => {
  const snapshot = baseSnapshot({
    inbound: {
      available: true,
      byWorkspace: [
        {
          name: "Keerti-portfolio",
          rows: [{ edge_id: "e1", source: "../persona/profile.yaml", downstream: "lib/content.ts", state: "DRIFTED" }],
        },
      ],
    },
  });
  const diff = computeDiff(snapshot, priorFrom(snapshot));
  assert.equal(diff.inboundLines.length, 1);
  assert.match(diff.inboundLines[0], /Keerti-portfolio/);
  assert.match(diff.inboundLines[0], /profile\.yaml/);
  assert.match(diff.inboundLines[0], /content\.ts/);
  assert.match(diff.inboundLines[0], /DRIFTED/);

  const text = formatDigest(diff);
  assert.match(text, /INBOUND \(1\)/);
  assert.match(text, /Keerti-portfolio: \.\.\/persona\/profile\.yaml → lib\/content\.ts   DRIFTED/);
});

test("inbound: a DIVERGED edge also renders; multiple workspaces each get a line", () => {
  const snapshot = baseSnapshot({
    inbound: {
      available: true,
      byWorkspace: [
        { name: "WsA", rows: [{ edge_id: "e1", source: "../up/a.md", downstream: "a.ts", state: "DRIFTED" }] },
        { name: "WsB", rows: [{ edge_id: "e2", source: "../up/b.md", downstream: "b.ts", state: "DIVERGED" }] },
      ],
    },
  });
  const diff = computeDiff(snapshot, priorFrom(snapshot));
  assert.equal(diff.inboundLines.length, 2);
  const text = formatDigest(diff);
  assert.match(text, /INBOUND \(2\)/);
  assert.match(text, /WsA:.*DRIFTED/);
  assert.match(text, /WsB:.*DIVERGED/);
});

test("inbound: an unavailable reconciliation (post-error) reports the vanished-signal line, not silence", () => {
  const snapshot = baseSnapshot({ inbound: { available: false, error: "reconcile threw: boom" } });
  const diff = computeDiff(snapshot, priorFrom(snapshot));
  assert.equal(diff.inboundLines.length, 1);
  assert.match(diff.inboundLines[0], /inbound reconciliation unavailable/);
  assert.match(diff.inboundLines[0], /boom/);
});

// ─────────────────────────────────────────────────────────────────────────
// 7. Renders NOTHING when there is no inbound drift — no section, and a
//    quiet day with nothing else changed collapses to the one-line form.
// ─────────────────────────────────────────────────────────────────────────

test("inbound: no cross-repo drift produces zero inbound lines and no INBOUND heading", () => {
  const snapshot = baseSnapshot({ inbound: { available: true, byWorkspace: [] } });
  const diff = computeDiff(snapshot, priorFrom(snapshot));
  assert.deepEqual(diff.inboundLines, []);

  const text = formatDigest(diff);
  assert.doesNotMatch(text, /INBOUND/);
});

test("inbound: absent from the snapshot entirely (older buildSnapshot, or a synthetic fixture) is treated as no drift, not an error", () => {
  const snapshot = baseSnapshot(); // no `inbound` key at all
  const diff = computeDiff(snapshot, priorFrom(snapshot));
  assert.deepEqual(diff.inboundLines, []);
  assert.doesNotMatch(formatDigest(diff), /INBOUND/);
});

test("inbound: quiet day (no inbound drift, nothing else changed) still collapses to the one-line quiet form", () => {
  const snapshot = baseSnapshot({ inbound: { available: true, byWorkspace: [] } });
  const diff = computeDiff(snapshot, priorFrom(snapshot));
  const text = formatDigest(diff);
  assert.match(text, /^propagate: no change, watcher: alive.*0 open$/);
});

test("inbound: drift present is enough on its own to break the quiet-day collapse", () => {
  const snapshot = baseSnapshot({
    inbound: {
      available: true,
      byWorkspace: [{ name: "WsA", rows: [{ edge_id: "e1", source: "../up/a.md", downstream: "a.ts", state: "DRIFTED" }] }],
    },
  });
  const diff = computeDiff(snapshot, priorFrom(snapshot));
  const text = formatDigest(diff);
  assert.doesNotMatch(text, /^propagate: no change/);
  assert.match(text, /INBOUND \(1\)/);
});
