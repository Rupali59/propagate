/**
 * lib/graph/graph-index.mjs — the event join.
 *
 * graph-index.mjs:290 mapped `event_id: e.id ?? null`, but events write the
 * field as `event_id` (lib/edges/events.mjs:276), so every indexed event's
 * `event_id` column was NULL — confirmed against the live DB (1250 of 1250).
 * `v_edge_history` cannot join back to a specific event when that column is
 * always null. The same mapping also dropped `by`, `observed_on_ref`,
 * `source_content` and `downstream_content` entirely.
 *
 * This test builds a fixture event store (PROPAGATE_STATE_DIR-scoped, never
 * the real ~/.propagate — see docs/GOTCHAS.md G52) and a fixture workspace
 * with no sidecars, so `reconcile()` returns zero generators/rows and the
 * graph is empty — only the events path is under test. Runs in a subprocess
 * because EVENTS_DIR/STATE_DIR are module-level consts resolved at import
 * time from PROPAGATE_STATE_DIR (same pattern as tests/watcher/events.test.mjs).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const SKILL_DIR = fileURLToPath(new URL("../../", import.meta.url));
const GRAPH_INDEX_PATH = path.join(SKILL_DIR, "lib/graph/graph-index.mjs");
const EVENTS_PATH = path.join(SKILL_DIR, "lib/edges/events.mjs");

/**
 * Build one fixture event (via the real appendEvent, so it is a genuinely
 * valid record) and one fixture workspace (a directory with no
 * .propagates.yml — reconcile() finds zero generators there), then run
 * buildModel()+emitSqlite() in a subprocess scoped to a temp
 * PROPAGATE_STATE_DIR, and return the resulting sqlite db path plus the temp
 * dirs for cleanup.
 */
async function buildFixtureIndex(overrides = {}) {
  const stateDir = await mkdtemp(path.join(tmpdir(), "graph-index-events-state-"));
  const workDir = await mkdtemp(path.join(tmpdir(), "graph-index-events-work-"));
  await mkdir(path.join(workDir, "ws"), { recursive: true });
  const dbPath = path.join(stateDir, "graph-index.db");

  const script = `
    import { appendEvent } from ${JSON.stringify(EVENTS_PATH)};
    import { buildModel, emitSqlite } from ${JSON.stringify(GRAPH_INDEX_PATH)};

    await appendEvent(${JSON.stringify({
      edge_id: "abcd1234",
      node_id: "ws:lib/pricing.ts",
      disposition: "propagated",
      reason: "test fixture",
      by: "rupali",
      observed_on_ref: "production",
      source_content: "s".repeat(64),
      downstream_content: "d".repeat(64),
      ...overrides,
    })});

    const model = await buildModel([{ root: ${JSON.stringify(path.join(workDir, "ws"))} }]);
    emitSqlite(model, ${JSON.stringify(dbPath)});
    console.log(JSON.stringify({ ok: true }));
  `;

  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { ...process.env, PROPAGATE_STATE_DIR: stateDir },
  });
  if (result.status !== 0) {
    throw new Error(`fixture build failed: ${result.stderr}`);
  }

  return { stateDir, workDir, dbPath };
}

async function cleanup({ stateDir, workDir }) {
  await rm(stateDir, { recursive: true, force: true });
  await rm(workDir, { recursive: true, force: true });
}

test("graph-index: event_id round-trips (RED against e.id ?? null)", async () => {
  const ctx = await buildFixtureIndex();
  try {
    assert.ok(existsSync(ctx.dbPath), "index db must be written");
    const db = new DatabaseSync(ctx.dbPath);
    const rows = db.prepare("SELECT event_id, edge_id, node_id, disposition, reason FROM event").all();
    db.close();

    assert.equal(rows.length, 1, "the one fixture event must be indexed");
    const row = rows[0];
    assert.notEqual(row.event_id, null, "event_id must not be null — this is the bug under test");
    assert.match(String(row.event_id), /^[0-9A-Z]{26}$/, "event_id must be the real ULID minted by appendEvent");
    assert.equal(row.edge_id, "abcd1234");
    assert.equal(row.node_id, "ws:lib/pricing.ts");
    assert.equal(row.disposition, "propagated");
  } finally {
    await cleanup(ctx);
  }
});

test("graph-index: positional/provenance fields survive the round trip", async () => {
  const ctx = await buildFixtureIndex();
  try {
    const db = new DatabaseSync(ctx.dbPath);
    const row = db.prepare("SELECT * FROM event").get();
    db.close();

    assert.equal(row.by, "rupali");
    assert.equal(row.observed_on_ref, "production");
    assert.equal(row.source_content, "s".repeat(64));
    assert.equal(row.downstream_content, "d".repeat(64));
  } finally {
    await cleanup(ctx);
  }
});

test("graph-index: W1's newer fields (observed_at_commit etc.) are absent as SQL NULL, never fabricated", async () => {
  // This fixture event predates W1's new fields entirely (like all 1250 live
  // events) — the columns must still exist and read back as NULL, not "" or
  // any other stand-in for absence (rule:discernment-checks §2).
  const ctx = await buildFixtureIndex();
  try {
    const db = new DatabaseSync(ctx.dbPath);
    const row = db.prepare(
      "SELECT observed_at_commit, observed_on_branch, observed_dirty, by_kind FROM event",
    ).get();
    db.close();

    assert.equal(row.observed_at_commit, null);
    assert.equal(row.observed_on_branch, null);
    assert.equal(row.observed_dirty, null);
    assert.equal(row.by_kind, null);
  } finally {
    await cleanup(ctx);
  }
});

test("graph-index: forward-compat — a fixture event carrying W1's new fields round-trips them, absent stays NULL for others", async () => {
  const ctx = await buildFixtureIndex({
    observed_at_commit: "deadbeef",
    observed_on_branch: "main",
    observed_dirty: false,
    by_kind: "human",
  });
  try {
    const db = new DatabaseSync(ctx.dbPath);
    const row = db.prepare(
      "SELECT observed_at_commit, observed_on_branch, observed_dirty, by_kind FROM event",
    ).get();
    db.close();

    assert.equal(row.observed_at_commit, "deadbeef");
    assert.equal(row.observed_on_branch, "main");
    // sqlite has no boolean type; false is stored/read as 0.
    assert.equal(row.observed_dirty, 0);
    assert.equal(row.by_kind, "human");
  } finally {
    await cleanup(ctx);
  }
});

test("graph-index: v_edge_history exposes event_id and provenance, not just edge_id", async () => {
  const ctx = await buildFixtureIndex();
  try {
    const db = new DatabaseSync(ctx.dbPath);
    const row = db.prepare("SELECT * FROM v_edge_history").get();
    db.close();

    assert.notEqual(row, undefined, "v_edge_history must have a row for the fixture event");
    assert.notEqual(row.event_id, null, "v_edge_history must expose a non-null event_id to join back to a specific event");
    assert.equal(row.by, "rupali");
    assert.equal(row.observed_on_ref, "production");
  } finally {
    await cleanup(ctx);
  }
});

test("graph-index: byte-identical rebuild is preserved after the schema change", async () => {
  const { createHash } = await import("node:crypto");
  const { readFile } = await import("node:fs/promises");

  const stateDir = await mkdtemp(path.join(tmpdir(), "graph-index-events-state-"));
  const workDir = await mkdtemp(path.join(tmpdir(), "graph-index-events-work-"));
  await mkdir(path.join(workDir, "ws"), { recursive: true });
  const dbPath1 = path.join(stateDir, "graph-index-1.db");
  const dbPath2 = path.join(stateDir, "graph-index-2.db");

  const script = `
    import { appendEvent } from ${JSON.stringify(EVENTS_PATH)};
    import { buildModel, emitSqlite } from ${JSON.stringify(GRAPH_INDEX_PATH)};

    const fixture = {
      edge_id: "abcd1234",
      node_id: "ws:lib/pricing.ts",
      disposition: "propagated",
      reason: "test fixture",
      by: "rupali",
      observed_on_ref: "production",
      source_content: "s".repeat(64),
      downstream_content: "d".repeat(64),
    };
    await appendEvent(fixture, { now: new Date("2026-01-01T00:00:00.000Z") });

    const model1 = await buildModel([{ root: ${JSON.stringify(path.join(workDir, "ws"))} }]);
    emitSqlite(model1, ${JSON.stringify(dbPath1)});
    const model2 = await buildModel([{ root: ${JSON.stringify(path.join(workDir, "ws"))} }]);
    emitSqlite(model2, ${JSON.stringify(dbPath2)});
    console.log(JSON.stringify({ ok: true }));
  `;

  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { ...process.env, PROPAGATE_STATE_DIR: stateDir },
  });
  try {
    assert.equal(result.status, 0, `fixture build failed: ${result.stderr}`);
    const hash = (buf) => createHash("sha256").update(buf).digest("hex");
    const [buf1, buf2] = await Promise.all([readFile(dbPath1), readFile(dbPath2)]);
    assert.equal(hash(buf1), hash(buf2), "two rebuilds of the same corpus must be byte-identical");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  }
});
