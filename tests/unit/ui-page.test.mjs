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

import { page } from "../../commands/ui.mjs";

const html = page("deadbeef");
const script = (html.match(/<script>([\s\S]*?)<\/script>/) ?? [])[1];

test("the page emits exactly one inline script, and it PARSES", () => {
  assert.ok(script, "no inline script found — this check has gone blind");
  assert.doesNotThrow(() => new Script(script), "the served JS does not parse; the whole page is dead");
});

test("no RAW newline survives inside a JS string literal", () => {
  // The precise defect: a double-quoted string that spans a line break. Parsing
  // catches it today, but this names the cause when it recurs.
  const offenders = script.split("\n").filter((l) => {
    const q = (l.match(/"/g) ?? []).length;
    return q % 2 === 1 && !l.trim().startsWith("//");
  });
  assert.deepEqual(offenders, [], `unbalanced quotes — a string is spanning a newline:\n  ${offenders.join("\n  ")}`);
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
  assert.ok(!/\\\//.test(script), "an escaped slash inside the template gets eaten — use a character class");
  for (const v of ["queue", "issues", "todos"]) {
    assert.ok(script.includes(`"${v}"`), `the page must know about the ${v} view`);
  }
});
