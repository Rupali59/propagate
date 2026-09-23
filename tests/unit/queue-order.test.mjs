/**
 * The fix-order join — the load-bearing change behind the READY/BLOCKED split.
 *
 * THE CENTRAL CLAIM: READY and BLOCKED are the two halves of the actionable
 * set, and nothing falls between them. 18 of 49 actionable edges have an
 * unsettled ancestor, and `cli.mjs` refuses those with exit 3. A page that
 * offers all 49 the same form leads a person into a refusal it could have
 * predicted, using data that already existed one module over.
 *
 * WHY A ROW WITH NO WORKLIST ENTRY MUST BE NULL, NOT ZERO. `layer: 0` and
 * `blockedBy: []` both read as "root, nothing blocking it" — which places the
 * row in READY. Defaulting there would make the division assert something it
 * never checked, and the failure is invisible: the row looks judgeable and the
 * write path refuses it. `rule:discernment-checks` §2 — absence is attributable.
 *
 * These tests are PURE. They never call readEvents, so they cannot touch the
 * production ledger (G56) regardless of how they are run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildQueue, orderFor } from "../../lib/report/queue.mjs";

/** Two chains plus a singleton: a→b→c, d→e, and a lone f. */
const row = (id, from, to, state) => ({
  edge_id: id,
  node_id: "ws:" + from,
  state,
  source: { path: "/r/" + from },
  downstream: { path: "/r/" + to },
  why: null,
});

const ROWS = [
  row("e-ab", "a.md", "b.md", "DRIFTED"),    // root
  row("e-bc", "b.md", "c.md", "REVERSED"),   // blocked by e-ab
  row("e-de", "d.md", "e.md", "DIVERGED"),   // root
  row("e-f", "f.md", "g.md", "DRIFTED"),     // root, isolated
  row("e-clean", "h.md", "i.md", "CLEAN"),   // not actionable at all
];

test("READY + BLOCKED == the actionable set, with nothing unplaced", () => {
  const order = orderFor(ROWS);
  const items = buildQueue(ROWS, new Map(), { root: "/r/", order });

  assert.equal(items.length, 4, "CLEAN is not actionable and must not appear");
  const ready = items.filter((i) => i.blocked === false);
  const blocked = items.filter((i) => i.blocked === true);
  assert.equal(ready.length + blocked.length, items.length,
    "every actionable row is in exactly one of the two halves");
  assert.equal(items.filter((i) => i.orderMissing !== null).length, 0);
});

test("a downstream of an unsettled source is BLOCKED, and names its blocker", () => {
  const order = orderFor(ROWS);
  const items = buildQueue(ROWS, new Map(), { root: "/r/", order });
  const bc = items.find((i) => i.edge_id === "e-bc");
  assert.equal(bc.blocked, true);
  // blockedBy carries whole blocker OBJECTS, not bare ids — deliberately, so a
  // BLOCKED row can render "waiting on a.md -> b.md (DRIFTED)" without a second
  // lookup against a list it may not have loaded.
  assert.deepEqual(bc.blockedBy.map((b) => b.edge_id), ["e-ab"]);
  assert.deepEqual(bc.blockedBy[0], { edge_id: "e-ab", from: "/r/a.md", to: "/r/b.md", state: "DRIFTED" },
    "enough to render the blocker on the row");
  assert.equal(items.find((i) => i.edge_id === "e-ab").blocked, false, "the root is not blocked");
});

test("rows come back in fixOrder sequence — the top row IS the next action", () => {
  // The whole redesign rests on "start at the top". A noise-based re-sort, which
  // is what this function did before, quietly breaks that promise: it can put a
  // layer-2 row above an unstarted layer-0 one.
  const order = orderFor(ROWS);
  const items = buildQueue(ROWS, new Map(), { root: "/r/", order });
  assert.ok(items.every((x, i, a) => i === 0 || a[i - 1].orderIndex <= x.orderIndex),
    "monotonic in orderIndex");
  assert.equal(items[0].layer, 0, "a root sorts first");
  assert.ok(items[items.length - 1].layer >= items[0].layer);
});

test("an actionable row the worklist omits is NULL and says so — never silently READY", () => {
  // Constructed directly: an order map that knows about only one of the four.
  // Both sides filter on isActionable so this should not happen, which is
  // exactly why it must be detected rather than assumed away.
  const partial = new Map([["e-ab", { index: 0, layer: 0, blockedBy: [] }]]);
  const items = buildQueue(ROWS, new Map(), { root: "/r/", order: partial });
  const orphan = items.find((i) => i.edge_id === "e-bc");
  assert.equal(orphan.layer, null, "not 0 — 0 would read as a root");
  assert.equal(orphan.blockedBy, null, "not [] — [] would read as nothing blocking");
  assert.equal(orphan.blocked, null, "not false — false would place it in READY");
  assert.match(orphan.orderMissing, /absent from the fix-order worklist/);
});

test("no order map at all is a DIFFERENT absence from an omitted row", () => {
  // "I was not given a worklist" and "the worklist did not contain this edge"
  // are different facts; a single null for both would hide a real join failure.
  const items = buildQueue(ROWS, new Map(), { root: "/r/" });
  assert.match(items[0].orderMissing, /no worklist supplied/);
  assert.ok(items.every((i) => i.layer === null && i.blocked === null));
});

test("without an order map the old noise sort is preserved exactly", () => {
  // tests/cli/ui-queue.test.mjs calls buildQueue with no order map. Changing
  // the fallback ordering would break it for a reason unrelated to this change.
  const hist = new Map([
    ["e-ab", { total: 4, noChange: 4, last: null, lastVerified: null, dispositions: [] }],
    ["e-de", { total: 1, noChange: 0, last: null, lastVerified: null, dispositions: [] }],
  ]);
  const items = buildQueue(ROWS, hist, { root: "/r/" });
  const noise = items.map((i) => i.noiseRatio ?? -1);
  assert.deepEqual([...noise].sort((a, b) => a - b), noise, "ascending noise, heaviest last");
  assert.equal(items[items.length - 1].edge_id, "e-ab", "4 of 4 no-op sinks to the bottom");
});

// ── N89: the worklist orders by severity, not by the alphabet ─────────────

test("within a layer, REVERSED outranks DRIFTED — severity, not name", async () => {
  // THE DEFECT THIS FIXES, and it was live rather than hypothetical. fixOrder
  // sorted with `state.localeCompare`, and the two orderings diverge at the
  // second position:
  //
  //   alphabetical   DIVERGED, DRIFTED,  REVERSED, UNMATCHED
  //   severity       DIVERGED, REVERSED, DRIFTED,  UNMATCHED
  //
  // Both DRIFTED and REVERSED are live on this tree, so a person working the
  // list top-down was being handed the less severe of the two first.
  const { STATE_SEVERITY, severityRank } = await import("../../lib/graph/graph.mjs");
  assert.ok(STATE_SEVERITY.indexOf("REVERSED") < STATE_SEVERITY.indexOf("DRIFTED"),
    "the ranking itself must put REVERSED first, or this test proves nothing");
  assert.ok("DIVERGED".localeCompare("DRIFTED") < 0 && "DRIFTED".localeCompare("REVERSED") < 0,
    "and the alphabet must still disagree, or the bug could not have existed");

  const rows = [
    row("e-d", "x.md", "a.md", "DRIFTED"),
    row("e-r", "x.md", "b.md", "REVERSED"),
    row("e-v", "x.md", "c.md", "DIVERGED"),
  ];
  const order = orderFor(rows);
  const items = buildQueue(rows, new Map(), { root: "/r/", order });
  assert.deepEqual(items.map((i) => i.state), ["DIVERGED", "REVERSED", "DRIFTED"],
    "worst first, by STATE_SEVERITY");
});

test("an unranked state sorts LAST, not first", async () => {
  // severityRank returns the list length for anything it does not know. A 0
  // would put an unrecognised state at the top of the worklist and present it
  // as the most urgent thing in the tree.
  const { severityRank, STATE_SEVERITY } = await import("../../lib/graph/graph.mjs");
  assert.equal(severityRank("DIVERGED"), 0);
  assert.equal(severityRank("NOT_A_REAL_STATE"), STATE_SEVERITY.length);
  assert.ok(severityRank("NOT_A_REAL_STATE") > severityRank("CLEAN"));
});

test("the renderer and the model share ONE ranking", async () => {
  // graph-html.mjs held the only copy while graph.mjs sorted by name. Two
  // definitions of "worse" is the same shape as two definitions of the
  // hub/workspace line, and this is the import that prevents it.
  const html = readFileSync(new URL("../../lib/graph/graph-html.mjs", import.meta.url), "utf8");
  assert.match(html, /import \{ STATE_SEVERITY \} from "\.\/graph\.mjs"/,
    "the renderer must import the ranking");
  assert.doesNotMatch(html, /const STATE_SEVERITY\s*=/,
    "and must not declare a second one");
});
