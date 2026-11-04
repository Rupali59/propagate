/**
 * edgeEventIndex and the readers that take it (#127 phase 0).
 *
 * Literal fixtures throughout: the order a tie breaks in, the deferral
 * disagreement the census found, and the count of store reads a rekey chain costs
 * are all facts about a hand-written log, so the log is written out here and
 * never built through the code under test.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { indexEvents } from "../../lib/edges/events.mjs";
import { deriveEdgeState, reduceLastPinning, reduceLastDeferred, deferralAfterPin } from "../../lib/edges/reconcile.mjs";
import { foldWindow, streamPayload } from "../../lib/report/stream.mjs";
import { historyFromEvents } from "../../lib/report/queue.mjs";
import { describeWhy } from "../../lib/edges/why.mjs";

const T = (n) => `2026-10-${String(n).padStart(2, "0")}T00:00:00.000Z`;
const pin = (edge, ts, id, disposition = "propagated") => ({
  edge_id: edge, node_id: "n", ts, event_id: id, disposition, by: "t", reason: "r",
  source_content: "s1", downstream_content: "d1",
});
const defer = (edge, ts, id) => ({ edge_id: edge, node_id: "n", ts, event_id: id, disposition: "deferred", by: "t", reason: "later" });

test("edgeEventIndex: events order by (ts, event_id), and a ts tie breaks on event_id", () => {
  // Written OUT of order on purpose, with three events sharing one ts. event_ids are ULID-shaped
  // strings; only their string order matters.
  const log = [
    pin("e1", T(5), "01C"),
    pin("e1", T(5), "01A"),
    pin("e2", T(3), "01Z"),
    pin("e1", T(1), "01Q"),
    pin("e1", T(5), "01B"),
  ];
  const idx = indexEvents(log);
  assert.deepEqual(idx.byEdge.get("e1").map((e) => e.event_id), ["01Q", "01A", "01B", "01C"]);
  assert.deepEqual(idx.events.map((e) => e.event_id), ["01Q", "01Z", "01A", "01B", "01C"]);
  assert.deepEqual([...idx.byEdge.keys()].sort(), ["e1", "e2"]);
  assert.equal(log[0].event_id, "01C", "the input array is not reordered");
});

test("edgeEventIndex: an event with no edge_id stays in events and is in no edge's list; malformed is carried", () => {
  const idx = indexEvents([{ ts: T(1), event_id: "x", disposition: "propagated" }, pin("e1", T(2), "y")], 3);
  assert.equal(idx.events.length, 2);
  assert.equal(idx.byEdge.size, 1);
  assert.equal(idx.malformed, 3);
});

test("the reducers settle a same-ts tie on event_id, whatever order the log lists them in", () => {
  const a = pin("e1", T(5), "01A", "propagated");
  const b = pin("e1", T(5), "01B", "wontfix");
  assert.equal(reduceLastPinning([a, b]).get("e1").event_id, "01B");
  assert.equal(reduceLastPinning([b, a]).get("e1").event_id, "01B");
  const d1 = defer("e1", T(5), "01A");
  const d2 = defer("e1", T(5), "01B");
  assert.equal(reduceLastDeferred([d2, d1]).get("e1").event_id, "01B");
});

// ── stream.foldWindow agrees with reconcile on deferred edges ────────────────

/** What reconcile says about an edge with this log, content unchanged since the pin. */
function reconcileState(events) {
  const last = reduceLastPinning(events).get("e1") ?? null;
  const deferred = reduceLastDeferred(events).get("e1") ?? null;
  return deriveEdgeState({
    last,
    deferredAfterPin: deferralAfterPin(last, deferred),
    sourceId: last?.source_content,
    downstreamId: last?.downstream_content,
  });
}

const DEFERRAL_LOGS = {
  "only a deferral": [defer("e1", T(2), "a")],
  "a pin, then a later deferral (the census disagreement)": [pin("e1", T(1), "a"), defer("e1", T(2), "b")],
  "a deferral, then a pin": [defer("e1", T(1), "a"), pin("e1", T(2), "b")],
  "a decoupled pin, then a deferral": [pin("e1", T(1), "a", "decoupled"), defer("e1", T(2), "b")],
  "two deferrals": [defer("e1", T(1), "a"), defer("e1", T(2), "b")],
};

for (const [name, events] of Object.entries(DEFERRAL_LOGS)) {
  test(`foldWindow and reconcile agree on whether the edge is deferred: ${name}`, () => {
    const standing = foldWindow(events).get("e1");
    const streamSaysOpen = standing.disposition === "deferred";
    assert.equal(streamSaysOpen, reconcileState(events) === "DEFERRED", `reconcile says ${reconcileState(events)}, stream says open=${streamSaysOpen}`);
  });
}

test("streamPayload: a window holding only the later deferral does not hide the pin outside it", async () => {
  const idx = indexEvents([pin("e1", T(1), "a"), defer("e1", T(20), "b"), defer("e2", T(21), "c")]);
  const payload = await streamPayload({ since: T(15), index: idx });
  const byId = Object.fromEntries(payload.changed.map((c) => [c.edge_id, c]));
  assert.equal(byId.e1.open, false, "e1 was pinned at day 1; the day-20 deferral does not reopen it (reconcile: CLEAN)");
  assert.equal(byId.e1.parkedAfterPin, true);
  assert.equal(byId.e1.disposition, "deferred", "the row still reports the most recent event");
  assert.equal(byId.e1.standing, "propagated");
  assert.equal(byId.e2.open, true, "e2 has only a deferral (reconcile: DEFERRED)");
  assert.equal(payload.summary.open, 1);
  assert.equal(payload.summary.closed, 1);
});

test("streamPayload: judgedCount comes from the same index as the fold", async () => {
  const idx = indexEvents([pin("e1", T(1), "a"), pin("e1", T(2), "b", "no-change-needed"), pin("e1", T(20), "c")]);
  const payload = await streamPayload({ since: T(15), index: idx });
  assert.equal(payload.changed[0].judgedCount, 3);
  assert.equal(payload.changed[0].noiseRatio, 1 / 3);
});

test("historyFromEvents takes an index as readily as an event array", () => {
  const events = [pin("e1", T(1), "a"), pin("e1", T(2), "b")];
  assert.equal(historyFromEvents(indexEvents(events, 2)).get("e1").total, 2);
  assert.equal(historyFromEvents(indexEvents(events, 2)).malformed, 2);
  assert.equal(historyFromEvents(events, 1).malformed, 1);
});

// ── why reads the log once for a whole chain ─────────────────────────────────

test("why on a two-hop rekey chain reads the log once, not once per hop", async () => {
  const rekey = (edge, from, ts, id) => ({ ...pin(edge, ts, id, "rekeyed"), from_edge_id: from });
  const log = [
    pin("e1", T(1), "a"),
    rekey("e2", "e1", T(2), "b"),
    rekey("e3", "e2", T(3), "c"),
  ];
  let reads = 0;
  const result = await describeWhy("e3", {
    all: true,
    readIndex: async () => {
      reads++;
      return indexEvents(log);
    },
  });
  assert.equal(reads, 1, "one read for e3 and both hops back");
  assert.equal(result.status, "found");
  assert.deepEqual(result.previous.map((p) => p.edge_id), ["e2", "e1"], "the chain was followed through both hops");
  assert.equal(result.totalEvents, 3);
});
