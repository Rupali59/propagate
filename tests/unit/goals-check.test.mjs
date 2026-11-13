// goals check (propagate#264): the standing check. Every clause has a failing fixture written as a LITERAL, never
// through a shared builder (rule:mutate-behind-the-fixture-builder): do not tidy these onto a helper, because a builder
// can only produce valid goals and boards, and the guards below are there to refuse the invalid ones.
// @size small
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { checkGoals } from "../../lib/report/goals-check.mjs";
import { parseGoalsFile } from "../../lib/report/goals.mjs";
import { checkCmd } from "../../cli/goals.mjs";

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0); // 2026-11-20

const PLAN_CLAUSE = "no plan approval recorded in 7 days";
const clauses = (r) => r.violations.map((v) => v.clause);

// A complete Ready item and a complete In progress item, as literals reused only where the test is about something else.
const okReady = { ref: "o/r#1", status: "Ready", doneWhen: true, fields: { Goal: "G1", Priority: "P1", Model: "Sonnet", Size: "S", Order: 1 } };
const okProg = { ref: "o/r#2", status: "In progress", doneWhen: true, fields: { Goal: "G1", Priority: "P1", Model: "Sonnet", Size: "S" } };

const g1 = { n: "G1", title: "one", status: "open", active: true, activeSince: "2026-11-13", appetiteWeeks: 4, retros: [] };
const goalsFile = (...entries) => ({ file: "/x/GOALS.md", unread: false, entries });
const board = (items, over = {}) => ({ number: 7, title: "B", hasGoalField: true, items, ...over });

test("a complete tree passes, and the plan clause is reported as not checked, never as a pass", () => {
  const r = checkGoals({ files: [goalsFile(g1)], boards: [board([okReady, okProg])], now: NOW });
  assert.equal(r.ok, true, JSON.stringify(r.violations));
  assert.deepEqual(r.violations, []);
  assert.ok(r.notChecked.includes(PLAN_CLAUSE), `notChecked was ${JSON.stringify(r.notChecked)}`);
  assert.equal(r.counts.active, 1);
  assert.equal(r.counts.itemsChecked, 2);
});

test("clause active-goals: more than 3 active goals is a violation, 3 is not", () => {
  const mk = (n) => ({ n, title: n, status: "open", active: true, activeSince: "2026-11-13", appetiteWeeks: 4, retros: [] });
  const three = checkGoals({ files: [goalsFile(mk("G1"), mk("G2"), mk("G3"))], boards: [board([])], now: NOW });
  assert.equal(three.violations.filter((v) => v.clause === "active-goals").length, 0);
  const four = checkGoals({ files: [goalsFile(mk("G1"), mk("G2"), mk("G3"), mk("G4"))], boards: [board([])], now: NOW });
  assert.deepEqual(clauses(four), ["active-goals"]);
  assert.match(four.violations[0].reason, /4 active goals, the limit is 3/);
  assert.equal(four.ok, false);
});

test("clause active-goals: 0 active goals is a violation in its own right", () => {
  const idle = { n: "G1", title: "one", status: "open", active: false, activeSince: null, appetiteWeeks: null, retros: [] };
  const r = checkGoals({ files: [goalsFile(idle)], boards: [board([])], now: NOW });
  assert.deepEqual(clauses(r), ["active-goals"]);
  assert.match(r.violations[0].reason, /0 active goals/);
});

test("a parked goal parsed from a real file is never counted active (4 Active lines, one parked: no limit violation)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gc-"));
  const p = path.join(dir, "GOALS.md");
  const sec = (id, extra = "") => `## ${id} · t\n\n**Active since 2026-11-13 · appetite 4 weeks**\n${extra}\n**Done when:** x.\n\n`;
  writeFileSync(p, `# W\n\n${sec("G1")}${sec("G2")}${sec("G3")}${sec("G4", "**Parked (cycle 1, 2026-11-14):** waits; returns when asked.\n")}`);
  const r = checkGoals({ files: [parseGoalsFile(p)], boards: [board([])], now: NOW });
  assert.equal(r.counts.active, 3);
  assert.equal(r.violations.filter((v) => v.clause === "active-goals").length, 0, JSON.stringify(r.violations));
});

test("clause goal-undeclared: an item naming a goal no file declares, and one declared but not active", () => {
  const parked = { n: "G9", title: "p", status: "parked", active: false, activeSince: null, appetiteWeeks: null, retros: [] };
  const items = [
    { ref: "o/r#10", status: "Ready", doneWhen: true, fields: { Goal: "G5", Priority: "P1", Model: "Sonnet", Size: "S", Order: 1 } },
    { ref: "o/r#11", status: "Ready", doneWhen: true, fields: { Goal: "G9", Priority: "P1", Model: "Sonnet", Size: "S", Order: 2 } },
  ];
  const r = checkGoals({ files: [goalsFile(g1, parked)], boards: [board(items)], now: NOW });
  const u = r.violations.filter((v) => v.clause === "goal-undeclared");
  assert.deepEqual(u.map((v) => v.subject).sort(), ["G5", "G9"]);
  assert.match(u.find((v) => v.subject === "G5").reason, /declared in no GOALS\.md/);
  assert.match(u.find((v) => v.subject === "G9").reason, /declared but not active/);
});

test("clause item-fields: a Ready item with no Order is a violation", () => {
  const item = { ref: "o/r#20", status: "Ready", doneWhen: true, fields: { Goal: "G1", Priority: "P1", Model: "Sonnet", Size: "S" } };
  const r = checkGoals({ files: [goalsFile(g1)], boards: [board([item])], now: NOW });
  assert.deepEqual(clauses(r), ["item-fields"]);
  assert.equal(r.violations[0].subject, "o/r#20");
  assert.match(r.violations[0].reason, /missing Order/);
});

test("clause item-fields: an In progress item needs no Order (finish first, by design)", () => {
  const item = { ref: "o/r#21", status: "In progress", doneWhen: true, fields: { Goal: "G1", Priority: "P1", Model: "Sonnet", Size: "S" } };
  const r = checkGoals({ files: [goalsFile(g1)], boards: [board([item])], now: NOW });
  assert.equal(r.ok, true, JSON.stringify(r.violations));
  assert.deepEqual(r.violations, []);
});

test("clause item-fields: each missing field is named (Goal, Priority, Model, Size, Done when)", () => {
  const bare = { ref: "o/r#30", status: "In progress", doneWhen: false, fields: {} };
  const parkedGoal = { ref: "o/r#31", status: "In progress", doneWhen: true, fields: { Goal: "Parked", Priority: "P1", Model: "Sonnet", Size: "S" } };
  const idea = { ref: "o/r#32", status: "In progress", doneWhen: true, fields: { Goal: "Idea", Priority: "P1", Model: "Sonnet", Size: "S" } };
  const r = checkGoals({ files: [goalsFile(g1)], boards: [board([bare, parkedGoal, idea])], now: NOW });
  const by = Object.fromEntries(r.violations.filter((v) => v.clause === "item-fields").map((v) => [v.subject, v.reason]));
  assert.match(by["o/r#30"], /Goal, Priority, Model, Size, Done when/);
  assert.match(by["o/r#31"], /Goal \(is Parked\)/);
  assert.match(by["o/r#32"], /Goal \(is Idea\)/);
});

test("clause appetite: an active goal with no appetite recorded is a violation, never a pass", () => {
  const none = { n: "G1", title: "one", status: "open", active: true, activeSince: "2026-11-13", appetiteWeeks: null, retros: [] };
  const r = checkGoals({ files: [goalsFile(none)], boards: [board([])], now: NOW });
  assert.deepEqual(clauses(r), ["appetite"]);
  assert.match(r.violations[0].reason, /no appetite recorded/);
});

test("clause appetite: past its appetite with no Retro on or after the end is a violation; a Retro clears it", () => {
  // 1 week from 2026-11-06 ends 2026-11-13; NOW is 2026-11-20.
  const over = { n: "G1", title: "one", status: "open", active: true, activeSince: "2026-11-06", appetiteWeeks: 1, retros: [] };
  const early = { ...over, retros: [{ date: "2026-11-10", decision: "continue" }] };
  const late = { ...over, retros: [{ date: "2026-11-14", decision: "continue" }] };
  const within = { n: "G1", title: "one", status: "open", active: true, activeSince: "2026-11-13", appetiteWeeks: 2, retros: [] };
  const run = (e) => checkGoals({ files: [goalsFile(e)], boards: [board([])], now: NOW });
  assert.deepEqual(clauses(run(over)), ["appetite"]);
  assert.match(run(over).violations[0].reason, /past its appetite/);
  assert.deepEqual(clauses(run(early)), ["appetite"], "a Retro dated before the appetite ended does not clear it");
  assert.deepEqual(clauses(run(late)), []);
  assert.deepEqual(clauses(run(within)), []);
});

test("floor: no GOALS.md files is blind, not clean", () => {
  const r = checkGoals({ files: [], boards: [board([okReady])], now: NOW });
  assert.equal(r.ok, false);
  assert.match(r.blind, /no GOALS\.md found/);
});

test("floor: no boards read is blind, not clean", () => {
  const r = checkGoals({ files: [goalsFile(g1)], boards: [], now: NOW });
  assert.equal(r.ok, false);
  assert.match(r.blind, /no board was read/);
});

test("a board with no Goal field is named in notChecked, its items are not counted clean, and an unread file is named too", () => {
  const unread = { file: "/y/GOALS.md", unread: true, reason: "format not recognised", entries: [] };
  const noField = { number: 9, title: "Plain", hasGoalField: false, items: [{ ref: "o/r#40", status: "Ready", doneWhen: false, fields: {} }] };
  const r = checkGoals({ files: [goalsFile(g1), unread], boards: [noField, board([okReady])], now: NOW });
  assert.equal(r.counts.itemsChecked, 1);
  assert.ok(r.notChecked.some((n) => /board 9 Plain: has no Goal field/.test(n)), JSON.stringify(r.notChecked));
  assert.ok(r.notChecked.some((n) => /\/y\/GOALS\.md: unread/.test(n)), JSON.stringify(r.notChecked));
  assert.equal(r.violations.filter((v) => v.subject === "o/r#40").length, 0);
});

// ── the command: a fake GitHub fetcher honouring the alias names of dayDetailQuery ──────────────────────────────

const OPT = [{ id: "a", name: "Backlog" }, { id: "b", name: "Ready" }, { id: "c", name: "In progress" }, { id: "d", name: "Done" }];
const listing = (nodes) => ({ viewer: { projectsV2: { totalCount: nodes.length, nodes } } });
const goalBoard = {
  id: "P7", number: 7, title: "B", closed: false,
  fields: { nodes: [{ id: "S", name: "Status", options: OPT }, { id: "G", name: "Goal", options: [{ id: "g", name: "G1" }] }] },
};
const empty = { totalCount: 0, nodes: [] };
const readyNode = {
  id: "I1",
  content: { number: 1, title: "t", body: "**Done when:** x", state: "OPEN", closedAt: null, repository: { nameWithOwner: "o/r" }, milestone: null, labels: { nodes: [] } },
  fieldValues: { nodes: [
    { name: "Ready", field: { name: "Status" } }, { name: "G1", field: { name: "Goal" } }, { name: "P1", field: { name: "Priority" } },
    { name: "Sonnet", field: { name: "Model" } }, { name: "S", field: { name: "Size" } }, { number: 1, field: { name: "Order" } },
  ] },
};
const fakeFetcher = (nodes, readyItems) => ({
  rateLimit: () => ({ graphql: { remaining: 5000, limit: 5000 } }),
  graphql: async (q) => {
    if (q.includes("projectsV2(first:100)")) return listing(nodes);
    return { viewer: { b7: { number: 7, title: "B", ready: { totalCount: readyItems.length, nodes: readyItems }, prog: empty, backlog: empty, done: empty, recent: empty, stale: empty } } };
  },
});
const sink = () => {
  const lines = [];
  return { lines, fn: (s) => lines.push(s) };
};
const files = [goalsFile(g1)];

test("checkCmd: a clean read is exit 0 and prints the not-checked plan clause", async () => {
  const o = sink();
  const code = await checkCmd([], { files, approvals: [], fetcher: fakeFetcher([goalBoard], [readyNode]), now: NOW, out: o.fn, err: o.fn });
  assert.equal(code, 0, o.lines.join("\n"));
  assert.ok(o.lines.join("\n").includes(PLAN_CLAUSE));
});

test("checkCmd: a violation is exit 1 and --json carries it", async () => {
  const noOrder = { ...readyNode, fieldValues: { nodes: readyNode.fieldValues.nodes.filter((v) => v.field.name !== "Order") } };
  const o = sink();
  const code = await checkCmd(["--json"], { files, fetcher: fakeFetcher([goalBoard], [noOrder]), now: NOW, out: o.fn, err: o.fn });
  assert.equal(code, 1);
  const j = JSON.parse(o.lines.join("\n"));
  assert.equal(j.ok, false);
  assert.equal(j.violations[0].clause, "item-fields");
});

test("checkCmd: zero open boards is exit 2 (a blind read), never a pass", async () => {
  const o = sink();
  const code = await checkCmd([], { files, fetcher: fakeFetcher([], []), now: NOW, out: o.fn, err: o.fn });
  assert.equal(code, 2);
  assert.match(o.lines.join("\n"), /gone blind/);
});

test("checkCmd: zero GOALS.md files is exit 2", async () => {
  const o = sink();
  const code = await checkCmd([], { files: [], fetcher: fakeFetcher([goalBoard], [readyNode]), now: NOW, out: o.fn, err: o.fn });
  assert.equal(code, 2);
  assert.match(o.lines.join("\n"), /no GOALS\.md found/);
});

test("a Ready or In progress group cut off at 100 is named in notChecked, never silently checked in part", async () => {
  const r = checkGoals({ files: [goalsFile(g1)], boards: [board([okReady], { truncated: ["board 7 ready: 100 of 140"] })], now: NOW });
  assert.ok(r.notChecked.some((n) => n.startsWith("board 7 ready: 100 of 140")), `notChecked was ${JSON.stringify(r.notChecked)}`);
  // And the reader hands it over: boardsForGoals keeps only this board's ready/prog truncations.
  const { boardsForGoals } = await import("../../lib/report/day.mjs");
  const read = {
    listing: { boards: [{ number: 7, title: "B", hasGoalField: true }] },
    byBoard: new Map([[7, { ready: [], prog: [], backlog: [], done: [], recent: [], stale: [] }]]),
    truncated: ["board 7 ready: 100 of 140", "board 7 backlog: 100 of 300", "board 70 prog: 100 of 101"],
  };
  assert.deepEqual(boardsForGoals(read)[0].truncated, ["board 7 ready: 100 of 140"]);
});

test("boards with no Goal field and no Ready / In progress items fold into one notChecked line; a board with items keeps its own", () => {
  const r = checkGoals({
    files: [goalsFile(g1)],
    boards: [board([okReady]), board([], { number: 30, title: "A", hasGoalField: false }), board([], { number: 31, title: "B", hasGoalField: false }), board([okReady], { number: 32, title: "C", hasGoalField: false })],
    now: NOW,
  });
  assert.ok(r.notChecked.includes("2 board(s) with no Goal field and nothing Ready or In progress: 30, 31"), JSON.stringify(r.notChecked));
  assert.ok(r.notChecked.some((n) => n.startsWith("board 32 C: has no Goal field, so its 1 Ready")), JSON.stringify(r.notChecked));
  assert.equal(r.notChecked.filter((n) => /^board 3[01] /.test(n)).length, 0, "an idle board must not also get its own line");
});

// plan-goal (G3 Done-when 2): the approval log hooks/plan-goal.mjs writes. Rows are literals.
const daysAgo = (d) => new Date(NOW - d * 24 * 3600 * 1000).toISOString();
const plain = (approvals) => checkGoals({ files: [goalsFile(g1)], boards: [board([okReady, okProg])], approvals, now: NOW });

test("plan-goal: a row older than 7 days is ignored, even one naming a goal that is not active", () => {
  const r = plain([{ ts: daysAgo(8), plan: "/p/old.md", goal: "G9" }]);
  assert.equal(r.ok, true, JSON.stringify(r.violations));
  assert.ok(r.notChecked.includes(PLAN_CLAUSE), "an all-stale log is the same as no log");
});

test("plan-goal: an approval naming a goal that is not active now is a plan-goal violation", () => {
  const parked = { n: "G2", title: "two", status: "parked", active: false, activeSince: null, appetiteWeeks: null, retros: [] };
  const r = checkGoals({
    files: [goalsFile(g1, parked)],
    boards: [board([okReady, okProg])],
    approvals: [{ ts: daysAgo(2), plan: "/p/new.md", goal: "G2" }, { ts: daysAgo(1), plan: "/p/ok.md", goal: "G1" }],
    now: NOW,
  });
  assert.deepEqual(clauses(r), ["plan-goal"]);
  assert.equal(r.violations[0].subject, "/p/new.md");
  assert.match(r.violations[0].reason, /G2.*not active now/);
  assert.deepEqual(r.approvals.byGoal, { G2: 1, G1: 1 });
  assert.equal(r.ok, false);
});

test("plan-goal: an override is listed in the approvals summary, never a violation", () => {
  const r = plain([{ ts: daysAgo(1), plan: "/p/side.md", goal: null, reason: "one-off repair" }]);
  assert.equal(r.ok, true, JSON.stringify(r.violations));
  assert.deepEqual(r.violations, []);
  assert.equal(r.approvals.total, 1);
  assert.deepEqual(r.approvals.overrides, [{ ts: daysAgo(1), plan: "/p/side.md", reason: "one-off repair" }]);
  assert.ok(!r.notChecked.includes(PLAN_CLAUSE), "a recorded approval is not 'not checked'");
});

test("plan-goal: no rows, or no approvals argument, is 'not checked', never clean", () => {
  assert.ok(plain([]).notChecked.includes(PLAN_CLAUSE));
  assert.ok(plain(undefined).notChecked.includes(PLAN_CLAUSE));
});

test("checkCmd: prints the approvals summary and the override lines", async () => {
  const o = sink();
  const rows = [{ ts: daysAgo(1), plan: "/p/a.md", goal: "G1" }, { ts: daysAgo(1), plan: "/p/b.md", goal: null, reason: "repair" }];
  const code = await checkCmd([], { files, approvals: rows, fetcher: fakeFetcher([goalBoard], [readyNode]), now: NOW, out: o.fn, err: o.fn });
  assert.equal(code, 0, o.lines.join("\n"));
  const text = o.lines.join("\n");
  assert.match(text, /plan approvals, last 7 days: 2 .*G1 x1.*1 goal_reason override/);
  assert.match(text, /override.*\/p\/b\.md: repair/);
});
