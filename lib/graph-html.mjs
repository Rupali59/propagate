/**
 * graph-html.mjs — renders a buildGraph() result to ONE self-contained page.
 *
 * Design note: the plan this cited (~/.claude/plans/okay-pln-these-out-zany-rain.md
 * §"Component 3") was later overwritten by the monitor design, so the citation no
 * longer resolves to the graph work. See docs/plans/ for plans that govern this repo.
 *
 * PURE: graph object in, HTML string out. No filesystem, no network, no
 * config — `cli.mjs` owns writing the file. That keeps the whole renderer
 * testable by asserting on a string.
 *
 * SELF-CONTAINED IS A HARD REQUIREMENT, not a preference. All CSS and JS are
 * inline and the data is embedded as JSON. No CDN, no font fetch, no remote
 * image. A page that silently degrades when offline (or behind a strict CSP)
 * is a page that lies about the tree.
 *
 * WHY IT IS TWO LEVELS. Measured 2026-08-17: 561 nodes, 711 edges, and
 * PanditPawanKaushik owns 477 of them while four single nodes have out-degree
 * 79/65/59/58. A force-directed render of that is a hairball that answers no
 * question anyone actually has. So:
 *
 *   Level 1  workspace condensation — ~11 boxes and the handful of edges
 *            that genuinely cross a workspace boundary.
 *   Level 2  one workspace expanded into layered columns L0..Ln, root -> leaf,
 *            with fan-out above FANOUT_BUNDLE collapsed to one bundle node.
 *
 * The layout is computed in the page rather than baked into the SVG, so the
 * same embedded data serves both levels and the filter toggles.
 *
 * THEME. Full light palette on bare `:root`; dark redefined under BOTH
 * `prefers-color-scheme` (guarded against an explicit light choice) and
 * `[data-theme="dark"]`, so an explicit toggle wins in either direction. No
 * colour gets its only definition inside a media query.
 */

/** Fan-out above this collapses to a single bundle node in level 2. */
const FANOUT_BUNDLE = 20;

/** Ordered worst-first; a node takes the worst state among its incident edges. */
const STATE_SEVERITY = [
  "DIVERGED",
  "REVERSED",
  "DRIFTED",
  "UNMATCHED",
  "UNRESOLVABLE",
  "NOT_PRESENT_ON_REF",
  "NEVER_VERIFIED",
  "CLEAN",
];

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Embed JSON safely inside a <script> block. `</script>` and the HTML-comment
 * openers are the two sequences that can break out of a script element even
 * inside a JSON string literal.
 */
function embedJson(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    // U+2028/U+2029 are legal inside a JSON string but terminate a JS line, so
    // an unescaped one in the embedded blob is a syntax error in the page.
    .replace(/[\u2028\u2029]/g, (c) => "\\u" + c.charCodeAt(0).toString(16));
}

/**
 * Reduce the graph to the compact shape the page script consumes. Nodes become
 * indices so 711 edges cost two integers each instead of two absolute paths.
 *
 * @param {ReturnType<import("./graph.mjs").buildGraph>} graph
 * @param {{items: Array, excludedUnverified: number}} order - fixOrder() output
 * @param {{root?: string}} [opts] - `root` is stripped from displayed paths
 */
export function toPageData(graph, order, opts = {}) {
  const root = opts.root ? (opts.root.endsWith("/") ? opts.root : opts.root + "/") : "";
  const rel = (p) => (root && p && p.startsWith(root) ? p.slice(root.length) : p);

  const nodeList = [...graph.nodes.keys()].sort();
  const idx = new Map(nodeList.map((p, i) => [p, i]));

  const worst = new Map();
  const rank = (s) => {
    const i = STATE_SEVERITY.indexOf(s);
    return i === -1 ? STATE_SEVERITY.length : i;
  };
  for (const e of graph.edges) {
    for (const side of [e.from, e.to]) {
      if (!worst.has(side) || rank(e.state) < rank(worst.get(side))) worst.set(side, e.state);
    }
  }
  for (const u of graph.unmatched) {
    if (!worst.has(u.from) || rank(u.state) < rank(worst.get(u.from))) worst.set(u.from, u.state);
  }

  const nodes = nodeList.map((p) => {
    const n = graph.nodes.get(p);
    return {
      p: rel(p),
      w: n.workspace,
      l: n.layer,
      i: n.inDeg,
      o: n.outDeg,
      s: worst.get(p) || "CLEAN",
      c: n.scc !== null ? 1 : 0,
    };
  });

  const edges = graph.edges.map((e) => ({
    a: idx.get(e.from),
    b: idx.get(e.to),
    s: e.state,
    y: e.why || "",
    k: e.kind || "",
    id: e.edge_id,
  }));

  // Workspace aggregates for level 1.
  const wsMap = new Map();
  for (const n of nodes) {
    if (!wsMap.has(n.w)) wsMap.set(n.w, { name: n.w, nodes: 0, edges: 0, byState: {} });
    wsMap.get(n.w).nodes++;
  }
  const wsEdges = new Map(); // "a>b" -> count, for cross-workspace only
  for (const e of graph.edges) {
    const a = graph.nodes.get(e.from).workspace;
    const b = graph.nodes.get(e.to).workspace;
    const rec = wsMap.get(a);
    rec.edges++;
    rec.byState[e.state] = (rec.byState[e.state] || 0) + 1;
    if (a !== b) {
      const k = `${a}>${b}`;
      wsEdges.set(k, (wsEdges.get(k) || 0) + 1);
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    root: root || null,
    stats: graph.stats,
    nodes,
    edges,
    workspaces: [...wsMap.values()].sort((a, b) => b.edges - a.edges),
    crossEdges: [...wsEdges.entries()].map(([k, n]) => {
      const [from, to] = k.split(">");
      return { from, to, n };
    }),
    sccs: graph.sccs.map((c) => c.map(rel)),
    duplicatePairs: graph.duplicatePairs.map((d) => ({
      from: rel(d.from),
      to: rel(d.to),
      edges: d.edges,
    })),
    unmatched: graph.unmatched.map((u) => ({
      from: rel(u.from),
      glob: u.glob,
      state: u.state,
      selfEdge: !!u.selfEdge,
    })),
    fixOrder: order.items.map((i) => ({
      id: i.edge_id,
      from: rel(i.from),
      to: i.to ? rel(i.to) : null,
      glob: i.glob || null,
      state: i.state,
      layer: i.layer,
      blocked: i.blockedBy.map((b) => ({ id: b.edge_id, from: rel(b.from), to: rel(b.to), state: b.state })),
    })),
    excludedUnverified: order.excludedUnverified,
    fanoutBundle: FANOUT_BUNDLE,
  };
}

/**
 * @param {ReturnType<import("./graph.mjs").buildGraph>} graph
 * @param {{items: Array, excludedUnverified: number}} order
 * @param {{root?: string, title?: string}} [opts]
 * @returns {string} a complete HTML document
 */
export function renderGraphHtml(graph, order, opts = {}) {
  const data = toPageData(graph, order, opts);
  const title = opts.title || "propagate — declared coupling graph";
  const s = data.stats;

  const blockedCount = data.fixOrder.filter((i) => i.blocked.length).length;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root {
  --bg: #fbfaf8;      --panel: #ffffff;   --ink: #1a1a19;     --muted: #6b6a67;
  --line: #e2e0dc;    --line-strong: #c8c5be;
  --clean: #4a7c59;   --drift: #c26a1e;   --reverse: #8a6bb8; --diverge: #c0392b;
  --unver: #9a9892;   --unmatched: #b8952a; --absent: #7a8b99;
  --accent: #2f6f8f;  --shadow: 0 1px 2px rgba(0,0,0,.06), 0 4px 12px rgba(0,0,0,.04);
}
:root:not([data-theme="light"]) {
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #16171a;    --panel: #1e2024;   --ink: #e8e6e1;     --muted: #9a978f;
    --line: #2e3138;  --line-strong: #444951;
    --clean: #6fa87f; --drift: #e0913f;   --reverse: #a98cd4; --diverge: #e06c5c;
    --unver: #6e6b66; --unmatched: #d4b445; --absent: #8fa3b3;
    --accent: #6bb0d0; --shadow: 0 1px 2px rgba(0,0,0,.3), 0 4px 14px rgba(0,0,0,.25);
  }
}
:root[data-theme="dark"] {
  --bg: #16171a;    --panel: #1e2024;   --ink: #e8e6e1;     --muted: #9a978f;
  --line: #2e3138;  --line-strong: #444951;
  --clean: #6fa87f; --drift: #e0913f;   --reverse: #a98cd4; --diverge: #e06c5c;
  --unver: #6e6b66; --unmatched: #d4b445; --absent: #8fa3b3;
  --accent: #6bb0d0; --shadow: 0 1px 2px rgba(0,0,0,.3), 0 4px 14px rgba(0,0,0,.25);
}

* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font: 15px/1.55 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
  padding: 2rem 1.25rem 5rem;
}
.wrap { max-width: 1180px; margin: 0 auto; }
h1 { font-size: 1.4rem; margin: 0 0 .2rem; letter-spacing: -.01em; }
h2 { font-size: 1.02rem; margin: 2.4rem 0 .7rem; letter-spacing: -.005em; }
.sub { color: var(--muted); font-size: .85rem; margin-bottom: 1.6rem; }
code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .86em; }

.strip { display: flex; flex-wrap: wrap; gap: .5rem; margin-bottom: .4rem; }
.stat {
  background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
  padding: .55rem .85rem; min-width: 92px; box-shadow: var(--shadow);
}
.stat b { display: block; font-size: 1.35rem; line-height: 1.15; font-variant-numeric: tabular-nums; }
.stat span { color: var(--muted); font-size: .72rem; text-transform: uppercase; letter-spacing: .05em; }
.stat.bad b { color: var(--diverge); }

.bars { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: .9rem 1rem; box-shadow: var(--shadow); }
.bar { display: grid; grid-template-columns: 150px 1fr 52px; align-items: center; gap: .6rem; margin: .28rem 0; }
.bar .lbl { font-size: .78rem; color: var(--muted); }
.bar .track { height: 9px; background: var(--line); border-radius: 5px; overflow: hidden; }
.bar .fill { height: 100%; border-radius: 5px; }
.bar .num { text-align: right; font-variant-numeric: tabular-nums; font-size: .82rem; }

.alert {
  background: var(--panel); border: 1px solid var(--line); border-left: 3px solid var(--diverge);
  border-radius: 8px; padding: .8rem 1rem; margin: .55rem 0; box-shadow: var(--shadow);
}
.alert.warn { border-left-color: var(--unmatched); }
.alert h3 { margin: 0 0 .3rem; font-size: .9rem; }
.alert p { margin: .25rem 0; font-size: .85rem; color: var(--muted); }

.scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
table { border-collapse: collapse; width: 100%; font-size: .85rem; min-width: 720px; }
th, td { text-align: left; padding: .42rem .6rem; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 600; font-size: .72rem; text-transform: uppercase; letter-spacing: .05em; }
tbody tr:hover { background: color-mix(in srgb, var(--accent) 6%, transparent); }
td.n { font-variant-numeric: tabular-nums; color: var(--muted); white-space: nowrap; }

.pill {
  display: inline-block; padding: .1rem .45rem; border-radius: 4px; font-size: .7rem;
  font-weight: 600; letter-spacing: .02em; color: #fff; white-space: nowrap;
}
.blocked { color: var(--diverge); font-size: .76rem; display: block; margin-top: .2rem; }

.controls { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; margin: .7rem 0; }
button, select {
  font: inherit; font-size: .82rem; padding: .34rem .7rem; border-radius: 6px;
  border: 1px solid var(--line-strong); background: var(--panel); color: var(--ink); cursor: pointer;
}
button.on { background: var(--accent); border-color: var(--accent); color: #fff; }
.legend { display: flex; flex-wrap: wrap; gap: .8rem; font-size: .76rem; color: var(--muted); margin: .5rem 0 0; }
.legend i { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: .3rem; }

.canvas { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; box-shadow: var(--shadow); }
svg { display: block; }
svg text { fill: var(--ink); font-family: ui-sans-serif, -apple-system, sans-serif; }
svg .edge { stroke: var(--line-strong); fill: none; }
svg .box { fill: var(--panel); stroke: var(--line-strong); cursor: pointer; }
svg .box:hover { stroke: var(--accent); stroke-width: 2; }
svg .lane { fill: var(--muted); font-size: 10px; letter-spacing: .06em; }
.empty { color: var(--muted); font-size: .85rem; padding: 1.2rem; text-align: center; }
footer { margin-top: 3rem; color: var(--muted); font-size: .76rem; border-top: 1px solid var(--line); padding-top: .9rem; }
</style>
</head>
<body>
<div class="wrap">
  <h1>propagate — declared coupling graph</h1>
  <div class="sub">
    Derived from <code>reconcile()</code> at ${escapeHtml(data.generatedAt)}${
      data.root ? ` · paths relative to <code>${escapeHtml(data.root)}</code>` : ""
    }.
    Read-only: this page reflects the tree, it never changes it.
  </div>

  <div class="strip">
    <div class="stat"><b>${s.nodes}</b><span>nodes</span></div>
    <div class="stat"><b>${s.edges}</b><span>edges</span></div>
    <div class="stat"><b>${s.roots}</b><span>roots</span></div>
    <div class="stat"><b>${s.leaves}</b><span>leaves</span></div>
    <div class="stat"><b>${s.interior}</b><span>interior</span></div>
    <div class="stat"><b>${s.maxDepth}</b><span>max depth</span></div>
    <div class="stat${s.cycles ? " bad" : ""}"><b>${s.cycles}</b><span>cycles</span></div>
    <div class="stat${blockedCount ? " bad" : ""}"><b>${blockedCount}</b><span>out of order</span></div>
  </div>

  <h2>Edge states</h2>
  <div class="bars" id="bars"></div>

  <h2>Structural defects</h2>
  <div id="defects"></div>

  <h2>Fix order — root to leaf</h2>
  <p class="sub" style="margin:.2rem 0 .6rem">
    Sorted by the source's layer, so working top to bottom never pins a downstream against a
    source that is itself unsettled. <strong>${data.excludedUnverified}</strong> NEVER_VERIFIED
    edge(s) excluded from this list — they are a baseline gap, not movement; the graph still
    treats them as unsettled when deciding what blocks what.
  </p>
  <div class="scroll">
    <table id="fixorder"><thead><tr>
      <th>#</th><th>Layer</th><th>State</th><th>Edge</th><th>Why</th>
    </tr></thead><tbody></tbody></table>
  </div>

  <h2>The graph</h2>
  <div class="controls">
    <button id="backBtn" style="display:none">&larr; all workspaces</button>
    <select id="wsPick"><option value="">— pick a workspace —</option></select>
    <button id="dirtyBtn">non-CLEAN only</button>
    <span class="mono" id="viewLabel" style="color:var(--muted);font-size:.8rem"></span>
  </div>
  <div class="canvas scroll"><svg id="svg" width="1120" height="440"></svg></div>
  <div class="legend" id="legend"></div>

  <footer>
    Generated by <code>propagate graph --html</code>. Self-contained: no network requests, no
    external assets. Regenerate rather than edit — this file has no memory of its own.
  </footer>
</div>

<script type="application/json" id="data">${embedJson(data)}</script>
<script>
(function () {
  "use strict";
  var D = JSON.parse(document.getElementById("data").textContent);

  var COLORS = {
    CLEAN: "var(--clean)", DRIFTED: "var(--drift)", REVERSED: "var(--reverse)",
    DIVERGED: "var(--diverge)", NEVER_VERIFIED: "var(--unver)",
    UNMATCHED: "var(--unmatched)", NOT_PRESENT_ON_REF: "var(--absent)",
    UNRESOLVABLE: "var(--absent)"
  };
  var color = function (s) { return COLORS[s] || "var(--muted)"; };
  var base = function (p) { return String(p).split("/").pop(); };

  // ── state histogram ─────────────────────────────────────────────────────
  var order = ["CLEAN","NEVER_VERIFIED","NOT_PRESENT_ON_REF","DIVERGED","REVERSED","DRIFTED","UNMATCHED","UNRESOLVABLE"];
  var total = 0, k;
  for (k in D.stats.byState) total += D.stats.byState[k];
  var barsHtml = "";
  order.forEach(function (st) {
    var n = D.stats.byState[st] || 0;
    if (!n) return;
    var pct = total ? (n / total * 100) : 0;
    barsHtml += '<div class="bar"><span class="lbl">' + st + '</span>' +
      '<span class="track"><span class="fill" style="width:' + pct.toFixed(2) + '%;background:' + color(st) + '"></span></span>' +
      '<span class="num">' + n + '</span></div>';
  });
  document.getElementById("bars").innerHTML = barsHtml;

  // ── structural defects ──────────────────────────────────────────────────
  var dHtml = "";
  D.sccs.forEach(function (c) {
    dHtml += '<div class="alert"><h3>Cycle — ' + c.length + ' mutually declared files</h3>' +
      '<p>No canonical direction exists for these, so no fix order does either. ' +
      'They are condensed to one node for layering; one side still needs to be named canonical.</p>' +
      c.map(function (p) { return '<p class="mono">' + p + '</p>'; }).join("") + '</div>';
  });
  D.duplicatePairs.forEach(function (d) {
    dHtml += '<div class="alert"><h3>Declared twice</h3>' +
      '<p class="mono">' + d.from + ' &rarr; ' + d.to + '</p>' +
      '<p>The same coupling under two edge ids, so closing one leaves the other open forever. ' +
      'Reasons given:</p>' +
      d.edges.map(function (e) { return '<p class="mono">' + e.id + " — " + (e.why || "(no why)") + '</p>'; }).join("") +
      '</div>';
  });
  D.unmatched.forEach(function (u) {
    dHtml += '<div class="alert warn"><h3>' + (u.selfEdge ? "Self-edge" : "Glob matches nothing") + '</h3>' +
      '<p class="mono">' + u.from + (u.glob ? ' &rarr; ' + u.glob : "") + '</p>' +
      '<p>' + (u.selfEdge
        ? "A file declared as its own downstream — it cannot be ordered."
        : "The declaration is live but reaches zero files. Honest adoption signal, not an error.") + '</p></div>';
  });
  document.getElementById("defects").innerHTML =
    dHtml || '<div class="alert" style="border-left-color:var(--clean)"><h3>None</h3>' +
    '<p>No cycles, no duplicate declarations, no unmatched globs.</p></div>';

  // ── fix order table ─────────────────────────────────────────────────────
  var tb = document.querySelector("#fixorder tbody");
  if (!D.fixOrder.length) {
    tb.innerHTML = '<tr><td colspan="5" class="empty">Nothing actionable — every declared edge is CLEAN.</td></tr>';
  } else {
    tb.innerHTML = D.fixOrder.map(function (i, n) {
      var target = i.to ? i.to : "(glob: " + i.glob + ")";
      var blocked = i.blocked.length
        ? '<span class="blocked">blocked by ' + i.blocked.length + ': ' +
          i.blocked.map(function (b) { return base(b.from) + "&rarr;" + base(b.to); }).join(", ") + '</span>'
        : "";
      return '<tr><td class="n">' + (n + 1) + '</td><td class="n">L' + i.layer + '</td>' +
        '<td><span class="pill" style="background:' + color(i.state) + '">' + i.state + '</span></td>' +
        '<td class="mono">' + i.from + ' &rarr; ' + target + blocked + '</td>' +
        '<td class="n" style="white-space:normal">' + (i.blocked.length ? "fix its upstream first" : "ready") + '</td></tr>';
    }).join("");
  }

  // ── legend ──────────────────────────────────────────────────────────────
  document.getElementById("legend").innerHTML = order.filter(function (st) {
    return D.stats.byState[st];
  }).map(function (st) {
    return '<span><i style="background:' + color(st) + '"></i>' + st + '</span>';
  }).join("");

  // ── graph rendering ─────────────────────────────────────────────────────
  var SVG = "http://www.w3.org/2000/svg";
  var svg = document.getElementById("svg");
  var viewLabel = document.getElementById("viewLabel");
  var dirtyOnly = false;
  var current = null; // null = level 1

  function el(name, attrs, text) {
    var n = document.createElementNS(SVG, name);
    for (var a in attrs) n.setAttribute(a, attrs[a]);
    if (text != null) n.textContent = text;
    return n;
  }
  function clear() { while (svg.firstChild) svg.removeChild(svg.firstChild); }
  function isDirty(st) { return st !== "CLEAN"; }

  function defsArrow() {
    var defs = el("defs", {});
    var m = el("marker", {
      id: "arrow", viewBox: "0 0 10 10", refX: "9", refY: "5",
      markerWidth: "6", markerHeight: "6", orient: "auto-start-reverse"
    });
    m.appendChild(el("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: "var(--line-strong)" }));
    defs.appendChild(m);
    return defs;
  }

  // Level 1 — workspaces as boxes, cross-workspace edges between them.
  function renderWorkspaces() {
    clear();
    var ws = D.workspaces.slice();
    var perRow = 4, boxW = 250, boxH = 92, gapX = 26, gapY = 26, padX = 24, padY = 30;
    var rows = Math.ceil(ws.length / perRow);
    var W = padX * 2 + perRow * boxW + (perRow - 1) * gapX;
    var H = padY * 2 + rows * boxH + (rows - 1) * gapY;
    svg.setAttribute("width", W); svg.setAttribute("height", H);
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    svg.appendChild(defsArrow());

    var pos = {};
    ws.forEach(function (w, i) {
      var r = Math.floor(i / perRow), c = i % perRow;
      pos[w.name] = { x: padX + c * (boxW + gapX), y: padY + r * (boxH + gapY), w: boxW, h: boxH };
    });

    // cross-workspace edges first, so boxes paint over them
    D.crossEdges.forEach(function (e) {
      var a = pos[e.from], b = pos[e.to];
      if (!a || !b) return;
      var x1 = a.x + a.w / 2, y1 = a.y + a.h, x2 = b.x + b.w / 2, y2 = b.y;
      var my = (y1 + y2) / 2;
      svg.appendChild(el("path", {
        class: "edge",
        d: "M " + x1 + " " + y1 + " C " + x1 + " " + my + ", " + x2 + " " + my + ", " + x2 + " " + y2,
        "marker-end": "url(#arrow)", "stroke-width": Math.min(4, 1 + e.n / 2), opacity: ".65"
      }));
    });

    ws.forEach(function (w) {
      var p = pos[w.name];
      var g = el("g", {});
      g.appendChild(el("rect", { class: "box", x: p.x, y: p.y, width: p.w, height: p.h, rx: 9 }));
      g.appendChild(el("text", { x: p.x + 14, y: p.y + 26, "font-size": "13", "font-weight": "600" }, w.name));
      g.appendChild(el("text", { x: p.x + 14, y: p.y + 45, "font-size": "11", fill: "var(--muted)" },
        w.edges + " edges · " + w.nodes + " nodes"));

      // state chip row, proportional
      var chipY = p.y + 58, chipX = p.x + 14, chipW = p.w - 28;
      order.forEach(function (st) {
        var n = w.byState[st] || 0;
        if (!n) return;
        var seg = chipW * (n / w.edges);
        g.appendChild(el("rect", { x: chipX, y: chipY, width: Math.max(2, seg), height: 8, rx: 3, fill: color(st) }));
        chipX += seg + 1;
      });
      g.appendChild(el("text", { x: p.x + 14, y: p.y + 84, "font-size": "10", fill: "var(--muted)" }, "click to expand"));
      g.style.cursor = "pointer";
      g.addEventListener("click", function () { open(w.name); });
      svg.appendChild(g);
    });

    viewLabel.textContent = ws.length + " workspaces · " + D.crossEdges.length + " cross-workspace edges";
    document.getElementById("backBtn").style.display = "none";
    document.getElementById("wsPick").value = "";
  }

  // Level 2 — one workspace, layered L0..Ln, fan-out bundled.
  function renderWorkspace(name) {
    clear();
    var keep = [];
    D.nodes.forEach(function (n, i) { if (n.w === name) keep.push(i); });
    var inSet = {};
    keep.forEach(function (i) { inSet[i] = true; });

    var edges = D.edges.filter(function (e) {
      if (!(inSet[e.a] || inSet[e.b])) return false;
      if (dirtyOnly && !isDirty(e.s)) return false;
      return true;
    });

    // Bundle any source whose fan-out inside this view exceeds the threshold.
    var outCount = {};
    edges.forEach(function (e) { outCount[e.a] = (outCount[e.a] || 0) + 1; });
    var bundled = {};
    Object.keys(outCount).forEach(function (a) {
      if (outCount[a] > D.fanoutBundle) bundled[a] = outCount[a];
    });

    var shown = [], seen = {};
    function want(i) { if (!seen[i]) { seen[i] = true; shown.push(i); } }
    var drawn = [];
    edges.forEach(function (e) {
      if (bundled[e.a]) return;
      want(e.a); want(e.b); drawn.push(e);
    });
    Object.keys(bundled).forEach(function (a) { want(Number(a)); });

    if (!shown.length) {
      svg.setAttribute("width", 1120); svg.setAttribute("height", 120);
      svg.setAttribute("viewBox", "0 0 1120 120");
      svg.appendChild(el("text", { x: 40, y: 64, "font-size": "13", fill: "var(--muted)" },
        dirtyOnly ? "No non-CLEAN edges in " + name + "." : "No edges in " + name + "."));
      viewLabel.textContent = name + " — nothing to draw";
      return;
    }

    // Group by layer, renormalised so the workspace's own minimum is column 0.
    var minL = Infinity;
    shown.forEach(function (i) { minL = Math.min(minL, D.nodes[i].l); });
    var cols = {};
    shown.forEach(function (i) {
      var c = D.nodes[i].l - minL;
      (cols[c] = cols[c] || []).push(i);
    });
    var colKeys = Object.keys(cols).map(Number).sort(function (a, b) { return a - b; });

    var colW = 268, rowH = 30, padX = 24, padY = 42, nodeW = 232, nodeH = 22;
    var maxRows = 0;
    colKeys.forEach(function (c) { maxRows = Math.max(maxRows, cols[c].length + (bundleRows(c))); });
    function bundleRows(c) {
      var n = 0;
      cols[c].forEach(function (i) { if (bundled[i]) n++; });
      return n;
    }
    var W = padX * 2 + colKeys.length * colW;
    var H = Math.max(240, padY + maxRows * rowH + 60);
    svg.setAttribute("width", W); svg.setAttribute("height", H);
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    svg.appendChild(defsArrow());

    var pos = {};
    colKeys.forEach(function (c, ci) {
      cols[c].sort(function (a, b) { return D.nodes[a].p.localeCompare(D.nodes[b].p); });
      cols[c].forEach(function (i, ri) {
        pos[i] = { x: padX + ci * colW, y: padY + ri * rowH };
      });
      svg.appendChild(el("text", { class: "lane", x: padX + ci * colW, y: 26 }, "L" + c));
    });

    drawn.forEach(function (e) {
      var a = pos[e.a], b = pos[e.b];
      if (!a || !b) return;
      var x1 = a.x + nodeW, y1 = a.y + nodeH / 2, x2 = b.x, y2 = b.y + nodeH / 2;
      var mx = (x1 + x2) / 2;
      svg.appendChild(el("path", {
        class: "edge",
        d: "M " + x1 + " " + y1 + " C " + mx + " " + y1 + ", " + mx + " " + y2 + ", " + x2 + " " + y2,
        "marker-end": "url(#arrow)",
        stroke: isDirty(e.s) ? color(e.s) : "var(--line-strong)",
        "stroke-width": isDirty(e.s) ? 2 : 1,
        opacity: isDirty(e.s) ? ".95" : ".45"
      })).appendChild(el("title", {}, e.y || e.s));
    });

    shown.forEach(function (i) {
      var n = D.nodes[i], p = pos[i];
      var g = el("g", {});
      g.appendChild(el("rect", {
        x: p.x, y: p.y, width: nodeW, height: nodeH, rx: 5,
        fill: "var(--panel)", stroke: color(n.s), "stroke-width": isDirty(n.s) ? 2 : 1
      }));
      var label = base(n.p);
      if (label.length > 30) label = label.slice(0, 29) + "\\u2026";
      g.appendChild(el("text", { x: p.x + 8, y: p.y + 15, "font-size": "11" }, label));
      if (n.c) g.appendChild(el("text", { x: p.x + nodeW - 16, y: p.y + 15, "font-size": "11", fill: "var(--diverge)" }, "\\u21ba"));
      g.appendChild(el("title", {}, n.p + "  [" + n.s + "]  in:" + n.i + " out:" + n.o + " layer:" + n.l));
      svg.appendChild(g);

      if (bundled[i]) {
        var by = p.y + rowH;
        svg.appendChild(el("path", {
          class: "edge", "marker-end": "url(#arrow)", opacity: ".5",
          d: "M " + (p.x + nodeW) + " " + (p.y + nodeH / 2) + " L " + (p.x + colW - 24) + " " + (by + nodeH / 2)
        }));
        var bg = el("g", {});
        bg.appendChild(el("rect", {
          x: p.x + colW - 24, y: by, width: 150, height: nodeH, rx: 5,
          fill: "var(--panel)", stroke: "var(--line-strong)", "stroke-dasharray": "3 2"
        }));
        bg.appendChild(el("text", { x: p.x + colW - 16, y: by + 15, "font-size": "11", fill: "var(--muted)" },
          bundled[i] + " downstreams"));
        bg.appendChild(el("title", {}, "Fan-out of " + bundled[i] + " collapsed (threshold " + D.fanoutBundle + ")"));
        svg.appendChild(bg);
      }
    });

    var hiddenNote = Object.keys(bundled).length
      ? " · " + Object.keys(bundled).length + " hub(s) bundled"
      : "";
    viewLabel.textContent = name + " — " + shown.length + " nodes, " + drawn.length + " edges drawn" +
      hiddenNote + (dirtyOnly ? " · non-CLEAN only" : "");
    document.getElementById("backBtn").style.display = "";
  }

  function open(name) { current = name; document.getElementById("wsPick").value = name; renderWorkspace(name); }
  function render() { if (current) renderWorkspace(current); else renderWorkspaces(); }

  var pick = document.getElementById("wsPick");
  D.workspaces.forEach(function (w) {
    var o = document.createElement("option");
    o.value = w.name; o.textContent = w.name + " (" + w.edges + ")";
    pick.appendChild(o);
  });
  pick.addEventListener("change", function () {
    if (pick.value) open(pick.value); else { current = null; renderWorkspaces(); }
  });
  document.getElementById("backBtn").addEventListener("click", function () {
    current = null; renderWorkspaces();
  });
  document.getElementById("dirtyBtn").addEventListener("click", function () {
    dirtyOnly = !dirtyOnly;
    this.className = dirtyOnly ? "on" : "";
    render();
  });

  renderWorkspaces();
})();
</script>
</body>
</html>
`;
}
