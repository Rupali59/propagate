/**
 * Git context — stamping (forward) and backfill (retroactive reconstruction)
 * of `git: {sha, branch, dirty}` on ledger rows.
 *
 * Two halves, deliberately kept apart:
 *
 * STAMP (forward, live). `getGitContext(filePath)` resolves the repo that
 * owns `filePath`, reads its current HEAD sha/branch and working-tree dirty
 * state, and hands back `{context, error}`. Called by `watcher.mjs` at fire
 * time on every NEW Event row (both the `drift` and `code_drift` paths).
 * Never throws — a git failure degrades to `context: null` plus an `error`
 * string the caller is expected to log (watcher.mjs owns the actual log
 * write, since it already has an async file logger; this module stays
 * synchronous and I/O-logging-free so it's trivially unit-testable).
 *
 * BACKFILL (retroactive, offline). For the 1454 rows that predate stamping,
 * there is no way to know what HEAD actually was when the row fired — that
 * information was never recorded. What CAN be recovered is a legitimate
 * lower-bound reconstruction: SPEC.md §5's auto-close rule is
 * `git log --format=%H --name-only <sha>..HEAD`, which wants **HEAD at the
 * moment the row fired** as the anchor to search forward from — NOT the
 * commit that contains the edit the row describes. `git rev-list -1
 * --before=<row.timestamp> <branch>` reconstructs exactly that anchor: the
 * newest commit that existed on `branch` at or before the row's timestamp.
 * This is why backfill is worth doing at all, and why it must never be
 * "corrected" into finding the commit that touched the source file — that
 * would answer a different question than the one SPEC §5 asks.
 *
 * Because we don't know which branch was checked out at fire time either,
 * backfill anchors against the repo's CURRENT branch (HEAD now) as the best
 * available approximation, and says so explicitly in `method`. Every
 * reconstructed entry carries `reconstructed: true` — a reconstructed sha
 * must never be mistaken for a stamped one — and backfill only ever
 * PROPOSES an anchor via a sidecar file; it never writes to a ledger row and
 * never changes a row's status.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const GIT_TIMEOUT_MS = 5000;

/**
 * Walk up from `filePath`'s directory looking for a `.git` entry (directory
 * for a canonical repo, file for a worktree gitfile pointer — both are valid
 * repo markers per `lib/worktrees.mjs`). Returns the absolute repo root, or
 * `null` if `filePath` isn't inside any repo. Never throws.
 * @param {string} filePath
 * @returns {string|null}
 */
export function findRepoRoot(filePath) {
  try {
    let dir = path.dirname(path.resolve(filePath));
    const fsRoot = path.parse(dir).root;
    for (;;) {
      if (existsSync(path.join(dir, ".git"))) return dir;
      if (dir === fsRoot) return null;
      dir = path.dirname(dir);
    }
  } catch {
    return null;
  }
}

/**
 * Stamp the CURRENT git context for the repo that owns `filePath`. Forward
 * path only — always reads live HEAD/status, never historical.
 *
 * Contract:
 * - `filePath` outside any repo: `{context: null, error: null}` — this is
 *   the expected, non-error case (a source may legitimately live outside a
 *   git repo, e.g. a workspace-root doc). No log line warranted.
 * - repo found but a git subprocess fails (corrupt repo, no commits yet,
 *   git not on PATH): `{context: null, error: "<message>"}` — the caller
 *   (watcher.mjs) is expected to log `error`. This function itself never
 *   throws and never writes a log line (ISSUES.md N8 is exactly a bare
 *   `catch { return []; }` that swallowed a failure silently — this module
 *   surfaces the failure as a return value instead of repeating that bug).
 * - success: `{context: {sha, branch, dirty}, error: null}`. `branch` is
 *   `null` for detached HEAD — recorded, never invented.
 *
 * @param {string} filePath
 * @returns {{context: {sha: string, branch: string|null, dirty: boolean}|null, error: string|null}}
 */
export function getGitContext(filePath) {
  const repoRoot = findRepoRoot(filePath);
  if (!repoRoot) return { context: null, error: null };
  try {
    const sha = execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
    }).trim();
    let branch = execFileSync(
      "git",
      ["-C", repoRoot, "rev-parse", "--abbrev-ref", "HEAD"],
      { encoding: "utf8", timeout: GIT_TIMEOUT_MS },
    ).trim();
    if (branch === "HEAD") branch = null; // detached — record null, don't invent
    const statusOut = execFileSync(
      "git",
      ["-C", repoRoot, "status", "--porcelain"],
      { encoding: "utf8", timeout: GIT_TIMEOUT_MS },
    );
    const dirty = statusOut.trim().length > 0;
    return { context: { sha, branch, dirty }, error: null };
  } catch (err) {
    return {
      context: null,
      error: `git-context: stamp failed for repo ${repoRoot}: ${err.message}`,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Backfill — reconstruction, sidecar I/O, batch driver
// ─────────────────────────────────────────────────────────────────────────

/**
 * Reconstruct SPEC §5's anchor for one row: the newest commit that existed
 * on the repo's CURRENT branch at or before `timestampISO`. This is a lower
 * bound to search forward from (`git log <sha>..HEAD`), not the commit that
 * touched the source file — see module doc.
 *
 * @param {string} repoRoot
 * @param {string} timestampISO - the row's `timestamp` (when it FIRED)
 * @returns {{anchor: {sha: string, branch: string|null, reconstructed: true, method: string}|null, reason: string|null}}
 */
export function reconstructAnchor(repoRoot, timestampISO) {
  let branch = null;
  try {
    const b = execFileSync(
      "git",
      ["-C", repoRoot, "rev-parse", "--abbrev-ref", "HEAD"],
      { encoding: "utf8", timeout: GIT_TIMEOUT_MS },
    ).trim();
    branch = b === "HEAD" ? null : b;
  } catch {
    // Detached, or repo in a weird state — branch context genuinely
    // unrecoverable. Record null, don't invent (still attempt the anchor
    // reconstruction below against HEAD).
  }
  const revTarget = branch || "HEAD";
  let sha;
  try {
    sha = execFileSync(
      "git",
      [
        "-C",
        repoRoot,
        "rev-list",
        "-1",
        `--before=${timestampISO}`,
        revTarget,
      ],
      { encoding: "utf8", timeout: GIT_TIMEOUT_MS },
    ).trim();
  } catch (err) {
    return { anchor: null, reason: `git rev-list failed: ${err.message}` };
  }
  if (!sha) {
    return {
      anchor: null,
      reason: "no commit before row timestamp (predates available history)",
    };
  }
  return {
    anchor: {
      sha,
      branch,
      reconstructed: true,
      method: `git rev-list -1 --before=${timestampISO} ${revTarget} — reconstructs HEAD-at-fire-time per SPEC.md §5 (a lower bound to search forward from), NOT the commit containing the edit. Branch is the repo's CURRENT branch, used as the best available approximation of the branch checked out at fire time; the true fire-time branch is unrecoverable.`,
    },
    reason: null,
  };
}

/**
 * Resolve the sidecar path for a ledger's git-backfill entries, keyed off
 * the ACTUAL resolved ledger path (`ws.ledgerJsonl` — the record, never
 * rebuilt from `wsRoot`), so it tracks whichever of the three layouts
 * discovery pinned to without needing to know about a new one by name:
 *   - `<root>/docs/PROPAGATION_LEDGER.jsonl` → sidecar nested at
 *     `<root>/docs/.propagation/git-backfill.jsonl` (keeps machine state out
 *     of a directory a human reads).
 *   - the legacy `<root>/.propagation/ledger.jsonl` → sidecar alongside it,
 *     `<root>/.propagation/git-backfill.jsonl`.
 *   - the current `<root>/propagation/ledger.jsonl` → sidecar alongside it
 *     the same way, `<root>/propagation/git-backfill.jsonl` — this falls out
 *     of the same "not docs/" branch below with no special-casing, because
 *     `propagation/` is, like `.propagation/`, already a machine-owned
 *     directory rather than a human-authored one.
 * @param {string} ledgerJsonlPath
 * @returns {string}
 */
export function resolveGitBackfillSidecarPath(ledgerJsonlPath) {
  const ledgerDir = path.dirname(ledgerJsonlPath);
  const usesDocsConvention = path.basename(ledgerDir) === "docs";
  const sidecarDir = usesDocsConvention
    ? path.join(ledgerDir, ".propagation")
    : ledgerDir;
  return path.join(sidecarDir, "git-backfill.jsonl");
}

/**
 * Load a git-backfill sidecar (JSONL, one `{id, git}` object per line) from
 * an absolute path. Missing file, unreadable file, or malformed lines all
 * degrade to an empty/partial map — never throws.
 * @param {string} sidecarPath
 * @returns {Map<string, object>} row id -> reconstructed git object
 */
export function loadGitBackfillSidecarAt(sidecarPath) {
  const map = new Map();
  if (!existsSync(sidecarPath)) return map;
  let raw;
  try {
    raw = readFileSync(sidecarPath, "utf8");
  } catch {
    return map;
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && entry.id && entry.git) map.set(entry.id, entry.git);
    } catch {
      // skip malformed line, keep going
    }
  }
  return map;
}

/**
 * Convenience wrapper: resolve the sidecar path for a ledger and load it.
 * Used by `lib/ledger.mjs`'s fold to attach reconstructed context.
 * @param {string} ledgerJsonlPath
 * @returns {Map<string, object>}
 */
export function loadGitBackfillSidecar(ledgerJsonlPath) {
  return loadGitBackfillSidecarAt(resolveGitBackfillSidecarPath(ledgerJsonlPath));
}

/**
 * Backfill driver over an already-folded row array (as returned by
 * `readLedger`/`readLedgerWithStats` from `lib/ledger.mjs`). Takes rows
 * rather than a ledger path so this module has no import-time dependency on
 * `lib/ledger.mjs` — the caller (a CLI entry point, or a test) wires the two
 * together.
 *
 * PROPOSES ONLY. Never mutates `rows`, never touches the ledger file, never
 * changes a row's status. Rows that already carry a stamped `git` field are
 * skipped entirely (never overwritten by a reconstruction). Every miss is
 * attributed to a reason so the hit rate is honestly reportable.
 *
 * @param {Array<{id: string, source?: string, timestamp: string, git?: object}>} rows
 * @param {string} workspaceRoot - absolute path; `row.source` is resolved against this
 * @returns {{
 *   hit: number, miss: number, alreadyStamped: number,
 *   missReasons: Record<string, number>,
 *   entries: Array<{id: string, git: object}>
 * }}
 */
export function backfillRows(rows, workspaceRoot) {
  const result = {
    hit: 0,
    miss: 0,
    alreadyStamped: 0,
    missReasons: {},
    entries: [],
  };
  const bump = (reason) => {
    result.miss++;
    result.missReasons[reason] = (result.missReasons[reason] || 0) + 1;
  };
  for (const row of rows) {
    if (row.git) {
      // Already stamped (forward path) — a reconstruction must never
      // pass as, or overwrite, a stamped value.
      result.alreadyStamped++;
      continue;
    }
    if (!row.source) {
      bump("row has no source path");
      continue;
    }
    const abs = path.resolve(workspaceRoot, row.source);
    const repoRoot = findRepoRoot(abs);
    if (!repoRoot) {
      bump("source not inside any resolvable git repo");
      continue;
    }
    const { anchor, reason } = reconstructAnchor(repoRoot, row.timestamp);
    if (!anchor) {
      bump(reason || "reconstruction failed for an unlogged reason");
      continue;
    }
    result.hit++;
    result.entries.push({ id: row.id, git: anchor });
  }
  return result;
}

/**
 * Merge newly-reconstructed entries into whatever the sidecar already has
 * (by id, new wins) and write the result. Idempotent — safe to re-run.
 * Does NOT touch the ledger file. No-ops (does not create the sidecar) when
 * there is nothing to write.
 * @param {string} sidecarPath
 * @param {Array<{id: string, git: object}>} entries
 */
export function writeGitBackfillSidecar(sidecarPath, entries) {
  if (entries.length === 0) return;
  const existing = loadGitBackfillSidecarAt(sidecarPath);
  for (const e of entries) existing.set(e.id, e.git);
  mkdirSync(path.dirname(sidecarPath), { recursive: true });
  const lines = [...existing.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([id, git]) => JSON.stringify({ id, git }));
  writeFileSync(sidecarPath, lines.join("\n") + "\n");
}

/**
 * Dry-run-capable entry point for one workspace. Reads the ledger via the
 * caller-supplied `readLedgerFn` (pass `readLedger` from `lib/ledger.mjs` —
 * kept as a parameter rather than a static import to avoid a module-cycle
 * with `lib/ledger.mjs`, which itself imports `loadGitBackfillSidecar` from
 * this file), computes reconstructions, and — unless `dryRun` — writes the
 * sidecar. NEVER writes to the ledger file itself, and NEVER changes a
 * row's status; that is the whole point of the sidecar design (SPEC I2).
 *
 * @param {{root: string, ledgerJsonl: string}} workspace
 * @param {(jsonlPath: string) => Promise<Array>} readLedgerFn
 * @param {{dryRun?: boolean}} [opts]
 * @returns {Promise<{
 *   workspace: string, sidecarPath: string, dryRun: boolean,
 *   totalRows: number, hit: number, miss: number, alreadyStamped: number,
 *   missReasons: Record<string, number>
 * }>}
 */
export async function backfillWorkspace(workspace, readLedgerFn, opts = {}) {
  const dryRun = opts.dryRun !== false; // default true — write is opt-in
  const rows = await readLedgerFn(workspace.ledgerJsonl);
  const result = backfillRows(rows, workspace.root);
  const sidecarPath = resolveGitBackfillSidecarPath(workspace.ledgerJsonl);
  if (!dryRun) {
    writeGitBackfillSidecar(sidecarPath, result.entries);
  }
  return {
    workspace: workspace.name,
    sidecarPath,
    dryRun,
    totalRows: rows.length,
    hit: result.hit,
    miss: result.miss,
    alreadyStamped: result.alreadyStamped,
    missReasons: result.missReasons,
  };
}
