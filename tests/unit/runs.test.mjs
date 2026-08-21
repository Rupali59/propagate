/**
 * Tests for lib/core/runs.mjs — §3 of
 * ~/.claude/plans/status-temporal-plum.md (lane W3).
 *
 * Same isolation discipline as tests/watcher/events.test.mjs: RUNS_DIR is a
 * module-level const computed from STATE_DIR at import time, so every test
 * that writes must run in a subprocess with PROPAGATE_STATE_DIR scoped to a
 * fresh tmpdir — never the real store (docs/GOTCHAS.md G54).
 *
 * Run: `npm test` (node --test tests/)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

async function withScopedStore(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), "runs-store-"));
  try {
    await fn(stateDir);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

function runInSubprocess(script, env) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env,
  });
  assert.equal(result.status, 0, `subprocess failed: ${result.stderr}`);
  return JSON.parse(result.stdout.trim().split("\n").pop());
}

function baseRun(overrides = {}) {
  return {
    roots: ["/tmp/example-workspace"],
    refs: { "/tmp/example-workspace": "working-tree" },
    edge_counts: { CLEAN: 3, DRIFTED: 1 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// RED #1 — a reconcile run appends exactly one run record; a second run
// appends a second.
// ---------------------------------------------------------------------------

test("appendRun: one call appends exactly one run record", async () => {
  await withScopedStore(async (stateDir) => {
    const out = runInSubprocess(
      `
      import { appendRun, readRuns } from ${JSON.stringify(
        path.resolve("lib/core/runs.mjs"),
      )};
      await appendRun(${JSON.stringify(baseRun())});
      const { runs, malformed } = await readRuns();
      console.log(JSON.stringify({ count: runs.length, malformed }));
      `,
      { ...process.env, PROPAGATE_STATE_DIR: stateDir },
    );
    assert.equal(out.count, 1);
    assert.equal(out.malformed, 0);
  });
});

test("appendRun: a second run appends a second record, not overwriting the first", async () => {
  await withScopedStore(async (stateDir) => {
    const out = runInSubprocess(
      `
      import { appendRun, readRuns } from ${JSON.stringify(
        path.resolve("lib/core/runs.mjs"),
      )};
      const r1 = await appendRun(${JSON.stringify(baseRun({ edge_counts: { CLEAN: 3 } }))});
      const r2 = await appendRun(${JSON.stringify(baseRun({ edge_counts: { CLEAN: 4 } }))});
      const { runs } = await readRuns();
      console.log(JSON.stringify({
        count: runs.length,
        distinctIds: new Set(runs.map((r) => r.run_id)).size,
        r1Id: r1.run_id,
        r2Id: r2.run_id,
      }));
      `,
      { ...process.env, PROPAGATE_STATE_DIR: stateDir },
    );
    assert.equal(out.count, 2);
    assert.equal(out.distinctIds, 2);
    assert.notEqual(out.r1Id, out.r2Id);
  });
});

test("appendRun: every stamped record carries run_id and ts", async () => {
  await withScopedStore(async (stateDir) => {
    const out = runInSubprocess(
      `
      import { appendRun } from ${JSON.stringify(path.resolve("lib/core/runs.mjs"))};
      const stamped = await appendRun(${JSON.stringify(baseRun())});
      console.log(JSON.stringify({ hasRunId: typeof stamped.run_id === "string" && stamped.run_id.length > 0, hasTs: typeof stamped.ts === "string" }));
      `,
      { ...process.env, PROPAGATE_STATE_DIR: stateDir },
    );
    assert.equal(out.hasRunId, true);
    assert.equal(out.hasTs, true);
  });
});

// ---------------------------------------------------------------------------
// RED #4 — a malformed line in the run store does not crash a read.
// ---------------------------------------------------------------------------

test("readRuns: a malformed line is counted, not thrown, and does not hide the good rows", async () => {
  await withScopedStore(async (stateDir) => {
    const out = runInSubprocess(
      `
      import { appendRun, readRuns, shardPathForTs } from ${JSON.stringify(
        path.resolve("lib/core/runs.mjs"),
      )};
      import { appendFile } from "node:fs/promises";
      const now = new Date("2026-08-20T00:00:00.000Z");
      await appendRun(${JSON.stringify(baseRun())}, { now });
      // Corrupt the shard with a garbage line.
      await appendFile(shardPathForTs(now), "{not valid json\\n");
      await appendRun(${JSON.stringify(baseRun())}, { now });
      const { runs, malformed } = await readRuns();
      console.log(JSON.stringify({ count: runs.length, malformed }));
      `,
      { ...process.env, PROPAGATE_STATE_DIR: stateDir },
    );
    assert.equal(out.count, 2, "the two well-formed rows must still be readable");
    assert.equal(out.malformed, 1, "the corrupt line must be counted, not silently dropped");
  });
});

test("appendRun: rejects a record missing roots/refs/edge_counts", async () => {
  await withScopedStore(async (stateDir) => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
        import { appendRun } from ${JSON.stringify(path.resolve("lib/core/runs.mjs"))};
        try {
          await appendRun({ refs: {}, edge_counts: {} });
          console.log(JSON.stringify({ threw: false }));
        } catch (err) {
          console.log(JSON.stringify({ threw: true, message: err.message }));
        }
        `,
      ],
      { encoding: "utf8", env: { ...process.env, PROPAGATE_STATE_DIR: stateDir } },
    );
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout.trim().split("\n").pop());
    assert.equal(out.threw, true);
    assert.match(out.message, /roots/);
  });
});
