/**
 * queue.mjs — open register items, with the exact bytes a write will anchor on.
 *
 * WHY IT RE-READS THE FILES `backlog` ALREADY READ. `backlog` returns the
 * PARSED text of an item — `N82 · The workspace census…` — which is not the
 * line on disk. The line on disk is
 * `### N82 · The workspace census… — **S2** — **OPEN**`, and that is what the
 * write has to match byte for byte.
 *
 * Anchoring on the parsed text would be a prefix match by another name, and a
 * prefix match can land on a different line after an edit above it. So each
 * file is read once (not once per item) and the raw line is carried alongside.
 *
 * WHAT IT DOES NOT DO. It offers no action it cannot justify from the line
 * itself: a heading with no `**OPEN**` marker gets no close button, and a
 * checkbox already ticked gets no tick button. The UI must never render a
 * control that the write path will refuse — a button that always errors is
 * worse than an absent one, and it is the same rule the disposition queue
 * follows for DIVERGED.
 */

import { readFileSync } from "node:fs";

/** One read per FILE, not per item. */
function linesOf(file, cache, read) {
  if (cache.has(file)) return cache.get(file);
  let lines = null;
  try {
    lines = read(file, "utf8").split("\n");
  } catch {
    lines = null; // attributed by the caller as `unreadable`
  }
  cache.set(file, lines);
  return lines;
}

/** Which actions this exact line can support. Derived from the line, never
 *  assumed from the file's kind. */
export function actionsFor(kind, raw) {
  const out = [];
  if (kind === "issue") {
    if (/\*\*OPEN\*\*/.test(raw)) out.push("issue-close");
    if (/\*\*S[0-4]\*\*/.test(raw)) out.push("issue-severity");
  } else if (kind === "todo") {
    if (/^\s*-\s\[ \]\s/.test(raw)) out.push("todo-tick");
  }
  return out;
}

/**
 * Open issues and todos, each carrying the raw line.
 *
 * @param {{backlogFn?: Function, read?: Function, limit?: number}} opts
 */
export function registerQueue({ backlogFn, read = readFileSync, limit = 200 } = {}) {
  let result;
  try {
    const fn = backlogFn ?? require0();
    result = fn({});
  } catch (err) {
    // The shape a consumer expects with the error IN it, never an empty list —
    // an empty register list renders as "nothing to do" (rule:discernment-checks §6).
    return { error: String(err?.message ?? err), issues: null, todos: null };
  }

  const cache = new Map();
  let unreadable = 0;
  let skipped = 0;

  const attach = (item, kind) => {
    const lines = linesOf(item.file, cache, read);
    if (!lines) { unreadable += 1; return null; }
    const raw = lines[item.line - 1];
    if (typeof raw !== "string") { skipped += 1; return null; }
    const actions = actionsFor(kind, raw);
    if (!actions.length) { skipped += 1; return null; }
    // WHY A BUTTON IS MISSING, stated on the row. Two conventions for issue
    // status live in this tree: newer entries carry `**OPEN**` in the heading
    // and are closed by flipping it; older ones (propagate's own N10, and
    // everything before N77) carry no status marker at all and state their
    // resolution in the BODY. Flipping a marker that is not there is not a
    // safe write, so close is not offered — and the row says so, rather than
    // quietly rendering one fewer button than the row beside it.
    const noClose = kind === "issue" && !actions.includes("issue-close")
      ? "no **OPEN** marker in the heading — this entry states its status in the body, which this surface does not edit"
      : null;
    return {
      kind,
      file: item.file,
      line: item.line,
      raw,                        // the write anchor — the WHOLE line
      text: item.text,            // what a human reads
      id: item.id ?? null,
      priority: item.priority ?? null,
      actions,
      noClose,
      short: shortFile(item.file),
    };
  };

  const issues = [];
  for (const f of result.issueFiles ?? []) {
    for (const it of f.items ?? []) {
      const row = attach(it, "issue");
      if (row) issues.push(row);
    }
  }

  // `ranked` is already priority-ordered and deduped across files.
  const todos = [];
  for (const it of result.ranked ?? []) {
    const row = attach(it, "todo");
    if (row) todos.push(row);
  }

  return {
    error: null,
    issues: issues.slice(0, limit),
    todos: todos.slice(0, limit),
    // Truncation is STATED. A silent top-N reads as "this is everything"
    // (`rule:delegation-criteria`: no silent caps).
    counts: {
      issues: issues.length,
      todos: todos.length,
      shownIssues: Math.min(issues.length, limit),
      shownTodos: Math.min(todos.length, limit),
      unreadable,
      // Items whose line offers no action — already closed, or a shape no
      // planner understands. Counted so "fewer rows than doctor reports" has an
      // explanation rather than looking like data loss.
      noAction: skipped,
    },
    generatedAt: new Date().toISOString(),
  };
}

/** Workspace-qualified and middle-elided, matching the queue's convention —
 *  53 files in this tree are named CLAUDE.md and the registers collide too. */
export function shortFile(abs) {
  const parts = String(abs ?? "").split("/").filter(Boolean);
  if (parts.length <= 3) return parts.join("/");
  return `${parts[parts.length - 3]}/${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

/** Deferred so importing this module does not pay for the backlog walk. */
function require0() {
  throw new Error("backlogFn is required — call registerQueue({ backlogFn })");
}
