/**
 * Tests for lib/reminders/identity-map.mjs — the provisional UUID <-> PR-0NN
 * map (spec "Shape", `docs/plans/2026-09-23-reminders-todo-bridge.md:271-273`).
 *
 * `assignId`/`recordObservation` are pure (never touch disk); `saveIdentityMap`
 * is the one write path, exercised here directly and, for the dry-run
 * guarantee, indirectly via tests/unit/reminders-reconcile.test.mjs.
 *
 * Run: `PROPAGATE_STATE_DIR="${TMPDIR:-/tmp}/propagate-test-state" node --test
 * tests/unit/reminders-identity-map.test.mjs` (G56).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadIdentityMap, saveIdentityMap, assignId, recordObservation, identityMapPath } from "../../lib/reminders/identity-map.mjs";

async function freshDir() {
  return mkdtemp(path.join(tmpdir(), "identity-map-"));
}
const cleanup = (d) => rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });

test("loadIdentityMap on an absent file returns an empty map, never throws", async () => {
  const d = await freshDir();
  try {
    const map = await loadIdentityMap(d);
    assert.deepEqual(map, { version: 1, nextSeq: 1, entries: {} });
  } finally {
    await cleanup(d);
  }
});

test("assignId mints PR-001 for a new reminder id, is pure, and does not write", async () => {
  const d = await freshDir();
  try {
    const before = await loadIdentityMap(d);
    const { map, id, minted } = assignId(before, "uuid-a", "2026-09-25T00:00:00.000Z");
    assert.equal(id, "PR-001");
    assert.equal(minted, true);
    assert.deepEqual(before, { version: 1, nextSeq: 1, entries: {} }, "assignId must not mutate its input");
    const { existsSync } = await import("node:fs");
    assert.equal(existsSync(identityMapPath(d)), false, "assignId alone must not write");
    assert.equal(map.entries["uuid-a"].id, "PR-001");
    assert.equal(map.entries["uuid-a"].lastObserved, null);
  } finally {
    await cleanup(d);
  }
});

test("assignId is idempotent -- a known id is returned, not re-minted", () => {
  const map0 = { version: 1, nextSeq: 1, entries: {} };
  const { map: map1 } = assignId(map0, "uuid-a", "2026-09-25T00:00:00.000Z");
  const { map: map2, id, minted } = assignId(map1, "uuid-a", "2026-09-25T00:00:00.000Z");
  assert.equal(id, "PR-001");
  assert.equal(minted, false);
  assert.equal(map2.nextSeq, 2, "the sequence must not advance a second time for the same id");
});

test("assignId mints sequential ids for distinct reminders", () => {
  let map = { version: 1, nextSeq: 1, entries: {} };
  const ids = [];
  for (const uuid of ["a", "b", "c"]) {
    const r = assignId(map, uuid, "2026-09-25T00:00:00.000Z");
    map = r.map;
    ids.push(r.id);
  }
  assert.deepEqual(ids, ["PR-001", "PR-002", "PR-003"]);
});

test("recordObservation throws for an id with no identity yet -- refuses to guess", () => {
  const map = { version: 1, nextSeq: 1, entries: {} };
  assert.throws(() => recordObservation(map, "unknown", { completed: true, completedAt: "x" }), /no identity yet/);
});

test("saveIdentityMap + loadIdentityMap round-trip byte-for-byte in shape", async () => {
  const d = await freshDir();
  try {
    let map = { version: 1, nextSeq: 1, entries: {} };
    ({ map } = assignId(map, "uuid-a", "2026-09-25T00:00:00.000Z"));
    map = recordObservation(map, "uuid-a", { completed: true, completedAt: "2026-09-25T00:00:00.000Z" });

    await saveIdentityMap(map, d);
    const reloaded = await loadIdentityMap(d);
    assert.deepEqual(reloaded, map);
  } finally {
    await cleanup(d);
  }
});

test("a damaged identity-map.json throws rather than silently returning an empty map", async () => {
  const d = await freshDir();
  try {
    await mkdir(path.dirname(identityMapPath(d)), { recursive: true });
    await writeFile(identityMapPath(d), "{not json", "utf8");
    await assert.rejects(() => loadIdentityMap(d), /not valid JSON/);
  } finally {
    await cleanup(d);
  }
});

test("a well-formed-JSON but wrong-shaped identity-map.json throws rather than being read as empty", async () => {
  const d = await freshDir();
  try {
    await mkdir(path.dirname(identityMapPath(d)), { recursive: true });
    await writeFile(identityMapPath(d), JSON.stringify({ oops: true }), "utf8");
    await assert.rejects(() => loadIdentityMap(d), /expected \{version, nextSeq, entries\} shape/);
  } finally {
    await cleanup(d);
  }
});
