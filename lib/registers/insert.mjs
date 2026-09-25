/**
 * insert.mjs — the one operation `write.mjs` deliberately does not do:
 * insert a NEW line into a hand-written register, rather than edit an
 * existing one. `docs/plans/2026-09-23-reminders-todo-bridge.md`'s "Part 1 —
 * the inserter"; PR-021's DECISIONS.md entry (2026-09-25) is why this exists
 * at all — the reminders bridge cannot reach its stated goal condition
 * without it.
 *
 * WHY A SEPARATE MODULE, NOT A THIRD PLANNER IN write.mjs. `write.mjs`'s
 * planners are narrow regex matchers on purpose and hold no format
 * knowledge. A safe insert needs a PARSER — specifically `backlog.mjs`'s
 * classifier, because the dangerous failure mode of an insert is not a byte
 * change, it is a PARSE change (see A3 below). This repo already paid for
 * "two forks of one traversal" once, inside `backlog.mjs` itself — so this
 * module REUSES `backlog.mjs`'s exported parser rather than writing a second
 * one, and reuses `write.mjs`'s atomic temp+rename mechanics rather than
 * teaching `write.mjs` to parse.
 *
 * ── THE THREE ASSERTIONS ─────────────────────────────────────────────────
 *
 * write.mjs's own "+1 line" and "every other line identical" assertions are
 * UNREACHABLE as written for an edit (`out = lines.slice(); out[i] = next`
 * cannot violate either) and would be exactly as unreachable for an insert
 * written with `splice` — `splice(i, 0, x)` always grows by one; asserting
 * that is asserting that splice is splice. The guarantees that actually
 * matter for an insert are these three, each with the input that makes it
 * fail:
 *
 * **A1 — content.** The new text may not contain a newline. For an EDIT that
 * only corrupts one line's text; for an INSERT it corrupts the file's
 * *shape* — a second, unplanned line lands wherever `\n` was.
 *
 * **A2 — boundary.** The anchor (the line the new text lands immediately
 * after) must be a LEGAL boundary: a blank line, or immediately before a
 * heading at or above the new entry's own heading level — and not inside a
 * closed section. "The anchor did not move" (the race check, reused from
 * write.mjs) only proves the FILE is unchanged; it says nothing about
 * whether that position was ever a safe place to insert.
 *
 * **A3 — parse.** THIS IS THE ONE THAT MATTERS. Simulate the insert in
 * memory and run `backlog.mjs`'s classifier on the text before and after.
 * Assert the format election is unchanged and every pre-existing item's
 * `{id, closed}` is unchanged. One `- [ ]`-shaped line flips
 * `parseTodoLikeFile`'s whole-file election, and a line whose text lands
 * inside `CLOSED_MARKERS_RE`'s 3-line lookahead of the PRECEDING entry
 * silently closes it — both leave every byte of every pre-existing entry
 * untouched, so "nothing else changed" is true and the guarantee is
 * violated anyway. The guarantee is over the PARSE, not the bytes.
 *
 * WHAT IS DELIBERATELY NOT HERE: deciding WHERE to insert (which register,
 * which project) — that is `lib/reminders/sync.mjs`'s job, one layer up.
 * This module inserts one line, given an anchor a caller already resolved.
 */

import { readFile, writeFile, rename } from "node:fs/promises";
import { parseTodoLikeFile, closedSectionLines } from "../report/backlog.mjs";

/** @param {string} line */
function headingLevel(line) {
  const m = /^(#{1,6})\s/.exec(line);
  return m ? m[1].length : null;
}

/**
 * A2. `lines` is the FULL file, 0-indexed array (`text.split("\n")`).
 * `anchorLine` is 1-based: the new text lands immediately AFTER it.
 *
 * @param {{lines: string[], anchorLine: number, insertText: string, closedLines: Set<number>}} args
 */
export function isLegalBoundary({ lines, anchorLine, insertText, closedLines }) {
  // Neither the anchor line itself, nor the position immediately following
  // it (where the file's PRIOR content resumes), may sit inside a closed
  // section — the second check catches anchoring on a closed heading's own
  // title line, which `closedSectionLines` deliberately does not mark.
  if (closedLines.has(anchorLine)) {
    return { ok: false, reason: `anchor line ${anchorLine} is inside a closed section — refusing to insert there` };
  }
  if (closedLines.has(anchorLine + 1)) {
    return {
      ok: false,
      reason: `the position immediately after anchor line ${anchorLine} is inside a closed section — refusing to insert there`,
    };
  }

  const anchorText = lines[anchorLine - 1];
  if (anchorText !== undefined && anchorText.trim() === "") return { ok: true };

  const nextLine = lines[anchorLine]; // the line immediately after the anchor (0-indexed === anchorLine for a 1-based anchor)
  const nextLevel = nextLine !== undefined ? headingLevel(nextLine) : null;
  const insertLevel = headingLevel(insertText) ?? Infinity;
  if (nextLevel !== null && nextLevel <= insertLevel) return { ok: true };

  return {
    ok: false,
    reason:
      `anchor line ${anchorLine} is not a legal boundary — it is not a blank line and is not immediately ` +
      "before a heading at or above the new entry's level. Inserting here would land mid-entry.",
  };
}

/** Insert `insertText` immediately after 1-based `anchorLine`, in memory. */
export function simulateInsert(lines, anchorLine, insertText) {
  return lines.slice(0, anchorLine).concat([insertText], lines.slice(anchorLine)).join("\n");
}

/** The identity of a parsed item, for A3's before/after comparison — by
 *  `id` when the format carries one (id-keyed), by `text` otherwise
 *  (checkbox). Matches `backlog.mjs`'s own item-identity convention. */
function itemKey(item) {
  return item.id ? `id:${item.id}` : `text:${item.text}`;
}

const FORMATS_WITH_NO_ITEM_MODEL = new Set(["unrecognised", "stub", "pointer-stub"]);

/**
 * A3. Runs `backlog.mjs`'s OWN classifier on the before/after text and
 * compares them — never a second, forked parser.
 *
 * @param {{beforeText: string, afterText: string, filePath: string}} args
 */
export function checkParseInvariant({ beforeText, afterText, filePath }) {
  const before = parseTodoLikeFile(beforeText, filePath);
  const after = parseTodoLikeFile(afterText, filePath);

  if (before.format !== after.format) {
    return {
      ok: false,
      error: `insert would change the file's format election: "${before.format}" -> "${after.format}"`,
    };
  }

  if (FORMATS_WITH_NO_ITEM_MODEL.has(before.format)) {
    // A stub, pointer-stub or unrecognised file carries no per-item {id,
    // closed} model to protect against reclassification — format equality
    // above is the whole check for these.
    return { ok: true };
  }

  const beforeMap = new Map(before.items.map((it) => [itemKey(it), it]));
  const afterMap = new Map(after.items.map((it) => [itemKey(it), it]));

  for (const [key, item] of beforeMap) {
    const match = afterMap.get(key);
    if (!match) {
      return {
        ok: false,
        error:
          `insert would reclassify a pre-existing entry (${key}) from open to closed — ` +
          "most likely a closed-marker lookahead absorbing the inserted text. Field: closed (false -> true).",
      };
    }
    if (match.text !== item.text) {
      return {
        ok: false,
        error: `insert would change entry ${key}'s text — field: text ("${item.text}" -> "${match.text}")`,
      };
    }
  }

  if (after.closed !== before.closed) {
    return {
      ok: false,
      error: `insert would change the file's closed count — field: closed (${before.closed} -> ${after.closed})`,
    };
  }

  return { ok: true };
}

/**
 * Insert one new line into a register, or refuse and say why. Mirrors
 * `write.mjs#applyEdit`'s shape deliberately: same race check (re-read NOW,
 * compare the whole anchor line byte for byte), same atomic temp+rename.
 *
 * `code` on a refusal is the vocabulary a caller (`sync.mjs`) maps onto a
 * disposition: `bad-args` | `bad-content` (A1) | `anchor-moved` (the race
 * check) | `illegal-boundary` (A2) | `would-change-classification` (A3) |
 * `read-failed` | `write-failed`.
 *
 * @param {{file: string, anchorLine: number, anchorExpected: string, insertText: string, deps?: object}} args
 */
export async function applyInsert({ file, anchorLine, anchorExpected, insertText, deps = {} } = {}) {
  const read = deps.readFile ?? readFile;
  const write = deps.writeFile ?? writeFile;
  const mv = deps.rename ?? rename;

  if (!file || !Number.isInteger(anchorLine) || anchorLine < 1) {
    return { ok: false, code: "bad-args", error: "file and a 1-based anchorLine are required" };
  }
  if (typeof anchorExpected !== "string" || typeof insertText !== "string") {
    return { ok: false, code: "bad-args", error: "anchorExpected and insertText must both be strings" };
  }

  // A1 — content shape. Checked before the file is even read: no plan whose
  // insertText already fails A1 is worth a race check.
  if (/\n/.test(insertText)) {
    return { ok: false, code: "bad-content", error: "insert text may not contain a newline — this writes exactly ONE new line" };
  }
  if (insertText === "") {
    return { ok: false, code: "bad-content", error: "insert text may not be empty" };
  }

  let text;
  try {
    text = await read(file, "utf8");
  } catch (err) {
    return { ok: false, code: "read-failed", error: `cannot read ${file} — ${err.message}` };
  }

  const lines = text.split("\n");
  if (anchorLine > lines.length) {
    return {
      ok: false,
      code: "anchor-moved",
      error: `anchor line ${anchorLine} is past the end of the file (${lines.length} lines) — the file changed; reload`,
    };
  }

  // THE RACE CHECK, same discipline as write.mjs's guarantee 1: the whole
  // line, byte for byte, not merely "still looks like the same entry".
  if (lines[anchorLine - 1] !== anchorExpected) {
    return {
      ok: false,
      code: "anchor-moved",
      error:
        `anchor line ${anchorLine} is not what was previewed — the file changed since it was resolved; reload.\n` +
        `  expected: ${anchorExpected}\n` +
        `  found:    ${lines[anchorLine - 1]}`,
    };
  }

  // A2 — legal boundary.
  const closedLines = closedSectionLines(lines);
  const boundary = isLegalBoundary({ lines, anchorLine, insertText, closedLines });
  if (!boundary.ok) {
    return { ok: false, code: "illegal-boundary", error: boundary.reason };
  }

  // A3 — parse invariant. Simulated in memory; nothing is written yet.
  const afterText = simulateInsert(lines, anchorLine, insertText);
  const invariant = checkParseInvariant({ beforeText: text, afterText, filePath: file });
  if (!invariant.ok) {
    return { ok: false, code: "would-change-classification", error: invariant.error };
  }

  const tmp = `${file}.propagate-tmp`;
  try {
    await write(tmp, afterText);
    await mv(tmp, file);
  } catch (err) {
    return { ok: false, code: "write-failed", error: `write failed — ${err.message}` };
  }

  return {
    ok: true,
    file,
    anchorLine,
    insertedAtLine: anchorLine + 1,
    anchorText: anchorExpected,
    insertedText: insertText,
  };
}
