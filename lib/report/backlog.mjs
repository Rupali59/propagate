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

import { SEARCH_ROOTS } from "../core/config.mjs";
import { isHandoverFile, foldHandovers } from "./handovers.mjs";
import { isPointerStubText } from "../migrate/workspace.mjs";

const SKIP_DIR_NAMES = new Set([
  "node_modules", ".git", ".next", "dist", "build", ".turbo", ".vercel",
  "Library", "Trash", ".cache", ".worktrees", "vendor", ".venv", "__pycache__",
  // ARCHIVES ARE NOT BACKLOG. Added 2026-08-22 when the handover source
  // surfaced `_archive/2026-08-22/HANDOVER-doppler-import-2026-08-20.md` --
  // a file archived that same day BECAUSE it was finished, immediately
  // reported back as outstanding work.
  //
  // Latent for the other three sources rather than new: measured the same day,
  // 0 of 35 STATE.md, 0 of 13 TODOS.md and 0 of 1 ISSUES.md happened to sit
  // under an archive directory, so the walk had been descending into archives
  // all along and simply had not found anything there yet.
  "_archive", "archive",
]);

const MAX_WALK_DEPTH = 6;
const WALK_BUDGET_MS = 20_000;

// ─────────────────────────────────────────────────────────────────────────────
// Discovery
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Walk SEARCH_ROOTS looking for STATE.md, TODOS.md, ISSUES.md (both the
 * legacy `docs/ISSUES.md` and the v3 sibling `<dir>/ISSUES.md`), and
 * handovers.
 * Bounded by depth and a wall-clock budget, same shape as
 * lib/inventory.mjs's repo walk -- any subtree not reached before the
 * budget expires is recorded in `dropped`, never silently omitted (G3).
 */
export function discoverBacklogFiles({ searchRoots = SEARCH_ROOTS, maxDepth = MAX_WALK_DEPTH, budgetMs = WALK_BUDGET_MS } = {}) {
  // claudeMd / gotchasMd / memoryMd added 2026-08-28 for `propagate caps`.
  // ADDITIVE: existing callers read only the keys they know, so widening the
  // result cannot change backlog's behaviour. Adding kinds here rather than
  // writing a second walk is deliberate -- two forks of one traversal is the
  // defect the size-caps review was about (`Vipin Kaushik` and
  // `PanditPawanKaushik` each held an improvement the other lacked, 80 lines
  // apart, and the union ran nowhere).
  const found = { stateMd: [], todosMd: [], issuesMd: [], handoverMd: [], claudeMd: [], gotchasMd: [], memoryMd: [] };
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

  /** File names in `parent`. Same never-throw contract as listDirs. */
  function listFiles(parent) {
    try {
      return readdirSync(parent, { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => e.name);
    } catch {
      return [];
    }
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
    // TWO paths, because the v3 layout move (2026-08-22/23) relocated ISSUES.md
    // and this reader was not repointed. `docs/ISSUES.md` is the pre-move
    // location; `<dir>/ISSUES.md` is where it lives now, as a SIBLING of
    // STATE.md under propagation/state/<project>/.
    //
    // Measured 2026-08-25, before the fix: the tree held exactly ONE ISSUES.md
    // -- propagate's own, 43 open entries -- and `backlog` printed
    // "0 docs/ISSUES.md discovered". The walk was already reaching that exact
    // directory (it picked up STATE.md beside it), so this was never the
    // traversal, only the path pattern.
    //
    // The failure mode is why both are kept rather than swapped: a reader that
    // emits ZERO reads as "no issues exist" rather than "I looked where they
    // are not" (rule:discernment-checks §6). Keeping the legacy path means an
    // unmigrated workspace does not lose its issues the day this lands.
    for (const rel of [["docs", "ISSUES.md"], ["ISSUES.md"]]) {
      const abs = path.join(dir, ...rel);
      if (existsSync(abs)) found.issuesMd.push(abs);
    }
    // HANDOVERS.md and dated HANDOVER-*.md. A fourth source rather than a
    // fourth reader: this walk, the depth bound and the time budget already
    // exist, and lib/report/handovers.mjs inherits the parsed/stub/unparsed
    // discipline the other three use.
    //
    // Matched by NAME rather than by a fixed filename, because handovers come
    // in two shapes -- one long append-only file plus dated single-topic ones
    // beside it -- and a check for only `HANDOVERS.md` would silently miss the
    // five dated ones the tree currently holds.
    for (const e of listFiles(dir)) {
      if (isHandoverFile(e)) found.handoverMd.push(path.join(dir, e));
    }
    // Capped context files that are not backlog registers. GOTCHAS.md carries
    // BOTH layouts for the same reason ISSUES.md does above: the v3 move is
    // partial, so dropping the pre-move path would silently unwatch every
    // project that has not migrated.
    if (existsSync(path.join(dir, "CLAUDE.md"))) found.claudeMd.push(path.join(dir, "CLAUDE.md"));
    if (existsSync(path.join(dir, "MEMORY.md"))) found.memoryMd.push(path.join(dir, "MEMORY.md"));
    for (const rel of [["docs", "GOTCHAS.md"], ["GOTCHAS.md"]]) {
      const abs = path.join(dir, ...rel);
      if (existsSync(abs)) found.gotchasMd.push(abs);
    }

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
      // DEEPEST NODE WINS. A subheading with bullets under it is a GROUP and its
      // bullets are the items; a subheading with only prose IS the item.
      //
      // Until 2026-08-26 this branch took EVERY subheading as an item and never
      // descended, so `## Pending (by priority)` -> `### P1 — Rebuild` reported
      // the bucket LABEL as work and the tasks beneath it were unreachable.
      // Measured across 48 STATE.md: 192 items reported, 353 actually present —
      // roughly 46% of the real backlog had never appeared in the tool, while
      // 29 priority labels appeared as if they were work. Wrong in both
      // directions at once, which is why no consumer of this list could be
      // trusted (and why `doctor`/`monitor` delivery waits on this landing).
      //
      // ONE RULE, NO NAMED SECTIONS. A `BUCKET_RE` matching P0-P3 was rejected:
      // a fixed list is the thing that rots, and `### High` / `### Later` /
      // `### Blocked` would break it silently. Structure is the signal — has
      // this heading children, or not.
      for (let s = 0; s < subheadings.length; s++) {
        const hm = subheadings[s].text.match(headingRe);
        const startIdx = bodyLines.findIndex((b) => b.lineNumber === subheadings[s].lineNumber);
        // Bounded by the NEXT subheading at any level: a deeper heading owns its
        // own bullets, so they must not leak up into this one.
        const endLine = s + 1 < subheadings.length ? subheadings[s + 1].lineNumber : Infinity;
        const kids = bodyLines
          .slice(startIdx + 1)
          .filter((b) => b.lineNumber < endLine && /^-\s+(.+)$/.test(b.text));
        if (kids.length > 0) {
          for (const k of kids) {
            items.push({
              file: filePath,
              line: k.lineNumber,
              section: sectionName,
              group: hm[2].trim(), // "P1 — Rebuild" as CONTEXT, never as an item
              text: k.text.match(/^-\s+(.+)$/)[1].trim(),
              format: "state-bullet",
            });
          }
        } else {
          items.push({
            file: filePath,
            line: subheadings[s].lineNumber,
            section: sectionName,
            text: hm[2].trim(),
            format: "state-subheading",
          });
        }
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
// The DASHLESS leading-id form: `### N1 · ...`, `### G12 · ...`. propagate's own
// ISSUES.md numbers 43 entries this way and every one was invisible, because
// ID_HEADING_RE above requires 2-6 letters, a dash, then 2-4 digits (TM-010,
// YV-004). Combined with the stub bug this file reported as an empty stub.
//
// ANCHORED at the start of the heading text, unlike ID_HEADING_RE which matches
// an id anywhere in the line. That is deliberate and it is the whole safety
// margin: `N1` is a far weaker fingerprint than `TM-010`, so an unanchored
// version would promote ordinary headings ("## V2 roadmap", "### Fix S1 first")
// into backlog items. Requiring the id to BE the start of the heading matches
// the convention every register in this tree actually uses.
const ID_HEADING_LEADING_RE = /^(#{2,6})\s+([A-Z]{1,3}\d{1,4})\s*[·:—–-]\s+(.*)$/;
// The separator is REQUIRED, and it is what makes the weak fingerprint safe.
// Anchoring alone was not enough: "## V2 roadmap and beyond" leads with a
// matching id and is a section heading, not an item. Every real register in
// this tree writes `### N1 · Title` / `### YV-004 · Title`, so demanding the
// separator keeps all 63 of propagate's entries and rejects prose headings.
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

/** The path a pointer stub names, for the reader who wants to follow it. */
function pointerStubTarget(text) {
  const m = text.match(/now lives at\s+`([^`]+)`/i);
  return m ? m[1] : null;
}
// Below this, with no recognised item shape, call it a stub rather than "unparsed".
const STUB_MAX_CHARS = 220;
// How far into a file an explicit "none open" marker is still read as a
// DECLARATION rather than a passing mention. Generous enough for a title, a
// blockquote and a sentence; far short of the :906 prose that caused the bug.
const STUB_MARKER_WINDOW = 400;

/**
 * Classify and parse one TODOS.md / docs/ISSUES.md-shaped file.
 * Tries checkbox format first (most files), then ID-keyed heading format,
 * then falls back to stub/unparsed depending on content length + an
 * explicit "none open" marker.
 */
export function parseTodoLikeFile(text, filePath) {
  // POINTER STUBS FIRST, before any other classification. The v3 migration
  // leaves one at every moved artifact's old path, and 14 of the tree's 23
  // TODOS.md are stubs. They carried no checkbox and no ID heading, so they fell
  // through to `unparsed` and rendered RED as "format not recognised" —
  // 14 of 23 files reported broken while working exactly as designed.
  //
  // That is not a cosmetic complaint. An unparsed file is a REAL defect signal
  // ("something here I could not read"), and drowning it in 14 false positives
  // trains the reader to skip the whole list, which is how the one genuinely
  // unreadable file goes unnoticed.
  //
  // A distinct format rather than reusing `stub`, because they assert different
  // things: `stub` says nothing is open HERE, a pointer stub says the state is
  // somewhere ELSE and is counted there. The target is discovered separately by
  // the same walk — Motherboard's real TODOS.md parses with 39 open — so
  // counting the stub as 0 open is correct and NOT a silent loss.
  //
  // The predicate is imported, never restated: lib/migrate/workspace.mjs owns it
  // and its writer deliberately emits the phrase this matches.
  if (isPointerStubText(text)) {
    return {
      file: filePath,
      format: "pointer-stub",
      parsed: 0,
      open: 0,
      closed: 0,
      unparsed: null,
      stub: true,
      stubReason: pointerStubTarget(text)
        ? `pointer stub — state lives at ${pointerStubTarget(text)}`
        : "pointer stub — state lives elsewhere (target not named)",
      items: [],
    };
  }

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
    // Dashed form first (stronger fingerprint), then the dashless leading form.
    const hm = line.match(ID_HEADING_RE) || line.match(ID_HEADING_LEADING_RE);
    if (hm) {
      const headingText = line.replace(/^#{2,6}\s+/, "").trim();
      // Look ahead for a closed marker in this entry's BODY, stopping at the
      // next heading. Crossing it attributes the FOLLOWING entry's status to
      // this one: with `### A2 · open` immediately above
      // `### B3 · **RESOLVED**`, A2 was reported closed. Pre-existing, and it
      // only bites where entries are adjacent headings with no body — which
      // is exactly how a terse register is written.
      const nextNonEmpty =
        lines
          .slice(idx + 1, idx + 4)
          .filter((l) => !/^#{1,6}\s/.test(l))
          .find((l) => l.trim().length > 0) || "";
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
  // AND on length, not OR. Until 2026-08-25 this was
  // `STUB_EXPLICIT_RE.test(text) || trimmed.length < STUB_MAX_CHARS`, so the
  // phrase "no open" ANYWHERE, at ANY size, declared the whole file a stub with
  // open:0. propagate's own ISSUES.md -- 43 entries, ~900 lines -- says "no
  // open" twice in prose at :906 and :933 and was reported as an empty stub.
  //
  // A stub is a SHORT file that says nothing is open. A long file that happens
  // to contain the phrase is the opposite: it is a register with content the
  // classifier failed to recognise, and calling that "stub" converts a parser
  // gap into a confident, false "0 open".
  // The marker still counts, but only where a DECLARATION can live: the head of
  // the file. A file that opens with "none open" is a stub; a file that mentions
  // the phrase 900 lines into prose is not.
  const looksLikeStub =
    trimmed.length < STUB_MAX_CHARS || STUB_EXPLICIT_RE.test(trimmed.slice(0, STUB_MARKER_WINDOW));
  if (looksLikeStub) {
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
/**
 * The identity of a work item.
 *
 * An item that carries an `id` (the ID-keyed formats parse one — TM-010, N1,
 * YV-004) is identified BY that id, scoped to its file: project registers number
 * independently, so `Tushar`'s `YV-004` and a hypothetical `YV-004` elsewhere are
 * different work. An item with no id has only its prose.
 *
 * WHY THIS IS NOT JUST `normalizeForDedup(text)`, which it was until 2026-08-26:
 *
 *   - it DISCARDED an id the parser had already extracted, so rewording an entry
 *     minted a new item and dropped its history — the `edge_id` churn hazard
 *     `docs/LIFECYCLE.md` names, one layer up;
 *   - and it COLLIDED on prose, so five unrelated files whose live sections each
 *     contained a bare `P2` line merged into a single "item". Measured before the
 *     fix: `mergedCount` 18, of which the merges included bare `P1`/`P2`/`P3`.
 *
 * Those are opposite errors from one line: the same work counted twice, and
 * different work counted once.
 */
function identityOf(item) {
  return item.id ? `id:${item.file}#${item.id}` : `text:${normalizeForDedup(item.text)}`;
}

export function dedupeItems(items) {
  const byKey = new Map();
  for (const item of items) {
    const key = identityOf(item);
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
/**
 * The DEFECTS in a backlog result — the things that mean the tool cannot see
 * some of the work, as distinct from the work itself.
 *
 * ONE DEFINITION, TWO READERS. `doctor` and `monitor` both consume this rather
 * than each deciding what counts. `lib/report/monitor.mjs` records why:
 * `isActionable` lives in `lib/graph.mjs` so the monitor, `graph`'s worklist and
 * `drain`'s hint "can never disagree about what counts as work — two commands
 * reporting different totals for 'what needs doing' is worse than either being
 * slightly wrong, and that already happened once (23 vs 21)."
 *
 * WHAT IS DELIBERATELY NOT A DEFECT: the open items. There were 500 of them on
 * 2026-08-26 and that is the normal state of a working tree, not a fault.
 * Notifying on it is how a channel gets muted, and a muted channel is worth less
 * than no channel — the reader stops looking at the one line that matters.
 *
 * A defect here is always the same shape: **work exists that no count can see.**
 *
 * @param {ReturnType<typeof backlog>} result
 * @returns {Array<{kind: string, file: string, detail: string, key: string}>}
 */
export function backlogDefects(result) {
  const out = [];

  for (const f of result.totals?.unparsedFileList ?? []) {
    // `unreadable` and `unrecognised` are both here but they are different
    // facts, and the `kind` keeps them apart: one is a permissions/IO problem,
    // the other is a format nothing can parse. Collapsing them would send
    // someone to fix the wrong thing.
    const unreadable = /^unreadable:/.test(f.reason || "");
    out.push({
      kind: unreadable ? "unreadable" : "unparsed",
      file: f.file,
      detail: f.reason || "format not recognised",
      key: `backlog:${unreadable ? "unreadable" : "unparsed"}:${f.file}`,
    });
  }

  // A handover file where NOTHING is scoped cannot be closed and cannot report
  // anything as still open — every section reads `unknown`, which is the honest
  // third state and also a dead end. Per FILE, not per section: 16 separate
  // notifications for one file is the noise this function exists to avoid.
  for (const f of result.handovers?.files ?? []) {
    if (f.error) {
      out.push({ kind: "unreadable", file: f.file, detail: f.error, key: `backlog:unreadable:${f.file}` });
      continue;
    }
    const secs = f.sections ?? [];
    if (secs.length === 0) continue;
    const unscoped = secs.filter((s) => s.status === "unknown").length;
    if (unscoped === secs.length) {
      out.push({
        kind: "handover-unscoped",
        file: f.file,
        detail: `${secs.length} section(s), none carrying **Done when:** or **Resolved:** — none can be closed, or reported as still open`,
        key: `backlog:handover-unscoped:${f.file}`,
      });
    }
  }

  return out;
}

export function backlog({ searchRoots } = {}) {
  const discovery = discoverBacklogFiles(searchRoots ? { searchRoots } : undefined);

  const stateFiles = discovery.stateMd.map((f) => {
    const { text, error } = readTextSafe(f);
    if (error) return { file: f, error, format: "unreadable", items: [] };
    // POINTER STUBS FIRST, exactly as parseTodoLikeFile does at the top of its
    // own dispatch. This branch did not make the call, and the predicate was
    // right about every one of them — so seven signposts reported
    // `state-live-sections, 0 open`, which is indistinguishable from a project
    // that genuinely has no open work. `0 open` is the reading that makes work
    // disappear. Filed as N56; the gap survived because the check was written
    // once for the checkbox/id-keyed paths and this reader was added later.
    if (isPointerStubText(text)) {
      const target = pointerStubTarget(text);
      return {
        file: f,
        error: null,
        format: "pointer-stub",
        detail: target
          ? `pointer stub — state lives at ${target}`
          : "pointer stub — state lives elsewhere (target not named)",
        items: [],
      };
    }
    const { items } = parseStateLiveSections(text, f);
    return { file: f, error: null, format: "state-live-sections", items };
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

  // Handovers are reported as SECTIONS with a discharge state, not folded into
  // `ranked` items. A handover is a briefing, not a task line: merging it into
  // the item list would put "Four repos carry uncommitted propagation fixes"
  // beside "TM-015 Daily sky timelapse video" and rank them together.
  const handovers = foldHandovers(discovery.handoverMd ?? []);

  return {
    generatedAt: new Date().toISOString(),
    stateFiles,
    todoFiles,
    issueFiles,
    handovers,
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

// ─────────────────────────────────────────────────────────────────────────────
// --affects <scope> — a scoped INDEX over the tree-wide walk, never a copy.
//
// Measured 2026-08-27: 31 of 63 entries in propagate's own ISSUES.md name a
// DIFFERENT repo. N53 is an issue about `Vipin Kaushik/scripts/hygiene/lib/
// size-caps.sh`, filed here, invisible to anyone standing in that workspace.
//
// That is not a propagation gap. Copying issues downward would create a second
// register to keep in sync — the two-ledger problem already filed as A2. What
// was missing is the ability to ask a scoped question of data already walked:
// rule:delegation-criteria §2, derive on demand rather than remember.
// ─────────────────────────────────────────────────────────────────────────────

/** Every path segment appearing in any discovered register path. */
export function repoSegments(result) {
  const seen = new Set();
  const paths = [
    ...(result.stateFiles ?? []).map((f) => f.file),
    ...(result.todoFiles ?? []).map((f) => f.file),
    ...(result.issueFiles ?? []).map((f) => f.file),
    ...(result.handovers?.files ?? []).map((f) => f.file),
  ];
  for (const p of paths) {
    for (const seg of String(p).split("/")) {
      if (seg && seg !== "." && !seg.endsWith(".md")) seen.add(seg);
    }
  }
  return seen;
}

export function affectsMatcher(name) {
  const needle = String(name).toLowerCase();
  return {
    inPath: (file) => {
      const f = String(file ?? "").toLowerCase();
      return f.includes(`/${needle}/`) || f.startsWith(`${needle}/`);
    },
    inText: (text) => String(text ?? "").toLowerCase().includes(needle),
  };
}

/**
 * Reconstruct each ranked item's BODY from the file it came from.
 *
 * Ranked items carry `text` = the heading only. Matching on that alone found 2
 * cross-filed items for `Vipin Kaushik` where bodies find 24 — because an issue
 * titled "N53 · The size-cap check reads STATE.md at the pre-move path" never
 * names the repo it is entirely about. A title-only reader reports a small,
 * plausible, wrong number: rule:discernment-checks §6.
 *
 * Items within a file are contiguous, so an item's body runs from its own line
 * to the line before the next item in that same file.
 *
 * An UNREADABLE file yields no entry rather than an empty string, so the caller
 * can tell "no match" from "never looked" — §2, absence must be attributable.
 */
export function bodiesByItem(ranked, readFile) {
  const read = readFile ?? ((f) => readFileSync(f, "utf8"));
  const byFile = new Map();
  for (const it of ranked ?? []) {
    if (!it.file) continue;
    if (!byFile.has(it.file)) byFile.set(it.file, []);
    byFile.get(it.file).push(it);
  }
  const bodies = new Map();
  for (const [file, items] of byFile) {
    let lines;
    try {
      lines = String(read(file)).split("\n");
    } catch {
      continue;
    }
    items.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
    for (let i = 0; i < items.length; i++) {
      const start = Math.max(0, (items[i].line ?? 1) - 1);
      const end = i + 1 < items.length ? Math.max(start, (items[i + 1].line ?? lines.length) - 1) : lines.length;
      bodies.set(items[i], lines.slice(start, end).join("\n"));
    }
  }
  return bodies;
}

/**
 * Split ranked items and handover sections by scope. MUTATES `result` (the
 * caller owns a fresh object from `backlog()`), and returns the stats.
 *
 * `filedElsewhere` is the answer that matters: work recorded about this scope,
 * in someone else's register, that you cannot reach by opening your own.
 */
export function filterByAffects(result, name, readFile) {
  const { inPath, inText } = affectsMatcher(name);
  const rankedBefore = (result.ranked ?? []).length;
  const bodies = bodiesByItem(result.ranked ?? [], readFile);

  let bodyless = 0;
  const own = [], foreign = [];
  for (const it of result.ranked ?? []) {
    const paths = [it.file, ...(it.sources ?? []).map((s) => s.file)];
    if (paths.some((p) => inPath(p))) { own.push(it); continue; }
    const body = bodies.get(it);
    if (body === undefined) bodyless++;
    if (inText(body ?? it.text)) foreign.push(it);
  }
  result.ranked = [...foreign, ...own];

  let hoBefore = 0, hoForeign = 0;
  if (result.handovers?.files) {
    for (const f of result.handovers.files) {
      const secs = f.sections ?? [];
      hoBefore += secs.length;
      f.sections = secs.filter((sec) => {
        const hay = `${sec.title ?? ""} ${sec.doneWhen ?? ""} ${sec.body ?? ""}`;
        const match = inText(hay) || inPath(f.file);
        if (match && !inPath(f.file)) hoForeign++;
        return match;
      });
    }
    result.handovers.files = result.handovers.files.filter((f) => (f.sections ?? []).length > 0);
  }

  return {
    scope: name,
    rankedBefore,
    filedElsewhere: foreign.length,
    filedHere: own.length,
    handoverSectionsBefore: hoBefore,
    handoverSectionsElsewhere: hoForeign,
    bodylessItems: bodyless,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// --brief — the planning-shaped grouping.
//
// Full `backlog` output is 120 KB, of which 107 KB is the ranked list at a mean
// 209 chars per item. It exceeded the tool output limit twice in one session and
// had to be spilled to a file both times — which made the ONE derivation
// carrying open work the one you could not put in front of a planner.
//
// Pure so it can be tested. The renderer in cli.mjs only prints what this
// returns; every decision that could LOSE an item lives here.
// ─────────────────────────────────────────────────────────────────────────────

export const BRIEF_TRUNC = 90;

/**
 * @returns {{ groups: Map<string, Array>, truncated: number, byPriority: object,
 *             listed: number }}
 *
 * `listed` MUST equal `ranked.length`. Grouping and truncation shorten TEXT;
 * neither may drop an item. A digest that quietly loses rows is worse than no
 * digest, so the count is returned for the caller to assert on rather than
 * trusted (rule:discernment-checks §2).
 */
export function groupForBrief(ranked, { trunc = BRIEF_TRUNC, workspaceOf } = {}) {
  const wsOf = workspaceOf ?? ((f) => String(f ?? "").split("/")[0] || "(unknown)");
  const groups = new Map();
  const byPriority = { P0: 0, P1: 0, P2: 0, P3: 0, P4: 0, none: 0 };
  let truncated = 0, listed = 0;

  for (const item of ranked ?? []) {
    const ws = wsOf(item.file);
    if (!groups.has(ws)) groups.set(ws, []);

    // Collapse whitespace first: several registers wrap an entry across lines,
    // and without this a "90 char" line can render as four.
    let text = String(item.text ?? "").replace(/\s+/g, " ").trim();
    if (text.length > trunc) { text = text.slice(0, trunc - 1) + "…"; truncated++; }

    groups.get(ws).push({ ...item, briefText: text });
    listed++;

    const k = item.priority === null || item.priority === undefined ? "none" : `P${item.priority}`;
    if (byPriority[k] !== undefined) byPriority[k]++;
  }

  // Biggest group first — that is where the work is, and a planner scanning a
  // digest reads from the top.
  const sorted = new Map([...groups].sort((a, b) => b[1].length - a[1].length));
  return { groups: sorted, truncated, byPriority, listed };
}
