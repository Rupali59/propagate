/**
 * evidence.mjs — what actually changed, for the judgement being asked.
 *
 * THE FINDING THIS ANSWERS. The design review's first and sharpest item was that
 * this system demands a justification and gives you nothing to justify FROM. A
 * queue row asks "did this source change require a downstream change?" and shows
 * the `why` string — which is the reason the edge was DECLARED, written once,
 * possibly years ago. It is not the change.
 *
 * It turns out the change was always derivable. Every event records
 * `observed_at_commit`: the commit the source sat at when someone last said this
 * edge was fine. Measured 2026-09-17: **48 of 48** actionable edges have one, and
 * a diff costs **~19 ms** (15 produced in 289 ms, zero failures). So there is
 * nothing to cache and nothing to precompute — deriving 48 diffs to show one is
 * exactly the waste `rule:delegation-criteria` §2 exists to prevent.
 *
 * THE FIELD NAME COST A MEASUREMENT. `why` renders a composed `position` object;
 * the raw event stores flat `observed_at_commit` / `observed_dirty`. Reading the
 * rendered shape against raw events reports **0 of 48** — a confident, plausible
 * zero produced entirely by the ruler (`rule:discernment-checks` §4). It is named
 * here because the next person to reach for this data will read `why` first too.
 *
 * ── TWO RULES ──────────────────────────────────────────────────────────────
 *
 * **1. A failure is a NAMED REASON, never empty text.** "No commit recorded",
 * "not a git repository", "file deleted" and "nothing changed" are four different
 * facts and only the last one means the edge is quiet. An empty evidence panel
 * reads as "nothing changed", which is the one thing it must never say by
 * accident (`rule:discernment-checks` §2, and §6 — a reader that cannot report
 * failure invents an answer).
 *
 * **2. The diff is never presented as exact when it cannot be.** 37 of those 48
 * events were recorded while the working tree was DIRTY, so the commit is not
 * what was actually looked at. Those carry a caveat rather than a false
 * precision.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import path from "node:path";

const run = promisify(execFile);

/** Above this the panel collapses. Median diff is 61 lines; 1 in 15 exceeds 200. */
export const MAX_LINES = 200;

/**
 * NEVER A SHELL STRING. `execFile` with an argument array means a path
 * containing a space, a quote or a `;` is an argument, not syntax. Paths in this
 * tree already include `Vipin Kaushik/` — a space in a directory name — so this
 * is a live concern, not a theoretical one.
 */
async function git(repo, args) {
  const { stdout } = await run("git", ["-C", repo, ...args], { maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

/** The repository a file belongs to, or null when it is not in one. */
export async function repoRoot(file, deps = {}) {
  const g = deps.git ?? git;
  try {
    return (await g(path.dirname(file), ["rev-parse", "--show-toplevel"])).trim() || null;
  } catch {
    return null;
  }
}

/** Trim to MAX_LINES and SAY SO — a silent truncation reads as the whole diff. */
function clamp(text, max = MAX_LINES) {
  const lines = String(text ?? "").split("\n");
  if (lines.length <= max) return { text: lines.join("\n"), truncated: null };
  return {
    text: lines.slice(0, max).join("\n"),
    truncated: `showing the first ${max} of ${lines.length} lines`,
  };
}

/**
 * What changed in a source file since the edge was last judged.
 *
 * @param {{file: string, sinceCommit: string|null, dirty?: boolean, deps?: object}} opts
 * @returns {Promise<{ok: boolean, kind: string, text?: string, reason?: string, caveat?: string|null, truncated?: string|null, since?: string}>}
 */
export async function edgeDiff({ file, sinceCommit, dirty = false, deps = {} } = {}) {
  const g = deps.git ?? git;
  const kind = "diff";

  if (!file) return { ok: false, kind, reason: "no source file on this edge" };
  if (!sinceCommit) {
    // Every actionable edge has one today, but a freshly declared edge with no
    // event does not — and that is a different fact from "nothing changed".
    return { ok: false, kind, reason: "never judged, so there is no commit to compare against — this edge has no history yet" };
  }

  const repo = deps.repoRoot ? await deps.repoRoot(file) : await repoRoot(file, { git: g });
  if (!repo) return { ok: false, kind, reason: `${path.dirname(file)} is not inside a git repository` };

  const rel = path.relative(repo, file);
  let out;
  try {
    out = await g(repo, ["diff", "--unified=3", `${sinceCommit}..HEAD`, "--", rel]);
  } catch (err) {
    // A commit that no longer exists (rebased, or a different clone) is the
    // common case and must say which commit, or it cannot be acted on.
    const msg = String(err?.stderr || err?.message || err).split("\n")[0];
    return { ok: false, kind, reason: `cannot diff from ${sinceCommit.slice(0, 8)} — ${msg}` };
  }

  if (!out.trim()) {
    // A REAL result, and distinct from every failure above: the file is byte
    // identical to when it was judged, so the drift is on the other side.
    return {
      ok: true,
      kind,
      text: "",
      empty: true,
      since: sinceCommit,
      caveat: null,
      truncated: null,
      reason: "the source has not changed since it was last judged — look at the downstream instead",
    };
  }

  const { text, truncated } = clamp(out);
  return {
    ok: true,
    kind,
    text,
    truncated,
    since: sinceCommit,
    // THE HONESTY CLAUSE. 37 of 48 events were recorded with a dirty tree, so
    // the commit is not what the person actually looked at; the diff may include
    // changes that were already sitting uncommitted at that moment.
    caveat: dirty
      ? "the working tree was dirty when this was last judged, so this diff may include changes that were already present then"
      : null,
  };
}

/**
 * An issue's own entry — the heading and the prose beneath it.
 *
 * WHY THE WHOLE ENTRY AND NOT THE LINE. For an issue the evidence IS the
 * argument: what was measured, what it cost, why it is that severity. A one-line
 * heading is a title, and judging a title is the thing this surface exists to
 * stop.
 */
export async function entryBody({ file, line, deps = {} } = {}) {
  const read = deps.readFile ?? readFile;
  const kind = "entry";
  if (!file || !Number.isInteger(line) || line < 1) return { ok: false, kind, reason: "no file and line to read" };

  let text;
  try {
    text = await read(file, "utf8");
  } catch (err) {
    return { ok: false, kind, reason: `cannot read ${path.basename(file)} — ${err.message}` };
  }

  const lines = text.split("\n");
  if (line > lines.length) {
    return { ok: false, kind, reason: `line ${line} is past the end of the file — it has ${lines.length} lines; reload` };
  }

  // From this heading to the next one at the SAME level. A `####` inside the
  // entry is part of it; the next `###` is the following entry.
  const start = line - 1;
  const level = (lines[start].match(/^#+/) ?? [""])[0].length;
  let end = lines.length;
  if (level > 0) {
    for (let i = start + 1; i < lines.length; i += 1) {
      const m = lines[i].match(/^#+/);
      if (m && m[0].length <= level) { end = i; break; }
    }
  } else {
    // Not a heading (a todo line): a few lines of context either side is the
    // useful unit, since the surrounding items are what give it meaning.
    return finishSpan(lines, Math.max(0, start - 2), Math.min(lines.length, start + 3), kind, line);
  }
  return finishSpan(lines, start, end, kind, line);
}

function finishSpan(lines, start, end, kind, line) {
  const { text, truncated } = clamp(lines.slice(start, end).join("\n").replace(/\s+$/, ""));
  return { ok: true, kind, text, truncated, caveat: null, startLine: start + 1, line };
}

/**
 * One entry point, so a caller never picks the wrong reader for a row kind.
 * `commands/` renders this; nothing here prints or writes.
 */
export async function evidenceFor({ kind, file, line, sinceCommit, dirty, deps } = {}) {
  if (kind === "edge") return edgeDiff({ file, sinceCommit, dirty, deps });
  if (kind === "issue" || kind === "todo") return entryBody({ file, line, deps });
  return { ok: false, kind: "unknown", reason: `no evidence reader for kind ${JSON.stringify(kind ?? null)}` };
}
