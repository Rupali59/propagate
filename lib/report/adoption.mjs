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

import { readFileSync, existsSync, readdirSync, realpathSync, statSync } from "node:fs";
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

/** Every column this module reads, by its header NAME. A header cell is
 *  normalised to its first word (`supersedes / superseded_by` -> `supersedes`). */
export const SYSTEMS_COLUMNS = Object.freeze([
  "id",
  "kind",
  "status",
  "supersedes",
  "artifacts",
  "liveness_probe",
  "last_verified",
  "adoption_date",
  "retirement_checklist_done",
]);

/** A table without these cannot answer the adoption question at all. */
export const REQUIRED_COLUMNS = Object.freeze(["id", "status", "last_verified", "adoption_date"]);

function normalizeHeader(cell) {
  return stripMarkup(cell).toLowerCase().split(/[\s/(]/)[0].trim();
}

const SEPARATOR_RE = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/**
 * Parse every SYSTEMS table in a markdown text BY HEADER NAME (#298). Before
 * #298 this was positional over propagate's 9-column header, so a 7-column file
 * put `adoption_date` on `null`, `isAdoptionBlank(null)` is false, and the scan
 * found 0 candidates silently (eng review B6).
 *
 * A table is a header line followed by a `|---|` separator. A table carrying every
 * REQUIRED_COLUMNS header contributes its data rows: lines starting `| \`` (a
 * backtick-quoted id), up to the first non-table line. A table without them is
 * skipped. When NO table qualifies, the text is unreadable: `error` names the
 * missing headers of the closest table, and `rows` is []. That is never 0 rows of
 * a readable file.
 *
 * Returns `{ rows, error }`. A short row yields `null` for missing cells.
 */
export function parseSystems(text) {
  const lines = text.split("\n");
  const rows = [];
  let qualifying = 0;
  let bestMissing = null;
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!/^\s*\|/.test(lines[i]) || !SEPARATOR_RE.test(lines[i + 1].trim())) continue;
    const headers = splitTableRow(lines[i]).map(normalizeHeader);
    const missing = REQUIRED_COLUMNS.filter((c) => !headers.includes(c));
    let j = i + 2;
    if (missing.length > 0) {
      if (bestMissing === null || missing.length < bestMissing.length) bestMissing = missing;
      while (j < lines.length && /^\s*\|/.test(lines[j])) j++;
      i = j - 1;
      continue;
    }
    qualifying++;
    const index = Object.fromEntries(SYSTEMS_COLUMNS.map((c) => [c, headers.indexOf(c)]));
    for (; j < lines.length && /^\s*\|/.test(lines[j]); j++) {
      if (!/^\|\s*`/.test(lines[j])) continue;
      const cells = splitTableRow(lines[j]);
      const row = { lineNumber: j + 1 };
      for (const col of SYSTEMS_COLUMNS) {
        const idx = index[col];
        row[col] = idx >= 0 && cells[idx] !== undefined ? stripMarkup(cells[idx]) : null;
      }
      rows.push(row);
    }
    i = j - 1;
  }
  if (qualifying === 0) {
    const error =
      bestMissing === null
        ? "no markdown table found"
        : `no table with header(s) ${REQUIRED_COLUMNS.join(", ")}` +
          (bestMissing.length < REQUIRED_COLUMNS.length ? ` (closest table lacks: ${bestMissing.join(", ")})` : "");
    return { rows: [], error };
  }
  return { rows, error: null };
}

/** Rows only. Throws when the text is unreadable, so a missing header can
 *  never come back as a silent `[]`. Use `parseSystems` to get the error. */
export function parseSystemsTable(text) {
  const { rows, error } = parseSystems(text);
  if (error) throw new Error(`SYSTEMS.md unreadable: ${error}`);
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
    return { rows: [], error: `unreadable: ${systemsMdPath}: ${err.message}` };
  }
  const { rows, error } = parseSystems(text);
  return { rows, error: error ? `unreadable: ${systemsMdPath}: ${error}` : null };
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

/**
 * THE candidate definition (#298: digest, doctor and the glance share it).
 * A row is askable when its status is exactly one of ADOPTION_TARGET_STATUSES
 * (plain `active` stays out, ruling 2026-11-16) and its adoption_date is blank.
 * An askable row whose `last_verified` has no leading date has no clock: it is
 * `unknown` ("unknown: no start date"), never a candidate and never a pass.
 */
export function classifyAdoptionRows(rows) {
  const candidates = [];
  const unknown = [];
  for (const r of rows) {
    if (!ADOPTION_TARGET_STATUSES.includes(normalizeStatus(r.status)) || !isAdoptionBlank(r.adoption_date)) continue;
    (leadingDate(r.last_verified) ? candidates : unknown).push(r);
  }
  return { candidates, unknown };
}

/** Every row eligible to be asked about (see classifyAdoptionRows). */
export function adoptionCandidates(rows) {
  return classifyAdoptionRows(rows).candidates;
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
    // Set when the rows came from scanRetirement (#298); absent for bare rows.
    workspace: picked.workspace ?? null,
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
  if (ask.workspace) lines.push(`  in workspace ${ask.workspace}`);
  lines.push(`  ${sinceLabel}`);
  lines.push(`  liveness_probe: ${ask.liveness_probe}`);
  lines.push(`  earned it? retire it? or not yet -- answer here, a human fills adoption_date in that SYSTEMS.md, never this tool`);
  if (ask.candidateCount > 1) {
    lines.push(`  (${ask.candidateCount - 1} other unadopted row(s) waiting; one per run, never a list)`);
  }
  return lines;
}

// ─────────────────────────────────────────────────────────────────────────────
// The scan (#298): every discovered SYSTEMS.md, each counted once.
// ─────────────────────────────────────────────────────────────────────────────

/** Where a workspace keeps a SYSTEMS.md, derived from the docs layout
 *  (docs/REFERENCE.md §"Docs layout"): its own `docs/`, one folder per project
 *  under `docs/<project>/`, and the hub's `propagation/docs/<project>/`. */
export function systemsPathsFor(root) {
  const out = [path.join(root, "docs", "SYSTEMS.md")];
  for (const base of [path.join(root, "docs"), path.join(root, "propagation", "docs")]) {
    let entries = [];
    try {
      entries = readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith(".")) out.push(path.join(base, e.name, "SYSTEMS.md"));
    }
  }
  return out.filter((f) => existsSync(f));
}

/**
 * Identity of a file across git worktrees: `{ key, linked }`. A linked worktree's
 * `.git` is a file (`gitdir: <common>/worktrees/<name>`); its key is the COMMON git
 * dir plus the path inside the checkout, so the main checkout and every worktree of
 * it share one key. Outside git the key is the realpath. Read from disk, no `git`
 * subprocess: doctor and the digest both run this.
 */
export function fileIdentity(file) {
  const real = realpathSync(file);
  let dir = path.dirname(real);
  for (;;) {
    const dotGit = path.join(dir, ".git");
    let st = null;
    try {
      st = statSync(dotGit);
    } catch {
      /* keep walking up */
    }
    if (st) {
      const rel = path.relative(dir, real);
      if (st.isDirectory()) return { key: `${realpathSync(dotGit)}::${rel}`, linked: false };
      const m = readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+)$/m);
      if (m) {
        const gitdir = path.resolve(dir, m[1].trim());
        let common = gitdir;
        try {
          common = path.resolve(gitdir, readFileSync(path.join(gitdir, "commondir"), "utf8").trim());
        } catch {
          /* a submodule-style gitdir with no commondir is its own repository */
        }
        try {
          common = realpathSync(common);
        } catch {
          /* gitdir gone (pruned worktree): the unresolved path still groups copies */
        }
        return { key: `${common}::${rel}`, linked: common !== gitdir && existsSync(path.join(gitdir, "commondir")) };
      }
      return { key: real, linked: false };
    }
    const up = path.dirname(dir);
    if (up === dir) return { key: real, linked: false };
    dir = up;
  }
}

/**
 * THE retirement-candidate function: digest, doctor and the glance call this and
 * nothing else (#298). Reads every SYSTEMS.md of `workspaces` plus
 * `<skillDir>/docs/SYSTEMS.md`, keeps one copy per identity (the main checkout
 * over a linked worktree, then the first in sorted path order), and classifies
 * every row with classifyAdoptionRows.
 *
 * Returns { scanned, sources, duplicates, unreadable, candidates, unknown }:
 *   scanned     number of workspaces looked in (the blind-scan line names it);
 *   sources     [{ path, workspace, rows }] read and counted;
 *   duplicates  [{ path, workspace, sameAs }] skipped as a copy of a source;
 *   unreadable  [{ path, workspace, error }] never folded into "0 candidates";
 *   candidates / unknown  rows, each with `source` and `workspace` added.
 */
export function scanRetirement({ workspaces = [], skillDir = SKILL_DIR } = {}) {
  const seen = [];
  const located = [];
  for (const ws of workspaces) {
    for (const f of systemsPathsFor(ws.root)) located.push({ path: f, workspace: ws.name });
  }
  if (skillDir) {
    const own = path.join(skillDir, "docs", "SYSTEMS.md");
    // Named for what it is, not its directory: from a worktree checkout
    // `basename(skillDir)` is the worktree's name.
    if (existsSync(own)) located.push({ path: own, workspace: "propagate" });
  }

  const byKey = new Map();
  for (const loc of located) {
    let id;
    try {
      id = fileIdentity(loc.path);
    } catch {
      id = { key: loc.path, linked: false };
    }
    const entry = { ...loc, ...id };
    seen.push(entry);
    const prior = byKey.get(id.key);
    const better = !prior || (prior.linked && !entry.linked) || (prior.linked === entry.linked && entry.path < prior.path);
    if (better) byKey.set(id.key, entry);
  }

  const result = { scanned: workspaces.length, sources: [], duplicates: [], unreadable: [], candidates: [], unknown: [] };
  for (const entry of seen) {
    const kept = byKey.get(entry.key);
    if (kept !== entry) {
      if (kept.path !== entry.path || kept.workspace !== entry.workspace) {
        if (!result.duplicates.some((d) => d.path === entry.path)) {
          result.duplicates.push({ path: entry.path, workspace: entry.workspace, sameAs: kept.path });
        }
      }
      continue;
    }
    const { rows, error } = readSystemsTable(entry.path);
    if (error) {
      result.unreadable.push({ path: entry.path, workspace: entry.workspace, error });
      continue;
    }
    result.sources.push({ path: entry.path, workspace: entry.workspace, rows: rows.length });
    const { candidates, unknown } = classifyAdoptionRows(rows);
    const tag = (r) => ({ ...r, source: entry.path, workspace: entry.workspace });
    result.candidates.push(...candidates.map(tag));
    result.unknown.push(...unknown.map(tag));
  }
  return result;
}

/** The blind-scan sentence, shared so doctor, digest and glance say it alike. */
export function blindScanLine(scan) {
  return `retirement: no SYSTEMS.md found in ${scan.scanned} workspaces scanned`;
}
