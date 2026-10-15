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
  assert.match(labels[0], /JUDGE\s*3/, "Judge reads worklist.toJudge");
  assert.match(labels[1], /UNBLOCK\s*1/, "Unblock reads leverage.blocked");
  // ACTIVITY and the Explore views have no count; they must not read as 0.
  for (const i of [3, 4, 5, 6]) assert.doesNotMatch(labels[i], /\d/, `${labels[i]} must not render a count it does not have`);
});

test("the Judge badge EQUALS the rendered To-judge rows, by the widget's own counter (plan test 8)", async () => {
  // Two independent derivations of one number: the server's buildWorklist over the
  // items, and the rows the page draws. The 46-versus-78 defect was these two
  // disagreeing in different units.
  const { app, ui } = await mount();
  const badge = Number(textOf(byClass(app, "div")[0]).replace(/\D/g, ""));
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
  click(btnText(m.app, /Never verified/));
  await m.settle();
  const t = textOf(byClass(m.app, "detail")[0]);
  assert.match(t, /357 never verified/);
  assert.match(t, /PERMANENT/);
  assert.match(t, /never clear/i);
  assert.match(t, /It is not a baseline|It is not a backlog/);
  assert.match(t, /UI writes no baseline/);
  assert.equal(byTag(byClass(m.app, "disp")[0] ? m.app : byClass(m.app, "detail")[0], "textarea").length, 0, "a never-verified view must offer no verdict form");
  assert.ok(byClass(m.app, "cmd").some((c) => /propagate bootstrap --baseline-from-git/.test(textOf(c))));
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
  const none = { section: null, state: null, chip: null };
  assert.deepEqual(fromRealm(m.ui.readHash()), { view: "judge", edge: "abc d", ...none });
  m.ctx.location.hash = "#/nonsense";
  assert.deepEqual(fromRealm(m.ui.readHash()), { view: "judge", edge: null, ...none });
  // Deep links (2026-10-15): section / state / chip ride in the hash beside edge.
  m.ctx.location.hash = "#/health?section=Workspace%3A";
  assert.deepEqual(fromRealm(m.ui.readHash()), { view: "health", edge: null, section: "Workspace:", state: null, chip: null });
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
  assert.match(t, /1\s*blocked/);
  assert.match(t, /1\s*roots/);
  assert.match(t, /0\s*need several/);
  assert.match(t, /frees 1 now/);
  assert.match(t, /lib\/a\.mjs → propagate\/commands\/a\.mjs|propagate\/lib\/a\.mjs/);
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
  assert.match(t, /2\s*need several/);
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
  const marked = byClass(m.app, "hrow").filter((r) => /focus/.test(r.getAttribute("class")));
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
  const hrows = byClass(m.app, "hrow").map(textOf);
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

test("Activity draws verdicts as a stacked bar per day and states its share without NaN", async () => {
  const m = await mount({ hash: "#/activity" });
  const t = textOf(detail(m.app));
  assert.equal(byClass(m.app, "vcol").length, 3);
  assert.equal(byClass(m.app, "vgap").length, 1, "a day with no verdicts is a gap, not a zero-height bar");
  assert.match(t, /71% of 7 verdicts in 3 days recorded that nothing needed doing/);
  assert.match(t, /status/);
  assert.doesNotMatch(t, /NaN|undefined/);
  assert.equal(byClass(m.app, "vseg-quiet").length, 3);
  assert.equal(byClass(m.app, "changed").length, 0, "no changed-since feed (D5)");
});

test("Activity says unknown with the reason, never 14 zeros", async () => {
  const bad = { ...SURFACE, velocity: { status: "unknown", reason: "event store unreadable: EACCES", days: [] }, usage: { status: "none-recorded", reason: "no command records in the runs store" } };
  const m = await mount({ hash: "#/activity", routes: { "/api/surface": bad } });
  const t = textOf(detail(m.app));
  assert.match(t, /unknown: event store unreadable: EACCES/);
  assert.match(t, /None recorded: no command records/);
  assert.equal(byClass(m.app, "vcol").length, 0);
});

test("a day-less window with no events says so", async () => {
  const none = { ...SURFACE, velocity: { status: "ok", reason: null, windowDays: 14, events: 0, noChangeEvents: 0, noChangeShareOfEvents: null, days: [] } };
  const m = await mount({ hash: "#/activity", routes: { "/api/surface": none } });
  assert.match(textOf(detail(m.app)), /No verdicts in 14 days \(event store read\)/);
});

test("a gap in a series BREAKS the path instead of interpolating across it", async () => {
  // A line drawn across a day nobody measured asserts a reading never taken.
  const { ui } = await mount();
  const pts = [{ value: 1 }, { value: null }, { value: 3 }];
  const d = ui.linePath(pts, (i) => i * 10, (v) => v);
  assert.equal((d.match(/M/g) || []).length, 2, "two subpaths, because the middle day is a gap");
  assert.doesNotMatch(d, /M0\.0 1\.0 L20/, "must not join across the gap");
});

test("a chart path measures itself and hands the length to the CSS", async () => {
  // Without --len the draw-in animation silently does not run.
  const { app } = await mount({ hash: "#/activity" });
  const series = findAll(app, (n) => n.nodeType === 1 && String(n.getAttribute && n.getAttribute("class") || "").includes("series"));
  assert.ok(series.length, "no series paths rendered");
  assert.equal(series[0].style._props.get("--len"), "123.4", "getTotalLength() must reach the CSS");
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
