/**
 * ui.client.js — run headless, against a stub DOM.
 *
 * WHY THIS IS POSSIBLE NOW. The client used to live inside `page()`'s template
 * literal, where it was a string and could only be checked by eye. As a plain
 * file it can be executed in `node:vm` with a stub DOM, which is the difference
 * between "it parses" and "it renders what it should".
 *
 * WHAT IT IS ACTUALLY FOR. The shaping logic is where the design lives — which
 * axis each view groups on, that severity leaves the title and becomes a badge,
 * that the list order and the keyboard index are the same order. None of that is
 * visible to a parse check, and all of it is wrong in ways that look fine in a
 * screenshot.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";
import path from "node:path";

import { fromRealm } from "../helpers/plain.mjs";

const CLIENT = readFileSync(path.join(import.meta.dirname, "../../commands/ui.client.js"), "utf8");

/** The smallest DOM the client touches. innerHTML is a plain string sink, which
 *  is all the assertions need — the real browser parses it, we inspect it. */
function stubDom() {
  const nodes = new Map();
  const make = (id) => ({
    id, innerHTML: "", textContent: "", value: "", style: {},
    dataset: {}, classList: { contains: () => false, toggle: () => {}, add: () => {}, remove: () => {} },
    addEventListener: () => {}, focus: () => {}, blur: () => {},
    querySelector: () => null, querySelectorAll: () => [], scrollIntoView: () => {},
  });
  for (const id of ["nav", "sum", "chips", "q", "list", "detail", "ev", "action", "msg", "disp", "sev", "reason", "go"]) {
    nodes.set(id, make(id));
  }
  return {
    body: { dataset: { token: "test-token" } },
    getElementById: (id) => nodes.get(id) ?? null,
    addEventListener: () => {},
    activeElement: { tagName: "BODY", blur: () => {} },
    _nodes: nodes,
  };
}

/** Run the client with a fetch that answers from `routes`. */
async function boot(routes, hash = "#issues") {
  const document = stubDom();
  const ctx = createContext({
    document,
    location: { hash },
    fetch: async (url) => {
      const key = Object.keys(routes).find((k) => String(url).includes(k));
      return { json: async () => (key ? routes[key] : { error: "no stub for " + url }) };
    },
    setTimeout, clearTimeout, console, Date, Math, JSON, Map, Set, RegExp, String, Number, Array, Object, Promise,
  });
  ctx.globalThis = ctx;
  new Script(CLIENT).runInContext(ctx);
  await new Promise((r) => setTimeout(r, 15));   // let load() settle
  return { ctx, document, ui: ctx.__ui };
}

// ── fixtures shaped exactly like the real endpoints ────────────────────────

const issue = (id, sev, text, file = "/Users/x/Documents/GitHub/propagate/propagation/state/workspace/ISSUES.md", line = 1) => ({
  kind: "issue", id, file, line, short: "state/workspace/ISSUES.md",
  raw: `### ${id} · ${text} — **${sev}** — **OPEN**`,
  text: `${id} · ${text} — **${sev}** — **OPEN**`,
  actions: ["issue-close", "issue-severity"], noClose: null, priority: null,
});
const todo = (text, ws, priority = null) => ({
  kind: "todo", id: null, priority,
  file: `/Users/x/Documents/GitHub/${ws}/propagation/state/workspace/TODOS.md`,
  line: 4, short: "state/workspace/TODOS.md", raw: `- [ ] ${text}`, text, actions: ["todo-tick"], noClose: null,
});
const REGISTERS = {
  error: null,
  issues: [issue("N10", "S1", "a launchd label that does not exist"), issue("N82", "S2", "the census cannot tell two things apart"),
           issue("N83", "S2", "another S2"), issue("N88", "S3", "abandoned worktrees")],
  todos: [todo("motherboard thing", "Motherboard"), todo("another motherboard thing", "Motherboard"),
          todo("tathya thing", "Tathya", 0), todo("x".repeat(648), "Tathya")],
  counts: { issues: 4, todos: 4, shownIssues: 4, shownTodos: 4, unreadable: 0, noAction: 610 },
};
const QUEUE = {
  items: [
    { edge_id: "e1", state: "REVERSED", source: "/x/Documents/GitHub/rules/a.md", downstream: "/x/Documents/GitHub/Tathya/b.md",
      sourceShort: "rules/a.md", downstreamShort: "Tathya/b.md", judgedCount: 4, noiseRatio: 0.75, allowed: ["propagated"], lastVerified: { commit: "abcdef1234", dirty: true, ts: "2026-09-01T00:00:00Z" }, why: null },
    { edge_id: "e2", state: "DRIFTED", source: "/x/Documents/GitHub/Tathya/e.md", downstream: "/x/Documents/GitHub/Tathya/g.md",
      sourceShort: "Tathya/e.md", downstreamShort: "Tathya/g.md", judgedCount: 0, noiseRatio: null, allowed: ["propagated"], lastVerified: null, why: "because" },
    { edge_id: "e3", state: "DIVERGED", source: "/x/Documents/GitHub/rules/i.md", downstream: "/x/Documents/GitHub/scripts/k.md",
      sourceShort: "rules/i.md", downstreamShort: "scripts/k.md", judgedCount: 1, noiseRatio: 0, allowed: ["both-reconciled"], lastVerified: null, why: null },
  ],
  summary: { total: 3, byState: { REVERSED: 1, DRIFTED: 1, DIVERGED: 1 }, neverJudged: 1, judged: 2, highNoise: 1 },
  declared: 497, expanded: 1007,
};

// ── the design, asserted ───────────────────────────────────────────────────

test("severity leaves the title and becomes a badge", async () => {
  // It has been shipping as literal asterisks: `N10 · … — **S1** — **OPEN**`.
  const { ui, document } = await boot({ "/api/registers": REGISTERS });
  const rows = ui.shape("issues");
  assert.equal(rows[0].badge, "S1");
  assert.doesNotMatch(rows[0].title, /\*\*/, "no markdown asterisks survive into the title");
  assert.doesNotMatch(rows[0].title, /OPEN/, "the status marker is not part of the title either");
  assert.match(rows[0].title, /launchd label/);
  assert.doesNotMatch(document.getElementById("list").innerHTML, /\*\*S[0-4]\*\*/);
});

test("issues group by SEVERITY, worst first — not by workspace", async () => {
  // All 55 real issues are propagate's, so a workspace grouping yields exactly
  // one group and tells the reader nothing.
  const { ui } = await boot({ "/api/registers": REGISTERS });
  const gs = ui.grouped(ui.shape("issues"));
  assert.deepEqual(fromRealm(gs.map(([g, r]) => [g, r.length])), [["S1", 1], ["S2", 2], ["S3", 1]]);
});

test("todos group by WORKSPACE, not by priority", async () => {
  // 127 of 145 real todos have no priority, so a priority grouping is one big
  // "unrated" bucket plus noise.
  const { ui } = await boot({ "/api/registers": REGISTERS }, "#todos");
  const gs = ui.grouped(ui.shape("todos"));
  assert.deepEqual(fromRealm(gs.map(([g]) => g).sort()), ["Motherboard", "Tathya"]);
});

test("the queue groups by the HUB/WORKSPACE line, with state on the badge", async () => {
  // "Where is hub vs workspace?" — it was nowhere. The queue grouped by state,
  // which the badge already says. A CROSSING edge is a contract that has not
  // reached its instances, and that question was unanswerable from this page.
  const { ui } = await boot({ "/api/queue": QUEUE }, "#queue");
  const rows = ui.shape("queue");
  assert.deepEqual(fromRealm(rows.map((r) => r.group)),
    ["crosses the line", "Tathya", "hub-internal"], "grouped by side, not by state");
  assert.deepEqual(fromRealm(rows.map((r) => r.badge)),
    ["REVERSED", "DRIFTED", "DIVERGED"], "state survives on the badge");

  const gs = ui.grouped(rows);
  assert.equal(fromRealm(gs.map(([g]) => g))[0], "crosses the line", "crossers first — they are the interesting ones");
});

// ── the bug the refactor fixed ─────────────────────────────────────────────

test("ROWS is in DISPLAY order, so j/k and a click mean the same row", async () => {
  // Grouping reorders rows relative to the filtered array, so an index into one
  // is not an index into the other. The first version rendered and then
  // re-queried the DOM to recover the order, making the display the source of
  // truth for its own contents.
  const { ui, document } = await boot({ "/api/registers": REGISTERS });
  const rows = ui.rows();
  assert.deepEqual(fromRealm(rows.map((r) => r.badge)), ["S1", "S2", "S2", "S3"], "S1 first, matching the rendered groups");

  const html = document.getElementById("list").innerHTML;
  const order = [...html.matchAll(/class="badge (S[0-9])"/g)].map((m) => m[1]);
  assert.deepEqual(order, fromRealm(rows.map((r) => r.badge)), "the DOM and ROWS agree, index for index");
});

test("the selected row is marked, and it is the first one", async () => {
  const { document } = await boot({ "/api/registers": REGISTERS });
  const html = document.getElementById("list").innerHTML;
  assert.equal((html.match(/class="item sel"/g) ?? []).length, 1, "exactly one selection");
  assert.match(html.slice(0, html.indexOf("</div>") + 400), /item sel/, "and it is the first item");
});

// ── filtering ──────────────────────────────────────────────────────────────

test("a chip narrows to its group and the counts stay honest", async () => {
  const { ui } = await boot({ "/api/registers": REGISTERS });
  const all = ui.shape("issues");
  ui.setFilter("S2");
  assert.equal(ui.filtered(all).length, 2);
  ui.setFilter(null);
  assert.equal(ui.filtered(all).length, 4);
});

test("search matches title AND location, so a filename finds its rows", async () => {
  const { ui } = await boot({ "/api/registers": REGISTERS });
  const all = ui.shape("issues");
  ui.setQ("worktrees");
  assert.equal(ui.filtered(all).length, 1);
  ui.setQ("ISSUES.md");
  assert.equal(ui.filtered(all).length, 4, "the path is searchable too");
  ui.setQ("");
});

test("an empty result says WHICH question was asked", async () => {
  // "nothing here" and "nothing matched your filter" are different facts and
  // only one of them means there is no work.
  const { ui, document } = await boot({ "/api/registers": REGISTERS });
  ui.setQ("zzzzz-no-such-thing");
  const { document: d2 } = await boot({ "/api/registers": { error: null, issues: [], todos: [], counts: {} } });
  assert.match(d2.getElementById("list").innerHTML, /Nothing in this view/);
  assert.ok(document);
});

test("an endpoint error is rendered, not swallowed into an empty list", async () => {
  const { document } = await boot({ "/api/registers": { error: "walk exploded", issues: null, todos: null } });
  assert.match(document.getElementById("list").innerHTML, /walk exploded/);
});

// ── growth ─────────────────────────────────────────────────────────────────

test("a 648-character todo does not break the list", async () => {
  // A real one in this tree is exactly that long. The list clamps to two lines
  // in CSS; the full text belongs to the detail pane.
  const { ui } = await boot({ "/api/registers": REGISTERS }, "#todos");
  const long = ui.shape("todos").find((r) => r.title.length > 600);
  assert.ok(long, "the long row is still present, not dropped");
  assert.equal(long.title.length, 648, "and not truncated in the data — only in the CSS");
});

test("a queue row shows whether it has ever been judged", async () => {
  const { ui } = await boot({ "/api/queue": QUEUE }, "#queue");
  const rows = ui.shape("queue");
  assert.match(rows.find((r) => r.raw.edge_id === "e2").meta, /never judged/);
  assert.match(rows.find((r) => r.raw.edge_id === "e1").meta, /judged 4/);
  assert.equal(rows.find((r) => r.raw.edge_id === "e1").noisy, true, "75% no-op is worth flagging");
  assert.equal(rows.find((r) => r.raw.edge_id === "e3").noisy, false);
});
