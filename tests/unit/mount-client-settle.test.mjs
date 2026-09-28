/**
 * mount-client-settle.test.mjs — the harness waits on a CONDITION, not a clock.
 *
 * PR-008 was one line: `await new Promise((r) => setTimeout(r, 30))`. `node --test`
 * parallelises across files, so under contention 30ms was not enough for the mount
 * effect's fetch to resolve and Preact to re-render, and assertions ran against the
 * loading placeholder — the actual value in every recorded occurrence. It escalated
 * from 2 failures to 6 in a single day as mount-based tests were added.
 *
 * These tests exist because the replacement is itself a guard, and a guard with no
 * test proving it can fail is worse than none. The suite that USES the harness
 * cannot test it: every one of those tests passes under a long-enough sleep, which
 * is exactly how the defect survived. So the harness is exercised here directly,
 * with routes that resolve on a schedule this file controls.
 *
 * Deliberately NOT asserted: any duration. A test that checks "settled within Nms"
 * would reintroduce the thing being removed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { mountClient } from "../helpers/mount-client.mjs";

/**
 * The MINIMUM inbox payload the client can render without crashing.
 *
 * My first attempt here was `{ items: [], generated_at }`, invented rather than
 * derived, and the client threw `Cannot read properties of undefined (reading
 * 'worklist')`. That failure looked like the harness settling early and was my
 * fixture being the wrong shape — worth recording, because a wrong fixture and a
 * broken wait produce the same symptom.
 *
 * Kept deliberately empty rather than copied from `ui-client.test.mjs`: these
 * tests are about WHEN the harness returns, not what renders, so a rich payload
 * would couple them to the client's presentation for no gain.
 */
const INBOX = {
  fatal: null,
  declared: 0,
  expanded: 0,
  divisions: {
    worklist: { error: null, actionable: 0, unplaced: 0, ready: [], blocked: [] },
    parked: { error: null, items: [] },
    gap: { error: null, items: [] },
    analytics: { error: null },
    stream: { error: null, items: [] },
    conflicts: { error: null, items: [] },
    reference: { error: null, items: [] },
    graph: { error: null },
  },
};

/** A promise that resolves after `ticks` macrotasks — far more than any sleep. */
function afterTicks(value, ticks) {
  let p = Promise.resolve();
  for (let i = 0; i < ticks; i += 1) p = p.then(() => new Promise((r) => setTimeout(r, 0)));
  return p.then(() => value);
}

test("a route that resolves LATE is still awaited — the case a sleep gets wrong", async () => {
  // 40 chained macrotasks is well past anything a fixed sleep would have covered
  // at the old 30ms, and the point is that no number appears in the harness at all.
  const { app, calls } = await mountClient({ inbox: afterTicks(INBOX, 40) });
  assert.deepEqual(calls, ["/api/inbox"], "the mount must have fetched");
  const text = app.textContent ?? "";
  assert.ok(text.length > 0, "the pane must have rendered something");
  assert.ok(
    !/reading the reminders list/i.test(text),
    `settled on the loading placeholder — the condition returned before the data arrived: ${JSON.stringify(text.slice(0, 120))}`,
  );
});

test("a fetch that NEVER resolves fails loudly, and names what was pending", async () => {
  // The failing case. Without it this is a loop that might simply always exit
  // early, and every test above would still pass.
  await assert.rejects(
    () => mountClient({ inbox: new Promise(() => {}), timeoutMs: 120 }),
    (err) => {
      assert.match(err.message, /did not settle within 120ms/);
      assert.match(err.message, /fetch\(es\) still in flight/, "the message must say WHY it gave up");
      assert.match(err.message, /\/api\/inbox/, "and which endpoint was outstanding");
      return true;
    },
  );
});

test("the timeout message carries the last DOM signature, not just a duration", async () => {
  // rule:discernment-checks §2. A timeout that says only "timed out" sends the next
  // reader back to guessing at durations, which is where PR-008 started.
  await assert.rejects(
    () => mountClient({ inbox: new Promise(() => {}), timeoutMs: 120 }),
    /Last DOM signature/,
  );
});

// DROPPED: "an unstubbed route still throws rather than settling empty".
//
// The harness's header promises it, and it does — but by raising an unhandled
// rejection inside a timer, which terminates the process rather than rejecting
// `mountClient()`. That is loud, which is what the promise was about, and it is not
// cleanly assertable without installing an uncaughtException handler. It is also
// pre-existing behaviour this rewrite did not touch, so a test written here would
// be asserting something I had not changed and could not observe properly.
//
// Recorded rather than silently omitted: the gap is that "fails loudly" and "fails
// in a way a test can catch" are different properties, and only the first is true.

test("settling does not depend on how many ticks the data takes", async () => {
  // The property that distinguishes a condition from a duration: the same
  // assertion holds whether the route is instant or slow. Under a fixed sleep the
  // slow case is the one that breaks, intermittently, on a busy machine.
  const fast = await mountClient({ inbox: INBOX });
  const slow = await mountClient({ inbox: afterTicks(INBOX, 25) });
  assert.equal(
    slow.app.textContent,
    fast.app.textContent,
    "a late-resolving route must render identically to an instant one",
  );
});
