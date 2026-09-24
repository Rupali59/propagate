/**
 * doc-tokens.test.mjs — §3a of docs/plans/2026-09-24-parser-collapse.md.
 *
 * One tokenizer, extracted from `handovers.mjs` because that is the parser that
 * got things wrong in public and was hardened for it:
 *
 *   MARKER_WINDOW = 3  "WITHOUT THIS BOUND THE PARSER LIES, and it did" — it
 *                      reported 2 sections closed and BOTH were false.
 *   FENCE_RE           documenting the marker protocol inside HANDOVERS.md minted
 *                      a PHANTOM section reporting CLOSED, the one state that must
 *                      never be wrong (N51).
 *
 * 24 modules and 97 line-anchored regexes parse markdown in this repo. Each of
 * those hazards currently has 24 places to live. G69 — a prose line that wrapped
 * into a heading and closed every entry below it — is exactly what FENCE_RE
 * prevents, in a file whose parser has no equivalent.
 *
 * FIXTURES ARE SYNTHETIC, NOT THE LIVE FILE. The plan named HANDOVERS.md's "26
 * sections, unknown: 4" as the baseline. Measured hours later: 28 and unknown 6 —
 * two real sections written by other sessions the same day. A concurrently edited
 * file cannot be a regression fixture, and using one would produce failures that
 * are somebody else's commit.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { scanStructure, markerInWindow, hasClosingWord, CLOSING_WORDS } from "../../lib/docs/tokens.mjs";

const doc = (...lines) => lines.join("\n");

test("headings carry depth, text and 1-indexed line", () => {
  const s = scanStructure(doc("# One", "", "## Two", "### Three"));
  assert.deepEqual(
    s.headings.map((h) => [h.depth, h.text, h.line]),
    [[1, "One", 1], [2, "Two", 3], [3, "Three", 4]],
  );
});

test("a heading inside a FENCE is not a heading — N51's phantom section", () => {
  const s = scanStructure(doc("# Real", "```markdown", "## 2026-08-26 · A thing handed over", "```", "## Also real"));
  assert.deepEqual(s.headings.map((h) => h.text), ["Real", "Also real"]);
  assert.ok(s.fenced.has(3), "the fenced line is reported as fenced, not merely dropped");
});

test("~~~ fences count too, and an unterminated fence swallows the rest", () => {
  const s = scanStructure(doc("# A", "~~~", "## hidden", "## also hidden"));
  assert.deepEqual(s.headings.map((h) => h.text), ["A"]);
});

test("a marker directly under its heading is found", () => {
  const lines = doc("## Section", "", "**Done when:** the thing is true", "more prose").split("\n");
  const m = markerInWindow(lines, 1, 3, /^\s*\*{0,2}Done when:?\*{0,2}\s*:?\s*(.+)$/i);
  assert.equal(m.value, "the thing is true");
  assert.equal(m.line, 3);
});

test("a marker BEYOND the window is not found — the bound that stopped the parser lying", () => {
  const lines = doc("## Section", "a", "b", "c", "d", "**Done when:** too far down").split("\n");
  assert.equal(markerInWindow(lines, 1, 3, /^\s*\*{0,2}Done when:?\*{0,2}\s*:?\s*(.+)$/i), null);
});

test("fenced lines are SKIPPED for matching but still CONSUME the window", () => {
  // handovers.mjs's exact rule: a section-level marker belongs directly under its
  // heading, before any illustration, so a code block between them is precisely
  // the distance the window measures. Not consuming it would widen the window by
  // an arbitrary amount and reopen the false-close door from a third side.
  const lines = doc("## S", "```", "**Done when:** inside a fence", "```", "**Done when:** real but now too far").split("\n");
  assert.equal(markerInWindow(lines, 1, 3, /^\s*\*{0,2}Done when:?\*{0,2}\s*:?\s*(.+)$/i), null);
});

test("closing-word detection lives in ONE place", () => {
  // Today it is at least three: CLOSED_SECTION_RE, CLOSED_MARKERS_RE, and
  // backlog's first-body-line rule. Three spellings of one idea is how the
  // `## Finished` convention ended up documented in two files and implemented in
  // neither.
  assert.ok(CLOSING_WORDS.length >= 8, `only ${CLOSING_WORDS.length} closing words`);
  for (const w of ["done", "resolved", "shipped", "finish", "superseded", "archiv"]) {
    assert.ok(CLOSING_WORDS.some((c) => c.includes(w) || w.includes(c)), `"${w}" must be covered`);
  }
  assert.ok(hasClosingWord("## Finished"), "the word this session proved was missing");
  assert.ok(hasClosingWord("N89 — **RESOLVED 2026-09-21**"));
  assert.ok(!hasClosingWord("PR-004 · Clear the gbrain serve process"), "`Clear` is not a closing word");
});

test("an UNRECOGNISED shape is a refusal, not an empty result", () => {
  // Finding E: 3 of 105 register files parse to `unparsed`, contents UNKNOWN. That
  // must never aggregate as zero — rule:discernment-checks §2.
  const s = scanStructure("");
  assert.deepEqual(s.headings, []);
  assert.equal(s.reason, "empty document", "an empty input says WHY it yielded nothing");
  assert.equal(scanStructure(doc("# Has a heading")).reason, null);
});
