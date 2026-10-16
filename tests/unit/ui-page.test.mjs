/**
 * The UI page's inline script — does it actually parse?
 *
 * THE BUG THIS EXISTS FOR. `page()` is one large template literal that GENERATES
 * JavaScript. So every escape in it is interpreted twice: once when the template
 * runs, once by the browser. `diff.split("\n")` written naturally in the source
 * became a REAL NEWLINE inside a JS string literal in the served page — a
 * SyntaxError that killed the entire inline script.
 *
 * The symptom was the header stuck on "loading…" forever. Every request returned
 * 200, `/api/registers` answered in 130ms, the server was healthy, and nothing
 * appeared in any log. The only evidence was in the browser's console, which
 * nothing in this repo reads.
 *
 * `node --check commands/ui.mjs` passes throughout — the MODULE is valid; it is
 * the string it builds that is not. Same family as the backtick that closed the
 * widget's className literal, and as the comment in ui.mjs that closed this very
 * template while explaining the hazard. Three instances in one session.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Script, createContext } from "node:vm";
import { readFileSync } from "node:fs";
import path from "node:path";

import { page } from "../../commands/ui.mjs";

const html = page("deadbeef");
// A bare realm the way a browser's global looks to a UMD wrapper: self/window/globalThis all point at it.
const vmContext = () => { const c = createContext({ console }); c.globalThis = c; c.self = c; c.window = c; return c; };
/**
 * SIX SCRIPTS NOW, not one: preact, its hooks, htm, d3, Plot, then the client.
 *
 * This used to take the FIRST match, which quietly became the vendored preact
 * bundle the moment the page grew a vendor stage — so every assertion below
 * would have been checking a third-party file instead of ours. It passed for
 * exactly one run before the count assertion caught it.
 */
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const script = scripts[scripts.length - 1];

test("the page emits its six inline scripts, and EVERY one parses", () => {
  assert.ok(script, "no inline script found — this check has gone blind");
  // Pinned: three vendored globals plus the client. A missing vendor file
  // leaves the client referencing an undefined `preact` and the page renders
  // nothing, with HTTP 200 and a silent console.
  // Overview, 2026-10-16: SIX now, deliberately. d3 and Observable Plot were vendored for the
  // Overview's charts and each is its own script tag, BEFORE the client, so a syntax error in
  // one is attributed to a file and cannot take the others down. The parse loop below covers
  // all six, including the two big minified ones: a truncated copy of either is the failure
  // this guards, and it would show as "Plot is not defined" in a browser console nobody reads.
  assert.equal(scripts.length, 6, "expected preact + hooks + htm + d3 + plot + client");
  scripts.forEach((src, i) => {
    assert.doesNotThrow(() => new Script(src), `inline script ${i} does not parse; the page is dead`);
  });
});

test("the script the page emits is the client FILE, unmodified", () => {
  // REPLACES a quote-balance heuristic that lived here. That check was a crude
  // proxy for "a string is spanning a newline", which was the symptom of code
  // living inside a template literal. The client is a plain file now, so
  // `node --check` validates it directly and the vm parse above validates what
  // is served — the heuristic added nothing and flagged multi-line block
  // comments containing quotes. A check that cries wolf gets deleted, which is
  // how a working check becomes no check; deleting it deliberately is better
  // than keeping it and learning to ignore it.
  const client = readFileSync(path.join(import.meta.dirname, "../../commands/ui.client.js"), "utf8");
  assert.ok(script.includes(client.trim().slice(0, 200)), "the emitted script must BE the client file, not a copy that can drift");
  assert.ok(script.length > 5000, "and the whole of it, not a fragment");
});

test("the template literal is never closed early", () => {
  // A backtick inside page()'s own body truncates the page. The last thing the
  // template emits is the closing body tag, so its presence proves the literal
  // survived to the end.
  assert.match(html, /<\/body><\/html>\s*$/, "the page is TRUNCATED — a backtick closed the literal early");
});

test("every view the page routes is reachable from both fragment spellings", () => {
  // open-ui.sh hands over a ROUTE ("/todos"); a tab click writes a bare name
  // ("todos"). Both must land on the same view, or a widget click silently
  // shows the wrong page — no error, just the wrong content.
  // Asserted as a BEHAVIOUR, not a spelling: the point is that a leading slash
  // is stripped, not which regex does it. The first version pinned the exact
  // source text and broke the moment the regex was rewritten to dodge the
  // escaping problem that caused all this.
  assert.match(script, /slice\(1\)\.replace\([^)]*\)/, "the hash must be normalised before it is matched");
  // NO ESCAPE GUARD HERE ANY MORE, AND THAT IS THE POINT.
  //
  // This used to ban `\/` because the client lived inside page()'s template
  // literal, where escapes were consumed twice and that one collapsed a regex
  // (G65). The client is a plain FILE now, inlined by an array join —
  // `[..., "<script>", js, "</script>", ...].join("")` — so nothing touches its
  // escapes and ordinary regexes are correct.
  //
  // Two replacements were tried and both were wrong: banning `\/` blocked
  // correct code, and banning backticks blocked ordinary comments. A guard that
  // outlives its hazard does not merely waste a line — it blocks correct work
  // and teaches people to route around checks.
  //
  // The real guards are above: the emitted script PARSES, and it IS the client
  // file byte for byte. The template-literal hazard is still live in
  // widget/propagate-queue.jsx, whose className is still a literal, and
  // widget-contract.test.mjs guards that one.
  // Named against the DIVISIONS, not the tabs they replaced. This listed
  // queue/issues/todos and went red the moment the page stopped having them --
  // which is the check working, not the check being brittle.
  //
  // REWRITTEN 2026-10-15 (plan F11), deliberately and not patched: the nine
  // data-source views became judge / unblock / health / activity plus the Explore
  // set. The first loop is the VIEWS the page renders; the second is every hash an
  // older widget build or a bookmark can still send, which must keep resolving so
  // a stale click never lands on a blank page.
  for (const v of ["judge", "unblock", "health", "activity", "registers", "reminders", "graph"]) {
    assert.ok(script.includes(`"${v}"`), `the page must route the ${v} view`);
  }
  for (const old of ["ready", "blocked", "parked", "gap", "analytics", "reference", "stream", "conflicts"]) {
    assert.match(script, new RegExp(`\\b${old}:\\s*"[a-z]+"`), `the old #${old} hash must still redirect to a view`);
  }
});

test("the emitted page has no HTML-entity text in any rendered string (#70.2, plan test 7)", () => {
  // The old list drew its caret as the literal six characters ampersand-hash-9656,
  // because htm text is not HTML: nothing decodes an entity, so the page printed the
  // entity's SOURCE. Asserted on the EMITTED script, the thing the browser runs.
  const entity = /&#\d+;|&#x[0-9a-f]+;|&(?:amp|lt|gt|quot|nbsp|rarr|middot|mdash);/i;
  assert.doesNotMatch(script, entity, "an entity is written as text; use the character itself");
  // The negative control: the same pattern DOES flag the defect it exists for, so a
  // pattern that stopped matching would not read as a clean page.
  assert.match("<span class=\"caret\">&#9656;</span>", entity, "the guard has gone blind to the very defect it names");
  assert.match("a &rarr; b", entity);
});

test("the page carries the id of the build it was read from (F5)", () => {
  assert.match(page("tok", "0123456789abcdef"), /data-build="0123456789abcdef"/);
  assert.match(html, /data-token="deadbeef"/);
});

/* RETIRED 2026-10-15 (plan D5): the three cases that stood here asserted the
   changed-since STREAM view -- its three downstream_on_ref vintage branches, its
   sinceSource labels, and its judgedCount null-versus-zero comparison. D5 removed
   that view: the feed was an echo (148 rows, all by the same author, none open),
   and "new" now lives as a dot on Judge rows. The plan's "Tests retired: none"
   predates D5 and is wrong about this; the properties those cases protected
   (never collapsing "absent" into "unresolved", never printing a 7-day default as
   "everything since you looked") have no surface left to protect. /api/stream and
   /api/seen remain on the server for the CLI and the widget. */

test("the vendored d3 and Plot actually define their globals, d3 first, both before the client (Overview, 2026-10-16)", () => {
  // Parsing is not loading. Plot's UMD build reads the d3 global when it RUNS, so a copy that
  // parses but was truncated, or that is loaded in the wrong order, leaves `Plot` undefined and
  // the Overview showing "chart unavailable" with HTTP 200 and a quiet console. Run the real
  // emitted scripts, in the real order, in a bare realm and ask for the functions the client calls.
  const ctx = vmContext();
  const order = scripts.slice(0, -1);
  assert.equal(order.length, 5, "five vendored scripts precede the client");
  order.forEach((src) => new Script(src).runInContext(ctx));
  for (const g of ["preact", "preactHooks", "htm", "d3"]) assert.ok(ctx[g], `${g} was not defined by its script`);
  for (const f of ["plot", "barX", "barY", "ruleX", "ruleY"]) assert.equal(typeof ctx.Plot?.[f], "function", `Plot.${f} is not a function`);
  // And the order is a dependency: Plot first, d3 second must NOT yield a working Plot.
  const wrong = vmContext();
  const [preact, hooks, htm, d3src, plotsrc] = order;
  for (const src of [preact, hooks, htm, plotsrc]) { try { new Script(src).runInContext(wrong); } catch { /* the failure is the point */ } }
  assert.notEqual(typeof wrong.Plot?.plot, "function", "Plot loaded without d3 in front of it; the order test cannot fail");
  void d3src;
});
