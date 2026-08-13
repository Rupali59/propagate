/**
 * The digest's DRIFT section — the daily-digest replacement for the retired
 * 60s launchd watcher (the only writer of v1 ledger drift rows). Sourced
 * from reconcile(), reporting DRIFTED/DIVERGED edges the INBOUND section
 * does not already cover.
 *
 * The partition rule (G20 — a digest must never report one edge in two
 * sections):
 *
 *   - DRIFT.sameRepo        — rows where sameRepo === true.
 *   - INBOUND (existing)    — cross-repo rows whose downstream IS under a
 *                             known WORKSPACES root.
 *   - DRIFT.outboundUnknown — cross-repo rows whose downstream is NOT under
 *                             any known workspace (the gap that must not
 *                             vanish silently, G2).
 *
 * Two halves here: (1) computeDiff()/formatDigest() rendering, synthetic
 * snapshot fixtures only — mirrors tests/digest-inbound.test.mjs's shape.
 * (2) the partition itself, exercised directly against
 * inboundSnapshotForTest()/driftSnapshotForTest() with a representative
 * fabricated reconcile() row set — this is the assertion the task exists
 * for: every DRIFTED/DIVERGED row lands in exactly one section, and the
 * section counts sum to the total.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeDiff, formatDigest, inboundSnapshotForTest, driftSnapshotForTest } from "../digest.mjs";

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
// 1. Rendering — computeDiff()/formatDigest() over a fabricated snapshot.
// ─────────────────────────────────────────────────────────────────────────

test("drift: renders a DRIFT section for a same-repo edge", () => {
  const snapshot = baseSnapshot({
    drift: {
      available: true,
      total: 1,
      sameRepo: [{ edge_id: "e1", source: "Alpha:lib/pricing.ts", downstream: "Alpha:app/page.tsx", state: "DRIFTED" }],
      outboundUnknown: [],
    },
  });
  const diff = computeDiff(snapshot, priorFrom(snapshot));
  assert.equal(diff.driftLines.length, 1);
  assert.match(diff.driftLines[0], /lib\/pricing\.ts/);
  assert.match(diff.driftLines[0], /app\/page\.tsx/);
  assert.match(diff.driftLines[0], /DRIFTED/);

  const text = formatDigest(diff);
  assert.match(text, /DRIFT \(1\)/);
});

test("drift: an outbound-unknown edge renders with its distinct label", () => {
  const snapshot = baseSnapshot({
    drift: {
      available: true,
      total: 1,
      sameRepo: [],
      outboundUnknown: [{ edge_id: "e2", source: "Alpha:persona/profile.yaml", downstream: "/fake/Unmapped/lib/x.ts", state: "DIVERGED" }],
    },
  });
  const diff = computeDiff(snapshot, priorFrom(snapshot));
  assert.equal(diff.driftLines.length, 1);
  assert.match(diff.driftLines[0], /outbound — downstream outside any known workspace/);
  assert.match(diff.driftLines[0], /DIVERGED/);

  const text = formatDigest(diff);
  assert.match(text, /DRIFT \(1\)/);
});

test("drift: reconcile failure reports 'unavailable', never silence or a false 'no drift'", () => {
  const snapshot = baseSnapshot({ drift: { available: false, error: "reconcile threw: boom" } });
  const diff = computeDiff(snapshot, priorFrom(snapshot));
  assert.equal(diff.driftLines.length, 1);
  assert.match(diff.driftLines[0], /drift reconciliation unavailable/);
  assert.match(diff.driftLines[0], /boom/);
});

test("drift: no drift produces zero lines, no DRIFT heading, and still collapses to the quiet-day form", () => {
  const snapshot = baseSnapshot({ drift: { available: true, total: 0, sameRepo: [], outboundUnknown: [] } });
  const diff = computeDiff(snapshot, priorFrom(snapshot));
  assert.deepEqual(diff.driftLines, []);

  const text = formatDigest(diff);
  assert.doesNotMatch(text, /DRIFT/);
  assert.match(text, /^propagate: no change, watcher: alive.*0 open$/);
});

test("drift: absent from the snapshot entirely (older buildSnapshot) is treated as no drift, not an error", () => {
  const snapshot = baseSnapshot(); // no `drift` key at all
  const diff = computeDiff(snapshot, priorFrom(snapshot));
  assert.deepEqual(diff.driftLines, []);
  assert.doesNotMatch(formatDigest(diff), /DRIFT/);
});

test("drift: drift present alone breaks the quiet-day collapse", () => {
  const snapshot = baseSnapshot({
    drift: {
      available: true,
      total: 1,
      sameRepo: [{ edge_id: "e1", source: "Alpha:a.md", downstream: "Alpha:a.ts", state: "DRIFTED" }],
      outboundUnknown: [],
    },
  });
  const diff = computeDiff(snapshot, priorFrom(snapshot));
  const text = formatDigest(diff);
  assert.doesNotMatch(text, /^propagate: no change/);
  assert.match(text, /DRIFT \(1\)/);
});

// ─────────────────────────────────────────────────────────────────────────
// 2. The partition itself — driftSnapshotForTest()/inboundSnapshotForTest()
//    against a shared, representative reconcile()-shaped row set. This is
//    the assertion the task exists for.
// ─────────────────────────────────────────────────────────────────────────

/** Minimal reconcile()-shaped row — only the fields inbound/drift read. */
function row(edgeId, nodeId, sourcePath, downstreamPath, { state = "DRIFTED", sameRepo } = {}) {
  return {
    node_id: nodeId,
    edge_id: edgeId,
    source: { path: sourcePath, ref: null, contentId: "s", unresolvable: null },
    downstream: { path: downstreamPath, ref: null, contentId: "d", unresolvable: null },
    state,
    since: null,
    last: null,
    deferred: null,
    glob: null,
    sameRepo,
    unresolvable: null,
  };
}

const FAKE_WORKSPACES = [
  { name: "Alpha", root: "/fake/Alpha" },
  { name: "Beta", root: "/fake/Beta" },
];

test("partition: every DRIFTED/DIVERGED row lands in exactly one section, and counts are exhaustive", () => {
  const rows = [
    // same-repo drift — belongs in DRIFT.sameRepo
    row("e-samerepo-1", "Alpha:lib/pricing.ts", "/fake/Alpha/lib/pricing.ts", "/fake/Alpha/app/page.tsx", {
      state: "DRIFTED",
      sameRepo: true,
    }),
    row("e-samerepo-2", "Beta:SPEC.md", "/fake/Beta/SPEC.md", "/fake/Beta/engine.ts", {
      state: "DIVERGED",
      sameRepo: true,
    }),
    // cross-repo, downstream under a KNOWN workspace — belongs in INBOUND
    row("e-inbound-1", "Upstream:persona/profile.yaml", "/fake/Upstream/persona/profile.yaml", "/fake/Alpha/lib/content.ts", {
      state: "DRIFTED",
      sameRepo: false,
    }),
    row("e-inbound-2", "Upstream:persona/profile.yaml", "/fake/Upstream/persona/profile.yaml", "/fake/Beta/lib/content.ts", {
      state: "DIVERGED",
      sameRepo: false,
    }),
    // cross-repo, downstream NOT under any known workspace — the gap; belongs in DRIFT.outboundUnknown
    row("e-outbound-1", "Alpha:docs/GUIDE.md", "/fake/Alpha/docs/GUIDE.md", "/fake/Gamma/lib/reader.ts", {
      state: "DRIFTED",
      sameRepo: false,
    }),
    // noise: not DRIFTED/DIVERGED, must not appear anywhere
    row("e-clean-1", "Alpha:README.md", "/fake/Alpha/README.md", "/fake/Alpha/other.md", {
      state: "CLEAN",
      sameRepo: true,
    }),
    row("e-never-1", "Alpha:X.md", "/fake/Alpha/X.md", "/fake/Beta/y.ts", {
      state: "NEVER_VERIFIED",
      sameRepo: false,
    }),
  ];

  const reconcileResult = { available: true, rows };
  const inbound = inboundSnapshotForTest(reconcileResult, FAKE_WORKSPACES);
  const drift = driftSnapshotForTest(reconcileResult, FAKE_WORKSPACES);

  const totalDriftedOrDiverged = rows.filter((r) => r.state === "DRIFTED" || r.state === "DIVERGED").length;
  assert.equal(totalDriftedOrDiverged, 5);

  const inboundEdgeIds = inbound.byWorkspace.flatMap((w) => w.rows.map((r) => r.edge_id));
  const driftSameRepoEdgeIds = drift.sameRepo.map((r) => r.edge_id);
  const driftOutboundEdgeIds = drift.outboundUnknown.map((r) => r.edge_id);

  // Exhaustive: every drifted/diverged edge is in exactly one of the three lists.
  const allReported = [...inboundEdgeIds, ...driftSameRepoEdgeIds, ...driftOutboundEdgeIds];
  assert.equal(allReported.length, totalDriftedOrDiverged, "section counts must sum to the total");
  assert.equal(new Set(allReported).size, allReported.length, "no edge_id may appear twice across sections");

  // No overlap, pairwise.
  const inboundSet = new Set(inboundEdgeIds);
  const sameRepoSet = new Set(driftSameRepoEdgeIds);
  const outboundSet = new Set(driftOutboundEdgeIds);
  for (const id of inboundSet) assert.ok(!sameRepoSet.has(id) && !outboundSet.has(id));
  for (const id of sameRepoSet) assert.ok(!inboundSet.has(id) && !outboundSet.has(id));
  for (const id of outboundSet) assert.ok(!inboundSet.has(id) && !sameRepoSet.has(id));

  // Content check: the right rows landed in the right bucket.
  assert.deepEqual(new Set(sameRepoSet), new Set(["e-samerepo-1", "e-samerepo-2"]));
  assert.deepEqual(new Set(inboundSet), new Set(["e-inbound-1", "e-inbound-2"]));
  assert.deepEqual(new Set(outboundSet), new Set(["e-outbound-1"]));

  // Noise never appears.
  assert.ok(!allReported.includes("e-clean-1"));
  assert.ok(!allReported.includes("e-never-1"));
});

test("partition: reconcile failure propagates as unavailable to BOTH sections, never a false CLEAN", () => {
  const reconcileResult = { available: false, error: "reconcile threw: boom" };
  const inbound = inboundSnapshotForTest(reconcileResult, FAKE_WORKSPACES);
  const drift = driftSnapshotForTest(reconcileResult, FAKE_WORKSPACES);
  assert.equal(inbound.available, false);
  assert.equal(drift.available, false);
  assert.match(inbound.error, /boom/);
  assert.match(drift.error, /boom/);
});
