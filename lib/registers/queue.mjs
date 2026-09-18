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

  /* HANDOVERS AND GOTCHAS ARE READ-ONLY HERE, and that is stated rather than
   * implied. Handovers are append-only by their own header (resolving must
   * INSERT a dated block, never rewrite), and promoting a gotcha to a rule is
   * the judgement N64 records as the valuable part. Neither is a marker flip,
   * so neither gets an action — but both belong on the page, because a surface
   * that claims to hold everything and silently omits two registers is lying
   * about its own coverage. */
  const handovers = [];
  for (const f of result.handovers?.files ?? []) {
    for (const sec of f.sections ?? []) {
      if (sec.status && sec.status !== "open") continue;
      handovers.push({
        kind: "handover", file: f.file, line: sec.line ?? null, short: shortFile(f.file),
        date: sec.date ?? null, text: sec.title ?? "(untitled)", doneWhen: sec.doneWhen ?? null,
        actions: [], readOnly: "append-only by its own header — resolving inserts a dated block, it never rewrites",
      });
    }
  }

  return {
    error: null,
    issues: issues.slice(0, limit),
    todos: todos.slice(0, limit),
    handovers: handovers.slice(0, limit),
    // Truncation is STATED. A silent top-N reads as "this is everything"
    // (`rule:delegation-criteria`: no silent caps).
    counts: {
      issues: issues.length,
      todos: todos.length,
      shownIssues: Math.min(issues.length, limit),
      shownTodos: Math.min(todos.length, limit),
      handovers: handovers.length,
      unreadable,
      // Items whose line offers no action — already closed, or a shape no
      // planner understands. Counted so "fewer rows than doctor reports" has an
      // explanation rather than looking like data loss.
      noAction: skipped,
    },
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Every gotcha entry, with whether it can actually FIRE.
 *
 * `parseEntries` returns only entries carrying a `**Trigger:**`, so using it
 * alone would silently hide the majority — 63 of 89 have one, and the other 26
 * are not defects. rule:every-project-carries-gotchas is explicit that most
 * hazards have no mechanical trigger and that inventing one manufactures noise.
 * So the headings are the population and the trigger is an attribute of each,
 * which is the distinction the count on the widget also draws.
 *
 * Read-only: promoting one to a rule is the judgement N64 records as the
 * valuable part, and a machine-authored fingerprint is what N76 spent a day
 * proving is hard.
 */
export function gotchaEntries({ files = [], read = readFileSync, limit = 300 } = {}) {
  const out = [];
  let unreadable = 0;
  for (const f of files) {
    let text;
    try { text = read(f, "utf8"); } catch { unreadable += 1; continue; }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const m = /^###\s+(.*)$/.exec(lines[i]);
      if (!m) continue;
      // SEARCH THE WHOLE ENTRY, to the next heading — not a fixed window.
      // A 5-line window reported 58 of 89 firing where parseEntries (which
      // splits on `### ` and searches the whole block) reports 63: five
      // entries put their Trigger further down. Two readers of one file
      // disagreeing by five is the N86 shape, and the widget's count and this
      // list are rendered side by side.
      let end = lines.length;
      for (let k = i + 1; k < lines.length; k += 1) if (/^###\s/.test(lines[k])) { end = k; break; }
      const near = lines.slice(i + 1, end).join("\n");
      const trig = /\*\*Trigger:\*\*\s*`([^`]+)`/.exec(near);
      out.push({
        kind: "gotcha", file: f, line: i + 1, short: shortFile(f),
        text: m[1], trigger: trig ? trig[1] : null, actions: [],
        readOnly: trig ? null : "no trigger — this entry is documented but never fires, which is the default for most hazards",
      });
    }
  }
  return { entries: out.slice(0, limit), total: out.length, unreadable, files: files.length };
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
