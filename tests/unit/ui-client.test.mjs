/**
 * The client, ACTUALLY RENDERED — not just its helpers called.
 *
 * WHAT CHANGED AND WHY IT MATTERS. An earlier version of this file exported the
 * client's pure functions and asserted on their return values. That catches a
 * wrong grouping axis. It cannot catch "the component throws on a row whose
 * blockedBy is undefined", which is the failure a person actually sees: a blank
 * pane, HTTP 200, nothing in any log. Same shape as G65, one layer up.
 *
 * So this mounts the real component tree into tests/helpers/minidom.mjs with the
 * three vendored globals loaded exactly as the page loads them, and asserts on the
 * DOM that comes out.
 *
 * REWRITTEN 2026-10-15 for the redesign (plan ticklish-gathering-brook, lane C).
 * The nine data-source views became JUDGE / UNBLOCK / HEALTH / ACTIVITY plus
 * Explore, so every case that named READY, BLOCKED, PARKED, BASELINE GAP,
 * ANALYTICS or the node+state batch row was rewritten DELIBERATELY to the
 * 2026-10-15 rename -- not patched to pass. The cases that tested a property the
 * redesign keeps (a gap breaks a path, the undo is five seconds, a failure has a
 * voice) are kept as they were.
 *
 * THE FIXTURE IS BUILT WITH THE REAL COUNTERS. `worklist` and `leverage` come from
 * the same functions the server runs over its items (inbox.mjs worklistWithUnplaced,
 * surface.mjs buildLeverage), because a hand-typed `toJudge: 3` would let the
 * badge-equals-rows test pass over two numbers nobody derived.
 */
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

import { byClass, byTag, textOf, findAll } from "../helpers/minidom.mjs";
import { mountClient, respond, rawText, rejectWith } from "../helpers/mount-client.mjs";
import { worklistWithUnplaced } from "../../lib/report/inbox.mjs";
import { buildLeverage } from "../../lib/report/surface.mjs";
import { fromRealm } from "../helpers/plain.mjs";

const read = (rel) => readFileSync(path.join(import.meta.dirname, "../..", rel), "utf8");

/* -- fixtures, shaped exactly like the endpoints ------------------------- */

const ALLOWED = ["propagated", "no-change-needed", "source-corrected", "decoupled", "deferred", "wontfix", "baselined"];
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
  allowed: state === "DIVERGED" ? ["both-reconciled"] : ALLOWED,
  orderIndex: over.orderIndex ?? 0,
  layer: 0,
  blockedBy: [],
  blocked: false,
  orderMissing: null,
  contentKey: `${id}|s-${id}|d-${id}`,
  ...over,
});

const READY = [
  edge("a", "DIVERGED", { orderIndex: 0 }),
  edge("b", "DRIFTED", { orderIndex: 1, node_id: "propagate:shared.mjs" }),
  edge("c", "DRIFTED", { orderIndex: 2, node_id: "propagate:shared.mjs" }),
  edge("d", "REVERSED", { orderIndex: 3, boundary: "crosses the line" }),
];
const BLOCKED = [
  edge("e", "DRIFTED", {
    orderIndex: 4, blocked: true,
    blockedBy: [{ edge_id: "a", from: "/u/Documents/GitHub/propagate/lib/a.mjs", to: "/u/Documents/GitHub/propagate/commands/a.mjs", state: "DIVERGED" }],
  }),
];
const PARKED = [{
  edge_id: "p1", node_id: "Keerti:p.md", state: "NEVER_VERIFIED", source: "/u/Documents/GitHub/Keerti/p.md", downstream: "/u/Documents/GitHub/Keerti/q.md",
  sourceShort: "Keerti/p.md", downstreamShort: "Keerti/q.md", boundary: "Keerti", contentKey: "p1|s-p1|d-p1",
  reason: "waiting on the upstream rename", by: "rupali", since: "2026-09-01T00:00:00Z", ageDays: 20,
}];

/** An /api/inbox payload, with the counters the SERVER would add over the same items. */
function inboxOf({ ready = READY, blocked = BLOCKED, parked = PARKED, gap = 357, extra = {} } = {}) {
  const items = [...ready, ...blocked];
  return {
    fatal: null,
    declared: 500,
    expanded: 1010,
    divisions: {
      worklist: { error: null, actionable: items.length, unplaced: 0, ready, blocked },
      parked: { error: null, items: parked },
      gap: { error: null, total: gap, deferred: parked.length, buckets: null, bucketsLazy: true },
      reference: { registers: null, lazy: true, error: null, sources: null },
    },
    worklist: worklistWithUnplaced(items),
    leverage: buildLeverage(items, { root: "/u/Documents/GitHub/" }),
    generatedAt: "2026-10-15T10:00:00.000Z",
    ...extra,
  };
}
const INBOX = inboxOf();

const SURFACE = {
  generatedAt: "2026-10-15T10:00:00.000Z",
  health: { ok: true, reason: null, sections: [{ key: "State", label: "State", status: "fail", fail: 2, accepted: 3, pass: 4 }] },
  velocity: {
    status: "ok", reason: null, windowDays: 3, events: 7, noChangeEvents: 5, noChangeShareOfEvents: 5 / 7,
    days: [{ day: "2026-10-13", total: 4, noChange: 3, changed: 1 }, { day: "2026-10-14", total: 0, noChange: 0, changed: 0 }, { day: "2026-10-15", total: 3, noChange: 2, changed: 1 }],
  },
  usage: {
    status: "ok", reason: null, origin: "interactive", windowDays: 3, total: 9, failures: 1, refusals: 0, origins: { interactive: 9 },
    days: [{ day: "2026-10-13", count: 4 }, { day: "2026-10-14", count: 0 }, { day: "2026-10-15", count: 5 }],
    top: [{ command: "status", count: 6 }, { command: "verify", count: 3 }],
  },
};

const evidenceFor = (id) => ({
  ok: true, kind: "diff", side: "source",
  text: `@@ -1 +1 @@\n-old ${id}\n+new ${id}`, truncated: null, since: "abc1234", caveat: null,
  downstream: { ok: true, kind: "diff", side: "downstream", text: "", empty: true, since: "abc1234", caveat: null, truncated: null, reason: "the downstream has not changed since it was last judged" },
  contentIds: { source: "s-" + id, downstream: "d-" + id },
});

/* -- the harness ---------------------------------------------------------- */

/**
 * Mount with every endpoint the client reads stubbed, so an UNSTUBBED path is a
 * test bug that `unstubbed` reports rather than a quiet network error on screen.
 */
const mount = (opts = {}) => mountClient({
  inbox: INBOX,
  speedUp: true,
  ...opts,
  routes: {
    "/api/surface": SURFACE,
    "/api/seen-edges": { ok: true, status: "ok", triples: [] },
    "/api/evidence": (c) => evidenceFor(JSON.parse(c.body).edge_id),
    "/api/dispose": respond(200, { ok: true, event_id: "ev-1" }),
    ...(opts.routes || {}),
  },
});

const click = (node) => node.dispatchEvent({ type: "click", stopPropagation() {}, preventDefault() {} });
const typeInto = (ta, v) => { ta.value = v; ta.dispatchEvent({ type: "input" }); };
const buttons = (root) => byTag(root, "button");
const btnText = (root, re) => buttons(root).find((b) => re.test(textOf(b)));
const rows = (app) => byClass(app, "item");
const detail = (app) => byClass(app, "detail")[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evidenceCalls = (m) => m.fetches.filter((f) => f.path === "/api/evidence").map((f) => JSON.parse(f.body).edge_id);
const disposeCalls = (m) => m.fetches.filter((f) => f.path === "/api/dispose");
const ticks = (app) => findAll(app, (n) => n.nodeType === 1 && n.localName === "input" && n.getAttribute("type") === "checkbox");

/* Phase 1 helpers (2026-10-16): every chart is Plot now, and the headless suite has none, so a test that
   needs to see a chart's shapes installs the recording stand-in (fakePlot, below) and re-renders. */
const dtRows = (root) => byClass(root, "dt-row");
const withPlot = (m, log = {}) => {
  const P = fakePlot(m.doc, log);
  const real = P.plot;
  log.all = [];
  P.plot = (o) => { const n = real(o); log.all.push({ o, n, shapes: log.shapes }); return n; };
  m.ctx.Plot = P;
  return log;
};
const clipboard = (m) => { const wrote = []; m.ctx.navigator = { clipboard: { writeText: (t) => { wrote.push(t); return Promise.resolve(); } } }; return wrote; };

/* -- it renders at all ---------------------------------------------------- */

test("the client mounts and renders a rail, a list and a detail pane", async () => {
  const { app, ui, unstubbed } = await mount();
  assert.ok(byClass(app, "rail").length, "no rail rendered");
  assert.ok(byClass(app, "list").length, "no list rendered");
  assert.ok(byClass(app, "detail").length, "no detail rendered");
  assert.equal(byClass(app, "div").length, ui.DIVISIONS.length, "every division in DIVISIONS gets a rail button");
  assert.deepEqual(unstubbed, [], "the mount asked for an endpoint this test does not stub");
});

test("first paint reads the inbox, then the three after-paint reads -- and nothing lazy", async () => {
  // REWRITTEN (plan E8, then D12 and F5). The test used to pin ONE request. The
  // redesign adds exactly three, and the point of pinning the set is unchanged: the
  // lazy views (health, registers, reminders, baseline, the graph) cost more than
  // the inbox and must not ride the first paint.
  //   /api/surface     Health badge, velocity and usage -- loads AFTER the inbox
  //   /api/seen-edges  the "new" dot's seen-set (D12)
  //   /api/version     the stale-server check (F5), only when the page carries a build id
  const { calls } = await mount({ build: "b1", routes: { "/api/version": { ok: true, build: "b1" } } });
  assert.equal(calls[0], "/api/inbox", "the inbox comes first: it is what the person acts on");
  assert.deepEqual([...calls].sort(), ["/api/evidence", "/api/evidence", "/api/inbox", "/api/seen-edges", "/api/surface", "/api/version"],
    "first paint made a request this test does not know about (evidence is the selected row and its prefetched neighbour)");
});

/* -- the rail and the one count definition -------------------------------- */

test("the rail shows live counts, and a count that is not loaded is BLANK not zero", async () => {
  const { app } = await mount();
  const labels = byClass(app, "div").map(textOf);
  // OVERVIEW joined at the front on 2026-10-16, so every index below moved up by one: that is
  // the rename this test was rewritten for, not a loosening.
  assert.match(labels[1], /JUDGE\s*3/, "Judge reads worklist.toJudge");
  assert.match(labels[2], /UNBLOCK\s*1/, "Unblock reads leverage.blocked");
  // OVERVIEW, ACTIVITY and the Explore views have no count; they must not read as 0.
  for (const i of [0, 4, 5, 6, 7]) assert.doesNotMatch(labels[i], /\d/, `${labels[i]} must not render a count it does not have`);
});

test("the Judge badge EQUALS the rendered To-judge rows, by the widget's own counter (plan test 8)", async () => {
  // Two independent derivations of one number: the server's buildWorklist over the
  // items, and the rows the page draws. The 46-versus-78 defect was these two
  // disagreeing in different units.
  const { app, ui } = await mount();
  const badge = Number(textOf(byClass(app, "div")[1]).replace(/\D/g, ""));
  assert.equal(badge, INBOX.worklist.toJudge, "the rail did not read worklist.toJudge");
  assert.equal(rows(app).length, badge, "the badge says one number and the list draws another");
  // DIVERGED rows are NOT in To judge: they sit under their own chip with their own count.
  const chip = btnText(app, /Both sides moved/);
  assert.match(textOf(chip), /Both sides moved\s*1/);
  assert.equal(ui.judgeModel(fromRealm(INBOX), new Set()).diverged.length, 1);
});

test("the rail is a nav landmark with aria-current on the open view (F3)", async () => {
  const { app } = await mount();
  const nav = byTag(app, "nav")[0];
  assert.equal(nav.getAttribute("aria-label"), "views");
  const on = byClass(app, "div").filter((b) => b.getAttribute("aria-current") === "page");
  assert.equal(on.length, 1, "exactly one rail button is the current page");
  assert.match(textOf(on[0]), /JUDGE/);
  const live = findAll(app, (n) => n.nodeType === 1 && n.getAttribute("aria-live") === "polite");
  assert.equal(live.length, 1, "one polite live region announces verdicts, undo and bulk results");
});

/* -- Judge: the list ------------------------------------------------------ */

test("the queue is grouped by workspace, then by source node", async () => {
  // REWRITTEN from "READY collapses a shared node+state into ONE expandable row".
  // Rows are edges now, because a selection crosses nodes and a batch row hid the
  // unit the verdict writes to. The grouping is a header, not a collapse.
  const { app } = await mount();
  const ws = byClass(app, "ghead").map(textOf);
  assert.equal(ws.length, 1, `one workspace in the fixture, got ${JSON.stringify(ws)}`);
  assert.match(ws[0], /^propagate/);
  const nodes = byClass(app, "nhead").map(textOf);
  assert.ok(nodes.some((t) => /propagate:shared\.mjs\s*2/.test(t)), `the shared node should head its two edges: ${JSON.stringify(nodes)}`);
  assert.equal(rows(app).length, 3, "3 judgeable edges render as 3 rows (the DIVERGED one is under its chip)");
});

test("the top row is fixOrder's first, not a re-sorted one", async () => {
  const { app } = await mount();
  assert.match(textOf(rows(app)[0]), /lib\/b\.mjs/, "orderIndex 1 leads To judge");
});

test("a DIVERGED edge offers only both-reconciled, and says to edit both files first (D2)", async () => {
  const m = await mount();
  click(btnText(m.app, /Both sides moved/));
  await m.settle();
  const t = textOf(detail(m.app));
  assert.match(t, /Edit both files first/);
  const labels = byClass(m.app, "disp")[0].childNodes.map(textOf);
  assert.equal(labels.length, 1);
  assert.match(labels[0], /both-reconciled/);
  assert.match(labels[0], /r/, "and it shows its key");
});

test("every disposition button comes from item.allowed", async () => {
  const { app } = await mount();
  const labels = byClass(app, "disp")[0].childNodes.map(textOf);
  assert.equal(labels.length, ALLOWED.length);
  assert.ok(labels.some((l) => /no-change-needed\s*n/.test(l)), "no-change-needed carries its key");
});

test("a key hint is rendered only for dispositions that HAVE a key", async () => {
  const { ui } = await mount();
  assert.equal(ui.keyFor("no-change-needed"), "n");
  assert.equal(ui.keyFor("both-reconciled"), "r");
  assert.equal(ui.keyFor("wontfix"), null, "no key, so no hint to render");
});

test("an empty To-judge names where the work went (F7)", async () => {
  const empty = inboxOf({ ready: [READY[0]], blocked: BLOCKED, parked: PARKED });
  const m = await mount({ inbox: empty });
  const t = textOf(byClass(m.app, "empty")[0]);
  assert.match(t, /Nothing to judge \(2 edges checked\)/i, "it states what it checked");
  assert.match(t, /1 edge is blocked on 1 root/);
  assert.match(t, /1 edge need both sides edited/);
  assert.match(t, /1 parked/);
  assert.match(t, /357 never verified/);
  assert.ok(byTag(byClass(m.app, "empty")[0], "button").length >= 3, "and each destination is a button");
  click(btnText(byClass(m.app, "empty")[0], /Unblock/));
  await m.settle();
  assert.match(textOf(byClass(m.app, "div").find((b) => b.getAttribute("aria-current") === "page")), /UNBLOCK/);
});

/* -- Judge: evidence ------------------------------------------------------ */

test("evidence is fetched on select, once per edge, and only the NEXT row is prefetched (E3)", async () => {
  const m = await mount();
  assert.deepEqual(evidenceCalls(m), ["b", "c"], "the selected row and its neighbour -- not the queue");
  m.press("j");
  await m.settle();
  assert.deepEqual(evidenceCalls(m), ["b", "c", "d"], "c was cached, so only the new neighbour is fetched");
  m.press("k");
  await m.settle();
  assert.deepEqual(evidenceCalls(m), ["b", "c", "d"], "going back re-reads the cache, not the server");
});

test("both diffs render side by side, and the downstream says that unchanged IS drift", async () => {
  const { app } = await mount();
  const t = textOf(detail(app));
  assert.match(t, /-old b/);
  assert.match(t, /Unchanged since last judged\. The source moved and this did not: that is drift\./);
  assert.equal(byClass(app, "evgrid").length, 1);
  assert.equal(byClass(app, "evbox").length, 2);
});

test("verdict buttons are disabled while evidence loads, and enabled when it lands", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  // Evidence for b is held open on purpose: `untracked` keeps the harness from
  // waiting on the very request this test is trying to look at half-done.
  const m = await mount({ untracked: ["/api/evidence"], routes: { "/api/evidence": (c) => {
    const id = JSON.parse(c.body).edge_id;
    return id === "b" ? gate.then(() => evidenceFor("b")) : evidenceFor(id);
  } } });
  await sleep(200);   // past the 150ms debounce, so the request is genuinely outstanding
  assert.equal(m.fetches.filter((f) => f.path === "/api/evidence").length, 1, "the held request should be the only one so far");
  const held = byTag(byClass(m.app, "disp")[0], "button");
  assert.ok(held.length > 0 && held.every((b) => b.disabled === true || b.getAttribute("disabled") !== null), "buttons must be disabled while the evidence is loading");
  assert.match(textOf(detail(m.app)), /waiting for the evidence/);
  // And the KEY is refused too, not just the button.
  typeInto(byTag(m.app, "textarea")[0], "a perfectly adequate reason");
  m.press("n");
  await sleep(10);
  assert.equal(byClass(m.app, "undo").length, 0, "a verdict key was accepted before the evidence had arrived");
  release();
  await sleep(30);
  await m.settle();
  const after = byTag(byClass(m.app, "disp")[0], "button");
  assert.ok(after.every((b) => !b.disabled && b.getAttribute("disabled") === null), "buttons should enable once the evidence has loaded");
});

test("an evidence ERROR enables the verdict and says so (the diff must not block judging)", async () => {
  const m = await mount({ routes: { "/api/evidence": respond(500, { ok: false, error: "git exploded" }) } });
  const t = textOf(detail(m.app));
  assert.match(t, /evidence/i);
  assert.match(t, /git exploded/);
  assert.match(t, /judging without the diff/);
  const verdicts = byClass(m.app, "disp")[0].childNodes;
  assert.ok(verdicts.length > 0 && verdicts.every((b) => !b.getAttribute("disabled") && b.disabled !== true), "an unreadable diff must not disable the buttons");
});

/* -- Judge: the reason belongs to an EDGE (#70.1) ------------------------- */

test("a reason typed on one edge never appears on another, and survives going back (plan test 2)", async () => {
  const m = await mount();
  typeInto(byTag(m.app, "textarea")[0], "reason typed for edge b only");
  m.press("j");
  await m.settle();
  const onC = byTag(m.app, "textarea")[0];
  assert.equal(onC.value ?? "", "", "edge c inherited edge b's reason -- the wrong-edge defect");
  assert.match(textOf(byClass(m.app, "rlabel")[0]), /Reason for c/, "the box says which edge it belongs to");
  m.press("k");
  await m.settle();
  assert.equal(byTag(m.app, "textarea")[0].value, "reason typed for edge b only", "going back lost the text");
});

test("a verdict sends the reason of the edge it was pressed on, with the content ids it SAW (F1)", async () => {
  const m = await mount();
  typeInto(byTag(m.app, "textarea")[0], "checked lib/b.mjs:1 against commands/b.mjs");
  m.press("j");                       // move away: b's text must stay b's
  await m.settle();
  m.press("k");
  await m.settle();
  m.press("n");
  await m.settle();
  const [call] = disposeCalls(m);
  assert.ok(call, "no dispose request was made");
  assert.deepEqual(fromRealm(JSON.parse(call.body)), {
    edge_id: "b", disposition: "no-change-needed", reason: "checked lib/b.mjs:1 against commands/b.mjs",
    observed: { source: "s-b", downstream: "d-b" },
  });
  assert.equal(call.opts.keepalive, true, "the write must outlive the page (F8)");
});

test("a verdict with a short reason is refused on the page and writes nothing", async () => {
  const m = await mount();
  typeInto(byTag(m.app, "textarea")[0], "short");
  m.press("n");
  await m.settle();
  assert.match(textOf(detail(m.app)), /reason of 12 or more characters/);
  assert.equal(disposeCalls(m).length, 0);
});

/* -- the undo window ------------------------------------------------------ */

test("the undo window is five seconds and is not a compensating event", async () => {
  const { ui } = await mount();
  assert.equal(ui.UNDO_MS, 5000);
});

test("a held verdict hides its row, and undo brings it back having written nothing (F8)", async () => {
  const m = await mount();
  typeInto(byTag(m.app, "textarea")[0], "a perfectly adequate reason");
  m.press("n");
  await sleep(10);
  assert.ok(!rows(m.app).some((r) => /lib\/b\.mjs/.test(textOf(r))), "a row you just judged is still judgeable while its write is pending");
  assert.ok(byClass(m.app, "undo").length, "the undo bar is up");
  m.press("u");
  await m.settle();
  assert.ok(rows(m.app).some((r) => /lib\/b\.mjs/.test(textOf(r))), "undo should return the row");
  assert.equal(disposeCalls(m).length, 0, "an undone verdict must write nothing");
  assert.equal(byTag(m.app, "textarea")[0].value, "a perfectly adequate reason", "and the reason is kept");
});

test("a refused single verdict leaves the row and keeps the reason", async () => {
  const m = await mount({ routes: { "/api/dispose": respond(409, { ok: false, error: "edge moved to REVERSED since selection" }) } });
  typeInto(byTag(m.app, "textarea")[0], "a perfectly adequate reason");
  m.press("n");
  await m.settle();
  assert.match(textOf(detail(m.app)), /edge moved to REVERSED/);
  assert.ok(rows(m.app).some((r) => /lib\/b\.mjs/.test(textOf(r))), "the row must come back");
  assert.equal(byTag(m.app, "textarea")[0].value, "a perfectly adequate reason", "the reason must survive a refusal");
});

test("under reduced motion the ring is replaced by a NUMBER, not removed", async () => {
  // The ring IS the clock. Hiding it without a fallback removes the
  // information rather than the animation.
  const { stylesheet } = await import("../../commands/ui.mjs"); // the CSS as served (commands/ui/css/*.css, joined)
  const css = stylesheet();
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.ring \{ display: none/);
  assert.match(read("commands/ui.client.js"), /reduced \? left \+ "s" : ""/);
});

/* -- bulk (D1) ------------------------------------------------------------ */

test("nothing is ticked or preselected when the page opens (plan test 3a)", async () => {
  const { app } = await mount();
  const boxes = ticks(app);
  assert.equal(boxes.length, 3, "one native checkbox per row");
  assert.ok(boxes.every((b) => !b.checked), "a row arrived ticked: bulk must never be pre-chosen");
  assert.ok(boxes.every((b) => /^select /.test(b.getAttribute("aria-label"))), "each checkbox is labelled source to downstream (F3)");
});

test("x ticks across groups, and the bulk verdict offers only the dispositions EVERY row allows (plan test 3b)", async () => {
  const m = await mount();
  m.press("x");                       // b
  click(btnText(m.app, /Both sides moved/));
  await m.settle();
  m.press("x");                       // a -- DIVERGED, allowed only both-reconciled
  await m.settle();
  m.press("J");
  await m.settle();
  const t = textOf(detail(m.app));
  assert.match(t, /2 edges, one verdict/);
  assert.match(t, /Nothing is preselected/);
  assert.equal(byClass(m.app, "disp").length, 0, "a DRIFTED edge and a DIVERGED one share no disposition, so none may be offered");
  assert.match(t, /share no disposition/);
});

test("with a shared disposition set the bulk bar offers exactly the intersection", async () => {
  const m = await mount();
  m.press("x"); m.press("j"); m.press("x"); m.press("j"); m.press("x");
  await m.settle();
  m.press("J");
  await m.settle();
  const labels = byClass(m.app, "disp")[0].childNodes.map(textOf);
  assert.equal(labels.length, ALLOWED.length, "b, c and d all allow the same seven");
  assert.match(textOf(detail(m.app)), /3 edges, one verdict/);
});

test("a bulk verdict sends {edges}, never node_id, with one reason and each edge's own state (plan test 3c)", async () => {
  const m = await mount();
  m.press("x"); m.press("j"); m.press("x");     // b and c: the SAME node
  await m.settle();
  m.press("J");
  await m.settle();
  typeInto(byTag(m.app, "textarea")[0], "both read against their sources");
  await m.settle();
  click(btnText(byClass(m.app, "disp")[0], /no-change-needed/));
  await m.settle();
  const [call] = disposeCalls(m);
  assert.ok(call, "no dispose request");
  const body = fromRealm(JSON.parse(call.body));
  assert.equal(body.node_id, undefined, "a selection must not use the node_id shape: it cannot express a cross-node set");
  assert.deepEqual(body.edges.map((e) => [e.edge_id, e.state]), [["b", "DRIFTED"], ["c", "DRIFTED"]]);
  assert.equal(body.disposition, "no-change-needed");
  assert.equal(body.reason, "both read against their sources");
  assert.deepEqual(body.edges[0].observed, { source: "s-b", downstream: "d-b" }, "evidence that was shown is echoed back");
});

test("a bulk verdict is ONE held batch: undo writes nothing for any member", async () => {
  const m = await mount();
  m.press("x"); m.press("j"); m.press("x");
  await m.settle();
  m.press("J");
  await m.settle();
  typeInto(byTag(m.app, "textarea")[0], "both read against their sources");
  await m.settle();
  click(btnText(byClass(m.app, "disp")[0], /no-change-needed/));
  await sleep(10);
  assert.equal(byClass(m.app, "undo").length, 1, "one undo bar for the whole batch");
  m.press("u");
  await m.settle();
  assert.equal(disposeCalls(m).length, 0);
});

test("a partial bulk (207) names each refusal and leaves ONLY the refused rows ticked", async () => {
  const m = await mount({ routes: { "/api/dispose": respond(207, { ok: false, results: [
    { edge_id: "b", ok: true, event_id: "e1" },
    { edge_id: "c", ok: false, code: 409, error: "edge moved to REVERSED since selection — reload" },
  ] }) } });
  m.press("x"); m.press("j"); m.press("x");
  await m.settle();
  m.press("J");
  await m.settle();
  typeInto(byTag(m.app, "textarea")[0], "both read against their sources");
  await m.settle();
  click(btnText(byClass(m.app, "disp")[0], /no-change-needed/));
  await m.settle();
  const t = textOf(detail(m.app));
  assert.match(t, /1 written · 1 refused/);
  assert.match(t, /c: edge moved to REVERSED/);
  const live = findAll(m.app, (n) => n.nodeType === 1 && n.getAttribute("aria-live") === "polite");
  assert.match(textOf(live[0]), /1 refused/, "the failure is announced, not only drawn");
  const checked = ticks(m.app).filter((b) => b.checked);
  assert.equal(checked.length, 1, "exactly the refused row stays ticked");
});

test("Esc clears the selection", async () => {
  const m = await mount();
  m.press("x");
  await m.settle();
  assert.ok(ticks(m.app).some((b) => b.checked));
  m.press("Escape");
  await m.settle();
  assert.ok(!ticks(m.app).some((b) => b.checked));
});

test("the selection is pruned against every payload (F8)", async () => {
  // A tick on an edge another window judged must not survive the payload that lost
  // it -- and must not come BACK ticked if a later payload returns the edge. The
  // visible symptom is the strip's count: tickedRows filters by what is on screen,
  // so only the strip, which reads the set itself, shows a stale tick.
  const without = inboxOf({ ready: READY.filter((r) => r.edge_id !== "c") });
  const m = await mount({ inbox: undefined, routes: { "/api/inbox": (c) => (c.n === 2 ? without : INBOX) } });
  m.press("x"); m.press("j"); m.press("x");
  await m.settle();
  assert.match(textOf(byClass(m.app, "bulkstrip")[0]), /2 edges ticked/);
  click(btnText(m.app, /^refresh$/));
  await m.settle();
  assert.match(textOf(byClass(m.app, "bulkstrip")[0]), /1 edge ticked/, "the vanished edge is still counted in the selection");
  click(btnText(m.app, /^refresh$/));          // c is back
  await m.settle();
  assert.match(textOf(byClass(m.app, "bulkstrip")[0]), /1 edge ticked/, "a pruned tick came back when its edge returned");
  const cBox = ticks(m.app)[rows(m.app).findIndex((r) => /lib\/c\.mjs/.test(textOf(r)))];
  assert.ok(cBox && !cBox.checked, "c returned ticked");
});

test("pruneTicked drops ids that left the payload and keeps the ones that did not", async () => {
  const { ui } = await mount();
  const out = ui.pruneTicked(new Set(["a", "b", "z"]), new Set(["a", "b"]));
  assert.deepEqual([...out].sort(), ["a", "b"]);
  const same = new Set(["a"]);
  assert.equal(ui.pruneTicked(same, new Set(["a"])), same, "nothing to prune returns the same set so no re-render is caused");
});

/* -- the other populations: parked (D11), unplaced, never verified --------- */

test("a parked edge is judgeable: its dispositions are derived, its evidence is labelled, its body carries NEVER_VERIFIED", async () => {
  const m = await mount({ routes: { "/api/evidence": (c) => {
    const id = JSON.parse(c.body).edge_id;
    if (id !== "p1") return evidenceFor(id);
    return { ok: true, kind: "diff", side: "source", text: "current source", truncated: null, since: null, noPriorVerdict: true,
      reason: "no earlier verdict to diff against — showing the current content",
      downstream: { ok: true, kind: "diff", side: "downstream", text: "current downstream", noPriorVerdict: true, reason: "no earlier verdict to diff against — showing the current content" },
      contentIds: { source: "s-p1", downstream: "d-p1" } };
  } } });
  click(btnText(m.app, /^Parked/));
  await m.settle();
  const t = textOf(detail(m.app));
  assert.match(t, /Parked 20 days ago by rupali: waiting on the upstream rename/);
  assert.match(t, /no earlier verdict to diff against/);
  assert.equal(byTag(byClass(m.app, "disp")[0], "button").length, ALLOWED.length, "parked dispositions come from the queue's own allowed lists");
  typeInto(byTag(m.app, "textarea")[0], "waiting is over, both read");
  m.press("n");
  await m.settle();
  const body = JSON.parse(disposeCalls(m)[0].body);
  assert.deepEqual(fromRealm(body), { edge_id: "p1", disposition: "no-change-needed", reason: "waiting is over, both read", observed: { source: "s-p1", downstream: "d-p1" } });
});

test("edges counted but not placed in the fix order are named, never silently dropped", async () => {
  const inbox = inboxOf();
  inbox.worklist = { ...inbox.worklist, toJudgeIncludesUnplaced: 2 };
  const m = await mount({ inbox });
  assert.match(textOf(byClass(m.app, "list")[0]), /2 edges in the count have no place in the fix order and cannot be listed here/);
});

test("Never verified is read-only: counts and the buckets, the reason there is no button, and a copyable bulk command", async () => {
  const m = await mount({ routes: { "/api/baseline": { buckets: { baselineable: 6, noCoCommit: 253, boundReached: 1, ineligibleCrossRepo: 64, examinedAndDeferred: 33 },
    total: 357, accountedFor: true, unaccounted: 0, error: null } } });
  const log = withPlot(m);
  click(btnText(m.app, /Never verified/));
  await m.settle();
  const t = textOf(byClass(m.app, "detail")[0]);
  assert.match(t, /357 never verified/);
  assert.match(t, /never clear/i);
  assert.match(t, /It is not a baseline|It is not a backlog/);
  assert.match(t, /UI writes no baseline/);
  assert.equal(byTag(byClass(m.app, "disp")[0] ? m.app : byClass(m.app, "detail")[0], "textarea").length, 0, "a never-verified view must offer no verdict form");
  assert.ok(byClass(m.app, "cmd").some((c) => /propagate bootstrap --baseline-from-git/.test(textOf(c))));
  // The five buckets are a Plot chart now (the div Bars are gone); the PERMANENT one is a datum, not text on the page.
  const bars = fromRealm(m.ui.bucketBars({ baselineable: 6, noCoCommit: 253, boundReached: 1, ineligibleCrossRepo: 64, examinedAndDeferred: 33 }, 357));
  assert.equal(bars.length, 5);
  assert.ok(bars.some((b) => /PERMANENT/.test(b.label) && b.tone === "permanent"));
  assert.equal(log.shapes.length, 5, "one drawn shape per bucket");
});

test("a never-verified bucket leads somewhere only when something is there: Parked opens, baselineable copies, the rest say why not", async () => {
  const k = { baselineable: 6, noCoCommit: 253, boundReached: 1, ineligibleCrossRepo: 64, examinedAndDeferred: 33 };
  const m = await mount({ routes: { "/api/baseline": { buckets: k, total: 357, accountedFor: true, unaccounted: 0, error: null } } });
  const wrote = clipboard(m);
  const log = withPlot(m);
  click(btnText(m.app, /Never verified/));
  await m.settle();
  const bars = fromRealm(m.ui.bucketBars(k, 357));
  const at = (id) => log.shapes[bars.findIndex((b) => b.id === id)];
  // the pure mapping first: every bucket has a target or a stated reason, never a bare bar
  for (const b of bars) {
    const target = m.ui.barTarget("buckets", b);
    assert.ok(target || /no list to open/.test(b.hint), b.id + " is neither clickable nor explains why not");
  }
  assert.equal(fromRealm(m.ui.barTarget("buckets", bars.find((b) => b.id === "examinedAndDeferred"))).route, "judge?chip=parked");
  // and the drawn shapes
  const before = m.ctx.location.hash;
  hover(at("noCoCommit"));
  await m.settle();
  assert.match(textOf(tipBox(m.app)), /253 edges.*no list to open/);
  click(at("noCoCommit"));
  await m.settle();
  assert.equal(m.ctx.location.hash, before, "an inert bucket must not navigate");
  assert.equal(wrote.length, 0, "an inert bucket must not copy");
  click(at("baselineable"));
  await m.settle();
  assert.deepEqual(wrote, ["propagate bootstrap --baseline-from-git"]);
  click(at("examinedAndDeferred"));
  await m.settle();
  assert.equal(m.ctx.location.hash, "#/judge?chip=parked");
});

test("a baseline split that does not add up SAYS so", async () => {
  const m = await mount({ routes: { "/api/baseline": { buckets: { baselineable: 1, noCoCommit: 1, boundReached: 0, ineligibleCrossRepo: 0, examinedAndDeferred: 0 },
    total: 99, accountedFor: false, unaccounted: 97, error: null } } });
  click(btnText(m.app, /Never verified/));
  await m.settle();
  assert.match(textOf(byClass(m.app, "detail")[0]), /do not sum to the total/);
});

/* -- the seen-set and the "new" dot (D12) ---------------------------------- */

test("a 'new' dot marks edges whose content key is not in the seen-set -- and OPENING Judge writes nothing", async () => {
  const m = await mount({ routes: { "/api/seen-edges": { ok: true, status: "ok", triples: ["b|s-b|d-b"] } } });
  const dots = byClass(m.app, "newdot");
  assert.equal(dots.length, 2, "c and d are new; b is seen");
  assert.ok(!rows(m.app).filter((r) => /lib\/b\.mjs/.test(textOf(r))).some((r) => byClass(r, "newdot").length));
  assert.equal(m.fetches.filter((f) => f.path === "/api/seen-edges" && f.opts.method === "POST").length, 0,
    "advance-on-view: the cursor moved just because the page opened (PR-023)");
});

test("'Mark seen' posts the triples that were RENDERED, and the dots go", async () => {
  const m = await mount({ routes: { "/api/seen-edges": (c) => (c.opts.method === "POST" ? { ok: true } : { ok: true, status: "ok", triples: [] }) } });
  assert.equal(byClass(m.app, "newdot").length, 3);
  click(btnText(m.app, /^Mark seen$/));
  await m.settle();
  const post = m.fetches.find((f) => f.path === "/api/seen-edges" && f.opts.method === "POST");
  assert.ok(post, "no POST");
  assert.deepEqual(fromRealm(JSON.parse(post.body).triples).sort(), ["b|s-b|d-b", "c|s-c|d-c", "d|s-d|d-d"]);
  assert.equal(byClass(m.app, "newdot").length, 0);
});

test("leaving Judge posts what was on screen", async () => {
  const m = await mount({ routes: { "/api/seen-edges": (c) => (c.opts.method === "POST" ? { ok: true } : { ok: true, status: "ok", triples: [] }) } });
  m.setHash("#/unblock");
  await m.settle();
  const post = m.fetches.find((f) => f.path === "/api/seen-edges" && f.opts.method === "POST");
  assert.ok(post, "leaving Judge should record what the reader saw");
  assert.equal(fromRealm(JSON.parse(post.body).triples).length, 3);
});

test("with no seen-set yet, nothing is marked new -- and the page says why", async () => {
  // "missing" is a first look. Marking all edges new would be 78 dots meaning nothing.
  const m = await mount({ routes: { "/api/seen-edges": { ok: true, status: "missing", triples: [] } } });
  assert.equal(byClass(m.app, "newdot").length, 0);
  assert.match(textOf(byClass(m.app, "list")[0]), /No seen-set yet/);
});

/* -- routing -------------------------------------------------------------- */

test("every old hash lands on its new view, and an unknown hash lands on Judge (plan test 4)", async () => {
  const { ui } = await mount();
  const table = { ready: "judge", parked: "judge", gap: "judge", blocked: "unblock", reference: "health",
    analytics: "activity", stream: "activity", conflicts: "reminders", graph: "graph",
    judge: "judge", unblock: "unblock", health: "health", activity: "activity", registers: "registers", reminders: "reminders" };
  for (const [old, want] of Object.entries(table)) {
    for (const spelling of ["#" + old, "#/" + old]) {
      const m = await mountClient({ inbox: INBOX, hash: spelling, routes: { "/api/surface": SURFACE, "/api/seen-edges": { ok: true, status: "ok", triples: [] },
        "/api/health": { ok: false, reason: "x" }, "/api/registers": { error: null, issues: [], todos: [], handovers: [] }, "/api/conflicts": { ok: true, rows: [], summary: { total: 0 } },
        "/graph": rawText(200, "<html></html>"), "/api/evidence": (c) => evidenceFor(JSON.parse(c.body).edge_id) } });
      const on = byClass(m.app, "div").filter((b) => b.getAttribute("aria-current") === "page").map(textOf).join("");
      assert.match(on, new RegExp(want.toUpperCase()), `${spelling} should open ${want}, opened ${on}`);
    }
  }
  assert.equal(ui.readHash().view, "judge");
});

test("readHash parses ?edge= and an unknown hash falls back to judge", async () => {
  const m = await mount({ hash: "#/judge?edge=abc%20d" });
  const none = { section: null, state: null, chip: null, focus: null, ws: null, age: null, source: null };
  assert.deepEqual(fromRealm(m.ui.readHash()), { view: "judge", edge: "abc d", ...none });
  m.ctx.location.hash = "#/nonsense";
  assert.deepEqual(fromRealm(m.ui.readHash()), { view: "judge", edge: null, ...none });
  // Deep links (2026-10-15): section / state / chip ride in the hash beside edge.
  m.ctx.location.hash = "#/health?section=Workspace%3A";
  assert.deepEqual(fromRealm(m.ui.readHash()), { view: "health", edge: null, ...none, section: "Workspace:" });
});

test("?state= filters To judge to that state and SAYS so with a clearable control", async () => {
  const m = await mount({ hash: "#/judge?state=REVERSED" });
  const filt = byClass(m.app, "filt");
  assert.equal(filt.length, 1, "a filtered list must never look like the whole queue");
  assert.match(textOf(filt[0]), /only reversed/);
  assert.ok(byClass(m.app, "item").every((r) => !/DRI/.test(textOf(r))), "no DRIFTED row survives a REVERSED filter");
});

test("?chip=both opens Both sides moved; an unknown chip or state is ignored, never a blank list", async () => {
  const m = await mount({ hash: "#/judge?chip=both" });
  assert.match(textOf(byClass(m.app, "chip").find((c) => /\bon\b/.test(c.getAttribute("class")))), /Both sides moved/);
  const u = await mount({ hash: "#/judge?chip=nope&state=EVERYTHING" });
  assert.equal(byClass(u.app, "filt").length, 0, "an unknown state must not filter");
  assert.match(textOf(byClass(u.app, "chip").find((c) => /\bon\b/.test(c.getAttribute("class")))), /To judge/);
});

test("?edge= selects that edge, switching to the chip it lives in", async () => {
  // Unblock's "Judge root" lands here, and a DIVERGED root is not under To judge.
  const m = await mount({ hash: "#/judge?edge=a" });
  const sel = byClass(m.app, "sel");
  assert.ok(sel.length && /lib\/a\.mjs/.test(textOf(sel[0])), "the DIVERGED root should be selected under its own chip");
  assert.match(textOf(byClass(m.app, "chip").find((c) => /on/.test(c.getAttribute("class")))), /Both sides moved/);
});

/* -- Unblock -------------------------------------------------------------- */

test("Unblock shows the stat row, ranks roots that free something, and 'Judge root' routes to ?edge=", async () => {
  const m = await mount({ hash: "#/unblock" });
  const t = textOf(detail(m.app));
  assert.match(t, /Blocked\s*1/);
  assert.match(t, /Roots\s*1/);
  assert.match(t, /Need several\s*0/);
  // the root list is a DataTable: two sortable number columns beside the edge, not a sentence
  const root = dtRows(detail(m.app))[0];
  assert.deepEqual(byTag(root, "td").slice(2, 4).map(textOf), ["1", "1"], "frees now and upstream of");
  assert.deepEqual(byTag(detail(m.app), "th").map((h) => textOf(h).replace(/ [▴▾]$/, "")), ["kind", "edge", "frees now", "upstream of", ""]);
  assert.match(textOf(root), /propagate\/lib\/a\.mjs/);
  click(btnText(detail(m.app), /Judge root/));
  await m.settle();
  assert.equal(m.ctx.location.hash, "#/judge?edge=a");
  assert.match(textOf(byClass(m.app, "div").find((b) => b.getAttribute("aria-current") === "page")), /JUDGE/);
});

test("a root outside the queue is NEVER VERIFIED: a shell-quoted command, and no Judge button", async () => {
  const items = [edge("x", "DRIFTED", { orderIndex: 0, blocked: true, blockedBy: [{ edge_id: "it's-root", from: "/u/Documents/GitHub/k/a.md", to: "/u/Documents/GitHub/k/b.md", state: "NEVER_VERIFIED" }] })];
  const inbox = inboxOf({ ready: [], blocked: items, parked: [] });
  const m = await mount({ inbox, hash: "#/unblock" });
  const t = textOf(detail(m.app));
  assert.match(t, /NEVER VERIFIED/);
  assert.ok(!btnText(detail(m.app), /Judge root/), "a root that is not in the queue cannot be judged here");
  const cmd = textOf(byClass(m.app, "cmd")[0]);
  assert.equal(cmd, `propagate verify --edge 'it'\\''s-root' --disposition baselined --reason '<what you checked, as file:line>' --apply`,
    "the id must be shell-quoted so a quote in it cannot end the argument");
});

test("joint blockers are grouped under the file their edges flow into", async () => {
  const mk = (id, ...roots) => edge(id, "DRIFTED", { orderIndex: 9, blocked: true, node_id: "n:" + id,
    blockedBy: roots.map((r) => ({ edge_id: r, from: "/u/Documents/GitHub/p/" + r + ".md", to: "/u/Documents/GitHub/p/" + r + "-dst.md", state: "DRIFTED" })),
    downstream: "/u/Documents/GitHub/p/shared.md", downstreamShort: "p/shared.md" });
  const roots = [edge("r1", "DRIFTED", { orderIndex: 0 }), edge("r2", "DRIFTED", { orderIndex: 1 })];
  const inbox = inboxOf({ ready: roots, blocked: [mk("j1", "r1", "r2"), mk("j2", "r1", "r2")], parked: [] });
  const m = await mount({ inbox, hash: "#/unblock" });
  const t = textOf(detail(m.app));
  assert.match(t, /2 blocked edges flow into p\/shared\.md; settle these roots together/);
  assert.equal(byClass(m.app, "fgroup").length, 1);
  assert.match(t, /Need several\s*2/);
});

test("joint blockers sharing one root set are ONE group naming every file (live pass 2026-10-15)", async () => {
  const mk = (id, dst, ...roots) => edge(id, "DRIFTED", { orderIndex: 9, blocked: true, node_id: "n:" + id,
    blockedBy: roots.map((r) => ({ edge_id: r, from: "/u/Documents/GitHub/p/" + r + ".md", to: "/u/Documents/GitHub/p/" + r + "-dst.md", state: "DRIFTED" })),
    downstream: "/u/Documents/GitHub/p/" + dst, downstreamShort: "p/" + dst });
  const roots = [edge("r1", "DRIFTED", { orderIndex: 0 }), edge("r2", "DRIFTED", { orderIndex: 1 })];
  const inbox = inboxOf({ ready: roots, blocked: [mk("j1", "a.md", "r1", "r2"), mk("j2", "b.md", "r2", "r1")], parked: [] });
  const m = await mount({ inbox, hash: "#/unblock" });
  const t = textOf(detail(m.app));
  assert.equal(byClass(m.app, "fgroup").length, 1, "the same root set must not repeat once per file");
  assert.match(t, /2 blocked edges flow into p\/a\.md and p\/b\.md; settle these roots together/);
});

test("an empty Unblock states what it checked", async () => {
  const inbox = inboxOf({ blocked: [] });
  const m = await mount({ inbox, hash: "#/unblock" });
  assert.match(textOf(detail(m.app)), /Nothing is blocked \(4 edges checked\)/);
});

/* -- Health --------------------------------------------------------------- */

const HEALTH = {
  ok: true, ageMs: 14 * 60000, generatedAt: "2026-10-15T09:46:00Z", problems: 2,
  totals: { pass: 5, warn: 3, fail: 2, info: 0, note: 0, accepted: 1 },
  sections: [
    { name: "Rules", pass: 1, warn: 0, fail: 1, info: 0, note: 0, accepted: 1, entries: [
      { kind: "fail", label: "CLAUDE.md restates rule:x", detail: "3 findings", action: { kind: "open", target: "/u/Documents/GitHub/CLAUDE.md" } },
      { kind: "accepted", label: "a.md restates rule:y", detail: "since 2026-10-01", action: { kind: "command", target: "propagate rules check" } },
    ] },
    { name: "State", pass: 4, warn: 3, fail: 1, info: 0, note: 0, accepted: 0, entries: [
      { kind: "fail", label: "workspaces conform", detail: "1 empty" },
      { kind: "warn", label: "a warning", detail: "d1" }, { kind: "warn", label: "another", detail: "d2" }, { kind: "warn", label: "third", detail: "d3" },
    ] },
  ],
};

test("?section= opens Health AT that section: a summary line, its rows marked, its warnings open", async () => {
  const m = await mount({ hash: "#/health?section=State", routes: { "/api/health": HEALTH } });
  const banner = byClass(m.app, "banner").find((b) => /focus/.test(b.getAttribute("class")));
  assert.ok(banner, "a focused section always shows SOMETHING, even when it is all green");
  assert.match(textOf(banner), /State · 1 fail · 0 accepted · 3 warn · 4 pass/);
  const marked = dtRows(m.app).filter((r) => /\bfocus\b/.test(r.getAttribute("class")));
  assert.equal(marked.length, 1, "only State's fail row is marked, not Rules'");
  assert.match(textOf(marked[0]), /workspaces conform/);
  const unknown = await mount({ hash: "#/health?section=Nope", routes: { "/api/health": HEALTH } });
  assert.match(textOf(byClass(unknown.app, "banner").find((b) => /focus/.test(b.getAttribute("class")))), /no doctor section by that name/);
});

test("Health opens with one derived line, then fail rows before accepted rows, each with its action", async () => {
  const m = await mount({ hash: "#/health", routes: { "/api/health": HEALTH } });
  const t = textOf(detail(m.app));
  assert.match(t, /2 fail · 1 accepted · 3 warn in 1 section · snapshot 14 min old/);
  assert.ok(byTag(detail(m.app), "button").some((b) => /re-run doctor/.test(textOf(b))), "re-run doctor is a copyable command");
  const hrows = dtRows(m.app).map(textOf);
  const kinds = byClass(m.app, "badge").map(textOf);
  assert.deepEqual(kinds.filter((k) => /FAIL|ACCEPTED/.test(k)), ["FAIL", "FAIL", "ACCEPTED"], "fail rows come first");
  assert.ok(hrows.some((r) => /CLAUDE\.md restates rule:x.*CLAUDE\.md/.test(r)), "an open action carries its path");
  assert.ok(hrows.some((r) => /propagate rules check/.test(r)), "a command action carries its command");
  assert.ok(hrows.some((r) => /workspaces conform.*no action mapped/.test(r)), "an unmapped check says so rather than showing nothing");
  assert.equal(byTag(detail(m.app), "details").length, 1, "warn is collapsed by section");
  assert.doesNotMatch(t, /Rules block/i);
});

test("an unreadable snapshot is a sentence with the way out, not an empty list", async () => {
  const m = await mount({ hash: "#/health", routes: { "/api/health": { ok: false, reason: "no snapshot yet", sections: null, ageMs: null } } });
  const t = textOf(detail(m.app));
  assert.match(t, /doctor snapshot unreadable: no snapshot yet/);
  assert.match(textOf(byClass(m.app, "cmd")[0]), /propagate doctor/);
});

test("zero failures reads as a result, with the snapshot age", async () => {
  const quiet = { ...HEALTH, totals: { ...HEALTH.totals, fail: 0, accepted: 0 }, sections: [{ name: "State", pass: 4, warn: 0, fail: 0, info: 0, note: 0, accepted: 0, entries: [] }] };
  const m = await mount({ hash: "#/health", routes: { "/api/health": quiet } });
  assert.match(textOf(detail(m.app)), /0 fail/);
  assert.match(textOf(detail(m.app)), /snapshot 14 min old/);
});

/* -- Activity ------------------------------------------------------------- */

test("Activity draws verdicts as a Plot bar per day and kind, and states its share without NaN", async () => {
  const m = await mount({ hash: "#/judge" });
  const log = withPlot(m);
  m.setHash("#/activity"); await m.settle();
  const t = textOf(detail(m.app));
  const verdicts = log.all.find((l) => l.o.marks.some((mk) => mk.o && mk.o.x === "day" && mk.o.fill === "kind"));
  assert.ok(verdicts, "the verdict chart went to Plot");
  assert.equal(verdicts.n.querySelectorAll().length, 6, "two kinds for each of the three days");
  assert.match(t, /71% of 7 verdicts in 3 days recorded that nothing needed doing/);
  assert.ok(log.all.some((l) => l.o.marks.some((mk) => mk.o && mk.o.y === "command")), "the commands chart went to Plot too");
  assert.doesNotMatch(t, /NaN|undefined/);
  assert.equal(byClass(m.app, "vcol").length + byClass(m.app, "vseg-quiet").length + byClass(m.app, "changed").length, 0, "the hand-built columns are gone");
});

test("Activity says what could not be read and why, never 14 zeros -- and never the word 'unknown'", async () => {
  const bad = { ...SURFACE, velocity: { status: "unknown", reason: "event store unreadable: EACCES", days: [] }, usage: { status: "none-recorded", reason: "no command records in the runs store" } };
  const m = await mount({ hash: "#/activity", routes: { "/api/surface": bad } });
  const t = textOf(detail(m.app));
  assert.match(t, /could not read — event store unreadable: EACCES/);
  assert.match(t, /None recorded: no command records/);
  assert.doesNotMatch(t, /unknown/, "a failed read is 'could not read', not 'unknown' (Phase 0)");
  assert.equal(byClass(m.app, "plot").length, 0);
});

test("a day-less window with no events says so", async () => {
  const none = { ...SURFACE, velocity: { status: "ok", reason: null, windowDays: 14, events: 0, noChangeEvents: 0, noChangeShareOfEvents: null, days: [] } };
  const m = await mount({ hash: "#/activity", routes: { "/api/surface": none } });
  assert.match(textOf(detail(m.app)), /No verdicts in 14 days \(event store read\)/);
});

test("a day with no reading is a GAP in the runs chart, counted and never drawn as a zero", async () => {
  // The old sparkline broke its path at a null day. The line is bars now; the property is the same:
  // a day nobody measured is not a day with zero runs.
  const { ui } = await mount();
  const r = fromRealm(ui.runBars({ days: [{ day: "2026-10-13", count: 4 }, { day: "2026-10-14", count: null }, { day: "2026-10-15", count: 0 }] }));
  assert.deepEqual(r.bars.map((b) => b.day), ["2026-10-13", "2026-10-15"], "the unmeasured day has no bar");
  assert.equal(r.gaps, 1);
  assert.equal(r.bars.find((b) => b.day === "2026-10-15").count, 0, "a measured zero IS drawn");
  assert.deepEqual(r.days, ["2026-10-13", "2026-10-14", "2026-10-15"], "but it keeps its place on the axis");
});

/* -- Explore -------------------------------------------------------------- */

test("Reminders never prints 'undefined' for a failed read, whichever field carries the reason (#70.5)", async () => {
  // The bridge says `reason`; the server's own catch says `error`. The panel read only
  // the first, so a 200 {ok:false, error} printed "could not read the reminders list
  // — undefined".
  const viaError = await mount({ hash: "#/reminders", routes: { "/api/conflicts": { ok: false, error: "osascript exploded" } } });
  assert.match(textOf(detail(viaError.app)), /could not read the reminders list — osascript exploded/);
  const viaNeither = await mount({ hash: "#/reminders", routes: { "/api/conflicts": { ok: false } } });
  assert.match(textOf(detail(viaNeither.app)), /no reason was given/);
  for (const m of [viaError, viaNeither]) assert.doesNotMatch(textOf(m.app), /undefined/);
  const http = await mount({ hash: "#/reminders", routes: { "/api/conflicts": respond(500, { ok: false, error: "bridge down" }) } });
  assert.match(textOf(detail(http.app)), /bridge down/);
  assert.match(textOf(detail(http.app)), /Nothing was examined/);
});

test("Registers is read-only: rows and counts, no write control", async () => {
  const reg = { error: null,
    issues: [{ kind: "issue", short: "propagate/ISSUES.md", line: 10, text: "N1 · something", id: "N1", priority: "S2", actions: ["issue-close"] }],
    todos: [{ kind: "todo", short: "k/TODOS.md", line: 3, text: "do the thing", priority: null, actions: ["todo-tick"] }],
    handovers: [] };
  const m = await mount({ hash: "#/registers", routes: { "/api/registers": reg } });
  const t = textOf(detail(m.app));
  assert.match(t, /Issues\s*1/);
  assert.match(t, /Todos\s*1/);
  assert.match(t, /Handovers\s*0/);
  assert.match(t, /N1 · something/);
  // .length, not deepEqual on the nodes: a failing deepEqual diffs two cyclic DOM
  // trees and took 43 seconds to say "failed" when this guard was mutated (M43).
  assert.equal(buttons(detail(m.app)).length, 0, "a register write control arrived before its own design pass (D7)");
});

test("Graph has a loading state, an error state with a retry, and a loaded state", async () => {
  const bad = await mount({ hash: "#/graph", routes: { "/graph": rawText(500, "could not render the graph — boom") } });
  assert.match(textOf(detail(bad.app)), /could not render the graph — boom/);
  assert.ok(btnText(detail(bad.app), /retry/));
  const good = await mount({ hash: "#/graph", routes: { "/graph": rawText(200, "<html>g</html>") } });
  assert.equal(byTag(good.app, "iframe").length, 1);
  assert.equal(byTag(good.app, "iframe")[0].getAttribute("srcdoc"), "<html>g</html>");
});

/* -- how it fails: the api() wrapper (#70.4, plan test 5) ------------------ */

test("a 401 shows 'token expired, reopen from the widget' and not a skeleton or a crash", async () => {
  const m = await mount({ inbox: undefined, routes: { "/api/inbox": respond(401, { ok: false, error: "token" }) } });
  const t = textOf(byClass(m.app, "banner")[0]);
  assert.match(t, /token expired, reopen from the widget/);
  assert.equal(byClass(m.app, "skel").length, 0, "stuck on the skeleton");
  assert.ok(!btnText(byClass(m.app, "banner")[0], /retry/), "a dead token has nothing to retry");
});

test("a 500 shows the server's sentence and a retry that re-fetches", async () => {
  const m = await mount({ inbox: undefined, routes: { "/api/inbox": (c) => (c.n === 1 ? respond(500, { ok: false, error: "reconcile exploded" }) : INBOX) } });
  const b = byClass(m.app, "banner")[0];
  assert.match(textOf(b), /reconcile exploded/);
  assert.equal(byClass(m.app, "skel").length, 0);
  click(btnText(b, /retry/));
  await m.settle();
  assert.equal(byClass(m.app, "banner").length, 0, "the retry should have loaded the queue");
  assert.equal(rows(m.app).length, 3);
});

test("a rejected fetch ends in a sentence, not a skeleton", async () => {
  const m = await mount({ inbox: undefined, routes: { "/api/inbox": rejectWith(new Error("connect ECONNREFUSED")) } });
  assert.match(textOf(byClass(m.app, "banner")[0]), /could not reach the server — connect ECONNREFUSED/);
  assert.equal(byClass(m.app, "skel").length, 0);
});

test("a body that is not JSON ends in a sentence, not a skeleton", async () => {
  const m = await mount({ inbox: undefined, routes: { "/api/inbox": rawText(200, "<html>a proxy login page</html>") } });
  assert.match(textOf(byClass(m.app, "banner")[0]), /not JSON/);
  assert.equal(byClass(m.app, "skel").length, 0);
});

test("a per-division error renders in that division, and the rail survives", async () => {
  // REWRITTEN from the PARKED-only case. A failed division arrives as `ready: null`
  // plus an error, and reading the null as an empty list would say "nothing to judge"
  // about a queue that could not be computed.
  const broken = JSON.parse(JSON.stringify(INBOX));
  broken.divisions.worklist = { error: "fix-order join exploded", ready: null, blocked: null, unplaced: null, actionable: null };
  const { app, ui } = await mount({ inbox: broken });
  assert.match(textOf(byClass(app, "banner")[0]), /fix-order join exploded/);
  assert.doesNotMatch(textOf(byClass(app, "list")[0]), /Nothing to judge/, "a failed queue was reported as an empty one");
  assert.equal(byClass(app, "div").length, ui.DIVISIONS.length, "the rail still renders in full");

  const parked = JSON.parse(JSON.stringify(INBOX));
  parked.divisions.parked = { error: "walk exploded", items: null };
  const p = await mount({ inbox: parked });
  click(btnText(p.app, /^Parked/));
  await p.settle();
  assert.match(textOf(byClass(p.app, "banner")[0]), /walk exploded/);
  assert.doesNotMatch(textOf(byClass(p.app, "list")[0]), /Nothing parked/);
});

test("a fatal reconcile renders the reason, not an empty page", async () => {
  const { app } = await mount({ inbox: { fatal: "reconcile failed: no workspaces", divisions: null } });
  assert.match(textOf(byClass(app, "banner")[0]), /no workspaces/);
});

test("a stale response is ignored: the LATEST refresh wins even when an older one lands last (F8)", async () => {
  // The first refresh is slow and old; the second is fast and new. Without the
  // load number the slow one resolves last and paints the old data back.
  //
  // THE SLOW ONE IS BUILT WHEN IT IS ASKED FOR. The first version of this created
  // the promise at the top of the test, so its 60ms timer had long expired by the time
  // the refresh ran, "slow" resolved instantly and in order, and removing the guard
  // left the test green. Found by mutating the guard (M14) -- a test that cannot go red
  // for the reason it names.
  const old = { ...INBOX, declared: 111 };
  const fresh = { ...INBOX, declared: 222 };
  const m = await mount({ inbox: undefined, routes: { "/api/inbox": (c) =>
    (c.n === 1 ? INBOX : c.n === 2 ? new Promise((r) => setTimeout(() => r(old), 80)) : fresh) } });
  const refresh = btnText(m.app, /^refresh$/);
  click(refresh);                 // n=2, slow, old
  click(refresh);                 // n=3, fast, new
  await m.settle();
  assert.deepEqual(m.fetches.filter((f) => f.path === "/api/inbox").map((f) => f.n), [1, 2, 3], "both refreshes must have been issued");
  assert.match(textOf(byClass(m.app, "sum")[0]), /222/, "the older response overwrote the newer one");
});

test("refresh re-fetches the current view's own endpoints, and the badges with them (#70.7)", async () => {
  const m = await mount({ hash: "#/health", routes: { "/api/health": HEALTH } });
  const before = m.calls.length;
  click(btnText(m.app, /^refresh$/));
  await m.settle();
  const again = m.calls.slice(before);
  for (const p of ["/api/inbox", "/api/surface", "/api/health"]) assert.ok(again.includes(p), `refresh did not re-fetch ${p}: ${JSON.stringify(again)}`);
});

test("a server older than the page is announced (F5), and an unreadable version is not", async () => {
  const stale = await mount({ build: "page-build", routes: { "/api/version": { ok: true, build: "server-build" } } });
  assert.match(textOf(byClass(stale.app, "banner")[0]), /server older than page/);
  const same = await mount({ build: "page-build", routes: { "/api/version": { ok: true, build: "page-build" } } });
  assert.equal(byClass(same.app, "banner").length, 0);
  const unsure = await mount({ build: "page-build", routes: { "/api/version": rejectWith(new Error("down")) } });
  assert.equal(byClass(unsure.app, "banner").length, 0, "cannot tell is not stale");
});

/* -- every badge the views emit has a rule (the UNMATCHED lesson, derived) -- */

test("every badge class a rendered view emits has a stylesheet rule", async () => {
  // A badge with no rule renders as ink on NO background: the element is there, the
  // text is not, and nothing errors. The population is what the views actually
  // RENDER, gathered from the DOM -- a source regex went blind here, because most
  // modifiers are built at runtime ("badge " + state), and found one class of nine.
  const { stylesheet } = await import("../../commands/ui.mjs");
  const css = stylesheet().replace(/\/\*[\s\S]*?\*\//g, "");
  const seen = new Set();
  const unblockItems = [edge("x", "DRIFTED", { orderIndex: 0, blocked: true, blockedBy: [{ edge_id: "gone", from: "/u/Documents/GitHub/k/a.md", to: "/u/Documents/GitHub/k/b.md", state: "NEVER_VERIFIED" }] })];
  const registers = { error: null, issues: [{ text: "i", priority: "S2", short: "x" }], todos: [{ text: "t", priority: null, short: "y" }], handovers: [] };
  const reminders = { ok: true, list: "l", rows: [{ reminderId: "1", disposition: "held-no-register", reason: "r" }, { reminderId: "2", disposition: "already-inserted", reason: "r" }], summary: { total: 2 } };
  const runs = [
    ["#/judge", {}], ["#/unblock", {}], ["#/health", { "/api/health": HEALTH }], ["#/registers", { "/api/registers": registers }], ["#/reminders", { "/api/conflicts": reminders }],
  ];
  for (const [hash, routes] of runs) {
    const m = await mount({ hash, routes });
    for (const b of byClass(m.app, "badge")) for (const c of b.getAttribute("class").split(/\s+/)) if (c !== "badge") seen.add(c);
  }
  const un = await mount({ hash: "#/unblock", inbox: inboxOf({ ready: [], blocked: unblockItems, parked: [] }) });
  for (const b of byClass(un.app, "badge")) for (const c of b.getAttribute("class").split(/\s+/)) if (c !== "badge") seen.add(c);
  const dv = await mount({ hash: "#/judge" });
  click(btnText(dv.app, /Both sides moved/));
  await dv.settle();
  for (const b of byClass(dv.app, "badge")) for (const c of b.getAttribute("class").split(/\s+/)) if (c !== "badge") seen.add(c);

  assert.ok(seen.size >= 8, `only ${seen.size} badge classes seen (${[...seen].join(", ")}) -- the scan has gone blind`);
  for (const must of ["fail", "accepted", "NEVER_VERIFIED", "DIVERGED", "DRIFTED"]) assert.ok(seen.has(must), `${must} was never rendered, so its rule was never checked`);
  const bare = [...seen].filter((c) => !new RegExp(`\\.badge\\.${c}\\b`).test(css));
  assert.deepEqual(bare, [], `rendered with no rule: ${bare.join(", ")}`);
});

/* -- text and numbers ----------------------------------------------------- */

test("no view renders HTML-entity text, 'undefined' or 'NaN' (#70.2, #70.3, #70.6)", async () => {
  for (const hash of ["#/judge", "#/unblock", "#/health", "#/activity", "#/registers"]) {
    const m = await mount({ hash, routes: { "/api/health": HEALTH, "/api/registers": { error: null, issues: [], todos: [], handovers: [] } } });
    const t = textOf(m.app);
    assert.doesNotMatch(t, /&#\d+;|&[a-z]+;/, `${hash} rendered entity text`);
    assert.doesNotMatch(t, /undefined|NaN/, `${hash} rendered undefined/NaN`);
    assert.doesNotMatch(t, / · ·|· $|^ ·/, `${hash} has a stray separator`);
  }
});

test("pct and ratio cannot print NaN from a zero denominator", async () => {
  const { ui } = await mount();
  assert.equal(ui.ratio(0, 0), null);
  assert.equal(ui.pct(ui.ratio(1, 0)), "unknown");
  assert.equal(ui.pct(NaN), "unknown");
  assert.equal(ui.pct(Infinity), "unknown");
  assert.equal(ui.pct(0.5), "50%");
  assert.equal(ui.dot("a", null, "", false, undefined, "b"), "a · b");
});

/* -- the pure helpers, still reachable ------------------------------------ */

test("groupRows keeps first-seen order at both levels and never drops an unplaced edge", async () => {
  const { ui } = await mount();
  const rowsIn = [
    { edge_id: "1", node_id: "n:a", sourceShort: "w1/x", orderIndex: 0 },
    { edge_id: "2", node_id: "n:b", sourceShort: "w2/x", orderIndex: 1 },
    { edge_id: "3", node_id: "n:a", sourceShort: "w1/x", orderIndex: 2 },
    { edge_id: "4", node_id: "n:z", sourceShort: "w1/y", orderIndex: null, orderMissing: "absent from the worklist" },
  ];
  const out = ui.groupRows(rowsIn);
  assert.deepEqual(fromRealm(out.groups.map((g) => g.ws)), ["w1", "w2", "unplaced"]);
  assert.deepEqual(fromRealm(out.flat.map((r) => r.edge_id)), ["1", "3", "2", "4"], "grouped, but within a node the server's order holds");
});

test("disposeBody sends {edge_id} for one edge and {edges} for a selection -- never node_id", async () => {
  const { ui } = await mount();
  const one = ui.disposeBody({ kind: "edge", entries: [{ edge_id: "e1", state: "DRIFTED" }], disposition: "deferred", reason: "long enough reason here" });
  assert.deepEqual(fromRealm(one), { edge_id: "e1", disposition: "deferred", reason: "long enough reason here" });
  const many = ui.disposeBody({ kind: "bulk", entries: [{ edge_id: "a", state: "DRIFTED", observed: { source: "s", downstream: "d" } }, { edge_id: "b", state: "REVERSED" }],
    disposition: "no-change-needed", reason: "checked both sides" });
  assert.deepEqual(fromRealm(many), { edges: [{ edge_id: "a", state: "DRIFTED", observed: { source: "s", downstream: "d" } }, { edge_id: "b", state: "REVERSED" }],
    disposition: "no-change-needed", reason: "checked both sides" });
  assert.equal(many.node_id, undefined);
});

test("counts reports an unloaded count as null, never as 0", async () => {
  const { ui } = await mount();
  assert.deepEqual(fromRealm(ui.counts(null)), {});
  const partial = JSON.parse(JSON.stringify(INBOX));
  delete partial.worklist;
  assert.equal(ui.counts(partial).judge, null);
});

test("intersectAllowed is the dispositions every row allows, in the first row's order", async () => {
  const { ui } = await mount();
  assert.deepEqual(fromRealm(ui.intersectAllowed([{ allowed: ["a", "b", "c"] }, { allowed: ["c", "b"] }])), ["b", "c"]);
  assert.deepEqual(fromRealm(ui.intersectAllowed([])), []);
  assert.deepEqual(fromRealm(ui.intersectAllowed([{ allowed: ["a"] }, { allowed: ["b"] }])), []);
});

test("a parked row's dispositions are derived from the queue, and are none when there is nothing to derive from", async () => {
  const { ui } = await mount();
  assert.deepEqual(fromRealm(ui.parkedAllowed(fromRealm(INBOX))), ALLOWED);
  assert.deepEqual(fromRealm(ui.parkedAllowed({ divisions: { worklist: { ready: [edge("a", "DIVERGED")], blocked: [] } } })), []);
});

/* -- plain-user pass 2026-10-16 ---------------------------------------------
 *
 * The page spoke in the code's words ("declared / expanded", "crosses the line",
 * `wontfix` with no gloss), printed raw markdown, ran one cell into another, drew
 * bars with no days, and answered a hover with the browser's native `title`. The
 * owner's standard, set on the desktop widget first: every item is actionable,
 * every shape shows a FORMATTED tooltip built from values already on the page,
 * and the copy is plain. Copy below is the owner's approved table, typed here by
 * hand on purpose -- a test that read the strings back out of the client would
 * pass whatever the client said.
 */

const hover = (node, x = 40, y = 50) => node.dispatchEvent({ type: "mouseenter", clientX: x, clientY: y });
const unhover = (node) => node.dispatchEvent({ type: "mouseleave" });
const tipBox = (app) => byClass(app, "tip")[0] || null;

const APPROVED_MEANING = {
  "propagated": "Downstream updated to match",
  "no-change-needed": "Checked: the downstream is still right",
  "source-corrected": "Source was wrong and is now fixed",
  "both-reconciled": "Both changed and now agree",
  "decoupled": "Not related: remove the link",
  "deferred": "Later: park it with a reason",
  "wontfix": "Accepted: it stays different (reason needed)",
  "baselined": "First check: accept today as the start (reason needed)",
};

test("every verdict button shows its one-line meaning beneath it (approved copy)", async () => {
  const m = await mount({ hash: "#/judge?state=DRIFTED" });
  const opts = byClass(m.app, "vopt");
  assert.equal(opts.length, ALLOWED.length, "one option per allowed verdict; a floor so a silent scan cannot pass");
  for (const o of opts) {
    // The name is the longest approved key the button's text starts with (a key cap such as `n` follows it).
    const label = textOf(byTag(o, "button")[0]).trim();
    const name = Object.keys(APPROVED_MEANING).filter((k) => label.startsWith(k)).sort((a, b) => b.length - a.length)[0];
    assert.ok(name, `no approved sentence for the button ${JSON.stringify(label)}`);
    assert.equal(textOf(byClass(o, "vmean")[0]), APPROVED_MEANING[name], `${name}: the sentence under its button`);
  }
  // both-reconciled is only offered on a both-sides-moved edge, so look there too.
  const d = await mount({ hash: "#/judge?chip=both" });
  assert.equal(textOf(byClass(d.app, "vmean")[0]), APPROVED_MEANING["both-reconciled"]);
});

test("the header says links and file pairs, and a row says workspaces and times (approved copy)", async () => {
  const inbox = inboxOf({ ready: [
    edge("x", "DRIFTED", { boundary: "crosses the line", judgedCount: 1, noiseRatio: 0.8 }),
    edge("y", "DRIFTED", { boundary: "crosses the line", judgedCount: 5, noiseRatio: 0.8, node_id: "propagate:other.mjs" }),
  ], blocked: [], parked: [] });
  const m = await mount({ hash: "#/judge", inbox });
  assert.equal(textOf(byClass(m.app, "sum")[0]), "500 links between files · 1010 file pairs checked");
  const metas = byClass(m.app, "item").map((r) => textOf(byClass(r, "meta")[0]));
  assert.ok(metas.includes("crosses workspaces · judged 1 time · usually nothing to change"), `singular: ${JSON.stringify(metas)}`);
  assert.ok(metas.includes("crosses workspaces · judged 5 times · usually nothing to change"), `plural: ${JSON.stringify(metas)}`);
  assert.doesNotMatch(textOf(m.app), /declared|expanded|crosses the line|mostly no-op|judged \dx/);
});

test("Registers renders markdown as elements: bold is bold, no literal asterisks, and HTML stays text", async () => {
  const reg = { error: null, issues: [], handovers: [],
    todos: [
      { kind: "todo", short: "state/workspace/TODOS.md", line: 488, priority: 0, text: "**TM-032 — Re-run /plan-eng-review** (P0, blocks impl) with `utm_source=x` and a stray ** marker" },
      { kind: "todo", short: "k/TODOS.md", line: 3, priority: 1, text: "<img src=x onerror=alert(1)> **P1-1** later" },
      { kind: "todo", short: "k/TODOS.md", line: 4, priority: null, id: "N1", text: "no priority here" },
    ] };
  const m = await mount({ hash: "#/registers", routes: { "/api/registers": reg } });
  const d = detail(m.app);
  assert.doesNotMatch(textOf(d), /\*\*/, "a literal ** reached the page");
  const bold = byTag(d, "b").map(textOf);
  assert.ok(bold.includes("TM-032 — Re-run /plan-eng-review"), `bold segments: ${JSON.stringify(bold)}`);
  assert.ok(byClass(d, "mono").some((n) => textOf(n) === "utm_source=x"), "a code span renders as code");
  assert.equal(byTag(m.app, "img").length, 0, "register text is never injected as HTML");
  assert.match(textOf(d), /<img src=x onerror=alert\(1\)>/, "the hostile text is shown as text");
  const badges = dtRows(d).map((r) => textOf(byClass(r, "badge")[0]));
  assert.deepEqual(badges, ["P0", "P1", "N1"], "P0 is a priority, not a dot");
  assert.match(textOf(byTag(d, "th")[0]), /priority/, "the column is named");
});

test("Health puts 'no action mapped' in its own block, apart from the detail text", async () => {
  const m = await mount({ hash: "#/health", routes: { "/api/health": HEALTH } });
  const none = byClass(m.app, "none-mapped");
  assert.equal(none.length, 1, "the one unmapped fail row");
  assert.equal(none[0].localName, "div", "a span here runs on from the detail: '...path(s))no action mapped'");
  assert.equal(textOf(none[0]), "no action mapped");
  const detailNode = byClass(none[0].parentNode, "meta").find((n) => n !== none[0]);
  assert.ok(detailNode && /1 empty/.test(textOf(detailNode)), "the detail is a sibling element, not text in the same node");
});

test("Activity has a day axis on both Plot charts, thinned so 30 days do not become 30 labels", async () => {
  const m = await mount({ hash: "#/judge" });
  const log = withPlot(m);
  m.setHash("#/activity"); await m.settle();
  const runs = log.all.find((l) => l.o.marks.some((mk) => mk.o && mk.o.x === "day" && mk.o.fill === "tone" && mk.o.y === "count"));
  assert.ok(runs, "the commands-per-day chart went to Plot");
  assert.deepEqual(fromRealm([...runs.o.x.domain].map((d) => runs.o.x.tickFormat(d))), ["13 Oct", "14 Oct", "15 Oct"], "every day of a short window is labelled");
  const notes = byClass(m.app, "cov").map(textOf).join("|");
  assert.match(notes, /most in a day: 5/, "the scale is stated outside the plot");
  const { ui } = m;
  const t30 = fromRealm(ui.axisTicks(30));
  assert.ok(t30[0] === 0 && t30[t30.length - 1] === 29, "first and last day always labelled");
  assert.ok(t30.length <= 7, `30 days must not carry 30 labels: ${t30.length}`);
  assert.deepEqual(fromRealm(ui.axisTicks(0)), []);
  assert.deepEqual(fromRealm(ui.axisTicks(1)), [0]);
  const days = Array.from({ length: 30 }, (_, i) => "2026-09-" + String(i + 1).padStart(2, "0"));
  assert.ok(ui.axisLabels(days).size <= 7 && ui.axisLabels(days).has("2026-09-01") && ui.axisLabels(days).has("2026-09-30"), "the Plot axis uses the same thinning");
});

test("tipText: every kind answers in words, and zero, empty and garbage never print NaN or undefined", async () => {
  const { ui } = await mount();
  const T = (k, v) => fromRealm(ui.tipText(k, v));
  // (the per-day "verdicts" kind went with the hand-built columns; the Plot bars use "vbar", below)
  assert.deepEqual(T("runs", { day: "2026-10-14", count: 0 }), { title: "Wed 14 Oct", lines: ["no commands run", "hover only — no list behind a day's count"] });
  assert.deepEqual(T("command", { command: "status", count: 6, total: 9 }),
    { title: "status", lines: ["6 runs", "67% of 9 interactive runs", "click to copy: propagate status"] });
  const noTotal = T("command", { command: "x", count: 0, total: 0 });
  assert.deepEqual(noTotal.lines, ["0 runs", "click to copy: propagate x"], "a zero total drops the share rather than dividing");
  assert.deepEqual(T("bucket", { label: "baselineable now", value: 3, total: 10 }).lines, ["3 edges", "30% of 10 never verified"]);
  assert.deepEqual(T("root", { source: "a", downstream: "b", freesNow: 2, upstreamOf: 5, inQueue: true }).lines,
    ["frees 2 now", "upstream of 5", "click to judge this root"]);
  assert.match(T("root", { source: "a", downstream: "b", freesNow: 0, upstreamOf: 0, inQueue: false }).lines[2], /copy the command/);
  assert.deepEqual(T("health", { label: "L", section: "State", tag: "fail", action: null }).lines, ["State", "failing check", "no action mapped"]);
  assert.deepEqual(T("health", { label: "L", section: "State", tag: "warn", action: null }).lines, ["State", "warning, not failing", "doctor maps no next step for a warning"], "a warn row is never silent");
  assert.match(T("health", { label: "L", section: "State", tag: "fail", action: { kind: "command", target: "do it" } }).lines[2], /next step: do it/);
  assert.equal(T("register", { id: "TM-1", short: "f.md", line: 3, priority: 0 }).lines[0], "priority P0 · f.md · line 3");
  assert.equal(T("register", { id: "TM-1", file: "/u/GitHub/f.md", short: "f.md", line: 3 }).lines[1], "click to copy /u/GitHub/f.md:3");
  assert.equal(T("register", { id: "TM-1" }).lines[1], "no file recorded for this item", "a row with no locator says so");
  // garbage in: still no NaN / undefined, and an unknown kind or a missing value is null, never a guess.
  for (const [k, v] of [["vbar", { day: "nonsense", n: NaN, total: undefined }], ["runs", { count: NaN }], ["command", { command: "c", count: NaN, total: NaN }]]) {
    assert.doesNotMatch(JSON.stringify(T(k, v)), /NaN|undefined|null/, `${k}: ${JSON.stringify(T(k, v))}`);
  }
  assert.equal(ui.tipText("vbar", null), null);
  assert.equal(ui.tipText("no-such-kind", { a: 1 }), null);
});

test("tipPlace keeps the tooltip inside the viewport by flipping, and never off the top-left", async () => {
  const { ui } = await mount();
  const roomy = fromRealm(ui.tipPlace(100, 100, 1200, 800));
  assert.ok(roomy.left > 100 && roomy.top > 100, "below and right of the pointer when there is room");
  const edge = fromRealm(ui.tipPlace(1190, 790, 1200, 800));
  assert.ok(edge.left < 1190 && edge.top < 790, `flipped left and up at the bottom-right corner: ${JSON.stringify(edge)}`);
  assert.ok(edge.left + 264 <= 1200 && edge.top + 112 <= 800, "and fully inside");
  const tiny = fromRealm(ui.tipPlace(2, 2, 100, 60));
  assert.ok(tiny.left >= 8 && tiny.top >= 8, "clamped, never negative");
  const bad = fromRealm(ui.tipPlace(NaN, undefined, 0, NaN));
  assert.ok(Number.isFinite(bad.left) && Number.isFinite(bad.top), "a pointer with no coordinates still places the box");
});

test("hovering a verdict bar shows a formatted tooltip, and leaving hides it", async () => {
  const m = await mount({ hash: "#/judge" });
  const log = withPlot(m);
  m.setHash("#/activity"); await m.settle();
  const verdicts = log.all.find((l) => l.o.marks.some((mk) => mk.o && mk.o.fill === "kind"));
  const shapes = verdicts.n.querySelectorAll();
  assert.equal(tipBox(m.app), null, "no tooltip until something is hovered");
  hover(shapes[0]);   // 13 Oct, "changed something"
  await m.settle();
  assert.match(textOf(tipBox(m.app)), /Tue 13 Oct · changed something.*1 verdict.*of 4 verdicts that day.*click to open Judge/);
  assert.equal(tipBox(m.app).getAttribute("role"), "tooltip");
  unhover(shapes[0]);
  await m.settle();
  assert.equal(tipBox(m.app), null, "gone on leave");
  hover(shapes[2]);   // 14 Oct: the empty day still has a datum
  await m.settle();
  assert.match(textOf(tipBox(m.app)), /Wed 14 Oct.*none recorded/);
});

test("a command bar shows its tooltip, and clicking it copies `propagate <command>`", async () => {
  // Real timers: the 1.5s "copied" flash would be sped up to 15ms and gone before it could be read.
  const m = await mount({ hash: "#/judge", speedUp: false });
  const wrote = clipboard(m);
  const log = withPlot(m);
  m.setHash("#/activity"); await m.settle();
  const usage = log.all.find((l) => l.o.marks.some((mk) => mk.o && mk.o.y === "command"));
  const shapes = usage.n.querySelectorAll();
  assert.equal(shapes.length, 2, "one clickable bar per top command");
  hover(shapes[0]);
  await m.settle();
  assert.match(textOf(tipBox(m.app)), /status.*6 runs.*67% of 9 interactive runs.*click to copy: propagate status/);
  click(shapes[0]);
  for (let i = 0; i < 40 && !/copied/.test(textOf(detail(m.app))); i++) await sleep(10);
  assert.deepEqual(wrote, ["propagate status"]);
  assert.match(textOf(detail(m.app)), /copied: propagate status/, "the page says so");
});

test("clicking a verdict bar on Activity opens Judge; the same bar on the Overview opens Activity", async () => {
  const m = await mount({ hash: "#/judge" });
  const log = withPlot(m);
  m.setHash("#/activity"); await m.settle();
  click(log.all.find((l) => l.o.marks.some((mk) => mk.o && mk.o.fill === "kind")).n.querySelectorAll()[0]);
  await m.settle();
  assert.equal(m.ctx.location.hash, "#/judge", "Activity is already the place to read verdicts, so its bars go to where they are made");
  const o = await mountOv();
  const olog = withPlot(o);
  o.setHash("#/overview"); await o.settle();
  click(olog.all.find((l) => l.o.marks.some((mk) => mk.o && mk.o.fill === "kind")).n.querySelectorAll()[0]);
  await o.settle();
  assert.equal(o.ctx.location.hash, "#/activity");
  // and the pure rule, so the two homes cannot drift apart
  assert.equal(m.ui.routeForBar("verdicts", { day: "2026-10-15" }), "activity");
  assert.equal(m.ui.routeForBar("verdicts", { day: "2026-10-15" }, "activity"), "judge");
});

test("Unblock, Health and Registers rows each carry a tooltip built from what the row shows", async () => {
  const u = await mount({ hash: "#/unblock" });
  const root = dtRows(u.app)[0];
  hover(root);
  await u.settle();
  assert.match(textOf(tipBox(u.app)), /frees \d+ now/);
  const h = await mount({ hash: "#/health", routes: { "/api/health": HEALTH } });
  const hr = dtRows(h.app).find((r) => /workspaces conform/.test(textOf(r)));
  hover(hr);
  await h.settle();
  assert.match(textOf(tipBox(h.app)), /workspaces conform.*State.*failing check.*no action mapped/);
  const reg = { error: null, issues: [], handovers: [], todos: [{ kind: "todo", short: "k/TODOS.md", line: 3, text: "do it", priority: 2, id: "T-9" }] };
  const r = await mount({ hash: "#/registers", routes: { "/api/registers": reg } });
  hover(dtRows(r.app)[0]);
  await r.settle();
  assert.match(textOf(tipBox(r.app)), /T-9.*priority P2 · k\/TODOS\.md · line 3.*click to copy k\/TODOS\.md:3/);
});

test("NO native title= attribute is left in any rendered view: every hint is the one tooltip", async () => {
  const views = { "#/judge": {}, "#/unblock": {}, "#/health": { "/api/health": HEALTH }, "#/activity": {},
    "#/registers": { "/api/registers": { error: null, issues: [], todos: [{ kind: "todo", short: "a", text: "t", priority: 1 }], handovers: [] } },
    "#/reminders": { "/api/conflicts": { ok: true, rows: [], summary: { total: 0 }, list: "L" } },
    "#/graph": { "/graph": rawText(200, "<html>g</html>") } };
  let seen = 0;
  for (const [hash, routes] of Object.entries(views)) {
    const m = await mount({ hash, routes });
    const nodes = findAll(m.app, (n) => n.nodeType === 1);
    seen += nodes.length;
    assert.ok(nodes.length > 20, `${hash} rendered only ${nodes.length} nodes; the scan has gone blind`);
    const titled = nodes.filter((n) => n.hasAttribute("title")).map((n) => n.localName + "." + n.getAttribute("class"));
    assert.deepEqual(titled, [], `${hash} still carries a native title=`);
  }
  assert.ok(seen > 200);
  // and the hints that used to be titles now live on the tooltip: the refresh button, in every view.
  const m = await mount({ hash: "#/judge" });
  hover(btnText(m.app, /^refresh$/));
  await m.settle();
  assert.match(textOf(tipBox(m.app)), /Refresh.*re-read this view and the counts/);
});

test("a Reminders timeout is a plain sentence with a Retry that re-reads; other failures keep the server's words", async () => {
  const m = await mount({ hash: "#/reminders", routes: { "/api/conflicts": { ok: false, reason: "osascript timed out after 3000ms reading list Inbox" } } });
  const t = textOf(detail(m.app));
  assert.match(t, /Reminders did not answer in 3s\. Open Reminders once and allow access, then retry\./);
  assert.doesNotMatch(textOf(byClass(m.app, "banner")[0]), /osascript/, "the tool's own words are not the headline");
  const before = m.fetches.filter((f) => f.path === "/api/conflicts").length;
  click(btnText(byClass(m.app, "banner")[0], /^retry$/));
  await m.settle();
  assert.equal(m.fetches.filter((f) => f.path === "/api/conflicts").length, before + 1, "Retry re-reads the list");
  assert.equal(m.ui.remindersTimeoutText("EACCES: not allowed"), null);
});

/* ══ The Overview dashboard (2026-10-16, plan ticklish-gathering-brook, Part 5, Lane E) ══════
   Built from the approved prototype. Charts are Observable Plot, vendored; the headless suite
   has NO Plot, which is exactly the "library did not load" path, so most of this proves the
   KPIs and the table stand on their own. The chart contract (what is drawn, which datum a
   shape belongs to, where a click goes) is tested on pure functions and on a recording Plot. */

const AGO = (days) => new Date(Date.now() - days * 864e5).toISOString();
const SRC_A = "/u/Documents/GitHub/WS1/alpha.md";
const SRC_B = "/u/Documents/GitHub/WS1/beta.md";
const SRC_C = "/u/Documents/GitHub/WS2/gamma.md";
const ovEdge = (id, state, source, boundary, over = {}) => edge(id, state, {
  source, sourceShort: source.split("/Documents/GitHub/")[1], boundary, ...over,
});
// x1 40d, x2 2d, x3 never (DIVERGED), x4 today, x5 10d (BLOCKED on x3), x6 3d.
const OV_READY = [
  ovEdge("x1", "DRIFTED", SRC_A, "WS1", { orderIndex: 0, last: { ts: AGO(40) } }),
  ovEdge("x2", "REVERSED", SRC_A, "WS1", { orderIndex: 1, last: { ts: AGO(2) } }),
  ovEdge("x3", "DIVERGED", SRC_A, "WS1", { orderIndex: 2 }),
  ovEdge("x4", "DRIFTED", SRC_B, "crosses the line", { orderIndex: 3, last: { ts: AGO(0) } }),
  ovEdge("x6", "UNMATCHED", SRC_C, "WS2", { orderIndex: 5, last: { ts: AGO(3) } }),
];
const OV_BLOCKED = [
  ovEdge("x5", "DRIFTED", SRC_B, "crosses the line", { orderIndex: 4, blocked: true, last: { ts: AGO(10) },
    blockedBy: [{ edge_id: "x3", from: SRC_A, to: "/u/Documents/GitHub/propagate/commands/x3.mjs", state: "DIVERGED" }] }),
];
const OV_INBOX = inboxOf({ ready: OV_READY, blocked: OV_BLOCKED, parked: [] });
const TODAY = new Date().toLocaleDateString("en-CA");   // YYYY-MM-DD, local: derived without the client's own localDay
const OV_SURFACE = { ...SURFACE, velocity: { status: "ok", reason: null, windowDays: 2, events: 5, noChangeEvents: 3,
  days: [{ day: "2020-01-01", total: 1, noChange: 1, changed: 0 }, { day: TODAY, total: 4, noChange: 3, changed: 1 }] } };
const mountOv = (opts = {}) => mount({ hash: "#/overview", inbox: OV_INBOX, ...opts,
  routes: { "/api/surface": OV_SURFACE, "/api/health": HEALTH, ...(opts.routes || {}) } });
const kpiCards = (app) => byClass(app, "kpi").filter((k) => /\bpick\b/.test(k.getAttribute("class")));
const srcRows = (app) => findAll(app, (n) => n.nodeType === 1 && n.localName === "tr" && /\bpick\b/.test(n.getAttribute("class") || ""));
const srcNames = (app) => srcRows(app).map((r) => textOf(byClass(r, "nm")[0]));
const th = (app, re) => byTag(app, "th").find((t) => re.test(textOf(t)));

test("an empty hash opens the Overview, which is the rail's first item; an unknown hash still opens Judge", async () => {
  const m = await mountOv({ hash: "" });
  const on = byClass(m.app, "div").filter((b) => b.getAttribute("aria-current") === "page");
  assert.equal(on.length, 1);
  assert.match(textOf(on[0]), /OVERVIEW/);
  assert.match(textOf(byClass(m.app, "div")[0]), /OVERVIEW/, "Overview must be the FIRST rail item");
  assert.equal(m.ui.parseHash("").view, "overview");
  assert.equal(m.ui.parseHash("#").view, "overview");
  assert.equal(m.ui.parseHash("#/overview").view, "overview");
  assert.equal(m.ui.parseHash("#/nonsense").view, "judge", "an unknown name is still Judge, never a blank page");
  // The new filter params: an age band is one of the five keys or nothing; ws/source are taken as written.
  const p = (h) => fromRealm(m.ui.parseHash(h));
  assert.equal(p("#/judge?age=gt4w").age, "gt4w");
  assert.equal(p("#/judge?age=forever").age, null, "a band it does not know must parse to null, not pass through");
  assert.equal(p("#/judge?age=%3E4w").age, null, "the raw label is not a key: keys are url-safe on purpose");
  assert.deepEqual([p("#/judge?ws=WS%201&source=%2Fa%2Fb.md").ws, p("#/judge?ws=WS%201&source=%2Fa%2Fb.md").source], ["WS 1", "/a/b.md"]);
  assert.equal(p("#/judge?ws=%E0%A4%A").ws, null, "a malformed escape is no filter, never a throw");
});

test("the Overview renders its five KPIs and the sources table from the fixture, with NO chart library", async () => {
  const m = await mountOv();
  assert.equal(m.ui.plotUnavailable(), "the chart library did not load", "this suite must be running without Plot, or the test proves nothing");
  const k = kpiCards(m.app).map(textOf);
  assert.equal(k.length, 5, "five KPI cards");
  assert.equal(k[0], "To judge" + OV_INBOX.worklist.toJudge + "of 6 edges in the queue, from 3 source files");
  assert.match(k[1], new RegExp("Blocked\\s*" + OV_INBOX.leverage.blocked + "waiting on an upstream edge"));
  assert.match(k[2], /Oldest wait\s*40 d/);
  assert.match(k[3], /Judged today\s*4/);
  assert.match(k[4], /Health\s*2 fail/);
  // The charts degrade to a sentence that NAMES the cause; none is blank, none throws.
  const lines = byClass(m.app, "reason").map(textOf).filter((t) => /chart unavailable/.test(t));
  assert.equal(lines.length, 3, "all three charts say so");
  for (const t of lines) assert.match(t, /chart unavailable — the chart library did not load/);
  // The table stands on its own.
  assert.deepEqual(srcNames(m.app), ["alpha.md", "beta.md", "gamma.md"], "ordered by edges, then oldest");
  const tds = (r) => byTag(r, "td").map(textOf);
  const [a, b, c] = srcRows(m.app).map(tds);
  assert.equal(a[1], "3"); assert.equal(a[3], "0", "a source with nothing blocked shows 0, NOT a dot");
  assert.equal(b[3], "1"); assert.equal(c[3], "0");
  assert.equal(a[4], "40 d"); assert.equal(b[4], "10 d");
  assert.match(textOf(byClass(m.app, "go")[0]), /all 3 sources/);
  assert.deepEqual(m.unstubbed, []);
});

test("each KPI card routes where Part 5 says, and Oldest wait opens the age band the oldest edge is in", async () => {
  const want = ["#/judge", "#/unblock", "#/judge?age=gt4w", "#/activity", "#/health"];
  const m = await mountOv();
  for (let i = 0; i < want.length; i++) {
    m.setHash("#/overview"); await m.settle();
    click(kpiCards(m.app)[i]); await m.settle();
    assert.equal(m.ctx.location.hash, want[i], `KPI ${i} went to the wrong place`);
  }
  // Pure: the same mapping without a render, including the case the card is NOT flagged.
  assert.equal(m.ui.routeForKpi("oldest", { oldest: 5 }), "judge?age=1to7d", "an unflagged card must not open an empty > 4 weeks list");
  assert.equal(m.ui.routeForKpi("oldest", { oldest: null }), "judge");
  assert.equal(m.ui.routeForKpi("nope", {}), null);
});

test("a KPI whose figure is unknown says so: Judged today and Health are never a silent zero", async () => {
  const bad = { ...SURFACE, velocity: { status: "unavailable", reason: "no event store", days: [] } };
  const m = await mountOv({ routes: { "/api/surface": bad, "/api/health": respond(500, { error: "doctor missing" }) } });
  const k = kpiCards(m.app).map(textOf);
  assert.match(k[3], /Judged today\s*could not readno event store/);
  assert.match(k[4], /Health\s*could not readdoctor missing/);
});

test("the sources table sorts by a clicked header, flips on a second click, and says which way (aria-sort)", async () => {
  const m = await mountOv();
  assert.equal(th(m.app, /^edges/).getAttribute("aria-sort"), "descending");
  click(th(m.app, /^blocked/)); await m.settle();
  assert.deepEqual(srcNames(m.app), ["beta.md", "alpha.md", "gamma.md"], "blocked desc: beta (1) first, ties by source path");
  assert.equal(th(m.app, /^blocked/).getAttribute("aria-sort"), "descending");
  assert.equal(th(m.app, /^edges/).getAttribute("aria-sort"), "none");
  click(th(m.app, /^blocked/)); await m.settle();
  assert.deepEqual(srcNames(m.app), ["alpha.md", "gamma.md", "beta.md"], "second click reverses");
  click(th(m.app, /^source/)); await m.settle();
  assert.deepEqual(srcNames(m.app), ["alpha.md", "beta.md", "gamma.md"], "source sorts A to Z first");
  click(th(m.app, /^oldest/)); await m.settle();
  assert.deepEqual(srcNames(m.app), ["alpha.md", "beta.md", "gamma.md"], "oldest desc: 40, 10, 3");
  // 'what moved' is a bar, not a sortable column.
  assert.equal(th(m.app, /what moved/).getAttribute("aria-sort"), null);
});

test("a source row opens Judge on exactly that source; 'all N sources' opens Judge unfiltered", async () => {
  const m = await mountOv();
  click(srcRows(m.app)[1]); await m.settle();
  assert.equal(m.ctx.location.hash, "#/judge?source=" + encodeURIComponent(SRC_B));
  // It landed: the Judge list shows only that source's judgeable edge, under a clearable control.
  assert.deepEqual(itemTitles(m.app).map((t) => t.replace(/ new$/, "")), ["WS1/beta.md → propagate/commands/x4.mjs"], "only beta.md's judgeable edge (x5 is blocked)");
  assert.match(textOf(byClass(m.app, "filt")[0]), /only beta\.md/);
  m.setHash("#/overview"); await m.settle();
  click(byClass(m.app, "go")[0]); await m.settle();
  assert.equal(m.ctx.location.hash, "#/judge");
  assert.equal(byClass(m.app, "filt").length, 0, "no filter rides along");
});

/* -- Judge filters ---------------------------------------------------------- */

const itemTitles = (app) => byClass(app, "item").map((r) => textOf(byClass(r, "ttl")[0]));

test("?ws= narrows Judge to one workspace, shows a clearable 'only ...' control, and clearing restores the list", async () => {
  const m = await mount({ hash: "#/judge?ws=WS1", inbox: OV_INBOX });
  assert.deepEqual(itemTitles(m.app).map((t) => t.replace(/ new$/, "")).sort(), ["WS1/alpha.md → propagate/commands/x1.mjs", "WS1/alpha.md → propagate/commands/x2.mjs"]);
  const filt = byClass(m.app, "filt");
  assert.equal(filt.length, 1);
  assert.match(textOf(filt[0]), /only WS1\s*2/);
  assert.match(filt[0].getAttribute("aria-label"), /clear the workspace filter/);
  click(filt[0]); await m.settle();
  assert.equal(byClass(m.app, "filt").length, 0);
  assert.equal(byClass(m.app, "item").length, OV_INBOX.worklist.toJudge, "cleared: the whole To-judge queue is back");
});

test("?ws=crosses workspaces matches the label the chart printed, not the server's 'crosses the line'", async () => {
  const m = await mount({ hash: "#/judge?ws=" + encodeURIComponent("crosses workspaces"), inbox: OV_INBOX });
  assert.equal(byClass(m.app, "item").length, 1, "x4 only: x5 is the same boundary but BLOCKED, so Judge never lists it");
  assert.match(textOf(byClass(m.app, "filt")[0]), /only crosses workspaces/);
});

test("?age= keeps only that waiting band, and an unknown band is ignored rather than emptying the list", async () => {
  const m = await mount({ hash: "#/judge?age=gt4w", inbox: OV_INBOX });
  assert.equal(byClass(m.app, "item").length, 1, "only x1 (40 days) waited more than four weeks");
  assert.match(textOf(byClass(m.app, "filt")[0]), /only waited > 4 weeks/);
  const lt = await mount({ hash: "#/judge?age=lt1d", inbox: OV_INBOX });
  assert.equal(byClass(lt.app, "item").length, 1, "only x4 was judged today");
  const bad = await mount({ hash: "#/judge?age=forever", inbox: OV_INBOX });
  assert.equal(byClass(bad.app, "filt").length, 0, "a bucket key it does not know must not filter");
  assert.equal(byClass(bad.app, "item").length, OV_INBOX.worklist.toJudge);
});

test("?source= is an EXACT path, offers 'select all N', and ticking them gives the bulk panel the whole set", async () => {
  const m = await mount({ hash: "#/judge?source=" + encodeURIComponent(SRC_A), inbox: OV_INBOX });
  assert.equal(byClass(m.app, "item").length, 2, "x1 and x2; x3 is DIVERGED and lives under its own chip");
  assert.match(textOf(byClass(m.app, "filt")[0]), /only alpha\.md\s*2/);
  const all = btnText(m.app, /select all 2/);
  assert.ok(all, "no 'select all N' offered with a source chosen");
  click(all); await m.settle();
  assert.equal(ticks(m.app).filter((t) => t.checked).length, 2);
  assert.match(textOf(detail(m.app)), /2 edges ticked/);
  assert.equal(btnText(m.app, /select all/), undefined, "once everything is ticked the offer goes away");
  // A different file with the same basename elsewhere must NOT match: the source is the full path.
  const other = await mount({ hash: "#/judge?source=" + encodeURIComponent("/elsewhere/alpha.md"), inbox: OV_INBOX });
  assert.equal(byClass(other.app, "item").length, 0);
  assert.match(textOf(byClass(other.app, "empty")[0]), /Nothing matches this filter/, "a filtered-empty list must not read as an empty queue");
});

test("ws, age, source and state COMBINE, each with its own control, and the chip counts follow the filters", async () => {
  const m = await mount({ hash: "#/judge?state=REVERSED&ws=WS1&source=" + encodeURIComponent(SRC_A) + "&age=1to7d", inbox: OV_INBOX });
  assert.equal(byClass(m.app, "item").length, 1, "x2 is the only REVERSED, WS1, alpha.md, 1-7 day edge");
  assert.equal(byClass(m.app, "filt").length, 4, "state + ws + age + source");
  const toJudgeChip = byClass(m.app, "chip").find((c) => /To judge/.test(textOf(c)));
  assert.match(textOf(toJudgeChip), /To judge\s*1/, "the chip count must agree with the list under the filters");
  // Clearing one leaves the other three.
  click(byClass(m.app, "filt").find((f) => /only alpha/.test(textOf(f)))); await m.settle();
  assert.equal(byClass(m.app, "filt").length, 3);
});

test("the filters also narrow the Both-sides-moved chip (a DIVERGED bar opens it with ws=)", async () => {
  const m = await mount({ hash: "#/judge?ws=WS1&chip=both", inbox: OV_INBOX });
  assert.equal(byClass(m.app, "item").length, 1, "x3");
  const none = await mount({ hash: "#/judge?ws=WS2&chip=both", inbox: OV_INBOX });
  assert.equal(byClass(none.app, "item").length, 0);
});

/* -- chart data, routing and wiring: pure, no browser ------------------------ */

test("routeForBar: every chart datum maps to ONE destination, and a datum it cannot route maps to null", async () => {
  const { ui } = await mountOv();
  const r = ui.routeForBar;
  assert.equal(r("queue", { ws: "WS1", state: "DRIFTED" }), "judge?ws=WS1&state=DRIFTED");
  assert.equal(r("queue", { ws: "crosses workspaces", state: "UNMATCHED" }), "judge?ws=crosses%20workspaces&state=UNMATCHED");
  assert.equal(r("queue", { ws: "WS1", state: "DIVERGED" }), "judge?ws=WS1&chip=both", "a diverged edge is never under To judge, so state= would open an empty list");
  assert.equal(r("queue", { ws: "a&b=c", state: "REVERSED" }), "judge?ws=a%26b%3Dc&state=REVERSED", "an ampersand in a name must not split the query");
  assert.equal(r("queue", { ws: "WS1", state: "SOMETHING_ELSE" }), "judge?ws=WS1");
  assert.equal(r("queue", { state: "DRIFTED" }), null, "no workspace, no destination");
  assert.equal(r("wait", { bucket: "gt4w" }), "judge?age=gt4w");
  assert.equal(r("wait", { bucket: "yesterday" }), null);
  assert.equal(r("verdicts", { day: "2026-10-15" }), "activity");
  assert.equal(r("pie", { ws: "WS1" }), null);
  assert.equal(r("queue", null), null);
  // Every route it emits is one parseHash reads back to the same filters (the round trip).
  const back = fromRealm(ui.parseHash("#/" + r("queue", { ws: "a&b=c", state: "REVERSED" })));
  assert.equal(back.view, "judge"); assert.equal(back.ws, "a&b=c"); assert.equal(back.state, "REVERSED");
});

test("queueBars / waitBars / verdictBars aggregate by key and keep the total honest", async () => {
  const { ui } = await mountOv();
  const model = fromRealm(ui.overviewModel(fromRealm(OV_INBOX), Date.now()));
  assert.equal(model.edges, 6);
  const q = fromRealm(ui.queueBars(model.rows));
  assert.deepEqual(q.order, ["WS1", "crosses workspaces", "WS2"], "workspaces by edges waiting, then name");
  assert.equal(q.bars.reduce((n, b) => n + b.n, 0), 6, "no edge lost or doubled by the aggregation");
  assert.equal(new Set(q.bars.map((b) => b.key)).size, q.bars.length, "keys are unique: they are how a drawn shape finds its datum");
  const w = fromRealm(ui.waitBars(model.rows));
  assert.equal(w.reduce((n, b) => n + b.n, 0), 6);
  assert.deepEqual(w.map((b) => b.bucket).filter((v, i, a) => a.indexOf(v) === i), ["lt1d", "1to7d", "1to4w", "gt4w", "never"], "buckets in age order");
  assert.equal(w.find((b) => b.bucket === "never").n, 1, "x3 was never judged and is its own band, not '< 1 day'");
  const v = fromRealm(ui.verdictBars(fromRealm(OV_SURFACE.velocity)));
  assert.equal(v.length, 4, "two kinds per day");
  assert.equal(v.filter((b) => b.day === TODAY).map((b) => b.n).join(), "1,3");
  assert.deepEqual(fromRealm(ui.verdictBars({ status: "unavailable", days: [{ day: "x", total: 1 }] })), [], "an unavailable series draws nothing, not a flat line");
});

test("the age bucket edges: 0 and 6 and 27 and 28 days, and null is its own band", async () => {
  const { ui } = await mountOv();
  assert.deepEqual([0, 0.9, 1, 6, 7, 27, 28, 400, null, undefined, NaN].map(ui.ageKey),
    ["lt1d", "lt1d", "1to7d", "1to7d", "1to4w", "1to4w", "gt4w", "gt4w", "never", "never", "never"]);
  const now = Date.parse("2026-10-16T12:00:00Z");
  assert.equal(ui.ageDaysOf({ last: { ts: "2026-10-15T11:00:00Z" } }, now), 1);
  assert.equal(ui.ageDaysOf({ ageDays: 20 }, now), 20, "a parked row's own age is used, not 'never judged'");
  assert.equal(ui.ageDaysOf({ last: { ts: "garbage" } }, now), null);
  assert.equal(ui.ageDaysOf({ last: { ts: "2027-01-01T00:00:00Z" } }, now), 0, "a clock-skewed future timestamp is 0 days, never negative");
});

// A recording stand-in for Plot: it hands back what the mark options say, so the CONTRACT
// (which fields, which colours, what each shape is labelled with) is asserted without a browser.
function fakePlot(doc, log = {}) {
  const mark = (kind) => (data, o) => ({ kind, data, o });
  return {
    plot(opts) {
      log.opts = opts;
      const svg = doc.createElement("svg");
      const shapes = [];
      for (const mk of opts.marks) {
        if (!mk.data || !mk.o || typeof mk.o.ariaLabel !== "function") continue;
        for (const d of mk.data) { const r = doc.createElement("rect"); r.setAttribute("aria-label", mk.o.ariaLabel(d)); svg.appendChild(r); shapes.push(r); }
      }
      svg.querySelectorAll = () => shapes;
      log.shapes = shapes;
      return svg;
    },
    barX: mark("barX"), barY: mark("barY"), ruleX: mark("ruleX"), ruleY: mark("ruleY"),
  };
}

test("buildPlot: every colour is a TOKEN resolved at render, every shape is labelled with its datum key", async () => {
  const m = await mountOv();
  const asked = [];
  const tok = (n) => { asked.push(n); return "TOK(" + n + ")"; };
  const model = m.ui.overviewModel(OV_INBOX, Date.now());
  const log = {};
  const P = fakePlot(m.doc, log);
  m.ui.buildPlot(P, "queue", m.ui.queueBars(model.rows), tok, 470);
  assert.deepEqual([...log.opts.color.range], ["TOK(--edge-drift)", "TOK(--edge-reverse)", "TOK(--edge-diverge)", "TOK(--dim)"], "state colours come from the same tokens as the badges");
  assert.deepEqual([...log.opts.color.domain], ["DRIFTED", "REVERSED", "DIVERGED", "UNMATCHED"]);
  assert.equal(log.opts.style.color, "TOK(--fg)");
  assert.equal(log.shapes.length, m.ui.queueBars(model.rows).bars.length);
  const labels = fromRealm(log.shapes.map((s) => s.getAttribute("aria-label")));
  assert.deepEqual(labels, fromRealm(m.ui.queueBars(model.rows).bars.map((b) => b.key)), "a shape's label is its datum's key");
  m.ui.buildPlot(P, "verdicts", { bars: m.ui.verdictBars(OV_SURFACE.velocity) }, tok, 360);
  assert.deepEqual([...log.opts.color.range], ["TOK(--st-accent)", "TOK(--seg-quiet)"], "the quiet series is --seg-quiet, the token the dark-mode fix repaired");
  // No literal colour anywhere in the options handed to the library.
  assert.doesNotMatch(JSON.stringify(log.opts.color), /#[0-9a-f]{3,8}\b|rgb\(|oklch\(/i);
});

test("wireChart: a click on a drawn shape goes where routeForBar says; a shape it cannot match is left alone and counted", async () => {
  const m = await mountOv();
  const model = m.ui.overviewModel(OV_INBOX, Date.now());
  const q = m.ui.queueBars(model.rows);
  const log = {};
  const node = m.ui.buildPlot(fakePlot(m.doc, log), "queue", q, () => "c", 470);
  const stray = m.doc.createElement("rect"); stray.setAttribute("aria-label", "bar");   // Plot's own group label
  const all = [...log.shapes, stray];
  node.querySelectorAll = () => all;
  const went = [];
  const wired = m.ui.wireChart(node, "queue", q.bars, (to) => went.push(to));
  assert.equal(wired, q.bars.length, "every datum's shape wired, and Plot's own 'bar' group not");
  assert.equal(stray.listeners.size, 0, "an unmatched element gets no handler");
  const i = q.bars.findIndex((b) => b.state === "DIVERGED");
  click(log.shapes[i]);
  assert.deepEqual(went, [m.ui.routeForBar("queue", q.bars[i])]);
  assert.match(went[0], /chip=both/);
  // Hover reaches the page's one tooltip (a no-op here, no TipLayer mounted, but it must not throw).
  assert.doesNotThrow(() => log.shapes[0].dispatchEvent({ type: "mouseenter", clientX: 5, clientY: 5 }));
  assert.equal(m.ui.wireChart(null, "queue", q.bars, () => {}), 0, "no node: nothing wired, no throw");
});

test("tipText speaks for the new shapes in words, and never prints NaN or a bare zero", async () => {
  const { ui } = await mountOv();
  const t = (k, v) => fromRealm(ui.tipText(k, v));
  assert.deepEqual(t("qbar", { ws: "WS1", state: "DIVERGED", n: 1, wsTotal: 4 }), { title: "WS1 · both sides moved", lines: ["1 edge", "25% of the 4 in WS1", "click to judge these"] });
  assert.deepEqual(t("wbar", { bucket: "gt4w", state: "DRIFTED", n: 2 }), { title: "> 4 weeks · drifted", lines: ["2 edges", "click to open this age band in Judge"] });
  assert.deepEqual(t("vbar", { day: "2026-10-13", kind: "no change needed", n: 0, total: 0 }), { title: "Tue 13 Oct · no change needed", lines: ["none recorded", "click to open Activity"] });
  assert.match(JSON.stringify(t("source", { short: "WS1/a.md", edges: 3, blocked: 0, states: {}, oldest: -1 })), /never judged/);
  for (const v of [{}, { n: undefined, wsTotal: NaN }]) assert.doesNotMatch(JSON.stringify(t("qbar", v)), /NaN|undefined/);
});

/* -- with a Plot that exists ---------------------------------------------------- */

test("with Plot present the three charts draw, every shape is clickable, and the click navigates", async () => {
  const m = await mountOv();
  const log = [];
  m.ctx.Plot = fakePlot(m.doc, {});
  const real = m.ctx.Plot.plot;
  m.ctx.Plot.plot = (o) => { const n = real(o); log.push({ o, n }); return n; };
  m.setHash("#/overview"); await m.settle();
  assert.equal(log.length >= 3, true, "the three charts were handed to the library");
  assert.equal(byClass(m.app, "reason").filter((r) => /chart unavailable/.test(textOf(r))).length, 0);
  assert.equal(byClass(m.app, "plot").length, 3);
  // Click the first shape of the waiting-time histogram.
  const wait = log.find((l) => l.o.marks.some((mk) => mk.o && mk.o.x === "label"));
  const shape = wait.n.querySelectorAll()[0];
  click(shape); await m.settle();
  assert.match(m.ctx.location.hash, /^#\/judge\?age=(lt1d|1to7d|1to4w|gt4w|never)$/);
});

test("a Plot that THROWS never takes the view down: that chart says why, the KPIs and the table stay", async () => {
  const m = await mountOv();
  m.ctx.Plot = { plot() { throw new Error("boom: no svg"); }, barX() {}, barY() {}, ruleX() {}, ruleY() {} };
  m.setHash("#/overview"); await m.settle();
  const lines = byClass(m.app, "reason").map(textOf).filter((t) => /chart unavailable/.test(t));
  assert.equal(lines.length, 3);
  assert.ok(lines.every((t) => /boom: no svg/.test(t)), "the reason names the cause");
  assert.equal(kpiCards(m.app).length, 5);
  assert.equal(srcRows(m.app).length, 3);
});

test("a Plot that draws but matches no shapes says its hover and click are off, instead of pretending", async () => {
  const m = await mountOv();
  const P = fakePlot(m.doc, {});
  const real = P.plot;
  P.plot = (o) => { const n = real(o); n.querySelectorAll = () => []; return n; };
  m.ctx.Plot = P;
  m.setHash("#/overview"); await m.settle();
  assert.equal(byClass(m.app, "cov").filter((c) => /hover and click are unavailable/.test(textOf(c))).length, 3);
});

test("Overview failure states have a voice: a failed inbox, and a failed worklist, are not an empty dashboard", async () => {
  const bad = await mountOv({ routes: { "/api/inbox": respond(500, { error: "disk gone" }) } });
  assert.match(textOf(byClass(bad.app, "banner")[0]), /the queue could not be read/);
  const failed = inboxOf();
  failed.divisions.worklist = { error: "ledger unreadable", ready: null, blocked: null };
  const w = await mountOv({ inbox: failed });
  assert.match(textOf(byClass(w.app, "banner")[0]), /ledger unreadable/);
  assert.equal(kpiCards(w.app).length, 0, "no KPI is drawn over a worklist that could not be computed");
  const empty = await mountOv({ inbox: inboxOf({ ready: [], blocked: [], parked: [] }) });
  assert.match(textOf(byClass(empty.app, "empty")[0]), /Nothing waiting/);
});

test("a source whose edges are ALL blocked opens Unblock, never an empty Judge (live render 2026-10-16)", async () => {
  const m = await mount({});
  const r = (g) => m.ui.sourceRoute(g);
  assert.equal(r({ source: "/u/a.md", edges: 14, blocked: 14 }), "unblock");
  assert.equal(r({ source: "/u/a b.md", edges: 12, blocked: 0 }), "judge?source=%2Fu%2Fa%20b.md");
  assert.equal(r({ source: "/u/c.md", edges: 7, blocked: 3 }), "judge?source=%2Fu%2Fc.md", "a partly blocked source still has edges to judge");
});

/* ══ Phase 0 and Phase 1 (2026-10-16): loading states, Kpi, DataTable, one chart implementation, ErrorBanner ══
   Plan ticklish-gathering-brook, Phases 0 and 1. The earlier cases in this file were rewritten where the
   markup they pinned (hand-built columns, div bars, the sparkline, bare .kpi) was deliberately replaced. */

const tabIndexOf = (n) => n.getAttribute("tabIndex") ?? n.getAttribute("tabindex");
const cardText = (app, re) => textOf(byClass(app, "chart").find((c) => re.test(textOf(c))) || { textContent: "" });

test("Phase 0: a pending read says 'loading…', a failed read says 'could not read — <reason>', and the two never share a word", async () => {
  // Pure first: the same Overview model in the three states /api/surface and /api/health can be in.
  const m = await mountOv();
  const model = m.ui.overviewModel(OV_INBOX, Date.now());
  const kpis = (v, h) => Object.fromEntries(fromRealm(m.ui.overviewKpis(model, v, h, Date.now())).map((k) => [k.key, k]));
  const loading = kpis({ status: "loading", reason: null }, { status: "loading" });
  const failed = kpis({ status: "error", reason: "surface exploded" }, { status: "error", kind: "http", error: "doctor missing" });
  for (const key of ["today", "health"]) {
    assert.equal(loading[key].text, "loading…");
    assert.equal(failed[key].text, "could not read");
    assert.notEqual(loading[key].text, failed[key].text, key + ": pending and failed must not read the same");
    assert.notEqual(loading[key].sub, failed[key].sub);
    for (const k of [loading[key], failed[key]]) assert.doesNotMatch(k.text + k.sub, /unknown/, "'unknown' is neither a wait nor a failure");
  }
  assert.equal(failed.today.sub, "surface exploded", "the reason is the server's own");
  assert.equal(failed.health.sub, "doctor missing");
  // readState is the one place the three states are told apart
  assert.deepEqual(fromRealm(m.ui.readState({ status: "idle" })), { kind: "loading", reason: null, text: "loading…" });
  assert.deepEqual(fromRealm(m.ui.readState({ status: "loading" })).kind, "loading");
  assert.equal(fromRealm(m.ui.readState({ status: "error", kind: "http", error: "boom" })).text, "could not read — boom");
  assert.match(fromRealm(m.ui.readState({ status: "error", kind: "token", error: "x" })).text, /token expired/, "a dead token says reopen, not the raw error");
  assert.equal(m.ui.readState({ status: "ok", data: {} }).kind, "ok");
  assert.equal(m.ui.velocityNote({ status: "ok" }), null);
});

test("Phase 0: on screen, a held /api/surface reads 'loading…' and a failed one 'could not read', in the KPI AND the chart", async () => {
  const held = await mountOv({ untracked: ["/api/surface"], routes: { "/api/surface": () => new Promise(() => {}) } });
  assert.match(kpiCards(held.app).map(textOf)[3], /^Judged today\s*loading…/);
  assert.match(cardText(held.app, /Verdicts per day/), /loading…/);
  assert.doesNotMatch(textOf(held.app), /unknown|could not read/, "while pending, nothing claims a failure or an unknown");
  const failed = await mountOv({ routes: { "/api/surface": respond(500, { error: "surface exploded" }) } });
  assert.match(kpiCards(failed.app).map(textOf)[3], /^Judged today\s*could not readsurface exploded/);
  assert.match(cardText(failed.app, /Verdicts per day/), /could not read — surface exploded/);
  assert.doesNotMatch(textOf(failed.app), /loading…|unknown/);
  // and it is the SAME two sentences on Activity
  const act = await mount({ hash: "#/activity", routes: { "/api/surface": respond(500, { error: "surface exploded" }) } });
  assert.match(textOf(detail(act.app)), /activity could not be read — surface exploded/);
});

/* -- Kpi ------------------------------------------------------------------------ */

test("Kpi: every card has a route or says why in its tooltip -- the Unblock row is clickable now, and the fallback sentence never shows", async () => {
  const m = await mount({ hash: "#/unblock" });
  const cards = byClass(m.app, "kpi");
  assert.equal(cards.length, 3);
  assert.deepEqual(cards.map((c) => /\bpick\b/.test(c.getAttribute("class")) ? "pick" : "inert"), ["pick", "pick", "inert"], "blocked and roots lead somewhere; 'need several' is 0, so it is inert");
  assert.ok(cards.every((c) => tabIndexOf(c) === "0"), "an inert card takes focus too: focus is how a keyboard user gets its reason");
  // the inert card says why, in the page's one tooltip
  hover(cards[2]);
  await m.settle();
  assert.match(textOf(tipBox(m.app)), /Need several.*no edge that needs several roots, so there is nothing to open/);
  unhover(cards[2]);
  // the live ones navigate: blocked -> the roots list, roots -> Judge on the top root
  click(cards[0]); await m.settle();
  assert.equal(m.ctx.location.hash, "#/unblock?focus=roots");
  assert.equal(findAll(m.app, (n) => n.nodeType === 1 && n.getAttribute("data-focus") === "roots").length, 1, "the target the route names exists");
  m.setHash("#/unblock"); await m.settle();
  click(byClass(m.app, "kpi")[1]); await m.settle();
  assert.equal(m.ctx.location.hash, "#/judge?edge=a");
  // pure: the rule for every figure, including the all-zero case
  const model = (o) => fromRealm(m.ui.unblockKpis({ blocked: 0, rootsTotal: 0, needAllRoots: 0, ranked: [], byFile: [], ...o }));
  for (const k of model({})) { assert.equal(k.route, null); assert.ok(k.tip && k.tip !== m.ui.KPI_NO_REASON, k.key + " is inert and must say why"); }
  assert.equal(model({ blocked: 3, needAllRoots: 3, byFile: [{ file: "x" }] })[0].route, "unblock?focus=together", "no single root frees anything: go to the joint groups");
  assert.equal(model({ blocked: 3, needAllRoots: 3, byFile: [{ file: "x" }] })[2].route, "unblock?focus=together");
  assert.equal(model({ blocked: 2, rootsTotal: 1, ranked: [{ edge_id: "r1", inQueue: false }] })[1].route, "unblock?focus=roots", "a never-verified top root cannot be judged: fall back to the list");
});

test("Kpi: a card given no route and no reason shows the fallback sentence that reads as a defect -- and no real view does", async () => {
  const m = await mountOv();
  // The fallbacks themselves, rendered bare: that they exist and show is what makes their absence below mean something.
  const { h, render } = m.ctx.preact;
  const host = m.doc.createElement("div");
  m.app.appendChild(host);
  render(h(m.ui.Kpi, { label: "Bare", value: 1, sub: "", route: null, tip: null, nav: () => {} }), host);
  hover(byClass(host, "kpi")[0]); await m.settle();
  assert.ok(tipBox(m.app), "a card with no reason still shows a tooltip");
  assert.match(textOf(tipBox(m.app)), new RegExp(m.ui.KPI_NO_REASON), "a card with no route and no reason falls back to the defect sentence");
  unhover(byClass(host, "kpi")[0]);
  render(h(m.ui.DataTable, { columns: [{ key: "a", label: "a", cell: (r) => r.a }], rows: [{ a: "x" }], rowKey: (r) => r.a }), host);
  hover(dtRows(host)[0]); await m.settle();
  assert.ok(tipBox(m.app), "an inert row with no tip still shows a tooltip");
  assert.match(textOf(tipBox(m.app)), new RegExp(m.ui.ROW_NO_REASON), "a row with no route, no action and no tip falls back to the defect sentence");
  assert.match(dtRows(host)[0].getAttribute("class"), /\binert\b/);
  unhover(dtRows(host)[0]);
  render(null, host);
  // the component directly: that the fallback exists and shows is what makes its absence everywhere else mean something
  const bare = await mount({ hash: "#/unblock", inbox: inboxOf({ blocked: [] }) });
  assert.equal(byClass(bare.app, "kpi").every((c) => /\binert\b/.test(c.getAttribute("class"))), true, "nothing blocked: all three are inert");
  const views = { "#/overview": { "/api/health": HEALTH }, "#/judge": {}, "#/unblock": {}, "#/health": { "/api/health": HEALTH }, "#/activity": {},
    "#/registers": { "/api/registers": { error: null, issues: [{ kind: "issue", short: "a", text: "t", priority: 1, file: "/f" }], todos: [], handovers: [] } },
    "#/reminders": { "/api/conflicts": { ok: true, list: "L", rows: [{ reminderId: "1", disposition: "held-no-register", reason: "r" }], summary: { total: 1 } } } };
  let seen = 0;
  for (const [hash, routes] of Object.entries(views)) {
    const v = await mount({ hash, inbox: OV_INBOX, routes });
    const t = textOf(v.app);
    seen += byClass(v.app, "kpi").length + dtRows(v.app).length;
    assert.ok(!t.includes(m.ui.KPI_NO_REASON) && !t.includes(m.ui.ROW_NO_REASON), `${hash} rendered a card or row that goes nowhere and says nothing`);
    for (const el of [...byClass(v.app, "kpi"), ...dtRows(v.app)]) {
      hover(el); await v.settle();
      const tb = tipBox(v.app);
      assert.ok(tb, `${hash}: "${textOf(el).slice(0, 40)}" shows no tooltip at all, so nothing explains what it does or why it does nothing`);
      assert.ok(!/goes nowhere, and nothing says why/.test(textOf(tb)), `${hash}: ${textOf(el).slice(0, 40)} has no reason`);
      unhover(el);
    }
  }
  assert.ok(seen >= 12, `only ${seen} cards and rows exercised -- the sweep has gone blind`);
});

/* -- DataTable ------------------------------------------------------------------ */

test("sortRows: null sorts last in BOTH directions, text A to Z, numbers by size, ties by the tie key", async () => {
  const { ui } = await mount();
  const rows = [{ k: "b", v: 2 }, { k: "a", v: 2 }, { k: "n", v: null }, { k: "c", v: 9 }, { k: "m", v: undefined }];
  const order = (dir) => fromRealm(ui.sortRows(rows, (r) => r.v, dir, (r) => r.k)).map((r) => r.k).join("");
  assert.equal(order("desc"), "cabmn", "9, then the 2s by tie key, then the two nulls by tie key");
  assert.equal(order("asc"), "abcmn", "nulls are still last, not first");
  assert.equal(fromRealm(ui.sortRows([{ s: "b" }, { s: "A" }, { s: "c" }], (r) => r.s, "asc")).map((r) => r.s).join(""), "AbC".replace("C", "c"));
  assert.deepEqual(fromRealm(ui.sortRows(null, () => 0, "asc")), [], "no rows is an empty list, not a throw");
});

test("every DataTable row takes focus, Enter acts only when the ROW has focus, and a control inside a row stops its own click", async () => {
  const m = await mountOv();
  const row = srcRows(m.app)[0];
  assert.ok(dtRows(m.app).every((r) => tabIndexOf(r) === "0"));
  // Enter on a focused control INSIDE the row is the control's, not the row's (key events bubble in a browser; the target tells them apart)
  const before = m.ctx.location.hash;
  row.dispatchEvent({ type: "keydown", key: "Enter", target: m.doc.createElement("button"), preventDefault() {} });
  await m.settle();
  assert.equal(m.ctx.location.hash, before, "Enter on a control inside the row did not navigate");
  row.dispatchEvent({ type: "keydown", key: "Enter", preventDefault() {} });
  await m.settle();
  assert.notEqual(m.ctx.location.hash, before);
  assert.match(m.ctx.location.hash, /^#\/judge\?source=/);
  // the stop() that keeps a Copy button from also firing its row
  const h = await mount({ hash: "#/health", routes: { "/api/health": HEALTH } });
  let stopped = 0;
  const copyBtn = btnText(dtRows(h.app)[0], /^copy/);
  assert.ok(copyBtn, "a health row carries its Copy button");
  copyBtn.dispatchEvent({ type: "click", stopPropagation() { stopped += 1; }, preventDefault() {} });
  assert.equal(stopped, 1, "Copy must stop the click, or the row copies as well");
});

test("Unblock roots: a root in the queue opens Judge, a never-verified one copies its baseline command, and both flash 'copied'", async () => {
  const items = [edge("x", "DRIFTED", { orderIndex: 0, blocked: true, blockedBy: [{ edge_id: "it's-root", from: "/u/Documents/GitHub/k/a.md", to: "/u/Documents/GitHub/k/b.md", state: "NEVER_VERIFIED" }] })];
  const m = await mount({ inbox: inboxOf({ ready: [], blocked: items, parked: [] }), hash: "#/unblock", speedUp: false });
  const wrote = clipboard(m);
  const row = dtRows(m.app)[0];
  assert.match(textOf(row), /NEVER VERIFIED/);
  click(row);
  for (let i = 0; i < 40 && !/copied/.test(textOf(row)); i++) await sleep(10);
  assert.deepEqual(wrote, ["propagate verify --edge 'it'\\''s-root' --disposition baselined --reason '<what you checked, as file:line>' --apply"]);
  assert.match(textOf(row), /copied/, "the row says so");
  // a root in the queue: the row itself opens Judge, no button needed
  const q = await mount({ hash: "#/unblock" });
  click(dtRows(q.app)[0]); await q.settle();
  assert.equal(q.ctx.location.hash, "#/judge?edge=a");
});

test("Health: warn rows are grouped by section and each carries a tooltip; a mapped next step copies on click", async () => {
  const m = await mount({ hash: "#/health", routes: { "/api/health": HEALTH }, speedUp: false });
  const wrote = clipboard(m);
  const sections = byTag(detail(m.app), "details");
  assert.equal(sections.length, 1);
  const warn = dtRows(sections[0]);
  assert.equal(warn.length, 3, "State's three warnings");
  assert.ok(warn.every((r) => textOf(byClass(r, "badge")[0]) === "WARN"));
  for (const r of warn) {
    hover(r); await m.settle();
    assert.match(textOf(tipBox(m.app)), /State.*warning, not failing.*doctor maps no next step for a warning/, textOf(r));
    unhover(r);
  }
  assert.equal(byClass(sections[0], "none-mapped").length, 0, "a warning carries no 'no action mapped' line: that is the normal case");
  // a fail row WITH a next step copies it
  const open = dtRows(m.app).find((r) => /CLAUDE\.md restates rule:x/.test(textOf(r)));
  click(open);
  for (let i = 0; i < 40 && !/copied/.test(textOf(open)); i++) await sleep(10);
  assert.deepEqual(wrote, ["/u/Documents/GitHub/CLAUDE.md"]);
  // and one WITHOUT is inert, and says so
  const none = dtRows(m.app).find((r) => /workspaces conform/.test(textOf(r)));
  assert.match(none.getAttribute("class"), /\binert\b/);
  const before = wrote.length;
  click(none);
  await m.settle();
  assert.equal(wrote.length, before, "an inert row copies nothing");
});

test("Registers and Reminders rows copy their locator: file:line for a register item, the best available for a reminder", async () => {
  const reg = { error: null, handovers: [], todos: [],
    issues: [{ kind: "issue", file: "/u/Documents/GitHub/propagate/ISSUES.md", short: "propagate/ISSUES.md", line: 10, text: "N1 · something", id: "N1", priority: "S2" },
      { kind: "issue", text: "no file recorded", id: "N2", priority: null }] };
  const m = await mount({ hash: "#/registers", routes: { "/api/registers": reg }, speedUp: false });
  const wrote = clipboard(m);
  const rows = dtRows(m.app);
  assert.equal(rows.length, 2);
  click(rows[0]);
  for (let i = 0; i < 40 && !/copied/.test(textOf(rows[0])); i++) await sleep(10);
  assert.deepEqual(wrote, ["/u/Documents/GitHub/propagate/ISSUES.md:10"], "the absolute path and the line, so it opens from a terminal");
  assert.equal(m.ui.registerLocator({ short: "k/TODOS.md", line: 3 }), "k/TODOS.md:3", "a row with no `file` falls back to its short path");
  assert.equal(m.ui.registerLocator({ text: "x" }), null);
  assert.match(rows[1].getAttribute("class"), /\binert\b/, "an item with no locator is inert");
  assert.equal(buttons(detail(m.app)).length, 0, "still no write control: copying is not a register write");
  // Reminders: /api/conflicts rows carry registerPath (no line) or only reminderId -- no file:line exists
  const rem = { ok: true, list: "Claude TODO", summary: { total: 2 }, rows: [
    { reminderId: "R-1", disposition: "held-unrecognized-shape", reason: "no staging heading", registerPath: "/u/Documents/GitHub/k/TODOS.md", project: "k", prId: "PR-001" },
    { reminderId: "R-2", disposition: "held-no-register", reason: "no TODOS.md found", tag: "k" }] };
  const r = await mount({ hash: "#/reminders", routes: { "/api/conflicts": rem }, speedUp: false });
  const rw = clipboard(r);
  const rr = dtRows(r.app);
  assert.equal(rr.length, 2);
  click(rr.find((x) => /PR-001/.test(textOf(x))));
  click(rr.find((x) => /no TODOS\.md found/.test(textOf(x))));
  for (let i = 0; i < 40 && rw.length < 2; i++) await sleep(10);
  assert.deepEqual(rw, ["/u/Documents/GitHub/k/TODOS.md", "R-2"], "the register path when there is one, the reminder id when there is not");
});

/* -- one chart implementation, one banner ------------------------------------------ */

test("every chart in every view is Plot: the Velocity columns, the Spark and the div Bars are gone", async () => {
  const src = read("commands/ui.client.js");
  assert.ok(src.length > 20000, "the scan has gone blind");
  assert.doesNotMatch(src, /function (Velocity|Spark|Bars)\b/, "a deleted chart implementation came back");
  const gone = ["vcol", "vstack", "vseg-changed", "vseg-quiet", "vaxis", "vtick", "axnote", "bar-t", "bar-f", "series", "hit", "vleg"];
  const views = { "#/overview": {}, "#/judge": {}, "#/unblock": {}, "#/health": { "/api/health": HEALTH }, "#/activity": {} };
  let plots = 0;
  for (const [hash, routes] of Object.entries(views)) {
    const m = await mountOv({ hash: "#/judge", routes });
    const log = withPlot(m);
    m.setHash(hash); await m.settle();
    plots += log.all.length;
    for (const cls of gone) assert.equal(byClass(m.app, cls).length, 0, `${hash} still draws .${cls}`);
  }
  assert.ok(plots >= 5, `only ${plots} Plot charts drawn across the views (3 on the Overview, 2 on Activity) -- the sweep has gone blind`);
  // The Never verified buckets are Plot too -- covered where they are opened, above.
});

test("a hand-written div.banner is gone: every error is ErrorBanner, and each one that can be retried offers 'retry'", async () => {
  const src = read("commands/ui.client.js");
  const from = src.indexOf("function ErrorBanner");
  const eb = src.slice(from, src.indexOf("/** Stop a click"));
  assert.ok(from > 0 && eb.length > 200, "ErrorBanner not found: the scan has gone blind");
  const left = [...src.replace(eb, "").matchAll(/<div class="banner[^>]*>/g)].map((x) => x[0]).sort();
  // Two remain on purpose: the focused-section note (a status, not an error) and the stale-server notice
  // (restarting the server is the cure, so a retry button would be a lie).
  assert.deepEqual(left, ['<div class="banner focus" role="status">', '<div class="banner" role="alert">'], "an error banner was written by hand");
  const retries = [];
  const check = async (label, m) => {
    const banner = byClass(m.app, "banner")[0];
    assert.ok(banner, label + ": no banner");
    const btn = btnText(banner, /^retry$/);
    assert.ok(btn, label + ": no retry in " + textOf(banner));
    retries.push(label);
  };
  const fatal = { fatal: "reconcile failed: no workspaces", divisions: null };
  await check("judge fatal", await mount({ inbox: fatal }));
  await check("unblock fatal", await mount({ inbox: fatal, hash: "#/unblock" }));
  await check("overview fatal", await mountOv({ inbox: fatal }));
  const broken = JSON.parse(JSON.stringify(INBOX));
  broken.divisions.worklist = { error: "fix-order join exploded", ready: null, blocked: null };
  await check("judge worklist", await mount({ inbox: broken }));
  await check("unblock worklist", await mount({ inbox: broken, hash: "#/unblock" }));
  await check("overview worklist", await mountOv({ inbox: broken }));
  await check("health unreadable", await mount({ hash: "#/health", routes: { "/api/health": { ok: false, reason: "no snapshot yet" } } }));
  await check("registers", await mount({ hash: "#/registers", routes: { "/api/registers": { error: "backlog exploded", issues: null, todos: null } } }));
  await check("reminders", await mount({ hash: "#/reminders", routes: { "/api/conflicts": { ok: false, reason: "EPERM" } } }));
  assert.equal(retries.length, 9);
  // and the retry actually re-reads: the reminders one
  const r = await mount({ hash: "#/reminders", routes: { "/api/conflicts": { ok: false, reason: "EPERM" } } });
  const n = r.fetches.filter((f) => f.path === "/api/conflicts").length;
  click(btnText(byClass(r.app, "banner")[0], /^retry$/)); await r.settle();
  assert.equal(r.fetches.filter((f) => f.path === "/api/conflicts").length, n + 1);
  // a dead token has nothing to retry: it gives the instruction instead of a button that cannot work
  const dead = await mount({ inbox: respond(401, { error: "token" }) });
  assert.equal(btnText(byClass(dead.app, "banner")[0], /^retry$/), undefined);
  assert.match(textOf(byClass(dead.app, "banner")[0]), /token expired/);
});

test("Unblock ?focus= is parsed, and a value the page does not know is ignored rather than put in a selector", async () => {
  const { ui } = await mount();
  assert.equal(fromRealm(ui.parseHash("#/unblock?focus=roots")).focus, "roots");
  assert.equal(fromRealm(ui.parseHash("#/unblock")).focus, null);
  // an unknown value reaches the view but never a querySelector: mount with a hostile one and with a querySelector that records its argument
  const m = await mount({ hash: '#/unblock?focus=%22%5D%2C%20body' });
  assert.equal(byClass(m.app, "kpi").length, 3, "the view still renders");
  const asked = [];
  const root = detail(m.app);
  root.querySelector = (sel) => { asked.push(sel); return null; };
  m.setHash("#/unblock?focus=together"); await m.settle();
  m.setHash('#/unblock?focus=%22%5D%2C%20body'); await m.settle();
  assert.ok(asked.every((s) => /^\[data-focus="(roots|together)"\]$/.test(s)), "only a known anchor name is ever put in a selector: " + asked.join(" | "));
});

/* ══ Phase 1b (2026-10-16): five touch-point fixes found on the Phase 0-1 review ══ */

test("Phase 1b/1: 'To judge' and 'Blocked' say 'loading…' while the queue is read and 'could not read' when it failed, never 'unknown'", async () => {
  const m = await mountOv();
  const model = fromRealm(m.ui.overviewModel(OV_INBOX, Date.now()));
  // The model as it is when a figure is MISSING: the payload carried no worklist / leverage count.
  const holed = { ...model, toJudge: null, blocked: null };
  const k = (inbox) => Object.fromEntries(fromRealm(m.ui.overviewKpis(holed, { status: "ok", days: [] }, { status: "loading" }, Date.now(), inbox)).map((x) => [x.key, x]));
  const loading = k({ status: "loading" });
  const failed = k({ status: "error", kind: "http", error: "inbox exploded" });
  const sent = k({ status: "ok", data: {} });
  for (const key of ["judge", "blocked"]) {
    assert.equal(loading[key].text, "loading…");
    assert.equal(failed[key].text, "could not read");
    assert.equal(failed[key].sub, "inbox exploded", "the reason is the server's own");
    assert.equal(sent[key].text, "could not read", "read fine but the figure is not in it: still not a number, still not 'unknown'");
    assert.match(sent[key].sub, /the queue sent no/);
    for (const x of [loading[key], failed[key], sent[key]]) assert.doesNotMatch(x.text + x.sub, /unknown/);
  }
  // a figure that IS held is shown whatever the resource is doing (a refresh keeps the old number up)
  const held = Object.fromEntries(fromRealm(m.ui.overviewKpis(model, { status: "ok", days: [] }, { status: "loading" }, Date.now(), { status: "loading" })).map((x) => [x.key, x]));
  assert.equal(held.judge.text, String(OV_INBOX.worklist.toJudge));
});

test("Phase 1b/2: Enter and Space on a focused Judge row select it like a click; on the checkbox inside it they do not", async () => {
  const m = await mount();
  const list = () => rows(m.app);
  assert.match(list()[0].getAttribute("class"), /\bsel\b/, "the first row starts selected");
  const second = list()[1];
  assert.doesNotMatch(second.getAttribute("class"), /\bsel\b/);
  // a key event from the checkbox inside the row is the checkbox's own (Space toggles it)
  second.dispatchEvent({ type: "keydown", key: " ", target: byTag(second, "input")[0], preventDefault() {} });
  await m.settle();
  assert.doesNotMatch(list()[1].getAttribute("class"), /\bsel\b/, "Space on the checkbox must not select the row");
  for (const key of ["Enter", " "]) {
    list()[0].dispatchEvent({ type: "click", stopPropagation() {}, preventDefault() {} });
    await m.settle();
    assert.doesNotMatch(list()[1].getAttribute("class"), /\bsel\b/);
    list()[1].dispatchEvent({ type: "keydown", key, target: list()[1], preventDefault() {} });
    await m.settle();
    assert.match(list()[1].getAttribute("class"), /\bsel\b/, JSON.stringify(key) + " on the focused row selects it");
  }
});

test("Phase 1b/3: clearing a Judge filter chip rewrites the hash without that parameter and keeps the others", async () => {
  const { ui } = await mount();
  // the pure rewrite first
  const w = (h, k, c) => ui.hashWithout(h, k, c);
  assert.equal(w("#/judge?ws=WS1&age=1to7d&source=%2Fa.md", "age"), "judge?ws=WS1&source=%2Fa.md");
  assert.equal(w("#/judge?ws=WS1", "ws"), "judge", "the last parameter takes the '?' with it");
  assert.equal(w("#/judge?ws=WS1&chip=parked", "ws", "both"), "judge?chip=both", "the open chip replaces the old chip=, never doubles it");
  assert.equal(w("#/judge", "ws"), "judge");
  // then on screen: every chip, with the others kept and the address bar agreeing
  const full = "#/judge?state=REVERSED&ws=WS1&source=" + encodeURIComponent(SRC_A) + "&age=1to7d";
  for (const [aria, gone] of [["workspace", "ws"], ["waiting time", "age"], ["source", "source"], ["reverse", "state"]]) {
    const m = await mount({ hash: full, inbox: OV_INBOX });
    const chip = byClass(m.app, "filt").find((c) => new RegExp(aria, "i").test(c.getAttribute("aria-label")));
    assert.ok(chip, "no " + aria + " chip on screen for " + full);
    click(chip); await m.settle();
    const h = m.ctx.location.hash;
    assert.doesNotMatch(h, new RegExp("[?&]" + gone + "="), gone + "= must be gone from " + h);
    for (const keep of ["state", "ws", "source", "age"].filter((x) => x !== gone)) assert.match(h, new RegExp("[?&]" + keep + "="), keep + "= must survive in " + h);
    assert.equal(byClass(m.app, "filt").length, 3, "the other three chips are still there");
  }
});

test("Phase 1b/4: a runs-per-day bar's tooltip says it is hover only", async () => {
  const { ui } = await mount();
  const t = fromRealm(ui.tipText("runs", { day: "2026-10-15", count: 5 }));
  assert.match(t.lines[t.lines.length - 1], /hover only — no list behind a day's count/);
  assert.equal(t.lines[0], "5 commands run");
});

test("Phase 1b/5: the header refresh re-reads /api/baseline when the Never-verified chip is open, and /graph on the Graph view", async () => {
  const baseline = { buckets: { baselineable: 6, noCoCommit: 253, boundReached: 1, ineligibleCrossRepo: 64, examinedAndDeferred: 33 }, total: 357, accountedFor: true, unaccounted: 0, error: null };
  const count = (m, p) => m.calls.filter((c) => c === p).length;
  const m = await mount({ routes: { "/api/baseline": baseline } });
  click(btnText(m.app, /Never verified/)); await m.settle();
  assert.equal(count(m, "/api/baseline"), 1);
  click(btnText(m.app, /^refresh$/)); await m.settle();
  assert.equal(count(m, "/api/baseline"), 2, "an open Never chip's split is re-read by refresh");
  // closed chip: nothing asked for it, so refresh does not fetch it
  const c = await mount({ routes: { "/api/baseline": baseline } });
  click(btnText(c.app, /^refresh$/)); await c.settle();
  assert.equal(count(c, "/api/baseline"), 0, "a chip that is not open is not fetched by refresh");
  // Graph
  const g = await mount({ hash: "#/graph", routes: { "/graph": rawText(200, "<html>g</html>") } });
  assert.equal(count(g, "/graph"), 1);
  click(btnText(g.app, /^refresh$/)); await g.settle();
  assert.equal(count(g, "/graph"), 2, "refresh re-renders the graph");
});
