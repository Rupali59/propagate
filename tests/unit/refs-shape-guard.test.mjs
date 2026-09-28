/**
 * refs-shape-guard.test.mjs — the guard that stops junk reaching an append-only log.
 *
 * `assertKnownShape` exists because of G26, which cost real rows: two producers
 * wrote different shapes both labelled `schema_version: 1`, `diffSnapshots` read
 * a FLAT snapshot's 36 existing refs as "there was nothing here", and emitted 4
 * spurious `created` events into `refs/lifecycle.jsonl` — append-only by design,
 * so they are still there. Its own error message names the stake: "treating an
 * unrecognised shape as empty would emit spurious lifecycle events into an
 * append-only log."
 *
 * IT HAD NO TEST. Measured 2026-09-28: zero tests in 2261 exercised its refusal.
 * The only mention anywhere in the suite is a handoff comment at
 * `tests/unit/refs-snapshot.test.mjs:407` reading
 *
 *     foreign shape refused -> assertKnownShape now keys on
 *                              schema_version, tested there
 *
 * and in the file it points at, no such test exists. That pointer is why nobody
 * looked: the coverage was believed to have moved and never arrived. A promise in
 * one file that another file has to keep — `rule:adversarial-review-reads-the-ledger`,
 * inside the test suite rather than between docs and code.
 *
 * WHY THIS IS ITS OWN FILE, and it is the more useful half.
 * `refs-workspace-snapshot.test.mjs` builds every input through `snap()`:
 *
 *     const snap = (projects, at) => ({ schema_version: WORKSPACE_SNAPSHOT_SCHEMA, … });
 *
 * That helper HARDCODES the valid schema version and always supplies `projects`,
 * so no test written in that file can express the violation — the fixture
 * sanitises it away before the module sees it. Its earlier tests use
 * `buildWorkspaceSnapshot()`, the real producer, which likewise only emits valid
 * shapes. So the guard was unreachable from the suite by construction, not by
 * oversight, and adding a case in there would have needed the helper bypassed
 * anyway.
 *
 * The shape was named by the session working in obsidian-vk-publish, from an
 * instance of its own: an intake test asserting "a pass cannot declare a workflow
 * state", whose input was built through the validator that strips unknown fields,
 * so the violating key never reached the module under test and the mutation stayed
 * GREEN. Their generalisation is the one worth keeping: two layers both enforcing
 * a property must each be tested against input that can actually express the
 * violation, or the second layer's test is decorative.
 *
 * So these fixtures are deliberately RAW LITERALS. Do not refactor them onto a
 * shared builder; that is the defect this file documents.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { diffSnapshots, WORKSPACE_SNAPSHOT_SCHEMA } from "../../lib/refs/snapshot.mjs";

/** The valid shape, written out by hand rather than built. */
const VALID = {
  schema_version: WORKSPACE_SNAPSHOT_SCHEMA,
  captured_at: "2026-09-28T00:00:00Z",
  captured_by: "propagate/refs",
  workspace_root: "/ws",
  projects: { alpha: { refs: { main: { head: "aaa", merge_state: "merged" } } } },
  skipped: [],
};

/** G26's actual v1 shape: nested projects, schema_version 1. */
const V1 = {
  schema_version: 1,
  captured_at: "2026-08-24T00:00:00Z",
  captured_by: "hygiene/branch-registry",
  projects: { alpha: { refs: { main: {} } } },
};

/** G26's other shape: a FLAT single-repo snapshot, also labelled 1. */
const FLAT = {
  schema_version: 1,
  project: "alpha",
  repo_root: "/ws/alpha",
  refs: [{ ref: "main", head: "aaa" }],
};

/** Neither: a version nobody wrote, with no projects map. */
const FUTURE = { schema_version: 99, captured_at: "2026-09-28T00:00:00Z" };

test("a V1 snapshot is refused, and the message says how to convert it", () => {
  assert.throws(
    () => diffSnapshots(V1, VALID),
    /refusing to diff the previous snapshot[\s\S]*v1 snapshot[\s\S]*migrate-refs/,
    "a v1 prev must be refused and must name the command that fixes it",
  );
});

test("a FLAT single-repo snapshot is refused — the shape that actually cost rows", () => {
  // This is G26 exactly: 36 refs read as zero, 4 spurious `created` events.
  assert.throws(
    () => diffSnapshots(FLAT, VALID),
    /flat single-repo snapshot/,
    "the flat shape must be distinguished from v1 — they need different remedies",
  );
});

test("an unrecognised version is refused and the version is NAMED", () => {
  assert.throws(
    () => diffSnapshots(FUTURE, VALID),
    /schema_version 99 and has no projects map/,
    "an operator holding an unreadable file needs to be told what it says it is",
  );
});

test("the three hints are DIFFERENT — one message for three causes helps nobody", () => {
  const msg = (prev) => {
    try { diffSnapshots(prev, VALID); return null; } catch (e) { return e.message; }
  };
  const [a, b, c] = [msg(V1), msg(FLAT), msg(FUTURE)];
  assert.ok(a && b && c, "all three must throw, or this comparison is vacuous");
  assert.notEqual(a, b);
  assert.notEqual(b, c);
  assert.notEqual(a, c);
});

test("the NEXT snapshot is guarded too, not only the previous one", () => {
  // Two call sites, and a guard applied to one argument is the shape
  // rule:safety-flag-needs-a-test is about: one path gated, one not.
  assert.throws(() => diffSnapshots(VALID, V1), /refusing to diff the next snapshot/);
  assert.throws(() => diffSnapshots(VALID, FLAT), /the next snapshot/);
});

test("REFUSING EMITS NOTHING — the whole point, asserted on the effect", () => {
  // The stake is not the error, it is that no events are produced. A guard that
  // threw AFTER pushing rows would satisfy every assertion above.
  for (const [label, prev] of [["v1", V1], ["flat", FLAT], ["future", FUTURE]]) {
    let events = "not assigned";
    try {
      events = diffSnapshots(prev, VALID);
    } catch {
      events = null;
    }
    assert.equal(events, null, `${label}: diffSnapshots returned events instead of refusing`);
  }
});

test("a null previous snapshot is ALLOWED — a first run is a baseline, not a foreign shape", () => {
  // The negative control that matters most: if the guard refused null, every
  // first run would fail and the fix would be to delete the guard.
  const ev = diffSnapshots(null, VALID);
  assert.ok(Array.isArray(ev), "null prev must diff, not throw");
  assert.deepEqual(ev.map((e) => e.type), ["baseline"]);
});

test("two valid snapshots pass — if this failed the guard would refuse everything", () => {
  const ev = diffSnapshots(VALID, VALID);
  assert.deepEqual(ev, [], "identical valid snapshots produce no events and no error");
});

test("schema_version 2 with NO projects map is refused, not treated as empty", () => {
  // The subtle one: the right version number is not enough. A truncated write
  // that lost `projects` would otherwise read as "every ref was pruned".
  const truncated = { ...VALID, projects: undefined };
  assert.throws(() => diffSnapshots(truncated, VALID), /has no projects map/);
});
