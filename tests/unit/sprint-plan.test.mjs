/**
 * sprint-plan.test.mjs — `propagate sprint plan` (propagate#190). Literal fixtures, no network, no real widget:
 * the widget is a stub directory written to a tmpdir and imported through PROPAGATE_USAGE_WIDGET_DIR's mechanism.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { sprintCmd } from "../../cli/sprint.mjs";
import {
  buildSprintPlan,
  calibrate,
  cutList,
  deriveRatio,
  keepOrder,
  parseSamples,
  okFalseRate,
} from "../../lib/report/sprint-plan.mjs";

const NOW = new Date(2026, 10, 10, 10, 0, 0).getTime(); // local Tue 2026-11-10 10:00
const iso = (d) => new Date(d).toISOString();
const RESET = iso(new Date(2026, 10, 15, 12, 30));
const OLD_RESET = iso(new Date(2026, 10, 8, 12, 30));

let widgetDir;
before(() => {
  widgetDir = mkdtempSync(path.join(tmpdir(), "sprint-widget-"));
  const dir = path.join(widgetDir, "src", "collect");
  mkdirSync(dir, { recursive: true });
  // Stubs: the real rule is the widget's. cap 10 flat, 5 used today, baseline = last row before local midnight.
  writeFileSync(path.join(dir, "daily-cap.mjs"), "export const dailyCap = () => ({ cap: 10, flooredCap: 10, basis: 'stub cap 10' });\n");
  writeFileSync(
    path.join(dir, "day-used.mjs"),
    `export function dayUsed(samples, now) {
  const d = new Date(now); d.setHours(0, 0, 0, 0);
  const before = samples.filter((s) => Date.parse(s.t) < d.getTime());
  if (!before.length) return { status: "no-baseline", usedPct: null, latest: null, baseline: null, unattributed: { pct: 0 } };
  return { status: "ok", usedPct: 5, latest: samples[samples.length - 1], baseline: before[before.length - 1], unattributed: { pct: 0 } };
}\n`,
  );
});
after(() => rmSync(widgetDir, { recursive: true, force: true }));

const stubWidget = {
  dailyCap: () => ({ cap: 10, flooredCap: 10, basis: "stub cap 10" }),
  dayUsed: (rows) => {
    const before = rows.filter((s) => Date.parse(s.t) < new Date(2026, 10, 10).getTime());
    return { status: "ok", usedPct: 5, baseline: before[before.length - 1] ?? null, unattributed: { pct: 0 } };
  },
};

const sample = (when, over = {}) => ({
  t: iso(when),
  ok: true,
  week_pct: 30,
  week_resets_at: RESET,
  errors: [],
  ...over,
});
const goodRows = () => [sample(new Date(2026, 10, 9, 23, 0)), sample(new Date(2026, 10, 10, 9, 50))];
const raw = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

// ── board fixtures ──────────────────────────────────────────────────────────

const RL = (remaining = 5000) => ({ graphql: { remaining, limit: 5000 }, core: { remaining: 4000, limit: 5000 } });

function listing(boards) {
  return {
    viewer: {
      projectsV2: {
        totalCount: boards.length,
        nodes: boards.map((b) => ({
          number: b.number,
          title: `Board ${b.number}`,
          closed: false,
          ready: { totalCount: b.ready },
          fields: { nodes: [{}, { name: "Sprint", configuration: { iterations: [{ title: "Sprint 2", startDate: "2026-11-08", duration: 7 }] } }] },
        })),
      },
    },
  };
}
const node = (n, { size = null, tokens = null, labels = [], milestone = null, sprint = "Sprint 2" } = {}) => ({
  content: { number: n, title: `item ${n}`, repository: { nameWithOwner: "o/r" }, milestone: milestone && { title: milestone }, labels: { nodes: labels.map((name) => ({ name })) } },
  fieldValues: {
    nodes: [
      { name: "Ready", field: { name: "Status" } },
      ...(size ? [{ name: size, field: { name: "Size" } }] : []),
      ...(sprint ? [{ title: sprint, startDate: "2026-11-08", duration: 7, field: { name: "Sprint" } }] : []),
      ...(tokens ? [{ number: tokens, field: { name: "Tokens" } }] : []),
    ],
  },
});
const conn = (nodes) => ({ totalCount: nodes.length, nodes });

function fetcher({ boards, ready, done = [], remaining = 5000 }) {
  const f = {
    calls: 0,
    rateLimit: () => RL(remaining),
    graphql: async (q) => {
      f.calls++;
      if (q.includes("projectsV2(first:100)")) return listing(boards);
      const viewer = {};
      for (const b of boards.filter((x) => x.ready > 0)) viewer[`b${b.number}`] = { number: b.number, title: `Board ${b.number}`, ready: conn(ready), done: conn(done) };
      return { viewer };
    },
  };
  return f;
}

/** Done items 100..104 of Size S, each 1,000,000 tokens, and the five lane rows that prove they are lane cost. */
const doneS = (k = 5) => Array.from({ length: k }, (_, i) => node(100 + i, { size: "S", tokens: 1_000_000 }));
const laneRows = (k = 5) =>
  Array.from({ length: k }, (_, i) => ({
    kind: "lane",
    issue: `#${100 + i}`,
    usage: { input: 0, output: 0, cache_create: 0, cache_read: 1_000_000 },
    week_pct: { start: 10, end: 12, delta: 2 },
  }));
const readyS = (k) => Array.from({ length: k }, (_, i) => node(200 + i, { size: "S" }));

const plan = (over = {}) =>
  buildSprintPlan({
    sampleRows: goodRows(),
    now: NOW,
    widget: stubWidget,
    fetcher: fetcher({ boards: [{ number: 7, ready: 3 }], ready: readyS(3), done: doneS() }),
    laneRows: laneRows(),
    ...over,
  });

// ── samples ─────────────────────────────────────────────────────────────────

test("a stale sample is exit 2, and nothing is fetched", async () => {
  const f = fetcher({ boards: [{ number: 7, ready: 1 }], ready: readyS(1) });
  const p = await plan({ sampleRows: [sample(new Date(2026, 10, 10, 2, 0))], fetcher: f });
  assert.equal(p.exit, 2);
  assert.match(p.reason, /older than 6h/);
  assert.equal(f.calls, 0);
});

test("a missing samples file is exit 2 with the reason", async () => {
  const lines = [];
  const prev = process.env.PROPAGATE_SAMPLES_PATH;
  process.env.PROPAGATE_SAMPLES_PATH = path.join(widgetDir, "no-such-samples.jsonl");
  try {
    const code = await sprintCmd(["plan"], { widgetDir, now: NOW, out: (s) => lines.push(s), fetcher: fetcher({ boards: [], ready: [] }), laneRows: [] });
    assert.equal(code, 2);
    assert.match(lines.join("\n"), /no ok:true sample.*\(no samples file\)/);
  } finally {
    if (prev === undefined) delete process.env.PROPAGATE_SAMPLES_PATH;
    else process.env.PROPAGATE_SAMPLES_PATH = prev;
  }
});

test("a week_resets_at boundary inside the measured span is exit 2", async () => {
  const rows = [sample(new Date(2026, 10, 9, 23, 0), { week_resets_at: OLD_RESET }), sample(new Date(2026, 10, 10, 9, 50))];
  const p = await plan({ sampleRows: rows });
  assert.equal(p.exit, 2);
  assert.match(p.reason, /week_resets_at boundary falls inside the measured span/);
});

test("an ok:false rate above 50% is exit 2, and the rate is printed", async () => {
  const rows = [...goodRows(), ...[1, 2, 3].map((m) => sample(new Date(2026, 10, 10, 9, m), { ok: false }))];
  assert.equal(okFalseRate(rows, NOW).failed, 3);
  const p = await plan({ sampleRows: rows });
  assert.equal(p.exit, 2);
  assert.match(p.reason, /ok:false on 3 of 5 runs/);
  const lines = [];
  const code = await sprintCmd(["plan"], { widgetDir, now: NOW, samplesRaw: raw(rows), out: (s) => lines.push(s), fetcher: fetcher({ boards: [], ready: [] }), laneRows: [] });
  assert.equal(code, 2);
  assert.match(lines.join("\n"), /ok:false rate, 7 days: 3 of 5 \(60%\)/);
});

test("the report changes when the samples change: nothing is cached", async () => {
  const at = (pct) => [sample(new Date(2026, 10, 9, 23, 0), { week_pct: pct }), sample(new Date(2026, 10, 10, 9, 50), { week_pct: pct })];
  const a = await plan({ sampleRows: at(30) });
  const b = await plan({ sampleRows: at(80) });
  assert.equal(a.budget.points, 45); // min(70 left, 5 today + 10 * 4 later days)
  assert.equal(b.budget.points, 20); // min(20 left, 45)
});

test("no widget configured is exit 2 with the stated reason, never a guess", async () => {
  const f = fetcher({ boards: [], ready: [] });
  const p = await plan({ widget: null, fetcher: f });
  assert.equal(p.exit, 2);
  assert.match(p.reason, /could not compute \(daily-cap source not configured: set PROPAGATE_USAGE_WIDGET_DIR\)/);
  assert.equal(f.calls, 0);
});

test("the real import path: a fixture widget directory is imported and used", async () => {
  const lines = [];
  const code = await sprintCmd(["plan", "--approvals", "3"], {
    widgetDir,
    now: NOW,
    samplesRaw: raw(goodRows()),
    out: (s) => lines.push(s),
    fetcher: fetcher({ boards: [{ number: 7, ready: 3 }], ready: readyS(3), done: doneS() }),
    laneRows: laneRows(),
  });
  const text = lines.join("\n");
  assert.equal(code, 0, text);
  assert.match(text, /budget: 45 week-% points to 2026-11-14/);
  assert.match(text, /daily cap: stub cap 10/);
  assert.match(text, /rupali approvals: 3/);
  assert.match(text, /concurrent Mac lanes: not derivable yet \(#150\)/);
  assert.match(text, /GraphQL calls made by this command: 2/);
});

// ── demand ──────────────────────────────────────────────────────────────────

test("a Size under 5 items of one basis reads uncalibrated and is counted, not summed", async () => {
  const done = [...doneS(), ...Array.from({ length: 4 }, (_, i) => node(300 + i, { size: "M", tokens: 3_000_000 }))];
  const lanes = [...laneRows(), ...Array.from({ length: 4 }, (_, i) => ({ ...laneRows(1)[0], issue: `#${300 + i}`, usage: { cache_read: 3_000_000 } }))];
  const ready = [...readyS(2), node(400, { size: "M" }), node(401, { size: "M" })];
  const p = await plan({ fetcher: fetcher({ boards: [{ number: 7, ready: 4 }], ready, done }), laneRows: lanes });
  assert.equal(p.calibration.M.status, "uncalibrated");
  assert.match(p.calibration.M.reason, /n=4 lane, n=0/);
  assert.equal(p.demand.uncalibrated.length, 2);
  // ratio = (5*1M + 4*3M tokens) / 18 points; 2 S items at 1M each. The two M items add nothing.
  assert.ok(Math.abs(p.demand.points - 2 * (1_000_000 / (17_000_000 / 18))) < 1e-9);
  assert.equal(p.exit, 2);
  assert.match(p.reason, /cannot judge fit: 2 of 4 Ready items calibrated/);
});

test("mixed bases are never pooled: 3 lane + 3 main-or-unknown is uncalibrated, not n=6", () => {
  const done = [
    ...Array.from({ length: 3 }, (_, i) => ({ number: 100 + i, size: "S", tokens: 1_000_000 })), // in the ledger
    ...Array.from({ length: 3 }, (_, i) => ({ number: 900 + i, size: "S", tokens: 5_000_000 })), // not in the ledger
  ];
  const c = calibrate(done, laneRows(), { tokensPerPct: 500_000 });
  assert.equal(c.S.status, "uncalibrated");
  assert.equal(c.S.n_lane, 3);
  assert.equal(c.S.n_main_or_unknown, 3);
});

test("a ledger row whose tokens differ from the board's Tokens is not lane cost", () => {
  const done = Array.from({ length: 5 }, (_, i) => ({ number: 100 + i, size: "S", tokens: 999 }));
  const c = calibrate(done, laneRows(), { tokensPerPct: 500_000 });
  assert.equal(c.S.n_lane, 0);
  assert.equal(c.S.status, "uncalibrated");
  assert.match(c.S.reason, /main-or-unknown basis only; no tokens-per-week-% ratio/);
});

test("tokens-per-week-% needs 5 usable lane rows; negative deltas are excluded and counted", () => {
  const rows = [...laneRows(4), { ...laneRows(1)[0], week_pct: { delta: -3 } }];
  const r = deriveRatio(rows);
  assert.ok(r.missing);
  assert.equal(r.n, 4);
  assert.equal(r.excluded, 1);
  assert.equal(deriveRatio(laneRows(5)).tokensPerPct, 500_000);
});

test("all-uncalibrated is exit 2: cannot judge fit: 0 of N, never a pass", async () => {
  const p = await plan({ fetcher: fetcher({ boards: [{ number: 7, ready: 3 }], ready: [node(1, { size: "M" }), node(2, { size: "S" }), node(3)], done: [] }), laneRows: [] });
  assert.equal(p.exit, 2);
  assert.equal(p.reason, "cannot judge fit: 0 of 3 Ready items calibrated");
  assert.equal(p.demand.unsized.length, 1);
});

test("calibrated demand inside the budget with nothing uncalibrated is exit 0", async () => {
  const p = await plan();
  assert.equal(p.exit, 0);
  assert.match(p.reason, /fits: 6 points against a budget of 45/);
});

test("over the budget is exit 1 with a cut list that keeps the budgeted prefix", async () => {
  const p = await plan({ fetcher: fetcher({ boards: [{ number: 7, ready: 30 }], ready: readyS(30), done: doneS() }) });
  assert.equal(p.exit, 1);
  assert.equal(p.cut.keep.length, 22); // 22 * 2 = 44 <= 45
  assert.equal(p.cut.cut.length, 8);
});

test("all Ready items count, with the in-Sprint split printed beside them", async () => {
  const ready = [node(1, { size: "S" }), node(2, { size: "S", sprint: null }), node(3, { size: "S", sprint: "Sprint 3" })];
  const p = await plan({ fetcher: fetcher({ boards: [{ number: 7, ready: 3 }], ready, done: doneS() }) });
  assert.equal(p.demand.total, 3);
  assert.equal(p.inSprint, 1);
});

test("needs:* label counts are derived from the Ready items", async () => {
  const ready = [node(1, { size: "S", labels: ["needs:mac"] }), node(2, { size: "S", labels: ["needs:mac", "needs:vm"] })];
  const p = await plan({ fetcher: fetcher({ boards: [{ number: 7, ready: 2 }], ready, done: doneS() }) });
  assert.deepEqual(p.resources.needs, { mac: 2, vm: 1, rupali: 0, github: 0 });
});

// ── the cut list ────────────────────────────────────────────────────────────

test("the cut list follows priority, then milestone, then board, and a smaller item never jumps the queue", () => {
  const it = (id, labels, milestone, board, points) => ({ number: id, labels, milestone, board, points });
  const items = [
    it(1, [], "v1", 2, 1),
    it(2, ["priority:P1"], "v2", 1, 10),
    it(3, ["priority:P0"], null, 9, 10),
    it(4, ["priority:P1"], "v1", 5, 10),
    it(5, ["priority:P1"], "v1", 3, 1),
  ];
  assert.deepEqual(keepOrder(items).map((i) => i.number), [3, 5, 4, 2, 1]);
  // budget 25: 3 (10) + 5 (1) + 4 (10) = 21, then 2 (10) does not fit; item 1 (1 point) would fit but stays cut.
  const { keep, cut } = cutList(items, 25);
  assert.deepEqual(keep.map((i) => i.number), [3, 5, 4]);
  assert.deepEqual(cut.map((i) => i.number), [2, 1]);
});

// ── GraphQL as a resource ───────────────────────────────────────────────────

test("low GraphQL remaining refuses before fetching anything", async () => {
  const f = fetcher({ boards: [{ number: 7, ready: 3 }], ready: readyS(3), remaining: 50 });
  const p = await plan({ fetcher: f });
  assert.equal(p.exit, 2);
  assert.match(p.reason, /below 100; refusing to start \(nothing fetched\)/);
  assert.equal(f.calls, 0);
  assert.equal(p.graphqlCalls, 0);
});

test("remaining below the estimate for the boards found refuses before the item fetch", async () => {
  const boards = [1, 2, 3, 4].map((number) => ({ number, ready: 1 }));
  const f = fetcher({ boards, ready: readyS(1), remaining: 150 });
  const p = await plan({ fetcher: f });
  assert.equal(p.exit, 2);
  assert.match(p.reason, /below the 170 estimated for 4 boards; refusing to fetch items/);
  assert.equal(f.calls, 1);
});

test("parseSamples counts malformed lines and sorts oldest first", () => {
  const r = parseSamples(`${JSON.stringify(sample(new Date(2026, 10, 10, 9)))}\nnot json\n${JSON.stringify(sample(new Date(2026, 10, 9)))}\n`);
  assert.equal(r.malformed, 1);
  assert.ok(Date.parse(r.rows[0].t) < Date.parse(r.rows[1].t));
});

test("--approvals must be a non-negative integer", async () => {
  const errs = [];
  assert.equal(await sprintCmd(["plan", "--approvals", "x"], { err: (s) => errs.push(s) }), 2);
  assert.match(errs.join(), /non-negative integer/);
  assert.equal(await sprintCmd(["nope"], { err: (s) => errs.push(s) }), 2);
});
