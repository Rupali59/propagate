/**
 * The digest's INVENTORY section — the self-adoption answer for
 * lib/inventory.mjs itself (task brief: "this probe is itself a tool that
 * could go unadopted"). Diff-only, same idiom as SKILLS: reports status
 * transitions since the last run, renders nothing when nothing changed, and
 * participates in the quiet-day collapse.
 *
 * Synthetic snapshot fixtures only, mirroring tests/digest-drift.test.mjs's
 * shape — never touches the real inventory probe or a real ledger.
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
    ...overrides,
  };
}

function invSnap(ids, over = {}) {
  const counts = { total: ids.length };
  for (const r of ids) counts[r.status] = (counts[r.status] ?? 0) + 1;
  return { available: true, generatedAt: "2026-08-14T09:00:00.000Z", counts, ids, droppedCount: 0, budgetExceeded: false, ...over };
}

function priorInvState(ids) {
  const statusById = {};
  for (const r of ids) statusById[r.id] = r.status;
  const counts = { total: ids.length };
  for (const r of ids) counts[r.status] = (counts[r.status] ?? 0) + 1;
  return { counts, statusById };
}

test("first run: inventory present but no baseline yet -> no inventory lines (firstRun handles the whole digest)", () => {
  const snapshot = baseSnapshot({ inventory: invSnap([{ id: "skill:a", status: "active" }]) });
  const diff = computeDiff(snapshot, null);
  assert.equal(diff.firstRun, true);
  assert.deepEqual(diff.inventoryLines, []);
});

test("probe comes online with no prior inventory baseline: states it once", () => {
  const priorNoInventory = { version: 1, lastRunAt: "2026-08-13T09:00:00.000Z", workspaces: {}, cross: { total: 0, open: 0, done: 0, wontfix: 0, openRows: [] } };
  const snapshot = baseSnapshot({ inventory: invSnap([{ id: "skill:a", status: "active" }, { id: "skill:b", status: "dormant" }]) });
  const diff = computeDiff(snapshot, priorNoInventory);
  assert.equal(diff.inventoryLines.length, 1);
  assert.match(diff.inventoryLines[0], /inventory online: 2 items/);
});

test("no change: identical id/status sets produce zero inventory lines", () => {
  const ids = [{ id: "skill:a", status: "active" }, { id: "plugin:p", status: "dormant" }];
  const snapshot = baseSnapshot({ inventory: invSnap(ids) });
  const prior = { workspaces: {}, cross: { total: 0, open: 0, done: 0, wontfix: 0, openRows: [] }, inventory: priorInvState(ids) };
  const diff = computeDiff(snapshot, prior);
  assert.deepEqual(diff.inventoryLines, []);
});

test("a status transition to dormant is reported by id", () => {
  const before = [{ id: "skill:a", status: "active" }];
  const after = [{ id: "skill:a", status: "dormant" }];
  const snapshot = baseSnapshot({ inventory: invSnap(after) });
  const prior = { workspaces: {}, cross: { total: 0, open: 0, done: 0, wontfix: 0, openRows: [] }, inventory: priorInvState(before) };
  const diff = computeDiff(snapshot, prior);
  assert.equal(diff.inventoryLines.length, 1);
  assert.equal(diff.inventoryLines[0], "skill:a: active -> dormant");
});

test("a status transition to active is reported by id", () => {
  const before = [{ id: "skill:a", status: "installed-never-invoked" }];
  const after = [{ id: "skill:a", status: "active" }];
  const snapshot = baseSnapshot({ inventory: invSnap(after) });
  const prior = { workspaces: {}, cross: { total: 0, open: 0, done: 0, wontfix: 0, openRows: [] }, inventory: priorInvState(before) };
  const diff = computeDiff(snapshot, prior);
  assert.equal(diff.inventoryLines[0], "skill:a: installed-never-invoked -> active");
});

test("a newly-appeared dormant item is called out distinctly from an appeared-active item", () => {
  const before = [];
  const after = [
    { id: "skill:new-dormant", status: "dormant" },
    { id: "skill:new-active", status: "active" },
  ];
  const snapshot = baseSnapshot({ inventory: invSnap(after) });
  const prior = { workspaces: {}, cross: { total: 0, open: 0, done: 0, wontfix: 0, openRows: [] }, inventory: priorInvState(before) };
  const diff = computeDiff(snapshot, prior);
  assert.ok(diff.inventoryLines.some((l) => l.includes("new dormant/never-invoked") && l.includes("skill:new-dormant")));
  assert.ok(diff.inventoryLines.some((l) => l.includes("1 other new item")));
});

test("a disappeared id (deleted skill, retired repo) is reported", () => {
  const before = [{ id: "skill:gone", status: "active" }];
  const after = [];
  const snapshot = baseSnapshot({ inventory: invSnap(after) });
  const prior = { workspaces: {}, cross: { total: 0, open: 0, done: 0, wontfix: 0, openRows: [] }, inventory: priorInvState(before) };
  const diff = computeDiff(snapshot, prior);
  assert.ok(diff.inventoryLines.some((l) => l.startsWith("-1 removed") && l.includes("skill:gone")));
});

test("budget-exceeded is surfaced even with no status changes", () => {
  const ids = [{ id: "skill:a", status: "active" }];
  const snapshot = baseSnapshot({ inventory: invSnap(ids, { budgetExceeded: true }) });
  const prior = { workspaces: {}, cross: { total: 0, open: 0, done: 0, wontfix: 0, openRows: [] }, inventory: priorInvState(ids) };
  const diff = computeDiff(snapshot, prior);
  assert.ok(diff.inventoryLines.some((l) => l.includes("time budget exceeded")));
});

test("vanished-signal: inventory was available last run and is not now -> explicit failure line, never silence", () => {
  const ids = [{ id: "skill:a", status: "active" }];
  const snapshot = baseSnapshot({ inventory: { available: false, error: "boom" } });
  const prior = { workspaces: {}, cross: { total: 0, open: 0, done: 0, wontfix: 0, openRows: [] }, inventory: priorInvState(ids) };
  const diff = computeDiff(snapshot, prior);
  assert.ok(diff.inventoryLines.some((l) => l.includes("!! inventory probe unavailable: boom")));
});

test("missing snapshot.inventory entirely does not crash computeDiff (older/synthetic snapshots)", () => {
  const snapshot = baseSnapshot();
  const prior = { workspaces: {}, cross: { total: 0, open: 0, done: 0, wontfix: 0, openRows: [] } };
  const diff = computeDiff(snapshot, prior);
  assert.deepEqual(diff.inventoryLines, []);
});

// ─────────────────────────────────────────────────────────────────────────────
// formatDigest — rendering + quiet-day participation
// ─────────────────────────────────────────────────────────────────────────────

test("formatDigest renders an INVENTORY section when there are inventory lines", () => {
  const before = [{ id: "skill:a", status: "active" }];
  const after = [{ id: "skill:a", status: "dormant" }];
  const snapshot = baseSnapshot({ inventory: invSnap(after) });
  const prior = { workspaces: {}, cross: { total: 0, open: 0, done: 0, wontfix: 0, openRows: [] }, inventory: priorInvState(before) };
  const diff = computeDiff(snapshot, prior);
  const text = formatDigest(diff);
  assert.match(text, /INVENTORY \(self-adoption probe\)/);
  assert.match(text, /skill:a: active -> dormant/);
});

test("formatDigest stays quiet (no INVENTORY section, quiet-day line) when nothing changed anywhere", () => {
  const ids = [{ id: "skill:a", status: "active" }];
  const snapshot = baseSnapshot({ inventory: invSnap(ids) });
  const prior = { workspaces: {}, cross: { total: 0, open: 0, done: 0, wontfix: 0, openRows: [] }, inventory: priorInvState(ids) };
  const diff = computeDiff(snapshot, prior);
  const text = formatDigest(diff);
  assert.doesNotMatch(text, /INVENTORY/);
  assert.match(text, /no change/);
});
