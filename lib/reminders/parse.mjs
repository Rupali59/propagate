/**
 * parse.mjs — pull hashtags out of a reminder body, robust to CR line endings.
 *
 * F3, `docs/plans/2026-09-23-reminders-todo-bridge.md:221-234`. AppleScript's
 * own `return` character is CR (0x0D), not LF — and this session's own write
 * to the live "Claude TODO" list produced a body ending
 * `…gh ENOENT error\r#ccusage`. A `\n`-anchored split makes that tag
 * INVISIBLE: the reminder looks untagged and is silently held for the wrong
 * reason (looks identical to a genuinely untagged item, which is exactly the
 * ambiguity `rule:discernment-checks` §2 warns about).
 *
 * Split on CR, LF and CRLF, in that priority so CRLF is consumed as one
 * separator rather than producing a spurious empty line between two reals.
 */

/** Matches a single CRLF, CR, or LF line break. */
const LINE_BREAK_RE = /\r\n|\r|\n/;

/**
 * A tag line: the WHOLE line (trimmed), nothing else. Deliberately not a
 * scan-anywhere-in-the-body pattern — a free-floating `#` inside prose
 * ("invoice #1234", "see ticket #77") is not a routing tag, and the live
 * corpus's own tagged bodies put the tag alone on its own line after the
 * separator (this session's write: `…error\r#ccusage`). That is also what
 * makes correct CR/LF/CRLF splitting load-bearing: without it, the tag line
 * never separates from the line before it and this pattern cannot match —
 * which is exactly the spec's own probed table entry,
 * `split(/\n/) -> []  <- the tag is INVISIBLE` (plan:227-229).
 */
const TAG_LINE_RE = /^#([a-zA-Z][\w-]*)$/;

/**
 * Split a reminder body into logical lines, tolerant of CR, LF and CRLF —
 * mixed within the same body, which is the case AppleScript actually
 * produces when a body is edited more than once by different tools.
 *
 * @param {string} body
 * @returns {string[]}
 */
export function splitLines(body) {
  if (typeof body !== "string" || body === "") return [];
  return body.split(LINE_BREAK_RE);
}

/**
 * Every hashtag in a body, lowercased, deduplicated, in first-seen order.
 * Scans the WHOLE body (every line), not just the last one — a tag can sit
 * anywhere, and this module makes no claim about where it "should" be.
 *
 * @param {string} body
 * @returns {string[]} tags without their leading `#`, lowercase
 */
export function extractTags(body) {
  if (typeof body !== "string" || body === "") return [];
  const seen = new Set();
  const out = [];
  for (const rawLine of splitLines(body)) {
    const m = rawLine.trim().match(TAG_LINE_RE);
    if (!m) continue;
    const tag = m[1].toLowerCase();
    if (!seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
    }
  }
  return out;
}
