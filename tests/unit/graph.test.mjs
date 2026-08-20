/**
 * lib/graph.mjs — the DAG derivation.
 *
 * Pure module, so every test here is a synthetic fixture: no tmpdir, no
 * subprocess, no tree on disk. That is the point of keeping graph.mjs free of
 * I/O — the ordering guard in `verify` depends on these properties, and a
 * module that reads the world cannot be proven against a fixture.
 *
 * Per rule:discernment-checks §1, each test below names THE INPUT THAT MAKES
 * IT FAIL in a comment, and that input was constructed and run red before the
 * test was considered done. A check that cannot fail is worse than no check.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildGraph, blockedBy, fixOrder, neighbourhood, isUnsettled } from "../../lib/graph/graph.mjs";

// ---------------------------------------------------------------------------
// Fixture helper — the minimum of reconcile()'s row shape that graph.mjs reads.
// ---------------------------------------------------------------------------

let seq = 0;
function row(from, to, state = "CLEAN", extra = {}) {
  seq++;
  return {
    node_id: `fixture:${from}`,
    edge_id: extra.edge_id || `e${seq}`,
    source: { path: from, ref: null, contentId: "s", unresolvable: null },
    downstream: { path: to, ref: null, contentId: "d", unresolvable: to ? null : "unmatched-glob" },
    state,
    since: null,
    last: null,
    deferred: null,
    glob: extra.glob ?? null,
    kind: extra.kind ?? "prose",
    why: extra.why ?? "because",
    sameRepo: true,
    unresolvable: null,
  };
}

// ---------------------------------------------------------------------------
// 1 — layering is longest-path-from-root, not out-depth
// ---------------------------------------------------------------------------

test("layer is longest path FROM A ROOT, so a node sits below its deepest source", () => {
  // A -> B, A -> C, C -> B.  B has two inbound paths: A->B (length 1) and
  // A->C->B (length 2). B must sit below BOTH, so layer(B) = 2.
  //
  // FAILING INPUT: an out-depth implementation ("how far can I get from here")
  // makes B a sink and puts it at layer 0. Verified red against that version.
  const g = buildGraph([row("/A", "/B"), row("/A", "/C"), row("/C", "/B")]);

  assert.equal(g.layers.get("/A"), 0, "A is a root");
  assert.equal(g.layers.get("/C"), 1, "C is one hop from the root");
  assert.equal(g.layers.get("/B"), 2, "B must be below C, not beside it");
  assert.equal(g.stats.maxDepth, 2);
});

test("topological order never places a node before one of its sources", () => {
  const g = buildGraph([row("/A", "/B"), row("/A", "/C"), row("/C", "/B"), row("/B", "/D")]);
  const pos = new Map(g.topoOrder.map((n, i) => [n, i]));
  for (const e of g.edges) {
    assert.ok(
      pos.get(e.from) < pos.get(e.to),
      `${e.from} must be ordered before ${e.to}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2 — a cycle must not hang, and must not vanish
// ---------------------------------------------------------------------------

test("a cycle is condensed, reported, and does not break layering or topo order", () => {
  // W -> X, X <-> Y, Y -> Z. The tree has exactly this shape today, between
  // two SSJK-mb plan specs that declare each other.
  //
  // FAILING INPUT: a naive recursive DFS with no on-stack check either
  // stack-overflows here or silently drops the back-edge, which would make the
  // graph LOOK acyclic — the G1 failure, a defect reporting success.
  const g = buildGraph([
    row("/W", "/X"),
    row("/X", "/Y"),
    row("/Y", "/X"),
    row("/Y", "/Z"),
  ]);

  assert.equal(g.stats.cycles, 1, "the X<->Y component must be reported");
  const comp = g.sccs[0].slice().sort();
  assert.deepEqual(comp, ["/X", "/Y"], "both members must be named, not just counted");

  // Every node still ordered and layered, despite the cycle.
  assert.equal(g.topoOrder.length, 4, "no node may be dropped by condensation");
  assert.equal(g.layers.get("/W"), 0);
  assert.equal(g.layers.get("/X"), 1);
  assert.equal(g.layers.get("/Y"), 1, "cycle members share the condensed layer");
  assert.equal(g.layers.get("/Z"), 2);
});

test("a long chain does not blow the stack (iterative Tarjan)", () => {
  // FAILING INPUT: a recursive Tarjan overflows well before 10k here.
  const rows = [];
  for (let i = 0; i < 10000; i++) rows.push(row(`/n${i}`, `/n${i + 1}`));
  const g = buildGraph(rows);
  assert.equal(g.stats.nodes, 10001);
  assert.equal(g.stats.cycles, 0);
  assert.equal(g.stats.maxDepth, 10000);
});

// ---------------------------------------------------------------------------
// 3 / 4 — blockedBy
// ---------------------------------------------------------------------------

test("blockedBy is transitive — a two-hop dirty ancestor still blocks", () => {
  // A -> B -> C -> D, every edge DRIFTED. Verifying C->D must report BOTH
  // upstream edges, because B may still move after A is fixed.
  //
  // FAILING INPUT: a one-hop implementation returns 1, not 2. Verified red.
  const g = buildGraph([
    row("/A", "/B", "DRIFTED", { edge_id: "ab" }),
    row("/B", "/C", "DRIFTED", { edge_id: "bc" }),
    row("/C", "/D", "DRIFTED", { edge_id: "cd" }),
  ]);
  const blockers = blockedBy(g, "cd").map((b) => b.edge_id).sort();
  assert.deepEqual(blockers, ["ab", "bc"]);
});

test("blockedBy terminates when a cycle sits in the ancestor chain", () => {
  // FAILING INPUT: without the visited set this loops forever and the test
  // times out rather than failing cleanly.
  const g = buildGraph([
    row("/X", "/Y", "DRIFTED", { edge_id: "xy" }),
    row("/Y", "/X", "DRIFTED", { edge_id: "yx" }),
    row("/Y", "/Z", "DRIFTED", { edge_id: "yz" }),
  ]);
  const blockers = blockedBy(g, "yz").map((b) => b.edge_id).sort();
  assert.deepEqual(blockers, ["xy", "yx"]);
});

test("a CLEAN ancestor does not block", () => {
  // FAILING INPUT: an implementation keying on "has any ancestor" rather than
  // "has any UNSETTLED ancestor" returns 1 here. Verified red.
  const g = buildGraph([
    row("/A", "/B", "CLEAN", { edge_id: "ab" }),
    row("/B", "/C", "DRIFTED", { edge_id: "bc" }),
  ]);
  assert.deepEqual(blockedBy(g, "bc"), []);
});

test("a root edge is never blocked", () => {
  const g = buildGraph([row("/A", "/B", "DRIFTED", { edge_id: "ab" })]);
  assert.deepEqual(blockedBy(g, "ab"), []);
});

test("NEVER_VERIFIED counts as unsettled for blocking", () => {
  // An unverified source is not a correct source — pinning against it asserts
  // a consistency nobody has ever checked.
  const g = buildGraph([
    row("/A", "/B", "NEVER_VERIFIED", { edge_id: "ab" }),
    row("/B", "/C", "DRIFTED", { edge_id: "bc" }),
  ]);
  assert.equal(isUnsettled("NEVER_VERIFIED"), true);
  assert.deepEqual(blockedBy(g, "bc").map((b) => b.edge_id), ["ab"]);
});

test("blockedBy on an unknown edge id returns empty rather than throwing", () => {
  const g = buildGraph([row("/A", "/B")]);
  assert.deepEqual(blockedBy(g, "nope"), []);
});

// ---------------------------------------------------------------------------
// 5 — fixOrder
// ---------------------------------------------------------------------------

test("fixOrder is root-to-leaf and annotates what blocks each item", () => {
  const g = buildGraph([
    row("/A", "/B", "DRIFTED", { edge_id: "ab" }),
    row("/B", "/C", "DRIFTED", { edge_id: "bc" }),
  ]);
  const { items } = fixOrder(g);
  assert.deepEqual(items.map((i) => i.edge_id), ["ab", "bc"], "root edge first");
  assert.equal(items[0].blockedBy.length, 0);
  assert.deepEqual(items[1].blockedBy.map((b) => b.edge_id), ["ab"]);
});

test("fixOrder excludes NEVER_VERIFIED by default and REPORTS the count", () => {
  // 88 NEVER_VERIFIED edges would drown the ~23 that actually moved. Excluding
  // them is right; excluding them SILENTLY is the G2 failure.
  //
  // FAILING INPUT: return only `items` with no count — the caller then cannot
  // tell "nothing excluded" from "82 hidden". Verified red against that shape.
  const g = buildGraph([
    row("/A", "/B", "DRIFTED"),
    row("/C", "/D", "NEVER_VERIFIED"),
    row("/E", "/F", "NEVER_VERIFIED"),
  ]);

  const def = fixOrder(g);
  assert.equal(def.items.length, 1);
  assert.equal(def.excludedUnverified, 2, "the exclusion must be attributable");

  const all = fixOrder(g, { includeUnverified: true });
  assert.equal(all.items.length, 3);
  assert.equal(all.excludedUnverified, 0);
});

test("fixOrder is stable across runs", () => {
  const rows = [
    row("/A", "/B", "DRIFTED"),
    row("/A", "/C", "DRIFTED"),
    row("/A", "/D", "REVERSED"),
  ];
  const a = fixOrder(buildGraph(rows)).items.map((i) => `${i.from}->${i.to}`);
  const b = fixOrder(buildGraph(rows)).items.map((i) => `${i.from}->${i.to}`);
  assert.deepEqual(a, b);
});

test("CLEAN edges never appear on the worklist", () => {
  const g = buildGraph([row("/A", "/B", "CLEAN"), row("/C", "/D", "DRIFTED")]);
  const { items } = fixOrder(g);
  assert.equal(items.length, 1);
  assert.equal(items[0].state, "DRIFTED");
});

// ---------------------------------------------------------------------------
// Edges with no second endpoint, and self-edges
// ---------------------------------------------------------------------------

test("an UNMATCHED glob is kept and surfaced, never silently dropped", () => {
  // A glob matching zero files is a finding — the declared coupling reaches
  // nothing. FAILING INPUT: `if (!to) continue;` with no `unmatched` array
  // makes the whole declaration disappear from every count.
  const g = buildGraph([row("/A", null, "UNMATCHED", { glob: "*/docs/GOTCHAS.md" })]);
  assert.equal(g.stats.edges, 0, "no second endpoint, so no adjacency");
  assert.equal(g.stats.unmatched, 1);
  assert.equal(g.unmatched[0].glob, "*/docs/GOTCHAS.md");
  assert.equal(g.stats.byState.UNMATCHED, 1, "still counted in the state histogram");

  const { items } = fixOrder(g);
  assert.equal(items.length, 1, "and still on the worklist");
  assert.equal(items[0].to, null);
});

test("a self-edge is recorded, not turned into a one-node cycle", () => {
  // FAILING INPUT: keeping it in adjacency makes /A its own SCC of size 1 with
  // a self-loop, and cycles would read as 0 while layering silently breaks.
  const g = buildGraph([row("/A", "/A", "DRIFTED")]);
  assert.equal(g.stats.edges, 0);
  assert.equal(g.stats.cycles, 0);
  assert.equal(g.unmatched.length, 1);
  assert.equal(g.unmatched[0].selfEdge, true);
});

// ---------------------------------------------------------------------------
// Duplicate declarations — found on the real tree the day this landed
// ---------------------------------------------------------------------------

test("the same (from,to) declared twice is reported, never merged", () => {
  // Real case 2026-08-17: brand-system.md -> components/README.md declared
  // twice with different `why`, so 711 edge records over 710 distinct pairs.
  // Closing one leaves the other open forever.
  const g = buildGraph([
    row("/A", "/B", "DRIFTED", { edge_id: "one", why: "first reason" }),
    row("/A", "/B", "DRIFTED", { edge_id: "two", why: "second reason" }),
  ]);
  assert.equal(g.stats.edges, 2, "both records survive — merging would hide one");
  assert.equal(g.stats.duplicatePairs, 1);
  assert.deepEqual(
    g.duplicatePairs[0].edges.map((e) => e.why).sort(),
    ["first reason", "second reason"],
    "both reasons must be shown so a human can pick",
  );
});

// ---------------------------------------------------------------------------
// Structure counts and workspace attribution
// ---------------------------------------------------------------------------

test("roots, leaves and interior partition the node set", () => {
  const g = buildGraph([row("/A", "/B"), row("/B", "/C")]);
  assert.deepEqual(g.roots, ["/A"]);
  assert.deepEqual(g.leaves, ["/C"]);
  assert.deepEqual(g.interior, ["/B"]);
  assert.equal(g.stats.roots + g.stats.leaves + g.stats.interior, g.stats.nodes);
});

test("workspace attribution prefers the NEAREST enclosing root", () => {
  // Keerti-portfolio sits inside the hub; a file in it belongs to the closest
  // workspace, not the outermost. Same nearest-ancestor rule
  // findAllSidecarsRecursive already applies to sidecars.
  //
  // FAILING INPUT: first-match-wins ordering attributes the file to /repo,
  // which is how a nested project's 82 edges get folded into its parent's 559.
  const g = buildGraph([row("/repo/inner/a.md", "/repo/outer.md")], {
    workspaceRoots: ["/repo", "/repo/inner"],
  });
  assert.equal(g.nodes.get("/repo/inner/a.md").workspace, "inner");
  assert.equal(g.nodes.get("/repo/outer.md").workspace, "repo");
});

test("an unattributable path is labelled, not left blank", () => {
  const g = buildGraph([row("/somewhere/a.md", "/somewhere/b.md")], {
    workspaceRoots: ["/elsewhere"],
  });
  const w = g.nodes.get("/somewhere/a.md").workspace;
  assert.ok(w && w.length, "a blank label reads as a real group");
});

test("an empty row set yields an empty graph rather than throwing", () => {
  const g = buildGraph([]);
  assert.equal(g.stats.nodes, 0);
  assert.equal(g.stats.edges, 0);
  assert.equal(g.stats.cycles, 0);
  assert.deepEqual(fixOrder(g).items, []);
});

// ---------------------------------------------------------------------------
// neighbourhood
// ---------------------------------------------------------------------------

test("neighbourhood walks both directions transitively and terminates on a cycle", () => {
  const g = buildGraph([
    row("/A", "/B"),
    row("/B", "/C"),
    row("/C", "/B"),
    row("/C", "/D"),
  ]);
  const n = neighbourhood(g, "/C");
  assert.deepEqual(n.ancestors.sort(), ["/A", "/B", "/C"]);
  assert.deepEqual(n.descendants.sort(), ["/B", "/C", "/D"]);
});
