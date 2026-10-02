/**
 * allowedDispositions — ONE predicate, and every surface that offers a
 * disposition agrees with it.
 *
 * The defect this pins: `lib/report/queue.mjs` computed `allowed` from the
 * DIVERGED rule alone, so for an edge whose source was itself unsettled the
 * queue (and the UI built on it) offered `propagated` and the write path then
 * refused it. The CLI enforced an ordering guard the other two surfaces did not
 * know existed.
 *
 * The parity table runs states x blocked x every disposition through the pure
 * function, the queue's `allowed`, and the UI's two gates, and asserts they
 * return the same answer for every cell. The CLI leg, which has to run verify
 * as a process, is in tests/cli/allowed-parity.test.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  allowedDispositions, orderingBlocks, divergedGuard, divergedRefusal,
  GUARD_EXEMPT, shellQuote, verifyCommand,
} from "../../lib/edges/disposition.mjs";
import { DISPOSITIONS } from "../../lib/edges/events.mjs";
import { buildQueue } from "../../lib/report/queue.mjs";
import { validateWrite, orderingRefusal } from "../../commands/ui.mjs";

const STATES = ["DRIFTED", "REVERSED", "DIVERGED", "UNMATCHED"];
const BLOCKER = { edge_id: "up00001", from: "/r/up.md", to: "/r/a.md", state: "NEVER_VERIFIED" };

function row(state) {
  return {
    edge_id: "e1", node_id: "r:a.md", state,
    source: { path: "/r/a.md" }, downstream: { path: "/r/b.md" }, why: "w",
  };
}

test("the floor: the table covers the states and every disposition", () => {
  // A parity test over an empty population passes by matching nothing.
  assert.ok(STATES.length >= 4);
  assert.ok(DISPOSITIONS.length >= 8, `only ${DISPOSITIONS.length} dispositions — the loop below has gone blind`);
});

test("DIVERGED accepts only both-reconciled", () => {
  const a = allowedDispositions(row("DIVERGED"), []);
  assert.deepEqual(a.allowed, ["both-reconciled"]);
  assert.deepEqual(a.viaOutOfOrder, []);
});

test("a blocked non-DIVERGED edge accepts only the GUARD_EXEMPT set; the rest are the --out-of-order route", () => {
  const a = allowedDispositions(row("DRIFTED"), [BLOCKER]);
  assert.deepEqual([...a.allowed].sort(), [...GUARD_EXEMPT].sort());
  assert.ok(a.blocked);
  assert.ok(a.viaOutOfOrder.includes("propagated"));
  assert.ok(a.viaOutOfOrder.includes("baselined"), "baselined pins, so it is not exempt");
  assert.ok(!a.viaOutOfOrder.includes("both-reconciled"), "refused by the DIVERGED pairing, not by ordering");
});

test("a DIVERGED edge that is also blocked reaches both-reconciled only via --out-of-order", () => {
  const a = allowedDispositions(row("DIVERGED"), [BLOCKER]);
  assert.deepEqual(a.allowed, []);
  assert.deepEqual(a.viaOutOfOrder, ["both-reconciled"]);
});

test("baselined is offered wherever verify accepts it, and wontfix/baselined require a reason", () => {
  const a = allowedDispositions(row("DRIFTED"), []);
  assert.ok(a.allowed.includes("baselined"));
  assert.deepEqual([...a.needsReason].sort(), ["baselined", "wontfix"]);
});

test("PARITY: states x blocked x dispositions — pure fn, queue, and both UI gates agree in every cell", () => {
  let cells = 0;
  for (const state of STATES) {
    for (const blocked of [false, true]) {
      const blockers = blocked ? [BLOCKER] : [];
      const r = row(state);
      const expected = allowedDispositions(r, blockers);

      // Queue: built the way queuePayload builds it, order entry carrying blockedBy.
      const order = new Map([["e1", { index: 0, layer: 0, blockedBy: blockers }]]);
      const [item] = buildQueue([r], new Map(), { order });
      // UNMATCHED is not actionable-filtered out: isActionable includes it.
      assert.deepEqual(item.allowed, expected.allowed, `queue allowed, ${state} blocked=${blocked}`);
      assert.deepEqual(item.viaOutOfOrder, expected.viaOutOfOrder, `queue viaOutOfOrder, ${state} blocked=${blocked}`);

      for (const d of DISPOSITIONS) {
        cells += 1;
        const accepted = expected.allowed.includes(d);

        // UI gate 1: validateWrite reads the queue item's own list.
        const invalid = validateWrite({ edge_id: "e1", disposition: d, reason: "a long enough reason" }, item);
        assert.equal(invalid === null, accepted, `validateWrite ${d}, ${state} blocked=${blocked}: ${invalid}`);

        // UI gate 2: the write-time ordering refusal (fresh rows, not the snapshot).
        const refusal = orderingRefusal(expected, d);
        assert.equal(refusal !== null, expected.viaOutOfOrder.includes(d), `orderingRefusal ${d}, ${state} blocked=${blocked}`);

        // The two guards verify enforces, composed by hand: an accepted
        // disposition passes BOTH; a refused one fails at least one.
        const passes = !divergedGuard(state, d) && !orderingBlocks(blockers, d);
        assert.equal(passes, accepted, `guards vs allowedDispositions, ${d}, ${state} blocked=${blocked}`);
      }
    }
  }
  assert.equal(cells, STATES.length * 2 * DISPOSITIONS.length, "every cell was visited");
});

test("a queue row with no worklist entry is not silently treated as blocked or unblocked-and-verified", () => {
  const [item] = buildQueue([row("DRIFTED")], new Map(), {});
  assert.equal(item.blocked, null);
  assert.match(item.orderMissing, /no worklist/);
});

test("verifyCommand always selects with --edge, never --glob, and quotes the reason as one argument", () => {
  const cmd = verifyCommand({ edge: "abc12345", disposition: "wontfix", reason: `it's "quoted" $HOME \`x\`` });
  assert.match(cmd, /^propagate verify --edge abc12345 --disposition wontfix --reason '/);
  assert.doesNotMatch(cmd, /--glob/);
  assert.equal(shellQuote("a'b"), `'a'\\''b'`);
});

test("the DIVERGED refusal keeps its warning AND prints the corrected command", () => {
  const msg = divergedRefusal({ edge_id: "dead0001", state: "DIVERGED" }, "propagated");
  assert.match(msg, /a human must look at both sides first/);
  assert.match(msg, /propagate verify --edge dead0001 --disposition both-reconciled --reason '/);
  assert.equal(divergedRefusal({ edge_id: "x", state: "DIVERGED" }, "both-reconciled"), null);
});
