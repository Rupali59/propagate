/**
 * The widget's chart maths, RUN — not read.
 *
 * WHY THIS EXISTS (decision D12). `widget/propagate-queue.jsx` is JSX that node
 * cannot import, so its geometry — donut angles, which calendar cell a day lands
 * in, bar heights — had no test at all. A wrong weekday offset draws a calendar
 * whose every cell is shifted by a day, with correct data, valid SVG and no
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

const NAMES = ["donutArcs", "arcPath", "calendarCells", "barHeights", "stackBars", "dayTicks",
  "healthPills", "localISO", "shortDate", "baseName", "agoText", "whyNot",
  "calendarWeeks", "shouldDrawDays", "recordingSince", "compactPath", "cascadeParts", "rootRoute", "viewRoute"];

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
  for (const n of ["donutArcs", "arcPath", "calendarCells", "barHeights", "stackBars", "dayTicks", "healthPills", "localISO", "shortDate", "baseName", "agoText", "whyNot", "calendarWeeks", "shouldDrawDays", "recordingSince", "compactPath"]) {
    assert.match(outside, new RegExp(`\\b${n}\\(`), `the widget never calls ${n}`);
  }
});

test("the block is plain JS: no JSX, no imports, no exports", () => {
  const block = extract().replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(block, /<[A-Za-z][^>]*\/?>|<\/[A-Za-z]/, "JSX inside the pure block cannot run in node");
  assert.doesNotMatch(block, /^\s*(import|export)\b/m, "the block must be self-contained");
});

// ── donut ───────────────────────────────────────────────────────────────────

test("donut: arc sweeps sum to 360 degrees and proportions are right", () => {
  const { total, arcs } = f.donutArcs({ DRIFTED: 28, REVERSED: 15, DIVERGED: 8, UNMATCHED: 1, other: 0 });
  assert.equal(total, 52);
  assert.deepEqual(arcs.map((a) => a.key), ["DRIFTED", "REVERSED", "DIVERGED", "UNMATCHED"], "zero slices are omitted, order is the family order");
  assert.ok(Math.abs(arcs.reduce((n, a) => n + a.sweepDeg, 0) - 360) < 1e-9, "sweeps must sum to 360");
  assert.ok(Math.abs(arcs[0].sweepDeg - (28 / 52) * 360) < 1e-9, "DRIFTED is 28/52 of the ring");
  // Contiguous, clockwise from 0: each slice starts where the last ended.
  assert.equal(arcs[0].startDeg, 0);
  for (let i = 1; i < arcs.length; i += 1) {
    assert.ok(Math.abs(arcs[i].startDeg - (arcs[i - 1].startDeg + arcs[i - 1].sweepDeg)) < 1e-9, `slice ${i} does not start where slice ${i - 1} ends`);
  }
});

test("donut: a single slice is one full ring, drawn as a closed path", () => {
  const { total, arcs } = f.donutArcs({ DRIFTED: 0, REVERSED: 7, DIVERGED: 0 });
  assert.equal(total, 7);
  assert.equal(arcs.length, 1);
  assert.equal(arcs[0].sweepDeg, 360);
  assert.equal(arcs[0].full, true);
  const d = f.arcPath(64, 64, 50, 0, 360);
  assert.equal((d.match(/A/g) || []).length, 2, "a full ring is two half arcs: one arc with start == end draws nothing");
});

test("donut: an empty or absent population is total 0 with no arcs, never NaN", () => {
  for (const input of [{}, { DRIFTED: 0, REVERSED: 0 }, null, undefined, { DRIFTED: -3, REVERSED: "x" }]) {
    const r = f.donutArcs(input);
    assert.equal(r.total, 0);
    assert.deepEqual(r.arcs, []);
  }
});

test("donut: arcPath starts at 12 o'clock and goes clockwise", () => {
  // A quarter turn from the top must end at 3 o'clock (x = cx + r, y = cy).
  const d = f.arcPath(100, 100, 50, 0, 90);
  assert.match(d, /^M100 50 A50 50 0 0 1 150 100$/);
  assert.match(f.arcPath(100, 100, 50, 0, 270), / 0 1 1 /, "a sweep past 180 degrees sets the large-arc flag");
});

// ── calendar ────────────────────────────────────────────────────────────────

test("calendar: 2026-10-03 lands on its true weekday (Saturday) and the right week column", () => {
  // 2026-10-03 is a Saturday (verified: `date -j -f %Y-%m-%d 2026-10-03 +%A`).
  // Today = Thursday 2026-10-15; its Monday is 2026-10-12, so the 9-week window
  // starts Monday 2026-08-17 and 10-03 sits in the Monday-week of 09-28: column 6.
  const cal = f.calendarCells([{ day: "2026-10-03", count: 12 }], "2026-10-15", 9);
  assert.equal(cal.error, null);
  assert.equal(cal.cols.length, 9);
  assert.equal(cal.firstISO, "2026-08-17");
  assert.equal(cal.lastISO, "2026-10-12");
  const cell = cal.cols.flat().find((c) => c.iso === "2026-10-03");
  assert.ok(cell, "the day is in the window");
  assert.equal(cell.row, 5, "Saturday is row 5 with Monday as row 0");
  assert.equal(cell.col, 6);
  assert.equal(cell.count, 12);
  assert.equal(cell.level, 4, "the only (so busiest) day takes the top level");
  // Every column is a Monday-start week: row 0 is a Monday, row 6 a Sunday.
  for (const col of cal.cols) {
    assert.equal(new Date(col[0].iso + "T00:00:00Z").getUTCDay(), 1, `${col[0].iso} is not a Monday`);
    assert.equal(new Date(col[6].iso + "T00:00:00Z").getUTCDay(), 0, `${col[6].iso} is not a Sunday`);
  }
});

test("calendar: today is in the LAST column at its weekday, and days after it are future", () => {
  const cal = f.calendarCells([], "2026-10-15", 9);   // a Thursday
  const today = cal.cols.flat().filter((c) => c.today);
  assert.equal(today.length, 1);
  assert.equal(today[0].iso, "2026-10-15");
  assert.equal(today[0].col, 8, "today is in the last column");
  assert.equal(today[0].row, 3, "Thursday is row 3");
  const future = cal.cols.flat().filter((c) => c.future).map((c) => c.iso);
  assert.deepEqual(future, ["2026-10-16", "2026-10-17", "2026-10-18"]);
  // A Monday and a Sunday today, the two edges of the week arithmetic.
  assert.equal(f.calendarCells([], "2026-10-12", 9).cols.flat().find((c) => c.today).row, 0);
  assert.equal(f.calendarCells([], "2026-10-18", 9).cols.flat().find((c) => c.today).row, 6);
});

test("calendar: zero-count days are real cells at level 0, not missing ones", () => {
  const cal = f.calendarCells([{ day: "2026-10-14", count: 30 }], "2026-10-15", 9);
  const real = cal.cols.flat().filter((c) => !c.future);
  assert.equal(real.length, 8 * 7 + 4, "eight full weeks plus Mon-Thu of the last: 60 cells drawn");
  const zero = real.filter((c) => c.count === 0);
  assert.ok(zero.length > 50, "the empty days are present");
  assert.ok(zero.every((c) => c.level === 0), "and carry level 0, the baseline");
  assert.equal(cal.cols.flat().length, 63, "no cell is dropped from the grid");
});

test("calendar: intensity scales to the busiest day; outside-window items are COUNTED, not dropped", () => {
  const cal = f.calendarCells([
    { day: "2026-10-14", count: 30 },
    { day: "2026-10-12", count: 15 },
    { day: "2026-10-06", count: 1 },
    { day: "2026-07-01", count: 4 },      // before the window
    { day: "2026-10-30", count: 2 },      // after today (clock skew)
  ], "2026-10-15", 9);
  const by = Object.fromEntries(cal.cols.flat().map((c) => [c.iso, c]));
  assert.equal(by["2026-10-14"].level, 4);
  assert.equal(by["2026-10-12"].level, 2, "15 of 30 is half: ceil(4 * .5) = 2");
  assert.equal(by["2026-10-06"].level, 1, "any non-zero day is at least level 1");
  assert.equal(cal.max, 30);
  assert.equal(cal.outside, 4, "older items are named in the caption, not silently dropped");
  assert.equal(cal.future, 2);
});

test("calendar: month labels sit on the column where the month changes", () => {
  const cal = f.calendarCells([], "2026-10-15", 9);
  assert.deepEqual(cal.months.map((m) => m.label), ["Aug", "Sep", "Oct"]);
  assert.equal(cal.months[0].col, 0);
  assert.equal(cal.cols[cal.months[2].col][0].iso, "2026-10-05", "October first appears on the Monday-week of 10-05 (its Monday-start column)");
});

test("calendar: an unreadable 'today' is an attributable error, not a silently empty grid", () => {
  const cal = f.calendarCells([{ day: "2026-10-03", count: 1 }], "not a date", 9);
  assert.match(cal.error, /not a YYYY-MM-DD date/);
  assert.deepEqual(cal.cols, []);
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

test("stacked bars: the split sums to the total height and keeps both parts visible", () => {
  const bars = f.stackBars([
    { day: "2026-10-03", total: 218, noChange: 163, changed: 55 },
    { day: "2026-10-07", total: 0, noChange: 0, changed: 0 },
    { day: "2026-10-04", total: 62, noChange: 60, changed: 2 },
    { day: "2026-10-10", total: 28, noChange: 0, changed: 28 },
  ], 56);
  assert.equal(bars[0].h, 56);
  assert.equal(bars[0].changedPx + bars[0].noChangePx, 56);
  assert.deepEqual([bars[1].h, bars[1].changedPx, bars[1].noChangePx], [0, 0, 0], "a zero day has no height (the renderer draws a baseline tick)");
  assert.ok(bars[2].changedPx >= 1 && bars[2].noChangePx >= 1, "2 of 62 changed is a thin sliver, not nothing");
  assert.equal(bars[2].changedPx + bars[2].noChangePx, bars[2].h);
  assert.equal(bars[3].noChangePx, 0, "an all-changed day has no light part");
});

test("day ticks: the month name appears on the first bar and on the 1st", () => {
  const t = f.dayTicks([{ day: "2026-09-30" }, { day: "2026-10-01" }, { day: "2026-10-02" }]);
  assert.deepEqual(t, [
    { label: "30", month: "Sep" },
    { label: "1", month: "Oct" },
    { label: "2", month: null },
  ]);
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

// ── revision 3: wide calendar, commands threshold, path labels ──────────────

test("calendar: a wide window (19 weeks) keeps today in the LAST column and months correct", () => {
  const cal = f.calendarCells([{ day: "2026-10-14", count: 3 }], "2026-10-15", 19);
  assert.equal(cal.cols.length, 19);
  assert.equal(cal.lastISO, "2026-10-12");
  assert.equal(cal.firstISO, "2026-06-08", "18 weeks before the Monday of today's week");
  const today = cal.cols.flat().find((c) => c.today);
  assert.equal(today.col, 18, "today is in the last column");
  assert.equal(today.row, 3);
  assert.deepEqual(cal.months.map((m) => m.label), ["Jun", "Jul", "Aug", "Sep", "Oct"]);
  assert.equal(cal.cols.flat().length, 19 * 7, "no cell dropped");
  for (const col of cal.cols) assert.equal(new Date(col[0].iso + "T00:00:00Z").getUTCDay(), 1, "every column starts on a Monday");
});

test("calendarWeeks: whole weeks that fit a stated width, never fewer than one", () => {
  // 340px wide, 16px label gutter, 17px step, 14px cell: (340-16-14)/17 = 18.2 -> 19 columns.
  assert.equal(f.calendarWeeks(340, 16, 17, 14), 19);
  assert.equal(f.calendarWeeks(16 + 14, 16, 17, 14), 1, "exactly one cell wide is one week");
  assert.equal(f.calendarWeeks(10, 16, 17, 14), 1, "a width too small still draws one week, not zero or negative");
  // The drawn width never exceeds the width it was given.
  for (const w of [100, 250, 340, 356, 500]) {
    const n = f.calendarWeeks(w, 16, 15, 13);
    assert.ok(16 + (n - 1) * 15 + 13 <= Math.max(w, 29), `${n} weeks overflow ${w}px`);
  }
});

test("commands: the day chart waits for 3 days with data", () => {
  const day = (n, count) => ({ day: `2026-10-${String(n).padStart(2, "0")}`, count });
  const one = [day(1, 0), day(2, 0), day(3, 27)];
  const two = [day(1, 4), day(2, 0), day(3, 27)];
  const three = [day(1, 4), day(2, 1), day(3, 27)];
  assert.equal(f.shouldDrawDays(one, 3), false, "one day with data is a number, not a chart");
  assert.equal(f.shouldDrawDays(two, 3), false, "two days is still below the threshold");
  assert.equal(f.shouldDrawDays(three, 3), true, "three days is the threshold itself");
  assert.equal(f.shouldDrawDays(three), true, "the default threshold is 3");
  assert.equal(f.shouldDrawDays([], 3), false);
  assert.equal(f.shouldDrawDays(null, 3), false);
  assert.equal(f.shouldDrawDays([day(1, -2), day(2, NaN), day(3, 9)], 1), true, "bad counts are not data; a real one is");
});

test("commands: recordingSince names the first day with data, or null", () => {
  assert.equal(f.recordingSince([{ day: "2026-10-13", count: 0 }, { day: "2026-10-14", count: 2 }, { day: "2026-10-15", count: 9 }]), "2026-10-14");
  assert.equal(f.recordingSince([{ day: "2026-10-13", count: 0 }]), null);
  assert.equal(f.recordingSince(null), null);
});

test("compactPath: short paths are untouched", () => {
  assert.equal(f.compactPath("docs/README.md", 30), "docs/README.md");
  assert.equal(f.compactPath("README.md", 3), "README.md", "a bare filename is never touched");
  assert.equal(f.compactPath(null, 10), "");
});

test("compactPath: directories are elided first, the filename always survives", () => {
  const long = "Vipin Kaushik/hora/acharya/constitution/MASTER_DECISIONS.md";
  const mid = f.compactPath(long, 40);
  assert.ok(mid.endsWith("/MASTER_DECISIONS.md"), mid);
  assert.ok(mid.startsWith("Vipin Kaushik/"), "the first directory is the last to go: " + mid);
  assert.match(mid, /\u2026/, "an elided directory is marked");
  const tight = f.compactPath(long, 28);
  assert.ok(tight.endsWith("MASTER_DECISIONS.md"), tight);
  // Shorter than the filename itself: the FILENAME still wins over the budget.
  const tiny = f.compactPath(long, 5);
  assert.equal(tiny, "\u2026/MASTER_DECISIONS.md", "truncating a filename names nothing, so the budget is exceeded instead");
  // The payload already carries an ellipsis directory; it is not duplicated.
  assert.equal(f.compactPath("Rupali/\u2026/docs/COMPONENTS.md", 10), "\u2026/COMPONENTS.md");
});

// Leverage cascade geometry (direction A, 2026-10-15).
test("cascadeParts: widths sum to exactly 100, zero parts are omitted, ranks follow segments", () => {
  const parts = f.cascadeParts({ segments: [{ edge_id: "a", n: 14 }, { edge_id: "b", n: 6 }, { edge_id: "c", n: 6 }], several: 9, rest: 7, blocked: 42 });
  assert.equal(Math.round(parts.reduce((t, p) => t + p.pct, 0) * 10), 1000, "the bar must fill the track exactly");
  assert.deepEqual(parts.map((p) => p.rank), [1, 2, 3, 0, 0]);
  const noRest = f.cascadeParts({ segments: [{ edge_id: "a", n: 3 }], several: 0, rest: 0, blocked: 3 });
  assert.deepEqual(noRest.map((p) => [p.key, p.pct]), [["a", 100]], "a zero part is omitted, never a zero-width sliver");
  assert.deepEqual(f.cascadeParts({ segments: [], several: 0, rest: 0, blocked: 0 }), []);
  assert.deepEqual(f.cascadeParts(null), []);
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
