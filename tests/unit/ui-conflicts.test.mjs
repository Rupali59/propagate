/**
 * ui-conflicts.test.mjs — T4, the CONFLICTS division.
 *
 * R2's finding was that every refusal the inserter produces existed and no
 * surface showed it. This asserts the surface, and the thing it asserts hardest
 * is the DISTINCTION BETWEEN THREE STATES that a naive panel collapses into
 * one:
 *
 *   could not look  ->  ok:false, a named reason, NO counts
 *   nothing held    ->  it ran, and it says over what population
 *   held            ->  grouped by what the reader can do about it
 *
 * `lib/reminders/read.mjs`'s F1 draws the first line in the read path; a panel
 * that renders a failed read as an empty list throws that away at the last
 * step. The empty-state test below is therefore a NEGATIVE control as much as a
 * positive one: it asserts the two states do not produce the same text.
 *
 * Its own file rather than an addition to ui-client.test.mjs, for the same
 * reason ui-rail-separator.test.mjs is: PR-008 records that file failing
 * intermittently across six test names, and a new assertion in there would
 * inherit a flake it has nothing to do with.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { byClass, textOf } from "../helpers/minidom.mjs";
import { mountClient } from "../helpers/mount-client.mjs";

/* -- fixtures, shaped exactly as lib/reminders/sync.mjs returns ----------- */

const INBOX = {
  fatal: null, declared: 0, expanded: 0,
  divisions: {
    worklist: { error: null, actionable: 0, unplaced: 0, ready: [], blocked: [] },
    parked: { error: null, items: [] },
    gap: { error: null, total: 0, rows: [] },
  },
};

const row = (disposition, over = {}) => ({
  reminderId: "R-" + disposition,
  prId: over.prId ?? null,
  tag: over.tag ?? "#propagate",
  project: over.project ?? "propagate",
  disposition,
  completed: false,
  completedAt: null,
  reason: over.reason ?? `because of ${disposition}`,
  ...over,
});

/** Every disposition the panel must place, one row each. */
const HELD = [
  row("held-no-register", { tag: "#ccusage", project: "claude-usage-widget",
    reason: "no TODOS.md anywhere under claude-usage-widget" }),
  row("held-ambiguous-register", { tag: "#vipinkaushik", project: "Vipin Kaushik",
    reason: "two candidate registers: the workspace has none, the repo root has one" }),
  row("held-unrecognized-shape"),
  row("held-would-change-classification"),
  row("held-illegal-boundary"),
  row("already-inserted", { prId: "PR-901", reason: "inserted at 2026-09-25T10:00:00.000Z" }),
];

const payload = (rows, over = {}) => ({
  ok: true,
  applied: false,
  list: "propagate",
  rows,
  summary: {
    total: rows.length + (over.routed ?? 0),
    byDisposition: rows.reduce((a, r) => ({ ...a, [r.disposition]: (a[r.disposition] || 0) + 1 }), {}),
  },
  writesToRegister: false,
  ...over,
});

const at = (routes, hash) => mountClient({ inbox: INBOX, routes, hash });

/* -- D-T1: grouped by what you can do, not by enum order ----------------- */

test("the six dispositions render in three groups, each with its count", async () => {
  const { app } = await at({ "/api/conflicts": payload(HELD) }, "#conflicts");
  const text = textOf(byClass(app, "detail")[0]);

  // The groups, with counts in the headers. Four config dispositions are
  // declared but only two appear here, so the count must be of ROWS present.
  assert.match(text, /CONFIGURATION.*?you can fix these.*?\u00b7\s*2(?!\d)/s, `no CONFIGURATION group with a count of 2:\n${text}`);
  assert.match(text, /CONTENT.*?refused to touch a file.*?\u00b7\s*3(?!\d)/s, "no CONTENT group with a count of 3");
  assert.match(text, /NOT A FAILURE.*?duplicate guard.*?\u00b7\s*1(?!\d)/s, "no NOT A FAILURE group with a count of 1");

  // Order is by what the reader can do: fixable first, the non-failure last.
  const secs = byClass(app, "sec").map(textOf);
  assert.equal(secs.length, 3, `expected 3 group headers, got ${secs.length}: ${JSON.stringify(secs)}`);
  assert.match(secs[0], /CONFIGURATION/);
  assert.match(secs[2], /NOT A FAILURE/);

  // Every row is placed. A disposition with no group would vanish silently,
  // which is the UNMATCHED-badge defect one level out.
  assert.equal(byClass(app, "sitem").length, HELD.length,
    "a disposition was dropped — every row must land in a group");
});

test("already-inserted is MUTED, and it is the only muted row", async () => {
  // It is not a failure. Rendering it like one puts the loudest hue on the
  // duplicate guard working correctly.
  const { app } = await at({ "/api/conflicts": payload(HELD) }, "#conflicts");
  const quiet = byClass(app, "quiet");
  assert.equal(quiet.length, 1, `expected exactly one muted row, got ${quiet.length}`);
  assert.match(textOf(quiet[0]), /already-inserted|inserted at/,
    "the muted row is not the already-inserted one");
});

test("each row carries its REASON, not just its kind", async () => {
  // Colour and a kebab-case kind are not an explanation. DESIGN.md's failure-3
  // exemption for these rows depends on the written reason being present.
  const { app } = await at({ "/api/conflicts": payload(HELD) }, "#conflicts");
  const text = textOf(byClass(app, "detail")[0]);
  assert.match(text, /no TODOS\.md anywhere/, "held-no-register lost its reason");
  assert.match(text, /two candidate registers/, "held-ambiguous-register lost its reason");
});

/* -- D-T2: the three states must not look alike --------------------------- */

test("nothing held REPORTS THE POPULATION — it is a result, not an absence", async () => {
  const { app } = await at({ "/api/conflicts": payload([], { routed: 5 }) }, "#conflicts");
  const text = textOf(byClass(app, "detail")[0]);

  assert.match(text, /all 5 reminder/i, `the empty state does not state its population:\n${text}`);
  assert.doesNotMatch(text, /no conflicts found/i,
    "the empty state fell back to the uncounted default it exists to replace");
  assert.equal(byClass(app, "sitem").length, 0, "no rows should render");
});

test("could-not-look renders DIFFERENTLY from nothing-held, and carries no counts", async () => {
  // The load-bearing negative control. If these two produced the same text,
  // a revoked TCC permission would read as a clean bill of health.
  const denied = { ok: false, applied: false, reason: "permission denied by the user", code: "denied" };

  const bad = await at({ "/api/conflicts": denied }, "#conflicts");
  const badText = textOf(byClass(bad.app, "detail")[0]);
  const good = await at({ "/api/conflicts": payload([], { routed: 5 }) }, "#conflicts");
  const goodText = textOf(byClass(good.app, "detail")[0]);

  assert.notEqual(badText, goodText, "a failed read renders identically to a clean run");
  assert.match(badText, /could not read/i, "a failed read must say it could not look");
  assert.match(badText, /permission denied/, "a failed read must carry its reason");
  assert.doesNotMatch(badText, /\ball \d+ reminder/i,
    "a failed read claimed a population it never examined");
  assert.ok(byClass(bad.app, "banner").length, "a failed read gets a banner, not a list row");
});

/* -- R2/5c: lazy, and looking writes nothing ----------------------------- */

test("the division is LAZY — /api/conflicts is not fetched until it is opened", async () => {
  // An osascript read on first paint would make every page load wait on the
  // Reminders app, and would run a read nobody asked for.
  const closed = await at({ "/api/conflicts": payload(HELD) }, "#ready");
  assert.ok(!closed.calls.includes("/api/conflicts"),
    `the panel was fetched without being opened: ${JSON.stringify(closed.calls)}`);

  const open = await at({ "/api/conflicts": payload(HELD) }, "#conflicts");
  assert.ok(open.calls.includes("/api/conflicts"), "opening the panel did not fetch it");
});

test("the panel offers NO action affordance — it reports, you fix elsewhere", async () => {
  // Deliberate, and recorded in the design review's NOT-in-scope. Asserting it
  // means a future form cannot arrive here unnoticed.
  const { app } = await at({ "/api/conflicts": payload(HELD) }, "#conflicts");
  assert.equal(byClass(app, "disp").length, 0, "CONFLICTS must offer no disposition form");
  assert.equal(byClass(app, "btn").length, 0, "CONFLICTS must offer no action buttons");
});

/* -- D-T5: the slop variant B carried ------------------------------------ */

test("no numbered 01-06 labels, and no per-row colour border", async () => {
  const { app } = await at({ "/api/conflicts": payload(HELD) }, "#conflicts");
  for (const sec of byClass(app, "sec")) {
    assert.doesNotMatch(textOf(sec), /^\s*0\d/,
      `a numbered section label came back: ${textOf(sec)} — it carries no information`);
  }
  for (const b of byClass(app, "badge")) {
    assert.doesNotMatch(textOf(b), /^\s*0\d/, `a numbered badge came back: ${textOf(b)}`);
  }
  for (const r of byClass(app, "sitem")) {
    assert.doesNotMatch(String(r.getAttribute?.("style") ?? ""), /border-left/,
      "a coloured left border on a row is AI-slop pattern 8");
  }
});

/* -- the grouping is COMPLETE over the source vocabulary ------------------ */

test("every disposition the two lane modules can emit lands in a group", async () => {
  // The render tests above prove the six in HELD are placed. They cannot see a
  // SEVENTH added to sync.mjs later, which `groupConflicts` would silently
  // count as `routed` and never draw. So the population comes from the source,
  // not from this file's fixture.
  const { readFileSync } = await import("node:fs");
  const path = await import("node:path");
  const root = path.join(import.meta.dirname, "../..");
  const read = (rel) => readFileSync(path.join(root, rel), "utf8");

  const dispositions = [];
  for (const [rel, re] of [
    ["lib/reminders/sync.mjs", /export const REFUSAL_DISPOSITIONS = Object\.freeze\(\[([^\]]*)\]\)/],
    ["lib/reminders/reconcile.mjs", /export const DISPOSITIONS = Object\.freeze\(\[([^\]]*)\]\)/],
  ]) {
    const m = re.exec(read(rel));
    assert.ok(m, `could not find the disposition list in ${rel} — this check has gone blind`);
    const found = [...m[1].matchAll(/"([a-z-]+)"/g)].map((x) => x[1]);
    assert.ok(found.length >= 6, `${rel}: parsed only ${found.length} — the extraction has gone blind`);
    dispositions.push(...found.filter((d) => d.startsWith("held-") || d === "already-inserted"));
  }
  assert.ok(dispositions.length >= 8,
    `expected at least 8 held dispositions, found ${dispositions.length}: ${dispositions.join(", ")}`);

  const { ui } = await at({ "/api/conflicts": payload([]) }, "#conflicts");
  const ungrouped = dispositions.filter((d) => ui.conflictGroup(d) === null);
  assert.deepEqual(ungrouped, [],
    `these dispositions belong to no CONFLICT_GROUP and would be counted as routed, not drawn: ${ungrouped.join(", ")}`);

  // And the negative control: a value that is NOT a conflict must stay ungrouped,
  // or the check above would pass by grouping everything.
  assert.equal(ui.conflictGroup("no-change"), null, "an outcome must not be grouped as a conflict");
  assert.equal(ui.conflictGroup("new"), null, "`new` is a planned insert, not a conflict");
});
