/**
 * lib/edges/states.mjs: the state -> action table every surface shows (graph-model plan, "State -> action"),
 * and the sets `graph` blocks and lists by. A deferred edge is parked and never blocks (#118).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { EDGE_STATES, UNSETTLED, ACTIONABLE, DISPLAY_ORDER, ACTIONS, actionOf } from "../../lib/edges/states.mjs";
import { isUnsettled } from "../../lib/graph/graph.mjs";

test("the plan's state -> action table, one row per state", () => {
  const want = {
    CLEAN: "done", DECOUPLED: "done", DRIFTED: "judge", REVERSED: "judge", DIVERGED: "pick-a-side",
    DEFERRED: "parked", NEVER_VERIFIED: "never-judged",
    UNMATCHED: "broken", UNRESOLVABLE: "broken", NOT_PRESENT_ON_REF: "broken",
  };
  assert.deepEqual(Object.keys(want).sort(), [...EDGE_STATES].sort(), "the table covers exactly the closed list");
  for (const [s, a] of Object.entries(want)) assert.equal(actionOf(s), a, s);
});

test("blocked only replaces the three states a person could otherwise act on", () => {
  for (const s of ["DRIFTED", "REVERSED", "DIVERGED"]) assert.equal(actionOf(s, true), ACTIONS.BLOCKED);
  for (const s of ["CLEAN", "DEFERRED", "NEVER_VERIFIED", "UNMATCHED"]) assert.equal(actionOf(s, true), actionOf(s, false));
});

test("an unrecognised state is 'unknown', never silently done", () => {
  assert.equal(actionOf("SOMETHING_NEW"), ACTIONS.UNKNOWN);
});

test("DEFERRED and DECOUPLED never block; every actionable state is in the display order", () => {
  assert.equal(isUnsettled("DEFERRED"), false);
  assert.equal(isUnsettled("DECOUPLED"), false);
  assert.equal(isUnsettled("NEVER_VERIFIED"), true);
  assert.ok(UNSETTLED.size >= 5 && ACTIONABLE.size >= 4, "the sets have gone empty");
  assert.deepEqual([...DISPLAY_ORDER].sort(), [...EDGE_STATES].sort(), "DISPLAY_ORDER ranks every state exactly once");
});
