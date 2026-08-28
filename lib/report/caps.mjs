/**
 * caps.mjs — context-budget caps, derived tree-wide.
 *
 * WHY THIS EXISTS. `Vipin Kaushik/scripts/hygiene/lib/size-caps.sh:63` reads
 * `proj_files=("CLAUDE.md" "STATE.md")` at each project's PRE-MOVE repo path,
 * which since the 2026-08-21 relocation is a 14-line pointer stub. Filed as N53.
 * The gate ran on all 15 commits that took one STATE.md from 225 to 471 lines in
 * a single day and named zero STATE.md files.
 *
 * Two forks of that shell library each held an improvement the other lacked, 80
 * lines apart, and the daemon ran the weaker one. So this is a convergence, not
 * a rewrite: it reuses `discoverBacklogFiles`'s single traversal rather than
 * adding a third walk.
 *
 * THE LOAD-BEARING PROPERTY is that every record carries the SOURCE it was read
 * from. "I looked at a stub" and "this file is 14 lines" must be different
 * outputs — rule:discernment-checks §2 and §6. N53 measured two projects that
 * pass BY ACCIDENT (93 and 38 real lines), which is exactly what makes the three
 * genuine breaches invisible.
 *
 * NOT the pre-commit gate. That reads `git diff --cached --numstat` and never
 * walks the tree; see the plan's perf contract. This is the report path, where
 * cost is free.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { discoverBacklogFiles } from "./backlog.mjs";
import { HUB_ROOT, HUB_ROOT_DIAGNOSTIC } from "../core/config.mjs";

/**
 * Defaults from `rules/conventions/CONTEXT-BUDGET.md` §Caps. A workspace may
 * override them with a `[caps]` TOML block in its own CONTEXT-BUDGET.md; that
 * is read by the shell forks today and is not yet wired here.
 *
 * GOTCHAS.md is deliberately absent from this table, not forgotten: it is capped
 * on ENTRIES, and the number lands when propagation aligns. See GOTCHAS_CAP.
 */
export const DEFAULT_CAPS = {
  "workspace/CLAUDE.md": 220,
  "project/CLAUDE.md": 180,
  "workspace/STATE.md": 200,
  "project/STATE.md": 200,
  "workspace/TODOS.md": 150,
  "project/TODOS.md": 150,
  "project/MEMORY.md": 40,
  "ISSUES.md": 800,
  "handover": 800,
};

/**
 * Unset ON PURPOSE. The hub policy fixes one constraint — it must exceed the
 * current maximum, or the ratchet freezes the largest file the day it lands and
 * reintroduces the bypass problem the old `(none)` exemption was written to
 * avoid. Until a number is chosen, gotchas are MEASURED and never judged: they
 * report `status: "unset"`, which is not a pass.
 */
export const GOTCHAS_CAP = null;
export const GOTCHAS_METRIC = "entries";

export const YELLOW_THRESHOLD = 0.9;

/** `### ` headings, with fenced blocks stripped first. */
export function countEntries(text) {
  // propagate's own N51 was this bug one file over: `parseHandovers` read fenced
  // EXAMPLES as real sections. Any `^### ` counter written the obvious way
  // reintroduces it, so strip fences before counting rather than after.
  const unfenced = String(text).replace(/^```[\s\S]*?^```/gm, "");
  return (unfenced.match(/^### /gm) || []).length;
}

export function countLines(text) {
  // Auto-rendered blocks do not count. `collect.sh` writes ~28 lines into a
  // STATE.md between HYGIENE_RENDER markers labelled "do not hand-edit" — 13% of
  // a 200-line cap a human is then asked to meet by hand.
  //
  // An UNCLOSED block (START present, END deleted) falls back to the FULL count
  // rather than silently swallowing the rest of the file. Fail-safe by
  // construction: a truncating bug must over-report, never under-report.
  // `wc -l` COUNTS NEWLINES, so a file ending in one yields no trailing line.
  // `split("\n")` yields a trailing "" for exactly that file, over-reporting by
  // one. Caught by running this against the real tree: it called
  // `Vipin Kaushik/CLAUDE.md` 220 where that workspace's own hook says 219.
  // One line is not cosmetic here — the comparison is `>=`, so an off-by-one
  // flips the verdict for any file sitting exactly at its cap.
  const raw = String(text);
  const lines = raw.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();

  let inBlock = false, opened = false, closed = false, kept = 0;
  for (const l of lines) {
    if (l.includes("<!-- HYGIENE_RENDER:START -->")) { inBlock = true; opened = true; }
    if (!inBlock) kept++;
    if (l.includes("<!-- HYGIENE_RENDER:END -->") && inBlock) { inBlock = false; closed = true; }
  }
  return opened && !closed ? lines.length : kept;
}

/**
 * A pointer stub left at a pre-move path. MUST be distinguishable from a short
 * real file — that conflation is N53 itself.
 */
export function isPointerStub(text) {
  const t = String(text);
  if (t.split("\n").length > 40) return false;
  return /state lives at|has moved to|pointer stub|see .*propagation\/state/i.test(t);
}

/**
 * Classify a discovered path into { kind, scope, project, source }.
 *
 * `source` is the whole point:
 *   propagation-state  read from <workspace>/propagation/state/<project>/
 *   in-repo            no propagation/state entry; measured where it lives
 *   stub-legacy        a pointer stub at the pre-move path — SKIPPED, not passed
 */
export function classifyPath(file, text, hubRoot = null) {
  const base = path.basename(file);
  const inPropagation = file.includes(`${path.sep}propagation${path.sep}state${path.sep}`);
  const segs = file.split(path.sep);

  let project = null, scope = "project";
  if (inPropagation) {
    const i = segs.lastIndexOf("state");
    project = segs[i + 1] ?? null;
    scope = project === "workspace" ? "workspace" : "project";
  } else {
    project = segs[segs.length - 2] ?? null;
    // SCOPE IS DEPTH, for in-repo files. `<hub>/CLAUDE.md` and
    // `<hub>/<workspace>/CLAUDE.md` are workspace-scope (cap 220);
    // `<hub>/<workspace>/<project>/CLAUDE.md` is project-scope (cap 180).
    //
    // Without this every in-repo file was judged at the project cap, so
    // `Vipin Kaushik/CLAUDE.md` read as 220/180 OVER where that workspace's own
    // hook reports it yellow against 220. A checker that disagrees with the
    // gate it is replacing is not a stricter checker, it is a wrong one.
    if (hubRoot) {
      const rel = path.relative(hubRoot, file);
      if (!rel.startsWith("..")) {
        const depth = rel.split(path.sep).length; // 1 = hub root file, 2 = workspace, 3+ = project
        if (depth <= 2) scope = "workspace";
      }
    }
  }

  let source = inPropagation ? "propagation-state" : "in-repo";
  if (!inPropagation && isPointerStub(text)) source = "stub-legacy";

  return { kind: base, scope, project, source };
}

export function capFor({ kind, scope }) {
  if (kind === "GOTCHAS.md") return GOTCHAS_CAP;
  if (kind === "ISSUES.md") return DEFAULT_CAPS["ISSUES.md"];
  if (/^HANDOVER/i.test(kind)) return DEFAULT_CAPS["handover"];
  return DEFAULT_CAPS[`${scope}/${kind}`] ?? null;
}

/**
 * Build one record per discovered capped file.
 *
 * Every branch produces an attributable status. There is no path that renders a
 * file as green without having measured it:
 *   ok | yellow | over   — measured against a cap
 *   skipped               — a legacy-path stub; the real file is measured elsewhere
 *   unset                 — measured, but this kind has no cap yet (gotchas)
 *   uncapped              — no cap declared for this kind, stated rather than assumed
 *   unreadable            — with the reason
 */
export function capsReport({ discover = discoverBacklogFiles, readFile = (f) => readFileSync(f, "utf8"), hubRoot = HUB_ROOT } = {}) {
  // G24: an unconfigured hub resolves to null, and null reads as "not
  // configured" rather than "configured wrong". Without a hub root every
  // in-repo file silently falls back to the PROJECT cap, which is how
  // `Vipin Kaushik/CLAUDE.md` read as over-cap against 180 when its own
  // workspace judges it against 220. So the degradation is REPORTED, not
  // absorbed.
  const scopeDegraded = hubRoot ? null : (HUB_ROOT_DIAGNOSTIC ?? "hub root unresolved — in-repo files judged at PROJECT caps, which under-reports workspace-scope files");
  const found = discover();
  const files = [
    ...found.claudeMd, ...found.stateMd, ...found.todosMd,
    ...found.issuesMd, ...found.gotchasMd, ...found.handoverMd,
    ...found.memoryMd,
  ];

  const records = [];
  for (const file of [...new Set(files)]) {
    let text;
    try {
      text = readFile(file);
    } catch (err) {
      records.push({ file, status: "unreadable", reason: String(err.message ?? err) });
      continue;
    }
    const { kind, scope, project, source } = classifyPath(file, text, hubRoot);

    if (source === "stub-legacy") {
      records.push({ file, kind, scope, project, source, status: "skipped", reason: "pointer stub at the pre-move path" });
      continue;
    }

    const metric = kind === "GOTCHAS.md" ? GOTCHAS_METRIC : "lines";
    const actual = metric === "entries" ? countEntries(text) : countLines(text);
    const cap = capFor({ kind, scope });

    let status;
    if (cap === null && kind === "GOTCHAS.md") status = "unset";
    else if (cap === null) status = "uncapped";
    else if (actual >= cap) status = "over";
    else if (actual >= Math.floor(cap * YELLOW_THRESHOLD)) status = "yellow";
    else status = "ok";

    records.push({ file, kind, scope, project, source, metric, actual, cap, status });
  }

  const by = (s) => records.filter((r) => r.status === s);
  return {
    records,
    totals: {
      measured: records.filter((r) => ["ok", "yellow", "over"].includes(r.status)).length,
      over: by("over").length,
      yellow: by("yellow").length,
      skippedStubs: by("skipped").length,
      unset: by("unset").length,
      uncapped: by("uncapped").length,
      unreadable: by("unreadable").length,
      excessLines: by("over").reduce((n, r) => n + (r.actual - r.cap), 0),
    },
    scopeDegraded,
    // MEMORY.md lives at ~/.claude/projects/*/memory/, OUTSIDE the walked tree.
    // The shell fork discovered it with a separate glob. Reporting 0 here would
    // be a reader that never looked, rendered as a clean result — §2 again.
    notDiscovered: found.memoryMd.length === 0
      ? [{ kind: "MEMORY.md", reason: "lives outside the walked tree (~/.claude/projects/*/memory/); needs the memory_watches glob, not this walk" }]
      : [],
  };
}
