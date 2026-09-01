/**
 * lib/claims/check.mjs — `propagate claims check`: five DETERMINISTIC checks
 * over the declared-edge corpus (every `.propagates.yml` source and every
 * downstream it declares).
 *
 * NORMATIVE, per the Phase 2 plan's LLM/deterministic split table, restated
 * here because this is the module the split is ABOUT: THIS MODULE MUST
 * IMPORT NO MODEL/SDK CLIENT AND MAKE NO NETWORK CALL. No `fetch`, no
 * `http`/`https`, no `@anthropic-ai/*` or any other SDK. Twice this session
 * (N35, N63) a judgment call got implemented as a regex and produced errors
 * in both directions — the fix both times was not "write a smarter regex",
 * it was "stop pretending this half is judgment when it's mechanical, and
 * stop pretending that half is mechanical when it's judgment." The five
 * checks below are the genuinely mechanical half: string extraction, date
 * arithmetic, `existsSync`, and a LOCAL `git rev-parse --verify` against
 * refs already on disk (no fetch, no push, no remote round trip — see
 * `findDeadBranchCitations` below). `lib/claims/judge.mjs` (a later lane)
 * is where a model belongs; if a check in this file ever needs one to
 * decide an answer, it does not belong in this file, full stop.
 * `tests/unit/claims-check-boundary.test.mjs` asserts this by reading this
 * module's own source text and failing on any of: `fetch(`, `node:http`,
 * `node:https`, `@anthropic-ai`, `openai`, or any other model-SDK import —
 * so the boundary is enforced, not merely stated.
 *
 * WHAT THIS MODULE DOES NOT DO: it does not print. Per `commands/ansi.mjs`'s
 * own header — "zero of 58 lib/ modules contain an ANSI escape, and none of
 * them print" — this module takes the tree as input and returns structured
 * findings; `commands/claims.mjs` is the only file that renders them.
 *
 * THE CORPUS is every file declared as a `sources.<key>` entry in any
 * `.propagates.yml`, plus every non-glob file its `propagates_to` names —
 * i.e. exactly the set of files `.propagates.yml` already asserts are
 * coupled to each other. This is deliberate, not merely convenient: it
 * means every finding here is about a coupling someone already declared,
 * never about an incidental pair of files that happen to share a word.
 * Glob downstreams (`kind: code` entries whose `path` contains `* ? [ ]`)
 * are recorded as SKIPPED, never silently dropped — expanding a glob
 * safely needs the same fs-walk `processChange` already does in
 * `watcher.mjs`, and duplicating that here would be a second walker for
 * one check when `rule:tool-priority`'s whole point is that a second copy
 * is one edit away from being the copy that disagrees.
 *
 * REUSE, NOT REBUILD: `findAllSidecarsRecursive` / `loadSidecar` /
 * `downstreamsFor` (lib/edges/edges.mjs, lib/edges/frontmatter.mjs) do the
 * sidecar discovery and parsing — this file does not walk a tree looking
 * for `.propagates.yml` a second time. `readTextSafe` (lib/report/backlog.mjs,
 * exported 2026-08-31 for exactly this kind of reuse) reads a file into the
 * same `{text, error}` two-outcome shape every other reader in this repo
 * uses. `nearestOwner` (lib/core/discovery.mjs) attributes a finding to its
 * nearest-owning workspace — never a string-prefix split (F7's bug).
 * `resolveRepo` (lib/edges/content-id.mjs) finds the nearest git root for
 * the branch-citation check; NOT `contentId()` from the same module, which
 * the Phase 1 rollup plan already ruled out for a different reason (it
 * returns `unresolvable: "no-repo"` outside a repo) — here that exact
 * behaviour is what we want: a citation check with no repo to check against
 * has nothing to do, and `resolveRepo` returning `null` says so directly.
 */

import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

import { shortPath } from "../core/config.mjs";
import { nearestOwner } from "../core/discovery.mjs";
import { readTextSafe } from "../report/backlog.mjs";
import { findAllSidecarsRecursive } from "../edges/edges.mjs";
import { loadSidecar } from "../edges/frontmatter.mjs";
import { resolveRepo } from "../edges/content-id.mjs";

// ─────────────────────────────────────────────────────────────────────────
// Corpus — walk declared sidecars, resolve every source + non-glob
// downstream to an absolute path. Two views over the same walk:
//   `fileEntries`  — Map<absPath, {sources:[], downstreams:[]}>, ONE entry
//                    per unique file (by realpath-free path.resolve — good
//                    enough here since we never write, only read), used by
//                    the checks that operate on a single file in isolation
//                    (expired dates, footer staleness, rotted citations).
//   `sourceEdges`  — flat list, one per declared `sources.<key>` entry,
//                    carrying its own resolved downstream list. Used by the
//                    checks that compare a source against ITS OWN declared
//                    downstream (concept tokens, price literals) — those
//                    need the edge, not just the file.
// ─────────────────────────────────────────────────────────────────────────

function ensureFileEntry(map, absPath) {
  if (!map.has(absPath)) map.set(absPath, { sources: [], downstreams: [] });
  return map.get(absPath);
}

/**
 * @param {{workspaces: Array<{root:string,name?:string}>}} opts
 * @returns {Promise<{
 *   fileEntries: Map<string, {sources: Array, downstreams: Array}>,
 *   sourceEdges: Array,
 *   globsSkipped: Array<{sidecar:string, sourceKey:string, path:string}>,
 *   sidecarsChecked: string[],
 *   sidecarsUnreadable: Array<{sidecar:string, reason:string}>,
 * }>}
 */
export async function buildClaimsCorpus({ workspaces = [] } = {}) {
  const fileEntries = new Map();
  const sourceEdges = [];
  const globsSkipped = [];
  const sidecarsChecked = [];
  const sidecarsUnreadable = [];
  const walkedSidecars = new Set(); // dedupe: findAllSidecarsRecursive is called once per
  // workspace root and is already bounded at nested-workspace boundaries (same guarantee
  // enumerateDeclaredSources/synthesizeKindCodeEntries rely on in lib/edges/edges.mjs), but
  // two DISJOINT workspace roots can still legitimately resolve the same sidecar path via a
  // symlink; this Set is the belt to that walk's suspenders, keyed on the raw path since a
  // realpath round trip here would cost one syscall per sidecar for a case that has not been
  // observed, only reasoned about.

  for (const ws of workspaces) {
    let sidecarPaths;
    try {
      // Second arg explicit, NOT the default: the default is production
      // WORKSPACES from lib/core/config.mjs, which is correct for real
      // runs (the caller always passes `workspaces: WORKSPACES` there) but
      // WRONG for a test passing a synthetic `workspaces` list — the walk
      // would then stop at production workspace boundaries instead of the
      // fixture's, silently under-walking the fixture tree. Caught by
      // exactly that failure in tests/unit/claims-check.test.mjs.
      sidecarPaths = await findAllSidecarsRecursive(
        ws.root,
        workspaces.map((w) => w.root),
      );
    } catch (err) {
      sidecarsUnreadable.push({ sidecar: ws.root, reason: `sidecar walk failed: ${err.message}` });
      continue;
    }
    for (const sidecarPath of sidecarPaths) {
      if (walkedSidecars.has(sidecarPath)) continue;
      walkedSidecars.add(sidecarPath);
      let sidecar;
      try {
        sidecar = await loadSidecar(sidecarPath);
      } catch (err) {
        sidecarsUnreadable.push({ sidecar: sidecarPath, reason: err.message });
        continue;
      }
      sidecarsChecked.push(sidecarPath);
      const sidecarDir = path.dirname(sidecarPath);
      for (const [sourceKey, entry] of Object.entries(sidecar.sources || {})) {
        const sourceAbs = path.resolve(sidecarDir, sourceKey);
        ensureFileEntry(fileEntries, sourceAbs).sources.push({ sidecarPath, sourceKey });

        const downstreams = [];
        for (const d of entry.propagates_to || []) {
          if (/[*?[\]]/.test(d.path)) {
            globsSkipped.push({ sidecar: sidecarPath, sourceKey, path: d.path });
            continue;
          }
          const downAbs = path.resolve(sidecarDir, d.path);
          ensureFileEntry(fileEntries, downAbs).downstreams.push({ sidecarPath, sourceKey, sourceAbs });
          downstreams.push({ abs: downAbs, kind: d.kind || "prose", why: d.why });
        }

        sourceEdges.push({
          sidecarPath,
          sourceKey,
          sourceAbs,
          concepts: entry.concepts || null,
          downstreams,
        });
      }
    }
  }

  return { fileEntries, sourceEdges, globsSkipped, sidecarsChecked, sidecarsUnreadable };
}

// ─────────────────────────────────────────────────────────────────────────
// Check 1 — expired dates. A date, or the end of a date RANGE, that has
// already passed, with nothing marking it as expired.
//
// Deliberately NOT "every ISO date in the file" — most dates in these docs
// are provenance stamps ("Last consolidated: 2026-05-04", "Vastu superseded
// 2026-07-15") that are correct forever and would drown three real findings
// in noise. Scoped instead to a MARKER vocabulary that means "this holds
// until/through X" — through / until / thru / resumes / expires / an arrow
// (→ or ->) — because every known positive this check must reproduce is
// exactly that shape:
//   "### Online-only window (2026-05-04 → ~2026-08-04)"      (the constitution doc)
//   "Online-only booking window ... through ~2026-08-04."     (CLAUDE.md)
//   `availabilityNote: "Resumes August 2026"`                 (pricing.ts)
// The third is a bare Month+Year, not ISO — treated as expiring at the END
// of that month (last calendar day), so "August 2026" reads as expired once
// "now" reaches any day in or after August 2026. That is deliberately
// coarse: a month-level literal never claimed a day, so it cannot be judged
// against one.
//
// KNOWN, ACCEPTED NOISE: "through|until|thru" also matches a past-tense
// correction ("this said so UNTIL 2026-08-25") that is not a live
// commitment at all — it is prose describing when a DIFFERENT, already-
// fixed mistake was fixed. Measured against the live corpus: 3 of 4
// findings in `Vipin Kaushik/CLAUDE.md` are this shape. Narrowing the
// marker vocabulary to exclude it risks losing recall on a genuine
// "documented as true until it stopped being true" case elsewhere in the
// tree, and a check that fires on a closed correction is a much cheaper
// mistake than one that stays silent on an open window — see
// `rule:discernment-checks` §1. Left as-is, deliberately, with this note
// so nobody "fixes" it into a narrower miss.
// ─────────────────────────────────────────────────────────────────────────

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MONTH_INDEX = new Map(MONTH_NAMES.map((m, i) => [m.toLowerCase(), i]));

// Each pattern below pairs a marker with a date it is DIRECTLY, adjacently
// attached to — not "a marker somewhere near a date." An earlier draft
// scanned a 60-char window after any `through|until|thru|resumes?|expires?|
// →|->` and picked up the first date in it; against the live corpus that
// matched "hero `Book a consultation →` button shipped 2026-05-31" — the
// arrow is UI copy, the date 26 characters later is an unrelated ship date,
// and the two have nothing to do with each other. Requiring adjacency (only
// whitespace, and an optional `~`, between the marker and the date) keeps
// every known positive and drops that false pairing, because "→ shipped"
// has a comma-and-clause between the arrow and the date, not whitespace.
const RANGE_ARROW_RE = /(?:→|->)\s*(~?)(\d{4})-(\d{2})-(\d{2})/g;
const THROUGH_UNTIL_ISO_RE = /\b(through|until|thru)\s+(~?)(\d{4})-(\d{2})-(\d{2})\b/gi;
const RESUME_EXPIRE_ISO_RE = /\b(resumes?|expires?)\s+(~?)(\d{4})-(\d{2})-(\d{2})\b/gi;
const MONTH_YEAR_MARKER_RE = new RegExp(
  `\\b(resumes?|expires?|through|until|thru)\\s+(${MONTH_NAMES.join("|")})\\s+(\\d{4})\\b`,
  "gi",
);
// Already-acknowledged: a line carrying one of these words is not "nothing
// marks it as expired" — it IS the mark. Suppresses the finding rather than
// flagging a line that already says the window closed.
const ALREADY_ACKNOWLEDGED_RE = /\b(expired|lapsed|closed|ended|superseded|retired|resumed|lifted|removed|past)\b/i;

/**
 * A HISTORICAL RECORD, not an expiring claim — and the distinction is the whole
 * reason this module exists.
 *
 * Measured on the live tree 2026-08-31, the first run of this check reported 49
 * "expired date" findings. Most were sentences like:
 *
 *   "This line carried 'measured 2026-08-20, four projects' UNTIL 2026-08-29,
 *    when removing Tathya-portfolio's entry made it three"
 *
 * That is a record of a correction already made — the healthiest kind of sentence
 * in this tree, and the register `rule:state-and-decisions` asks people to write.
 * Read as a deadline, it is a false positive; worse, it punishes exactly the
 * behaviour the rules reward.
 *
 * This is N63's defect reproduced inside the check built to avoid it: a regex
 * answering a question that needs judgment. "A date has passed" is mechanical.
 * "This file still ASSERTS something that expired" is not.
 *
 * THIS PATTERN DOES NOT SUPPRESS ANYTHING, AND THAT IS THE POINT.
 *
 * It was written as a suppressor first. Applied, it broke four tests in this
 * module's own suite by filtering out real findings whose fixture text happened
 * to contain "read" or "was" — the mirror-image error, made within minutes of
 * writing the paragraph above warning against it. That is the third instance in
 * one session (N35 too narrow, N63 too broad, this one both), and it is the
 * clearest possible evidence for the boundary: no regex separates "records a past
 * change" from "asserts an expired window", because the difference is what the
 * sentence MEANS.
 *
 * So it only COUNTS. `claims check` reports every passed date as a CANDIDATE and
 * prints how many look historical; `claims judge` decides. A candidate is not a
 * defect, and this module never claims otherwise. Counted-and-shown beats
 * filtered-and-hidden: `rule:enforcement-watches-itself` §4 — "found nothing" and
 * "looked at nothing" must be different outputs, and a silent filter collapses them.
 */
const HISTORICAL_RECORD_RE =
  /\b(was|were|had|carried|said|read|stood|listed|claimed|asserted|contained|showed|reported|used to|previously|formerly)\b[^.]{0,120}?\b(until|through|thru)\b/i;

function utcDayStamp(y, mIdx, d) {
  return Date.UTC(y, mIdx, d);
}

function todayUtcStamp(now) {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

function monthYearEndStamp(monthName, year) {
  const monthIdx = MONTH_INDEX.get(monthName.toLowerCase());
  // Day 0 of the FOLLOWING month == the last calendar day of this one.
  return utcDayStamp(Number(year), monthIdx + 1, 0);
}

/**
 * @param {string} text
 * @param {{now?: Date}} [opts]
 * @returns {Array<{line:number, snippet:string, marker:string, dateText:string, approx:boolean, expiredISO:string, daysExpired:number}>}
 */
export function findExpiredDates(text, { now = new Date() } = {}) {
  const findings = [];
  const nowStamp = todayUtcStamp(now);
  const lines = text.split("\n");

  const record = (lineNo, line, marker, dateText, approx, expiredStamp) => {
    if (expiredStamp > nowStamp) return;
    const daysExpired = Math.round((nowStamp - expiredStamp) / 86_400_000);
    findings.push({
      line: lineNo,
      snippet: line.trim(),
      marker,
      dateText,
      approx,
      expiredISO: new Date(expiredStamp).toISOString().slice(0, 10),
      daysExpired,
    });
  };

  // Suppressions are COUNTED, not silent. `rule:enforcement-watches-itself` §4:
  // "found nothing" and "looked at nothing" must be different outputs — and a
  // filter that quietly drops most of what it saw makes them identical.
  const suppressed = { acknowledged: 0, historical: 0 };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (ALREADY_ACKNOWLEDGED_RE.test(line)) {
      suppressed.acknowledged++;
      continue;
    }
    // A past-tense record of a change already made is NOT a lapsed deadline —
    // but that call is JUDGMENT and does not belong in this file. Counted here,
    // never suppressed. See HISTORICAL_RECORD_RE's comment.
    if (HISTORICAL_RECORD_RE.test(line)) suppressed.historical++;
    const lineNo = i + 1;

    RANGE_ARROW_RE.lastIndex = 0;
    let m;
    while ((m = RANGE_ARROW_RE.exec(line))) {
      const approx = m[1] === "~";
      record(lineNo, line, "→", `${approx ? "~" : ""}${m[2]}-${m[3]}-${m[4]}`, approx, utcDayStamp(Number(m[2]), Number(m[3]) - 1, Number(m[4])));
    }

    THROUGH_UNTIL_ISO_RE.lastIndex = 0;
    while ((m = THROUGH_UNTIL_ISO_RE.exec(line))) {
      const approx = m[2] === "~";
      record(lineNo, line, m[1], `${approx ? "~" : ""}${m[3]}-${m[4]}-${m[5]}`, approx, utcDayStamp(Number(m[3]), Number(m[4]) - 1, Number(m[5])));
    }

    RESUME_EXPIRE_ISO_RE.lastIndex = 0;
    while ((m = RESUME_EXPIRE_ISO_RE.exec(line))) {
      const approx = m[2] === "~";
      record(lineNo, line, m[1], `${approx ? "~" : ""}${m[3]}-${m[4]}-${m[5]}`, approx, utcDayStamp(Number(m[3]), Number(m[4]) - 1, Number(m[5])));
    }

    MONTH_YEAR_MARKER_RE.lastIndex = 0;
    while ((m = MONTH_YEAR_MARKER_RE.exec(line))) {
      record(lineNo, line, m[1], `${m[2]} ${m[3]}`, false, monthYearEndStamp(m[2], m[3]));
    }
  }

  // NOT attached to `findings`. An array carrying an extra own property is no longer
  // deepEqual to `[]`, which broke four tests asserting "no findings" — the count is
  // diagnostic and must never change the shape of the result it describes.
  void suppressed;
  return findings;
}

// ─────────────────────────────────────────────────────────────────────────
// Check 5 — `concepts:` tokens that can never fire. A declared trigger
// token that is not, literally, a substring of its own source file's
// current text is a check that reports success forever
// (`rule:discernment-checks` §1) — it will never once match a real edit to
// the section it claims to watch.
//
// Case-insensitive, NFC-normalized substring match. Case-insensitive
// because the corpus already shows why exact-case would be nearly useless:
// the declared token `email` never matches prose that writes `**Email:**`
// — a capitalized label, not a typo — and a matcher that requires exact
// case would make EVERY Title-Case label a false dead-token report. NFC
// normalization guards against the same Devanagari/IAST text being spelled
// with precomposed vs. combining Unicode forms in the token vs. the prose.
// ─────────────────────────────────────────────────────────────────────────

/**
 * @param {string} sourceText
 * @param {Record<string, string[]>|null} concepts
 * @returns {Array<{section:string, token:string}>}
 */
export function findDeadConceptTokens(sourceText, concepts) {
  const findings = [];
  if (!concepts) return findings;
  const norm = sourceText.normalize("NFC").toLowerCase();
  for (const [section, tokens] of Object.entries(concepts)) {
    for (const token of tokens || []) {
      const needle = String(token).normalize("NFC").toLowerCase();
      if (!needle) continue;
      if (!norm.includes(needle)) findings.push({ section, token: String(token) });
    }
  }
  return findings;
}

// ─────────────────────────────────────────────────────────────────────────
// Check 2 — literal claims vs. declared downstreams. Scoped to edges whose
// downstream is `kind: code` and whose path looks pricing-related
// (`/pric/i`) — deliberately narrow: running a "price row" extractor
// against an unrelated code downstream (contact.ts, content.ts) would be
// noise wearing the shape of a finding.
//
// Two directions, two different normalizations, and the asymmetry is
// deliberate, not an inconsistency:
//   doc -> code   the doc's table cell is a full descriptive fragment
//                 ("15 min consultation · online or in-person · Gurgaon")
//                 carrying duration/mode/location qualifiers that will
//                 never appear verbatim in code. `coreLabel` strips the
//                 known qualifier vocabulary and keeps the service noun
//                 before checking it as a substring of the code text.
//   code -> doc   a `kind`/`label` string in a TS price table IS already
//                 the canonical minimal identifier ("double_kundli") — no
//                 stripping needed, just de-hyphenation (`in_person` and
//                 the doc's "in-person" must compare equal) before a
//                 whole-phrase substring check against the doc text.
// ─────────────────────────────────────────────────────────────────────────

const QUALIFIER_STRIP_RE = /\b(\d+\s*min(?:ute)?s?|online|in[- ]person|gurgaon|gurugram)\b/gi;

function normalizeForMatch(s) {
  return s.normalize("NFC").toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
}

function coreLabel(cell) {
  const firstSegment = cell.split("·")[0]; // "·" (middle dot) separates cell qualifiers
  return normalizeForMatch(firstSegment.replace(QUALIFIER_STRIP_RE, ""));
}

/**
 * Extract first-column labels from a markdown table whose header row's
 * first cell is "Service" (case-insensitive) — the shape the constitution doc's
 * §Pricing table uses. A table under a different header is not this
 * check's business and is left alone.
 * @param {string} text
 * @returns {string[]}
 */
export function extractPriceTableLabels(text) {
  const lines = text.split("\n");
  const labels = [];
  let inTable = false;
  for (const line of lines) {
    if (!inTable) {
      if (/^\s*\|\s*service\s*\|/i.test(line)) inTable = true;
      continue;
    }
    if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue; // header separator row
    if (!line.trim().startsWith("|")) break; // table ended
    const cells = line.split("|");
    const label = (cells[1] || "").trim();
    if (label) labels.push(label);
  }
  return labels;
}

/**
 * Extract `kind: "..."` string-literal identifiers from a TS/JS price-tier
 * object literal (the `ConsultationKind` shape in `lib/pricing.ts`).
 * @param {string} text
 * @returns {string[]}
 */
export function extractCodeTierKinds(text) {
  return [...text.matchAll(/\bkind:\s*"([\w-]+)"/g)].map((m) => m[1]);
}

/**
 * @param {string} docText
 * @param {string} codeText
 * @returns {Array<{direction:"doc-not-in-code"|"code-not-in-doc", label:string}>}
 */
export function checkPriceLiteralsVsCode(docText, codeText) {
  const findings = [];
  const normCode = normalizeForMatch(codeText);
  for (const raw of extractPriceTableLabels(docText)) {
    const core = coreLabel(raw);
    if (core && !normCode.includes(core)) {
      findings.push({ direction: "doc-not-in-code", label: raw });
    }
  }

  const normDoc = normalizeForMatch(docText);
  for (const kind of extractCodeTierKinds(codeText)) {
    const needle = normalizeForMatch(kind);
    if (needle && !normDoc.includes(needle)) {
      findings.push({ direction: "code-not-in-doc", label: kind });
    }
  }
  return findings;
}

function isPriceRelatedDownstream(downstream) {
  return downstream.kind === "code" && /pric/i.test(downstream.abs);
}

// ─────────────────────────────────────────────────────────────────────────
// Check 3 — footer date vs. newest inline date. `*Last amended: YYYY-MM-DD*`
// (or "updated"/"revised") is a promise that nothing in the body is newer
// than that date. An inline amendment marker (Narrowed / Added / Corrected
// / Updated / Amended / Revised / Refined, each followed within a short
// window by an ISO date) that postdates the footer breaks that promise —
// mechanically, because ISO date strings sort lexicographically in
// chronological order, so no date parsing is needed to find the max.
// ─────────────────────────────────────────────────────────────────────────

const FOOTER_DATE_RE = /\*?\s*Last\s+(?:amended|updated|revised)\s*:\s*(\d{4}-\d{2}-\d{2})\s*\*?/i;
const INLINE_AMEND_RE = /\b(Narrowed|Added|Corrected|Updated|Amended|Revised|Refined)\b[^0-9]{0,20}(\d{4}-\d{2}-\d{2})/g;

/**
 * @param {string} text
 * @returns {{footer:string|null, newestInline:string|null, stale:boolean}}
 */
export function checkFooterVsInline(text) {
  const footerMatch = FOOTER_DATE_RE.exec(text);
  if (!footerMatch) return { footer: null, newestInline: null, stale: false };
  const footer = footerMatch[1];

  let newestInline = null;
  INLINE_AMEND_RE.lastIndex = 0;
  let m;
  while ((m = INLINE_AMEND_RE.exec(text))) {
    const d = m[2];
    if (!newestInline || d > newestInline) newestInline = d;
  }

  return { footer, newestInline, stale: newestInline !== null && newestInline > footer };
}

// ─────────────────────────────────────────────────────────────────────────
// Check 4 — rotted internal citations. Three independent sub-checks, all
// mechanical: (a) a "line N" self-citation whose target line, in the SAME
// file, is not prose (blank, or a markdown table separator); (b) a cited
// git branch that resolves to neither a local nor an `origin`-tracking
// ref; (c) a backtick-wrapped, extension-bearing path citation that does
// not exist relative to the citing file's directory — implemented and
// unit-tested, but NOT called from `claimsCheck` below; see
// `findDeadPathCitations`'s own doc comment for the measured reason.
// ─────────────────────────────────────────────────────────────────────────

// Requires an explicit citation CUE immediately before "line N" — "at",
// "see", "per", or a bare parenthetical "(line N)". Measured against the
// live corpus: a bare `\bline\s+\d+\b` also matches "anchor line 2" (a
// heading LABEL — "the second of several named quote-anchors", not a file
// citation) and "line 2 typographically subordinate" (a UI layout note) —
// three false positives from two files, neither of which is citing
// anything. The one required known positive — "(per Jiraiya voice example
// at line 118)" — reads correctly as "at line 118" under this narrower
// pattern; "anchor line 2" and "line 2 typographically" do not, because
// neither has a citation-cue word immediately before "line".
const SELF_LINE_CITE_RE = /\b(?:at|see|per)\s+line\s+(\d+)\b|\(\s*line\s+(\d+)\s*\)/gi;
// A citation preceded by something that looks like "path/to/file.ext:" or
// "file.ext " within 40 chars is citing ANOTHER file's line, not this
// file's own — out of scope for a self-citation check (verifying it would
// need to resolve and read that other file, which this function does not
// attempt).
const FOREIGN_FILE_BEFORE_RE = /[\w./-]+\.\w{1,5}[:\s]*$/;
const NON_PROSE_LINE_RE = /^[\s|:-]+$/;

function snippetAround(text, index, span = 60) {
  const start = Math.max(0, index - span);
  const end = Math.min(text.length, index + span);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

/**
 * @param {string} text
 * @returns {Array<{citedLine:number, reason:string, targetLine?:string, context:string}>}
 */
export function findSelfLineCitations(text) {
  const findings = [];
  const lines = text.split("\n");
  SELF_LINE_CITE_RE.lastIndex = 0;
  let m;
  while ((m = SELF_LINE_CITE_RE.exec(text))) {
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    if (FOREIGN_FILE_BEFORE_RE.test(before)) continue; // cites another file — not this check's job
    const n = Number(m[1] ?? m[2]); // group 1: "at|see|per line N"; group 2: bare "(line N)"
    if (!Number.isInteger(n) || n < 1 || n > lines.length) {
      findings.push({ citedLine: n, reason: "out-of-range", context: snippetAround(text, m.index) });
      continue;
    }
    const target = lines[n - 1];
    const trimmed = target.trim();
    if (trimmed === "" || NON_PROSE_LINE_RE.test(trimmed)) {
      findings.push({
        citedLine: n,
        reason: trimmed === "" ? "cited line is blank" : "cited line is a markdown table separator",
        targetLine: target,
        context: snippetAround(text, m.index),
      });
    }
  }
  return findings;
}

const BRANCH_CITE_RE = /\bbranch\s+`([\w./-]+)`/gi;

/** Default git runner: a LOCAL `git rev-parse --verify`, no network. */
function defaultGitRefExists(repoRoot, ref) {
  try {
    execFileSync("git", ["-C", repoRoot, "rev-parse", "--verify", "--quiet", ref], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} text
 * @param {string|null} repoRoot
 * @param {{refExists?: (repoRoot:string, ref:string)=>boolean}} [opts] injectable for tests
 * @returns {Array<{branch:string, context:string}>}
 */
export function findDeadBranchCitations(text, repoRoot, { refExists = defaultGitRefExists } = {}) {
  const findings = [];
  if (!repoRoot) return findings;
  BRANCH_CITE_RE.lastIndex = 0;
  let m;
  while ((m = BRANCH_CITE_RE.exec(text))) {
    const branch = m[1];
    const exists =
      refExists(repoRoot, `refs/heads/${branch}`) || refExists(repoRoot, `refs/remotes/origin/${branch}`);
    if (!exists) findings.push({ branch, context: snippetAround(text, m.index) });
  }
  return findings;
}

const PATH_CITE_RE = /`([\w][\w./-]*\.(?:md|ts|tsx|js|jsx|mjs|cjs|json|ya?ml|py|sh))`/g;

/**
 * NOT WIRED INTO `claimsCheck` BELOW — kept here as a tested building block,
 * deliberately not part of the live orchestrator yet. Measured against the
 * real `Vipin Kaushik` corpus: resolving every backtick-wrapped path
 * relative to the CITING FILE's directory produced 322 findings from one
 * run, and a sample showed why — prose routinely qualifies a path with a
 * REPO NAME in English immediately before it ("propagate's `docs/
 * REFERENCE.md`", meaning the SIBLING `propagate/` repo, not a path under
 * the citing file at all). Resolving that correctly needs repo-name-aware
 * lookup, not a relative-path guess, and shipping the guess as a live check
 * would bury the two or three real rotted citations under many false ones
 * — the opposite failure from `rule:discernment-checks` §1's "a check that
 * cannot fail": a check that (almost) always fires is just as useless,
 * because nobody can find the real finding in the noise. Left implemented
 * and unit-tested (a clean synthetic fixture proves the mechanism itself is
 * correct) so a later lane can wire it in once it also tries the nearest
 * workspace/repo root as a second resolution base, not only the citing
 * file's own directory.
 * @param {string} text
 * @param {{baseDir: string}} opts resolve a relative citation against this dir
 * @returns {Array<{citedPath:string, context:string}>}
 */
export function findDeadPathCitations(text, { baseDir }) {
  const findings = [];
  if (!baseDir) return findings;
  PATH_CITE_RE.lastIndex = 0;
  let m;
  while ((m = PATH_CITE_RE.exec(text))) {
    const p = m[1];
    if (/^https?:\/\//i.test(p) || !p.includes("/")) continue; // URL, or too ambiguous to resolve
    const resolved = path.resolve(baseDir, p);
    if (!existsSync(resolved)) findings.push({ citedPath: p, context: snippetAround(text, m.index) });
  }
  return findings;
}

// ─────────────────────────────────────────────────────────────────────────
// Orchestrator — three-outcome discipline (checked / skipped / unreadable),
// matching lib/report/backlog.mjs's own contract: "found nothing" and
// "looked at nothing" must never collapse to the same output
// (`rule:discernment-checks` §2). A run with zero findings still reports
// exactly how many files it checked, skipped, and could not read.
// ─────────────────────────────────────────────────────────────────────────

/**
 * @param {{workspaces: Array<{root:string,name?:string}>, now?: Date}} opts
 */
export async function claimsCheck({ workspaces = [], now = new Date() } = {}) {
  const corpus = await buildClaimsCorpus({ workspaces });

  // Single read pass — every corpus file read exactly once, regardless of
  // how many checks (or how many source/downstream roles) touch it.
  const textByPath = new Map();
  const filesChecked = [];
  const filesUnreadable = [];
  for (const absPath of corpus.fileEntries.keys()) {
    const { text, error } = readTextSafe(absPath);
    if (error) {
      filesUnreadable.push({ file: shortPath(absPath), reason: error });
      continue;
    }
    textByPath.set(absPath, text);
    filesChecked.push(shortPath(absPath));
  }

  const findings = [];
  const ownerLabel = (absPath) => {
    const owner = nearestOwner(absPath, workspaces);
    return owner ? owner.name || shortPath(owner.root) : "(outside any known workspace)";
  };

  // Checks 1, 3, 4 — single-file checks, once per unique corpus file.
  for (const [absPath, text] of textByPath) {
    const file = shortPath(absPath);
    const owner = ownerLabel(absPath);

    for (const f of findExpiredDates(text, { now })) {
      findings.push({ check: "expired-date", file, owner, ...f });
    }

    const footer = checkFooterVsInline(text);
    if (footer.stale) {
      findings.push({ check: "footer-stale", file, owner, footer: footer.footer, newestInline: footer.newestInline });
    }

    for (const f of findSelfLineCitations(text)) {
      findings.push({ check: "rotted-citation", subtype: "self-line", file, owner, ...f });
    }

    const repoRoot = resolveRepo(absPath);
    if (repoRoot) {
      for (const f of findDeadBranchCitations(text, repoRoot)) {
        findings.push({ check: "rotted-citation", subtype: "dead-branch", file, owner, repoRoot: shortPath(repoRoot), ...f });
      }
    }

    // findDeadPathCitations is deliberately NOT called here — see its own
    // doc comment for the measured reason (322 false positives on the live
    // corpus from prose that qualifies a path with a repo name).
  }

  // Checks 2, 5 — edge checks: a source's text against its OWN declared
  // downstream(s) / its OWN concepts block.
  for (const edge of corpus.sourceEdges) {
    const sourceText = textByPath.get(edge.sourceAbs);
    if (sourceText === undefined) continue; // unreadable source — already recorded above

    if (edge.concepts) {
      for (const f of findDeadConceptTokens(sourceText, edge.concepts)) {
        findings.push({
          check: "dead-concept-token",
          file: shortPath(edge.sourceAbs),
          owner: ownerLabel(edge.sourceAbs),
          sidecar: shortPath(edge.sidecarPath),
          sourceKey: edge.sourceKey,
          ...f,
        });
      }
    }

    for (const downstream of edge.downstreams) {
      if (!isPriceRelatedDownstream(downstream)) continue;
      const codeText = textByPath.get(downstream.abs);
      if (codeText === undefined) continue; // unreadable downstream — already recorded above
      for (const f of checkPriceLiteralsVsCode(sourceText, codeText)) {
        findings.push({
          check: "price-literal-drift",
          file: shortPath(edge.sourceAbs),
          owner: ownerLabel(edge.sourceAbs),
          downstream: shortPath(downstream.abs),
          ...f,
        });
      }
    }
  }

  return {
    generatedAt: now.toISOString(),
    findings,
    files: { checked: filesChecked, unreadable: filesUnreadable },
    sidecars: { checked: corpus.sidecarsChecked, unreadable: corpus.sidecarsUnreadable },
    globsSkipped: corpus.globsSkipped,
    coverage: {
      filesChecked: filesChecked.length,
      filesUnreadable: filesUnreadable.length,
      sidecarsChecked: corpus.sidecarsChecked.length,
      sidecarsUnreadable: corpus.sidecarsUnreadable.length,
      globsSkipped: corpus.globsSkipped.length,
      sourceEdges: corpus.sourceEdges.length,
    },
  };
}
