/**
 * The client, ACTUALLY RENDERED — not just its helpers called.
 *
 * WHAT CHANGED AND WHY IT MATTERS. The previous version of this file exported
 * the client's pure functions and asserted on their return values. That catches
 * a wrong grouping axis. It cannot catch "the component throws on a row whose
 * blockedBy is undefined", which is the failure a person actually sees: a blank
 * pane, HTTP 200, nothing in any log. Same shape as G65, one layer up.
 *
 * So this mounts the real component tree into tests/helpers/minidom.mjs with
 * the three vendored globals loaded exactly as the page loads them, and asserts
 * on the DOM that comes out.
 *
 * THE PAYLOADS BELOW ARE THE REAL SHAPES, taken from a live /api/inbox: 39
 * READY, 18 BLOCKED, 33 PARKED, 357 in the baseline gap.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";
import path from "node:path";

import { makeDocument, byClass, byTag, textOf, findAll } from "../helpers/minidom.mjs";
import { fromRealm } from "../helpers/plain.mjs";

const root = path.join(import.meta.dirname, "../..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

/* -- fixtures, shaped exactly like the endpoints ------------------------- */

const edge = (id, state, over = {}) => ({
  edge_id: id,
  node_id: over.node_id ?? ("propagate:lib/" + id + ".mjs"),
  state,
  source: "/u/Documents/GitHub/propagate/lib/" + id + ".mjs",
  downstream: "/u/Documents/GitHub/propagate/commands/" + id + ".mjs",
  sourceShort: "propagate/lib/" + id + ".mjs",
  downstreamShort: "propagate/commands/" + id + ".mjs",
  boundary: "propagate",
  side: "propagate",
  why: null,
  judgedCount: 0,
  noiseRatio: null,
  lastVerified: null,
  allowed: state === "DIVERGED" ? ["both-reconciled"]
    : ["propagated", "no-change-needed", "source-corrected", "decoupled", "deferred", "wontfix"],
  orderIndex: over.orderIndex ?? 0,
  layer: 0,
  blockedBy: [],
  blocked: false,
  orderMissing: null,
  ...over,
});

const INBOX = {
  fatal: null,
  declared: 500,
  expanded: 1010,
  divisions: {
    worklist: {
      error: null,
      actionable: 5,
      unplaced: 0,
      ready: [
        edge("a", "DIVERGED", { orderIndex: 0 }),
        edge("b", "DRIFTED", { orderIndex: 1, node_id: "propagate:shared.mjs" }),
        edge("c", "DRIFTED", { orderIndex: 2, node_id: "propagate:shared.mjs" }),
        edge("d", "REVERSED", { orderIndex: 3, boundary: "crosses the line" }),
      ],
      blocked: [
        edge("e", "DRIFTED", {
          orderIndex: 4, blocked: true,
          blockedBy: [{ edge_id: "a", from: "/u/Documents/GitHub/x.md", to: "/u/Documents/GitHub/y.md", state: "DRIFTED" }],
        }),
      ],
    },
    parked: {
      error: null,
      items: [{
        edge_id: "p1", node_id: "Keerti:p.md", state: "NEVER_VERIFIED",
        sourceShort: "Keerti/p.md", downstreamShort: "Keerti/q.md", boundary: "Keerti",
        reason: "waiting on the upstream rename", by: "rupali", since: "2026-09-01T00:00:00Z", ageDays: 20,
      }],
    },
    gap: { error: null, total: 357, deferred: 33, buckets: null, bucketsLazy: true },
    reference: { registers: null, lazy: true, error: null, sources: null },
  },
};

const ANALYTICS = {
  charts: {
    backlog: { title: "Open rows", error: null, coverage: { days: 33, span: 40 },
      points: [{ day: "2026-08-13", value: 167 }, { day: "2026-08-14", value: null }, { day: "2026-08-15", value: 42 }] },
    boundary: { title: "Hub or workspace", error: null, hub: 137, workspace: 2718, unattributable: 0,
      byWorkspace: { PanditPawanKaushik: 1014, "Vipin Kaushik": 597 }, note: null },
    // Coherent on purpose: the weeks must sum to `total`, or the percentage
    // the chart prints is computed over two different populations -- which is
    // the compare-unlike-things failure the charts are supposed to avoid.
    dispositions: { title: "What the answer was", error: null, total: 100,
      kinds: ["baselined", "no-change-needed"],
      weeks: [{ week: "2026-08-10", total: 100, counts: { baselined: 40, "no-change-needed": 60 } }] },
    problems: { title: "Doctor problems", error: null, coverage: { days: 33, span: 40 }, points: [{ day: "2026-08-13", value: 3 }] },
    scale: { title: "One hub, many projects", error: null, series: [
      { name: "workspaces discovered", points: [{ day: "2026-08-13", value: 7 }, { day: "2026-08-14", value: 18 }] },
      { name: "sidecars loaded", points: [{ day: "2026-08-13", value: 21 }] }] },
    duration: { title: "Doctor duration", error: null, points: [] },
  },
  coverage: {
    events: 2855, metricRows: 828,
    observedAtCommit: { have: 1506, of: 2855, pct: 0.5275 },
    reason: { have: 2704, of: 2855, pct: 0.947 },
  },
  eventsError: null,
};

/* -- the harness ---------------------------------------------------------- */

/** Mount the real client, with the real vendored Preact, into the mini DOM. */
async function mount({ inbox = INBOX, routes = {}, hash = "#ready", reduced = false } = {}) {
  const { doc, app } = makeDocument();
  const calls = [];
  const answers = { "/api/inbox": inbox, ...routes };

  const ctx = createContext({
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    Object, Array, String, Number, Boolean, Math, JSON, Map, Set, Promise, RegExp, Error, Date, isNaN, parseInt, parseFloat, Infinity,
    document: doc,
    location: { hash },
    matchMedia: () => ({ matches: reduced }),
    addEventListener() {}, removeEventListener() {},
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    queueMicrotask,
    fetch: async (url) => {
      const p = String(url).split("?")[0];
      calls.push(p);
      if (!(p in answers)) throw new Error("no stub for " + p);
      return { json: async () => answers[p] };
    },
  });
  ctx.globalThis = ctx;
  ctx.self = ctx;
  ctx.window = ctx;

  for (const f of ["commands/vendor/preact.js", "commands/vendor/hooks.js", "commands/vendor/htm.js"]) {
    new Script(read(f)).runInContext(ctx);
  }
  new Script(read("commands/ui.client.js")).runInContext(ctx);
  // Let the mount effect and its fetch settle.
  await new Promise((r) => setTimeout(r, 30));
  return { ctx, app, calls, ui: ctx.__ui };
}

/* -- it renders at all ---------------------------------------------------- */

test("the client mounts and renders a rail, a list and a detail pane", async () => {
  const { app, ui } = await mount();
  assert.ok(byClass(app, "rail").length, "no rail rendered");
  assert.ok(byClass(app, "list").length, "no list rendered");
  assert.ok(byClass(app, "detail").length, "no detail rendered");
  assert.equal(byClass(app, "div").length, ui.DIVISIONS.length,
    "every division in DIVISIONS gets a rail button");
});

test("the rail shows live counts, and a count that is not loaded is BLANK not zero", async () => {
  const { app } = await mount();
  const labels = byClass(app, "div").map(textOf);
  assert.match(labels[0], /READY\s*4/);
  assert.match(labels[1], /BLOCKED\s*1/);
  assert.match(labels[2], /PARKED\s*1/);
  assert.match(labels[3], /BASELINE GAP\s*357/);
  // ANALYTICS and REFERENCE have no count to show; they must not read as 0.
  assert.doesNotMatch(labels[4], /0/, "an unloaded division must not render a zero");
});

test("READY collapses a shared node+state into ONE expandable row", async () => {
  // Two DRIFTED edges on propagate:shared.mjs plus two singletons = 3 rows.
  const { app } = await mount();
  const items = byClass(app, "item");
  assert.equal(items.length, 3, "4 ready edges render as 3 rows");
  const grp = byClass(app, "grp");
  assert.equal(grp.length, 1, "exactly one batch");
  assert.match(textOf(grp[0]), /shared\.mjs.*2 files/s);
});

test("the top row is fixOrder's first, not a re-sorted one", async () => {
  const { app } = await mount();
  const first = byClass(app, "item")[0];
  assert.match(textOf(first), /lib\/a\.mjs/, "orderIndex 0 leads");
});

/* -- the division that must NOT offer a form ------------------------------ */

test("BLOCKED offers no disposition buttons, and says why", async () => {
  // cli.mjs refuses an out-of-order edge with exit 3. A form here walks the
  // user into a refusal the page could have predicted.
  const { app } = await mount({ hash: "#blocked" });
  assert.equal(byClass(app, "disp").length, 0, "BLOCKED must have no action block");
  const detail = byClass(app, "detail")[0];
  assert.match(textOf(detail), /cannot judge this yet/i);
  assert.match(textOf(detail), /exit 3/);
});

test("BLOCKED carries the caveat that its blocker list is not final", async () => {
  // 352 NEVER_VERIFIED edges block but are excluded from the printed worklist,
  // so a fourth blocker can appear once three clear.
  const { app } = await mount({ hash: "#blocked" });
  assert.match(textOf(byClass(app, "detail")[0]), /Never-verified edges also block/i);
});

/* -- READY's write surface ------------------------------------------------ */

test("every disposition button comes from item.allowed, and DIVERGED gets one", async () => {
  const { app } = await mount();
  const btns = byClass(app, "disp")[0];
  const labels = btns.childNodes.map(textOf);
  // The first ready row is DIVERGED, whose only legal disposition is
  // both-reconciled. Offering the other five would be offering refusals.
  assert.equal(labels.length, 1, "DIVERGED has exactly one allowed disposition");
  assert.match(labels[0], /both-reconciled/);
  assert.match(labels[0], /r/, "and it shows its key");
});

test("a key hint is rendered only for dispositions that HAVE a key", async () => {
  const { ui } = await mount();
  assert.equal(ui.keyFor("no-change-needed"), "n");
  assert.equal(ui.keyFor("both-reconciled"), "r");
  assert.equal(ui.keyFor("wontfix"), null, "no key, so no hint to render");
});

/* -- analytics ------------------------------------------------------------ */

test("a gap in a series BREAKS the path instead of interpolating across it", async () => {
  // A line drawn across a day nobody measured asserts a reading never taken.
  const { ui } = await mount();
  const pts = [{ value: 1 }, { value: null }, { value: 3 }];
  const d = ui.linePath(pts, (i) => i * 10, (v) => v);
  assert.equal((d.match(/M/g) || []).length, 2, "two subpaths, because the middle day is a gap");
  assert.doesNotMatch(d, /M0\.0 1\.0 L20/, "must not join across the gap");
});

test("charts render, state their coverage, and name the 47%", async () => {
  const { app } = await mount({ hash: "#analytics", routes: { "/api/analytics": ANALYTICS } });
  const charts = byClass(app, "chart");
  assert.ok(charts.length >= 5, "expected several charts, got " + charts.length);
  const all = textOf(byClass(app, "detail")[0]);
  assert.match(all, /53% of events/, "commit coverage is stated, not hidden");
  assert.match(all, /60% of every judgement recorded that nothing needed doing/);
  assert.match(all, /1 day\(s\) with no run/, "the gap is labelled on the chart");
});

test("a chart path measures itself and hands the length to the CSS", async () => {
  // Without --len the draw-in animation silently does not run.
  const { app } = await mount({ hash: "#analytics", routes: { "/api/analytics": ANALYTICS } });
  const series = findAll(app, (n) => n.nodeType === 1
    && String(n.getAttribute && n.getAttribute("class") || "").includes("series"));
  assert.ok(series.length, "no series paths rendered");
  assert.equal(series[0].style._props.get("--len"), "123.4", "getTotalLength() must reach the CSS");
});

/* -- the lazy divisions --------------------------------------------------- */

test("first paint fetches ONLY /api/inbox", async () => {
  // reference 300ms + baseline 1704ms + analytics 28ms on load would cost more
  // than the 1452ms this work set out to remove.
  const { calls } = await mount();
  assert.deepEqual(calls, ["/api/inbox"]);
});

test("opening a lazy division fetches it, once", async () => {
  const { calls } = await mount({ hash: "#analytics", routes: { "/api/analytics": ANALYTICS } });
  assert.deepEqual(calls.sort(), ["/api/analytics", "/api/inbox"]);
});

test("BASELINE GAP labels the slice that can never clear", async () => {
  const { app } = await mount({
    hash: "#gap",
    routes: { "/api/baseline": {
      buckets: { baselineable: 6, noCoCommit: 253, boundReached: 1, ineligibleCrossRepo: 64, examinedAndDeferred: 33 },
      total: 357, accountedFor: true, unaccounted: 0, error: null } },
  });
  const t = textOf(byClass(app, "detail")[0]);
  assert.match(t, /PERMANENT/, "the structural slice is labelled");
  assert.match(t, /never clear/i);
  assert.match(t, /It is not a backlog/);
});

test("a baseline split that does not add up SAYS so", async () => {
  const { app } = await mount({
    hash: "#gap",
    routes: { "/api/baseline": {
      buckets: { baselineable: 1, noCoCommit: 1, boundReached: 0, ineligibleCrossRepo: 0, examinedAndDeferred: 0 },
      total: 99, accountedFor: false, unaccounted: 97, error: null } },
  });
  assert.match(textOf(byClass(app, "detail")[0]), /do not sum to the total/);
});

/* -- how it fails --------------------------------------------------------- */

test("a fatal reconcile renders the reason, not an empty page", async () => {
  const { app } = await mount({ inbox: { fatal: "reconcile failed: no workspaces", divisions: null } });
  assert.match(textOf(byClass(app, "banner")[0]), /no workspaces/);
});

test("a per-division error renders in that division, and the rail survives", async () => {
  const broken = JSON.parse(JSON.stringify(INBOX));
  broken.divisions.parked = { error: "walk exploded", items: null };
  const { app, ui } = await mount({ inbox: broken, hash: "#parked" });
  assert.match(textOf(byClass(app, "banner")[0]), /walk exploded/);
  assert.equal(byClass(app, "div").length, ui.DIVISIONS.length, "the rail still renders in full");
});

test("an empty READY names what remains elsewhere", async () => {
  // An empty division is not an empty system.
  const empty = JSON.parse(JSON.stringify(INBOX));
  empty.divisions.worklist.ready = [];
  empty.divisions.worklist.actionable = 1;
  const { app } = await mount({ inbox: empty });
  const t = textOf(byClass(app, "empty")[0]);
  assert.match(t, /nothing to judge/i);
  assert.match(t, /1 in BLOCKED/);
  assert.match(t, /357 never verified/);
  assert.ok(byTag(byClass(app, "empty")[0], "button").length, "and offers the next action");
});

/* -- the undo window ------------------------------------------------------ */

test("the undo window is five seconds and is not a compensating event", async () => {
  const { ui } = await mount();
  assert.equal(ui.UNDO_MS, 5000);
});

test("under reduced motion the ring is replaced by a NUMBER, not removed", async () => {
  // The ring IS the clock. Hiding it without a fallback removes the
  // information rather than the animation.
  const css = read("commands/ui.css");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.ring \{ display: none/);
  assert.match(read("commands/ui.client.js"), /reduced \? left \+ "s" : ""/);
});

/* -- the pure helpers, still reachable ------------------------------------ */

test("batched keeps singletons singular and never merges across states", async () => {
  const { ui } = await mount();
  const rows = [
    { edge_id: "1", node_id: "n:a", state: "DRIFTED", orderIndex: 0 },
    { edge_id: "2", node_id: "n:a", state: "REVERSED", orderIndex: 1 },
    { edge_id: "3", node_id: "n:b", state: "DRIFTED", orderIndex: 2 },
    { edge_id: "4", node_id: "n:b", state: "DRIFTED", orderIndex: 3 },
  ];
  const out = ui.batched(rows);
  assert.deepEqual(fromRealm(out.map((g) => g.kind)), ["edge", "edge", "batch"]);
  // Same node, different state: NOT a batch. One disposition cannot apply to
  // both, and offering it would make a partial application expressible.
  assert.equal(out.filter((g) => g.kind === "batch").length, 1);
  assert.equal(out[2].members.length, 2);
});

/* -- the batch write surface ----------------------------------------------- */

test("a batch's detail pane offers buttons from members[0].allowed, and never edge-only controls", async () => {
  // Two DRIFTED members, no singleton edge in front of them, so the batch is
  // flat[0] and renders in the detail pane without needing to simulate a
  // click through the mini DOM.
  const batchInbox = JSON.parse(JSON.stringify(INBOX));
  batchInbox.divisions.worklist.ready = [
    edge("x", "DRIFTED", { orderIndex: 0, node_id: "propagate:shared2.mjs" }),
    edge("y", "DRIFTED", { orderIndex: 1, node_id: "propagate:shared2.mjs" }),
  ];
  const { app } = await mount({ inbox: batchInbox });
  const grp = byClass(app, "grp");
  assert.equal(grp.length, 1, "exactly one batch row in the list");
  const btns = byClass(app, "disp")[0];
  assert.ok(btns, "the batch detail pane must offer an action block");
  const labels = btns.childNodes.map(textOf);
  // Both members are DRIFTED, so ALLOWED_NON_DIVERGED's six dispositions are
  // legal for the whole group -- the writer would refuse none of them.
  assert.equal(labels.length, 6);
  assert.ok(labels.some((l) => /no-change-needed/.test(l)));
});

test("a batch of all-DIVERGED members offers only both-reconciled, same rule as a single edge", async () => {
  const batchInbox = JSON.parse(JSON.stringify(INBOX));
  batchInbox.divisions.worklist.ready = [
    edge("x", "DIVERGED", { orderIndex: 0, node_id: "propagate:shared3.mjs" }),
    edge("y", "DIVERGED", { orderIndex: 1, node_id: "propagate:shared3.mjs" }),
  ];
  const { app } = await mount({ inbox: batchInbox });
  const labels = byClass(app, "disp")[0].childNodes.map(textOf);
  assert.equal(labels.length, 1);
  assert.match(labels[0], /both-reconciled/);
});

test("disposeBody sends {node_id, state} for a batch and {edge_id} for a single edge — never both", async () => {
  const { ui } = await mount();
  const batchBody = ui.disposeBody({ kind: "batch", node_id: "n:a", state: "DRIFTED", disposition: "no-change-needed", reason: "checked both" });
  assert.deepEqual(fromRealm(batchBody), { node_id: "n:a", state: "DRIFTED", disposition: "no-change-needed", reason: "checked both" });
  assert.equal(batchBody.edge_id, undefined, "a batch body must not carry a single edge_id");

  const edgeBody = ui.disposeBody({ kind: "edge", edge_id: "e1", disposition: "deferred", reason: "long enough reason here" });
  assert.deepEqual(fromRealm(edgeBody), { edge_id: "e1", disposition: "deferred", reason: "long enough reason here" });
  assert.equal(edgeBody.node_id, undefined, "a single-edge body must not carry node_id/state");
});

test("counts reports an unloaded division as null, never as 0", async () => {
  const { ui } = await mount();
  assert.deepEqual(fromRealm(ui.counts(null)), {});
  const partial = JSON.parse(JSON.stringify(INBOX));
  partial.divisions.worklist.ready = null;
  assert.equal(ui.counts(partial).ready, null);
});
