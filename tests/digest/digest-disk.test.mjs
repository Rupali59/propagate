import { test } from "node:test";
import assert from "node:assert/strict";

import { computeDiff, formatDigest } from "../../digest.mjs";

// ─────────────────────────────────────────────────────────────────────────────
// Disk hygiene — synthetic snapshots only, never real df/du. Mirrors the
// fixture shape buildSnapshot() would produce (see digest.mjs diskSnapshot()).
// ─────────────────────────────────────────────────────────────────────────────

const KB_PER_GB = 1024 * 1024;
const SIX_WEEKS_MS = 6 * 7 * 24 * 60 * 60 * 1000;

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

function disk(overrides = {}) {
  return {
    availKb: 79 * KB_PER_GB, // matches real machine state at time of writing: 79 GiB free
    usedPct: 83,
    caches: [],
    projects: [],
    truncated: false,
    ...overrides,
  };
}

function baseSnapshot(overrides = {}) {
  return {
    generatedAt: "2026-08-10T09:00:00.000Z",
    degraded: false,
    suspiciousMarkers: [],
    watcher: { heartbeatMs: Date.now(), ageSeconds: 10, state: "alive" },
    workspaces: [ws("Alpha", { openRows: [{ id: "001", source: "a.md", downstreamCount: 1 }] })],
    cross: ws("cross", { openRows: [] }),
    duplicateOpenAcrossLedgers: { count: 0, examples: [] },
    plist: { checked: true, mismatched: false },
    disk: disk(),
    ...overrides,
  };
}

function priorFrom(snapshot, diskOverrides) {
  const workspaces = {};
  for (const w of snapshot.workspaces) {
    workspaces[w.name] = {
      total: w.counts.total,
      open: w.counts.open,
      done: w.counts.done,
      wontfix: w.counts.wontfix,
      openRows: w.openRows,
    };
  }
  const caches = {};
  for (const c of snapshot.disk.caches) caches[c.path] = c.apparentKb;
  const projects = {};
  for (const p of snapshot.disk.projects) projects[p.dir] = { nodeModulesKb: p.nodeModulesKb, nextKb: p.nextKb };
  return {
    version: 1,
    lastRunAt: "2026-08-09T09:00:00.000Z",
    workspaces,
    cross: {
      total: snapshot.cross.counts.total,
      open: snapshot.cross.counts.open,
      done: snapshot.cross.counts.done,
      wontfix: snapshot.cross.counts.wontfix,
      openRows: snapshot.cross.openRows,
    },
    disk: { availKb: snapshot.disk.availKb, usedPct: snapshot.disk.usedPct, caches, projects, ...diskOverrides },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Healthy day: zero disk lines, quiet one-liner.
// ─────────────────────────────────────────────────────────────────────────────

test("disk: healthy snapshot (79 GiB free, no growth, no dormant projects) produces zero disk lines", () => {
  const snapshot = baseSnapshot();
  const diff = computeDiff(snapshot, priorFrom(snapshot));
  assert.deepEqual(diff.diskLines, []);
  assert.deepEqual(diff.broken, []);
  const text = formatDigest(diff);
  assert.equal(text.split("\n").length, 1, "healthy day must stay a single quiet line");
  assert.doesNotMatch(text, /DISK/);
});

test("disk: absent disk key on snapshot (older/legacy snapshot shape) is tolerated, no crash, no lines", () => {
  const snapshot = baseSnapshot();
  delete snapshot.disk;
  const prior = priorFrom(baseSnapshot());
  delete prior.disk;
  const diff = computeDiff(snapshot, prior);
  assert.deepEqual(diff.diskLines, []);
  const text = formatDigest(diff);
  assert.doesNotMatch(text, /DISK/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Thresholds
// ─────────────────────────────────────────────────────────────────────────────

test("disk: availGb below 60 but at/above 30 emits a WARN line, does not escalate to broken", () => {
  const snapshot = baseSnapshot({ disk: disk({ availKb: 45 * KB_PER_GB }) });
  const diff = computeDiff(snapshot, priorFrom(snapshot));
  assert.equal(diff.broken.some((b) => b.kind === "diskCritical"), false);
  assert.equal(diff.diskLines.some((l) => /WARN/.test(l) && /45\.0 GiB/.test(l)), true);
});

test("disk: availGb below 30 routes through the broken channel (existing escalation path)", () => {
  const snapshot = baseSnapshot({ disk: disk({ availKb: 12 * KB_PER_GB }) });
  const diff = computeDiff(snapshot, priorFrom(snapshot));
  const found = diff.broken.find((b) => b.kind === "diskCritical");
  assert.ok(found, "expected a diskCritical entry in diff.broken");
  assert.match(found.detail, /12\.0 GiB/);
  // Below-30 must not also duplicate as a WARN line (single severity band wins).
  assert.equal(diff.diskLines.some((l) => /WARN/.test(l)), false);
});

test("disk: availGb below 30 appears in BROKEN section ahead of the totals footer, same as other broken kinds", () => {
  const snapshot = baseSnapshot({ disk: disk({ availKb: 10 * KB_PER_GB }) });
  const diff = computeDiff(snapshot, priorFrom(snapshot));
  const text = formatDigest(diff);
  const brokenIdx = text.indexOf("BROKEN");
  const footerIdx = text.lastIndexOf("open across");
  assert.notEqual(brokenIdx, -1);
  assert.ok(brokenIdx < footerIdx);
  assert.match(text, /diskCritical/);
});

test("disk: availGb at exactly 60 does not trip WARN (strict less-than)", () => {
  const snapshot = baseSnapshot({ disk: disk({ availKb: 60 * KB_PER_GB }) });
  const diff = computeDiff(snapshot, priorFrom(snapshot));
  assert.deepEqual(diff.diskLines, []);
});

// ─────────────────────────────────────────────────────────────────────────────
// Cache growth spike
// ─────────────────────────────────────────────────────────────────────────────

test("disk: a single cache growing >5 GiB apparent since last run emits one GROWTH line, independent of availGb band", () => {
  const priorSnapshot = baseSnapshot({
    disk: disk({ caches: [{ path: "/Users/x/.cache/uv", apparentKb: 2 * KB_PER_GB }] }),
  });
  const prior = priorFrom(priorSnapshot);
  const snapshot = baseSnapshot({
    disk: disk({ caches: [{ path: "/Users/x/.cache/uv", apparentKb: 9 * KB_PER_GB }] }), // +7 GiB
  });
  const diff = computeDiff(snapshot, prior);
  const growthLines = diff.diskLines.filter((l) => /GROWTH/.test(l));
  assert.equal(growthLines.length, 1);
  assert.match(growthLines[0], /\.cache\/uv/);
  assert.match(growthLines[0], /7\.0 GiB/);
});

test("disk: cache growth of <=5 GiB does not emit a GROWTH line", () => {
  const priorSnapshot = baseSnapshot({
    disk: disk({ caches: [{ path: "/Users/x/.npm", apparentKb: 2 * KB_PER_GB }] }),
  });
  const prior = priorFrom(priorSnapshot);
  const snapshot = baseSnapshot({
    disk: disk({ caches: [{ path: "/Users/x/.npm", apparentKb: 6 * KB_PER_GB }] }), // +4 GiB
  });
  const diff = computeDiff(snapshot, prior);
  assert.equal(diff.diskLines.some((l) => /GROWTH/.test(l)), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Dormant-but-heavy project
// ─────────────────────────────────────────────────────────────────────────────

test("disk: a project idle >6 weeks holding >200 MB node_modules emits one 'prunable' line", () => {
  const idleMs = Date.now() - (SIX_WEEKS_MS + 24 * 60 * 60 * 1000); // 6 weeks + 1 day ago
  const snapshot = baseSnapshot({
    disk: disk({
      projects: [{ dir: "/Users/x/Documents/GitHub/Old/stale-app", nodeModulesKb: 300 * 1024, nextKb: 0, newestSourceMs: idleMs }],
    }),
  });
  const diff = computeDiff(snapshot, priorFrom(snapshot));
  const prunable = diff.diskLines.filter((l) => /prunable/.test(l));
  assert.equal(prunable.length, 1);
  assert.match(prunable[0], /stale-app/);
});

test("disk: a project idle >6 weeks but under 200 MB node_modules is not flagged", () => {
  const idleMs = Date.now() - (SIX_WEEKS_MS + 24 * 60 * 60 * 1000);
  const snapshot = baseSnapshot({
    disk: disk({
      projects: [{ dir: "/Users/x/Documents/GitHub/Old/tiny-app", nodeModulesKb: 50 * 1024, nextKb: 0, newestSourceMs: idleMs }],
    }),
  });
  const diff = computeDiff(snapshot, priorFrom(snapshot));
  assert.equal(diff.diskLines.some((l) => /prunable/.test(l)), false);
});

test("disk: a heavy project (>200 MB) actively worked on (mtime recent) is not flagged", () => {
  const snapshot = baseSnapshot({
    disk: disk({
      projects: [{ dir: "/Users/x/Documents/GitHub/Active/big-app", nodeModulesKb: 500 * 1024, nextKb: 0, newestSourceMs: Date.now() }],
    }),
  });
  const diff = computeDiff(snapshot, priorFrom(snapshot));
  assert.equal(diff.diskLines.some((l) => /prunable/.test(l)), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Truncation note
// ─────────────────────────────────────────────────────────────────────────────

test("disk: truncated measurement adds a note but never fabricates numbers", () => {
  const snapshot = baseSnapshot({ disk: disk({ truncated: true }) });
  const diff = computeDiff(snapshot, priorFrom(snapshot));
  assert.equal(diff.diskLines.some((l) => /truncated/.test(l)), true);
});

// ─────────────────────────────────────────────────────────────────────────────
// formatDigest: DISK block placement + quiet-day interaction
// ─────────────────────────────────────────────────────────────────────────────

test("formatDigest: any tripped disk threshold breaks quiet-day suppression even with zero ledger change", () => {
  const snapshot = baseSnapshot({ disk: disk({ availKb: 45 * KB_PER_GB }) });
  const diff = computeDiff(snapshot, priorFrom(snapshot));
  assert.equal(diff.hasChange, false, "no ledger drift in this scenario");
  const text = formatDigest(diff);
  assert.notEqual(text.split("\n").length, 1, "must not collapse to the quiet one-liner when disk WARN is present");
  assert.match(text, /DISK:/);
  assert.match(text, /WARN/);
});

test("formatDigest: DISK block appears after BROKEN and before NEW/CLOSED sections", () => {
  const snapshot = baseSnapshot({ disk: disk({ availKb: 45 * KB_PER_GB }), degraded: true });
  const diff = computeDiff(snapshot, priorFrom(snapshot));
  const text = formatDigest(diff);
  const brokenIdx = text.indexOf("BROKEN");
  const diskIdx = text.indexOf("DISK:");
  assert.ok(brokenIdx !== -1 && diskIdx !== -1 && brokenIdx < diskIdx);
});
