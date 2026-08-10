import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";

import {
  rebuildIndex,
  tableCounts,
  queryOpenDrift,
  queryDecisionsSince,
  queryAffects,
  queryStaleState,
  queryUnknownTypes,
  runReadOnlySql,
  isWriteStatement,
} from "../lib/index-db.mjs";

async function makeFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "idx-"));
  const skillDir = await mkdtemp(path.join(tmpdir(), "idx-skill-"));
  return { root, skillDir };
}

function fixtureDbPath() {
  return ":memory:";
}

async function writeLedger(dir, lines) {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "PROPAGATION_LEDGER.jsonl"), lines.join("\n") + "\n", "utf8");
}

async function writeDecisions(filePath, text) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text, "utf8");
}

async function writeState(filePath, text) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text, "utf8");
}

// A stub discovery function that only "discovers" the ledgers we tell it to,
// mirroring the real discoverWorkspacesSync's return shape.
function stubDiscover(ledgerPaths) {
  return () => ({
    workspaces: ledgerPaths.map((p, i) => ({ name: `ws${i}`, root: path.dirname(p), ledgerJsonl: p })),
    markersSeen: ledgerPaths.length,
    degraded: false,
    suspiciousMarkers: [],
  });
}

test("rebuild is idempotent: two rebuilds produce identical query output", async () => {
  const { root, skillDir } = await makeFixture();
  const wsDir = path.join(root, "ws1", "docs");
  await writeLedger(wsDir, [
    JSON.stringify({ type: "drift", id: "001", source: "a.md", change: "x", status: "open", timestamp: "2026-01-01T00:00:00.000Z" }),
    JSON.stringify({ type: "status_change", id: "001", status: "done" }),
    JSON.stringify({ type: "drift", id: "002", source: "b.md", change: "y", status: "open", timestamp: "2026-01-02T00:00:00.000Z" }),
  ]);
  const ledgerPath = path.join(wsDir, "PROPAGATION_LEDGER.jsonl");
  const discover = stubDiscover([ledgerPath]);

  const r1 = rebuildIndex({ dbPath: ":memory:", roots: [root], skillDir, discover });
  const rows1 = queryOpenDrift(r1.db);
  r1.db.close();

  const r2 = rebuildIndex({ dbPath: ":memory:", roots: [root], skillDir, discover });
  const rows2 = queryOpenDrift(r2.db);
  r2.db.close();

  assert.deepEqual(rows1, rows2);
  assert.equal(rows1.length, 1);
  assert.equal(rows1[0].id, "002");
});

test("a malformed ledger line lands in ledger_unknown rather than breaking the build", async () => {
  const { root, skillDir } = await makeFixture();
  const wsDir = path.join(root, "ws1", "docs");
  await mkdir(wsDir, { recursive: true });
  const ledgerPath = path.join(wsDir, "PROPAGATION_LEDGER.jsonl");
  await writeFile(
    ledgerPath,
    [
      JSON.stringify({ type: "drift", id: "001", source: "a.md", status: "open", timestamp: "2026-01-01T00:00:00.000Z" }),
      "{not valid json,,,",
      JSON.stringify({ type: "manual", id: "999", change: "hand-authored note" }),
    ].join("\n") + "\n",
    "utf8",
  );
  const discover = stubDiscover([ledgerPath]);

  const result = rebuildIndex({ dbPath: ":memory:", roots: [root], skillDir, discover });
  const unknownRows = queryUnknownTypes(result.db);
  const raw = result.db.prepare("SELECT * FROM ledger_unknown ORDER BY line_no").all();
  result.db.close();

  assert.equal(raw.length, 2, "both the malformed line and the manual-typed row land in ledger_unknown");
  assert.equal(raw[0].raw_type, "(malformed)");
  assert.equal(raw[1].raw_type, "manual");
  assert.equal(raw[1].raw_id, "999");
  // the well-formed drift row still made it into ledger_row despite the
  // malformed line elsewhere in the same file
  assert.equal(result.counts.ledger_row, 1);
  assert.ok(unknownRows.some((r) => r.raw_type === "manual"));
});

test("a decision with multiple Affects targets produces multiple decision_affects rows", async () => {
  const { root, skillDir } = await makeFixture();
  const decisionsPath = path.join(root, "ws1", "docs", "DECISIONS.md");
  await writeDecisions(
    decisionsPath,
    `# Decisions

## 2026-05-01: multi-target decision

**What:** did a thing.
**Why:** because reasons.
**Gotchas:** none.
**Affects:** repoA, repoB, repoC
**Refs:** \`file.mjs\`

---

## 2026-05-02: single-target decision

**What:** did another thing.
**Why:** other reasons.
**Affects:** repoA
**Refs:** none

---
`,
  );
  const discover = stubDiscover([]);

  const result = rebuildIndex({ dbPath: ":memory:", roots: [root], skillDir, discover });
  const decisions = result.db.prepare("SELECT * FROM decision ORDER BY date").all();
  const affects = result.db.prepare("SELECT * FROM decision_affects ORDER BY decision_id, target").all();
  result.db.close();

  assert.equal(decisions.length, 2);
  assert.equal(decisions[0].what, "did a thing.");
  assert.equal(decisions[0].gotchas, "none.");
  assert.equal(decisions[1].gotchas, "", "Gotchas is optional and defaults to empty");

  const forFirst = affects.filter((a) => a.decision_id === decisions[0].id);
  assert.equal(forFirst.length, 3);
  assert.deepEqual(forFirst.map((a) => a.target).sort(), ["repoA", "repoB", "repoC"]);

  const forSecond = affects.filter((a) => a.decision_id === decisions[1].id);
  assert.equal(forSecond.length, 1);
  assert.equal(forSecond[0].target, "repoA");
});

test("header_last_updated and file_mtime are stored independently and can disagree", async () => {
  const { root, skillDir } = await makeFixture();
  const statePath = path.join(root, "ws1", "STATE.md");
  await writeState(statePath, `# State\n\nLast updated: 2026-01-01\n\nsome content\n`);

  const discover = stubDiscover([]);
  const result = rebuildIndex({ dbPath: ":memory:", roots: [root], skillDir, discover });
  const rows = result.db.prepare("SELECT * FROM state_doc").all();
  result.db.close();

  assert.equal(rows.length, 1);
  assert.equal(rows[0].header_last_updated, "2026-01-01");
  // file_mtime is a real filesystem timestamp from *just now* (test wrote the
  // file moments ago), which is necessarily later than the header's claim —
  // proving the two are captured independently, not collapsed into one value.
  assert.ok(rows[0].file_mtime > rows[0].header_last_updated);
  assert.notEqual(rows[0].file_mtime.slice(0, 10), rows[0].header_last_updated);
});

test("the sweep finds a ledger that a stubbed discovery misses and records a coverage_gap", async () => {
  const { root, skillDir } = await makeFixture();
  const wsDir = path.join(root, "ws1", "docs");
  await writeLedger(wsDir, [
    JSON.stringify({ type: "drift", id: "001", source: "a.md", status: "open", timestamp: "2026-01-01T00:00:00.000Z" }),
  ]);
  const ledgerPath = path.join(wsDir, "PROPAGATION_LEDGER.jsonl");

  // Discovery stubbed to find NOTHING — simulating the exact blind spot this
  // index exists to catch.
  const discover = () => ({ workspaces: [], markersSeen: 0, degraded: false, suspiciousMarkers: [] });

  const result = rebuildIndex({ dbPath: ":memory:", roots: [root], skillDir, discover });
  const gaps = result.db.prepare("SELECT * FROM coverage_gap").all();
  result.db.close();

  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].path, ledgerPath);
  assert.equal(gaps[0].reason, "found-by-sweep-not-discovery");
});

test("worktree-copy ledgers under dot-directories are excluded from the sweep", async () => {
  const { root, skillDir } = await makeFixture();
  // A real ledger.
  const wsDir = path.join(root, "ws1", "docs");
  await writeLedger(wsDir, [
    JSON.stringify({ type: "drift", id: "001", source: "a.md", status: "open", timestamp: "2026-01-01T00:00:00.000Z" }),
  ]);
  // A worktree-copy ledger nested under a dot-directory — must NOT be indexed.
  const worktreeDir = path.join(root, "ws1", ".claude", "worktrees", "some-branch", "docs");
  await writeLedger(worktreeDir, [
    JSON.stringify({ type: "drift", id: "001", source: "a.md", status: "open", timestamp: "2026-01-01T00:00:00.000Z" }),
  ]);

  const discover = stubDiscover([path.join(wsDir, "PROPAGATION_LEDGER.jsonl")]);
  const result = rebuildIndex({ dbPath: ":memory:", roots: [root], skillDir, discover });
  const ledgerPaths = result.db.prepare("SELECT DISTINCT ledger_path FROM ledger_row").all();
  result.db.close();

  assert.equal(ledgerPaths.length, 1, "only the real ledger was indexed, not the worktree copy");
  assert.ok(!ledgerPaths[0].ledger_path.includes(".claude"));
});

test(".propagation/ledger.jsonl (a dot-directory) IS indexed — the one allowed exception", async () => {
  const { root, skillDir } = await makeFixture();
  const dotDir = path.join(root, "ws1", ".propagation");
  await mkdir(dotDir, { recursive: true });
  await writeFile(
    path.join(dotDir, "ledger.jsonl"),
    JSON.stringify({ type: "drift", id: "001", source: "a.md", status: "open", timestamp: "2026-01-01T00:00:00.000Z" }) + "\n",
    "utf8",
  );
  const ledgerPath = path.join(dotDir, "ledger.jsonl");
  const discover = stubDiscover([ledgerPath]);

  const result = rebuildIndex({ dbPath: ":memory:", roots: [root], skillDir, discover });
  const rows = result.db.prepare("SELECT * FROM ledger_row").all();
  result.db.close();

  assert.equal(rows.length, 1);
  assert.equal(rows[0].ledger_path, ledgerPath);
});

test("--sql rejects a write statement", async () => {
  const { root, skillDir } = await makeFixture();
  const discover = stubDiscover([]);
  const result = rebuildIndex({ dbPath: ":memory:", roots: [root], skillDir, discover });

  for (const bad of [
    "DROP TABLE decision",
    "DELETE FROM decision",
    "UPDATE decision SET title='x'",
    "INSERT INTO decision (title) VALUES ('x')",
    "ALTER TABLE decision ADD COLUMN foo TEXT",
    "CREATE TABLE evil (a TEXT)",
  ]) {
    assert.throws(() => runReadOnlySql(result.db, bad), /refusing to run a write statement/);
    assert.equal(isWriteStatement(bad), true);
  }

  // A genuine read still works.
  const rows = runReadOnlySql(result.db, "SELECT COUNT(*) as c FROM decision");
  assert.equal(rows[0].c, 0);
  assert.equal(isWriteStatement("SELECT * FROM decision"), false);

  result.db.close();
});

test("canned queries: open-drift, decisions-since, affects, stale-state", async () => {
  const { root, skillDir } = await makeFixture();
  const wsDir = path.join(root, "ws1", "docs");
  await writeLedger(wsDir, [
    JSON.stringify({ type: "drift", id: "001", source: "a.md", change: "c1", status: "open", timestamp: "2026-01-01T00:00:00.000Z" }),
    JSON.stringify({ type: "drift", id: "002", source: "b.md", change: "c2", status: "wontfix", timestamp: "2026-01-02T00:00:00.000Z" }),
  ]);
  const decisionsPath = path.join(root, "ws1", "docs", "DECISIONS.md");
  await writeDecisions(
    decisionsPath,
    `## 2026-01-05: a decision\n\n**What:** w\n**Why:** y\n**Affects:** ws1, ws2\n**Refs:** none\n\n---\n\n## 2026-02-05: later decision\n\n**What:** w2\n**Why:** y2\n**Affects:** ws3\n**Refs:** none\n`,
  );
  const statePath = path.join(root, "ws1", "STATE.md");
  await writeState(statePath, `Last updated: 2026-01-01\n`);

  const discover = stubDiscover([path.join(wsDir, "PROPAGATION_LEDGER.jsonl")]);
  const result = rebuildIndex({ dbPath: ":memory:", roots: [root], skillDir, discover });

  const open = queryOpenDrift(result.db);
  assert.equal(open.length, 1);
  assert.equal(open[0].source, "a.md");

  const since = queryDecisionsSince(result.db, { from: "2026-02-01" });
  assert.equal(since.length, 1);
  assert.equal(since[0].title, "later decision");

  const affectsWs1 = queryAffects(result.db, "ws1");
  assert.equal(affectsWs1.length, 1);
  assert.equal(affectsWs1[0].title, "a decision");

  const stale = queryStaleState(result.db);
  assert.equal(stale.length, 1);
  assert.equal(stale[0].header_last_updated, "2026-01-01");

  result.db.close();
});

test("tableCounts reflects rebuild output", async () => {
  const { root, skillDir } = await makeFixture();
  const wsDir = path.join(root, "ws1", "docs");
  await writeLedger(wsDir, [
    JSON.stringify({ type: "drift", id: "001", source: "a.md", status: "open", timestamp: "2026-01-01T00:00:00.000Z" }),
  ]);
  const discover = stubDiscover([path.join(wsDir, "PROPAGATION_LEDGER.jsonl")]);
  const result = rebuildIndex({ dbPath: ":memory:", roots: [root], skillDir, discover });
  const counts = tableCounts(result.db);
  result.db.close();

  assert.equal(counts.ledger_row, 1);
  assert.equal(counts.decision, 0);
});
