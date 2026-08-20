/**
 * The adoption trigger (task brief Component 1): `adoption_date` is blank in
 * every applicable `docs/SYSTEMS.md` row -- there is a definition, a gate,
 * and a thrice-repeated taboo ("landed != adopted"), but no TRIGGER. Nothing
 * ever gives a human the opportunity to answer. This module is that trigger.
 *
 * WHAT IT DOES: parses `docs/SYSTEMS.md`'s table (read-only) and picks
 * exactly ONE row per call -- never a list -- to ask a human about:
 * earned / retire / not yet. It never writes `adoption_date` itself; the
 * companion test at tests/inventory.test.mjs:380 already forbids machines
 * from filling it, and this module does not attempt to.
 *
 * SELECTION IS A PURE FUNCTION OF SYSTEMS.md's CURRENT CONTENT. No cursor,
 * no second state file (G20: a second reporting/state mechanism duplicates
 * the first unless the first is deleted -- here there IS no first, so
 * nothing to duplicate). Given the same table, `pickAdoptionAsk` always
 * returns the same row: that is the "deterministic" requirement. "Rotation"
 * falls out for free -- as SYSTEMS.md changes (a row gets an adoption_date,
 * a status flips, a new active-unadopted row appears), the pick recomputes
 * from scratch and naturally lands on a different row. Nothing needs to
 * remember what was asked last time.
 *
 * ONE DELIBERATE EXCEPTION to "purely oldest": `daily-md` (this digest's own
 * generated artifact, itself `installed-never-invoked` per SYSTEMS.md) is
 * pinned to the front of the queue whenever it qualifies. That names the
 * circularity explicitly -- the tool answering "is anything unadopted?" is
 * itself unadopted, and delivering that fact through its own unadopted
 * channel is worth surfacing before anything else.
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

import { SKILL_DIR } from "../core/config.mjs";

export const SYSTEMS_MD_PATH = path.join(SKILL_DIR, "docs", "SYSTEMS.md");

/** Rows in this status carry the taboo this module exists to enforce a
 *  trigger for. Every other status (active, proposed, dormant, retired) is
 *  out of scope -- SYSTEMS.md's own notes are explicit that a `proposed` or
 *  merely-`active` row's blank adoption_date is not yet even askable. */
export const ADOPTION_TARGET_STATUSES = Object.freeze(["active-unadopted", "installed-never-invoked"]);

/** The row this module names as the circularity example (file header). */
export const PINNED_FIRST_ID = "daily-md";

// ─────────────────────────────────────────────────────────────────────────────
// Table parsing -- escaped-pipe aware. A naive `line.split("|")` misparses
// any cell containing `\|` (several SYSTEMS.md rows have `grep ... \| grep
// ...` inside inline code), silently shifting every later column. Verified
// directly against docs/SYSTEMS.md before writing the selection logic on top
// of it (G13/G15 -- grep for candidates, then confirm by reading).
// ─────────────────────────────────────────────────────────────────────────────

/** Split one `| a | b\| c | d |` markdown table row into cells, treating
 *  `\|` as a literal pipe (not a delimiter) and stripping the escape. */
export function splitTableRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  const cells = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
      continue;
    }
    if (s[i] === "|") {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

/** Strip markdown emphasis/code wrappers (`**bold**`, `` `code` ``) that
 *  SYSTEMS.md uses freely in the id/status columns, without touching the
 *  meaning of the remaining text. */
function stripMarkup(s) {
  return s.replace(/\*\*/g, "").replace(/^`|`$/g, "").trim();
}

const SYSTEMS_HEADER_COLS = [
  "id",
  "kind",
  "status",
  "supersedes",
  "artifacts",
  "liveness_probe",
  "last_verified",
  "adoption_date",
  "retirement_checklist_done",
];

/**
 * Parse every data row of `docs/SYSTEMS.md`'s table (the 9-column format
 * documented at the top of that file). Rows are matched by `| \`` at line
 * start (a backtick-quoted id in the first cell) -- the same shape the
 * header/notes rows never take, so this does not need to locate the header
 * separator line to know where data starts.
 *
 * Returns `{ rows, error }`. `error` is set (rows === []) only when the file
 * cannot be read at all -- never for an individual malformed row, which is
 * simply parsed with whatever cells are present (a short row yields
 * `undefined` for missing trailing columns rather than throwing).
 */
export function parseSystemsTable(text) {
  const lines = text.split("\n");
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/^\|\s*`/.test(line)) continue;
    const cells = splitTableRow(line);
    const row = { lineNumber: i + 1 };
    SYSTEMS_HEADER_COLS.forEach((col, idx) => {
      row[col] = cells[idx] !== undefined ? stripMarkup(cells[idx]) : null;
    });
    rows.push(row);
  }
  return rows;
}

export function readSystemsTable(systemsMdPath = SYSTEMS_MD_PATH) {
  if (!existsSync(systemsMdPath)) {
    return { rows: [], error: `not found: ${systemsMdPath}` };
  }
  let text;
  try {
    text = readFileSync(systemsMdPath, "utf8");
  } catch (err) {
    return { rows: [], error: `unreadable: ${err.message}` };
  }
  return { rows: parseSystemsTable(text), error: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// Blank detection -- SYSTEMS.md's authors use several literal spellings for
// "not yet answered" (`**BLANK**`, `**BLANK -- ...**`, `-- *not earned*`),
// distinct from real answers that happen to leave the field short (`never`,
// `n/a`, a filled-in date). Verified against every row in the live file
// before picking these patterns (G15: grep to find candidates, read to
// confirm) -- see the task verification transcript.
// ─────────────────────────────────────────────────────────────────────────────

const BLANK_ADOPTION_RE = /^(blank\b|—?\s*\*?not[\s-]?(yet[\s-]?)?earned\*?)/i;

export function isAdoptionBlank(adoptionDateCell) {
  if (adoptionDateCell === null || adoptionDateCell === undefined) return false;
  // Accept both raw table cells (still carrying `**bold**`) and already-
  // stripped ones (as parseSystemsTable produces) -- callers use both.
  const s = adoptionDateCell.replace(/\*\*/g, "").trim();
  if (s.length === 0) return true;
  return BLANK_ADOPTION_RE.test(s);
}

function normalizeStatus(status) {
  if (!status) return "";
  // Strip a trailing "retired 2026-08-14"-style date suffix so status
  // comparison is exact-match against the vocabulary, not prefix-match.
  return status.trim();
}

/** Best-effort leading `YYYY-MM-DD` extracted from a free-text cell (e.g.
 *  `last_verified`, which is often "2026-08-14 (verified directly: ...)").
 *  Returns null, never a guess, when no such date opens the cell. */
export function leadingDate(cell) {
  if (!cell) return null;
  const m = cell.trim().match(/^(\d{4}-\d{2}-\d{2})\b/);
  return m ? m[1] : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Selection
// ─────────────────────────────────────────────────────────────────────────────

/** Every row eligible to be asked about: target status, blank adoption_date. */
export function adoptionCandidates(rows) {
  return rows.filter(
    (r) => ADOPTION_TARGET_STATUSES.includes(normalizeStatus(r.status)) && isAdoptionBlank(r.adoption_date),
  );
}

/**
 * Pick exactly one candidate, deterministically, from the current table
 * content alone (see file header -- no cursor, no second state store).
 * Order: `pinnedFirstId` first if it qualifies, then the rest by ascending
 * `last_verified` (oldest verification first -- the best available proxy
 * for "how long has this sat unadopted", since SYSTEMS.md records no
 * separate since-unadopted timestamp; rows with no parseable date sort
 * last, never first, so an unparsable date cannot masquerade as "oldest"),
 * with id as the final, purely-cosmetic tiebreak for two identical dates.
 *
 * Returns null when there is nothing to ask -- the caller must render
 * nothing in that case (task constraint: silence, not an empty section).
 */
export function pickAdoptionAsk(rows, { pinnedFirstId = PINNED_FIRST_ID } = {}) {
  const candidates = adoptionCandidates(rows);
  if (candidates.length === 0) return null;

  const pinned = candidates.find((r) => r.id === pinnedFirstId);
  const rest = candidates
    .filter((r) => r.id !== pinnedFirstId)
    .slice()
    .sort((a, b) => {
      const da = leadingDate(a.last_verified);
      const db = leadingDate(b.last_verified);
      if (da && db && da !== db) return da < db ? -1 : 1;
      if (da && !db) return -1; // dated sorts before undated ("oldest" beats "unknown")
      if (!da && db) return 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

  const picked = pinned ?? rest[0];
  const verifiedDate = leadingDate(picked.last_verified);
  const daysUnverified = verifiedDate ? Math.floor((Date.now() - Date.parse(`${verifiedDate}T00:00:00Z`)) / 86400000) : null;

  return {
    id: picked.id,
    status: picked.status,
    liveness_probe: picked.liveness_probe,
    last_verified: picked.last_verified,
    daysUnverified,
    isCircularityExample: picked.id === pinnedFirstId,
    candidateCount: candidates.length,
  };
}

/** Render the single ask as digest lines. Never mentions a value for
 *  `adoption_date` -- the machine asks, it does not answer or suggest. */
export function formatAdoptionLines(ask) {
  if (!ask) return [];
  const lines = [];
  const sinceLabel =
    ask.daysUnverified !== null
      ? `last verified ${ask.last_verified.split(" ")[0]} (${ask.daysUnverified}d ago) -- proxy for "how long unadopted", not an exact since-date; SYSTEMS.md records no such field`
      : `last_verified unparsed (${JSON.stringify(ask.last_verified)}) -- age unknown, not assumed zero`;

  if (ask.isCircularityExample) {
    lines.push(
      `${ask.id} (status: ${ask.status}) -- this digest's own generated artifact is unadopted too. Asking about it first, before anything else in the queue, names that.`,
    );
  } else {
    lines.push(`${ask.id} (status: ${ask.status})`);
  }
  lines.push(`  ${sinceLabel}`);
  lines.push(`  liveness_probe: ${ask.liveness_probe}`);
  lines.push(`  earned it? retire it? or not yet -- answer here, a human fills adoption_date in docs/SYSTEMS.md, never this tool`);
  if (ask.candidateCount > 1) {
    lines.push(`  (${ask.candidateCount - 1} other unadopted row(s) waiting; one per run, never a list)`);
  }
  return lines;
}
