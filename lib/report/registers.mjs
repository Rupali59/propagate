/**
 * REGISTERS — what is hot, what is finished, and what could rotate out.
 *
 * The registers (ISSUES.md, TODOS.md, handovers, GOTCHAS.md) grow monotonically
 * with work. Nothing measured them until 2026-08-27, when the census found
 * propagate's own `ISSUES.md` at 2662 lines with 62% of its entries already
 * RESOLVED, and the hub's `HANDOVERS.md` at 1508 lines with every section closed.
 *
 * WHAT THIS IS NOT FOR. The push path is fine and this module must not be read
 * as evidence otherwise. Measured the same day: `gotcha-guard` caps display at
 * MAX_SHOWN = 3, the worst real trigger collision across eight representative
 * commands was 2, and parsing all 28 reachable entries costs 0.73 ms against a
 * 12 ms module import. Growth costs READING and CONTEXT, not runtime.
 *
 * ROTATION IS DRIVEN BY STATE, PER KIND — never by age alone. The kinds differ
 * in what makes an entry stop being worth loading, and one of them differs
 * absolutely:
 *
 *   issues     a RESOLVED/MOOT/CLOSED entry is history        -> rotatable
 *   handovers  a closed section is history                    -> rotatable
 *   todos      a checked item is history                      -> rotatable
 *   gotchas    A HAZARD DOES NOT EXPIRE                       -> never
 *
 * That last row is the whole reason this is a per-kind table and not a filter.
 * A fixed hazard is still the argument for why the fix exists — Motherboard's G6
 * is deliberately KEPT, rewritten as RETIRED, rather than deleted. Rotating
 * gotchas on age would throw away the reasoning that justifies current code.
 *
 * DERIVE-ONLY, DELIBERATELY. There is no writer here and no scheduled component
 * (`rule:delegation-criteria` §2). This module exists to show whether rotation is
 * worth automating at all; if the answer is "two files, a few times a year", a
 * hand-move into the existing `archive/` convention is correct and cheaper.
 * `rule:enforcement-watches-itself` lists nine mechanisms built in this tree that
 * nothing ever invoked — a writer nobody runs would be the tenth.
 *
 * Layer contract: this file RETURNS DATA AND PRINTS NOTHING. Rendering lives in
 * `commands/registers.mjs`; `lib/report/doctor/registers.mjs` folds it into
 * doctor.
 */

import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import { discoverBacklogFiles, parseTodoLikeFile, closedSectionLines } from "./backlog.mjs";
import { parseHandovers } from "./handovers.mjs";
import { parseEntries } from "../gotchas/parse.mjs";

/**
 * Per-kind lifecycle. The single source for "what rotates" — a caller must
 * never re-derive this, and adding a kind means adding a row here.
 *
 * `rotates` false is not "not implemented"; it is a decision with a reason,
 * and `whyNever` carries it so a reader is never left guessing whether the
 * absence is policy or oversight.
 */
export const LIFECYCLE = Object.freeze({
  issues: { rotates: true, finishedLabel: "resolved" },
  handovers: { rotates: true, finishedLabel: "closed" },
  todos: { rotates: true, finishedLabel: "checked" },
  gotchas: {
    rotates: false,
    finishedLabel: "retired",
    whyNever: "a hazard does not expire; a fixed one is still the argument for its fix",
  },
});

/** Heading markers that declare an issue entry finished. */
const ISSUE_FINISHED_RE = /\b(RESOLVED|MOOT|CLOSED|SUPERSEDED|WONTFIX)\b/;

/** Heading markers that declare a gotcha's mechanism gone. */
const GOTCHA_RETIRED_RE = /\b(RETIRED|SUPERSEDED)\b/;

/** Read a file, never throwing. Mirrors backlog.mjs's readTextSafe contract. */
function readSafe(file) {
  try {
    return { text: readFileSync(file, "utf8"), error: null };
  } catch (err) {
    return { text: null, error: `unreadable: ${err.message}` };
  }
}

function lineCount(text) {
  return text ? text.split("\n").length : 0;
}

/**
 * `### ` headings that are NOT inside a fenced code block.
 *
 * Fence tracking is not optional here. N51 is precisely this bug one module
 * over: `parseHandovers` counted a ```markdown example containing a heading as
 * a real section, and because the example also carried a close marker the
 * phantom section reported CLOSED. Documenting a register's own format INSIDE
 * that register is the normal way to trigger it — prose about the format read
 * as the format.
 *
 * Measured 2026-08-27: propagate's ISSUES.md currently has 0 fenced headings,
 * so this changes no number today. It is here so that writing one tomorrow does
 * not silently inflate the count.
 */
function headingsOutsideFences(text, re) {
  const out = [];
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (!fenced && re.test(line)) out.push(line);
  }
  return out;
}

/**
 * One register row.
 *
 * `reason` is LOAD-BEARING and is set whenever `rotatable` is 0. "0 rotatable
 * because every entry is live" and "0 rotatable because this file did not
 * parse" are different facts and only one of them is healthy
 * (`rule:discernment-checks` §2). A row with `unread: true` is NOT a zero — it
 * is a reader that failed and said so.
 */
function row({ kind, file, lines, entries, live, finished, rotatable, reason, unread = false, error = null }) {
  return { kind, file, lines, entries, live, finished, rotatable, reason, unread, error };
}

/** Classify an ISSUES.md-shaped file by its `### <ID> …` headings. */
function readIssues(file) {
  const { text, error } = readSafe(file);
  if (error) {
    return row({
      kind: "issues", file, lines: 0, entries: 0, live: 0, finished: 0, rotatable: 0,
      reason: error, unread: true, error,
    });
  }
  const heads = headingsOutsideFences(text, /^###\s+\S+\s+·/);
  const finished = heads.filter((h) => ISSUE_FINISHED_RE.test(h)).length;

  // A file with no recognisable entry headings is UNREAD, not empty. The
  // register may have a shape this reader does not know, and reporting 0
  // would be the reader inventing an answer (`rule:discernment-checks` §6).
  if (heads.length === 0) {
    const parsed = parseTodoLikeFile(text, file);
    if (parsed.format === "pointer-stub") {
      return row({
        kind: "issues", file, lines: lineCount(text), entries: 0, live: 0, finished: 0,
        rotatable: 0, reason: "pointer stub — the register lives elsewhere and is counted there",
      });
    }
    return row({
      kind: "issues", file, lines: lineCount(text), entries: 0, live: 0, finished: 0, rotatable: 0,
      reason: `no '### <ID> ·' entry headings found — format not recognised (parsed as ${parsed.format})`,
      unread: true,
    });
  }

  return row({
    kind: "issues", file, lines: lineCount(text), entries: heads.length,
    live: heads.length - finished, finished, rotatable: finished,
    reason: finished === 0 ? "every entry is open" : null,
  });
}

/** Classify a handover file using the existing dated-section parser. */
function readHandover(file) {
  const parsed = parseHandovers(file);
  if (parsed.error || parsed.totals === null) {
    const { text } = readSafe(file);
    return row({
      kind: "handovers", file, lines: lineCount(text), entries: 0, live: 0, finished: 0,
      rotatable: 0, reason: parsed.error ?? "totals unavailable", unread: true, error: parsed.error,
    });
  }
  const { open, closed, unknown } = parsed.totals;
  const { text } = readSafe(file);
  return row({
    kind: "handovers", file, lines: lineCount(text), entries: open + closed + unknown,
    live: open + unknown, finished: closed, rotatable: closed,
    reason: closed === 0 ? "no closed sections" : null,
  });
}

/** Classify a TODOS.md using the existing multi-format parser. */
function readTodos(file) {
  const { text, error } = readSafe(file);
  if (error) {
    return row({
      kind: "todos", file, lines: 0, entries: 0, live: 0, finished: 0, rotatable: 0,
      reason: error, unread: true, error,
    });
  }
  const parsed = parseTodoLikeFile(text, file);
  const lines = lineCount(text);

  if (parsed.format === "pointer-stub") {
    return row({
      kind: "todos", file, lines, entries: 0, live: 0, finished: 0, rotatable: 0,
      reason: "pointer stub — the register lives elsewhere and is counted there",
    });
  }
  if (parsed.format === "unreadable" || parsed.format === "unrecognised") {
    return row({
      kind: "todos", file, lines, entries: 0, live: 0, finished: 0, rotatable: 0,
      reason: parsed.unparsed ?? `format not recognised (${parsed.format})`, unread: true,
    });
  }

  const all = text.split("\n");
  const closed = closedSectionLines(all);
  const checked = all.filter((l, i) => /^\s*[-*]\s+\[[xX]\]/.test(l) && !closed.has(i + 1)).length;
  const open = (parsed.items ?? []).length;

  return row({
    kind: "todos", file, lines, entries: open + checked, live: open, finished: checked,
    rotatable: checked, reason: checked === 0 ? "nothing checked" : null,
  });
}

/**
 * Classify a GOTCHAS.md. NEVER rotatable on age — see LIFECYCLE.gotchas.
 *
 * Note `parseEntries` counts only TRIGGERED entries (it does `if (!trig) continue`),
 * so entry totals here are counted from headings directly. Using its count would
 * report a file of untriggered prose as empty, which is how a 478-line Shopify
 * register read as "0 entries" earlier the same day.
 */
function readGotchas(file) {
  const { text, error } = readSafe(file);
  if (error) {
    return row({
      kind: "gotchas", file, lines: 0, entries: 0, live: 0, finished: 0, rotatable: 0,
      reason: error, unread: true, error,
    });
  }
  const lines = lineCount(text);
  if (/^#\s+GOTCHAS\.md\s+—\s+moved/m.test(text) || /pointer stub/.test(text.slice(0, 400))) {
    return row({
      kind: "gotchas", file, lines, entries: 0, live: 0, finished: 0, rotatable: 0,
      reason: "pointer stub — the register lives elsewhere and is counted there",
    });
  }

  const heads = headingsOutsideFences(text, /^###\s+/);
  const retired = heads.filter((h) => GOTCHA_RETIRED_RE.test(h)).length;
  const triggered = parseEntries(file).entries.length;

  return row({
    kind: "gotchas", file, lines, entries: heads.length, live: heads.length - retired,
    finished: retired,
    // Retired entries collapse to a tombstone rather than rotating wholesale,
    // so they are reported but never counted as rotatable bulk.
    rotatable: 0,
    reason: LIFECYCLE.gotchas.whyNever,
    triggered,
  });
}

/**
 * Derive the register census.
 *
 * @param {{searchRoots?: string[], gotchasFiles?: string[]}} [opts]
 *   `gotchasFiles` is injected rather than walked: gotchas are discovered by
 *   `sourcesFor()` relative to a cwd, which is a different question from "every
 *   register in the tree". Callers that want the tree-wide view pass the list.
 * @returns {{rows: object[], totals: object, unread: object[]}}
 */
export function registers({ searchRoots, gotchasFiles = [] } = {}) {
  const discovery = discoverBacklogFiles(searchRoots ? { searchRoots } : undefined);

  const rows = [
    ...discovery.issuesMd.map(readIssues),
    ...discovery.handoverMd.map(readHandover),
    ...discovery.todosMd.map(readTodos),
    ...gotchasFiles.map(readGotchas),
  ];

  const by = (kind, field) => rows.filter((r) => r.kind === kind).reduce((a, r) => a + r[field], 0);

  const totals = {
    files: rows.length,
    hot: {
      issues: by("issues", "live"),
      handovers: by("handovers", "live"),
      todos: by("todos", "live"),
      gotchas: by("gotchas", "live"),
    },
    rotatable: {
      issues: by("issues", "rotatable"),
      handovers: by("handovers", "rotatable"),
      todos: by("todos", "rotatable"),
      gotchas: 0,
    },
    // Reported separately from `rotatable` on purpose: a retired gotcha is
    // finished but is NOT bulk to move out.
    retiredGotchas: by("gotchas", "finished"),
    // Any subtree the walk could not reach in its budget. Never silently omitted.
    dropped: discovery.dropped ?? [],
  };

  totals.rotatableTotal =
    totals.rotatable.issues + totals.rotatable.handovers + totals.rotatable.todos;

  return { rows, totals, unread: rows.filter((r) => r.unread) };
}

/** The files with the most rotatable bulk, largest first. Ties broken by size. */
export function rotationCandidates(result, { limit = 5 } = {}) {
  return result.rows
    .filter((r) => r.rotatable > 0)
    .sort((a, b) => b.rotatable - a.rotatable || b.lines - a.lines)
    .slice(0, limit);
}

/** Registers over a line budget, for the caps warning. Warn-only by design. */
export function overCap(result, caps = {}) {
  return result.rows
    .filter((r) => caps[r.kind] && r.lines >= caps[r.kind])
    .map((r) => ({ ...r, cap: caps[r.kind] }))
    .sort((a, b) => b.lines - a.lines);
}
