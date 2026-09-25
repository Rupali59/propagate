/**
 * Tests for lib/reminders/reconcile-log.mjs — the append-only reconciliation
 * log (H2, `docs/plans/2026-09-23-reminders-todo-bridge.md:93-97`).
 *
 * Run: `PROPAGATE_STATE_DIR="${TMPDIR:-/tmp}/propagate-test-state" node --test
 * tests/unit/reminders-reconcile-log.test.mjs` (G56).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { readReconcileLog, appendReconcileEvent, reconcileLogPath } from "../../lib/reminders/reconcile-log.mjs";

async function freshDir() {
  return mkdtemp(path.join(tmpdir(), "reconcile-log-"));
}
const cleanup = (d) => rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });

test("readReconcileLog on an absent file returns an empty result, never throws", async () => {
  const d = await freshDir();
  try {
    const { rows, malformed } = await readReconcileLog(d);
    assert.deepEqual(rows, []);
    assert.equal(malformed, 0);
  } finally {
    await cleanup(d);
  }
});

test("appendReconcileEvent + readReconcileLog round-trip, append-only across two calls", async () => {
  const d = await freshDir();
  try {
    await appendReconcileEvent({ ts: "2026-09-25T00:00:00.000Z", rows: [{ a: 1 }] }, d);
    await appendReconcileEvent({ ts: "2026-09-25T09:00:00.000Z", rows: [{ a: 2 }] }, d);
    const { rows, malformed } = await readReconcileLog(d);
    assert.equal(malformed, 0);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].ts, "2026-09-25T00:00:00.000Z");
    assert.equal(rows[1].ts, "2026-09-25T09:00:00.000Z");
  } finally {
    await cleanup(d);
  }
});

test("a malformed line is counted, never thrown away silently (rule:discernment-checks §2)", async () => {
  const d = await freshDir();
  try {
    await mkdir(path.dirname(reconcileLogPath(d)), { recursive: true });
    await writeFile(reconcileLogPath(d), '{"ok":true}\nnot json\n{"ok":true}\n', "utf8");
    const { rows, malformed } = await readReconcileLog(d);
    assert.equal(rows.length, 2);
    assert.equal(malformed, 1);
  } finally {
    await cleanup(d);
  }
});

test("blank lines are skipped, not counted as malformed", async () => {
  const d = await freshDir();
  try {
    await mkdir(path.dirname(reconcileLogPath(d)), { recursive: true });
    await writeFile(reconcileLogPath(d), '{"ok":true}\n\n\n{"ok":true}\n', "utf8");
    const { rows, malformed } = await readReconcileLog(d);
    assert.equal(rows.length, 2);
    assert.equal(malformed, 0);
  } finally {
    await cleanup(d);
  }
});
