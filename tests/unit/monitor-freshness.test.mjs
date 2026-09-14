/**
 * lib/report/doctor/environment.mjs — the monitor freshness verdict.
 *
 * Pure logic over synthetic stamps; never reads ~/.propagate/monitor.log and
 * never shells out to sysctl.
 *
 * WHY THIS FILE EXISTS. Until 2026-09-14 the check measured wall-clock elapsed
 * since the last logged run, against a 90-minute tolerance. launchd does not
 * fire a StartInterval through sleep, so a laptop closed overnight and a dead
 * agent produced the identical verdict. Measured that morning: an 8h12m sleep
 * failed the check with `last exit code = 0` and 41 clean runs behind it. The
 * instrument was answering a wider question than the one asked
 * (rule:discernment-checks §4).
 *
 * Per rule:safety-flag-needs-a-test, the load-bearing assertion is not "the
 * overnight case passes" — a check wired to always pass would satisfy that.
 * It is that the SAME run gap flips to stale once the sleep no longer explains
 * it. Both directions, or neither is evidence.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { monitorFreshness } from "../../lib/report/doctor/environment.mjs";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const STALE_AFTER_MS = 3 * 1800 * 1000; // 90 min — 3x the StartInterval
const NOW = Date.UTC(2026, 8, 14, 23, 18, 0); // the morning this was found

test("an 8h run gap explained by an 8h sleep is NOT stale", () => {
  const f = monitorFreshness({
    lastRunMs: NOW - 8 * HOUR,
    wakeMs: NOW - 5 * MIN, // woke five minutes ago
    nowMs: NOW,
    staleAfterMs: STALE_AFTER_MS,
  });
  assert.equal(f.stale, false, "sleep accounts for the whole gap — the agent was never given a slot");
  assert.equal(f.mins, 480, "wall-clock age is still reported honestly");
  assert.equal(f.awakeMins, 5, "but the verdict is taken on awake-elapsed");
});

test("the SAME 8h run gap with the machine awake throughout IS stale", () => {
  const f = monitorFreshness({
    lastRunMs: NOW - 8 * HOUR,
    wakeMs: NOW - 8 * HOUR - MIN, // awake the entire time
    nowMs: NOW,
    staleAfterMs: STALE_AFTER_MS,
  });
  assert.equal(f.stale, true, "nothing explains the silence — this is the real failure the check exists for");
  assert.equal(f.awakeMins, 480);
});

test("a wake OLDER than the last run does not shorten the age", () => {
  // Machine woke days ago and the monitor ran since. min() must pick the run
  // age, not the (larger) wake age — the guard against the fix inverting.
  const f = monitorFreshness({
    lastRunMs: NOW - 10 * MIN,
    wakeMs: NOW - 3 * 24 * HOUR,
    nowMs: NOW,
    staleAfterMs: STALE_AFTER_MS,
  });
  assert.equal(f.stale, false);
  assert.equal(f.awakeMins, 10, "awake-elapsed is the run age here, not three days");
});

test("a fresh run is not stale and reports no sleep note", () => {
  const f = monitorFreshness({
    lastRunMs: NOW - 12 * MIN,
    wakeMs: NOW - 3 * 24 * HOUR,
    nowMs: NOW,
    staleAfterMs: STALE_AFTER_MS,
  });
  assert.equal(f.stale, false);
  assert.equal(f.mins, f.awakeMins, "equal mins suppress the ', N min of it awake' note");
});

test("crashing overrides freshness — a loaded, failing agent is stale however recent", () => {
  const f = monitorFreshness({
    lastRunMs: NOW - MIN,
    wakeMs: NOW - 3 * 24 * HOUR,
    nowMs: NOW,
    staleAfterMs: STALE_AFTER_MS,
    crashing: true,
  });
  assert.equal(f.stale, true, "the stderr-newer-than-stdout tell must survive this change");
});

test("an unreadable wake stamp on darwin falls back to wall-clock AND says so", () => {
  const f = monitorFreshness({
    lastRunMs: NOW - 8 * HOUR,
    wakeMs: null,
    nowMs: NOW,
    staleAfterMs: STALE_AFTER_MS,
    sleepAware: true,
  });
  assert.equal(f.stale, true, "without a wake stamp the old wall-clock verdict stands — it must not silently pass");
  assert.equal(f.sleepBlind, true, "and the caller must be able to say the sleep was unaccounted");
});

test("a platform with no wake concept is not reported as sleep-blind", () => {
  // linux: null is how that platform works, not a probe failure. "no wake
  // stamp exists" and "the probe failed" are different facts (§2).
  const f = monitorFreshness({
    lastRunMs: NOW - 8 * HOUR,
    wakeMs: null,
    nowMs: NOW,
    staleAfterMs: STALE_AFTER_MS,
    sleepAware: false,
  });
  assert.equal(f.stale, true);
  assert.equal(f.sleepBlind, false);
});
