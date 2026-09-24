/**
 * tokens.mjs — the one markdown tokenizer the register readers share.
 *
 * WHY THIS EXISTS. 24 modules in this repo read markdown and find their structure
 * with 97 line-anchored regexes of their own. Every hazard therefore has 24 places
 * to live, and in two days that produced: a `## Finished` convention documented in
 * two files and implemented in neither; a prose line that wrapped so its literal
 * landed at a line start and closed every entry below it (G69); a reader counting
 * 87 prose tokens as 68 items (PR-006).
 *
 * WHY IT IS EXTRACTED FROM `handovers.mjs` SPECIFICALLY. That parser is the one
 * that got things wrong in public and was hardened for it, so its two bounds are
 * paid-for knowledge rather than guesses:
 *
 *   MARKER_WINDOW  "WITHOUT THIS BOUND THE PARSER LIES, and it did" — run against
 *                  the live 1,085-line HANDOVERS.md it reported 2 sections closed
 *                  and BOTH were false: one matched a sub-item's marker deep in a
 *                  body, the other matched the word mid-sentence in flowing prose.
 *   FENCE          documenting the marker protocol INSIDE HANDOVERS.md minted a
 *                  phantom section — a dated heading and a `**Resolved:**` both
 *                  inside a fence — and it reported CLOSED, the one state that must
 *                  never be wrong (N51). 16 sections became 17.
 *
 * `closed` is the state that makes work disappear, so it is the one these bounds
 * protect.
 */

/** ``` or ~~~, with or without an info string. */
const FENCE_RE = /^\s*(```|~~~)/;

/**
 * The words that mean "this is finished", in ONE place.
 *
 * Today the repo spells this idea at least three times — `CLOSED_SECTION_RE` and
 * `CLOSED_MARKERS_RE` in `backlog.mjs`, plus its first-body-line rule — and the
 * spellings had already diverged: only one of them contained "finish", which is
 * why a `## Finished` heading closed nothing for id-keyed files while two TODOS
 * headers promised it would.
 */
export const CLOSING_WORDS = Object.freeze([
  "archiv",
  "resolved",
  "done",
  "cancelled",
  "canceled",
  "closed",
  "complete",
  "finish",
  "shipped",
  "superseded",
  "landed",
  "withdrawn",
]);

const CLOSING_RE = new RegExp(`\\b(${CLOSING_WORDS.join("|")})`, "i");

/** Does this text declare something finished? */
export function hasClosingWord(text) {
  return CLOSING_RE.test(String(text ?? ""));
}

/**
 * Headings and fenced regions of a document.
 *
 * A heading inside a fence is NOT a heading — it is an illustration. But the
 * fenced lines are still REPORTED (`fenced`), because callers measuring a window
 * need to know the distance they consumed.
 *
 * `reason` is non-null when the document yielded nothing and there is something to
 * say about why. "Found no headings" and "there was nothing to read" are different
 * facts (`rule:discernment-checks` §2), and 3 of this tree's 105 register files
 * currently parse to an unknown shape that aggregates as zero.
 *
 * @param {string} text
 * @returns {{headings: Array<{depth: number, text: string, line: number}>, fenced: Set<number>, lines: string[], reason: string|null}}
 */
export function scanStructure(text) {
  const raw = String(text ?? "");
  const lines = raw.split("\n");
  const headings = [];
  const fenced = new Set();
  let inFence = false;

  lines.forEach((line, i) => {
    if (FENCE_RE.test(line)) {
      // The delimiter itself is fenced: it is not content, and a caller counting
      // distance should count it.
      inFence = !inFence;
      fenced.add(i + 1);
      return;
    }
    if (inFence) {
      fenced.add(i + 1);
      return;
    }
    const m = line.match(/^(#{1,6})\s+(.*)$/);
    if (m) headings.push({ depth: m[1].length, text: m[2].trim(), line: i + 1 });
  });

  let reason = null;
  if (raw.trim() === "") reason = "empty document";
  else if (headings.length === 0) reason = "no headings — this document has no structure this reader understands";

  return { headings, fenced, lines, reason };
}

/**
 * Find a marker belonging to the heading at `headingLine` (1-indexed).
 *
 * The window counts NON-EMPTY lines and **fenced lines consume it without being
 * matched**. That is deliberate and is `handovers.mjs`'s rule verbatim: a
 * section-level marker belongs directly under its heading, before any
 * illustration, so a code block sitting between them is exactly the distance the
 * window exists to measure. Not consuming it would widen the window by an
 * arbitrary amount and reopen the false-close door from a third side.
 *
 * @param {string[]} lines the whole document, split
 * @param {number} headingLine 1-indexed line of the heading
 * @param {number} window how many non-empty lines may still carry the marker
 * @param {RegExp} re must expose the value as capture group 1
 * @returns {{value: string, line: number}|null}
 */
export function markerInWindow(lines, headingLine, window, re) {
  let seen = 0;
  let inFence = false;
  for (let i = headingLine; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      seen++; // consumes the window
      if (seen > window) return null;
      continue;
    }
    if (line.trim() === "") continue;
    seen++;
    if (seen > window) return null;
    if (inFence) continue; // consumed above, never matched
    if (/^(#{1,6})\s+/.test(line)) return null; // the next section began
    const m = line.match(re);
    if (m) return { value: m[1].trim(), line: i + 1 };
  }
  return null;
}
