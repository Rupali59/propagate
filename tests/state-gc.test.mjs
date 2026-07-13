import { test } from "node:test";
import assert from "node:assert/strict";
import { pruneMtimes } from "../lib/state.mjs";

test("pruneMtimes drops keys not in the keep set", () => {
  const state = { mtimes: { "/a": 1, "/b": 2, "/c": 3 }, lastRunAt: 0, version: 1 };
  const pruned = pruneMtimes(state, new Set(["/a", "/c"]));
  assert.equal(pruned, 1);
  assert.deepEqual(Object.keys(state.mtimes).sort(), ["/a", "/c"]);
});
