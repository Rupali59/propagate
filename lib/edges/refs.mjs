/**
 * refs.mjs — the timeline coordinator for propagate v2.
 *
 * Three jobs, deliberately kept apart:
 *
 * 1. `enumerateRefs(repoRoot)` — what refs (branches + worktrees) exist for
 *    one repo, right now. Extends `lib/worktrees.mjs` (reuses its porcelain
 *    parser) rather than replacing it; that module stays the authority on
 *    worktree-path *expansion*, this one is the authority on ref
 *    *enumeration* for §3's per-side context.
 *
 * 2. `findLedgersUnder(rootDir)` — a RAW filesystem walk, deliberately NOT
 *    `lib/discovery.mjs`. `discoverWorkspacesSync`'s `listDirs` excludes
 *    every dot-directory before its named skip-list is even consulted
 *    (`lib/discovery.mjs:78`), and its `DEFAULT_MAX_DEPTH` is 2
 *    (`lib/discovery.mjs:52`). Together those mean
 *    `.claude/worktrees/<name>/docs/PROPAGATION_LEDGER.jsonl` can never be
 *    discovered — confirmed live at
 *    `PanditPawanKaushik/.claude/worktrees/client-answers-propagation/docs/PROPAGATION_LEDGER.jsonl`
 *    (79 rows, 1 open, invisible to `status`/`doctor`). This function makes
 *    that gap VISIBLE and ENUMERABLE. It does not fix discovery — the live
 *    launchd watcher (`com.tathya.propagate.watcher`) uses
 *    `discoverWorkspacesSync`'s output as-is, and widening it here would
 *    silently change what the running watcher watches (the N13 failure
 *    mode: a baseline gets rewritten out from under a live process). Fixing
 *    discovery is a separate, deliberate, supervised step.
 *
 *    The vocabulary (`discoverable` / `reason`) is the same idea as
 *    `lib/index-db.mjs`'s `coverage_gap: "found-by-sweep-not-discovery"`
 *    (`lib/index-db.mjs:469-472`) — a thing found by walking the disk that
 *    discovery's own walk never reached. This is that same gap, with the
 *    "why" broken out instead of folded into one flag.
 *
 * 3. `refsForEdge(sourceAbs, downstreamAbs)` — §3's per-side context. 35-37%
 *    of declared edges cross a repo boundary (measured 2026-08-13, plan
 *    §3/§3b), so "the state of this edge at ref R" is undefined for a third
 *    of the graph unless each side resolves independently. This is that
 *    resolution, built on (1).
 *
 * Failure discipline throughout (ISSUES.md N8 — worktree enumeration used
 * to swallow failure with a bare `catch { return []; }`, hiding it from
 * everything downstream): every git call here either returns cleanly or
 * reports its failure in the `error` field. Nothing here throws, and
 * nothing here silently returns empty on a REAL failure — only on the
 * genuinely-normal "no repo / no ref here" cases, which are distinguished
 * explicitly rather than inferred from a caught exception's message.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { parsePorcelain } from "../core/worktrees.mjs";
import { discoverWorkspacesSync, BACKUP_DIR_PREFIXES, isSkippedDir } from "../core/discovery.mjs";
import { findRepoRoot, getGitContext } from "../core/git-context.mjs";

const pExecFile = promisify(execFile);
const GIT_TIMEOUT_MS = 5000;

/**
 * One git runner for this module and for lib/refs/snapshot.mjs.
 *
 * Exported rather than copied: the registry needs a `git branch --merged`
 * spawn that cannot ride the for-each-ref enumeration, and a second private
 * runner would mean two timeout values and two error shapes for the same
 * operation. Same reasoning as the single GOTCHAS parser.
 */
export function runGit(repoRoot, args) {
  return pExecFile("git", ["-C", repoRoot, ...args], { timeout: GIT_TIMEOUT_MS });
}

/** True iff `dir` carries a `.git` entry (directory for a canonical repo,
 * file for a worktree gitfile pointer — both are valid repo markers per
 * `lib/worktrees.mjs`'s own topology doc). Pure fs check, no subprocess. */
function hasGitMarker(dir) {
  return existsSync(path.join(dir, ".git"));
}

function errMessage(err) {
  const raw = (err && (err.stderr || err.message)) || String(err);
  return String(raw).trim() || "git command failed with no message";
}

// ─────────────────────────────────────────────────────────────────────────
// 1. enumerateRefs
// ─────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} RefEntry
 * @property {string|null} ref - branch short name, or null (detached / not applicable) — never invented
 * @property {"branch"|"worktree"} kind
 * @property {string|null} path - worktree checkout path (worktree kind only; null for branch kind)
 * @property {string} head - full commit sha
 * @property {boolean} isCanonical - true for the main worktree (worktree kind only; false for branch kind)
 * @property {boolean} detached - true for a detached-HEAD worktree
 * @property {string} [upstreamTrack] - `%(upstream:track)`, branch kind only.
 *   PRESENT-BUT-EMPTY when there is no upstream; absent on worktree entries.
 *   `""` means asked-and-none, which is not the same as never-asked.
 * @property {string} [lastCommitIso] - `%(committerdate:iso-strict)`, branch kind only
 */

/**
 * Enumerate every ref (local branches + worktrees) for one repo.
 *
 * Three distinguishable outcomes, per the safety constraint:
 *   - `repoRoot` doesn't exist on disk         -> `{ refs: [], error: "<message>" }`
 *   - `repoRoot` exists but has no `.git`       -> `{ refs: [], error: null }`   (NORMAL — not a repo)
 *   - `repoRoot` has `.git` but a git call fails -> `{ refs: [], error: "<message>" }`
 *
 * The middle case is what lets bootstrap (plan §5's git stage) distinguish
 * "offer `git init`" from "something is actually broken here."
 *
 * @param {string} repoRoot
 * @returns {Promise<{refs: RefEntry[], error: string|null}>}
 */
export async function enumerateRefs(repoRoot) {
  if (!existsSync(repoRoot)) {
    return { refs: [], error: `path does not exist: ${repoRoot}` };
  }
  let isDir;
  try {
    isDir = statSync(repoRoot).isDirectory();
  } catch (err) {
    return { refs: [], error: errMessage(err) };
  }
  if (!isDir) {
    return { refs: [], error: `not a directory: ${repoRoot}` };
  }
  if (!hasGitMarker(repoRoot)) {
    // Normal answer: this is just a directory, not (yet) a git repo. This is
    // exactly the signal plan §5's bootstrap git stage needs to offer
    // `git init` rather than reporting a failure.
    return { refs: [], error: null };
  }

  const refs = [];

  // Worktrees — reuse worktrees.mjs's proven porcelain parser rather than
  // re-implementing it. We do NOT reuse enumerateWorktreesForRepo() itself:
  // that function's own bare `catch { return []; }` is ISSUES.md N8, the
  // exact silent-swallow this module exists to not repeat.
  try {
    const { stdout } = await runGit(repoRoot, ["worktree", "list", "--porcelain"]);
    const worktrees = parsePorcelain(stdout);
    if (worktrees.length > 0) worktrees[0].isCanonical = true;
    for (const wt of worktrees) {
      if (wt.isBare) continue; // no working tree, nothing to report as a ref
      refs.push({
        ref: wt.branch, // null when detached — never invented, per parsePorcelain
        kind: "worktree",
        path: wt.path,
        head: wt.commit,
        isCanonical: Boolean(wt.isCanonical),
        detached: wt.branch === null,
      });
    }
  } catch (err) {
    return { refs: [], error: errMessage(err) };
  }

  // Local branches — independent of whether they're checked out anywhere.
  try {
    // Four fields, one spawn. `upstream:track` and `committerdate:iso-strict`
    // are real for-each-ref atoms and cost nothing on top of the enumeration
    // that already runs.
    //
    // TWO FIELDS THE BRANCH REGISTRY WANTS ARE NOT HERE, deliberately:
    //   merge_state    — `%(merged)` and `%(merge_state)` are BOTH
    //                    `fatal: unknown field name`. Verified against git, not
    //                    assumed. It needs `--merged <base>` as a FILTER, i.e.
    //                    its own spawn, and is bought by the caller that wants
    //                    it rather than charged to every caller here.
    //   is_active_line — not a git fact at all; it comes from `[active_lines]`
    //                    config. Inventing it from git would be guessing.
    //
    // The v3 plan doc said all four came free "at zero extra spawns". They do
    // not, and a comment repeating that would be the claim outliving the check.
    const { stdout } = await runGit(repoRoot, [
      "for-each-ref",
      "--format=%(refname:short)%09%(objectname)%09%(upstream:track)%09%(committerdate:iso-strict)",
      "refs/heads/",
    ]);
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Split on tabs, not indexOf, now that there are four columns. Trailing
      // columns can be EMPTY (a branch with no upstream yields ""), so a
      // missing field must read as "" and never collapse the column count.
      const cols = trimmed.split("\t");
      if (cols.length < 2) continue; // malformed line, skip rather than misparse
      const [name, sha] = cols;
      if (!name || !sha) continue;
      refs.push({
        ref: name,
        kind: "branch",
        path: null,
        head: sha,
        isCanonical: false, // not applicable to a bare branch entry
        detached: false,
        // Present-but-empty when git has nothing to say. `""` means "asked, no
        // upstream"; an absent key would mean "never asked" and the registry
        // must be able to tell those apart.
        upstreamTrack: cols[2] ?? "",
        lastCommitIso: cols[3] ?? "",
      });
    }
  } catch (err) {
    return { refs: [], error: errMessage(err) };
  }

  return { refs, error: null };
}

// ─────────────────────────────────────────────────────────────────────────
// 2. findLedgersUnder — raw walk, deliberately not discovery
// ─────────────────────────────────────────────────────────────────────────

const LEDGER_FILENAMES = new Set(["PROPAGATION_LEDGER.jsonl", "ledger.jsonl"]);

// Mirrors the NAMED entries of lib/discovery.mjs's SKIP_DIR_NAMES
// (lib/discovery.mjs:54-68) — heavy, never-a-ledger directories it is
// still correct to skip for performance. Kept as a local copy rather than
// importing the unexported constant (see module header: we must not edit
// discovery.mjs, and its constant isn't exported). If discovery's list
// drifts from this one, the failure mode is "we walk a few extra heavy
// dirs" — never "we miss a ledger", because unlike discovery.mjs this list
// does NOT blanket-exclude dot-directories. `.git` is skipped by exact
// name match here (huge, never contains a ledger), not by a dot-prefix
// rule that would also swallow `.claude`.
// Skip list: ONE declaration, in lib/discovery.mjs. This file used to keep its own
// copy and the two had already diverged (see BACKUP_DIR_PREFIXES there for what and
// why). Re-exported rather than re-listed so the divergence cannot recur.
export { BACKUP_DIR_PREFIXES };

const HEAVY_SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  ".turbo",
  ".vercel",
  "Library",
  "Trash",
]);

// Deep enough to reach `.claude/worktrees/<name>/docs/PROPAGATION_LEDGER.jsonl`
// from a workspace hub root: hub(0) -> PanditPawanKaushik(1) -> .claude(2)
// -> worktrees(3) -> <name>(4) -> docs(5) -> file. 8 leaves headroom for one
// extra level of nesting without needing to be re-tuned per topology.
const DEFAULT_LEDGER_WALK_DEPTH = 8;

// Local copy of lib/discovery.mjs:52's DEFAULT_MAX_DEPTH, used only to
// explain (not to reproduce) why a ledger discovery misses. See the same
// import-vs-copy rationale as HEAVY_SKIP_DIR_NAMES above.
const DISCOVERY_DEFAULT_MAX_DEPTH = 2;

function walkForLedgers(dir, depth, maxDepth, results) {
  if (depth > maxDepth) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable dir — skip, don't crash the walk
  }
  for (const entry of entries) {
    if (entry.isFile()) {
      if (LEDGER_FILENAMES.has(entry.name)) {
        results.push(path.join(dir, entry.name));
      }
      continue;
    }
    if (!entry.isDirectory()) continue;
    // Deliberately NO `!entry.name.startsWith(".")` filter here — that
    // blanket exclusion is exactly discovery.mjs's blind spot (see module
    // header). Only the named heavy dirs are skipped.
    if (HEAVY_SKIP_DIR_NAMES.has(entry.name) || isSkippedDir(entry.name)) continue;
    walkForLedgers(path.join(dir, entry.name), depth + 1, maxDepth, results);
  }
}

/**
 * Explain why a ledger found by the raw walk is NOT discoverable, given the
 * three-way vocabulary this task specifies. Priority: a dot-directory
 * anywhere in the path is an absolute block regardless of depth, so it's
 * checked first; then depth; `no-workspace-marker` is the residual case
 * (structurally reachable, but no `.propagates.yml` with `workspace: true`
 * sits at the workspace root discovery would need).
 *
 * @param {string} ledgerPath - absolute, already resolved
 * @param {string} rootDir - absolute, already resolved; the same root findLedgersUnder was called with
 * @returns {"dot-directory"|"depth"|"no-workspace-marker"}
 */
function explainUndiscoverable(ledgerPath, rootDir) {
  // The workspace root is the marker directory. Ledger layout is always
  // <root>/docs/PROPAGATION_LEDGER.jsonl or <root>/.propagation/ledger.jsonl
  // (see lib/discovery.mjs's makeWorkspaceRecord) — both are two path
  // segments below the workspace root.
  const wsRoot = path.dirname(path.dirname(ledgerPath));
  const relParts = path
    .relative(rootDir, wsRoot)
    .split(path.sep)
    .filter(Boolean);

  if (relParts.some((seg) => seg.startsWith("."))) return "dot-directory";
  if (relParts.length > DISCOVERY_DEFAULT_MAX_DEPTH) return "depth";
  return "no-workspace-marker";
}

/**
 * @typedef {Object} LedgerFinding
 * @property {string} path - absolute path to the ledger file found on disk
 * @property {boolean} discoverable - would `discoverWorkspacesSync` (called READ-ONLY) find this?
 * @property {"dot-directory"|"depth"|"no-workspace-marker"|null} reason - null when discoverable
 */

/**
 * Raw filesystem walk for ledger files under `rootDir`, INCLUDING
 * dot-directories, deep enough to reach a nested worktree's ledger. For
 * each one found, calls `discoverWorkspacesSync` (imported read-only —
 * never mutated, never used to change discovery's own behaviour) to check
 * whether the running watcher's discovery would actually see it, and if
 * not, explains why.
 *
 * @param {string} rootDir
 * @param {{maxDepth?: number}} [opts]
 * @returns {LedgerFinding[]}
 */
export function findLedgersUnder(rootDir, opts = {}) {
  const maxDepth = opts.maxDepth ?? DEFAULT_LEDGER_WALK_DEPTH;
  const resolvedRoot = path.resolve(rootDir);

  const foundPaths = [];
  if (existsSync(resolvedRoot)) {
    walkForLedgers(resolvedRoot, 0, maxDepth, foundPaths);
  }

  // Ground truth, read-only: what discovery would actually find from this
  // same root. This is a call, never an edit — lib/discovery.mjs stays
  // untouched, and this never feeds back into the watcher's own state.
  const discovery = discoverWorkspacesSync([resolvedRoot]);
  const discoveredLedgerPaths = new Set(
    discovery.workspaces.map((w) => path.resolve(w.ledgerJsonl)),
  );

  return foundPaths.map((p) => {
    const resolved = path.resolve(p);
    const discoverable = discoveredLedgerPaths.has(resolved);
    return {
      path: resolved,
      discoverable,
      reason: discoverable ? null : explainUndiscoverable(resolved, resolvedRoot),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────
// 3. refsForEdge — per-side context (plan §3)
// ─────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} EdgeSide
 * @property {string} path - the absolute path passed in
 * @property {string|null} repoRoot - null if `path` isn't inside any git repo
 * @property {string|null} ref - current branch, or null (detached / no repo) — never invented
 * @property {string|null} head - current HEAD sha, or null
 * @property {boolean} detached - true iff inside a repo with a detached HEAD
 * @property {import("./refs.mjs").RefEntry[]} refs - full ref enumeration for this side's repo (empty if no repo)
 * @property {string|null} error - non-null iff a git call for THIS side genuinely failed
 */

async function resolveSide(absPath) {
  const repoRoot = findRepoRoot(absPath);
  if (!repoRoot) {
    // Legitimately outside any repo (e.g. a workspace-root doc) — the same
    // "normal, not an error" case getGitContext already treats this way.
    return {
      path: absPath,
      repoRoot: null,
      ref: null,
      head: null,
      detached: false,
      refs: [],
      error: null,
    };
  }

  const { context, error: ctxError } = getGitContext(absPath);
  const { refs, error: refsError } = await enumerateRefs(repoRoot);

  return {
    path: absPath,
    repoRoot,
    ref: context ? context.branch : null, // null for detached OR a context failure — never guessed
    head: context ? context.sha : null,
    detached: context ? context.branch === null : false,
    refs,
    error: refsError || ctxError || null,
  };
}

/**
 * Resolve both sides of a declared edge independently. Plan §3: 35-37% of
 * edges cross a repo boundary, so each side genuinely has its own ref set —
 * this never assumes a shared ref, and `sameRepo` is the caller's signal
 * for whether "the same ref on both sides" is even a meaningful question.
 *
 * @param {string} sourceAbs
 * @param {string} downstreamAbs
 * @returns {Promise<{source: EdgeSide, downstream: EdgeSide, sameRepo: boolean}>}
 */
export async function refsForEdge(sourceAbs, downstreamAbs) {
  const [source, downstream] = await Promise.all([
    resolveSide(sourceAbs),
    resolveSide(downstreamAbs),
  ]);
  const sameRepo = Boolean(
    source.repoRoot && downstream.repoRoot && source.repoRoot === downstream.repoRoot,
  );
  return { source, downstream, sameRepo };
}
