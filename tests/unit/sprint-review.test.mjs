/**
 * sprint-review.test.mjs — `propagate sprint review` (propagate#191). Literal fixtures, an injected fetcher, no network.
 *
 * The safety-flag test (rule:safety-flag-needs-a-test) measures the SIDE EFFECT: the fake board store is snapshotted
 * byte for byte before and after, and the fetcher's write method is counted. It does not trust the command's
 * own "nothing written" wording.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { sprintCmd } from "../../cli/sprint.mjs";
import { buildSprintReview, classify, moveMutation, pickIterations } from "../../lib/report/sprint-review.mjs";

const NOW = new Date(2026, 10, 10, 10, 0, 0).getTime(); // local Tue 2026-11-10

// ── fixtures ────────────────────────────────────────────────────────────────

const iter = (id, title, startDate, duration) => ({ id, title, startDate, duration });
const boardNode = (n, completed, active) => ({
  id: `P${n}`,
  number: n,
  title: `Board ${n}`,
  closed: false,
  fields: { nodes: [{}, { id: `F${n}`, name: "Sprint", configuration: { iterations: active, completedIterations: completed } }] },
});
const listing = (nodes) => ({ viewer: { projectsV2: { totalCount: nodes.length, nodes } } });

// board 7: Sprint 1 2026-11-05..11-08 ended, Sprint 2 2026-11-09..11-15 current, Sprint 3 11-16..11-22 next
// board 18: Sprint 1 2026-11-05..11-07 ended (disagrees with board 7 on the end), Sprint 2 11-08.. current
const LISTING = () =>
  listing([
    boardNode(7, [iter("i71", "Sprint 1", "2026-11-05", 4)], [iter("i72", "Sprint 2", "2026-11-09", 7), iter("i73", "Sprint 3", "2026-11-16", 7)]),
    boardNode(18, [iter("i181", "Sprint 1", "2026-11-05", 3)], [iter("i182", "Sprint 2", "2026-11-08", 7)]),
  ]);

const item = (board, n, { status = "Ready", sprint = "Sprint 1", finished = null, size = null, tokens = null, minutes = null } = {}) => ({
  id: `I${board}-${n}`,
  content: { number: n, title: `item ${n}`, repository: { nameWithOwner: "o/r" } },
  fieldValues: {
    nodes: [
      { name: status, field: { name: "Status" } },
      ...(sprint ? [{ title: sprint, startDate: "2026-11-05", duration: 4, field: { name: "Sprint" } }] : []),
      ...(finished ? [{ date: finished, field: { name: "Finished" } }] : []),
      ...(size ? [{ name: size, field: { name: "Size" } }] : []),
      ...(tokens !== null ? [{ number: tokens, field: { name: "Tokens" } }] : []),
      ...(minutes !== null ? [{ number: minutes, field: { name: "Minutes" } }] : []),
    ],
  },
});

/** Board 7 (Sprint 1 = 11-05..11-08): 2 done in window, 1 done outside, 1 Status Done with no Finished, 2 carry-over. */
const BOARD7 = () => [
  item(7, 1, { status: "Done", finished: "2026-11-06", size: "S", tokens: 1_000_000, minutes: 30 }),
  item(7, 2, { status: "Done", finished: "2026-11-08", size: "S", tokens: 2_000_000 }), // end day is inside; Minutes missing
  item(7, 3, { status: "Done", finished: "2026-11-09" }), // after the window
  item(7, 4, { status: "Done" }), // Finished missing
  item(7, 5, { status: "In progress" }),
  item(7, 6, { status: "Ready" }),
];
/** Board 18 (Sprint 1 = 11-05..11-07): 1 done in window, 1 carry-over. */
const BOARD18 = () => [item(18, 20, { status: "Done", finished: "2026-11-07", size: "M", tokens: 5_000_000, minutes: 90 }), item(18, 21, { status: "Ready" })];

/** A fake GitHub. `store` is the board state the writes mutate; `writes` counts every call that reached `write`. */
function fetcher({ remaining = 5000, store = { 7: BOARD7(), 18: BOARD18() }, listingData = LISTING() } = {}) {
  const f = {
    store,
    calls: 0,
    writes: [],
    queries: [],
    rateLimit: () => ({ graphql: { remaining, limit: 5000 } }),
    graphql: async (q) => {
      f.calls++;
      f.queries.push(q);
      assert.ok(!q.trimStart().startsWith("mutation"), "a mutation must never go through graphql()");
      if (q.includes("projectsV2(first:100)")) return listingData;
      const viewer = {};
      for (const m of q.matchAll(/b(\d+):projectV2/g)) viewer[`b${m[1]}`] = { number: Number(m[1]), title: `Board ${m[1]}`, items: { totalCount: store[m[1]].length, nodes: store[m[1]] } };
      return { viewer };
    },
    write: async (mutation) => {
      f.writes.push(mutation);
      for (const m of mutation.matchAll(/itemId:"([^"]+)".*?iterationId:"([^"]+)"/g)) {
        for (const items of Object.values(store)) {
          const it = items.find((x) => x.id === m[1]);
          if (it) it.fieldValues.nodes = it.fieldValues.nodes.map((v) => (v.field?.name === "Sprint" ? { ...v, title: `moved:${m[2]}` } : v));
        }
      }
      return {};
    },
  };
  return f;
}

const run = async (args, f = fetcher(), laneRows = []) => {
  const lines = [];
  const code = await sprintCmd(["review", ...args], { fetcher: f, laneRows, now: NOW, out: (s) => lines.push(s), err: (s) => lines.push(`ERR ${s}`) });
  return { code, text: lines.join("\n"), lines };
};

// ── counts ──────────────────────────────────────────────────────────────────

test("planned, done and carry-over are counted from the fixture, per board and in total", async () => {
  const f = fetcher();
  const r = await buildSprintReview({ now: NOW, fetcher: f, laneRows: [] });
  assert.equal(r.exit, 0);
  const b7 = r.boards.find((b) => b.number === 7);
  assert.deepEqual([b7.planned, b7.done.length, b7.carry.length, b7.unverified.length], [6, 2, 2, 2]);
  assert.deepEqual(b7.carry.map((i) => i.number), [5, 6]);
  const b18 = r.boards.find((b) => b.number === 18);
  assert.deepEqual([b18.planned, b18.done.length, b18.carry.length, b18.unverified.length], [2, 1, 1, 0]);
  assert.deepEqual(r.totals, { planned: 8, done: 3, carry: 3, unverified: 2 });
  assert.equal(r.graphqlCalls, 2);
});

test("an item whose own Sprint value is another iteration is dropped even if the server returned it", async () => {
  const store = { 7: [...BOARD7(), item(7, 99, { status: "Ready", sprint: "Sprint 2" })], 18: BOARD18() };
  const r = await buildSprintReview({ now: NOW, fetcher: fetcher({ store }), laneRows: [] });
  assert.equal(r.boards.find((b) => b.number === 7).planned, 6);
});

test("done requires Finished inside the window: a Done item finished after the end is not done", () => {
  const c = classify(
    [item(7, 1, { status: "Done", finished: "2026-11-09" }), item(7, 2, { status: "Done", finished: "2026-11-04" })].map((n) => ({
      number: n.content.number,
      status: "Done",
      finished: n.fieldValues.nodes.find((v) => v.field.name === "Finished").date,
    })),
    { start: "2026-11-05", end: "2026-11-08" },
  );
  assert.equal(c.done.length, 0);
  assert.equal(c.unverified.length, 2);
});

test("boards that disagree on the iteration dates are reported, per board", async () => {
  const r = await buildSprintReview({ now: NOW, fetcher: fetcher(), laneRows: [] });
  const note = r.notes.find((n) => n.includes("disagree"));
  assert.ok(note, "a disagreement note");
  assert.match(note, /board 7: 2026-11-05\.\.2026-11-08/);
  assert.match(note, /board 18: 2026-11-05\.\.2026-11-07/);
  assert.ok(r.notes.some((n) => n.startsWith("added mid-sprint: not derivable")));
});

test("missing cost fields are counted", async () => {
  const r = await buildSprintReview({ now: NOW, fetcher: fetcher(), laneRows: [] });
  // Status-Done planned: board7 #1 #2 #3 #4, board18 #20 = 5; Finished missing: #4 only
  assert.equal(r.missing.statusDone, 5);
  assert.equal(r.missing.finished, 1);
  // Done in window: #1 #2 #20 = 3; Tokens all present; Minutes missing on #2
  assert.equal(r.missing.doneInWindow, 3);
  assert.equal(r.missing.tokens, 0);
  assert.equal(r.missing.minutes, 1);
});

test("the Size gain counts this sprint's Done items with Size and Tokens, by Size, against the floor of 5", async () => {
  const r = await buildSprintReview({ now: NOW, fetcher: fetcher(), laneRows: [] });
  assert.equal(r.calibration.S.n_main_or_unknown, 2);
  assert.equal(r.calibration.M.n_main_or_unknown, 1);
  assert.equal(r.calibration.S.status, "uncalibrated");
  const text = (await run([])).text;
  assert.match(text, /S: 0 lane, 2 main-or-unknown from this sprint alone; 3 more of one basis to reach the floor/);
});

test("--sprint selects by title; a title no board has is exit 2 with the reason", async () => {
  const r = await buildSprintReview({ now: NOW, fetcher: fetcher({ store: { 7: [item(7, 1, { sprint: "Sprint 2" })], 18: [] } }), laneRows: [], sprintTitle: "Sprint 2" });
  assert.equal(r.exit, 0);
  assert.equal(r.boards[0].sprint.title, "Sprint 2");
  const none = await buildSprintReview({ now: NOW, fetcher: fetcher(), laneRows: [], sprintTitle: "Sprint 9" });
  assert.equal(none.exit, 2);
  assert.match(none.reason, /no board has a Sprint iteration titled "Sprint 9"/);
});

test("the default is the most recently ended iteration; a board with none ended falls back to the current one, marked", () => {
  const boards = [
    { number: 1, title: "a", iterations: [{ id: "x", title: "S1", start: "2026-11-01", end: "2026-11-07" }, { id: "y", title: "S2", start: "2026-11-08", end: "2026-11-14" }] },
    { number: 2, title: "b", iterations: [{ id: "z", title: "T1", start: "2026-11-08", end: "2026-11-14" }] },
  ];
  const { picked } = pickIterations(boards, "2026-11-10");
  assert.equal(picked[0].sprint.title, "S1");
  assert.equal(picked[0].next.title, "S2");
  assert.equal(picked[1].sprint.title, "T1");
  assert.equal(picked[1].inProgress, true);
});

// ── GraphQL budget ──────────────────────────────────────────────────────────

test("low GraphQL refuses before fetching anything", async () => {
  const f = fetcher({ remaining: 50 });
  const r = await buildSprintReview({ now: NOW, fetcher: f, laneRows: [], apply: true });
  assert.equal(r.exit, 2);
  assert.match(r.reason, /below 100; refusing to start \(nothing fetched\)/);
  assert.equal(f.calls, 0);
  assert.equal(f.writes.length, 0);
});

test("remaining under 10 + 40 x boards refuses after the listing call and before the item fetch", async () => {
  const nodes = [7, 18, 30].map((n) => boardNode(n, [iter(`c${n}`, "Sprint 1", "2026-11-05", 4)], []));
  const f = fetcher({ remaining: 120, listingData: listing(nodes), store: { 7: [], 18: [], 30: [] } });
  const r = await buildSprintReview({ now: NOW, fetcher: f, laneRows: [], apply: true });
  assert.equal(r.exit, 2);
  assert.match(r.reason, /below the 130 estimated for 3 boards; refusing to fetch items/);
  assert.equal(f.calls, 1);
  assert.equal(f.writes.length, 0);
});

// ── the safety flag ─────────────────────────────────────────────────────────

test("WITHOUT --apply no write is reachable: the board store is byte-identical and write() was never called", async () => {
  const combos = [[], ["--json"], ["--sprint", "Sprint 1"], ["--sprint", "Sprint 1", "--json"], ["--sprint", "Sprint 2"], ["--sprint", "Sprint 9"], ["--json", "--sprint", "Sprint 1"]];
  for (const args of combos) {
    const f = fetcher();
    const before = JSON.stringify(f.store);
    const { text } = await run(args, f);
    assert.equal(JSON.stringify(f.store), before, `${args.join(" ") || "(no flags)"} must not touch any board item`);
    assert.equal(f.writes.length, 0, `${args.join(" ") || "(no flags)"} must not reach write()`);
    assert.ok(!/mutation/.test(f.queries.join("\n")), "no query text contains a mutation");
    assert.ok(typeof text === "string");
  }
});

test("without --apply the output lists the moves it WOULD make and says nothing was written", async () => {
  const { code, text } = await run([]);
  assert.equal(code, 0);
  assert.match(text, /--apply would write 3 move\(s\) \(nothing written\)/);
  assert.match(text, /move o\/r#5 \(board 7\) "Sprint 1" -> "Sprint 2"/);
});

// ── --apply ─────────────────────────────────────────────────────────────────

test("--apply writes exactly the carry-over moves, board then issue number, into each board's next iteration", async () => {
  const f = fetcher();
  const { code, lines } = await run(["--apply"], f);
  assert.equal(code, 0);
  assert.equal(f.writes.length, 1);
  const w = f.writes[0];
  const ids = [...w.matchAll(/itemId:"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ["I7-5", "I7-6", "I18-21"]);
  // board 7 carries into Sprint 2 (i72), board 18 into its next iteration after Sprint 1 (i182)
  assert.deepEqual([...w.matchAll(/iterationId:"([^"]+)"/g)].map((m) => m[1]), ["i72", "i72", "i182"]);
  assert.deepEqual([...w.matchAll(/projectId:"([^"]+)"/g)].map((m) => m[1]), ["P7", "P7", "P18"]);
  assert.ok(!w.includes("I7-1") && !w.includes("I7-3") && !w.includes("I7-4"), "Done and unverified items are never moved");
  assert.equal(f.store[7].find((i) => i.id === "I7-5").fieldValues.nodes.find((v) => v.field?.name === "Sprint").title, "moved:i72");
  assert.equal(f.store[7].find((i) => i.id === "I7-1").fieldValues.nodes.find((v) => v.field?.name === "Sprint").title, "Sprint 1");
  // what it will write is printed BEFORE the summary
  const announce = lines.findIndex((l) => l.startsWith("--apply: about to write 3 move(s)"));
  const wrote = lines.findIndex((l) => l.startsWith("wrote 3 move(s)"));
  assert.ok(announce >= 0 && wrote > announce);
});

test("--apply with nothing to carry writes nothing", async () => {
  const f = fetcher({ store: { 7: [item(7, 1, { status: "Done", finished: "2026-11-06" })], 18: [] } });
  const { code } = await run(["--apply"], f);
  assert.equal(code, 0);
  assert.equal(f.writes.length, 0);
});

test("--apply with no later iteration reports it and writes nothing for that board", async () => {
  const data = listing([boardNode(7, [iter("i71", "Sprint 1", "2026-11-05", 4)], [])]);
  const f = fetcher({ listingData: data, store: { 7: BOARD7(), 18: [] } });
  const r = await buildSprintReview({ now: NOW, fetcher: f, laneRows: [], apply: true });
  assert.equal(f.writes.length, 0);
  assert.match(r.unmovable[0].why, /no later iteration/);
});

test("the mutation text carries only a Sprint iteration value, nothing else", () => {
  const m = moveMutation([{ projectId: "P", itemId: "I", fieldId: "F", toIterationId: "N" }]);
  assert.equal(m, 'mutation{m0:updateProjectV2ItemFieldValue(input:{projectId:"P",itemId:"I",fieldId:"F",value:{iterationId:"N"}}){projectV2Item{id}}}');
});

// ── CLI ─────────────────────────────────────────────────────────────────────

test("an unknown flag is exit 2, before any fetch", async () => {
  const f = fetcher();
  const { code, text } = await run(["--aply"], f);
  assert.equal(code, 2);
  assert.match(text, /unknown argument --aply/);
  assert.equal(f.calls, 0);
});

test("a Sprint that has not ended is reviewed but its carry-over is never moved", async () => {
  const data = listing([boardNode(7, [], [iter("i72", "Sprint 2", "2026-11-09", 7), iter("i73", "Sprint 3", "2026-11-16", 7)])]);
  const f = fetcher({ listingData: data, store: { 7: [item(7, 5, { status: "Ready", sprint: "Sprint 2" })] } });
  const r = await buildSprintReview({ now: NOW, fetcher: f, laneRows: [], apply: true });
  assert.equal(r.exit, 0);
  assert.equal(r.moves.length, 0);
  assert.equal(f.writes.length, 0);
  assert.match(r.unmovable[0].why, /has not ended/);
});
