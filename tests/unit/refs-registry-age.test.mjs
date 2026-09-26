/**
 * refs-registry-age.test.mjs — ISSUES N55's visibility half.
 *
 * The refresh now rides the 09:00 digest. This is what notices when it STOPS,
 * which is N55 one level up: the original defect was a correctly-retired
 * component whose replacement nothing invoked, and nothing said so for 32 days.
 *
 * Two thresholds, because "has not run today" and "has stopped" are different
 * facts and only the second deserves a warning. A permanently-warning doctor
 * trains people to ignore it — the reasoning already written at
 * lib/report/doctor/workspaces.mjs's ref-registry block.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { registryAgeDays, REFS_STALE_DAYS, REFS_STOPPED_DAYS } from "../../lib/report/doctor/workspaces.mjs";

const NOW = Date.parse("2026-09-26T12:00:00Z");
const daysAgo = (n) => new Date(NOW - n * 86_400_000).toISOString();

test("age is whole days, measured from captured_at", () => {
  assert.equal(registryAgeDays(daysAgo(0), NOW), 0);
  assert.equal(registryAgeDays(daysAgo(1), NOW), 1);
  assert.equal(registryAgeDays(daysAgo(32), NOW), 32, "the real tree sat at 32 days");
});

test("an unreadable or missing captured_at is NULL, never 0", () => {
  // 0 would read as "refreshed today" — a silent zero standing in for "I could
  // not tell", which is the shape N55 is about (rule:discernment-checks §2).
  for (const bad of [undefined, null, "", "not a date", 12345, {}]) {
    assert.equal(registryAgeDays(bad, NOW), null, `${JSON.stringify(bad)} must be null, not a number`);
  }
});

test("the thresholds separate 'not today' from 'stopped'", () => {
  assert.ok(REFS_STALE_DAYS < REFS_STOPPED_DAYS, "stale must be reachable before stopped");
  // A laptop closed over a weekend is not a broken schedule.
  assert.ok(REFS_STALE_DAYS >= 2, "one missed daily run must not warn");
  // And the condition N55 recorded must land in the loud bucket.
  assert.ok(32 >= REFS_STOPPED_DAYS, "the 32-day case this was filed on must read as STOPPED");
});

test("a freshly refreshed registry is in NEITHER bucket — the negative control", () => {
  // Without this, thresholds of 0 would pass every assertion above while
  // making doctor fire on every healthy tree.
  const age = registryAgeDays(daysAgo(0), NOW);
  assert.ok(age < REFS_STALE_DAYS, "a registry refreshed today must be silent");
});
