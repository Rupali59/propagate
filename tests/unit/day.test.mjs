/**
 * day.test.mjs — `propagate day open` / `day close` (propagate#240). Literal fixtures, a fake fetcher, no network.
 *
 * The safety-flag test (rule:safety-flag-needs-a-test) measures the SIDE EFFECT: the fake board store is snapshotted
 * byte for byte before and after a dry-run close, and the fetcher's write method is counted.
 * Hostile inputs are written out as literals, never through the `item` helper (which can only build valid items):
 * do not tidy them onto it (rule:mutate-behind-the-fixture-builder).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// `day open` writes the dispatch snapshot (propagate#265) under stateDir(); keep every test off the real one.
process.env.PROPAGATE_STATE_DIR = mkdtempSync(path.join(tmpdir(), "day-test-state-"));

import { dayCmd } from "../../cli/day.mjs";
import { buildDayOpen, buildDayClose, renderDayOpen, renderDayClose, hasDoneWhen, countBasis, promotionOrder, readBoards } from "../../lib/report/day.mjs";

const NOW = new Date(2026, 10, 12, 10, 0, 0).getTime(); // local Thu 2026-11-12 10:00
const iso = (d) => new Date(d).toISOString();
const RESET = iso(new Date(2026, 10, 15, 12, 30));
const TODAY_CLOSE = iso(new Date(2026, 10, 12, 8, 0));

// ── goals: one active goal, G1 (parseGoalsFile's shape) ─────────────────────

const goalEntry = (n, over = {}) => ({ n, title: `goal ${n}`, status: "open", active: true, activeSince: "2026-11-09", appetiteWeeks: 4, retros: [], ...over });
const goalsFile = (...entries) => [{ file: "/x/GOALS.md", unread: false, entries }];
const GOALS = goalsFile(goalEntry("G1"));

// ── samples and widget ──────────────────────────────────────────────────────

const sample = (when, pct) => ({ t: iso(when), ok: true, week_pct: pct, week_resets_at: RESET, errors: [] });
// 30 week-% points consumed across the 7 days (10 -> 40).
const goodRows = () => [
  sample(new Date(2026, 10, 6, 12), 10),
  sample(new Date(2026, 10, 9, 12), 20),
  sample(new Date(2026, 10, 11, 12), 30),
  sample(new Date(2026, 10, 12, 9, 50), 40),
];
const widget = (cap = 10, used = 5) => ({
  dailyCap: () => ({ cap, flooredCap: cap, basis: `stub cap ${cap}` }),
  dayUsed: () => ({ status: "ok", usedPct: used, baseline: null, unattributed: { pct: 0 } }),
});

// ── board store and fake fetcher ────────────────────────────────────────────

const OPT = { Backlog: "o-b", Ready: "o-r", "In progress": "o-p", Done: "o-d" };
const boardNode = (number, over = {}) => ({
  id: `P${number}`,
  number,
  title: `Board ${number}`,
  closed: false,
  fields: {
    nodes: [
      {},
      { id: `FS${number}`, name: "Status", options: Object.entries(OPT).map(([name, id]) => ({ id, name })) },
      { id: `FF${number}`, name: "Finished", dataType: "DATE" },
    ],
  },
  items: [],
  ...over,
});
/** A board on GitHub's default Todo / In Progress / Done vocabulary. */
const todoBoard = (number) =>
  boardNode(number, {
    fields: { nodes: [{ id: `FS${number}`, name: "Status", options: [{ id: "t", name: "Todo" }, { id: "i", name: "In Progress" }, { id: "d", name: "Done" }] }] },
  });

/** Valid items only. Hostile cases below are literals. */
const item = (n, { goal = "G1", priority = null, model = null, order = null, status = "Backlog", size = null, body = "", labels = [], itemType = null, state = "OPEN", closedAt = null, finished = null, tokens = null, minutes = null } = {}) => ({
  id: `I${n}`,
  content: { number: n, title: `item ${n}`, body, state, closedAt, repository: { nameWithOwner: "o/r" }, milestone: null, labels: { nodes: labels.map((name) => ({ name })) } },
  fieldValues: {
    nodes: [
      { name: status, field: { name: "Status" } },
      ...(size ? [{ name: size, field: { name: "Size" } }] : []),
      ...(goal ? [{ name: goal, field: { name: "Goal" } }] : []),
      ...(priority ? [{ name: priority, field: { name: "Priority" } }] : []),
      ...(model ? [{ name: model, field: { name: "Model" } }] : []),
      ...(order !== null ? [{ number: order, field: { name: "Order" } }] : []),
      ...(itemType ? [{ name: itemType, field: { name: "Item type" } }] : []),
      ...(finished ? [{ date: finished, field: { name: "Finished" } }] : []),
      ...(tokens !== null ? [{ number: tokens, field: { name: "Tokens" } }] : []),
      ...(minutes !== null ? [{ number: minutes, field: { name: "Minutes" } }] : []),
    ],
  },
});

const stat = (it) => it.fieldValues.nodes.find((v) => v.field?.name === "Status")?.name;
const closed = (it) => it.content.state === "CLOSED";
const PAGE = 100;
/** One page of a group: `after` is the cursor the previous page returned ("c<offset>"), or null for the first. */
const conn = (nodes, after = null) => {
  const start = after === null ? 0 : Number(after.slice(1));
  const end = start + PAGE;
  return {
    totalCount: nodes.length,
    pageInfo: { hasNextPage: end < nodes.length, endCursor: end < nodes.length ? `c${end}` : null },
    nodes: nodes.slice(start, end),
  };
};
/** The items of one board group, by the Status filter dayDetailQuery / dayPageQuery send for it. */
const groupItems = (b, filter) => {
  const s = (n) => b.items.filter((i) => stat(i) === n);
  if (filter === "status:Ready") return s("Ready");
  if (filter === 'status:"In progress"') return s("In progress");
  if (filter === "status:Backlog") return s("Backlog");
  if (filter === "is:closed -status:Done") return b.items.filter((i) => closed(i) && stat(i) !== "Done");
  return s("Done"); // done, and recent (the fake does not filter by date)
};

/** The fake: honours the alias names of dayDetailQuery, applies writes to the store, counts them. */
function fetcher(store, { remaining = 5000, dropWriteFor = null } = {}) {
  const f = {
    writes: [],
    graphqlCalls: 0,
    pageCalls: [], // the follow-up (after:) queries, in order
    rateChecks: 0,
    rateLimit: () => {
      f.rateChecks++;
      return { graphql: { remaining: typeof remaining === "function" ? remaining(f) : remaining, limit: 5000 } };
    },
    graphql: async (q) => {
      f.graphqlCalls++;
      const pg = /projectV2\(number:(\d+)\)\{items\(first:100,after:("(?:[^"\\]|\\.)*"),query:("(?:[^"\\]|\\.)*")\)/.exec(q);
      if (pg) {
        f.pageCalls.push(q);
        const b = store.boards.find((x) => x.number === Number(pg[1]));
        return { viewer: { projectV2: { items: conn(groupItems(b, JSON.parse(pg[3])), JSON.parse(pg[2])) } } };
      }
      if (q.includes("projectsV2(first:100)")) {
        return { viewer: { projectsV2: { totalCount: store.boards.length, nodes: store.boards.map(({ items, ...b }) => b) } } };
      }
      if (q.includes("node(id:")) {
        const out = {};
        [...q.matchAll(/r(\d+):node\(id:"([^"]+)"\)/g)].forEach(([, i, id]) => {
          const it = store.boards.flatMap((b) => b.items).find((x) => x.id === id);
          out[`r${i}`] = it ? { id, fieldValues: it.fieldValues } : null;
        });
        return out;
      }
      const viewer = {};
      for (const m of q.matchAll(/b(\d+):projectV2/g)) {
        const b = store.boards.find((x) => x.number === Number(m[1]));
        viewer[`b${b.number}`] = {
          number: b.number,
          title: b.title,
          ready: conn(groupItems(b, "status:Ready")),
          prog: conn(groupItems(b, 'status:"In progress"')),
          backlog: conn(groupItems(b, "status:Backlog")),
          done: conn(groupItems(b, "status:Done")),
          recent: conn(groupItems(b, "status:Done")),
          stale: conn(groupItems(b, "is:closed -status:Done")),
        };
      }
      return { viewer };
    },
    write: async (mutation) => {
      f.writes.push(mutation);
      for (const m of mutation.matchAll(/itemId:"([^"]+)",fieldId:"([^"]+)",value:\{(singleSelectOptionId|date):"([^"]+)"\}/g)) {
        const [, itemId, , kind, val] = m;
        if (itemId === dropWriteFor) continue; // the fake drops this value
        const it = store.boards.flatMap((b) => b.items).find((x) => x.id === itemId);
        const nodes = it.fieldValues.nodes;
        if (kind === "singleSelectOptionId") {
          const name = Object.keys(OPT).find((k) => OPT[k] === val);
          nodes.find((v) => v.field?.name === "Status").name = name;
        } else {
          const cur = nodes.find((v) => v.field?.name === "Finished");
          if (cur) cur.date = val;
          else nodes.push({ date: val, field: { name: "Finished" } });
        }
      }
      return {};
    },
  };
  return f;
}

const out = () => {
  const lines = [];
  return { lines, fn: (s) => lines.push(s) };
};

// ── open fixtures ───────────────────────────────────────────────────────────

/** Three Finished items in 7 days -> count basis 30 / 3 = 10 points per item. */
const finished3 = () => [
  item(901, { status: "Done", state: "CLOSED", finished: "2026-11-10" }),
  item(902, { status: "Done", state: "CLOSED", finished: "2026-11-11" }),
  item(903, { status: "Done", state: "CLOSED", finished: "2026-11-12" }),
];
const openStore = (ready, extra = []) => ({
  boards: [boardNode(7, { items: [...finished3(), ...ready, ...extra] }), todoBoard(9)],
});
const readyN = (k) => Array.from({ length: k }, (_, i) => item(200 + i, { status: "Ready", size: "S" }));
const open = (store, over = {}) =>
  buildDayOpen({ goalFiles: GOALS, sampleRows: goodRows(), now: NOW, widget: widget(), fetcher: fetcher(store), laneRows: [], ...over });

// ── hasDoneWhen ─────────────────────────────────────────────────────────────

test("hasDoneWhen: the four real forms are true", () => {
  assert.equal(hasDoneWhen("Intro\n\n## Done when\n- a"), true);
  assert.equal(hasDoneWhen("**Done when:**\n- a"), true);
  assert.equal(hasDoneWhen("**Done when**\n- a"), true);
  assert.equal(hasDoneWhen("Epic for the rollout. Done when every sub-issue is closed."), true);
});

test("hasDoneWhen: prose that only discusses the marker is false (workspace-hub#13)", () => {
  // Literals on purpose: a fenced block and an inline span that MENTION the marker without stating one.
  const prose = "The skill checks for `**Done when:**` markers in issue bodies.";
  const fenced = "Example of a marker:\n\n```md\n**Done when:**\n- x\n```\n\nThat is all.";
  const both = prose + "\n\n" + fenced;
  assert.equal(hasDoneWhen(prose), false);
  assert.equal(hasDoneWhen(fenced), false);
  assert.equal(hasDoneWhen(both), false);
  assert.equal(hasDoneWhen(""), false);
  assert.equal(hasDoneWhen(null), false);
});

// ── day open ────────────────────────────────────────────────────────────────

test("open: short fixture is exit 1 'short by ~N points' and lists a promotable Backlog item", async () => {
  const store = openStore([], [item(300, { status: "Backlog", size: "S", body: "## Done when\nx" })]);
  const r = await open(store);
  assert.equal(r.exit, 1);
  assert.equal(r.verdict, "short");
  assert.match(r.reason, /short by ~5 points/);
  assert.deepEqual(r.fill.map((f) => f.ref), ["o/r#300"]);
  assert.match(r.basis.label, /count basis \(derived: 30 pts \/ 3 items, 7 d\)/);
});

test("open: enough fixture is exit 0", async () => {
  const r = await open(openStore(readyN(1))); // 10 points against a budget of 5: within 2x
  assert.equal(r.exit, 0);
  assert.equal(r.verdict, "enough");
});

test("open: over fixture is exit 1 and names what will not fit", async () => {
  const r = await open(openStore(readyN(3))); // 30 points against 5
  assert.equal(r.exit, 1);
  assert.equal(r.verdict, "over");
  assert.ok(r.cut.items.length >= 1);
});

test("open: carry-over In progress and Ready with no Size are listed", async () => {
  const store = openStore([item(210, { status: "Ready" })], [item(211, { status: "In progress", size: "S" })]);
  const r = await open(store);
  assert.deepEqual(r.inProgress.map((i) => i.ref), ["o/r#211"]);
  assert.deepEqual(r.readyNoSize.map((i) => i.ref), ["o/r#210"]);
});

test("open: no good sample is exit 2 with a reason, and nothing is fetched", async () => {
  const f = fetcher(openStore(readyN(1)));
  const r = await buildDayOpen({ sampleRows: [], now: NOW, widget: widget(), fetcher: f, laneRows: [] });
  assert.equal(r.exit, 2);
  assert.match(r.reason, /no ok:true sample/);
  assert.equal(f.graphqlCalls, 0);
});

test("open: uncalibrated items with no Finished item in 7 days is exit 2 'cannot judge'", async () => {
  const store = { boards: [boardNode(7, { items: readyN(2) })] }; // no Done items at all
  const r = await open(store);
  assert.equal(r.exit, 2);
  assert.match(r.reason, /cannot judge/);
  assert.match(r.reason, /no item has a Finished date/);
});

test("open: no sample span for the count basis is exit 2", async () => {
  const r = await open(openStore(readyN(1)), { sampleRows: [sample(new Date(2026, 10, 12, 9, 50), 40)] });
  assert.equal(r.exit, 2);
  assert.match(r.reason, /no sample span/);
});

test("open: a board on Todo / In Progress / Done is named and skipped, never guessed", async () => {
  const r = await open(openStore(readyN(1)));
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].number, 9);
  assert.match(r.skipped[0].why, /Backlog, Ready/);
});

test("open: 0 open boards is exit 2 'gone blind', not 'nothing to do'", async () => {
  const r = await open({ boards: [] });
  assert.equal(r.exit, 2);
  assert.match(r.reason, /gone blind/);
});

test("open: an item that comes back with no field values is exit 2 'gone blind'", async () => {
  // Literal: a valid-item builder cannot express this.
  const hostile = { id: "IX", content: { number: 5, title: "x", state: "OPEN", repository: { nameWithOwner: "o/r" }, labels: { nodes: [] } }, fieldValues: { nodes: [] } };
  const store = { boards: [boardNode(7, { items: [] })] };
  const f = fetcher(store);
  const orig = f.graphql;
  f.graphql = async (q) => {
    const d = await orig(q);
    if (d.viewer?.b7) d.viewer.b7.ready = conn([hostile]);
    return d;
  };
  const r = await buildDayOpen({ sampleRows: goodRows(), now: NOW, widget: widget(), fetcher: f, laneRows: [] });
  assert.equal(r.exit, 2);
  assert.match(r.reason, /gone blind/);
});

test("open: low rate limit refuses before fetching", async () => {
  const f = fetcher(openStore(readyN(1)), { remaining: 10 });
  const r = await buildDayOpen({ sampleRows: goodRows(), now: NOW, widget: widget(), fetcher: f, laneRows: [] });
  assert.equal(r.exit, 2);
  assert.equal(f.graphqlCalls, 0);
});

test("countBasis derives points per finished item", () => {
  const b = countBasis(goodRows(), [{ repo: "o/r", number: 1, finished: "2026-11-11" }, { repo: "o/r", number: 2, finished: "2026-11-12" }], NOW);
  assert.equal(b.perItem, 15);
});

test("promotionOrder: priority label, then smaller Size, then lower number", () => {
  const o = promotionOrder([
    { number: 5, size: "S", labels: [] },
    { number: 4, size: "XL", labels: ["priority:P1"] },
    { number: 3, size: "M", labels: ["priority:P1"] },
    { number: 2, size: "XS", labels: ["priority:P0"] },
    { number: 1, size: "S", labels: [] },
  ]);
  assert.deepEqual(o.map((x) => x.number), [2, 3, 4, 1, 5]);
});

// ── day close ───────────────────────────────────────────────────────────────

/** Every proposal kind (a)-(e) on one board. */
const closeStore = () => ({
  boards: [
    boardNode(7, {
      items: [
        item(1, { status: "Backlog", size: "S", body: "## Done when\n- x" }), // (a) promote
        item(2, { status: "Backlog", size: "M", body: "no condition stated here" }), // (b) refused: missing Done when
        item(3, { status: "Backlog", body: "**Done when:** x" }), // (b) refused: missing Size
        item(4, { status: "Ready", state: "CLOSED", closedAt: TODAY_CLOSE }), // (c) closed, not Done; (d) tokens/minutes
        item(5, { status: "Done", state: "CLOSED", closedAt: TODAY_CLOSE, finished: "2026-11-12", tokens: 100 }), // (d) minutes
        item(6, { status: "In progress", size: "S" }), // (e)
        item(7, { status: "Backlog", size: "S", body: "Done when x.", itemType: "Epic" }), // never startable
      ],
    }),
  ],
});
const close = (store, over = {}) =>
  buildDayClose({ goalFiles: GOALS, sampleRows: goodRows(), now: NOW, widget: widget(), fetcher: fetcher(store), ...over });

test("close: proposes every kind (a)-(e) and the summary line", async () => {
  const r = await close(closeStore());
  assert.equal(r.exit, 0);
  assert.deepEqual(r.promote.map((p) => p.ref), ["o/r#1"]);
  assert.deepEqual(r.refused.map((p) => [p.ref, p.missing]).sort(), [["o/r#2", "Done when"], ["o/r#3", "Size"]]);
  assert.deepEqual(r.closeFix.map((p) => [p.ref, p.finished]), [["o/r#4", "2026-11-12"]]);
  assert.deepEqual(r.costGaps.map((g) => [g.ref, g.missing]).sort(), [["o/r#4", ["Tokens", "Minutes"]], ["o/r#5", ["Minutes"]]]);
  assert.deepEqual(r.inProgress.map((p) => p.ref), ["o/r#6"]);
  assert.equal(r.doneToday, 2);
  assert.deepEqual(r.usage, { used: 5, cap: 10 });
});

test("close WITHOUT --apply: zero write calls and the board data is byte-identical (every proposal kind present)", async () => {
  const store = closeStore();
  const f = fetcher(store);
  const before = JSON.stringify(store);
  const r = await buildDayClose({ goalFiles: GOALS, sampleRows: goodRows(), now: NOW, widget: widget(), fetcher: f, apply: false });
  assert.ok(r.operations.length > 0, "the fixture must have proposed writes, or this test proves nothing");
  assert.equal(f.writes.length, 0, "no write call without --apply");
  assert.equal(JSON.stringify(store), before, "the board data must be byte-identical");
  // and through the CLI, with the flag absent
  const o = out();
  const store2 = closeStore();
  const f2 = fetcher(store2);
  const before2 = JSON.stringify(store2);
  const code = await dayCmd(["close"], { goalFiles: GOALS, out: o.fn, now: NOW, fetcher: f2, samplesRaw: goodRows().map((x) => JSON.stringify(x)).join("\n"), widget: widget(), laneRows: [] });
  assert.equal(code, 0);
  assert.equal(f2.writes.length, 0);
  assert.equal(JSON.stringify(store2), before2);
});

test("close WITH --apply: writes only (a) and (c), then reads back MATCH n/n", async () => {
  const store = closeStore();
  const f = fetcher(store);
  const r = await buildDayClose({ goalFiles: GOALS, sampleRows: goodRows(), now: NOW, widget: widget(), fetcher: f, apply: true });
  assert.equal(r.exit, 0);
  assert.deepEqual([...r.writes].sort(), ["o/r#1: Status -> Ready", "o/r#4: Finished = 2026-11-12", "o/r#4: Status -> Done"]);
  assert.deepEqual(r.readBack, { matched: 2, total: 2, mismatches: [] });
  assert.match(r.reason, /MATCH 2\/2/);
  const by = (n) => store.boards[0].items.find((i) => i.content.number === n);
  assert.equal(stat(by(1)), "Ready");
  assert.equal(stat(by(4)), "Done");
  for (const n of [2, 3, 5, 6, 7]) assert.notEqual(stat(by(n)), "Ready", `item ${n} was not promoted`);
  assert.equal(by(5).fieldValues.nodes.some((v) => v.field.name === "Minutes"), false, "cost gaps are never filled");
});

test("close --apply: writes are batched 20 per request", async () => {
  const items = Array.from({ length: 25 }, (_, i) => item(500 + i, { status: "Ready", state: "CLOSED", closedAt: TODAY_CLOSE }));
  const store = { boards: [boardNode(7, { items })] };
  const f = fetcher(store);
  const r = await buildDayClose({ goalFiles: GOALS, sampleRows: goodRows(), now: NOW, widget: widget(), fetcher: f, apply: true });
  assert.equal(r.exit, 0);
  assert.equal(f.writes.length, 3); // 50 ops: 20 + 20 + 10
  assert.deepEqual(f.writes.map((w) => (w.match(/updateProjectV2ItemFieldValue/g) ?? []).length), [20, 20, 10]);
  assert.deepEqual(r.readBack, { matched: 25, total: 25, mismatches: [] });
});

test("close --apply: a fake that drops one value on read-back is exit 1 naming the item", async () => {
  const store = closeStore();
  const f = fetcher(store, { dropWriteFor: "I4" });
  const r = await buildDayClose({ goalFiles: GOALS, sampleRows: goodRows(), now: NOW, widget: widget(), fetcher: f, apply: true });
  assert.equal(r.exit, 1);
  assert.equal(r.readBack.matched, 1);
  assert.deepEqual(r.readBack.mismatches.map((m) => m.ref), ["o/r#4"]);
  assert.match(r.reason, /o\/r#4/);
});

test("close: Ready refusal names an item with Size but no Done when, and one with Done when but no Size", async () => {
  const r = await close(closeStore());
  const byRef = Object.fromEntries(r.refused.map((x) => [x.ref, x.missing]));
  assert.equal(byRef["o/r#2"], "Done when");
  assert.equal(byRef["o/r#3"], "Size");
  assert.ok(!r.promote.some((p) => ["o/r#2", "o/r#3"].includes(p.ref)));
});

test("close: a block/question label and an Epic are never promoted or refused", async () => {
  // Literal: hostile label written out by hand.
  const blocked = { id: "IB", content: { number: 60, title: "b", body: "Done when x.", state: "OPEN", repository: { nameWithOwner: "o/r" }, labels: { nodes: [{ name: "question" }] } }, fieldValues: { nodes: [{ name: "Backlog", field: { name: "Status" } }, { name: "S", field: { name: "Size" } }] } };
  const store = { boards: [boardNode(7, { items: [blocked, item(61, { status: "Backlog", size: "S", body: "Done when x.", itemType: "Epic" })] })] };
  const r = await close(store);
  assert.deepEqual(r.promote, []);
  assert.deepEqual(r.refused, []);
});

test("close: tops up to 3 Ready per board", async () => {
  const items = [
    item(10, { status: "Ready", size: "S" }),
    item(11, { status: "Ready", size: "S" }),
    ...[20, 21, 22].map((n) => item(n, { status: "Backlog", size: "S", body: "## Done when\nx" })),
  ];
  const r = await close({ boards: [boardNode(7, { items })] });
  assert.deepEqual(r.promote.map((p) => p.ref), ["o/r#20"]);
});

test("close: 0 open boards is exit 2 'gone blind' and no write", async () => {
  const f = fetcher({ boards: [] });
  const r = await buildDayClose({ goalFiles: GOALS, sampleRows: goodRows(), now: NOW, widget: widget(), fetcher: f, apply: true });
  assert.equal(r.exit, 2);
  assert.match(r.reason, /gone blind/);
  assert.equal(f.writes.length, 0);
});

test("close: an item with no field values is exit 2 'gone blind' and no write, even with --apply", async () => {
  const hostile = { id: "IX", content: { number: 5, title: "x", state: "OPEN", repository: { nameWithOwner: "o/r" }, labels: { nodes: [] } }, fieldValues: { nodes: [] } };
  const store = closeStore();
  const f = fetcher(store);
  const orig = f.graphql;
  f.graphql = async (q) => {
    const d = await orig(q);
    if (d.viewer?.b7) d.viewer.b7.backlog = conn([hostile]);
    return d;
  };
  const r = await buildDayClose({ goalFiles: GOALS, sampleRows: goodRows(), now: NOW, widget: widget(), fetcher: f, apply: true });
  assert.equal(r.exit, 2);
  assert.match(r.reason, /gone blind/);
  assert.equal(f.writes.length, 0);
});

test("close: a closed item with Status unset (no field values) is NOT blindness; it is moved to Done", async () => {
  // Literal, from the real boards (kirtik-website#127): matches `is:closed -status:Done`, has no field values.
  const bare = { id: "IBARE", content: { number: 127, title: "bare", body: "", state: "CLOSED", closedAt: TODAY_CLOSE, repository: { nameWithOwner: "o/r" }, labels: { nodes: [] } }, fieldValues: { nodes: [] } };
  const store = { boards: [boardNode(7, { items: [] })] };
  const f = fetcher(store);
  const orig = f.graphql;
  f.graphql = async (q) => {
    const d = await orig(q);
    if (d.viewer?.b7) d.viewer.b7.stale = conn([bare]);
    return d;
  };
  const r = await buildDayClose({ goalFiles: GOALS, sampleRows: goodRows(), now: NOW, widget: widget(), fetcher: f });
  assert.equal(r.exit, 0);
  assert.deepEqual(r.closeFix.map((c) => [c.ref, c.from]), [["o/r#127", "no status"]]);
});

test("dayCmd: usage and unknown flags are exit 2; --apply is refused on open", async () => {
  const e = [];
  assert.equal(await dayCmd([], { err: (s) => e.push(s) }), 2);
  assert.equal(await dayCmd(["open", "--apply"], { err: (s) => e.push(s) }), 2);
  assert.equal(await dayCmd(["close", "--bogus"], { err: (s) => e.push(s) }), 2);
});

// ── goal-aware promotion and the per-goal block (propagate#240) ─────────────
// Guard fixtures below are LITERAL items, never built through `item`: the builder defaults Goal to an active goal and
// can only make valid items, which is exactly what these refusals must not depend on. Do not tidy them onto it
// (rule:mutate-behind-the-fixture-builder).

const lit = (id, n, goalValue) => ({
  id,
  content: { number: n, title: `lit ${n}`, body: "## Done when\n- x", state: "OPEN", closedAt: null, repository: { nameWithOwner: "o/r" }, milestone: null, labels: { nodes: [] } },
  fieldValues: {
    nodes: [
      { name: "Backlog", field: { name: "Status" } },
      { name: "S", field: { name: "Size" } },
      ...(goalValue === undefined ? [] : [{ name: goalValue, field: { name: "Goal" } }]),
    ],
  },
});
const parked = lit("LP", 71, "Parked");
const idea = lit("LI", 72, "idea"); // case-insensitive
const noGoal = lit("LN", 73, undefined);
const inactive = lit("LX", 74, "G9"); // a G-id no active goal carries
const goodLit = lit("LG", 75, "G1");

test("close: a Parked, an Idea, a Goal-less and an inactive-G-id item are each refused with the reason named, and never promoted", async () => {
  const store = { boards: [boardNode(7, { items: [parked, idea, noGoal, inactive, goodLit] })] };
  const r = await close(store);
  assert.deepEqual(r.promote.map((p) => p.ref), ["o/r#75"]);
  const by = Object.fromEntries(r.refused.map((x) => [x.ref, x.missing]));
  assert.equal(by["o/r#71"], "Goal is Parked, not an active goal");
  assert.equal(by["o/r#72"], "Goal is idea, not an active goal");
  assert.equal(by["o/r#73"], "no Goal");
  assert.equal(by["o/r#74"], "Goal is G9, not an active goal");
});

test("close: a goal gap is named beside a Size or Done when gap", async () => {
  const lacking = { ...lit("LD", 76, "Parked"), content: { ...lit("LD", 76, "x").content, body: "no condition" } };
  const r = await close({ boards: [boardNode(7, { items: [lacking] })] });
  assert.deepEqual(r.refused.map((x) => x.missing), ["Done when; Goal is Parked, not an active goal"]);
});

test("close: no goal read SKIPS promotions with a warning; closed -> Done and the cost gaps still run (Rupali: skip with warning)", async () => {
  for (const goalFiles of [null, [], [{ file: "/x/GOALS.md", unread: true, entries: [], reason: "unreadable" }], goalsFile(goalEntry("G1", { active: false }))]) {
    const store = closeStore(); // would promote item 1 and close item 4 if goals were read
    const r = await buildDayClose({ goalFiles, sampleRows: goodRows(), now: NOW, widget: widget(), fetcher: fetcher(store) });
    assert.notEqual(r.exit, 2, "a skipped promotion is a warning, not a could-not-judge");
    assert.match(r.promotionsSkipped ?? "", /no active goal was read/);
    assert.deepEqual(r.promote, []);
    assert.ok(r.closeFix.length >= 1, "closed -> Done must still be proposed without goals");
    assert.ok(!r.refused.some((x) => /no active goal/.test(x.missing)), "the skip is one warning, not a refusal per item");
    assert.match(renderDayClose(r).slice(0, 2).join("\n"), /WARNING: promotions skipped/, "the warning is printed first");
  }
});

test("close --apply with no goal read writes the Done fix and never a promotion", async () => {
  const store = closeStore();
  const f = fetcher(store);
  const r = await buildDayClose({ goalFiles: [], sampleRows: goodRows(), now: NOW, widget: widget(), fetcher: f, apply: true });
  assert.deepEqual(r.promote, []);
  assert.ok(f.writes.length >= 1, "the Done fix is written");
  assert.ok(!f.writes.join("\n").includes("Status -> Ready") && !r.writes.some((w) => /Ready/.test(w.what ?? "")), "no promotion is written");
});

test("dayCmd close: no active goal read prints the warning and does not exit 2", async () => {
  const o = out();
  const code = await dayCmd(["close"], { goalFiles: [], out: o.fn, now: NOW, fetcher: fetcher(closeStore()), samplesRaw: goodRows().map((x) => JSON.stringify(x)).join("\n"), widget: widget(), laneRows: [] });
  assert.notEqual(code, 2);
  assert.match(o.lines.join("\n"), /WARNING: promotions skipped/);
});

test("open: an unread goal source offers no promotable Backlog item (fail closed there too)", async () => {
  const store = openStore([], [item(300, { status: "Backlog", size: "S", body: "## Done when\nx" })]);
  const r = await open(store, { goalFiles: [] });
  assert.equal(r.verdict, "short");
  assert.deepEqual(r.fill, []);
});

test("promotionOrder: Order first (unordered last), then Priority field P0..P3, then label rank, then Size, then number", () => {
  // Literals on purpose.
  const o = promotionOrder([
    { number: 1, size: "XS", labels: ["priority:P0"], fields: {} }, // unordered: after every ordered item
    { number: 2, size: "XL", labels: [], fields: { Order: 2, Priority: "P3" } },
    { number: 3, size: "XL", labels: [], fields: { Order: 1, Priority: "P3" } },
    { number: 4, size: "S", labels: [], fields: { Priority: "P1" } },
    { number: 5, size: "S", labels: [], fields: { Priority: "P0" } },
    { number: 6, size: "S", labels: ["priority:P0"], fields: { Priority: "P1" } }, // field P1, label P0: beats #4 on the label tie-break
    { number: 7, size: "S", labels: [], fields: {} },
  ]);
  assert.deepEqual(o.map((x) => x.number), [3, 2, 5, 6, 4, 1, 7]);
});

const readyOf = (k, extra = {}) => item(k, { status: "Ready", size: "S", goal: "G1", ...extra });
const goalStore = () => ({
  boards: [
    boardNode(7, {
      items: [
        ...finished3(),
        readyOf(210, { order: 2, priority: "P2", model: "Haiku" }),
        readyOf(211, { order: 1, priority: "P1", model: "Sonnet" }),
        readyOf(212, { priority: "P0" }), // Ready with no Order: after the ordered ones
        item(213, { status: "Ready", size: "M", goal: "Parked", model: "Opus" }), // not under an active goal
        item(214, { status: "Ready", size: "M", goal: null }), // no Goal at all
        item(215, { status: "In progress", size: "S", goal: "G1" }),
        item(216, { status: "Backlog", goal: "G1" }),
        item(217, { status: "Backlog", goal: "G1" }),
        item(218, { status: "Backlog", goal: "G2" }), // a different goal: not counted under G1
      ],
    }),
    todoBoard(9),
  ],
});

test("open: one block per active goal with counts, Ready by Order with Model, and the not-under-an-active-goal line", async () => {
  const r = await open(goalStore(), { goalFiles: goalsFile(goalEntry("G1", { title: "First goal" }), goalEntry("G2", { title: "Second", appetiteWeeks: null })) });
  assert.equal(r.goalBlocks.length, 2);
  const g1 = r.goalBlocks[0];
  assert.deepEqual(g1.counts, {
    prog: { n: 1, atLeast: false },
    ready: { n: 3, atLeast: false },
    backlog: { n: 2, atLeast: false },
    done: { n: 3, atLeast: false }, // the three finished3() items carry the builder default Goal G1
  });
  assert.deepEqual(g1.readyByOrder.map((i) => [i.order, i.priority, i.model, i.ref]), [
    [1, "P1", "Sonnet", "o/r#211"],
    [2, "P2", "Haiku", "o/r#210"],
    [null, "P0", null, "o/r#212"],
  ]);
  assert.deepEqual(r.readyNotUnderActiveGoal.map((i) => i.ref), ["o/r#213", "o/r#214"]);
  assert.equal(r.goalBlocks[1].counts.backlog.n, 1);
  const text = renderDayOpen(r).join("\n");
  assert.match(text, /G1 · First goal\s+appetite: 4 weeks from 2026-11-09, 25 days left/);
  assert.match(text, /G2 · Second\s+no appetite recorded/);
  assert.match(text, /In progress 1 · Ready 3 · Backlog 2 · Done 3/);
  assert.match(text, /Ready by Order:\n\s+1  P1  Sonnet  S  o\/r#211/);
  assert.match(text, /–  P0  –  S  o\/r#212/);
  assert.match(text, /not under an active goal: 2 Ready item\(s\): o\/r#213, o\/r#214/);
  assert.match(text, /goals: /); // the existing goals summary line is still there
});

test("open: a truncated Done group prints as an at-least count, never a total", async () => {
  const store = goalStore();
  store.boards[0].items.push(item(220, { status: "Done", state: "CLOSED", goal: "G1", finished: "2026-11-11" }));
  const f = fetcher(store);
  const orig = f.graphql;
  f.graphql = async (q) => {
    const d = await orig(q);
    if (d.viewer?.b7) d.viewer.b7.done = { totalCount: 250, nodes: d.viewer.b7.done.nodes }; // 250 exist, the nodes hold fewer
    return d;
  };
  const r = await open(store, { fetcher: f });
  assert.equal(r.goalBlocks[0].counts.done.atLeast, true);
  assert.match(renderDayOpen(r).join("\n"), /Done ≥4\b/);
  assert.doesNotMatch(renderDayOpen(r).join("\n"), /Done 4\b/);
});

test("open: the per-goal block makes no GraphQL call of its own (call count unchanged with goalFiles)", async () => {
  const f1 = fetcher(goalStore());
  const f2 = fetcher(goalStore());
  const without = await buildDayOpen({ sampleRows: goodRows(), now: NOW, widget: widget(), fetcher: f1, laneRows: [] });
  const withGoals = await buildDayOpen({ goalFiles: goalsFile(goalEntry("G1"), goalEntry("G2")), sampleRows: goodRows(), now: NOW, widget: widget(), fetcher: f2, laneRows: [] });
  assert.ok(f1.graphqlCalls >= 2, "the baseline must have made the listing and detail reads");
  assert.equal(f2.graphqlCalls, f1.graphqlCalls);
  assert.equal(withGoals.graphqlCalls, without.graphqlCalls);
  assert.ok(withGoals.goalBlocks.length === 2, "and the blocks were built");
});

// ── the dispatch snapshot (propagate#265) ───────────────────────────────────

test("day open writes <stateDir>/day/items.json from the read it already did: no extra GraphQL call", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "day-snap-"));
  process.env.PROPAGATE_STATE_DIR = dir;
  const store = openStore([
    item(200, { status: "Ready", size: "S", model: "Sonnet", goal: "G1" }),
    item(201, { status: "Backlog", goal: "G1" }),
  ]);
  const f = fetcher(store);
  const r = await buildDayOpen({ goalFiles: GOALS, sampleRows: goodRows(), now: NOW, widget: widget(), fetcher: f, laneRows: [] });
  assert.equal(f.graphqlCalls, 2, "one listing read and one detail read, exactly what day open did before the snapshot");
  assert.equal(r.graphqlCalls, f.graphqlCalls);
  const snap = JSON.parse(readFileSync(path.join(dir, "day", "items.json"), "utf8"));
  assert.equal(snap.generatedAt, new Date(NOW).toISOString());
  assert.deepEqual(snap.items["o/r#200"], {
    model: "Sonnet",
    goal: "G1",
    status: "Ready",
    projectId: "P7",
    itemId: "I200",
    statusFieldId: "FS7",
    inProgressOptionId: "o-p",
  });
  assert.equal(snap.items["o/r#201"].status, "Backlog");
  assert.equal(snap.items["o/r#201"].model, null, "an unset Model is null, not a guess");
  assert.ok(snap.items["o/r#901"], "Done items are covered too");
  assert.deepEqual(readdirSync(path.join(dir, "day")), ["items.json"], "the temp file was renamed away");
  process.env.PROPAGATE_STATE_DIR = mkdtempSync(path.join(tmpdir(), "day-test-state-"));
});

test("a snapshot write failure becomes a note and never fails day open", async () => {
  const blocker = path.join(mkdtempSync(path.join(tmpdir(), "day-snap-")), "afile");
  writeFileSync(blocker, "x");
  process.env.PROPAGATE_STATE_DIR = blocker; // a file where a directory is needed
  const r = await open(openStore(readyN(3)));
  assert.notEqual(r.exit, 2, `day open must still judge: ${r.reason}`);
  assert.ok(r.notes.some((n) => /dispatch snapshot not written/.test(n)), `notes: ${JSON.stringify(r.notes)}`);
  process.env.PROPAGATE_STATE_DIR = mkdtempSync(path.join(tmpdir(), "day-test-state-"));
});

// ── paging: a group longer than 100 is read in full, up to 10 pages ─────────

const backlogN = (k) => Array.from({ length: k }, (_, i) => item(1000 + i, { status: "Backlog", size: "S" }));
/** readBoards with its own call counter, the way day open / day close count GraphQL calls. */
const readPaged = async (nItems, fopts = {}) => {
  const f = fetcher({ boards: [boardNode(7, { items: backlogN(nItems) })] }, fopts);
  let calls = 0;
  const read = await readBoards({ fetcher: f, now: NOW, count: () => calls++ });
  return { f, read, calls };
};

test("paging: a 250-item Backlog is read in full, with no truncated entry and exactly 2 follow-up calls, counted", async () => {
  const { f, read, calls } = await readPaged(250);
  assert.equal(read.stop, undefined, read.stop);
  const items = read.byBoard.get(7).backlog;
  assert.equal(items.length, 250);
  assert.deepEqual(items.map((i) => i.number), backlogN(250).map((i) => i.content.number), "pages are appended in order, none repeated");
  assert.deepEqual(read.truncated, []);
  assert.equal(f.pageCalls.length, 2);
  assert.match(f.pageCalls[0], /after:"c100"/);
  assert.match(f.pageCalls[1], /after:"c200"/);
  assert.match(f.pageCalls[0], /query:"status:Backlog"/, "the follow-up carries the group's own filter");
  assert.equal(calls, 2 + 2, "listing + detail + 2 follow-ups");
  assert.equal(calls, f.graphqlCalls, "the counted calls are the calls made");
});

test("paging: a day open over a 250-item Backlog prints the true call count and no truncation note", async () => {
  const f = fetcher({ boards: [boardNode(7, { items: [...finished3(), ...backlogN(250)] })] });
  const r = await buildDayOpen({ goalFiles: GOALS, sampleRows: goodRows(), now: NOW, widget: widget(), fetcher: f, laneRows: [] });
  assert.equal(r.graphqlCalls, f.graphqlCalls);
  assert.equal(f.pageCalls.length, 2);
  assert.ok(!r.notes.some((n) => /truncated/.test(n)), JSON.stringify(r.notes));
});

test("paging: a 1,050-item group hits the 10-page cap: 1,000 read, truncated names 1000 of 1050", async () => {
  const { f, read, calls } = await readPaged(1050);
  assert.equal(read.byBoard.get(7).backlog.length, 1000);
  assert.deepEqual(read.truncated, ["board 7 backlog: 1000 of 1050"]);
  assert.equal(f.pageCalls.length, 9, "10 pages per group, the first included");
  assert.equal(calls, 2 + 9);
});

test("paging: remaining below MIN_RATE_LIMIT before page 2 stops paging with a note, not a failure; the truncation stays", async () => {
  const { f, read } = await readPaged(250, { remaining: (fx) => (fx.rateChecks <= 1 ? 5000 : 50) });
  assert.equal(read.stop, undefined, "a low rate limit while paging is never a failure");
  assert.equal(f.pageCalls.length, 0);
  assert.equal(read.byBoard.get(7).backlog.length, 100);
  assert.deepEqual(read.truncated, ["board 7 backlog: 100 of 250"]);
  assert.equal(read.notes.length, 1);
  assert.match(read.notes[0], /paging stopped: GraphQL remaining 50 is below 100/);
});

test("paging: a stop mid-run keeps what was read, and the later groups stay truncated", async () => {
  // ready 150 + backlog 150: the check before the Ready follow-up passes, every later one is low.
  const items = [
    ...Array.from({ length: 150 }, (_, i) => item(2000 + i, { status: "Ready", size: "S" })),
    ...Array.from({ length: 150 }, (_, i) => item(3000 + i, { status: "Backlog", size: "S" })),
  ];
  const f = fetcher({ boards: [boardNode(7, { items })] }, { remaining: (fx) => (fx.rateChecks <= 2 ? 5000 : 50) });
  const read = await readBoards({ fetcher: f, now: NOW, count: () => {} });
  assert.equal(f.pageCalls.length, 1);
  assert.equal(read.byBoard.get(7).ready.length, 150, "the Ready group was fully paged before the stop");
  assert.equal(read.byBoard.get(7).backlog.length, 100);
  assert.deepEqual(read.truncated, ["board 7 backlog: 100 of 150"]);
  assert.match(read.notes[0], /paging stopped/);
});

test("paging: day open reports the stop note and the truncated group, and still judges", async () => {
  const f = fetcher({ boards: [boardNode(7, { items: [...finished3(), ...backlogN(250)] })] }, { remaining: (fx) => (fx.rateChecks <= 1 ? 5000 : 50) });
  const r = await buildDayOpen({ goalFiles: GOALS, sampleRows: goodRows(), now: NOW, widget: widget(), fetcher: f, laneRows: [] });
  assert.notEqual(r.exit, 2, r.reason);
  assert.ok(r.notes.some((n) => /paging stopped/.test(n)), JSON.stringify(r.notes));
  assert.ok(r.notes.some((n) => /board 7 backlog: 100 of 250/.test(n)), JSON.stringify(r.notes));
});
