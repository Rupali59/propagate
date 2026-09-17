/**
 * write.mjs — the only code in this repo that edits a hand-written register.
 *
 * WHY THIS IS DANGEROUS AND THEREFORE NARROW. `ISSUES.md`, `TODOS.md` and
 * `HANDOVERS.md` are not an event store. They are prose that people wrote, with
 * conventions this repo enforces elsewhere, and a bad write does not append a
 * junk row — it destroys a sentence somebody meant.
 *
 * So every function here plans a change to **exactly one line**, identified by
 * its full current text, and the apply step refuses if that text has moved.
 *
 * ── THE THREE GUARANTEES ───────────────────────────────────────────────────
 *
 * **1. Line-anchored, re-read immediately before writing.** The browser's view
 * may be seconds old. `applyEdit` reads the file NOW and compares the whole
 * line, byte for byte, against what the reader was looking at. Two windows open
 * is a race, not a bug — `/queue` already handles it this way, by re-deriving
 * and re-running the same guard `verify` uses.
 *
 * **2. One line changes. Never more.** `applyEdit` asserts the line count is
 * unchanged and that every OTHER line is identical. A planner with a greedy
 * regex cannot quietly take a second line with it.
 *
 * **3. Nothing is written that was not previewed.** The caller passes the exact
 * `next` line it showed the human. This module does not re-plan at write time,
 * because a plan computed twice can differ twice.
 *
 * WHAT IS DELIBERATELY NOT HERE. `HANDOVERS.md` resolution — it is append-only
 * by its own header, so resolving INSERTS a dated block beneath rather than
 * rewriting, which is a different operation with a different guarantee. Stage 2.
 */

import { readFile, writeFile, rename } from "node:fs/promises";

/** `YYYY-MM-DD`, injected rather than read from the clock so a test can pin it
 *  and so the same date reaches the preview and the write. */
function today(now) {
  return new Date(now).toISOString().slice(0, 10);
}

const MIN_REASON = 12;

/**
 * Plan closing an id-keyed issue.
 *
 * The heading looks like:
 *   `### N82 · title — **S2** — **OPEN**`
 * and closing it replaces the trailing status marker only. The severity and the
 * title are left exactly as they were: this operation changes ONE fact.
 */
export function planIssueClose(line, { reason, now = Date.now(), status = "RESOLVED" } = {}) {
  if (!/^###\s/.test(line)) return { ok: false, error: "not an issue heading — refusing to guess" };
  if (!/\*\*OPEN\*\*/.test(line)) {
    // Already closed, or a shape this planner does not understand. Both mean
    // "do not write", and saying which is the difference between a reader who
    // reloads and one who files a bug (rule:discernment-checks §2).
    return { ok: false, error: "no **OPEN** marker on that line — it may already be closed; reload" };
  }
  const bad = badReason(reason);
  if (bad) return { ok: false, error: bad };
  if (!/^[A-Z]+$/.test(status)) return { ok: false, error: "status must be a bare uppercase word" };

  const next = line.replace(/\*\*OPEN\*\*/, `**${status} ${today(now)} — ${reason.trim()}**`);
  return { ok: true, next };
}

/** Plan a severity change. Same discipline: one marker, nothing else. */
export function planIssueSeverity(line, { severity, reason, now = Date.now() } = {}) {
  if (!/^###\s/.test(line)) return { ok: false, error: "not an issue heading — refusing to guess" };
  if (!/^S[0-4]$/.test(String(severity))) return { ok: false, error: "severity must be S0..S4" };
  if (!/\*\*S[0-4]\*\*/.test(line)) return { ok: false, error: "no **Sn** marker on that line to change" };
  const bad = badReason(reason);
  if (bad) return { ok: false, error: bad };
  const next = line.replace(/\*\*S[0-4]\*\*/, `**${severity}**`);
  if (next === line) return { ok: false, error: `already ${severity} — nothing to write` };
  return { ok: true, next };
}

/**
 * Plan ticking a checkbox todo.
 *
 * `- [ ] **thing**` becomes `- [x] **thing** — done <date>, <reason>`.
 *
 * The reason is appended rather than replacing the text, because the text is
 * what makes the item findable later and a closed item with its description
 * replaced by "done" is a lost item.
 */
export function planTodoTick(line, { reason, now = Date.now() } = {}) {
  const m = /^(\s*)-\s\[( |x|X)\]\s(.*)$/.exec(line);
  if (!m) return { ok: false, error: "not a checkbox line — refusing to guess" };
  if (m[2] !== " ") return { ok: false, error: "already ticked — reload" };
  const bad = badReason(reason);
  if (bad) return { ok: false, error: bad };
  return { ok: true, next: `${m[1]}- [x] ${m[3]} — done ${today(now)}, ${reason.trim()}` };
}

/**
 * A reason is mandatory and must be a sentence.
 *
 * SAME DISCIPLINE AS `verify`, AND FOR THE SAME REASON. The whole value of
 * these registers is that a closed item explains itself; "done" tells the next
 * reader nothing they could not see from the checkbox. A length floor is a
 * crude proxy for that and is not trying to be more.
 */
export function badReason(reason) {
  const r = String(reason ?? "").trim();
  if (!r) return "a reason is required — a closed item with no reason is a lost one";
  if (r.length < MIN_REASON) return `reason must be at least ${MIN_REASON} characters (got ${r.length})`;
  if (/\n/.test(r)) return "reason must be a single line — it is going into a markdown heading";
  return null;
}

export const PLANNERS = Object.freeze({
  "issue-close": planIssueClose,
  "issue-severity": planIssueSeverity,
  "todo-tick": planTodoTick,
});

/**
 * A one-line unified diff, for the preview.
 *
 * THE PREVIEW IS THE POINT. The design review's first finding was that the
 * system demands a judgement and gives you no evidence to make it. A human
 * approves this exact hunk; they are not approving a promise that something
 * reasonable will happen.
 */
export function previewDiff(file, lineNo, before, after) {
  return [
    `--- ${file}`,
    `+++ ${file}`,
    `@@ -${lineNo},1 +${lineNo},1 @@`,
    `-${before}`,
    `+${after}`,
  ].join("\n");
}

/**
 * Apply a planned edit, or refuse and say why.
 *
 * `expected` is the FULL current text of the line as the reader saw it. Not a
 * prefix, not the parsed title — the whole line. Anything less can match a
 * different line after an edit above it.
 */
export async function applyEdit({ file, line, expected, next, deps = {} } = {}) {
  const read = deps.readFile ?? readFile;
  const write = deps.writeFile ?? writeFile;
  const mv = deps.rename ?? rename;

  if (!file || !Number.isInteger(line) || line < 1) return { ok: false, error: "file and a 1-based line are required" };
  if (typeof expected !== "string" || typeof next !== "string") return { ok: false, error: "expected and next must both be strings" };
  if (expected === next) return { ok: false, error: "nothing to change" };
  if (/\n/.test(next)) return { ok: false, error: "a replacement line may not contain a newline — this writes ONE line" };

  let text;
  try {
    text = await read(file, "utf8");
  } catch (err) {
    return { ok: false, error: `cannot read ${file} — ${err.message}` };
  }

  const lines = text.split("\n");
  if (line > lines.length) {
    return { ok: false, error: `line ${line} is past the end of the file (${lines.length} lines) — the file changed; reload` };
  }

  // THE RACE CHECK. Not "does the line still start with N82" — the whole line,
  // byte for byte. Anything weaker lets a concurrent edit through.
  if (lines[line - 1] !== expected) {
    return {
      ok: false,
      error:
        `line ${line} is not what was previewed — the file changed since it was rendered; reload.\n` +
        `  expected: ${expected}\n` +
        `  found:    ${lines[line - 1]}`,
    };
  }

  const out = lines.slice();
  out[line - 1] = next;

  // GUARANTEE 2, asserted rather than assumed. A planner is a regex, and a
  // regex that quietly matched a newline would take a second line with it.
  if (out.length !== lines.length) return { ok: false, error: "internal: the edit changed the line count" };
  for (let i = 0; i < out.length; i += 1) {
    if (i !== line - 1 && out[i] !== lines[i]) return { ok: false, error: `internal: line ${i + 1} changed and should not have` };
  }

  const tmp = `${file}.propagate-tmp`;
  try {
    await write(tmp, out.join("\n"));
    await mv(tmp, file);
  } catch (err) {
    return { ok: false, error: `write failed — ${err.message}` };
  }
  return { ok: true, file, line, before: expected, after: next };
}

/**
 * Plan + preview in one call, so a caller cannot show one thing and write
 * another. The route it feeds hands `next` straight back on confirm.
 */
export function planEdit({ action, file, line, current, ...opts }) {
  const planner = PLANNERS[action];
  if (!planner) return { ok: false, error: `unknown action ${action}` };
  const r = planner(current, opts);
  if (!r.ok) return r;
  return { ok: true, next: r.next, diff: previewDiff(file, line, current, r.next) };
}
