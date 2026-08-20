import { test } from "node:test";
import assert from "node:assert/strict";
import { pruneMtimes } from "../../lib/core/state.mjs";

test("pruneMtimes drops keys not in the keep set", () => {
  const state = { mtimes: { "/a": 1, "/b": 2, "/c": 3 }, lastRunAt: 0, version: 1 };
  const pruned = pruneMtimes(state, new Set(["/a", "/c"]));
  assert.equal(pruned, 1);
  assert.deepEqual(Object.keys(state.mtimes).sort(), ["/a", "/c"]);
});

import { readState, pruneCrossDecisions } from "../../lib/core/state.mjs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import pathm from "node:path";

test("readState preserves crossDecisions even when mtimes is missing (G5)", async () => {
  const dir = await mkdtemp(pathm.join(tmpdir(), "stateg5-"));
  const sp = pathm.join(dir, "state.json");
  await writeFile(sp, JSON.stringify({ crossDecisions: { "2026-06-14:abc": true }, version: 2 }));
  const s = await readState(sp);
  assert.equal(s.crossDecisions["2026-06-14:abc"], true, "crossDecisions survived missing mtimes");
  assert.deepEqual(s.mtimes, {}, "mtimes filled from empty");
});

test("readState migrates v1 (no crossDecisions) by adding the empty map", async () => {
  const dir = await mkdtemp(pathm.join(tmpdir(), "statemig-"));
  const sp = pathm.join(dir, "state.json");
  await writeFile(sp, JSON.stringify({ mtimes: { "/x": 1 }, lastRunAt: 5, version: 1 }));
  const s = await readState(sp);
  assert.deepEqual(s.crossDecisions, {}, "v1 migrated: crossDecisions added");
  assert.equal(s.mtimes["/x"], 1);
});

test("pruneCrossDecisions drops only old non-live keys", () => {
  const now = Date.parse("2026-07-13T00:00:00Z");
  const state = { crossDecisions: {
    "2024-01-01:old": true,   // >400d, not live → prune
    "2026-07-01:recent": true, // recent, not live → keep
    "2020-01-01:live": true,   // old but live → keep
  }, mtimes: {}, lastRunAt: 0, version: 2 };
  const pruned = pruneCrossDecisions(state, new Set(["2020-01-01:live"]), now);
  assert.equal(pruned, 1);
  assert.ok(!state.crossDecisions["2024-01-01:old"]);
  assert.ok(state.crossDecisions["2026-07-01:recent"]);
  assert.ok(state.crossDecisions["2020-01-01:live"]);
});
