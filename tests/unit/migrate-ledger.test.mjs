import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { migrateLedger } from "../../lib/edges/migrate-ledger.mjs";
import { readLedger, readLedgerWithStats } from "../../lib/edges/ledger.mjs";

/** `readLedger`'s fold deliberately excludes `manual` rows (docs/DATA_MODEL.md
 * §2 — "manual" is terminal-only and never enters the drift fold). Row
 * conservation across all three row-opening types needs the raw stats view. */
async function allRowsIncludingManual(jsonlPath) {
  const { rows, manual } = await readLedgerWithStats(jsonlPath);
  return [...rows, ...manual];
}

/** Write a fixture ledger as raw JSONL lines (each arg is one physical row). */
async function writeFixture(jsonlPath, rows) {
  await mkdir(path.dirname(jsonlPath), { recursive: true });
  const body = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
  await writeFile(jsonlPath, body);
}

async function readRaw(jsonlPath) {
  if (!existsSync(jsonlPath)) return null;
  return readFile(jsonlPath, "utf8");
}

/** Standard two-workspace fixture: sub-project nested under a parent. */
async function makeWorkspaces() {
  const root = await mkdtemp(path.join(tmpdir(), "migledger-"));
  const subRoot = path.join(root, "sub-project");
  const fromPath = path.join(subRoot, "docs", "PROPAGATION_LEDGER.jsonl");
  const intoPath = path.join(root, "docs", "PROPAGATION_LEDGER.jsonl");
  return { root, subRoot, fromPath, intoPath };
}

test("ids are renumbered on collision — both rows survive independently", async () => {
  const { fromPath, intoPath } = await makeWorkspaces();

  await writeFixture(fromPath, [
    {
      type: "drift",
      id: "001",
      timestamp: "2026-01-01T00:00:00.000Z",
      source: "lib/x.ts",
      change: "source edit",
      downstream: [{ path: "lib/y.ts", why: "consumer", kind: "code" }],
      status: "open",
    },
  ]);

  await writeFixture(intoPath, [
    {
      type: "drift",
      id: "001",
      timestamp: "2026-01-01T00:00:00.000Z",
      source: "other/file.ts",
      change: "unrelated pre-existing row",
      downstream: [],
      status: "open",
    },
  ]);

  const result = await migrateLedger({ fromPath, intoPath, apply: true });
  assert.equal(result.migrated, 1);

  const rows = await readLedger(intoPath);
  assert.equal(rows.length, 2, "both the pre-existing and migrated row survive");

  const ids = rows.map((r) => r.id);
  assert.equal(new Set(ids).size, 2, "ids are distinct — no collision");

  const migratedRow = rows.find((r) => r.migrated_from?.id === "001");
  assert.ok(migratedRow, "migrated row is findable by provenance");
  assert.notEqual(migratedRow.id, "001", "migrated row got a NEW id, not the colliding source id");

  const preExisting = rows.find((r) => r.source === "other/file.ts");
  assert.equal(preExisting.id, "001", "pre-existing destination row keeps its original id");
});

test("source and downstream paths are rewritten relative to the destination root", async () => {
  const { fromPath, intoPath } = await makeWorkspaces();

  await writeFixture(fromPath, [
    {
      type: "code_drift",
      id: "001",
      timestamp: "2026-01-01T00:00:00.000Z",
      source: "lib/x.ts",
      change: "edit",
      downstream: [
        { path: "lib/y.ts", why: "consumer", kind: "code" },
        { path: "docs/DOC.md", why: "doc", kind: "prose" },
      ],
      status: "open",
    },
  ]);
  await writeFixture(intoPath, []);

  await migrateLedger({ fromPath, intoPath, apply: true });

  const rows = await readLedger(intoPath);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.source, "sub-project/lib/x.ts");
  assert.deepEqual(
    row.downstream.map((d) => d.path),
    ["sub-project/lib/y.ts", "sub-project/docs/DOC.md"],
  );
});

test("status_change follows its row to the new id; folded final status is unchanged", async () => {
  const { fromPath, intoPath } = await makeWorkspaces();

  await writeFixture(fromPath, [
    {
      type: "drift",
      id: "001",
      timestamp: "2026-01-01T00:00:00.000Z",
      source: "lib/x.ts",
      change: "edit",
      downstream: [{ path: "lib/y.ts", why: "consumer", kind: "code" }],
      status: "open",
    },
    {
      type: "status_change",
      id: "001",
      timestamp: "2026-01-02T00:00:00.000Z",
      status: "wontfix",
      wontfix_reason: "not applicable here",
      closed_by: "wontfix",
    },
  ]);
  await writeFixture(intoPath, []);

  await migrateLedger({ fromPath, intoPath, apply: true });

  const rows = await readLedger(intoPath);
  assert.equal(rows.length, 1, "folded output has exactly one row for this id");
  const row = rows[0];
  assert.equal(row.status, "wontfix");
  assert.equal(row.wontfix_reason, "not applicable here");
  assert.equal(row.closed_by, "wontfix");
  assert.equal(row.migrated_from.id, "001");
});

test("dry-run writes nothing — destination file is byte-identical before and after", async () => {
  const { fromPath, intoPath } = await makeWorkspaces();

  await writeFixture(fromPath, [
    {
      type: "drift",
      id: "001",
      timestamp: "2026-01-01T00:00:00.000Z",
      source: "lib/x.ts",
      change: "edit",
      downstream: [{ path: "lib/y.ts", why: "consumer", kind: "code" }],
      status: "open",
    },
  ]);
  await writeFixture(intoPath, [
    {
      type: "drift",
      id: "001",
      timestamp: "2026-01-01T00:00:00.000Z",
      source: "existing.ts",
      change: "pre-existing",
      downstream: [],
      status: "open",
    },
  ]);

  const before = await readRaw(intoPath);
  const result = await migrateLedger({ fromPath, intoPath, apply: false });
  const after = await readRaw(intoPath);

  assert.equal(after, before, "dry-run must not touch the destination file byte-for-byte");
  assert.equal(result.apply, false);
  assert.equal(result.migrated, 1, "dry-run still reports what WOULD migrate");
  assert.equal(result.manifestPath, null, "dry-run writes no manifest");
});

test("dry-run against a not-yet-existing destination creates no file", async () => {
  const { fromPath, intoPath } = await makeWorkspaces();
  await writeFixture(fromPath, [
    {
      type: "drift",
      id: "001",
      timestamp: "2026-01-01T00:00:00.000Z",
      source: "lib/x.ts",
      change: "edit",
      downstream: [],
      status: "open",
    },
  ]);
  assert.equal(existsSync(intoPath), false);

  await migrateLedger({ fromPath, intoPath, apply: false });
  assert.equal(existsSync(intoPath), false, "dry-run must not create the destination file");
});

test("re-running --apply is idempotent — no duplicated rows", async () => {
  const { fromPath, intoPath } = await makeWorkspaces();

  await writeFixture(fromPath, [
    {
      type: "drift",
      id: "001",
      timestamp: "2026-01-01T00:00:00.000Z",
      source: "lib/x.ts",
      change: "edit",
      downstream: [{ path: "lib/y.ts", why: "consumer", kind: "code" }],
      status: "open",
    },
    {
      type: "status_change",
      id: "001",
      timestamp: "2026-01-02T00:00:00.000Z",
      status: "done",
      closed_by: "drain",
    },
    {
      type: "code_drift",
      id: "002",
      timestamp: "2026-01-03T00:00:00.000Z",
      source: "lib/z.ts",
      change: "edit",
      downstream: [],
      status: "open",
    },
  ]);
  await writeFixture(intoPath, []);

  const first = await migrateLedger({ fromPath, intoPath, apply: true });
  assert.equal(first.migrated, 2);
  const afterFirst = await readLedger(intoPath);
  assert.equal(afterFirst.length, 2);

  const second = await migrateLedger({ fromPath, intoPath, apply: true });
  assert.equal(second.migrated, 0, "no new events migrated on re-run");
  assert.equal(second.skipped, 2, "both source rows recognized as already migrated");

  const afterSecond = await readLedger(intoPath);
  assert.equal(afterSecond.length, 2, "row count unchanged — no duplication");
  assert.deepEqual(
    afterSecond.map((r) => r.id).sort(),
    afterFirst.map((r) => r.id).sort(),
  );
});

test("the manifest round-trips: every new id maps to exactly one old id, every source row appears once", async () => {
  const { fromPath, intoPath } = await makeWorkspaces();

  await writeFixture(fromPath, [
    {
      type: "drift",
      id: "001",
      timestamp: "2026-01-01T00:00:00.000Z",
      source: "lib/a.ts",
      change: "edit",
      downstream: [],
      status: "open",
    },
    {
      type: "code_drift",
      id: "002",
      timestamp: "2026-01-01T00:00:01.000Z",
      source: "lib/b.ts",
      change: "edit",
      downstream: [],
      status: "open",
    },
    {
      type: "manual",
      id: "003",
      timestamp: "2026-01-01T00:00:02.000Z",
      source: "lib/c.ts",
      change: "rename annotation",
      downstream: [],
      status: "done",
    },
  ]);
  await writeFixture(intoPath, []);

  const result = await migrateLedger({ fromPath, intoPath, apply: true });
  assert.equal(result.migrated, 3);
  assert.ok(result.manifestPath, "apply writes a manifest and returns its path");
  assert.ok(existsSync(result.manifestPath));

  const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
  assert.equal(manifest.idMap.length, 3);

  const oldIds = manifest.idMap.map((m) => m.oldId).sort();
  assert.deepEqual(oldIds, ["001", "002", "003"], "every source row appears exactly once");

  const newIds = manifest.idMap.map((m) => m.newId);
  assert.equal(new Set(newIds).size, 3, "every new id is distinct");
});

test("row conservation across drift + code_drift + manual, mixed with pre-existing destination rows", async () => {
  const { fromPath, intoPath } = await makeWorkspaces();

  await writeFixture(fromPath, [
    { type: "drift", id: "001", timestamp: "2026-01-01T00:00:00.000Z", source: "a.ts", change: "c", downstream: [], status: "open" },
    { type: "status_change", id: "001", timestamp: "2026-01-01T01:00:00.000Z", status: "done", closed_by: "drain" },
    { type: "code_drift", id: "002", timestamp: "2026-01-01T02:00:00.000Z", source: "b.ts", change: "c", downstream: [], status: "open" },
    { type: "manual", id: "003", timestamp: "2026-01-01T03:00:00.000Z", source: "c.ts", change: "c", downstream: [], status: "wontfix" },
  ]);
  await writeFixture(intoPath, [
    { type: "drift", id: "001", timestamp: "2025-12-01T00:00:00.000Z", source: "pre.ts", change: "c", downstream: [], status: "wontfix" },
  ]);

  const beforeRows = await allRowsIncludingManual(intoPath);
  const beforeStatuses = beforeRows.map((r) => r.status).sort();

  const result = await migrateLedger({ fromPath, intoPath, apply: true });
  assert.equal(result.migrated, 3, "drift + code_drift + manual all count as row-opening types");

  const afterRows = await allRowsIncludingManual(intoPath);
  assert.equal(afterRows.length, beforeRows.length + 3, "destination distinct-row count rises by exactly the source count");

  const ids = afterRows.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, "no id collisions in the destination afterwards");

  const afterStatuses = afterRows.map((r) => r.status).sort();
  const migratedStatuses = ["done", "open", "wontfix"];
  assert.deepEqual(afterStatuses, [...beforeStatuses, ...migratedStatuses].sort(), "folded final statuses are conserved");
});

// ─────────────────────────────────────────────────────────────────────────
// Degenerate-input guard: --from X --into X (and same-workspace-root) must
// be REFUSED, not silently no-op'd. Before this it only "worked" because the
// content-dedupe guard happens to skip rows already present at the
// destination it just read from — luck, not design, and untested. RED item
// 6 of ~/.claude/plans/status-temporal-plum.md's verification list.
// ─────────────────────────────────────────────────────────────────────────

test("migrate-ledger --from X --into X is REFUSED, not silently no-op'd", async () => {
  const { fromPath } = await makeWorkspaces();
  await writeFixture(fromPath, [
    { type: "drift", id: "001", timestamp: "2026-01-01T00:00:00.000Z", source: "a.ts", change: "c", downstream: [], status: "open" },
  ]);
  const before = await readRaw(fromPath);

  await assert.rejects(
    () => migrateLedger({ fromPath, intoPath: fromPath, apply: false }),
    /same path|refusing/i,
  );
  await assert.rejects(
    () => migrateLedger({ fromPath, intoPath: fromPath, apply: true }),
    /same path|refusing/i,
  );

  const after = await readRaw(fromPath);
  assert.equal(after, before, "a refused same-path migration must not touch the source file");
});

test("migrate-ledger refuses when --from and --into resolve to the same workspace root via different candidate basenames", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "migledger-sameroot-"));
  const docsJsonl = path.join(root, "docs", "PROPAGATION_LEDGER.jsonl");
  const legacyJsonl = path.join(root, ".propagation", "ledger.jsonl");
  await writeFixture(docsJsonl, [
    { type: "drift", id: "001", timestamp: "2026-01-01T00:00:00.000Z", source: "a.ts", change: "c", downstream: [], status: "open" },
  ]);

  // Same workspace root (`root`), two DIFFERENT candidate ledger paths —
  // deriveRoots computes an empty prefix either way, which is exactly the
  // "renumber every id for a pure file move" trap this guard exists to stop.
  await assert.rejects(
    () => migrateLedger({ fromPath: docsJsonl, intoPath: legacyJsonl, apply: false }),
    /same workspace root|refusing/i,
  );
});
