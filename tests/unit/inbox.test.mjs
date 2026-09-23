/**
 * The five divisions — and specifically, how they FAIL.
 *
 * The divisions themselves are thin: they slice one reconcile pass. What needs
 * testing is the thing that is invisible when it goes wrong — a division that
 * reports success while holding a failure, which renders as "nothing to do"
 * over a crash (`rule:discernment-checks` §6).
 *
 * Pure: no filesystem, no git, no event store. Every dep is injected.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { inboxPayload, parkedFrom, boundaryOf, splitWorklist, referencePayload, division } from "../../lib/report/inbox.mjs";

const ROOT = "/u/Documents/GitHub/";
const abs = (p) => ROOT + p;

const edge = (id, from, to, state, extra = {}) => ({
  edge_id: id,
  node_id: "ws:" + from,
  state,
  source: { path: abs(from) },
  downstream: { path: abs(to) },
  why: null,
  sameRepo: true,
  ...extra,
});

const ROWS = [
  edge("e-ab", "rules/a.md", "Tathya/b.md", "DRIFTED"),        // root, crosses
  edge("e-bc", "Tathya/b.md", "Tathya/c.md", "REVERSED"),      // blocked by e-ab
  edge("e-hub", "rules/x.md", "scripts/y.md", "DIVERGED"),     // hub-internal
  edge("e-park", "Keerti/p.md", "Keerti/q.md", "NEVER_VERIFIED", {
    deferred: { ts: "2026-09-01T00:00:00Z", reason: "waiting on the upstream rename", by: "rupali" },
  }),
  edge("e-nv", "Keerti/r.md", "Keerti/s.md", "NEVER_VERIFIED"),
  edge("e-clean", "Rupali/h.md", "Rupali/i.md", "CLEAN"),
];

const okDeps = (over = {}) => ({
  loadWorkspaces: async () => [],
  reconcile: async () => ({ rows: ROWS, stats: { edges: 4, expanded: 6 } }),
  historyByEdge: async () => new Map(),
  planBaseline: (rows) => {
    const nv = rows.filter((r) => r.state === "NEVER_VERIFIED");
    return {
      neverVerifiedCount: nv.length,
      outcomes: { examinedAndDeferred: nv.filter((r) => r.deferred), baselined: [], noCoCommit: [], boundReached: [], ineligibleCrossRepo: [] },
    };
  },
  registerQueue: () => ({ error: null, issues: [{ id: "N1" }], todos: [] }),
  ...over,
});

// ── the divisions add up ───────────────────────────────────────────────────

test("READY + BLOCKED == the actionable set, nothing unplaced", async () => {
  const p = await inboxPayload({ root: ROOT, deps: okDeps() });
  const w = p.divisions.worklist;
  assert.equal(w.ready.length + w.blocked.length, w.actionable);
  assert.equal(w.unplaced, 0);
  assert.equal(w.blocked.length, 1, "e-bc has an unsettled ancestor");
  assert.equal(w.blocked[0].edge_id, "e-bc");
});

test("a deferred row is in PARKED and in NO other division", async () => {
  // It still reads NEVER_VERIFIED, which is why isActionable drops it and why
  // it has been on no surface. The flag is the only thing distinguishing
  // "examined and parked" from "never looked at".
  const p = await inboxPayload({ root: ROOT, deps: okDeps(), now: Date.parse("2026-09-21T00:00:00Z") });
  const d = p.divisions;
  assert.deepEqual(d.parked.items.map((i) => i.edge_id), ["e-park"]);
  const inWorklist = [...d.worklist.ready, ...d.worklist.blocked].map((i) => i.edge_id);
  assert.ok(!inWorklist.includes("e-park"), "never in the worklist");
  assert.equal(d.parked.items[0].reason, "waiting on the upstream rename");
  assert.equal(d.parked.items[0].ageDays, 20, "age is derivable; a due date would be invented");
});

test("BASELINE GAP ships its total inline and its buckets lazily", async () => {
  // planBaseline(baseline-from-git) is 1052 ms measured — a git walk per repo.
  // On the page-load path it would cost more than everything else combined.
  const p = await inboxPayload({ root: ROOT, deps: okDeps() });
  assert.equal(p.divisions.gap.total, 2, "both NEVER_VERIFIED rows, deferred included");
  assert.equal(p.divisions.gap.buckets, null);
  assert.equal(p.divisions.gap.bucketsLazy, true, "stated, not left to be inferred from a null");
});

// ── how it fails ───────────────────────────────────────────────────────────

test("one dead source leaves the other divisions rendering", async () => {
  const p = await inboxPayload({
    root: ROOT,
    deps: okDeps({ planBaseline: () => { throw new Error("git walk exploded"); } }),
  });
  assert.match(p.divisions.gap.error, /git walk exploded/);
  assert.equal(p.divisions.gap.total, null, "null, NOT 0 — 0 would read as no backlog");
  assert.equal(p.divisions.worklist.ready.length, 2, "READY is unaffected");
  assert.equal(p.divisions.parked.items.length, 1, "PARKED is unaffected");
});

test("REFERENCE is lazy — it is NOT on the first-paint path", async () => {
  // Profiled 2026-09-21: registerQueue plus its backlog walk is 188 ms of a
  // 731 ms warm page, 26%, and it is the one division nobody acts in.
  const p = await inboxPayload({ root: ROOT, deps: okDeps() });
  assert.equal(p.divisions.reference.lazy, true, "stated, not inferred from a null");
  assert.equal(p.divisions.reference.registers, null);
});

test("a payload that RETURNS its error is not reported as clean", async () => {
  // THE BUG THIS FILE WAS WRITTEN FOR, caught live. registerQueue reports
  // failure by returning {error, issues: null} rather than throwing, so a
  // wrapper that only catches throws stamps error:null on a failed source and
  // the page renders "no registers in this tree" over a crash.
  const r = await referencePayload({
    deps: okDeps({ registerQueue: () => ({ error: "backlogFn is required", issues: null, todos: null }) }),
  });
  assert.match(r.error, /backlogFn is required/, "the nested error is hoisted, not swallowed");
  assert.equal(r.registers.issues, null, "and the empty list is not passed off as a result");
});

test("reconcile failing is the whole page, not a division", async () => {
  // There is no page without it. Reporting it per-division would render four
  // empty divisions, each looking like a legitimately empty result.
  const p = await inboxPayload({
    root: ROOT,
    deps: okDeps({ reconcile: async () => { throw new Error("no workspaces"); } }),
  });
  assert.match(p.fatal, /reconcile failed: no workspaces/);
  assert.equal(p.divisions, null, "null, not four empty divisions");
});

// ── the hub/workspace line, stamped once, server-side ──────────────────────

test("every edge row carries side and boundary from the server", async () => {
  // This rule used to live twice: here and as a regex in the browser. Two
  // readers of one fact, free to disagree, with nothing comparing them.
  const p = await inboxPayload({ root: ROOT, deps: okDeps() });
  const rows = [...p.divisions.worklist.ready, ...p.divisions.worklist.blocked];
  assert.ok(rows.every((r) => typeof r.boundary === "string"));
  assert.equal(rows.find((r) => r.edge_id === "e-ab").boundary, "crosses the line");
  assert.equal(rows.find((r) => r.edge_id === "e-hub").boundary, "hub-internal");
  assert.equal(rows.find((r) => r.edge_id === "e-bc").boundary, "Tathya");
  assert.equal(p.divisions.parked.items[0].boundary, "Keerti", "PARKED is stamped too");
});

test("boundaryOf: a contract that has not reached its instances is the interesting case", () => {
  assert.equal(boundaryOf(abs("rules/a.md"), abs("Tathya/b.md"), ROOT), "crosses the line");
  assert.equal(boundaryOf(abs("rules/a.md"), abs("scripts/b.md"), ROOT), "hub-internal");
  assert.equal(boundaryOf(abs("Tathya/a.md"), abs("Tathya/b.md"), ROOT), "Tathya");
});

// ── helpers, directly ──────────────────────────────────────────────────────

test("parkedFrom reports a missing reason as null, never as empty prose", () => {
  const out = parkedFrom([edge("e", "a/x.md", "a/y.md", "NEVER_VERIFIED", { deferred: { ts: "2026-09-11T00:00:00Z" } })],
    ROOT, Date.parse("2026-09-21T00:00:00Z"));
  assert.equal(out[0].reason, null, "deferred with no reason given is a finding, not an empty string");
  assert.equal(out[0].ageDays, 10);
});

test("parkedFrom survives an unparseable timestamp without inventing an age", () => {
  const out = parkedFrom([edge("e", "a/x.md", "a/y.md", "NEVER_VERIFIED", { deferred: { ts: "not-a-date" } })], ROOT);
  assert.equal(out[0].ageDays, null, "null, not 0 — 0 would read as deferred today");
});

test("splitWorklist keeps an unplaced row out of BOTH halves", () => {
  const items = [
    { edge_id: "a", blocked: false, orderMissing: null },
    { edge_id: "b", blocked: true, orderMissing: null },
    { edge_id: "c", blocked: null, orderMissing: "absent from the fix-order worklist" },
  ];
  const { ready, blocked, unplaced } = splitWorklist(items);
  assert.equal(ready.length, 1);
  assert.equal(blocked.length, 1);
  assert.equal(unplaced.length, 1, "counted, so the mismatch is visible rather than absorbed");
});

test("division() hoists a nested error and names the source — tested directly", () => {
  // NO CURRENT DIVISION NESTS A PAYLOAD: worklist and parked return arrays,
  // gap returns scalars, and REFERENCE (the one that did) is now lazy. So this
  // guard has no live caller and is tested here on purpose rather than left to
  // pass vacuously — a capability nobody invokes is indistinguishable from one
  // that was never built (rule:enforcement-watches-itself).
  const out = division(() => ({ registers: { error: "walk exploded", issues: null } }), { registers: null });
  assert.match(out.error, /walk exploded/);
  assert.deepEqual(out.sources, ["registers: walk exploded"]);
});

test("division() reports a clean run as clean, and a throw as a throw", () => {
  const ok = division(() => ({ items: [1, 2] }), { items: null });
  assert.equal(ok.error, null);
  assert.equal(ok.sources, null);
  const boom = division(() => { throw new Error("nope"); }, { items: null });
  assert.match(boom.error, /nope/);
  assert.equal(boom.items, null, "the empty shape is all-null so it cannot read as a result");
});

// ── the defaults themselves ────────────────────────────────────────────────

test("inbox's OWN defaultDeps supplies everything inboxPayload calls", async () => {
  // THE BUG THIS WAS ADDED FOR. Every test above injects deps, so none of them
  // touches defaultDeps — and commands/ui.mjs handed inboxPayload the deps from
  // queue.mjs instead, which has reconcile and loadWorkspaces but no
  // historyByEdge, planBaseline or registerQueue. Result: a 500 on the endpoint
  // that serves the whole page, with a green suite.
  //
  // Asserted by SHAPE, not by running it: the real thing walks the tree.
  const { defaultDeps } = await import("../../lib/report/inbox.mjs");
  const d = await defaultDeps();
  for (const k of ["reconcile", "loadWorkspaces", "planBaseline", "registerQueue", "historyByEdge"]) {
    assert.equal(typeof d[k], "function", `inbox defaultDeps is missing ${k}`);
  }
});

test("queue's defaultDeps is NOT sufficient for inboxPayload", async () => {
  // Stated as a property rather than left as a trap. If the two ever converge,
  // this goes red and someone decides deliberately instead of discovering it
  // through a 500.
  const q = await (await import("../../lib/report/queue.mjs")).defaultDeps();
  const missing = ["planBaseline", "registerQueue", "historyByEdge"].filter((k) => typeof q[k] !== "function");
  assert.ok(missing.length > 0,
    "queue and inbox deps have converged — ui.mjs can stop keeping two, and this test should be replaced");
});
