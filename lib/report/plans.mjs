/**
 * plans.mjs — what `propagate plans --check` derives.
 *
 * WHY THIS EXISTS. `.templates/PLAN.md` (hub, first commit `e24b0c1`, 2026-09-14)
 * mandates a `## Goal state` section carrying `**Done when:**` and
 * `**Derived by:**`. Nothing enforced it — zero files under `lib/`, `commands/`,
 * `cli.mjs`, `hooks/` or `skills/` referenced `PLAN.md`. This module is the
 * enforcement, and it is deliberately narrow: it reports, it never writes a
 * plan, and it never runs anything a plan names as its derivation command
 * (same posture as `lib/report/goals.mjs`, for the same reason — running shell
 * written inside a markdown file is a hole, not a feature).
 *
 * FOUR MEASURED DEFECTS THIS MODULE EXISTS TO NOT REPEAT (all confirmed by
 * reading the code that made them, during the plan that produced this file):
 *
 *   1. `doc-kind.mjs` classifies "plan" only under a `plans/` dir AND a dated
 *      basename (`DATED.test(n)`). So "the corpus" is smaller than "every file
 *      that looks like a plan" — `excludedFromPlanDirs()` below reports the
 *      difference instead of silently narrowing it.
 *   2. `declaredState()`'s `archived` branch fires only for a path under
 *      `archive/`/`_archive/`. On the in-repo corpus that has been ZERO every
 *      time it has been measured — a class that is structurally always zero
 *      must not be advertised as if it were informative
 *      (`rule:discernment-checks` §1). `finishedByArchiveDir` is reported
 *      SEPARATELY from `finishedByStatus` for exactly this reason.
 *   3. curate-docs' own caller passes `declaredState()` only `graph.seeds[0]`
 *      while the graph is built from ALL seeds. `hubLinked()` below tries every
 *      seed, not the first.
 *   4. curate-docs' `report.mjs` grades ORPHAN/DETACHED before declared-state,
 *      so a plan cited only from a sibling `plans/README.md` reads ORPHAN
 *      first. This module does not inherit that order — see `planState()`'s
 *      PRECEDENCE RULE, which is `archive/` > `Status:` > hub-linked > neither,
 *      documented once and pinned by tests/unit/plans.test.mjs.
 *
 * THE DATE GATE. Newest dated plan measured in the tree at the time this was
 * written: 2026-09-01. The template landed 2026-09-14. Every existing plan
 * predates the rule it is being checked against, so an ungated `flagged` count
 * would report ~200 pre-existing files as debt forever instead of ratcheting
 * from zero. `TEMPLATE_LANDED` gates conformance grading to files authored ON
 * OR AFTER it; older files are `exempt`, a stated fact, never silently dropped.
 *
 * ONE `classifyPlan()` ENTRY POINT. In-repo corpora (no `--root`) are
 * classified through `doc-kind.mjs`'s KINDS, same taxonomy every other reader
 * in this tree uses. External roots (`--root <path>`, e.g. `~/.claude/plans`)
 * are classified by PATH ALONE — 0 of 54 session plans measured there carry
 * frontmatter or a dated basename, so doc-kind's rule would exclude all of
 * them. The fork lives HERE, once, never scattered across callers.
 */

import { readFileSync, readdirSync, existsSync, statSync, realpathSync } from "node:fs";
import path from "node:path";

import { kindOf, DATED } from "./doc-kind.mjs";
import { declaredState, introducedBy, lastTouched } from "../../skills/curate-docs/lib/evidence.mjs";
import { buildLinkGraph } from "../../skills/curate-docs/lib/link-graph.mjs";

/** `.templates/PLAN.md`'s first commit (hub `e24b0c1`). Conformance grading is
 *  gated on this; see the module header for why an ungated count is wrong. */
export const TEMPLATE_LANDED = "2026-09-14";

/**
 * Directories a plan walk skips. Deliberately NOT `archive`/`_archive` —
 * unlike `lib/report/backlog.mjs`'s walk (which is right to skip them: a
 * finished TODO is not backlog), a plan moved under `docs/plans/archive/`
 * must still be found, because that is the one real signal `planState()` can
 * use for "finished by directory". Skipping it would make defect 2 (above)
 * permanently, artificially zero instead of honestly zero.
 */
const SKIP_DIR_NAMES = new Set([
  "node_modules", ".git", ".next", "dist", "build", ".turbo", ".vercel",
  "Library", "Trash", ".cache", ".worktrees", "vendor", ".venv", "__pycache__",
  "fixtures", "__fixtures__", "testdata", "__snapshots__",
]);

const MAX_WALK_DEPTH = 8;
const WALK_BUDGET_MS = 20_000;

// ─────────────────────────────────────────────────────────────────────────────
// Root validation — D5: a bad root exits non-zero naming the path; an empty
// but valid root is a DIFFERENT outcome. Kept as pure data here; commands/
// plans.mjs decides the process exit code and the words on screen.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @returns {{ok:true} | {ok:false, reason:"missing"|"not-a-directory"|"unreadable", detail:string}}
 */
export function validateRoot(root) {
  if (!existsSync(root)) {
    return { ok: false, reason: "missing", detail: `no such path: ${root}` };
  }
  let st;
  try {
    st = statSync(root);
  } catch (err) {
    return { ok: false, reason: "unreadable", detail: `${root}: ${err.message}` };
  }
  if (!st.isDirectory()) {
    return { ok: false, reason: "not-a-directory", detail: `not a directory: ${root}` };
  }
  try {
    readdirSync(root);
  } catch (err) {
    return { ok: false, reason: "unreadable", detail: `${root}: ${err.message}` };
  }
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Discovery — every markdown file under a root, bounded, absence attributable.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Walk `root` collecting every `.md` file. Bounded by depth and a wall-clock
 * budget, same shape as `lib/report/backlog.mjs`'s `discoverBacklogFiles` —
 * any subtree not reached is recorded in `dropped`, never silently omitted
 * (`rule:discernment-checks` §2).
 *
 * Symlinks are followed, inode-guarded against cycles — same reason
 * `skills/curate-docs/lib/discovery.mjs` does: neither `readdirSync`'s
 * `Dirent` nor git treats a symlinked FILE as a file (`isFile()` is false for
 * it), so `skills/propagate/SKILL.md` — a real symlink to the repo's own
 * `SKILL.md` — silently vanished from the walk until this was added.
 */
export function walkMarkdown(root, { maxDepth = MAX_WALK_DEPTH, budgetMs = WALK_BUDGET_MS } = {}) {
  const files = [];
  const dropped = [];
  const seenDirs = new Set();
  const start = Date.now();
  let budgetExceeded = false;

  function walk(dir, depth) {
    if (budgetExceeded) return;
    if (Date.now() - start > budgetMs) {
      budgetExceeded = true;
      dropped.push({ path: dir, reason: "time budget exceeded" });
      return;
    }
    let realDir;
    try {
      realDir = realpathSync(dir);
    } catch {
      realDir = dir;
    }
    if (seenDirs.has(realDir)) return; // symlink cycle — silently done, not a drop
    seenDirs.add(realDir);

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      dropped.push({ path: dir, reason: `unreadable: ${err.message}` });
      return;
    }
    const subdirs = [];
    for (const e of entries) {
      const full = path.join(dir, e.name);
      let isDir = e.isDirectory();
      let isFile = e.isFile();
      if (e.isSymbolicLink()) {
        let st;
        try {
          st = statSync(full);
        } catch {
          continue; // broken symlink — not a finding here
        }
        isDir = st.isDirectory();
        isFile = st.isFile();
      }
      if (isFile && e.name.toLowerCase().endsWith(".md")) files.push(full);
      if (isDir) subdirs.push({ name: e.name, full });
    }
    if (depth >= maxDepth) {
      if (subdirs.length > 0) dropped.push({ path: dir, reason: `max depth ${maxDepth} reached — not walked further` });
      return;
    }
    for (const { name, full } of subdirs) {
      if (name.startsWith(".") || SKIP_DIR_NAMES.has(name)) continue;
      walk(full, depth + 1);
    }
  }

  walk(root, 0);
  return { files, dropped, budgetExceeded };
}

// ─────────────────────────────────────────────────────────────────────────────
// classifyPlan() — the ONE fork between in-repo (doc-kind) and external (path).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {string} absPath
 * @param {{external?: boolean}} [opts]
 * @returns {null | {kind:"plan", basenameDate: string|null}}
 */
export function classifyPlan(absPath, { external = false } = {}) {
  if (external) {
    // Path-based only. Measured: 0 of 54 session plans (`~/.claude/plans`,
    // `~/.gstack/projects/*/ceo-plans`) carry frontmatter, and their filenames
    // are fable-style slugs with no date in them at all — doc-kind's rule
    // would exclude every one of them. "Lives under a directory literally
    // named plans/" is the whole test; no directory is special-cased by name.
    const segs = absPath.split(path.sep);
    if (!segs.some((s) => s.toLowerCase() === "plans")) return null;
    return { kind: "plan", basenameDate: DATED.exec(path.basename(absPath))?.[0] ?? null };
  }
  const { kind } = kindOf(absPath);
  if (kind !== "plan") return null;
  return { kind: "plan", basenameDate: DATED.exec(path.basename(absPath))?.[0] ?? null };
}

/**
 * What the classifier excluded, and why — defect 1. Only meaningful for
 * in-repo corpora: an external root's classifier has no second condition to
 * exclude on (anything under `plans/` qualifies), so this always returns []
 * there, which IS the honest answer, not a narrowing.
 */
export function excludedFromPlanDirs(files, external = false) {
  if (external) return [];
  const out = [];
  for (const f of files) {
    const segs = f.split(path.sep);
    if (!segs.some((s) => s.toLowerCase() === "plans")) continue;
    if (classifyPlan(f, { external: false })) continue; // classified — not excluded
    const dated = DATED.test(path.basename(f));
    out.push({
      file: f,
      reason: dated
        ? "under a plans/ dir, dated basename, but doc-kind did not classify it as plan (frontmatter overrode it)"
        : "under a plans/ dir but its basename carries no YYYY-MM-DD date",
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Status: prose — a refinement, never the primary signal. See planState().
// ─────────────────────────────────────────────────────────────────────────────

// Scanned over the file HEAD only (first 3000 chars): every real example in
// this tree — `<!-- Written 2026-08-19. Status: ACTIVE. -->`, `**Status: done.**`,
// `Status: approved, not started.` — sits in the first few lines. Scanning the
// whole file would eventually match unrelated prose ("the HTTP status of...").
const STATUS_HEAD_CHARS = 3000;
// The colon is REQUIRED. Without it this matched ordinary prose containing the
// word "status" ("no status line here") and reported a phrase nobody wrote as
// a status declaration — worse than finding none, because a reader would
// trust it (rule:discernment-checks §6).
const STATUS_RE = /(?:^|[^A-Za-z])\*{0,2}Status\*{0,2}:\s*([^\n.]{1,80})/i;

/** The raw phrase after `Status:`, or null if the file states none. */
export function extractStatusPhrase(text) {
  const head = text.slice(0, STATUS_HEAD_CHARS);
  const m = STATUS_RE.exec(head);
  if (!m) return null;
  return m[1].replace(/\*+$/, "").replace(/-->$/, "").trim();
}

const FINISHED_WORDS = /\b(done|shipped|complete|completed|closed|landed|superseded|cancell?ed|merged)\b/i;
const LIVE_WORDS = /\b(active|in[- ]progress|ongoing|wip|proposed|drafting|approved)\b/i;

/** @returns {"finished"|"live"|null} null = present but not recognised vocabulary. */
export function classifyStatusPhrase(phrase) {
  if (!phrase) return null;
  if (FINISHED_WORDS.test(phrase)) return "finished";
  if (LIVE_WORDS.test(phrase)) return "live";
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// planState() — live / finished / undeclared, and the PRECEDENCE RULE.
//
//   1. under archive/ or _archive/         -> finished  (defect 2's axis — see
//                                              above: honestly reported even
//                                              when structurally always zero)
//   2. Status: names a FINISHED word        -> finished  (author's explicit word
//                                              overrides an ambiguous graph read)
//   3. hub-linked from ANY seed             -> live      (defect 3's fix — every
//                                              seed is tried, not seeds[0])
//   4. none of the above                    -> undeclared
//
// Status: is deliberately NOT consulted for "live" — a doc that says
// "Status: active" but that nothing links is still undeclared. The graph is
// primary for the live/undeclared axis; Status only ever pulls a doc INTO
// "finished", never out of "undeclared" into "live". This is the one line in
// this module a future edit is most likely to blur, which is why it is
// pinned by a test that asserts the SURPRISING direction: a hub-linked plan
// whose Status says "done" reports finished, not live.
// ─────────────────────────────────────────────────────────────────────────────

/** Try every seed, not just the first — defect 3. */
function hubLinked(root, abs, graph) {
  if (!graph?.seeds?.length) return false;
  return graph.seeds.some(
    (seed) => declaredState(root, abs, { hub: seed, nodes: graph.nodes }).state === "active",
  );
}

/** @returns {{state:"live"|"finished"|"undeclared", why:string}} */
export function planState(root, abs, graph, statusClass) {
  const archived = declaredState(root, abs, { hub: null, nodes: graph.nodes }).state === "archived";
  if (archived) return { state: "finished", why: "lives under archive/ or _archive/", finishedBy: "archive-dir" };
  if (statusClass === "finished") {
    return { state: "finished", why: "Status: names a finished word", finishedBy: "status" };
  }
  if (hubLinked(root, abs, graph)) {
    return { state: "live", why: "cited directly by a hub seed" };
  }
  return { state: "undeclared", why: "not archived, no finished Status:, not linked from any hub seed" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Goal-state grading — conforms / partial / flagged.
// ─────────────────────────────────────────────────────────────────────────────

const DONE_WHEN_RE = /^\s*\*{0,2}Done when:?\*{0,2}\s*:?/im;
const DERIVATION_RE = /^\s*\*{0,2}(?:Derived by|Judgement,?\s*not derivable):?\*{0,2}\s*:?/im;

/** @returns {"conforms"|"partial"|"flagged"} */
export function goalStateGrade(text) {
  const hasDoneWhen = DONE_WHEN_RE.test(text);
  const hasDerivation = DERIVATION_RE.test(text);
  if (hasDoneWhen && hasDerivation) return "conforms";
  if (hasDoneWhen && !hasDerivation) return "partial";
  // Neither, or a derivation with no arrival condition to derive — the latter
  // is still "nobody said what would finish this", so it is graded the same.
  return "flagged";
}

// ─────────────────────────────────────────────────────────────────────────────
// Authored date — basename first (free), evidence.mjs second (a git spawn,
// degrading to mtime, never throwing — same contract lastTouched already has).
// ─────────────────────────────────────────────────────────────────────────────

/** @returns {{date: string|null, source: "basename"|"git-introduced"|"mtime"|"unknown"}} */
export function authoredDate(root, abs, basenameDate) {
  if (basenameDate) return { date: basenameDate, source: "basename" };
  const intro = introducedBy(root, abs);
  if (intro.status === "ok" && intro.date) return { date: intro.date.slice(0, 10), source: "git-introduced" };
  const lt = lastTouched(root, abs);
  if (lt.status === "ok" && lt.date) {
    return { date: lt.date.slice(0, 10), source: lt.via === "git" ? "git-last-touched" : "mtime" };
  }
  // A repo with no git history and an unreadable mtime DEGRADES to unknown; it
  // must never be read as "no date, therefore pre-gate, therefore exempt" —
  // that would silently excuse a new plan from the very rule it is failing.
  return { date: null, source: "unknown" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Top-level — one root's derivation, and the multi-root combination.
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CFG = Object.freeze({
  entryPoints: ["STATE.md", "README.md", "CLAUDE.md", "AGENTS.md", "GEMINI.md", "TODOS.md", "SKILL.md"],
  hubSeeds: "auto",
  extraRoots: [],
  // readStatus() (curate-docs/lib/state.mjs) also recognises a bare directory
  // named archive/_archive as a status, same list as curate-docs' own DEFAULTS.
  archiveDirs: ["archive", "_archive"],
});

/**
 * Derive the full report for one root. Never throws — a per-file read failure
 * is reported as `unreadable`, never folded into a zero.
 *
 * @param {{path:string, external:boolean}} spec
 */
export function checkRoot(spec) {
  const { path: root, external } = spec;
  const validity = validateRoot(root);
  if (!validity.ok) return { root, external, ok: false, ...validity };

  const { files, dropped, budgetExceeded } = walkMarkdown(root);
  const classified = files
    .map((f) => ({ file: f, ...classifyPlan(f, { external }) }))
    .filter((c) => c.kind === "plan");
  const excluded = excludedFromPlanDirs(files, external);

  if (classified.length === 0) {
    return {
      root, external, ok: true, empty: true, scanned: files.length,
      dropped, budgetExceeded, excluded, plans: [],
    };
  }

  const graph = buildLinkGraph(root, { docs: files, cfg: DEFAULT_CFG });

  const plans = classified.map((c) => {
    let text = null;
    try {
      text = readFileSync(c.file, "utf8");
    } catch (err) {
      return { file: c.file, unreadable: true, reason: err.message };
    }
    const statusPhrase = extractStatusPhrase(text);
    const statusClass = classifyStatusPhrase(statusPhrase);
    const { state, why, finishedBy } = planState(root, c.file, graph, statusClass);
    const dated = authoredDate(root, c.file, c.basenameDate);
    const gated = dated.date !== null && dated.date >= TEMPLATE_LANDED;
    const grade = goalStateGrade(text);
    return {
      file: c.file, unreadable: false, state, why, finishedBy: finishedBy ?? null,
      statusPhrase, authoredDate: dated, gated, grade,
    };
  });

  return {
    root, external, ok: true, empty: false, scanned: files.length,
    dropped, budgetExceeded, excluded, hubReason: graph.hubReason, plans,
  };
}

/**
 * @param {Array<{path:string, external:boolean}>} roots
 */
export function checkPlans(roots) {
  return { generatedAt: new Date().toISOString(), results: roots.map(checkRoot) };
}

/**
 * Roll every root's plans into counts, by class — never one number
 * (`rule:discernment-checks` §5: comparing counts across incompatible axes is
 * the same mistake as comparing declared vs. expanded edges).
 */
export function planCounts(report) {
  const c = {
    roots: report.results.length,
    invalidRoots: 0,
    emptyRoots: 0,
    scanned: 0,
    excludedFromPlanDirs: 0,
    unreadable: 0,
    live: 0,
    finishedByArchiveDir: 0,
    finishedByStatus: 0,
    undeclared: 0,
    exempt: 0, // authored before TEMPLATE_LANDED
    dateUnknown: 0,
    conforms: 0,
    partial: 0,
    flagged: 0,
  };
  for (const r of report.results) {
    if (!r.ok) { c.invalidRoots += 1; continue; }
    if (r.empty) { c.emptyRoots += 1; continue; }
    c.scanned += r.scanned;
    c.excludedFromPlanDirs += r.excluded.length;
    for (const p of r.plans) {
      if (p.unreadable) { c.unreadable += 1; continue; }
      if (p.state === "live") c.live += 1;
      else if (p.state === "finished") {
        if (p.finishedBy === "archive-dir") c.finishedByArchiveDir += 1;
        else c.finishedByStatus += 1;
      } else c.undeclared += 1;

      if (p.authoredDate.date === null) { c.dateUnknown += 1; continue; }
      if (!p.gated) { c.exempt += 1; continue; }
      // Conformance is graded only for GATED plans — the whole point of the
      // date gate is that a plan predating the rule is not debt under it.
      if (p.grade === "conforms") c.conforms += 1;
      else if (p.grade === "partial") c.partial += 1;
      else c.flagged += 1;
    }
  }
  return c;
}
