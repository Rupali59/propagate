/**
 * bootstrap.mjs — turns NEVER_VERIFIED edges into an honest starting
 * position (propagate v2 Phase 4c).
 *
 * See /Users/rupali.b/.claude/plans/jolly-waddling-sphinx.md Part 1 (the
 * approved plan for this file) and
 * /Users/rupali.b/.claude/plans/okay-i-dont-think-logical-haven.md §5
 * (bootstrapping methodology), §5b (measured 31% coverage), §4
 * (dispositions).
 *
 * Two stages, deliberately kept apart:
 *
 *   1. `gitStage()` — git setup, explicit and FIRST. The model depends on
 *      git for timelines, so bootstrap owns git setup rather than assuming
 *      it: not-a-repo is offered `git init` (never run unprompted; `apply`
 *      may run it) and states plainly that without git there are no refs
 *      and the ref lens does not apply. Reuses `enumerateRefs`
 *      (lib/refs.mjs) rather than re-parsing `git worktree list`/branches.
 *
 *   2. `planBaseline()` / `applyBaseline()` — co-commit evidence baselining
 *      (§2/§3). An edge whose source and downstream were last touched in
 *      the SAME commit is evidence they were consistent then; that becomes
 *      a `baselined` event whose `reason` names the SHA. Batched per repo
 *      (§2's non-negotiable, not an optimisation) — ONE `git log
 *      --name-only` walk per repo, intersected against every same-repo edge
 *      in memory, never one git spawn per edge (the spike's ~1,860 spawns /
 *      17.2s failure mode this exists to avoid).
 *
 * A baseline is a CLAIM, not a verification (§3 — the entire lesson of v1's
 * three silent seeds). Every write goes through lib/events.mjs's
 * `appendEvent`, which already refuses a `baselined` event with no `reason`
 * — that validation is NOT re-implemented here (GOTCHAS G20: let it throw).
 * The disposition recorded is always literally `"baselined"`, never
 * `"verified"` — there is no such disposition in this codebase, by design.
 */

import path from "node:path";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

import { enumerateRefs } from "./refs.mjs";
import { resolveRepo } from "./content-id.mjs";
import { appendEvent } from "./events.mjs";
import { resolveProvenance } from "./provenance.mjs";

const GIT_TIMEOUT_MS = 5000;
const GIT_MAX_BUFFER = 1024 * 1024 * 64;

/** Default co-commit walk depth (plan §2: "bound the walk at 400 commits
 * (configurable via an option)"). */
export const DEFAULT_WALK_COMMITS = 400;

export const BASELINE_POLICIES = Object.freeze(["baseline-from-git", "baseline-all", "none"]);

// ─────────────────────────────────────────────────────────────────────────
// git spawn accounting — scoped to THIS module's git calls (the co-commit
// batching stage + git-init offers), so tests can assert an O(repos), not
// O(edges), spawn count without timing (plan TESTS #10; G6: "assert it with
// an injected spawn counter, never with timing"). `enumerateRefs`
// (lib/refs.mjs) has its own independent git calls, uncounted here — this
// counter answers exactly the claim §2 makes about the baseline walk.
// ─────────────────────────────────────────────────────────────────────────
let __spawnCount = 0;

function execGit(args, opts = {}) {
  __spawnCount++;
  return execFileSync("git", args, {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
    encoding: "utf8",
    ...opts,
  });
}

/** Test hook: current count of git subprocess spawns since process start (or last reset). */
export function __getSpawnCountForTests() {
  return __spawnCount;
}

/** Test hook: zero the spawn counter. */
export function __resetSpawnCountForTests() {
  __spawnCount = 0;
}

// ─────────────────────────────────────────────────────────────────────────
// 1. THE GIT STAGE — explicit and first.
// ─────────────────────────────────────────────────────────────────────────

/**
 * True iff `dir` carries a `.git` entry (directory for a canonical repo,
 * file for a worktree gitfile pointer). Same check as lib/refs.mjs's
 * (unexported) `hasGitMarker`, duplicated rather than imported — refs.mjs's
 * internals stay refs.mjs's; `enumerateRefs` is this file's one dependency
 * on it, matching lib/content-id.mjs's precedent of duplicating
 * `resolveRepo`'s walk rather than reaching into a module another lane owns.
 */
function hasGitMarker(dir) {
  return existsSync(path.join(dir, ".git"));
}

/**
 * @typedef {Object} GitStageEntry
 * @property {string} root
 * @property {boolean} existedAsRepoBefore
 * @property {boolean} isRepoNow
 * @property {boolean} created - true iff bootstrap ran `git init` here this call (apply only)
 * @property {string|null} offeredInitCommand - non-null whenever this root is not (yet) a repo
 * @property {string|null} initError
 * @property {number} branches
 * @property {number} worktrees
 * @property {string|null} refsError
 */

/**
 * Git setup, owned by bootstrap rather than assumed. For each workspace
 * root:
 *   - no `.git` -> OFFER `git init` (the command is always returned in
 *     `offeredInitCommand`, printed by the caller); with `opts.apply` it is
 *     actually run. Never runs unprompted otherwise — dry-run is the
 *     default posture for the whole command, and this is no exception.
 *   - `.git` present (already, or just created) -> `enumerateRefs()` for
 *     branch/worktree counts, so the report can say what git state existed
 *     versus what this run created.
 *
 * Never throws. A git failure surfaces in `initError`/`refsError` — the
 * exact discipline lib/refs.mjs's own module doc requires of every caller
 * built on it ("nothing here throws, and nothing here silently returns
 * empty on a REAL failure").
 *
 * @param {{root: string}[]} workspaces
 * @param {{apply?: boolean}} [opts]
 * @returns {Promise<GitStageEntry[]>}
 */
export async function gitStage(workspaces, opts = {}) {
  const apply = Boolean(opts.apply);
  const entries = [];

  for (const ws of workspaces) {
    const root = ws.root;
    const existedAsRepoBefore = hasGitMarker(root);
    let created = false;
    let initError = null;

    if (!existedAsRepoBefore && apply) {
      try {
        execGit(["init", "-q", "-b", "main", root]);
        created = hasGitMarker(root);
      } catch (err) {
        initError = (err && (err.stderr?.toString?.() || err.message)) || String(err);
      }
    }

    const isRepoNow = hasGitMarker(root);
    let branches = 0;
    let worktrees = 0;
    let refsError = null;

    if (isRepoNow) {
      const { refs, error } = await enumerateRefs(root);
      refsError = error;
      branches = refs.filter((r) => r.kind === "branch").length;
      worktrees = refs.filter((r) => r.kind === "worktree").length;
    }

    entries.push({
      root,
      existedAsRepoBefore,
      isRepoNow,
      created,
      // Offered regardless of whether apply just created it: a reader
      // scanning this array for "what would running this again do" gets a
      // consistent answer, and when isRepoNow is now true this field simply
      // reads null (see below) — no separate "created" branch to remember.
      offeredInitCommand: isRepoNow ? null : `git init "${root}"`,
      initError,
      branches,
      worktrees,
      refsError,
    });
  }

  return entries;
}

// ─────────────────────────────────────────────────────────────────────────
// 2. BASELINE FROM CO-COMMIT EVIDENCE — batched per repo (§2, non-negotiable).
// ─────────────────────────────────────────────────────────────────────────

/**
 * ONE `git log --format=%H --name-only -<bound>` walk per repo, plus one
 * `git rev-list --count HEAD` to know whether the walk was truncated —
 * without this, an edge whose co-commit predates the window is
 * indistinguishable from one that never had a co-commit, which is exactly
 * the G2 ambiguity ("no result" vs "no result BECAUSE —") this file exists
 * to not repeat. Never spawns git again per edge; every edge in this repo
 * intersects in memory against the SAME two calls.
 *
 * @param {string} repoRoot
 * @param {number} [bound]
 * @returns {{commits: string[], fileMap: Map<string, Set<string>>, totalCommits: number, truncated: boolean}}
 */
export function buildCommitFileMap(repoRoot, bound = DEFAULT_WALK_COMMITS) {
  let out = "";
  try {
    out = execGit(["-C", repoRoot, "log", "--format=%H", "--name-only", `-${bound}`]);
  } catch {
    // A repo with zero commits (freshly `git init`'d, nothing committed
    // yet) fails `git log` the same way a genuinely broken repo would --
    // both degrade to "no evidence available", never a throw.
    return { commits: [], fileMap: new Map(), totalCommits: 0, truncated: false };
  }

  const commits = [];
  const fileMap = new Map();
  let current = null;
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    if (/^[0-9a-f]{40}$/.test(line.trim())) {
      current = line.trim();
      commits.push(current);
      fileMap.set(current, new Set());
    } else if (current) {
      fileMap.get(current).add(line);
    }
  }

  let totalCommits = commits.length;
  try {
    const countOut = execGit(["-C", repoRoot, "rev-list", "--count", "HEAD"]).trim();
    const parsed = parseInt(countOut, 10);
    if (Number.isFinite(parsed)) totalCommits = parsed;
  } catch {
    // Leave totalCommits at commits.length -- a failed count must not
    // fabricate "definitely not truncated" (G2: absence needs a reason,
    // not a guessed favorable default).
  }

  return { commits, fileMap, totalCommits, truncated: totalCommits > commits.length };
}

/**
 * The most recent commit (per `git log`'s own newest-first order) in which
 * BOTH relative paths appear together, or null.
 *
 * @param {ReturnType<typeof buildCommitFileMap>} repoMap
 * @param {string} srcRelPath
 * @param {string} dstRelPath
 * @returns {string|null}
 */
export function findCoCommit(repoMap, srcRelPath, dstRelPath) {
  for (const sha of repoMap.commits) {
    const files = repoMap.fileMap.get(sha);
    if (files && files.has(srcRelPath) && files.has(dstRelPath)) return sha;
  }
  return null;
}

/**
 * @typedef {Object} BaselineOutcomes
 * @property {Array<{row: object, reason: string}>} baselined
 * @property {Array<object>} noCoCommit
 * @property {Array<object>} boundReached
 * @property {Array<object>} ineligibleCrossRepo
 */

/**
 * Classify every NEVER_VERIFIED row under one of §5's three policies. Pure
 * with respect to the caller (no writes); the only I/O is the batched git
 * walk this triggers once per repo under `baseline-from-git`, never per
 * row. `--none` and `--baseline-all` never touch git at all.
 *
 * Already-verified rows (CLEAN/DRIFTED/REVERSED/DIVERGED/…) are left alone
 * — bootstrap only ever acts on the NEVER_VERIFIED set, matching plan §5.4
 * ("Reconcile -> everything NEVER_VERIFIED. This is true.") as the premise
 * this function classifies against.
 *
 * @param {Array} rows - reconcile()'s output rows
 * @param {"baseline-from-git"|"baseline-all"|"none"} policy
 * @param {{bound?: number}} [opts]
 * @returns {{outcomes: BaselineOutcomes, neverVerifiedCount: number}}
 */
export function planBaseline(rows, policy, opts = {}) {
  const bound = opts.bound ?? DEFAULT_WALK_COMMITS;
  const outcomes = { baselined: [], noCoCommit: [], boundReached: [], ineligibleCrossRepo: [] };
  const neverVerified = rows.filter((r) => r.state === "NEVER_VERIFIED");

  if (policy === "none") {
    return { outcomes, neverVerifiedCount: neverVerified.length };
  }

  if (policy === "baseline-all") {
    for (const row of neverVerified) {
      outcomes.baselined.push({
        row,
        reason: "baseline-all: asserted consistent now, without inspection (bootstrap --baseline-all)",
      });
    }
    return { outcomes, neverVerifiedCount: neverVerified.length };
  }

  if (policy !== "baseline-from-git") {
    throw new Error(
      `planBaseline: unknown policy ${JSON.stringify(policy)}; must be one of ${BASELINE_POLICIES.join(" | ")}`,
    );
  }

  // Only same-repo edges are eligible — a cross-repo edge CANNOT have a
  // shared commit by construction (two independent histories), so it is
  // reported as its own outcome, never folded into "no-co-commit" (which
  // would misreport "we looked and found nothing" for an edge that was
  // never eligible to be looked at this way).
  const byRepo = new Map(); // repoRoot -> rows[]
  for (const row of neverVerified) {
    if (!row.sameRepo) {
      outcomes.ineligibleCrossRepo.push(row);
      continue;
    }
    const repoRoot = resolveRepo(row.source.path);
    if (!repoRoot) {
      // row.sameRepo true implies reconcile resolved both sides to the same
      // non-null repo when it ran; null here means the repo vanished
      // between reconcile and this classification (e.g. deleted mid-run).
      // Report rather than silently drop (G2) -- closest honest bucket is
      // "no evidence found", since there is nothing left to walk.
      outcomes.noCoCommit.push(row);
      continue;
    }
    if (!byRepo.has(repoRoot)) byRepo.set(repoRoot, []);
    byRepo.get(repoRoot).push(row);
  }

  for (const [repoRoot, repoRows] of byRepo) {
    const repoMap = buildCommitFileMap(repoRoot, bound);
    for (const row of repoRows) {
      const srcRel = path.relative(repoRoot, row.source.path);
      const dstRel = path.relative(repoRoot, row.downstream.path);
      const sha = findCoCommit(repoMap, srcRel, dstRel);
      if (sha) {
        outcomes.baselined.push({ row, reason: `baseline-from-git: co-committed at ${sha}` });
      } else if (repoMap.truncated) {
        outcomes.boundReached.push(row);
      } else {
        outcomes.noCoCommit.push(row);
      }
    }
  }

  return { outcomes, neverVerifiedCount: neverVerified.length };
}

/**
 * Write one `baselined` event per outcome in `outcomes.baselined`. Every
 * write goes through lib/events.mjs's `appendEvent`, which validates
 * (`reason` required for "baselined", both content fields required since
 * baselined pins) and stamps `event_id`/`ts` — none of that is
 * re-implemented here (GOTCHAS G20: a second reporting/validation mechanism
 * duplicates the first unless you delete the first; there is only one
 * validator, and it lives in events.mjs).
 *
 * @param {BaselineOutcomes} outcomes
 * @param {{by?: string}} [opts]
 * @returns {Promise<{applied: Array<{edge_id: string, node_id: string, disposition: "baselined", priorState: string, event_id: string}>, failed: Array<{edge_id: string, node_id: string, error: string}>}>}
 */
export async function applyBaseline(outcomes, opts = {}) {
  const applied = [];
  const failed = [];

  for (const { row, reason } of outcomes.baselined) {
    try {
      const stamped = await appendEvent({
        edge_id: row.edge_id,
        node_id: row.node_id,
        disposition: "baselined",
        reason,
        by: opts.by || process.env.USER || "bootstrap",
        ...resolveProvenance(row, "bootstrap"),
        source_content: row.source.contentId,
        downstream_content: row.downstream.contentId,
      });
      applied.push({
        edge_id: row.edge_id,
        node_id: row.node_id,
        disposition: "baselined",
        priorState: row.state,
        event_id: stamped.event_id,
      });
    } catch (err) {
      failed.push({ edge_id: row.edge_id, node_id: row.node_id, error: err.message });
    }
  }

  return { applied, failed };
}
