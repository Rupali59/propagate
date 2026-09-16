/**
 * goals.mjs — goal states: the arrival conditions a direction does not carry.
 *
 * `NORTH_STAR.md` §What we are building toward holds one direction line per
 * workspace and says plainly that it carries "no status, no counts, no dates —
 * those are derived". That is right for a constitution, and it leaves every
 * direction without a way to tell whether it was reached. Measured 2026-09-14:
 * `goal state` appeared in **0** files tree-wide and `Done when` in **0 of 107**
 * plan documents, while 16 handovers already used it.
 *
 * THE VOCABULARY. The Business Motivation Model separates a *goal* ("what must
 * be satisfied on a continuing basis", permitted to be unachievable) from an
 * *objective* ("an attainable, time-targeted, measurable target"). NORTH_STAR
 * holds goals. This file holds the objectives that say when one is met.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THIS READER NEVER EXECUTES A `Derived by:` COMMAND.
 *
 * The plan that produced this module asked for goals whose derivation command
 * "was actually run", with an erroring command reported as unknown. That was
 * refused, because `handovers.mjs` — whose three-state parse this reuses —
 * already answered it: *"Deriving 'closed' would mean executing shell written
 * inside a markdown file — a hole wide enough to drive anything through, and
 * against the tool's stated posture: it never edits a downstream, it tells a
 * human."* Running it here would reintroduce that hole one module over, and
 * `tests/unit/goals.test.mjs` pins the refusal with a canary file.
 *
 * So the second axis is whether a derivation was CLAIMED, not whether it
 * passes:
 *
 *   **Derived by:** <command>              -> claimed
 *   **Judgement, not derivable:** <why>    -> waived
 *   neither                                -> none    <- the defect
 *
 * The third is what this reader exists to surface: a goal asserting an arrival
 * condition nobody can check, which does not admit that it cannot be checked.
 * "Not mechanically derivable" and "nobody checked" are different facts and
 * only one is honest (`rule:discernment-checks` §2).
 * ─────────────────────────────────────────────────────────────────────────
 */

import { readFileSync } from "node:fs";

import { parseHandovers } from "./handovers.mjs";

/**
 * `**Derived by:** …` — a command is named. Tolerates the bold markers being
 * absent, and matches the label alone so a fenced block on the following lines
 * still counts as a claim (see `extractCommand`).
 */
const DERIVED_BY_RE = /^\s*\*{0,2}Derived by:?\*{0,2}\s*:?\s*(.*)$/im;

/**
 * The command a `Derived by:` names, in the three shapes the tree actually
 * writes it.
 *
 * Naively taking the rest of the line got this wrong twice on the first real
 * file: an entry whose command is a fenced block reported the literal
 * "```sh", and one whose line continues into an explanatory clause reported a
 * sentence fragment ending in "— the". Both LOOK like commands in a report,
 * which is worse than reporting nothing — a reader would paste them.
 *
 *   **Derived by:** `cmd`              -> the backticked span
 *   **Derived by:** cmd — why          -> up to the em-dash
 *   **Derived by:**                    -> the following fenced block
 *   ```sh
 *   cmd
 *   ```
 */
function extractCommand(body) {
  const lines = body.split("\n");
  const i = lines.findIndex((l) => DERIVED_BY_RE.test(l));
  if (i === -1) return null;

  const rest = (lines[i].match(DERIVED_BY_RE)?.[1] ?? "").trim();
  const inline = rest.replace(/^`+|`+$/g, "").trim();

  // A backticked span is the least ambiguous form — prefer it whole.
  const ticked = rest.match(/`([^`]+)`/);
  if (ticked) return ticked[1].trim();

  // Prose continuation after an em-dash is explanation, not command.
  if (inline && !/^(```|~~~)/.test(inline)) return inline.split(/\s+[—–]\s+/)[0].trim();

  // Otherwise the command is the fenced block that follows.
  const fenceStart = lines.findIndex((l, j) => j >= i && /^\s*(```|~~~)/.test(l));
  if (fenceStart !== -1) {
    const out = [];
    let continued = false;
    for (let j = fenceStart + 1; j < lines.length; j++) {
      if (/^\s*(```|~~~)/.test(lines[j])) break;
      const t = lines[j].trim();
      if (!t) continue;
      // A trailing backslash continues ONE shell command across lines. Joining
      // those with " ; " produces a string that reads like a command and is not
      // one — `git ls-files \ ; | grep …` fails if pasted. Same class of defect
      // as returning the fence marker: worse than printing nothing, because a
      // reader will run it.
      if (continued) out[out.length - 1] += " " + t.replace(/\\$/, "").trim();
      else out.push(t.replace(/\\$/, "").trim());
      continued = /\\$/.test(t);
    }
    // Joined with NEWLINES, never " ; ". A fenced block whose lines carry
    // trailing `#` comments — which is how this tree writes them — becomes a
    // command where everything after the first `#` is commented out. Measured
    // on the first real GOALS.md: the registries goal ran deploy-check.sh and
    // silently skipped mongo-check.sh, because the join put the second command
    // behind the first one's comment. A command that quietly does half its job
    // is the same defect as returning the fence marker.
    if (out.length) return out.join("\n");
  }
  return null;
}

/**
 * `**Judgement, not derivable:** …` — the entry says out loud that no command
 * can answer it. Deliberately matches the shorter `not derivable` too, so an
 * author who writes the idea without the exact phrase is still counted as
 * having declared it rather than being reported as a defect.
 */
const WAIVED_RE = /^\s*\*{0,2}(?:Judgement,?\s*)?not derivable:?\*{0,2}\s*:?\s*(.+)$/im;

/**
 * Parse one GOALS.md.
 *
 * Section shape and the open/closed/unknown verdict come from
 * `parseHandovers`, unchanged — one parser, not a fork of one. The per-section
 * body is re-read here only to classify the derivation axis, which handovers
 * has no concept of.
 *
 * @returns {{file: string, entries: Array, unread: boolean, reason: string|null, error: string|null}}
 */
export function parseGoalsFile(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    // A file that cannot be read is NOT zero goals. Say which.
    return { file, entries: [], unread: true, reason: `unreadable: ${err.message}`, error: err.message };
  }

  let sections;
  try {
    const parsed = parseHandovers(file);
    sections = parsed.sections || parsed || [];
  } catch (err) {
    return { file, entries: [], unread: true, reason: `parse failed: ${err.message}`, error: err.message };
  }

  if (!Array.isArray(sections) || sections.length === 0) {
    // Zero sections is a reader that did not recognise the shape, not an empty
    // register (`rule:discernment-checks` §6). registers.mjs draws this exact
    // line and this module must not blur it.
    return {
      file,
      entries: [],
      unread: true,
      reason: "no '## <N> · <title>' goal sections found — format not recognised",
      error: null,
    };
  }

  const bodies = sectionBodies(text);

  const entries = sections.map((s, i) => {
    const body = bodies[i] ?? "";
    let derivation = "none";
    if (WAIVED_RE.test(body)) derivation = "waived";
    else if (DERIVED_BY_RE.test(body)) derivation = "claimed";
    const cmd = derivation === "claimed" ? extractCommand(body) : null;
    return {
      n: s.number ?? i + 1,
      title: s.title ?? "",
      // `?? "unknown"` is defence against a contract change, NOT a live branch:
      // parseHandovers always sets a status, so mutating this default to
      // "closed" leaves the suite green (checked 2026-09-14). The
      // "unknown, never closed" guarantee this module relies on is enforced in
      // handovers.mjs, not here — said out loud so a future reader does not
      // mistake this line for the thing that holds it.
      status: s.status ?? "unknown",
      derivation,
      command: cmd,
    };
  });

  return { file, entries, unread: false, reason: null, error: null };
}

/**
 * Split the file into per-section bodies, in the same order parseHandovers
 * returns its sections.
 *
 * Fence-aware, and that is not optional: documenting the GOALS.md format
 * INSIDE a GOALS.md is the ordinary way to trip this, and registers.mjs
 * records the same bug one module over (N51 — a ```markdown example counted as
 * a real section, and because the example carried a close marker the phantom
 * reported CLOSED).
 */
function sectionBodies(text) {
  const SECTION = /^##\s+(?:\d{4}-\d{2}-\d{2}|\d+)\s*[·\-–—:.]?\s*/;
  const out = [];
  let current = null;
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      if (current !== null) current.push(line);
      continue;
    }
    if (!fenced && SECTION.test(line)) {
      current = [];
      out.push(current);
      continue;
    }
    if (current !== null) current.push(line);
  }
  return out.map((lines) => lines.join("\n"));
}

/**
 * Roll several parsed files into one set of counts.
 *
 * `unknown` is never folded into open or closed, and `uncheckable` is reported
 * separately from `unread` — a goal nobody can check and a FILE nobody could
 * read are different failures, and merging them would hide whichever is rarer.
 */
export function goalCounts(files) {
  const c = {
    files: files.length,
    unread: 0,
    total: 0,
    open: 0,
    closed: 0,
    unknown: 0,
    claimed: 0,
    waived: 0,
    uncheckable: 0,
  };
  for (const f of files) {
    if (f.unread) {
      c.unread += 1;
      continue;
    }
    for (const e of f.entries) {
      c.total += 1;
      if (e.status === "open") c.open += 1;
      else if (e.status === "closed") c.closed += 1;
      else c.unknown += 1;
      if (e.derivation === "claimed") c.claimed += 1;
      else if (e.derivation === "waived") c.waived += 1;
      else c.uncheckable += 1;
    }
  }
  return c;
}

/**
 * ── The direction quote: does a goal still test the direction it cites? ──────
 *
 * WHY THIS EXISTS AND NOT AN EDGE. The hub sidecar declares
 * NORTH_STAR.md -> GOALS.md, and that edge's own `why:` claims BOTH directions:
 * "change the direction and the goal state is answering a question no longer
 * being asked; change the goal state and it may no longer test the direction it
 * claims to." Only the first half was enforced — editing a goal fired nothing.
 *
 * The obvious fix, a reverse edge, was declared on 2026-09-16 and reverted the
 * same hour. propagate refuses mutual pairs on a structural ground, in its own
 * words: "A mutually-declared pair has no canonical direction, so no fix order
 * exists for it and propagation cannot terminate: whichever side you verify
 * first, the other re-arms it." `doctor`'s graph.cycles == 0 went red the moment
 * it was declared. So this closes the same gap by DERIVATION instead: compare
 * content, add no edge, create no cycle.
 *
 * TWO NORMALISATIONS, BOTH LOAD-BEARING, BOTH FOUND BY HAND ON THE ONE REAL PAIR.
 * A naive string compare reports drift that does not exist, and a check that
 * cries wolf on every entry is one nobody reads:
 *
 *   1. PROVENANCE. NORTH_STAR.md tags inferred claims `⟨inferred from: …⟩`
 *      (hub CLAUDE.md: "untagged lines are Rupali's own words"). That is
 *      metadata about where a claim came from, not the claim. Left in, the one
 *      existing pair mismatches at char 240 of 240 — on the tag alone.
 *   2. WRAPPING. The goal quotes as a `> ` blockquote; NORTH_STAR writes a `- `
 *      list item with hanging indent. Same words, different line breaks.
 *
 * With both applied the live pair matches exactly, 240 chars each. Neither was
 * predictable from reading the code — both came from running the comparison on
 * real data before writing any.
 *
 * FOUR STATES, NEVER COLLAPSED (`rule:discernment-checks` §2). "quotes nothing"
 * is the one a simpler design drops, and it is the honest majority case: a
 * GOALS.md that cites no direction cannot be checked at all, and must not read
 * as agreement.
 */

/** `⟨inferred from: …⟩` — provenance, not claim. Exported so a test can prove it is stripped. */
export const PROVENANCE_RE = /⟨inferred from:[^⟩]*⟩/gu;

/** Strip provenance, collapse wrapping. The two normalisations above, in one place. */
export function normaliseDirection(s) {
  return String(s ?? "").replace(PROVENANCE_RE, " ").replace(/\s+/gu, " ").trim();
}

/**
 * The first contiguous `> ` blockquote in a GOALS.md — the direction it claims
 * to test. Returns null when the file quotes nothing, which is a fact, not a
 * failure.
 */
export function quotedDirection(goalsText) {
  const out = [];
  for (const line of String(goalsText ?? "").split("\n")) {
    if (line.startsWith("> ")) out.push(line.slice(2));
    else if (line.startsWith(">")) out.push(line.slice(1));
    else if (out.length) break;
  }
  return out.length ? normaliseDirection(out.join(" ")) : null;
}

/**
 * Find the direction in NORTH_STAR.md that the quote refers to, by its leading
 * bolded label (`**This hub** — …`), and return it normalised.
 *
 * Matched on the LABEL rather than on the whole text: matching on the full body
 * would make the check tautological — it could only find a direction that had
 * not changed, which is precisely the drift it exists to detect.
 */
export function directionByLabel(northStarText, label) {
  const lines = String(northStarText ?? "").split("\n");
  const i = lines.findIndex((l) => /^\s*[-*]\s*\*\*/.test(l) && l.includes(label));
  if (i < 0) return null;
  const buf = [lines[i].replace(/^\s*[-*]\s*/, "")];
  for (let j = i + 1; j < lines.length; j++) {
    if (/^\s+\S/.test(lines[j])) buf.push(lines[j]);
    else break;
  }
  return normaliseDirection(buf.join(" "));
}

/**
 * @returns {{state: "matches"|"diverged"|"absent"|"unquoted", why: string}}
 */
export function checkDirectionQuote({ goalsText, northStarText }) {
  const quoted = quotedDirection(goalsText);
  if (!quoted) {
    return { state: "unquoted", why: "this GOALS.md quotes no direction — nothing to compare, which is not agreement" };
  }
  const label = (quoted.match(/\*\*([^*]+)\*\*/) || [])[1];
  if (!label) {
    return { state: "unquoted", why: "the quoted direction carries no **bold label**, so it cannot be located in NORTH_STAR.md" };
  }
  const live = directionByLabel(northStarText, `**${label}**`);
  if (live === null) {
    return { state: "absent", why: `no direction labelled **${label}** in NORTH_STAR.md — the goal cites something that is gone` };
  }
  if (live === quoted) return { state: "matches", why: `**${label}** — quote and direction agree (${quoted.length} chars)` };
  return {
    state: "diverged",
    why: `**${label}** — the quote no longer matches the direction (quote ${quoted.length} chars, direction ${live.length})`,
  };
}
