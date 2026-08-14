/**
 * The backlog aggregate view (task brief Component 2). READ-ONLY: no
 * migration, no edits to any source file, ever.
 *
 * WHAT IT READS, across SEARCH_ROOTS: every `STATE.md`'s live sections
 * (`Now` / `Active` / `Pending` / `Next`), every `TODOS.md`, and every
 * `docs/ISSUES.md`.
 *
 * THE HAZARD (measured, task brief): of ~16 TODO files, 6 are checkbox-style
 * (`- [ ]` / `- [x]`), 7 are ID-keyed prose (`TM-###`, `YV-###`, `MI-###`
 * headings), 3 are stubs ("nothing open, see STATE.md"). A parser that
 * silently returns 0 for a shape it does not recognise reports "nothing
 * open" for a file full of real work -- indistinguishable, from the
 * output, from a genuinely empty file (G2: absence is ambiguous unless it
 * is attributable).
 *
 * So every file this module reads produces one of exactly three outcomes,
 * never conflated:
 *   - `parsed: N`       -- recognised a format, extracted N items (N may be 0
 *                          for a genuine stub, which is a DIFFERENT outcome
 *                          from "unparsed", see below).
 *   - `stub: true`       -- recognised, explicitly, as intentionally empty
 *                          (an explicit "nothing open" marker, or the file
 *                          is too short to hold real content).
 *   - `unparsed: reason` -- the file has real content but matched neither
 *                          recognised format; NEVER reported as `parsed: 0`.
 *
 * Deduplication only merges items whose normalized text is an EXACT match.
 * No fuzzy matching, no substring containment -- per the task brief, "if
 * dedup is uncertain, keep both and say so rather than guessing" (mirrors
 * G15: grep finds candidates, it does not get to stand in for a match).
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";

import { SEARCH_ROOTS } from "./config.mjs";

const SKIP_DIR_NAMES = new Set([
  "node_modules", ".git", ".next", "dist", "build", ".turbo", ".vercel",
  "Library", "Trash", ".cache", ".worktrees", "vendor", ".venv", "__pycache__",
]);

const MAX_WALK_DEPTH = 6;
const WALK_BUDGET_MS = 20_000;

// ─────────────────────────────────────────────────────────────────────────────
// Discovery
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Walk SEARCH_ROOTS looking for STATE.md, TODOS.md, and docs/ISSUES.md.
 * Bounded by depth and a wall-clock budget, same shape as
 * lib/inventory.mjs's repo walk -- any subtree not reached before the
 * budget expires is recorded in `dropped`, never silently omitted (G3).
 */
export function discoverBacklogFiles({ searchRoots = SEARCH_ROOTS, maxDepth = MAX_WALK_DEPTH, budgetMs = WALK_BUDGET_MS } = {}) {
  const found = { stateMd: [], todosMd: [], issuesMd: [] };
  const dropped = [];
  const start = Date.now();
  let budgetExceeded = false;

  function listDirs(parent) {
    let entries;
    try {
      entries = readdirSync(parent, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries.filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIR_NAMES.has(e.name));
  }

  function walk(dir, depth) {
    if (budgetExceeded) return;
    if (Date.now() - start > budgetMs) {
      budgetExceeded = true;
      dropped.push({ path: dir, reason: "time budget exceeded" });
      return;
    }
    if (existsSync(path.join(dir, "STATE.md"))) found.stateMd.push(path.join(dir, "STATE.md"));
    if (existsSync(path.join(dir, "TODOS.md"))) found.todosMd.push(path.join(dir, "TODOS.md"));
    if (existsSync(path.join(dir, "docs", "ISSUES.md"))) found.issuesMd.push(path.join(dir, "docs", "ISSUES.md"));

    if (depth >= maxDepth) {
      if (listDirs(dir).length > 0) {
        dropped.push({ path: dir, reason: `max depth ${maxDepth} reached -- not walked further` });
      }
      return;
    }
    for (const entry of listDirs(dir)) walk(path.join(dir, entry.name), depth + 1);
  }

  for (const root of searchRoots) {
    if (!existsSync(root)) continue;
    walk(root, 0);
  }

  // De-dup paths (a root nested inside another root would otherwise double-walk).
  for (const key of Object.keys(found)) found[key] = [...new Set(found[key])];

  return { ...found, dropped, budgetExceeded };
}

// ─────────────────────────────────────────────────────────────────────────────
// STATE.md — live sections only (Now / Active / Pending / Next)
// ─────────────────────────────────────────────────────────────────────────────

const LIVE_SECTION_RE = /^(now|active|pending|next)\b/i;

/**
 * Extract items from a STATE.md's live sections. A "section" is any heading
 * (any level) whose text starts with Now/Active/Pending/Next (case
 * insensitive, so "## Now (in flight)" and "### Pending (by priority)" both
 * match). The section runs until the next heading at the same or shallower
 * level.
 *
 * Within a section: if it contains any deeper subheadings, each subheading
 * is one item (its title). If it has no subheadings, each unindented `- `
 * bullet directly in the section is one item. This avoids double-counting a
 * subsection's own bullets as separate items on top of the subsection itself.
 */
export function parseStateLiveSections(text, filePath) {
  const lines = text.split("\n");
  const items = [];
  const headingRe = /^(#{1,6})\s+(.*)$/;

  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(headingRe);
    if (!m || !LIVE_SECTION_RE.test(m[2].trim())) {
      i++;
      continue;
    }
    const sectionLevel = m[1].length;
    const sectionName = m[2].trim();
    const sectionStartLine = i + 1; // 1-indexed
    let j = i + 1;
    const bodyLines = [];
    while (j < lines.length) {
      const mm = lines[j].match(headingRe);
      if (mm && mm[1].length <= sectionLevel) break;
      bodyLines.push({ text: lines[j], lineNumber: j + 1 });
      j++;
    }

    const subheadings = bodyLines.filter((l) => {
      const hm = l.text.match(headingRe);
      return hm && hm[1].length > sectionLevel;
    });

    if (subheadings.length > 0) {
      for (const l of subheadings) {
        const hm = l.text.match(headingRe);
        items.push({
          file: filePath,
          line: l.lineNumber,
          section: sectionName,
          text: hm[2].trim(),
          format: "state-subheading",
        });
      }
    } else {
      for (const l of bodyLines) {
        const bm = l.text.match(/^-\s+(.+)$/); // unindented bullet only
        if (bm) {
          items.push({
            file: filePath,
            line: l.lineNumber,
            section: sectionName,
            text: bm[1].trim(),
            format: "state-bullet",
          });
        }
      }
    }

    i = j; // continue scanning after this section (handles multiple matching sections)
  }

  return { items };
}

// ─────────────────────────────────────────────────────────────────────────────
// TODOS.md / docs/ISSUES.md — checkbox / id-keyed / stub / unrecognised
// ─────────────────────────────────────────────────────────────────────────────

const CHECKBOX_RE = /^\s*-\s*\[([ xX])\]\s*(.+)$/;
const ID_HEADING_RE = /^(#{2,6})\s+.*\b([A-Z]{2,6}-\d{2,4})\b.*$/;
// The bullet variant of ID-keyed prose (e.g. Vipin Kaushik/TODOS.md:
// `- **TM-010** — Public read-only API...`, no heading marker at all).
// Distinct file from the heading variant (Tushar/TODOS.md's `### YV-004 ·`)
// -- same ID vocabulary, different container. Both are "ID-keyed prose" per
// the task brief's measurement; treating only the heading shape as
// recognised would misreport this file's real, well-formed content as
// unparsed (verified directly against the file before adding this).
const ID_BULLET_RE = /^\s*-\s*(~~)?\s*\*\*([A-Z]{2,6}-\d{2,4})\*\*\s*(~~)?\s*[—-]?\s*(.*)$/;
const CLOSED_MARKERS_RE =
  /~~.*~~|✅|\bdone\b|\bcompleted\b|\bsuperseded\b|\bmoot\b|\bclosed\b|\bcancelled\b|\bcanceled\b|\bresolved\b|\bshipped\b|\barchived\b/i;

/**
 * Headings that declare their whole section closed. Structural, and therefore
 * stronger than word-matching each item: `Vipin Kaushik/TODOS.md:56` is
 * "## Archived directly (resolved / done / cancelled — no cherry-pick needed)"
 * and its own body says "These were already closed ... but stayed in TODOS.md as
 * historical rows." Nine items under it were being reported as OPEN backlog,
 * because item-level matching missed "CANCELLED" and "resolved" (both absent
 * from the marker list until 2026-08-14).
 *
 * An over-reporting backlog is not harmless: it is the same failure as a
 * never-firing check, inverted -- closed work read as outstanding.
 */
const CLOSED_SECTION_RE =
  /\b(archiv|resolved|done|cancelled|canceled|closed|complete|shipped|superseded|landed)/i;

/** Line numbers (1-indexed) that sit under a closed-declaring heading. */
export function closedSectionLines(lines) {
  const out = new Set();
  let closedDepth = null;
  lines.forEach((line, idx) => {
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const depth = h[1].length;
      if (closedDepth !== null && depth <= closedDepth) closedDepth = null;
      if (closedDepth === null && CLOSED_SECTION_RE.test(h[2])) closedDepth = depth;
      return;
    }
    if (closedDepth !== null) out.add(idx + 1);
  });
  return out;
}

const STUB_EXPLICIT_RE = /none open|nothing open|no open|no items/i;
const STUB_MAX_CHARS = 220; // below this, with no recognised item shape, call it a stub rather than "unparsed"

/**
 * Classify and parse one TODOS.md / docs/ISSUES.md-shaped file.
 * Tries checkbox format first (most files), then ID-keyed heading format,
 * then falls back to stub/unparsed depending on content length + an
 * explicit "none open" marker.
 */
export function parseTodoLikeFile(text, filePath) {
  const lines = text.split("\n");
  const inClosedSection = closedSectionLines(lines);

  // 1. Checkbox style.
  const checkboxMatches = [];
  lines.forEach((line, idx) => {
    const m = line.match(CHECKBOX_RE);
    if (m)
      checkboxMatches.push({
        lineNumber: idx + 1,
        closed: m[1].toLowerCase() === "x" || inClosedSection.has(idx + 1),
        text: m[2].trim(),
      });
  });
  if (checkboxMatches.length > 0) {
    const items = checkboxMatches
      .filter((c) => !c.closed)
      .map((c) => ({ file: filePath, line: c.lineNumber, text: c.text, format: "checkbox" }));
    return {
      file: filePath,
      format: "checkbox",
      parsed: checkboxMatches.length,
      open: items.length,
      closed: checkboxMatches.length - items.length,
      unparsed: null,
      stub: false,
      items,
    };
  }

  // 2. ID-keyed prose — either heading style (TM-###, YV-###, MI-### as a
  //    `### ID · Title` heading) or bullet style (`- **ID** — Title`).
  const idMatches = [];
  lines.forEach((line, idx) => {
    const hm = line.match(ID_HEADING_RE);
    if (hm) {
      const headingText = line.replace(/^#{2,6}\s+/, "").trim();
      const nextNonEmpty = lines.slice(idx + 1, idx + 4).find((l) => l.trim().length > 0) || "";
      const closed =
        CLOSED_MARKERS_RE.test(headingText) || CLOSED_MARKERS_RE.test(nextNonEmpty) || inClosedSection.has(idx + 1);
      idMatches.push({ lineNumber: idx + 1, id: hm[2], closed, text: headingText });
      return;
    }
    const bm = line.match(ID_BULLET_RE);
    if (bm) {
      const struckThrough = Boolean(bm[1] || bm[3]);
      const bulletText = line.replace(/^\s*-\s*/, "").trim();
      const closed = struckThrough || CLOSED_MARKERS_RE.test(bulletText) || inClosedSection.has(idx + 1);
      idMatches.push({ lineNumber: idx + 1, id: bm[2], closed, text: bulletText });
    }
  });
  if (idMatches.length > 0) {
    const items = idMatches
      .filter((c) => !c.closed)
      .map((c) => ({ file: filePath, line: c.lineNumber, text: c.text, id: c.id, format: "id-keyed" }));
    return {
      file: filePath,
      format: "id-keyed",
      parsed: idMatches.length,
      open: items.length,
      closed: idMatches.length - items.length,
      unparsed: null,
      stub: false,
      items,
    };
  }

  // 3. Stub: explicit "none open" marker, or short enough to plausibly hold
  //    no real content.
  const trimmed = text.trim();
  if (STUB_EXPLICIT_RE.test(text) || trimmed.length < STUB_MAX_CHARS) {
    return {
      file: filePath,
      format: "stub",
      parsed: 0,
      open: 0,
      closed: 0,
      unparsed: null,
      stub: true,
      stubReason: STUB_EXPLICIT_RE.test(text) ? "explicit 'none open' marker" : `file has only ${trimmed.length} chars of content`,
      items: [],
    };
  }

  // 4. Unrecognised format, real content -- MUST NOT report parsed: 0 (G2).
  return {
    file: filePath,
    format: "unrecognised",
    parsed: null,
    open: null,
    closed: null,
    unparsed: `format not recognised (${trimmed.length} chars, no checkbox lines, no ID-keyed headings, not a stub)`,
    stub: false,
    items: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Priority extraction (best-effort, for ranking only -- never invented)
// ─────────────────────────────────────────────────────────────────────────────

const PRIORITY_RE = /\bP([0-3])\b/;

export function extractPriority(text) {
  const m = text.match(PRIORITY_RE);
  return m ? Number(m[1]) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Dedup — exact normalized-text match only, never fuzzy.
// ─────────────────────────────────────────────────────────────────────────────

function normalizeForDedup(text) {
  return text
    .toLowerCase()
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Merge items whose normalized text is byte-identical. Returns
 * `{ items, mergedCount }` where each returned item carries a `sources`
 * array (length 1 if never merged). Never merges on similarity/substring —
 * per the task brief, uncertain dedup keeps both and says so; this function
 * has exactly one certainty tier (exact match) and does not pretend to a
 * second.
 */
export function dedupeItems(items) {
  const byKey = new Map();
  for (const item of items) {
    const key = normalizeForDedup(item.text);
    if (!byKey.has(key)) {
      byKey.set(key, { ...item, sources: [{ file: item.file, line: item.line }] });
    } else {
      byKey.get(key).sources.push({ file: item.file, line: item.line });
    }
  }
  const merged = [...byKey.values()];
  const mergedCount = items.length - merged.length;
  return { items: merged, mergedCount };
}

// ─────────────────────────────────────────────────────────────────────────────
// Top-level
// ─────────────────────────────────────────────────────────────────────────────

function readTextSafe(filePath) {
  try {
    return { text: readFileSync(filePath, "utf8"), error: null };
  } catch (err) {
    return { text: null, error: String(err.message || err) };
  }
}

/**
 * Build the full backlog view. Read-only: opens files, never writes.
 *
 * Returns:
 *   - `stateFiles`  -- one entry per STATE.md, each with its live-section items
 *   - `todoFiles`   -- one entry per TODOS.md, parsed/stub/unparsed per file
 *   - `issueFiles`  -- one entry per docs/ISSUES.md, same shape as todoFiles
 *   - `dropped`     -- walk-budget/depth drops from discovery (G3)
 *   - `totals`      -- { parsedFiles, unparsedFiles, stubFiles, parsedItems, unparsedFileList }
 *   - `ranked`      -- deduped, priority-then-file-order ranked item list
 *   - `mergedCount` -- how many duplicate items were folded during ranking
 */
export function backlog({ searchRoots } = {}) {
  const discovery = discoverBacklogFiles(searchRoots ? { searchRoots } : undefined);

  const stateFiles = discovery.stateMd.map((f) => {
    const { text, error } = readTextSafe(f);
    if (error) return { file: f, error, items: [] };
    const { items } = parseStateLiveSections(text, f);
    return { file: f, error: null, items };
  });

  function parseGeneric(files) {
    return files.map((f) => {
      const { text, error } = readTextSafe(f);
      if (error) {
        return { file: f, format: "unreadable", parsed: null, unparsed: `unreadable: ${error}`, stub: false, items: [] };
      }
      return parseTodoLikeFile(text, f);
    });
  }

  const todoFiles = parseGeneric(discovery.todosMd);
  const issueFiles = parseGeneric(discovery.issuesMd);

  const allRawItems = [
    ...stateFiles.flatMap((f) => f.items),
    ...todoFiles.flatMap((f) => f.items),
    ...issueFiles.flatMap((f) => f.items),
  ];

  for (const item of allRawItems) item.priority = extractPriority(item.text);

  const { items: dedupedItems, mergedCount } = dedupeItems(allRawItems);
  dedupedItems.sort((a, b) => {
    const pa = a.priority ?? 99;
    const pb = b.priority ?? 99;
    if (pa !== pb) return pa - pb;
    return 0; // stable: preserve discovery order otherwise
  });

  const genericFiles = [...todoFiles, ...issueFiles];
  const parsedFiles = genericFiles.filter((f) => f.format !== "unrecognised" && f.format !== "unreadable").length;
  const unparsedFileList = genericFiles.filter((f) => f.format === "unrecognised" || f.format === "unreadable");
  const stubFiles = genericFiles.filter((f) => f.stub).length;
  const parsedItems = genericFiles.reduce((sum, f) => sum + (f.open ?? 0), 0) + stateFiles.reduce((sum, f) => sum + f.items.length, 0);

  return {
    generatedAt: new Date().toISOString(),
    stateFiles,
    todoFiles,
    issueFiles,
    dropped: discovery.dropped,
    budgetExceeded: discovery.budgetExceeded,
    totals: {
      stateFilesRead: stateFiles.length,
      todoFilesRead: todoFiles.length,
      issueFilesRead: issueFiles.length,
      parsedFiles,
      unparsedFiles: unparsedFileList.length,
      stubFiles,
      parsedItems,
      unparsedFileList: unparsedFileList.map((f) => ({ file: f.file, reason: f.unparsed })),
    },
    ranked: dedupedItems,
    mergedCount,
  };
}
