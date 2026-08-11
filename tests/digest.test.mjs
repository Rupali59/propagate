import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  computeDiff,
  formatDigest,
  readDigestState,
  writeDigestState,
  snapshotToDigestStateForTest,
} from "../digest.mjs";

// ─────────────────────────────────────────────────────────────────────────────
// Fixture builders — synthetic snapshots/digest-states only. Never touch a
// real .jsonl ledger.
// ─────────────────────────────────────────────────────────────────────────────

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
    generatedAt: "2026-08-10T09:00:00.000Z",
    degraded: false,
    suspiciousMarkers: [],
    watcher: { heartbeatMs: Date.now(), ageSeconds: 10, state: "alive" },
    workspaces: [ws("Alpha", { openRows: [{ id: "001", source: "a.md", downstreamCount: 1 }] })],
    cross: ws("cross", { openRows: [] }),
    duplicateOpenAcrossLedgers: { count: 0, examples: [] },
    plist: { checked: true, mismatched: false },
    ...overrides,
  };
}

function priorFrom(snapshot) {
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
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// computeDiff
// ─────────────────────────────────────────────────────────────────────────────

test("computeDiff: first run (prior null) reports firstRun and does not compute new/closed", () => {
  const snapshot = baseSnapshot();
  const diff = computeDiff(snapshot, null);
  assert.equal(diff.firstRun, true);
  assert.deepEqual(diff.newByWorkspace, []);
  assert.deepEqual(diff.closedByWorkspace, []);
  assert.equal(diff.totals.open, 1);
});

test("computeDiff: no change when prior equals current open rows", () => {
  const snapshot = baseSnapshot();
  const prior = priorFrom(snapshot);
  const diff = computeDiff(snapshot, prior);
  assert.equal(diff.firstRun, false);
  assert.equal(diff.hasChange, false);
  assert.deepEqual(diff.newByWorkspace, []);
  assert.deepEqual(diff.closedByWorkspace, []);
  assert.deepEqual(diff.broken, []);
});

test("computeDiff: a new open row since last run is reported under newByWorkspace", () => {
  const snapshot = baseSnapshot({
    workspaces: [
      ws("Alpha", {
        openRows: [
          { id: "001", source: "a.md", downstreamCount: 1 },
          { id: "002", source: "b.md", downstreamCount: 3 },
        ],
      }),
    ],
  });
  const prior = priorFrom(baseSnapshot()); // only 001 known
  const diff = computeDiff(snapshot, prior);
  assert.equal(diff.hasChange, true);
  assert.equal(diff.newByWorkspace.length, 1);
  assert.equal(diff.newByWorkspace[0].name, "Alpha");
  assert.deepEqual(
    diff.newByWorkspace[0].rows.map((r) => r.id),
    ["002"],
  );
  assert.deepEqual(diff.closedByWorkspace, []);
});

test("computeDiff: a row that dropped out of open (closed/wontfix) since last run is reported under closedByWorkspace", () => {
  const priorSnapshot = baseSnapshot({
    workspaces: [
      ws("Alpha", {
        openRows: [
          { id: "001", source: "a.md", downstreamCount: 1 },
          { id: "002", source: "b.md", downstreamCount: 3 },
        ],
      }),
    ],
  });
  const prior = priorFrom(priorSnapshot);
  const snapshot = baseSnapshot(); // only 001 still open; 002 closed
  const diff = computeDiff(snapshot, prior);
  assert.equal(diff.hasChange, true);
  assert.equal(diff.closedByWorkspace.length, 1);
  assert.deepEqual(
    diff.closedByWorkspace[0].rows.map((r) => r.id),
    ["002"],
  );
  assert.deepEqual(diff.newByWorkspace, []);
});

test("computeDiff: watcher not alive is reported as broken, independent of ledger quietDays", () => {
  const snapshot = baseSnapshot({ watcher: { heartbeatMs: 0, ageSeconds: 999999, state: "dead" } });
  const diff = computeDiff(snapshot, priorFrom(snapshot));
  assert.equal(diff.broken.some((b) => b.kind === "watcher"), true);
});

test("computeDiff: DISCOVERY_DEGRADED true is reported as broken", () => {
  const snapshot = baseSnapshot({ degraded: true });
  const diff = computeDiff(snapshot, priorFrom(snapshot));
  assert.equal(diff.broken.some((b) => b.kind === "discovery"), true);
});

test("computeDiff: suspiciousMarkers non-empty is reported as broken, one entry per marker", () => {
  const snapshot = baseSnapshot({
    suspiciousMarkers: [{ path: "/fake/bad/.propagates.yml", reason: "workspace not boolean" }],
  });
  const diff = computeDiff(snapshot, priorFrom(snapshot));
  const found = diff.broken.filter((b) => b.kind === "suspiciousMarker");
  assert.equal(found.length, 1);
  assert.match(found[0].detail, /bad\/\.propagates\.yml/);
});

test("computeDiff: malformed ledger lines are reported as broken", () => {
  const snapshot = baseSnapshot({
    workspaces: [ws("Alpha", { openRows: [], malformed: 2 })],
  });
  const diff = computeDiff(snapshot, priorFrom(snapshot));
  assert.equal(diff.broken.some((b) => b.kind === "malformedLedgerLines" && /Alpha/.test(b.detail)), true);
});

test("computeDiff: duplicateOpenAcrossLedgers non-zero is reported as broken", () => {
  const snapshot = baseSnapshot({
    duplicateOpenAcrossLedgers: { count: 1, examples: [{ path: "/x", ledgers: ["a", "b"] }] },
  });
  const diff = computeDiff(snapshot, priorFrom(snapshot));
  assert.equal(diff.broken.some((b) => b.kind === "duplicateOpenAcrossLedgers"), true);
});

// ─────────────────────────────────────────────────────────────────────────────
// formatDigest
// ─────────────────────────────────────────────────────────────────────────────

test("formatDigest: no change + nothing broken emits a short single line, not a full report", () => {
  const snapshot = baseSnapshot();
  const diff = computeDiff(snapshot, priorFrom(snapshot));
  const text = formatDigest(diff);
  assert.equal(text.split("\n").length, 1);
  assert.match(text, /^propagate: no change, watcher: alive.*1 open$/);
});

test("formatDigest: first run states explicitly that there is no prior state, and does not enumerate all open rows", () => {
  const snapshot = baseSnapshot({
    workspaces: [
      ws("Alpha", {
        openRows: Array.from({ length: 20 }, (_, i) => ({ id: String(i), source: `f${i}.md`, downstreamCount: 0 })),
      }),
    ],
  });
  const diff = computeDiff(snapshot, null);
  const text = formatDigest(diff);
  assert.match(text, /FIRST RUN/);
  assert.match(text, /20 open/);
  // Must not dump all 20 individual rows on first run.
  assert.equal((text.match(/^\s*\+ /gm) || []).length, 0);
});

test("formatDigest: broken conditions lead the report ahead of new/closed rows", () => {
  const snapshot = baseSnapshot({ degraded: true });
  const diff = computeDiff(snapshot, priorFrom(snapshot));
  const text = formatDigest(diff);
  const brokenIdx = text.indexOf("BROKEN");
  assert.notEqual(brokenIdx, -1);
  const footerIdx = text.lastIndexOf("open across");
  assert.ok(brokenIdx < footerIdx, "BROKEN section must appear before the totals footer");
});

// ─────────────────────────────────────────────────────────────────────────────
// digest-state persistence — atomic write, roundtrip. mkdtemp fixture, never
// the real ~/.claude/propagate-digest-state.json.
// ─────────────────────────────────────────────────────────────────────────────

test("writeDigestState/readDigestState: roundtrips through a temp path", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "digest-state-"));
  const statePath = path.join(dir, "propagate-digest-state.json");

  assert.equal(await readDigestState(statePath), null, "no file yet -> null, not a throw");

  const snapshot = baseSnapshot();
  const state = snapshotToDigestStateForTest(snapshot);
  await writeDigestState(state, statePath);

  const read = await readDigestState(statePath);
  assert.equal(read.version, 1);
  assert.deepEqual(Object.keys(read.workspaces), ["Alpha"]);
  assert.equal(read.workspaces.Alpha.open, 1);
});

test("readDigestState: malformed JSON on disk returns null rather than throwing", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "digest-state-bad-"));
  const statePath = path.join(dir, "propagate-digest-state.json");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(statePath, "{not json", "utf8");
  assert.equal(await readDigestState(statePath), null);
});

// ── Skills block ────────────────────────────────────────────────────────────
// The whole point is that it says NOTHING on a quiet day. A block restating
// "92 skills, 36 never invoked" every morning becomes wallpaper in a week --
// the exact failure that let PROPAGATION_CROSS_LEDGER.md read "Watcher
// healthy" for a month.

const skillSnap = (over = {}) => ({
  available: true, total: 3, neverInvoked: 1, dangling: 0, disagreement: 0,
  ids: ["a", "b", "c"], ...over,
});

test("skills contribute zero lines when the inventory is unchanged", () => {
  const snap = { ...baseSnapshot(), skills: skillSnap() };
  const prior = { ...snapshotToDigestStateForTest(snap) };
  const diff = computeDiff(snap, prior);
  assert.deepEqual(diff.skillLines, []);
  // and the quiet-day early return must still be reachable
  assert.match(formatDigest(diff), /^propagate: no change/);
});

test("skills report appearances and disappearances, not the inventory", () => {
  const before = { ...baseSnapshot(), skills: skillSnap() };
  const prior = snapshotToDigestStateForTest(before);
  const after = { ...baseSnapshot(), skills: skillSnap({ ids: ["a", "c", "d"], total: 3 }) };
  const diff = computeDiff(after, prior);
  const text = diff.skillLines.join("\n");
  assert.match(text, /\+1 appeared: d/);
  assert.match(text, /-1 removed: b/);
  assert.doesNotMatch(text, /never invoked/, "must not restate the inventory");
  assert.match(formatDigest(diff), /SKILLS:/);
});

test("probe disagreement fires on transition, and is loud", () => {
  const before = { ...baseSnapshot(), skills: skillSnap() };
  const prior = snapshotToDigestStateForTest(before);
  const after = { ...baseSnapshot(), skills: skillSnap({ disagreement: 2 }) };
  const diff = computeDiff(after, prior);
  assert.match(diff.skillLines.join("\n"), /primary liveness probe has lost events/);

  // Persisting at the same value must NOT re-fire — alarms nag on change only.
  const prior2 = snapshotToDigestStateForTest(after);
  assert.deepEqual(computeDiff({ ...baseSnapshot(), skills: skillSnap({ disagreement: 2 }) }, prior2).skillLines, []);
});

test("an unavailable skill index stays silent rather than reporting zero", () => {
  // A rebuild that ran without the opt-in sweep has no skill rows. Reporting
  // "0 skills" would read as "everything was deleted".
  const snap = { ...baseSnapshot(), skills: { available: false, error: "no skill rows" } };
  const diff = computeDiff(snap, snapshotToDigestStateForTest({ ...baseSnapshot(), skills: skillSnap() }));
  assert.deepEqual(diff.skillLines, []);
});
