/**
 * lib/graph-html.mjs — the self-contained page renderer.
 *
 * Pure (graph in, string out), so these assert on the string. Two properties
 * are load-bearing and everything else is cosmetic:
 *
 *   1. SELF-CONTAINED. No external host is reachable from the page. A page
 *      that quietly needs the network is a page that shows a different tree
 *      (or none) depending on where it is opened.
 *   2. COMPLETE. The embedded blob holds every node and edge the graph has.
 *      A renderer that truncates produces a page that looks authoritative and
 *      under-reports — the exact shape of every instrument failure in
 *      rule:discernment-checks §4.
 *
 * Per rule:discernment-checks §1 each test names the input that makes it fail.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildGraph, fixOrder } from "../../lib/graph/graph.mjs";
import { renderGraphHtml, toPageData } from "../../lib/graph/graph-html.mjs";

let seq = 0;
function row(from, to, state = "CLEAN", extra = {}) {
  seq++;
  return {
    node_id: `fixture:${from}`,
    edge_id: extra.edge_id || `e${seq}`,
    source: { path: from, ref: null, contentId: "s", unresolvable: null },
    downstream: { path: to, ref: null, contentId: "d", unresolvable: null },
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

function render(rows, opts) {
  const g = buildGraph(rows, opts);
  return { g, html: renderGraphHtml(g, fixOrder(g), opts) };
}

function embedded(html) {
  const m = html.match(/<script type="application\/json" id="data">([\s\S]*?)<\/script>/);
  assert.ok(m, "the page must carry an embedded data blob");
  return JSON.parse(m[1]);
}

// ---------------------------------------------------------------------------
// 1 — self-contained
// ---------------------------------------------------------------------------

test("the page reaches no external host", () => {
  // FAILING INPUT: add `<script src="https://cdn…">` to the template and this
  // goes red. Verified by doing exactly that.
  const { html } = render([row("/A", "/B", "DRIFTED")]);

  const external = [...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)/g)]
    .map((m) => m[1])
    .filter((u) => /^(https?:)?\/\//.test(u));
  assert.deepEqual(external, [], "no external src/href");

  assert.doesNotMatch(html, /\bfetch\s*\(/, "no fetch()");
  assert.doesNotMatch(html, /XMLHttpRequest/, "no XHR");
  assert.doesNotMatch(html, /new\s+WebSocket/, "no websocket");
  assert.doesNotMatch(html, /@import/, "no CSS @import");
});

test("the embedded script is syntactically valid JavaScript", () => {
  // A page whose script throws on load renders an empty canvas and still
  // "looks fine" above the fold. FAILING INPUT: an unescaped U+2028 in a path,
  // which is legal JSON and a line terminator in JS — that is what embedJson
  // exists for.
  const { html } = render([row("/A/we\u2028ird.md", "/B.md", "DRIFTED")]);
  const m = html.match(/<script>\n([\s\S]*?)<\/script>/);
  assert.ok(m, "page script present");
  assert.doesNotThrow(() => new Function(m[1]), "page script must parse");
  assert.doesNotThrow(() => embedded(html), "embedded JSON must parse");
});

test("a path containing </script> cannot break out of the data block", () => {
  // FAILING INPUT: JSON.stringify alone. `</script>` inside a JSON string
  // still closes the element in an HTML parser.
  const { html } = render([row("/A/</script><img>.md", "/B.md", "DRIFTED")]);
  const scriptOpens = (html.match(/<script/g) || []).length;
  const scriptCloses = (html.match(/<\/script>/g) || []).length;
  assert.equal(scriptOpens, scriptCloses, "script tags must stay balanced");
  assert.doesNotThrow(() => embedded(html));
});

// ---------------------------------------------------------------------------
// 2 — complete
// ---------------------------------------------------------------------------

test("every node and edge reaches the embedded blob", () => {
  // FAILING INPUT: a `.slice(0, 100)` anywhere in toPageData. Verified red.
  const rows = [];
  for (let i = 0; i < 300; i++) rows.push(row(`/n${i}`, `/n${i + 1}`, i % 7 === 0 ? "DRIFTED" : "CLEAN"));
  const { g, html } = render(rows);
  const d = embedded(html);

  assert.equal(d.nodes.length, g.stats.nodes, "node count must match the graph");
  assert.equal(d.edges.length, g.stats.edges, "edge count must match the graph");
  assert.equal(d.stats.nodes, g.stats.nodes);
});

test("the fix order in the page is the same list, in the same order, as fixOrder()", () => {
  // Terminal and page disagreeing about the worklist is worse than having only
  // one of them. FAILING INPUT: sort the page copy differently.
  const rows = [
    row("/A", "/B", "DRIFTED", { edge_id: "ab" }),
    row("/B", "/C", "DRIFTED", { edge_id: "bc" }),
    row("/X", "/Y", "REVERSED", { edge_id: "xy" }),
  ];
  const g = buildGraph(rows);
  const order = fixOrder(g);
  const d = embedded(renderGraphHtml(g, order));
  assert.deepEqual(d.fixOrder.map((i) => i.id), order.items.map((i) => i.edge_id));
});

test("the excluded NEVER_VERIFIED count is stated on the page, not just omitted", () => {
  // FAILING INPUT: drop `excludedUnverified` from toPageData — the page then
  // shows a short worklist with no hint that anything was withheld (G2).
  const g = buildGraph([row("/A", "/B", "DRIFTED"), row("/C", "/D", "NEVER_VERIFIED")]);
  const html = renderGraphHtml(g, fixOrder(g));
  assert.equal(embedded(html).excludedUnverified, 1);
  assert.match(html, /NEVER_VERIFIED\s*\n?\s*edge\(s\) excluded|excluded from this list/);
});

// ---------------------------------------------------------------------------
// Defects are carried through to the page
// ---------------------------------------------------------------------------

test("cycles, duplicate pairs and unmatched globs all reach the page", () => {
  const g = buildGraph([
    row("/X", "/Y", "CLEAN"),
    row("/Y", "/X", "CLEAN"),
    row("/A", "/B", "CLEAN", { edge_id: "d1", why: "one" }),
    row("/A", "/B", "CLEAN", { edge_id: "d2", why: "two" }),
    { ...row("/G", null, "UNMATCHED", { glob: "*/docs/GOTCHAS.md" }),
      downstream: { path: null, ref: null, contentId: null, unresolvable: "unmatched-glob" } },
  ]);
  const d = embedded(renderGraphHtml(g, fixOrder(g)));
  assert.equal(d.sccs.length, 1);
  assert.equal(d.duplicatePairs.length, 1);
  assert.deepEqual(d.duplicatePairs[0].edges.map((e) => e.why).sort(), ["one", "two"]);
  assert.equal(d.unmatched.length, 1);
  assert.equal(d.unmatched[0].glob, "*/docs/GOTCHAS.md");
});

// ---------------------------------------------------------------------------
// Theme — the rule is "no colour defined ONLY inside a media/[data-theme] block"
// ---------------------------------------------------------------------------

test("every theme token has a definition on bare :root", () => {
  // FAILING INPUT: move a token's only definition into the dark media query.
  // The page then renders that colour as `unset` in light mode.
  const { html } = render([row("/A", "/B")]);
  const bare = html.match(/:root \{([\s\S]*?)\}/);
  assert.ok(bare, "a bare :root block must exist");

  const declared = new Set([...bare[1].matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  const used = new Set([...html.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]));
  const missing = [...used].filter((t) => !declared.has(t));
  assert.deepEqual(missing, [], "these tokens are used but never defined on bare :root");
});

test("dark is defined for both prefers-color-scheme and an explicit data-theme", () => {
  const { html } = render([row("/A", "/B")]);
  assert.match(html, /@media \(prefers-color-scheme: dark\)/);
  assert.match(html, /:root:not\(\[data-theme="light"\]\)/, "system dark must not override an explicit light choice");
  assert.match(html, /:root\[data-theme="dark"\]/, "an explicit dark toggle must win");
  assert.match(html, /body\s*\{[^}]*background:\s*var\(--bg\)/, "body needs an explicit background");
});

test("wide content scrolls inside its own container, not the page body", () => {
  const { html } = render([row("/A", "/B")]);
  assert.match(html, /\.scroll\s*\{[^}]*overflow-x:\s*auto/);
  assert.match(html, /class="scroll"/);
});

// ---------------------------------------------------------------------------
// toPageData specifics
// ---------------------------------------------------------------------------

test("paths are made relative to the given root", () => {
  const g = buildGraph([row("/root/a.md", "/root/b.md", "DRIFTED")]);
  const d = toPageData(g, fixOrder(g), { root: "/root" });
  assert.deepEqual(d.nodes.map((n) => n.p).sort(), ["a.md", "b.md"]);
});

test("a node takes the WORST state among its incident edges", () => {
  // /B is downstream of one CLEAN and one DIVERGED edge. Colouring it CLEAN
  // would hide the defect. FAILING INPUT: last-write-wins instead of severity.
  const g = buildGraph([
    row("/A", "/B", "CLEAN"),
    row("/C", "/B", "DIVERGED"),
  ]);
  const d = toPageData(g, fixOrder(g));
  assert.equal(d.nodes.find((n) => n.p === "/B").s, "DIVERGED");
});

test("an empty graph still renders a valid page", () => {
  const g = buildGraph([]);
  const html = renderGraphHtml(g, fixOrder(g));
  assert.match(html, /<!doctype html>/i);
  assert.equal(embedded(html).nodes.length, 0);
  assert.doesNotThrow(() => new Function(html.match(/<script>\n([\s\S]*?)<\/script>/)[1]));
});
