/**
 * The settle gauge: median gap between consecutive same-session verifies.
 * Batch writes excluded; events with no session_id are not counted -- and the
 * description says so rather than reporting a bare zero.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { sessionGapMedian, describeCadence } from "../../lib/report/verify-cadence.mjs";

const at = (s, session = "s1") => ({ ts: new Date(Date.UTC(2026, 9, 2, 0, 0, s)).toISOString(), session_id: session });

test("median of the gaps between consecutive verifies in one session", () => {
  // gaps: 10, 30, 20 -> median 20
  const r = sessionGapMedian([at(0), at(10), at(40), at(60)]);
  assert.equal(r.gaps, 3);
  assert.equal(r.medianSec, 20);
});

test("a batch write (gaps under 2s) is excluded, not averaged in", () => {
  // One `verify --node X` writing 4 events a few ms apart, then a real 60s gap.
  const batch = [0, 0.1, 0.2, 0.3].map((s) => at(s));
  const r = sessionGapMedian([...batch, at(60.3)]);
  assert.equal(r.batchGapsExcluded, 3);
  assert.equal(r.gaps, 1);
  assert.equal(r.medianSec, 60);
});

test("gaps are never taken ACROSS sessions", () => {
  const r = sessionGapMedian([at(0, "a"), at(100, "b"), at(200, "a")]);
  assert.equal(r.sessions, 2);
  assert.equal(r.gaps, 1, "only a's own two events form a gap");
  assert.equal(r.medianSec, 200);
});

test("events with no session_id are not counted — absent means unknown, and the line says so", () => {
  const r = sessionGapMedian([{ ts: "2026-09-01T00:00:00Z" }, { ts: "2026-09-01T00:05:00Z" }]);
  assert.equal(r.stamped, 0);
  assert.equal(r.medianSec, null);
  assert.match(describeCadence(r), /no session-stamped verify events yet \(0 of 2\)/);
  assert.match(describeCadence(r), /unknown, not human/);
});

test("stamped events but only batch gaps: says there is nothing to take a median of", () => {
  const r = sessionGapMedian([at(0), at(0.5)]);
  assert.equal(r.medianSec, null);
  assert.match(describeCadence(r), /nothing to take a median of/);
});
