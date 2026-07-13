/**
 * Worktree enumeration + path expansion.
 *
 * Why this exists
 * ---------------
 * Sidecars declare canonical paths like `../VipinKaushik/lib/pricing.ts`. When
 * a repo has multiple git worktrees (canonical + secondary worktrees from
 * `git worktree add`), edits in non-canonical worktrees are invisible to the
 * watcher unless we expand the canonical path to all worktree-equivalents.
 *
 * Topology this handles
 * ---------------------
 *   workspace_root/
 *   ├── VipinKaushik/             ← canonical (.git is a directory)
 *   │   └── lib/pricing.ts
 *   ├── VipinKaushik-location-shape/   ← sibling worktree (.git is a file)
 *   │   └── lib/pricing.ts
 *   ├── VipinKaushik-mb/          ← canonical (.git is a directory)
 *   │   ├── lib/pricing.ts
 *   │   └── .worktrees/
 *   │       └── real-sky/         ← nested worktree (.git is a file)
 *   │           └── lib/pricing.ts
 *   └── astroacharya-thirty-muhurtas/  ← sibling worktree of astroacharya/
 *
 * Two-pass enumeration
 * --------------------
 * Pass 1 — readdir(workspaceRoot), find direct-child dirs whose `.git` is
 *          a DIRECTORY (not a file). Those are CANONICAL repos. Secondary
 *          worktrees have `.git` as a FILE (gitfile pointer) and are
 *          discovered in pass 2 via the canonical's worktree list.
 * Pass 2 — For each canonical, run `git -C <canonical> worktree list
 *          --porcelain`. Includes canonical itself + all secondary
 *          worktrees (sibling or nested).
 *
 * Cache lifetime
 * --------------
 * One full enumeration per watcher.mjs invocation, passed by reference into
 * processChange / processCodeCanonical. Each launchd-spawned watcher run is a
 * fresh process; "cache" here means "compute once per fire", not across fires.
 *
 * Adversarial review fixes baked in
 * ---------------------------------
 * - S4: execFile with `-C repoRoot`, never relying on cwd
 * - S5: two-pass enumeration since workspace root is not itself a repo
 * - C2: longest-prefix resolver for canonicalPath → repo
 * - N1: detached HEAD parsed as `branch=null, commit=<sha>`
 * - Error envelope: every git call try/catched; failures return empty
 */

import { readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pExecFile = promisify(execFile);

/**
 * @typedef {Object} Worktree
 * @property {string} path - absolute path to the worktree root
 * @property {string|null} branch - "refs/heads/foo" simplified to "foo", or null when detached
 * @property {string} commit - full HEAD SHA
 * @property {boolean} isCanonical - true for the canonical (main) worktree
 * @property {boolean} isLocked - true if the worktree is locked (rare)
 * @property {boolean} isBare - true for bare-repo worktrees (rare; usually filtered out)
 */

/**
 * @typedef {Map<string, Worktree[]>} WorktreeMap
 *   Keyed by canonical repo absolute path. Values include the canonical
 *   itself as the first entry plus every secondary worktree.
 */

/**
 * Pass 1: find direct-child dirs of `workspaceRoot` whose `.git` is a
 * directory (canonical repos). Skips dirs whose `.git` is a file (those
 * are secondary worktrees pointing back at a canonical we'll find via
 * pass 2 anyway).
 *
 * @param {string} workspaceRoot
 * @returns {Promise<string[]>} absolute paths of canonical repo roots
 */
export async function enumerateCanonicalRepos(workspaceRoot) {
  if (!existsSync(workspaceRoot)) return [];
  let entries;
  try {
    entries = await readdir(workspaceRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const canonicals = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;
    const dotGit = path.join(workspaceRoot, entry.name, ".git");
    try {
      const s = await stat(dotGit);
      if (s.isDirectory()) {
        canonicals.push(path.join(workspaceRoot, entry.name));
      }
      // else: .git is a file (gitfile pointer) → secondary worktree, skip
    } catch {
      // no .git here, skip
    }
  }
  return canonicals.sort();
}

/**
 * Parse one `git worktree list --porcelain` stdout into Worktree records.
 *
 * Porcelain format (one record per worktree, blank line between):
 *   worktree /abs/path
 *   HEAD <full-sha>
 *   branch refs/heads/<branchname>           ← OR
 *   detached                                  ← exclusive with branch
 *   locked [optional <reason>]                ← optional
 *   bare                                      ← optional, for bare repos
 *
 * @param {string} stdout
 * @returns {Worktree[]}
 */
export function parsePorcelain(stdout) {
  const worktrees = [];
  let current = null;
  const flush = () => {
    if (current && current.path) worktrees.push(current);
    current = null;
  };
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trimEnd();
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith("worktree ")) {
      flush();
      current = {
        path: line.slice("worktree ".length),
        branch: null,
        commit: "",
        isCanonical: false, // set later by caller
        isLocked: false,
        isBare: false,
      };
    } else if (current && line.startsWith("HEAD ")) {
      current.commit = line.slice("HEAD ".length);
    } else if (current && line.startsWith("branch ")) {
      const ref = line.slice("branch ".length);
      // Strip refs/heads/ prefix for display; keep null for detached.
      current.branch = ref.startsWith("refs/heads/")
        ? ref.slice("refs/heads/".length)
        : ref;
    } else if (current && line === "detached") {
      current.branch = null;
    } else if (current && line.startsWith("locked")) {
      current.isLocked = true;
    } else if (current && line === "bare") {
      current.isBare = true;
    }
    // Unknown lines (future porcelain extensions) ignored — graceful.
  }
  flush();
  return worktrees;
}

/**
 * Pass 2: for one canonical repo, run `git worktree list --porcelain` and
 * return all its worktrees. First entry is marked canonical.
 *
 * Error envelope: any failure (git not on PATH, repo corrupt, porcelain
 * format unexpected) returns []. The watcher falls back to canonical-only
 * behaviour, which is identical to pre-T2.
 *
 * @param {string} canonicalRepoRoot
 * @returns {Promise<Worktree[]>}
 */
export async function enumerateWorktreesForRepo(canonicalRepoRoot) {
  let stdout;
  try {
    const result = await pExecFile(
      "git",
      ["-C", canonicalRepoRoot, "worktree", "list", "--porcelain"],
      { timeout: 5000 },
    );
    stdout = result.stdout;
  } catch {
    return [];
  }
  const worktrees = parsePorcelain(stdout);
  // The first record in porcelain output is always the canonical (per
  // git-worktree(1) — "the main worktree is listed first").
  if (worktrees.length > 0) worktrees[0].isCanonical = true;
  // Filter bare worktrees — they have no working tree, so no files to expand.
  return worktrees.filter((w) => !w.isBare);
}

/**
 * Public entry: enumerate all worktrees across all canonical repos under
 * `workspaceRoot`. Returns a map keyed by canonical repo path.
 *
 * @param {string} workspaceRoot
 * @returns {Promise<WorktreeMap>}
 */
export async function enumerateWorktrees(workspaceRoot) {
  const canonicals = await enumerateCanonicalRepos(workspaceRoot);
  const map = new Map();
  // Sequential rather than parallel: 5-10 repos at ~10ms each = ~50-100ms
  // total. Parallelism saves ~70ms but adds error-handling complexity.
  for (const canonical of canonicals) {
    const worktrees = await enumerateWorktreesForRepo(canonical);
    if (worktrees.length > 0) map.set(canonical, worktrees);
  }
  return map;
}

/**
 * Given an absolute canonical path (e.g. ".../VipinKaushik/lib/pricing.ts"),
 * find the repo that owns it via longest-prefix match against map keys,
 * then expand to all worktree-equivalents that have the file on disk.
 *
 * Returns [canonicalPath] (unchanged) if:
 *   - the path isn't inside any known repo (orphan file, workspace doc, etc.)
 *   - the repo has only the canonical worktree
 *
 * The returned list is in deterministic order: canonical first, then
 * secondary worktrees sorted by path. Missing-file siblings are filtered
 * (see S2 — bootstrap seed handles the inverse direction).
 *
 * @param {string} canonicalPath - absolute path, already resolved
 * @param {WorktreeMap} map
 * @returns {{path: string, worktree: Worktree}[]}
 *   Empty array if canonicalPath doesn't exist anywhere.
 */
export function expandWorktreePaths(canonicalPath, map) {
  // Longest-prefix match. Sort repo keys by length descending so that
  // /a/b/c-extension matches its OWN entry before /a/b/c.
  const candidates = [...map.keys()].sort((a, b) => b.length - a.length);
  let matchedRepo = null;
  for (const repoRoot of candidates) {
    if (
      canonicalPath === repoRoot ||
      canonicalPath.startsWith(repoRoot + path.sep)
    ) {
      matchedRepo = repoRoot;
      break;
    }
  }
  if (!matchedRepo) {
    // Not inside any tracked repo — return as-is (likely workspace doc).
    return existsSync(canonicalPath)
      ? [{ path: canonicalPath, worktree: null }]
      : [];
  }
  const worktrees = map.get(matchedRepo) || [];
  const relativeFromRepo = canonicalPath.slice(matchedRepo.length + 1);
  const expanded = [];
  for (const wt of worktrees) {
    const candidatePath =
      relativeFromRepo === ""
        ? wt.path
        : path.join(wt.path, relativeFromRepo);
    if (existsSync(candidatePath)) {
      expanded.push({ path: candidatePath, worktree: wt });
    }
    // Missing file in sibling worktree (e.g. file added on canonical's
    // branch only) is silently filtered. The bootstrap seed in T4 handles
    // the inverse — recording sibling-only mtimes without firing drift.
  }
  return expanded;
}

/**
 * Helper: given a worktree, return the ledger-friendly object describing
 * which branch/commit produced an edit. `null` for the canonical so older
 * row-readers don't see a redundant field.
 *
 * @param {Worktree | null} worktree
 * @returns {{branch: string|null, commit: string}|undefined}
 */
export function worktreeStamp(worktree) {
  if (!worktree || worktree.isCanonical) return undefined;
  return {
    branch: worktree.branch, // null when detached
    commit: worktree.commit.slice(0, 12),
  };
}

/**
 * Helper: derive the canonical-repo-relative path for a file. Used to
 * generate `correlation_id` so drain can dedupe rows that target the
 * same logical file across worktrees.
 *
 * @param {string} absolutePath
 * @param {WorktreeMap} map
 * @returns {string|null} canonical relative path, or null if no match
 */
export function correlationKey(absolutePath, map) {
  // Longest-prefix match across ALL worktree paths globally. Canonical's
  // path is often a PREFIX of a nested worktree's path (e.g. VipinKaushik-mb
  // and VipinKaushik-mb/.worktrees/real-sky), so iterating in declaration
  // order would always match canonical first and produce the wrong key.
  // Sort by path length descending → most specific wins.
  let bestWt = null;
  let bestRepo = null;
  for (const [repoRoot, worktrees] of map.entries()) {
    for (const wt of worktrees) {
      const matches =
        absolutePath === wt.path ||
        absolutePath.startsWith(wt.path + path.sep);
      if (!matches) continue;
      if (!bestWt || wt.path.length > bestWt.path.length) {
        bestWt = wt;
        bestRepo = repoRoot;
      }
    }
  }
  if (!bestWt) return null;
  const rel = absolutePath.slice(bestWt.path.length + 1) || ".";
  return `${path.basename(bestRepo)}:${rel}`;
}
