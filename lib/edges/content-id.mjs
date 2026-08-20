/**
 * Content identity — the primitive propagate v2 builds on.
 *
 * See /Users/rupali.b/.claude/plans/okay-i-dont-think-logical-haven.md
 * §1 (identities), §2b (propagate owns its store — why we don't just use
 * git's blob sha), §3/§3b/§3c (per-side context, spike results), §6b
 * (performance — the batching this file exists to do).
 *
 * `content_id = sha256(raw bytes)` — OURS, not git's. git's blob sha is a
 * *retrieval hint*, captured only when the bytes are genuinely in the object
 * store (tracked and clean). The two are different address spaces: git
 * hashes `"blob <len>\0" + bytes` with sha1; we hash raw bytes with sha256.
 * Never derive one from the other.
 *
 * Batching discipline (§6b, non-negotiable #2): one `git ls-files -s` and
 * one `git status --porcelain` per repo, memoized for the process. Never
 * spawn git in a loop over files. We still read+hash every file's bytes
 * ourselves in Node — the git calls exist only to (a) know which files are
 * dirty and (b) fetch the retrieval hint, not to avoid hashing.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const GIT_TIMEOUT_MS = 5000;
const GIT_MAX_BUFFER = 1024 * 1024 * 64;

// A git-lfs pointer file is small text starting with this exact header. It
// hashes stably while the real content behind it changes freely — an edge
// would read CLEAN forever while silently wrong (plan §T2/non-negotiable
// #3). The Phase 1 spike found zero LFS files across all workspaces
// (2026-08-13), so this guards a future foot-gun, not a live bug today —
// implemented anyway, per the plan's explicit instruction to do so.
const LFS_HEADER = "version https://git-lfs.github.com/spec/v1";

// ---------------------------------------------------------------------------
// git spawn accounting — every git subprocess in this module goes through
// this one wrapper, so tests can assert O(1)-per-repo spawn counts (plan
// §"TESTS" #9) without timing, which is flaky.
// ---------------------------------------------------------------------------
let __spawnCount = 0;

function execGit(args, opts = {}) {
  __spawnCount++;
  return execFileSync("git", args, {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
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

// ---------------------------------------------------------------------------
// resolveRepo — walk up from a path looking for a .git entry (directory for
// a canonical repo, file for a worktree gitfile pointer). Same convention as
// lib/git-context.mjs's findRepoRoot; duplicated rather than imported so
// this module has no dependency on the file another agent is concurrently
// editing (lib/refs.mjs is the intended future home for shared discovery).
// ---------------------------------------------------------------------------

/**
 * @param {string} absPath
 * @returns {string|null} absolute repo root, or null if absPath isn't inside any repo
 */
export function resolveRepo(absPath) {
  try {
    let dir = path.dirname(path.resolve(absPath));
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

// ---------------------------------------------------------------------------
// Per-repo, per-process caches (§6b: 10ms for ls-files, 30ms for status,
// paid once per repo no matter how many files are hashed against it).
// ---------------------------------------------------------------------------

/** repoRoot -> Map<repoRelativePath, gitBlobSha> */
const repoBlobCache = new Map();
/** repoRoot -> Set<repoRelativePath> (the dirty/untracked set from `git status --porcelain`) */
const repoDirtyCache = new Map();
/** `${absPath}:${mtimeMs}:${size}` -> {sha256, lfs} — the (path, mtime, size) -> hash cache from §2b/#5 */
const hashCache = new Map();

/**
 * ONE `git ls-files -s` call per repo, returning every tracked blob sha.
 * Memoized per repo for the process. A failure (not a git repo, git not on
 * PATH, etc.) degrades to an empty map — callers then simply have no hint
 * for any path in that repo, which is correct (a hint that can't be
 * produced is not a bug, just an absence).
 *
 * @param {string} repoRoot
 * @returns {Map<string, string>}
 */
export function batchTrackedBlobs(repoRoot) {
  if (repoBlobCache.has(repoRoot)) return repoBlobCache.get(repoRoot);
  const map = new Map();
  try {
    const out = execGit(["-C", repoRoot, "ls-files", "-s"], { encoding: "utf8" });
    for (const line of out.split("\n")) {
      if (!line.trim()) continue;
      // "<mode> <sha> <stage>\t<path>"
      const tab = line.indexOf("\t");
      if (tab === -1) continue;
      const meta = line.slice(0, tab).trim().split(/\s+/);
      const sha = meta[1];
      const relPath = line.slice(tab + 1);
      map.set(relPath, sha);
    }
  } catch {
    // leave map empty — no hints available for this repo, never a throw
  }
  repoBlobCache.set(repoRoot, map);
  return map;
}

/** ONE `git status --porcelain` call per repo, returning the dirty/untracked relpath set. Memoized. */
function dirtySet(repoRoot) {
  if (repoDirtyCache.has(repoRoot)) return repoDirtyCache.get(repoRoot);
  const set = new Set();
  try {
    const out = execGit(["-C", repoRoot, "status", "--porcelain"], { encoding: "utf8" });
    for (const line of out.split("\n")) {
      if (!line.trim()) continue;
      // "XY <path>" (rename: "XY orig -> new" — the new path is what's dirty)
      const rel = line.slice(3).split(" -> ").pop();
      set.add(rel);
    }
  } catch {
    // leave set empty — degrades to "nothing known dirty", so a stale hint
    // could theoretically be offered; acceptable, git status failing at all
    // means something is badly wrong with the repo and callers have bigger
    // problems than a dangling gitBlob hint.
  }
  repoDirtyCache.set(repoRoot, set);
  return set;
}

/** Clear the (path, mtime, size) -> sha256 cache. Deleting it must only cost time, never correctness. */
export function clearHashCache() {
  hashCache.clear();
}

/** Clear the per-repo ls-files/status caches (e.g. after a test commits new content mid-run). */
export function clearRepoCaches() {
  repoBlobCache.clear();
  repoDirtyCache.clear();
}

// ---------------------------------------------------------------------------
// hashing
// ---------------------------------------------------------------------------

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function isLfsPointer(buf) {
  const head = buf.subarray(0, LFS_HEADER.length).toString("utf8");
  return head === LFS_HEADER;
}

/**
 * Read + hash a working-tree file directly in Node (never via `git
 * hash-object` — that's a per-file spawn, measured ~10ms each, ~9s for a
 * 910-file repo; see §6b). Cached on (path, mtime, size).
 *
 * @param {string} absPath
 * @param {import("node:fs").Stats} st - caller already stat'd the file
 * @returns {{sha256: string, lfs: boolean}}
 */
function hashFileCached(absPath, st) {
  const key = `${absPath}:${st.mtimeMs}:${st.size}`;
  const cached = hashCache.get(key);
  if (cached) return cached;
  const buf = readFileSync(absPath);
  const result = { sha256: sha256(buf), lfs: isLfsPointer(buf) };
  hashCache.set(key, result);
  return result;
}

// ---------------------------------------------------------------------------
// contentId — the public API
// ---------------------------------------------------------------------------

function unresolved(reason) {
  return { id: null, alg: "sha256", gitBlob: null, unresolvable: reason };
}

/** Working-tree resolution: hash the file as it sits on disk right now. */
function contentIdWorkingTree(repoRoot, relPath, absPath) {
  let st;
  try {
    st = statSync(absPath);
  } catch (err) {
    if (err && err.code === "ENOENT") return unresolved("not-found");
    return unresolved("read-error");
  }
  if (st.isDirectory()) return unresolved("is-directory");

  let hashed;
  try {
    hashed = hashFileCached(absPath, st);
  } catch {
    return unresolved("read-error");
  }
  if (hashed.lfs) return unresolved("lfs-pointer");

  // gitBlob is captured ONLY when the content is genuinely in the object
  // store: tracked (present in `git ls-files -s`) AND clean (absent from
  // `git status --porcelain`). A dirty file's bytes are not what git has,
  // so the hint must be null — dangling immediately is worse than absent.
  const dirty = dirtySet(repoRoot);
  const tracked = batchTrackedBlobs(repoRoot);
  const gitBlob = !dirty.has(relPath) && tracked.has(relPath) ? tracked.get(relPath) : null;

  return { id: hashed.sha256, alg: "sha256", gitBlob, unresolvable: null };
}

/**
 * Type + blob sha for a path at a ref, via ONE `git ls-tree <ref> -- <path>`
 * call. Returns null if the path doesn't exist at that ref (including an
 * invalid ref itself — there is no separate "bad ref" reason in the API, it
 * folds into "not-found" since content isn't resolvable there either).
 */
function lsTreeEntry(repoRoot, ref, relPath) {
  let out;
  try {
    out = execGit(["-C", repoRoot, "ls-tree", ref, "--", relPath], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
  if (!out) return null;
  // "<mode> <type> <sha>\t<path>"
  const tab = out.indexOf("\t");
  const meta = (tab === -1 ? out : out.slice(0, tab)).trim().split(/\s+/);
  return { mode: meta[0], type: meta[1], sha: meta[2] };
}

/** Ref resolution: hash the content as it existed at `ref`, via `git show`. */
function contentIdAtRef(repoRoot, relPath, ref) {
  const entry = lsTreeEntry(repoRoot, ref, relPath);
  if (!entry) return unresolved("not-found");
  // "tree" = directory; "commit" = submodule gitlink — neither is content.
  if (entry.type !== "blob") return unresolved("is-directory");

  let buf;
  try {
    // No `encoding` — execFileSync returns a raw Buffer, which is what we
    // need to hash (matches the working-tree path's raw-byte hashing).
    buf = execGit(["-C", repoRoot, "cat-file", "-p", `${ref}:${relPath}`]);
  } catch {
    return unresolved("read-error");
  }
  if (isLfsPointer(buf)) return unresolved("lfs-pointer");

  // The content is genuinely in the object store here (we just read it from
  // there), so the retrieval hint is always legitimate to capture.
  return { id: sha256(buf), alg: "sha256", gitBlob: entry.sha, unresolvable: null };
}

/**
 * Resolve a file's content identity: sha256 of raw bytes, our own address
 * space (§2b). Never throws, never guesses — an absent id always carries a
 * REASON in `unresolvable`.
 *
 * @param {string} absPath
 * @param {{ref?: string}} [opts] - with `ref`, read content at that ref via
 *   `git show <ref>:<repo-rel-path>` instead of the working tree. Same repo
 *   is resolved from `absPath` either way — never assume a caller-supplied
 *   repo, always resolve per-side (plan §1 non-negotiable #1: 37% of edges
 *   cross a repo boundary).
 * @returns {{
 *   id: string|null,
 *   alg: "sha256",
 *   gitBlob: string|null,
 *   unresolvable: "no-repo"|"not-found"|"is-directory"|"lfs-pointer"|"read-error"|null
 * }}
 */
export function contentId(absPath, opts = {}) {
  const { ref } = opts;
  const repoRoot = resolveRepo(absPath);
  if (!repoRoot) return unresolved("no-repo");

  const relPath = path.relative(repoRoot, path.resolve(absPath));

  if (ref) return contentIdAtRef(repoRoot, relPath, ref);
  return contentIdWorkingTree(repoRoot, relPath, absPath);
}

/**
 * Batched hashing over many working-tree paths. Groups by repo so
 * `batchTrackedBlobs`/the dirty set are each computed once per repo no
 * matter how many paths are passed — the O(1)-git-spawns-per-repo property
 * `contentId` already gets from its module-level caches, made explicit here
 * as the documented bulk entry point (plan §7's `contentId` table, and the
 * "batch, never per-file spawn" non-negotiable).
 *
 * @param {string[]} absPaths
 * @returns {Map<string, ReturnType<typeof contentId>>} absPath -> result
 */
export function hashMany(absPaths) {
  const results = new Map();

  // Group by repo so the priming below touches each repo's caches once,
  // before any per-file hash call — purely for clarity/ordering; the
  // memoization in batchTrackedBlobs/dirtySet already makes this safe even
  // without pre-grouping, but grouping keeps the "one spawn pair per repo"
  // property visible in the code rather than incidental.
  const byRepo = new Map(); // repoRoot -> absPath[]
  const orphan = [];
  for (const absPath of absPaths) {
    const repoRoot = resolveRepo(absPath);
    if (!repoRoot) {
      orphan.push(absPath);
      continue;
    }
    if (!byRepo.has(repoRoot)) byRepo.set(repoRoot, []);
    byRepo.get(repoRoot).push(absPath);
  }

  for (const absPath of orphan) {
    results.set(absPath, contentId(absPath));
  }
  for (const [repoRoot, paths] of byRepo) {
    batchTrackedBlobs(repoRoot); // primes the one ls-files call for this repo
    dirtySet(repoRoot); // primes the one status call for this repo
    for (const absPath of paths) {
      results.set(absPath, contentId(absPath));
    }
  }

  return results;
}
