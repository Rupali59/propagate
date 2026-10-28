/**
 * The widget's chart maths, RUN — not read.
 *
 * WHY THIS EXISTS (decision D12). `widget/propagate-queue.jsx` is JSX that node
 * cannot import, so its geometry — the queue bar percentages, sparkline bar heights,
 * the health line and the changed-pill window — had no test at all. A wrong rounding
 * draws a bar that over- or under-fills its track, with correct data, valid SVG and no
 * error anywhere (the G9 family: right DOM, wrong picture).
 *
 * So the arithmetic lives in a marked pure block, `// ---- pure:charts begin ----`
 * to `end`, plain JS with no JSX and no imports, and this file extracts that
 * block FROM THE FILE TEXT and runs it in node:vm. The same technique
 * tests/unit/ui-client.test.mjs uses for the web client; nothing is duplicated,
 * so the code under test is the code that ships.
 *
 * THE FLOOR COMES FIRST. A regex that stops matching would otherwise make every
 * assertion below vacuous. The block must exist, be non-trivial, and define the
 * functions the widget calls (rule:derive-dont-curate).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

const WIDGET = path.join(import.meta.dirname, "../../widget/propagate-queue.jsx");
const src = readFileSync(WIDGET, "utf8");

const BEGIN = "// ---- pure:charts begin ----";
const END = "// ---- pure:charts end ----";

function extract() {
  const i = src.indexOf(BEGIN);
  const j = src.indexOf(END);
  assert.ok(i !== -1 && j !== -1 && j > i,
    `the widget has no pure:charts block (${BEGIN} ... ${END}) - this suite has gone blind, which is worse than failing`);
  return src.slice(i + BEGIN.length, j);
}

const NAMES = ["apportion", "queueParts", "healthSummary", "sinceText", "barHeights",
  "healthPills", "localISO", "shortDate", "baseName", "agoText", "whyNot",
  "rootRoute", "viewRoute", "tipLines", "fmtDay"];

/** Run the block in a fresh vm context with NOTHING else in scope, and hand back its functions. */
function load() {
  const block = extract();
  assert.ok(block.split("\n").length > 60, "the pure block is implausibly small - the extraction has gone blind");
  const ctx = vm.createContext({});
  // `const` at script top level is not a property of the context, so the
  // functions are returned by an expression appended to the SAME script.
  return vm.runInContext(`${block}\n;({ ${NAMES.join(", ")} })`, ctx);
}

// The vm context has its own Array/Object, so deepStrictEqual (which compares
// prototypes) calls a correct result "not reference-equal". Wrapping every
// function so its RESULT is round-tripped through JSON puts values back in this
// realm. Nothing in the pure block returns a function, Map or undefined that the
// round trip could change; null and numbers survive it.
const raw = load();
const f = Object.fromEntries(Object.entries(raw).map(([k, fn]) => [k, (...a) => {
  const r = fn(...a);
  return r === undefined ? r : JSON.parse(JSON.stringify(r));
}]));

test("floor: the block exists and defines every function the widget calls", () => {
  for (const n of NAMES) assert.equal(typeof f[n], "function", `${n} is missing from the pure block`);
  // And the widget really does call them (an unused helper is dead weight, and a
  // renamed one makes this suite test code the widget no longer runs).
  const outside = src.slice(0, src.indexOf(BEGIN)) + src.slice(src.indexOf(END));
  for (const n of ["queueParts", "healthSummary", "sinceText", "barHeights", "baseName", "agoText", "whyNot", "tipLines", "viewRoute"]) {
    assert.match(outside, new RegExp(`\\b${n}\\(`), `the widget never calls ${n}`);
  }
});

test("the block is plain JS: no JSX, no imports, no exports", () => {
  const block = extract().replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(block, /<[A-Za-z][^>]*\/?>|<\/[A-Za-z]/, "JSX inside the pure block cannot run in node");
  assert.doesNotMatch(block, /^\s*(import|export)\b/m, "the block must be self-contained");
});

test("localISO names the LOCAL day, not the UTC one", () => {
  // 00:30 local on 2026-10-15 is still the 14th in UTC for any zone ahead of it
  // (IST is +5:30). toISOString() would name the wrong day all morning.
  assert.equal(f.localISO(new Date(2026, 9, 15, 0, 30)), "2026-10-15");
  assert.equal(f.localISO(new Date(2026, 0, 5, 23, 59)), "2026-01-05");
  assert.equal(f.shortDate("2026-10-12"), "Oct 12");
});

// ── bars ────────────────────────────────────────────────────────────────────

test("bars: heights scale to the maximum and zero stays zero", () => {
  assert.deepEqual(f.barHeights([0, 50, 100], 40), [0, 20, 40]);
  assert.deepEqual(f.barHeights([218, 0, 109], 56), [56, 0, 28]);
  assert.equal(f.barHeights([5, 5, 5], 30).every((h) => h === 30), true);
});

test("bars: a small positive value is never rounded away; empty and bad input are zeros", () => {
  assert.deepEqual(f.barHeights([1, 1000], 40), [1, 40], "1 of 1000 would round to 0 and vanish: it keeps 1px");
  assert.deepEqual(f.barHeights([0, 0, 0], 40), [0, 0, 0]);
  assert.deepEqual(f.barHeights([], 40), []);
  assert.deepEqual(f.barHeights(null, 40), []);
  assert.deepEqual(f.barHeights([-4, NaN, "x"], 40), [0, 0, 0]);
});

// ── health pills and small helpers ──────────────────────────────────────────

test("health pills: the worst section wins, Workspaces aggregates, nothing failing is hidden", () => {
  const sec = (key, status, fail = 0, accepted = 0) => ({ key, label: key, status, fail, accepted, pass: 1 });
  const { pills, otherFailing } = f.healthPills([
    sec("Delivery", "ok"),
    sec("Discovery integrity", "fail", 2),
    sec("Workspace: A", "ok"),
    sec("Workspace: B", "accepted-only", 0, 3),
    sec("Workspace: C", "ok"),
    sec("Goals", "fail", 1),            // no pill covers it
    sec("Claims", "unknown"),
  ]);
  assert.equal(pills.length, 8);
  const by = Object.fromEntries(pills.map((p) => [p.label, p]));
  assert.equal(by.Delivery.status, "ok");
  assert.equal(by.Discovery.status, "fail");
  assert.equal(by.Discovery.fail, 2);
  assert.equal(by.Workspaces.status, "accepted-only", "one accepted section among oks is accepted-only");
  assert.equal(by.Workspaces.accepted, 3);
  assert.equal(by.Workspaces.count, 3);
  assert.equal(by.Metrics.status, "unknown", "a pill with no section is unknown, with a reason");
  assert.match(by.Metrics.reason, /no such section/);
  assert.deepEqual(otherFailing, ["Goals"], "a failure outside the eight pills is still named");
});

test("small helpers: baseName, agoText, whyNot", () => {
  assert.equal(f.baseName("Vipin Kaushik/…/constitution/NORTH_STAR.md"), "NORTH_STAR.md");
  assert.equal(f.baseName(null), "");
  assert.equal(f.agoText(20_000), "just now");
  assert.equal(f.agoText(4 * 60_000), "4 min ago");
  assert.equal(f.agoText(3 * 3600_000), "3 h ago");
  assert.equal(f.agoText(null), "unknown time");
  assert.equal(f.whyNot(null), "missing from the payload");
  assert.equal(f.whyNot({ status: "none-recorded", reason: "no command records" }), "no command records");
  assert.equal(f.whyNot({ status: "unknown" }), "unknown", "no reason still says WHAT it is, never nothing");
  assert.equal(f.whyNot({ status: "ok" }), null);
});

// The queue bar (2026-10-28): judge / pick a side / blocked, from the payload's own counts.
test("queueParts: percentages sum to exactly 100, zero parts are omitted, order is judge/decide/blocked", () => {
  const parts = f.queueParts({ toJudge: 92, decide: 30, blocked: 40 });
  assert.deepEqual(parts.map((p) => [p.key, p.n]), [["judge", 92], ["decide", 30], ["blocked", 40]]);
  assert.equal(Math.round(parts.reduce((t, p) => t + p.pct, 0) * 10), 1000, "the bar must fill the track exactly");
  const thirds = f.queueParts({ toJudge: 1, decide: 1, blocked: 1 });
  assert.equal(Math.round(thirds.reduce((t, p) => t + p.pct, 0) * 10), 1000, "thirds still sum to 100 (largest remainder)");
  const noDecide = f.queueParts({ toJudge: 3, decide: 0, blocked: 1 });
  assert.deepEqual(noDecide.map((p) => p.key), ["judge", "blocked"], "a zero part is omitted, never a zero-width sliver");
  assert.equal(noDecide.reduce((t, p) => t + p.pct, 0), 100);
});

test("queueParts: empty, zero total, null parts and no worklist all give [] (the caller says why)", () => {
  assert.deepEqual(f.queueParts({ toJudge: 0, decide: 0, blocked: 0 }), []);
  assert.deepEqual(f.queueParts({ toJudge: null, decide: null, blocked: null }), [], "the fix-order join is missing: a partial bar would lie");
  assert.deepEqual(f.queueParts({ toJudge: 5, decide: null, blocked: 2 }), [], "any null part makes the split unknown");
  assert.deepEqual(f.queueParts({}), []);
  assert.deepEqual(f.queueParts(null), []);
});

test("apportion: sums to 100 and survives all zeros", () => {
  assert.deepEqual(f.apportion([0, 0]), [0, 0]);
  assert.equal(Math.round(f.apportion([7, 11, 13, 17, 19]).reduce((a, b) => a + b, 0) * 10), 1000);
});

test("healthSummary: failing are named, unknown named, accepted only counted, uncovered failures carried", () => {
  const sec = (key, status, fail = 0, accepted = 0) => ({ key, label: key, status, fail, accepted, pass: 1 });
  const sm = f.healthSummary([sec("Delivery", "ok"), sec("Discovery integrity", "fail", 2), sec("Workspace: A", "accepted-only", 0, 3), sec("Goals", "fail", 1)]);
  assert.deepEqual(sm.failing.map((p) => p.label), ["Discovery"]);
  assert.equal(sm.accepted, 1);
  assert.deepEqual(sm.otherFailing, ["Goals"]);
  assert.ok(sm.unknown.length >= 1, "pills with no section are can't-tell, not silently ok");
  const clean = f.healthSummary(["Delivery", "Discovery integrity", "Backlog", "Instruction budget", "Workspace: A", "Metrics", "Registers", "Cross-repo"].map((k) => sec(k, "ok")));
  assert.deepEqual([clean.failing.length, clean.unknown.length, clean.accepted, clean.otherFailing.length], [0, 0, 0, 0]);
});

test("sinceText: a local short day, or null when the payload gives no usable time", () => {
  assert.equal(f.sinceText("2026-10-21T12:00:00.000Z"), "Oct 21");
  assert.equal(f.sinceText(null), null);
  assert.equal(f.sinceText(""), null);
  assert.equal(f.sinceText("not a time"), null, "never invent a time");
});

test("rootRoute: a queued root opens Judge on that edge; anything else, or an unsafe id, opens Unblock", () => {
  assert.equal(f.rootRoute({ edge_id: "7c9c9f6c", inQueue: true }), "/judge?edge=7c9c9f6c");
  assert.equal(f.rootRoute({ edge_id: "07e57259", inQueue: false }), "/unblock");
  assert.equal(f.rootRoute({ edge_id: "x';rm -rf ~;'", inQueue: true }), "/unblock", "the id reaches a single-quoted shell arg");
});

test("viewRoute: known views only, safe values URL-encoded, unsafe ones dropped (they reach a quoted shell arg)", () => {
  assert.equal(f.viewRoute("/health", { section: "Workspace:" }), "/health?section=Workspace%3A");
  assert.equal(f.viewRoute("/health", { section: "Instruction budget" }), "/health?section=Instruction%20budget");
  assert.equal(f.viewRoute("/judge", { state: "DRIFTED" }), "/judge?state=DRIFTED");
  assert.equal(f.viewRoute("/judge", { state: "x';rm -rf ~;'" }), "/judge", "an unsafe value is dropped, the view still opens");
  assert.equal(f.viewRoute("/etc/passwd", {}), "/judge", "an unknown view falls back, never passes through");
  assert.equal(f.viewRoute("/unblock"), "/unblock");
});


test("tipLines formats values the card already has; it never invents one", () => {
  assert.equal(f.fmtDay("2026-10-15"), "Thu 15 Oct");
  assert.deepEqual(f.tipLines("state", { label: "drifted", n: 54, total: 90 }),
    { title: "drifted", lines: ["54 edges", "60% of 90 queued", "click to judge these"] });
  assert.deepEqual(f.tipLines("verdicts", { day: "2026-10-14", total: 62, noChange: 45, changed: 17 }),
    { title: "Wed 14 Oct", lines: ["62 verdicts", "17 changed · 45 no change needed"] });
  assert.deepEqual(f.tipLines("verdicts", { day: "2026-10-07", total: 0, noChange: 0, changed: 0 }).lines, ["no verdicts recorded"]);
  assert.deepEqual(f.tipLines("queue", { label: "blocked", n: 40, total: 160, hint: "click to see what blocks them" }),
    { title: "blocked", lines: ["40 edges", "25% of 160 in the queue", "click to see what blocks them"] });
  assert.deepEqual(f.tipLines("pill", { label: "Discovery", status: "fail", fail: 2, accepted: 3, count: 1 }).lines[0], "2 failing checks");
  assert.equal(f.tipLines("state", { label: "x", n: 0, total: 0 }).lines.includes("NaN% of 0 queued"), false, "no NaN on an empty queue");
  assert.equal(f.tipLines("nope", {}), null);
});
