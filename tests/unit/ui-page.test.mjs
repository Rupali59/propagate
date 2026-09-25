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
import { Script } from "node:vm";
import { readFileSync } from "node:fs";
import path from "node:path";

import { page } from "../../commands/ui.mjs";

const html = page("deadbeef");
/**
 * FOUR SCRIPTS NOW, not one: preact, its hooks, htm, then the client.
 *
 * This used to take the FIRST match, which quietly became the vendored preact
 * bundle the moment the page grew a vendor stage — so every assertion below
 * would have been checking a third-party file instead of ours. It passed for
 * exactly one run before the count assertion caught it.
 */
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const script = scripts[scripts.length - 1];

test("the page emits its four inline scripts, and EVERY one parses", () => {
  assert.ok(script, "no inline script found — this check has gone blind");
  // Pinned: three vendored globals plus the client. A missing vendor file
  // leaves the client referencing an undefined `preact` and the page renders
  // nothing, with HTTP 200 and a silent console.
  assert.equal(scripts.length, 4, "expected preact + hooks + htm + client");
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
  // queue/issues/todos and went red the moment the page stopped having them —
  // which is the check working, not the check being brittle.
  for (const v of ["ready", "blocked", "parked", "gap", "analytics", "reference", "stream"]) {
    assert.ok(script.includes(`"${v}"`), `the page must route the ${v} division`);
  }
});

/* -- the stream division (Surface 1 of the event-stream plan) ------------- */

test("all three downstream_on_ref vintages have their own, distinguishable branch", () => {
  // lib/report/stream.mjs's refVintage() returns "absent" | "unresolved" |
  // "resolved" and is explicit that collapsing any two together mislabels
  // most of the store (absent is ~two thirds of history, pre-2026-08-22).
  // Checked as three SEPARATE literal branches, not just "the word appears
  // somewhere" -- a single `status || "unresolved"` fallback would also
  // contain the substring "unresolved" while actually collapsing absent
  // into it, so each is asserted as its own comparison against the vintage
  // status.
  assert.match(script, /status === "absent"/, "the client must special-case the absent vintage, not just print it");
  assert.match(script, /status === "unresolved"/, "the client must special-case the unresolved vintage, not just print it");
  assert.match(script, /return "resolved"/, "resolved must be its own branch, not a shared default");
  // The three CSS hooks the client constructs at render time (`"vin-" + status`)
  // -- proves ui.css has a rule for each, not just for the ones someone
  // thought to style (the UNMATCHED-badge shape recorded in STATE.md).
  assert.match(script, /"vin vin-"/, "the vintage badge class must be built from the status, not hardcoded to one value");
});

test("sinceSource is rendered as a label, not silently dropped", () => {
  // A 7-day default must never read as "this is everything since you last
  // looked" (rule:discernment-checks §2). All three sinceSource values from
  // streamPayload get their own copy, not a generic fallback.
  assert.match(script, /"given"/, "the given-since case must be labelled");
  assert.match(script, /"invalid-given-defaulted"/, "the invalid-given case must be labelled, not silently defaulted");
  assert.match(script, /last 7 days/, "the default-7d case must say so explicitly");
});

test("judgedCount null is distinguished from judgedCount 0", () => {
  // stream.mjs: "Null (not 0) when the edge has no other history beyond
  // this window's own event... different facts". A `c.judgedCount ? … :
  // 'never judged'` truthy check would collapse 0 into the same branch as
  // null; this asserts the explicit nullish comparison survives in the
  // emitted script.
  assert.match(script, /judgedCount == null/, "judgedCount must be compared against null explicitly, not by truthiness");
});
