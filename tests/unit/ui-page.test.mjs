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
const script = (html.match(/<script>([\s\S]*?)<\/script>/) ?? [])[1];

test("the page emits exactly one inline script, and it PARSES", () => {
  assert.ok(script, "no inline script found — this check has gone blind");
  assert.doesNotThrow(() => new Script(script), "the served JS does not parse; the whole page is dead");
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
  for (const v of ["queue", "issues", "todos"]) {
    assert.ok(script.includes(`"${v}"`), `the page must know about the ${v} view`);
  }
});
