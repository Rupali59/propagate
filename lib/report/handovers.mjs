/**
 * handovers.mjs — handover sections, and which of them anyone has scoped.
 *
 * WHY THIS EXISTS. `HANDOVERS.md` is 1,085 lines with ZERO status markers of
 * any kind; resolutions are appended as new dated sections rather than marking
 * the item they resolve. So the file records what happened and cannot record
 * that it was handled — the same defect as a ledger with no close path, in
 * prose form.
 *
 * Measured 2026-08-22: its 2026-08-17 section names its own discharge
 * condition in prose — "my edits are exactly the files with an mtime between
 * 19:02 and 19:14". Running that by hand showed ManavDaehi, Keerti and the hub
 * clean but PanditPawanKaushik still holding 3 such files, five days on. The
 * condition existed and was correct; it had simply never been written as
 * something a reader could find.
 *
 * THIS MODULE DOES NOT RUN THE CONDITION, and that is deliberate rather than
 * lazy. Deriving "closed" would mean executing shell written inside a markdown
 * file — a hole wide enough to drive anything through, and against the tool's
 * stated posture: it never edits a downstream, it tells a human. The condition
 * is REPORTED so a person runs it.
 *
 *     ## <date> · <title>
 *     **Done when:** <a condition someone can run>     -> open
 *     **Resolved:** <date> — <what happened>            -> closed
 *     (neither)                                         -> unknown
 *
 * THREE STATES, NEVER TWO. Defaulting the third to "closed" would report a
 * thousand lines of unscoped prose as finished; defaulting it to "open" would
 * claim every historical note is outstanding. Neither is true. `unknown` means
 * nobody has said what would finish it, which is the honest description of
 * almost the whole file and is exactly the kind of absence
 * rule:discernment-checks §2 requires be named rather than guessed.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * A section heading, in EITHER shape the tree actually uses.
 *
 *   ## 2026-08-17 · Title     the long append-only HANDOVERS.md, dated
 *   ## 1 · Title              a dated HANDOVER-*.md, numbered within the file
 *
 * The first version required a date, and reported **0 sections for
 * Motherboard/HANDOVER-2026-08-14.md, which has 7** — a file full of real work
 * reading as empty. That is the precise hazard `backlog.mjs`'s own header
 * warns about ("a parser that silently returns 0 for a shape it does not
 * recognise reports 'nothing open' for a file full of real work"), committed
 * by the module being added to it.
 *
 * When the heading carries no date, the file's own date is used — a dated
 * handover names its date in the filename, so the section is still
 * identifiable.
 */
const SECTION_RE = /^##\s+(?:(\d{4}-\d{2}-\d{2})|(\d+))\s*[·\-–—:.]?\s*(.*)$/;

/** `HANDOVER-doppler-import-2026-08-20.md` -> `2026-08-20`. */
const FILE_DATE_RE = /(\d{4}-\d{2}-\d{2})/;

/** Bold or plain, colon-terminated. Tolerates the markup the file actually uses. */
const DONE_WHEN_RE = /^\s*\*{0,2}Done when:?\*{0,2}\s*:?\s*(.+)$/i;
const RESOLVED_RE = /^\s*\*{0,2}Resolved:?\*{0,2}\s*:?\s*(.+)$/i;

/**
 * How many non-empty lines after a heading may still carry a section-level
 * marker.
 *
 * WITHOUT THIS BOUND THE PARSER LIES, and it did: run against the live
 * 1,085-line HANDOVERS.md it reported 2 sections closed, and BOTH were false.
 * One matched a sub-item's `**Resolved:** 2026-08-15 ...` deep in a section
 * body; the other matched the word mid-sentence in flowing prose. A
 * section-level marker belongs directly under its heading — anything further
 * down is discussion about resolutions, not a declaration that this section is
 * resolved.
 *
 * `closed` is the one state that must never be wrong, because it is the only
 * one that makes work disappear.
 */
const MARKER_WINDOW = 3;

/**
 * A fenced code block delimiter — ``` or ~~~, with optional info string.
 *
 * PROSE ABOUT THE FORMAT IS NOT THE FORMAT (N51). Documenting this module's own
 * marker protocol inside `HANDOVERS.md` minted a PHANTOM section: the example
 * held a dated `## …` heading followed by `**Resolved:** …`, both inside a
 * fence, and the parser read them as real. Measured 2026-08-26: 16 sections
 * became 17, and the phantom reported **closed** — the one state that must never
 * be wrong, arrived at by quoting the docs.
 *
 * Fenced lines are SKIPPED for matching but still CONSUME the marker window.
 * That is deliberate: a section-level marker belongs directly under its heading,
 * before any illustration, so a code block sitting between them is exactly the
 * distance the window exists to measure. Not consuming it would widen the window
 * by an arbitrary amount and re-open the false-close door from a third side.
 */
const FENCE_RE = /^\s*(```|~~~)/;

/**
 * Parse one handover file into dated sections with a discharge state.
 *
 * Never throws. An unreadable file returns `error` set and `totals: null` —
 * distinct from a readable file with no sections, which returns a real
 * `{open: 0, closed: 0, unknown: 0}`. "Found nothing" and "could not look" are
 * different facts and the caller must be able to tell them apart.
 *
 * @param {string} filePath
 * @returns {{file: string, error: string|null, sections: Array<{date: string, title: string, status: "open"|"closed"|"unknown", doneWhen: string|null, resolved: string|null, line: number}>, totals: {open: number, closed: number, unknown: number}|null}}
 */
export function parseHandovers(filePath) {
  if (!existsSync(filePath)) {
    return { file: filePath, error: `not found: ${filePath}`, sections: [], totals: null };
  }
  let text;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (err) {
    return { file: filePath, error: `unreadable: ${err.message}`, sections: [], totals: null };
  }

  const lines = text.split("\n");
  const sections = [];
  let current = null;
  let sinceHeading = 0; // non-empty lines seen since the current heading

  const close = () => {
    if (!current) return;
    current.status = current.resolved ? "closed" : current.doneWhen ? "open" : "unknown";
    sections.push(current);
    current = null;
  };

  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE_RE.test(lines[i])) {
      inFence = !inFence;
      if (current && lines[i].trim() !== "") sinceHeading += 1;
      continue;
    }
    if (inFence) {
      // Inside a fence: never a heading, never a marker — but it is still
      // distance between a heading and any marker below it.
      if (current && lines[i].trim() !== "") sinceHeading += 1;
      continue;
    }
    const m = SECTION_RE.exec(lines[i]);
    if (m) {
      close();
      const fileDate = (FILE_DATE_RE.exec(path.basename(filePath)) || [])[1] || null;
      current = {
        date: m[1] || fileDate,
        ordinal: m[2] ? Number(m[2]) : null,
        title: (m[3] || "").trim(),
        status: "unknown",
        doneWhen: null,
        resolved: null,
        line: i + 1,
      };
      sinceHeading = 0;
      continue;
    }
    if (!current) continue; // preamble prose belongs to no section
    if (lines[i].trim() === "") continue; // blank lines do not spend the window
    sinceHeading += 1;
    // Only the first few non-empty lines may declare the section's state. See
    // MARKER_WINDOW: without this the parser reported two false `closed`s on
    // the live file, and `closed` is the state that makes work disappear.
    if (sinceHeading > MARKER_WINDOW) continue;
    if (!current.doneWhen) {
      const d = DONE_WHEN_RE.exec(lines[i]);
      if (d) current.doneWhen = d[1].trim();
    }
    if (!current.resolved) {
      const r = RESOLVED_RE.exec(lines[i]);
      if (r) current.resolved = r[1].trim();
    }
  }
  close();

  const totals = { open: 0, closed: 0, unknown: 0 };
  for (const s of sections) totals[s.status] += 1;

  return { file: filePath, error: null, sections, totals };
}

/** `HANDOVERS.md` or a dated `HANDOVER-*.md`, as found beside each other. */
export function isHandoverFile(name) {
  return name === "HANDOVERS.md" || (name.startsWith("HANDOVER") && name.endsWith(".md"));
}

/**
 * Fold many handover files into one report.
 *
 * Files that could not be read are kept in `unreadable` rather than dropped:
 * a fold that silently omits them reports a smaller, cleaner-looking backlog
 * than actually exists, which is the failure this whole module is about.
 *
 * @param {string[]} files
 */
export function foldHandovers(files) {
  const parsed = [];
  const unreadable = [];
  const totals = { open: 0, closed: 0, unknown: 0 };
  for (const f of files) {
    const r = parseHandovers(f);
    if (r.error) {
      unreadable.push({ file: f, reason: r.error });
      continue;
    }
    parsed.push(r);
    for (const k of Object.keys(totals)) totals[k] += r.totals[k];
  }
  return { files: parsed, unreadable, totals, filesScanned: files.length };
}

/** Relative-to-a-root display path, for report lines. */
export function shortPath(file, root) {
  return root && file.startsWith(root) ? path.relative(root, file) : file;
}
