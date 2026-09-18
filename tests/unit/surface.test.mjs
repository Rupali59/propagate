/**
 * surface.mjs — the merged payload behind the one surface.
 *
 * These tests are organised around the three rules the module exists to
 * enforce, because each of them is a defect this repo has already paid for:
 *
 *   1. a zero over a zero denominator is NOT green          (N87)
 *   2. declared and expanded are different numbers          (§5, N85)
 *   3. a census states which question it answered           (N80)
 *
 * The fourth group is the one a curated list always gets wrong: a failing
 * section that is not on the list must still be rendered, or the curation
 * itself becomes a way for a failure to hide.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ratio,
  toneFor,
  sideOf,
  boundarySplit,
  ageBucket,
  buildEdgeRows,
  buildRegisterRows,
  buildHealthRows,
  buildGrid,
  buildSurface,
  gotchaCensus,
} from "../../lib/report/surface.mjs";

const NOW = Date.parse("2026-09-17T12:00:00.000Z");
const DAY = 86_400_000;
const ago = (d) => new Date(NOW - d * DAY).toISOString();

const queueOf = (items, over = { declared: 493, expanded: 1003 }) => ({
  items,
  summary: {
    total: items.length,
    byState: items.reduce((a, i) => ({ ...a, [i.state]: (a[i.state] ?? 0) + 1 }), {}),
    neverJudged: items.filter((i) => !i.last).length,
    judged: items.filter((i) => i.last).length,
    highNoise: items.filter((i) => (i.noiseRatio ?? 0) >= 0.5).length,
  },
  ...over,
});

const item = (o = {}) => ({
  edge_id: o.edge_id ?? "e1",
  state: o.state ?? "DRIFTED",
  sourceShort: "a/b.md",
  downstreamShort: "c/d.md",
  noiseRatio: o.noiseRatio ?? null,
  last: o.lastDays == null ? null : { ts: ago(o.lastDays), disposition: "no-change-needed" },
});

// ── RULE 1 · a zero over nothing is not a pass ─────────────────────────────

test("toneFor CANNOT return ok without a real denominator", () => {
  // The N87 defect as a type constraint: `0 actionable of 0 declared` rendered
  // green, so an unscanned tree and a clean tree were indistinguishable.
  assert.equal(toneFor(0, { denominator: 1003 }), "ok");
  assert.equal(toneFor(0, { denominator: 0 }), "unknown", "0 of 0 is not health");
  assert.equal(toneFor(0, { denominator: null }), "unknown");
  assert.equal(toneFor(0, {}), "unknown", "an omitted denominator is not an implicit pass");
});

test("COLOUR MUST BE EARNED — a non-zero count is neutral unless a threshold is named", () => {
  // It used to default to warnAt:1, so ANY non-zero count went amber. Measured
  // on the live tree that painted 6 of 9 rows amber, which means the colour was
  // answering "is this greater than zero" — the question the number beside it
  // already answers. The design's own read order asked for ONE coloured value.
  assert.equal(toneFor(87, { denominator: 117 }), "none", "a backlog is not an alarm");
  assert.equal(toneFor(350, { denominator: 487 }), "none");
  assert.equal(toneFor(1, { denominator: 10 }), "none", "even one");

  // A caller that NAMES a threshold still gets its colour.
  assert.equal(toneFor(10, { denominator: 48, warnAt: 1 }), "warn");
  assert.equal(toneFor(1, { denominator: 12, failAt: 1 }), "fail");

  // And zero is still worth seeing, because on this card it is rare.
  assert.equal(toneFor(0, { denominator: 10 }), "ok");
});

test("drift goes amber on OVERDUE work, not on having any", () => {
  const fresh = buildEdgeRows(queueOf([item({ lastDays: 1 }), item({ edge_id: "b", lastDays: 2 })]), { now: NOW })[0];
  assert.equal(fresh.tone, "none", "48 actionable with nothing stale is not an alarm");

  const stale = buildEdgeRows(queueOf([item({ lastDays: 40 }), item({ edge_id: "b", lastDays: 1 })]), { now: NOW })[0];
  assert.equal(stale.tone, "warn", "one edge unjudged for 40 days IS");
});

test("a register row is never coloured for merely having entries", () => {
  const rows = buildRegisterRows({ totals: { hot: { issues: 999 }, rotatable: { issues: 1 } } }, null);
  assert.equal(rows.find((r) => r.key === "issues").tone, "none");
});

test("gotchas are neutral, and amber ONLY when nothing in them can fire", () => {
  // Green asserted "this is good" because one entry had a trigger, which is not
  // an achievement. rule:every-project-carries-gotchas says most gotchas have no
  // mechanical trigger by design.
  const some = buildRegisterRows({}, { files: 10, entries: 89, triggered: 63, scope: "x" });
  assert.equal(some.find((r) => r.key === "gotchas").tone, "none");
  const none = buildRegisterRows({}, { files: 2, entries: 40, triggered: 0, scope: "x" });
  assert.equal(none.find((r) => r.key === "gotchas").tone, "warn", "a corpus that can never fire is documented and not delivered");
});

test("doctor's warns are COUNTED but not coloured; only a fail is", () => {
  // doctor grades 355 things `warn` tree-wide. Mirroring that onto this card
  // paints most of it amber and says nothing, so the count is printed and the
  // hue is withheld.
  const warnOnly = buildHealthRows(snap([sec("Delivery", { warn: 3 })])).find((r) => r.key === "Delivery");
  assert.equal(warnOnly.tone, "none");
  assert.equal(warnOnly.value, 3, "the number is still there");

  const failing = buildHealthRows(snap([sec("Discovery integrity", { fail: 1, pass: 11 })])).find((r) => r.key === "Discovery integrity");
  assert.equal(failing.tone, "fail");
});

test("exactly ONE thing is coloured red on a card with one failing check", () => {
  // The read order the design asked for and the implementation did not deliver.
  const s = buildSurface({
    queue: queueOf([item({ lastDays: 1 })]),
    snapshot: snap([sec("Delivery", { warn: 3 }), sec("Discovery integrity", { fail: 1, pass: 11 }), sec("Workspace: A", { warn: 40, pass: 5 })]),
    registers: { totals: { hot: { issues: 87, todos: 205 }, rotatable: { issues: 30, todos: 89 } } },
    gotchas: { files: 10, entries: 89, triggered: 63, scope: "x" },
    now: NOW,
  });
  const rows = s.groups.flatMap((g) => g.rows);
  assert.equal(rows.filter((r) => r.tone === "fail").length, 1, "one red");
  assert.ok(rows.filter((r) => r.tone === "warn").length <= 1, "at most one amber");
  assert.ok(rows.filter((r) => r.tone === "none").length >= 4, "and the rest quiet");
});

// ── the hub / workspace line ───────────────────────────────────────────────

test("sideOf puts contracts in the hub and everything else in its workspace", () => {
  // docs/HUB-AND-WORKSPACE.md: the hub owns contracts, workspaces own instances.
  const R = "/h/";
  assert.equal(sideOf("/h/rules/tool-priority.md", R), "hub");
  assert.equal(sideOf("/h/scripts/execution/ports.yml", R), "hub");
  assert.equal(sideOf("/h/.templates/PLAN.md", R), "hub");
  assert.equal(sideOf("/h/propagate/docs/REFERENCE.md", R), "hub", "propagate's docs are contracts, per the architecture note");
  assert.equal(sideOf("/h/CLAUDE.md", R), "hub", "a loose root file is found by walking up — that is the contract");
  assert.equal(sideOf("/h/Tathya/WorkTracker/STATE.md", R), "Tathya");
  assert.equal(sideOf("/h/propagate/lib/report/surface.mjs", R), "propagate", "code is an instance");
});

test("boundarySplit separates the edges that CROSS the line", () => {
  // A crossing edge is a contract that has not reached its instances — the
  // failure the two-way flow exists to catch, and previously indistinguishable
  // from a typo in one workspace's README.
  const R = "/h/";
  const e = (s, d) => ({ source: s, downstream: d });
  const b = boundarySplit([
    e("/h/rules/a.md", "/h/rules/b.md"),
    e("/h/rules/a.md", "/h/Tathya/CLAUDE.md"),
    e("/h/Tathya/x.md", "/h/Tathya/y.md"),
    e("/h/Keerti/x.md", "/h/Keerti/y.md"),
    e("/h/Tathya/p.md", "/h/Tathya/q.md"),
  ], R);
  assert.equal(b.hubInternal, 1);
  assert.equal(b.crossing, 1);
  assert.equal(b.workspaceLocal, 3);
  assert.deepEqual(b.byWorkspace, { Tathya: 2, Keerti: 1 });
});

test("the crossing count reaches the card", () => {
  const row = buildEdgeRows(
    { items: [{ edge_id: "a", state: "DRIFTED", source: "/h/rules/a.md", downstream: "/h/Tathya/b.md", last: null }],
      summary: { total: 1, byState: { DRIFTED: 1 } }, declared: 1, expanded: 1 },
    { now: NOW, root: "/h/" },
  )[0];
  assert.equal(row.boundary.crossing, 1);
  assert.ok(row.extra.some((e) => /cross hub/.test(e)), "and it is visible, not merely carried");
});

test("an empty queue over a real population is ok; over nothing it is unknown", () => {
  assert.equal(buildEdgeRows(queueOf([]))[0].tone, "ok");
  assert.equal(buildEdgeRows(queueOf([], { declared: 0, expanded: 0 }))[0].tone, "unknown");
});

test("the headline refuses to print 0 when nothing was scanned", () => {
  const clean = buildSurface({ queue: queueOf([]), now: NOW });
  assert.equal(clean.headline.value, 0);
  assert.equal(clean.headline.tone, "ok");

  const unscanned = buildSurface({ queue: queueOf([], { declared: 0, expanded: 0 }), now: NOW });
  assert.equal(unscanned.headline.value, null, "a bare 0 here is the lie");
  assert.equal(unscanned.headline.tone, "unknown");
  assert.match(unscanned.headline.label, /nothing scanned/);
});

test("ratio never divides by zero and never exceeds 1", () => {
  assert.equal(ratio(5, 0), null, "no bar and an empty bar must differ");
  assert.equal(ratio(5, null), null);
  assert.equal(ratio(2000, 1000), 1, "a bar cannot overflow its track");
  assert.equal(ratio(1, 4), 0.25);
});

// ── RULE 2 · declared and expanded are different numbers ───────────────────

test("declared and expanded are carried SEPARATELY, never conflated", () => {
  // `reconcile` reports stats.edges 493 and stats.expanded 1003. Three
  // renderers said "of 1003 declared" and all three were wrong (§5).
  const s = buildSurface({ queue: queueOf([item()]), now: NOW });
  assert.deepEqual(s.edges, { declared: 493, expanded: 1003 });
  assert.notEqual(s.edges.declared, s.edges.expanded, "the whole point");
});

test("the drift bar is measured against EXPANDED, the set the queue is drawn from", () => {
  const row = buildEdgeRows(queueOf([item(), item({ edge_id: "e2" })]))[0];
  assert.equal(row.ratio, 2 / 1003, "not 2/493 — the actionable set comes from expanded rows");
  assert.deepEqual(row.denominator, { declared: 493, expanded: 1003 });
});

// ── RULE 3 · a census states its scope ─────────────────────────────────────

test("gotchaCensus counts two DIFFERENT populations and names its scope", () => {
  // `parseEntries` skips any entry with no `**Trigger:**` line, so it returns a
  // strict subset of the `### ` headings. Reporting either as "the" gotcha
  // count without saying which is how N80 happened.
  const files = { "/w/docs/GOTCHAS.md": "### G1 x\n**Trigger:** `a`\n### G2 y\n### G3 z\n" };
  const deps = {
    sourcesFor: (r) => (r === "/w" ? ["/w/docs/GOTCHAS.md"] : []),
    parseEntries: () => ({ entries: [{ id: "G1" }], bad: [] }),
    readFileSync: (f) => files[f],
  };
  return gotchaCensus({ roots: ["/w"], deps }).then((c) => {
    assert.equal(c.entries, 3, "three ### headings");
    assert.equal(c.triggered, 1, "only one of them can ever fire");
    assert.equal(c.files, 1);
    assert.ok(c.scope, "a census with no stated scope is the N80 defect");
  });
});

test("a discovered-but-unreadable gotcha file is attributed, not swallowed", () => {
  const deps = {
    sourcesFor: () => ["/w/GOTCHAS.md"],
    parseEntries: () => ({ entries: [], bad: [] }),
    readFileSync: () => { throw new Error("EACCES"); },
  };
  return gotchaCensus({ roots: ["/w"], deps }).then((c) => {
    assert.equal(c.unreadable, 1, "'never there' and 'there but unreadable' are different facts");
    assert.equal(c.entries, 0);
  });
});

test("a gotcha file whose entries can never fire warns, rather than reading as stock", () => {
  const rows = buildRegisterRows({}, { files: 2, entries: 40, triggered: 0, scope: "x" });
  const g = rows.find((r) => r.key === "gotchas");
  assert.equal(g.tone, "warn", "40 entries, none deliverable — documented and not delivered");
  assert.equal(g.ratio, 1, "and the bar is FULL, because nothing in it can fire");
  const allFire = buildRegisterRows({}, { files: 1, entries: 10, triggered: 10, scope: "x" });
  assert.equal(allFire.find((r) => r.key === "gotchas").ratio, 0, "every entry deliverable is an EMPTY bar");
  assert.ok(g.extra.some((e) => /scope/.test(e)), "the scope travels with the number");
});

// ── the curated list must not be able to hide a failure ────────────────────

const snap = (sections, extra = {}) => ({
  ok: true,
  ageMs: 60_000,
  payload: { sections, problems: sections.reduce((a, s) => a + s.fail, 0), generatedAt: ago(0), ...extra },
});
const sec = (name, o = {}) => ({ name, pass: o.pass ?? 0, warn: o.warn ?? 0, fail: o.fail ?? 0, info: 0, note: 0, entries: [] });

test("a FAILING section outside the curated list still gets a row", () => {
  // A curated list that can hide a failure is the same defect one level up as a
  // population that excludes its own failures (N87).
  const rows = buildHealthRows(snap([sec("Delivery", { warn: 3 }), sec("Something Nobody Curated", { fail: 2, pass: 9 })]));
  const hidden = rows.find((r) => r.key === "Something Nobody Curated");
  assert.ok(hidden, "the failing section must appear even though nothing named it");
  assert.equal(hidden.tone, "fail");
});

test("a PASSING section outside the curated list is not rendered — that is just noise", () => {
  const rows = buildHealthRows(snap([sec("Delivery", { warn: 3 }), sec("Quiet", { pass: 4 })]));
  assert.equal(rows.find((r) => r.key === "Quiet"), undefined);
});

test("sixteen workspace sections collapse to one row that keeps the scale", () => {
  const ws = [sec("Workspace: A", { pass: 5 }), sec("Workspace: B", { warn: 7, pass: 2 }), sec("Workspace: C", { warn: 1 })];
  const row = buildHealthRows(snap(ws)).find((r) => r.key === "workspaces");
  assert.equal(row.value, 8, "the outstanding count, so the bar reads like every other bar");
  assert.equal(row.unit, "warn");
  assert.match(row.detail, /1 of 3 clean/, "the clean split is still legible");
});

test("EVERY bar on the card means 'how much is outstanding' — never the reverse", () => {
  // The first version measured the workspace row as the fraction CLEAN while
  // every other row measured the fraction OUTSTANDING, so one card carried two
  // opposite meanings for the same visual and a fuller bar was the better
  // result in one place and the worse result in the other.
  const s = buildSurface({
    queue: queueOf([item(), item({ edge_id: "e2" })]),
    snapshot: snap([sec("Delivery", { warn: 3 }), sec("Workspace: A", { pass: 9, warn: 1 })]),
    registers: { totals: { hot: { issues: 5 }, rotatable: { issues: 5 } } },
    gotchas: { files: 10, entries: 89, triggered: 63, scope: "workspace roots" },
    now: NOW,
  });
  const by = Object.fromEntries(s.groups.flatMap((g) => g.rows).map((r) => [r.key, r]));
  // THE ROW THIS TEST USED TO MISS. It was never populated here, so the gotcha
  // bar shipped measuring triggered/entries — a FULL bar for the GOOD result,
  // while every other full bar meant the bad one. Caught by reading the raw
  // payload, not by this test, which is why the row is now pinned explicitly.
  assert.equal(by.gotchas.ratio, 26 / 89, "the bar must show what CANNOT fire, not what can");
  assert.equal(by.Delivery.ratio, 1, "3 warn of 3 checks — entirely outstanding, full bar");
  assert.equal(by.workspaces.ratio, 0.1, "1 bad of 10 checks — nearly clean, near-empty bar");
  assert.equal(by.issues.ratio, 0.5);
  assert.ok(by.drift.ratio < 0.01, "2 of 1003");
  // The invariant, stated once: a bigger number is always a fuller bar.
  for (const r of Object.values(by)) {
    if (r.ratio == null || r.tone === "unknown") continue;
    if (r.ratio === 0) assert.equal(r.tone, "ok", `${r.key}: an empty bar must mean nothing outstanding`);
  }
});

test("a CLEAN section is labelled with what it has, not with the name of a problem", () => {
  // `Backlog  0 warn` labels a healthy row with a defect unit.
  const row = buildHealthRows(snap([sec("Backlog", { pass: 4 })])).find((r) => r.key === "Backlog");
  assert.equal(row.value, 4);
  assert.equal(row.unit, "pass");
  assert.equal(row.ratio, 0);
  assert.equal(row.tone, "ok");
});

test("a MISSING snapshot renders as unknown carrying the reason — never as healthy", () => {
  const rows = buildHealthRows({ ok: false, reason: "doctor failed on its last run — git exploded" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tone, "unknown", "ok here would reproduce N87 in a new file");
  assert.match(rows[0].detail, /git exploded/, "the cause must reach the reader");
});

test("buildSurface reports snapshot failure at the top level too", () => {
  const s = buildSurface({ queue: queueOf([]), snapshot: { ok: false, reason: "no snapshot yet" }, now: NOW });
  assert.equal(s.snapshot.ok, false);
  assert.match(s.snapshot.reason, /no snapshot/);
  assert.equal(s.snapshot.problems, null, "not 0 — unknown");
});

// ── the grid: grouped by state, so colour is redundant ─────────────────────

test("the grid groups into counted runs — position carries the meaning, not hue", () => {
  // DECISION 2. Amber/red/violet on a 7px cell with no hover is unreadable for
  // ~8% of men; grouping puts the meaning in position instead.
  const g = buildGrid([
    item({ edge_id: "a", state: "REVERSED" }),
    item({ edge_id: "b", state: "DRIFTED" }),
    item({ edge_id: "c", state: "REVERSED" }),
  ], { now: NOW });
  assert.deepEqual(g.map((r) => [r.state, r.count]), [["DRIFTED", 1], ["REVERSED", 2]]);
  assert.equal(g.find((r) => r.state === "REVERSED").cells.length, 2);
});

test("an empty state produces NO run rather than a zero-width one", () => {
  const g = buildGrid([item({ state: "DRIFTED" })], { now: NOW });
  assert.equal(g.length, 1);
  assert.equal(g.every((r) => r.count > 0), true);
});

test("a state the grid has never heard of is still rendered", () => {
  const g = buildGrid([item({ state: "SOMETHING_NEW" })], { now: NOW });
  assert.equal(g.find((r) => r.state === "SOMETHING_NEW")?.count, 1, "an unknown state must not vanish");
});

// ── ages ───────────────────────────────────────────────────────────────────

test("never-judged is its OWN bucket, not folded into 'old'", () => {
  // Folding them loses the distinction between "nobody has looked" and
  // "somebody looked and deferred" — only one of those is a backlog.
  assert.equal(ageBucket(null), "never");
  assert.equal(ageBucket(0.5 * DAY), "today");
  assert.equal(ageBucket(3 * DAY), "week");
  assert.equal(ageBucket(20 * DAY), "stale");
});

test("age buckets are counted across the queue and surfaced as extras", () => {
  const row = buildEdgeRows(queueOf([
    item({ edge_id: "a", lastDays: 20 }),
    item({ edge_id: "b", lastDays: 20 }),
    item({ edge_id: "c", lastDays: 0 }),
    item({ edge_id: "d" }),
  ]), { now: NOW })[0];
  assert.equal(row.buckets.stale, 2);
  assert.equal(row.buckets.never, 1);
  assert.ok(row.extra.some((e) => /2 over 15 days/.test(e)));
});

// ── registers ──────────────────────────────────────────────────────────────

test("the four registers are FIRST-CLASS rows, not one summary line", () => {
  // Today they are one dim `·` line inside doctor, and the first draft of this
  // surface compressed that further to `Registers  ok` — 329 written-down items
  // rendered as a word.
  const rows = buildRegisterRows(
    { totals: { hot: { issues: 86, handovers: 38, todos: 205 }, rotatable: { issues: 30, handovers: 31, todos: 89 } } },
    { files: 11, entries: 158, triggered: 79, scope: "workspace roots" },
  );
  assert.deepEqual(rows.map((r) => r.key), ["issues", "handovers", "todos", "gotchas"]);
  assert.equal(rows[0].value, 86);
  assert.equal(rows[0].ratio, 86 / 116, "open against everything written in the file");
  assert.equal(rows.find((r) => r.key === "gotchas").value, 158);
});

test("every row routes to a control, and no row routes nowhere", () => {
  // The design review's finding: a CTA that opens a 2800-line markdown file has
  // relocated the problem, not solved it.
  const s = buildSurface({
    queue: queueOf([item()]),
    snapshot: snap([sec("Delivery", { warn: 3 })]),
    registers: { totals: { hot: { issues: 1 }, rotatable: {} } },
    gotchas: { files: 1, entries: 1, triggered: 1, scope: "x" },
    now: NOW,
  });
  const rows = s.groups.flatMap((g) => g.rows);
  assert.ok(rows.length >= 5);
  for (const r of rows) {
    assert.ok(r.cta?.route, `${r.key} must land somewhere`);
    assert.ok(r.cta.route.startsWith("/"), `${r.key} routes to a control, not a document`);
  }
});

test("every row declares whether it is live or from the snapshot", () => {
  // Staleness is per-row: the queue is 239ms and current, the health rows can be
  // hours old. A surface that does not say which is which invites acting on the
  // wrong one.
  const s = buildSurface({
    queue: queueOf([item()]),
    snapshot: snap([sec("Delivery", { warn: 1 })]),
    registers: { totals: { hot: { issues: 1 }, rotatable: {} } },
    now: NOW,
  });
  const rows = s.groups.flatMap((g) => g.rows);
  assert.ok(rows.every((r) => r.source === "live" || r.source === "snapshot"));
  assert.equal(rows.find((r) => r.key === "drift").source, "live");
  assert.equal(rows.find((r) => r.key === "Delivery").source, "snapshot");
});
