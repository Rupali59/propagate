/**
 * graph.mjs — the DAG derivation over reconcile()'s rows.
 *
 * See ~/.claude/plans/okay-pln-these-out-zany-rain.md.
 *
 * propagate has always had a graph and never knew it. 23 sidecars declare 235
 * edges that expand to 710 couplings over 561 files, and every consumer
 * (`status`, `check`, `reconcile`, `verify`) treats each edge as an
 * independent fact. Nothing computed reachability or ordering — so nothing
 * could notice that verifying edge B->C while A->B is still DRIFTED pins C
 * against a B that is not yet correct. Measured 2026-08-17: 4 of the 23
 * non-CLEAN edges are in exactly that position.
 *
 * PURE. No filesystem, no git, no event store, no config import. Rows in,
 * derived graph out — so every property below is testable against a synthetic
 * fixture with no tree on disk. That is deliberate: the ordering guard in
 * `verify` depends on this being provably right, and a module that reads the
 * world cannot be proven against a fixture.
 *
 * TWO TRAPS THIS FILE IS BUILT AGAINST, both paid for already:
 *
 * 1. LAYERING IS LONGEST-PATH-FROM-ROOT, NOT OUT-DEPTH. The exploratory pass
 *    that produced the baseline numbers measured out-depth ("how far can I get
 *    from here"), which is the mirror image and answers a different question.
 *    A fix order needs the opposite: a node may only be verified once EVERY
 *    inbound edge is settled, so it must sit strictly below its deepest
 *    source. On the fixture A->B, A->C, C->B, out-depth puts B at 0; the
 *    correct layer is 2. Do not reuse out-depth code here (GOTCHAS: the
 *    mirror-image trap).
 *
 * 2. A CYCLE MUST NOT MAKE ANYTHING VANISH OR HANG. The tree has one today
 *    (two SSJK-mb plan specs declaring each other). Tarjan runs first and
 *    condenses each strongly-connected component to a single node, so layering
 *    and topological sort are always defined even while the cycle exists. The
 *    component is preserved in `sccs` so `doctor` can name its members and the
 *    page can draw it as one box. Dropping the back-edge would be the G1
 *    failure: the graph would look acyclic and the defect would report success.
 *
 * `blockedBy` walks ancestors transitively with a visited set, so the cycle
 * cannot hang it either.
 */

/** States that mean "this edge is not settled" for ordering purposes. */
const UNSETTLED = new Set(["DRIFTED", "REVERSED", "DIVERGED", "NEVER_VERIFIED", "UNRESOLVABLE"]);

/**
 * States that represent real movement someone should act on. `NEVER_VERIFIED`
 * is deliberately NOT here: 88 of them would drown the 23 edges that moved.
 * It still counts as unsettled for `blockedBy` (an unverified source is not a
 * correct source), and `fixOrder({includeUnverified: true})` opts it back in.
 */
const ACTIONABLE = new Set(["DRIFTED", "REVERSED", "DIVERGED", "UNMATCHED"]);

/** True when this edge state should block a downstream verification. */
export function isUnsettled(state) {
  return UNSETTLED.has(state);
}

/** True when this edge belongs on the default worklist. */
export function isActionable(state) {
  return ACTIONABLE.has(state);
}

/**
 * Label a path with the workspace it belongs to. `workspaceRoots` is optional
 * and, when given, wins by LONGEST matching prefix — nested workspaces
 * (Keerti-portfolio inside the hub) must attribute to the closest one, the
 * same nearest-ancestor rule `findAllSidecarsRecursive` already applies.
 *
 * With no roots supplied, falls back to the first path segment below the
 * common ancestor of all nodes, which is what the hub tree happens to mean by
 * "workspace". Never throws, never returns undefined — an unattributable path
 * gets "<unrooted>", because a silent empty label reads as a real group.
 */
function workspaceFor(absPath, workspaceRoots, commonPrefix) {
  if (workspaceRoots && workspaceRoots.length) {
    let best = null;
    for (const root of workspaceRoots) {
      const withSep = root.endsWith("/") ? root : root + "/";
      if (absPath === root || absPath.startsWith(withSep)) {
        if (!best || root.length > best.length) best = root;
      }
    }
    if (best) return best.split("/").filter(Boolean).pop() || "<unrooted>";
  }
  if (commonPrefix && absPath.startsWith(commonPrefix)) {
    const rest = absPath.slice(commonPrefix.length).replace(/^\/+/, "");
    const seg = rest.split("/")[0];
    // A file sitting directly in the common prefix has no workspace segment of
    // its own — it IS the hub. Naming it after its filename would invent a
    // workspace per file.
    return rest.includes("/") ? seg : "<hub>";
  }
  return "<unrooted>";
}

/** Longest common directory prefix of every path, used only for labelling. */
function commonDirPrefix(paths) {
  if (!paths.length) return "";
  let prefix = paths[0].split("/");
  for (const p of paths.slice(1)) {
    const parts = p.split("/");
    let i = 0;
    while (i < prefix.length && i < parts.length && prefix[i] === parts[i]) i++;
    prefix = prefix.slice(0, i);
  }
  return prefix.join("/");
}

/**
 * Tarjan's strongly-connected components, iterative so a deep chain cannot
 * blow the JS stack. Returns components in reverse topological order, which
 * is Tarjan's natural output and is exactly what the condensation needs.
 *
 * @param {string[]} nodes
 * @param {Map<string, Set<string>>} out
 * @returns {string[][]} every component; length > 1 (or a self-loop) is a cycle
 */
function tarjanSCC(nodes, out) {
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const components = [];
  let counter = 0;

  for (const start of nodes) {
    if (index.has(start)) continue;
    // Explicit work stack: {node, iterator, lastChild}
    const work = [{ node: start, iter: (out.get(start) || new Set()).values(), child: null }];
    index.set(start, counter);
    low.set(start, counter);
    counter++;
    stack.push(start);
    onStack.add(start);

    while (work.length) {
      const frame = work[work.length - 1];
      // Fold in the low-link of the child we just finished recursing into.
      if (frame.child !== null) {
        low.set(frame.node, Math.min(low.get(frame.node), low.get(frame.child)));
        frame.child = null;
      }
      const next = frame.iter.next();
      if (!next.done) {
        const m = next.value;
        if (!index.has(m)) {
          index.set(m, counter);
          low.set(m, counter);
          counter++;
          stack.push(m);
          onStack.add(m);
          frame.child = m;
          work.push({ node: m, iter: (out.get(m) || new Set()).values(), child: null });
        } else if (onStack.has(m)) {
          low.set(frame.node, Math.min(low.get(frame.node), index.get(m)));
        }
        continue;
      }
      // Frame exhausted — if it is a root, pop its component off the stack.
      work.pop();
      if (low.get(frame.node) === index.get(frame.node)) {
        const comp = [];
        for (;;) {
          const w = stack.pop();
          onStack.delete(w);
          comp.push(w);
          if (w === frame.node) break;
        }
        components.push(comp);
      }
    }
  }
  return components;
}

/**
 * Build the derived graph from reconcile()'s rows.
 *
 * Rows whose downstream did not resolve to a path (an UNMATCHED glob) carry no
 * edge — there is no second endpoint to connect. They are NOT dropped: they
 * are returned in `unmatched` so the page and `fixOrder` can show them, since
 * "this generator matches nothing" is a finding, not an absence (G1/G2).
 *
 * @param {Array} rows - reconcile()'s output rows
 * @param {{workspaceRoots?: string[]}} [opts]
 */
export function buildGraph(rows, opts = {}) {
  const { workspaceRoots } = opts;

  const edges = [];
  const unmatched = [];
  const nodeSet = new Set();
  const out = new Map();
  const inn = new Map();

  for (const r of rows) {
    const from = r.source && r.source.path;
    const to = r.downstream && r.downstream.path;
    if (!from) continue;
    nodeSet.add(from);

    if (!to) {
      unmatched.push({
        edge_id: r.edge_id,
        node_id: r.node_id,
        from,
        glob: r.glob || null,
        state: r.state,
        why: r.why || null,
      });
      continue;
    }
    nodeSet.add(to);

    // A self-edge is a declaration of a file on itself. It cannot be ordered
    // and would make its own node a permanent cycle, so it is recorded and
    // excluded from adjacency rather than silently kept or silently dropped.
    if (from === to) {
      unmatched.push({
        edge_id: r.edge_id,
        node_id: r.node_id,
        from,
        glob: r.glob || null,
        state: r.state,
        why: r.why || null,
        selfEdge: true,
      });
      continue;
    }

    edges.push({
      edge_id: r.edge_id,
      node_id: r.node_id,
      from,
      to,
      state: r.state,
      kind: r.kind || null,
      glob: r.glob || null,
      why: r.why || null,
      sameRepo: r.sameRepo ?? null,
    });
    if (!out.has(from)) out.set(from, new Set());
    out.get(from).add(to);
    if (!inn.has(to)) inn.set(to, new Set());
    inn.get(to).add(from);
  }

  const nodeList = [...nodeSet];
  const prefix = commonDirPrefix(nodeList);

  // ── SCC + condensation ────────────────────────────────────────────────────
  const components = tarjanSCC(nodeList, out);
  const compOf = new Map();
  components.forEach((comp, i) => comp.forEach((n) => compOf.set(n, i)));
  const sccs = components.filter((c) => c.length > 1);

  const condensedOut = new Map();
  const condensedIn = new Map();
  for (const e of edges) {
    const a = compOf.get(e.from);
    const b = compOf.get(e.to);
    if (a === b) continue; // internal to a component — condensed away
    if (!condensedOut.has(a)) condensedOut.set(a, new Set());
    condensedOut.get(a).add(b);
    if (!condensedIn.has(b)) condensedIn.set(b, new Set());
    condensedIn.get(b).add(a);
  }

  // ── Layering: longest path FROM A ROOT, over the condensation ─────────────
  // Kahn's algorithm gives a topological order; relaxing forward along it
  // yields longest-path layers in one pass, and cannot loop because the
  // condensation is acyclic by construction.
  const compIds = components.map((_, i) => i);
  const indeg = new Map(compIds.map((i) => [i, (condensedIn.get(i) || new Set()).size]));
  const queue = compIds.filter((i) => indeg.get(i) === 0);
  const compLayer = new Map(compIds.map((i) => [i, 0]));
  const compTopo = [];

  while (queue.length) {
    const c = queue.shift();
    compTopo.push(c);
    for (const d of condensedOut.get(c) || []) {
      compLayer.set(d, Math.max(compLayer.get(d), compLayer.get(c) + 1));
      indeg.set(d, indeg.get(d) - 1);
      if (indeg.get(d) === 0) queue.push(d);
    }
  }

  // Every component must appear. If one does not, the condensation was not
  // acyclic — which would be a bug in Tarjan, not in the data. Fail loudly
  // rather than returning a partial order that reads as complete.
  if (compTopo.length !== compIds.length) {
    throw new Error(
      `buildGraph: condensation is not acyclic — ${compTopo.length} of ${compIds.length} ` +
        `components ordered. This is an internal invariant failure in tarjanSCC, not a data problem.`,
    );
  }

  const layers = new Map();
  for (const n of nodeList) layers.set(n, compLayer.get(compOf.get(n)));

  const topoOrder = [];
  for (const c of compTopo) for (const n of components[c]) topoOrder.push(n);

  // ── Node records ─────────────────────────────────────────────────────────
  const nodes = new Map();
  for (const n of nodeList) {
    nodes.set(n, {
      absPath: n,
      workspace: workspaceFor(n, workspaceRoots, prefix),
      inDeg: (inn.get(n) || new Set()).size,
      outDeg: (out.get(n) || new Set()).size,
      layer: layers.get(n),
      scc: components[compOf.get(n)].length > 1 ? compOf.get(n) : null,
    });
  }

  const roots = nodeList.filter((n) => !inn.has(n));
  const leaves = nodeList.filter((n) => !out.has(n));
  const interior = nodeList.filter((n) => inn.has(n) && out.has(n));

  const byWorkspace = {};
  for (const e of edges) {
    const w = nodes.get(e.from).workspace;
    byWorkspace[w] = (byWorkspace[w] || 0) + 1;
  }
  const byState = {};
  for (const e of edges) byState[e.state] = (byState[e.state] || 0) + 1;
  for (const u of unmatched) byState[u.state] = (byState[u.state] || 0) + 1;

  // Two declarations of the SAME (from, to) with different `why` — the edge
  // fires twice, is verified twice, and each verification pins the same pair
  // under a different edge_id, so closing one leaves the other open forever.
  // Found on the real tree the day this module landed (2026-08-17): 711 edge
  // records over 710 distinct pairs. Reported, never merged — which of the two
  // `why` strings is right is a human's call.
  const pairIndex = new Map();
  for (const e of edges) {
    const k = `${e.from} ${e.to}`;
    if (!pairIndex.has(k)) pairIndex.set(k, []);
    pairIndex.get(k).push(e);
  }
  const duplicatePairs = [...pairIndex.values()]
    .filter((group) => group.length > 1)
    .map((group) => ({
      from: group[0].from,
      to: group[0].to,
      edges: group.map((e) => ({ edge_id: e.edge_id, why: e.why, state: e.state })),
    }));

  let maxDepth = 0;
  for (const v of layers.values()) maxDepth = Math.max(maxDepth, v);

  return {
    nodes,
    edges,
    unmatched,
    out,
    inn,
    sccs,
    duplicatePairs,
    components,
    compOf,
    condensed: { out: condensedOut, in: condensedIn, layer: compLayer, topo: compTopo },
    layers,
    roots,
    leaves,
    interior,
    topoOrder,
    stats: {
      nodes: nodeList.length,
      edges: edges.length,
      unmatched: unmatched.length,
      roots: roots.length,
      leaves: leaves.length,
      interior: interior.length,
      cycles: sccs.length,
      duplicatePairs: duplicatePairs.length,
      maxDepth,
      byWorkspace,
      byState,
    },
  };
}

/**
 * Ancestor edges of `edgeId`'s SOURCE that are themselves unsettled.
 *
 * Answers the question the ordering guard asks: "if I pin this downstream
 * against this source right now, is the source itself known-good?" Walks
 * inbound edges transitively — a two-hop-away dirty ancestor still means the
 * source may move again — with a visited set so the cycle terminates.
 *
 * Returns [] when the source is a root, or when every ancestor edge is CLEAN.
 *
 * @param {ReturnType<typeof buildGraph>} graph
 * @param {string} edgeId
 * @returns {Array<{edge_id: string, from: string, to: string, state: string}>}
 */
export function blockedBy(graph, edgeId) {
  const edge = graph.edges.find((e) => e.edge_id === edgeId);
  if (!edge) return [];

  // Index inbound edges by their downstream once, rather than re-scanning
  // graph.edges per hop — this is called per selected row in `verify`.
  const inboundEdges = new Map();
  for (const e of graph.edges) {
    if (!inboundEdges.has(e.to)) inboundEdges.set(e.to, []);
    inboundEdges.get(e.to).push(e);
  }

  const blockers = [];
  const seenEdges = new Set([edgeId]);
  const seenNodes = new Set();
  const frontier = [edge.from];

  while (frontier.length) {
    const node = frontier.pop();
    if (seenNodes.has(node)) continue;
    seenNodes.add(node);
    for (const up of inboundEdges.get(node) || []) {
      if (seenEdges.has(up.edge_id)) continue;
      seenEdges.add(up.edge_id);
      if (isUnsettled(up.state)) {
        blockers.push({ edge_id: up.edge_id, from: up.from, to: up.to, state: up.state });
      }
      frontier.push(up.from);
    }
  }
  return blockers;
}

/**
 * The root->leaf worklist: every actionable edge, ordered so that fixing them
 * top to bottom never pins a downstream against an unsettled source.
 *
 * Sorted by the SOURCE's layer ascending (roots first), then by state, then by
 * path for stability — an unstable worklist that reshuffles between runs is
 * one nobody can work through.
 *
 * @param {ReturnType<typeof buildGraph>} graph
 * @param {{includeUnverified?: boolean}} [opts]
 * @returns {{items: Array, excludedUnverified: number}}
 */
export function fixOrder(graph, opts = {}) {
  const { includeUnverified = false } = opts;

  const wanted = (state) =>
    isActionable(state) || (includeUnverified && state === "NEVER_VERIFIED");

  let excludedUnverified = 0;
  const items = [];

  for (const e of graph.edges) {
    if (e.state === "NEVER_VERIFIED" && !includeUnverified) {
      excludedUnverified++;
      continue;
    }
    if (!wanted(e.state)) continue;
    items.push({
      edge_id: e.edge_id,
      node_id: e.node_id,
      from: e.from,
      to: e.to,
      state: e.state,
      layer: graph.layers.get(e.from) ?? 0,
      blockedBy: blockedBy(graph, e.edge_id),
    });
  }
  for (const u of graph.unmatched) {
    if (!wanted(u.state)) continue;
    items.push({
      edge_id: u.edge_id,
      node_id: u.node_id,
      from: u.from,
      to: null,
      glob: u.glob,
      state: u.state,
      layer: graph.layers.get(u.from) ?? 0,
      blockedBy: [],
    });
  }

  items.sort(
    (a, b) =>
      a.layer - b.layer ||
      a.state.localeCompare(b.state) ||
      a.from.localeCompare(b.from) ||
      String(a.to).localeCompare(String(b.to)),
  );

  return { items, excludedUnverified };
}

/**
 * Every ancestor and descendant of one node, for `graph --node`. Both walks
 * are visited-guarded, so the cycle is safe here too.
 *
 * @param {ReturnType<typeof buildGraph>} graph
 * @param {string} absPath
 */
export function neighbourhood(graph, absPath) {
  const walk = (adj) => {
    const seen = new Set();
    const frontier = [absPath];
    while (frontier.length) {
      const n = frontier.pop();
      for (const m of adj.get(n) || []) {
        if (seen.has(m)) continue;
        seen.add(m);
        frontier.push(m);
      }
    }
    return [...seen];
  };
  return { ancestors: walk(graph.inn), descendants: walk(graph.out) };
}
