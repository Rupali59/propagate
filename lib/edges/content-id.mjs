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
 *
 * The same discipline applies at a ref: one `git ls-tree -r <ref>` and one
 * `git cat-file --batch` per (repo, ref), memoized for the process — never
 * a `ls-tree`/`cat-file -p` pair spawned per path. bootstrap.mjs:20-27
 * records the cost of getting this wrong once already (~1,860 spawns /
 * 17.2s); the same mistake in `contentIdAtRef` costs ~176k spawns under
 * `reconcile --all-refs`.
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
/** `${repoRoot}\u0000${ref}` -> Map<repoRelativePath, {type, sha}> — one `git ls-tree -r` per (repo, ref) */
const repoRefBlobCache = new Map();
/** `${repoRoot}\u0000${ref}` -> Map<gitBlobSha, Buffer> — one `git cat-file --batch` per (repo, ref) */
const repoRefObjectCache = new Map();

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
  repoRefBlobCache.clear();
  repoRefObjectCache.clear();
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

/**
 * Working-tree resolution: hash the file as it sits on disk right now.
 *
 * `wantGitBlob` gates the ONLY two git subprocesses on this path (R2/D11).
 * Measured 2026-08-25 across the real tree: `dirtySet` + `batchTrackedBlobs`
 * over 24 repos were **48 spawns costing 2,905ms of summed `git` time** — the
 * dominant term in a `reconcile()` whose cold runs sampled 3.1-4.2s — while
 * reading and sha256-ing all 725 files cost ~22ms. The batching was
 * already optimal (exactly 2 spawns per repo, never per file); the cost is
 * simply that `git status --porcelain` on a large working tree is slow, and it
 * is charged per repo *touched*, not per file read: `Astroclarity` paid 1,036ms
 * to contribute 2 files while `PanditPawanKaushik` paid 51ms for 938.
 *
 * All of it produced `gitBlob`, which **no production code reads** — not the
 * state derivation (`reconcile.mjs` compares our sha256), not the event schema
 * (`source_content` / `downstream_content`), not any CLI reporter. So it is now
 * opt-in. The hint is not deleted: §2b's design stands and the flag makes it
 * available to the first caller that genuinely needs it.
 */
function contentIdWorkingTree(repoRoot, relPath, absPath, wantGitBlob = false) {
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
  //
  // Not asked for => not computed, and therefore no git spawn at all. `null`
  // here means "not requested", which is the same value an untracked or dirty
  // file yields — deliberately, because the hint is defined as a best-effort
  // retrieval aid and every existing consumer already null-checks it. A caller
  // that needs to distinguish the two asks for it.
  let gitBlob = null;
  if (wantGitBlob) {
    const dirty = dirtySet(repoRoot);
    const tracked = batchTrackedBlobs(repoRoot);
    gitBlob = !dirty.has(relPath) && tracked.has(relPath) ? tracked.get(relPath) : null;
  }

  return { id: hashed.sha256, alg: "sha256", gitBlob, unresolvable: null };
}

/**
 * ONE `git ls-tree -r -t -z <ref>` call per (repo, ref), returning every
 * path's type + blob sha at that ref. Memoized per (repo, ref) for the
 * process — mirrors `batchTrackedBlobs` exactly: same shape, same "degrade
 * to empty map, never throw" posture (a bad ref folds into an empty map,
 * same as a repo git can't read; callers see "not-found" for every path,
 * which is correct — nothing is resolvable there).
 *
 * `-t` is load-bearing, not decorative: `-r` alone recurses into subtrees
 * and lists only their blobs, dropping the directory (`tree`) entries
 * themselves — a downstream path that IS a directory would then read as
 * "not-found" instead of "is-directory" (this file's own test suite caught
 * it red the moment `-t` was left off: "a directory declared as a
 * downstream at a ref ... resolves to is-directory, not a throw"). `-t`
 * restores those tree entries alongside the recursive blob listing.
 *
 * `-z` NUL-terminates records instead of newline-terminating them, so a
 * path containing a literal newline or tab-adjacent byte can't be
 * misparsed the way it could with the default quoted/newline format.
 *
 * @param {string} repoRoot
 * @param {string} ref
 * @returns {Map<string, {type: string, sha: string}>}
 */
export function batchRefBlobs(repoRoot, ref) {
  const key = `${repoRoot}\u0000${ref}`;
  if (repoRefBlobCache.has(key)) return repoRefBlobCache.get(key);
  const map = new Map();
  try {
    const out = execGit(["-C", repoRoot, "ls-tree", "-r", "-t", "-z", ref], { encoding: "utf8" });
    for (const record of out.split("\u0000")) {
      if (!record) continue;
      // "<mode> <type> <sha>\t<path>"
      const tab = record.indexOf("\t");
      if (tab === -1) continue;
      const meta = record.slice(0, tab).trim().split(/\s+/);
      const relPath = record.slice(tab + 1);
      map.set(relPath, { type: meta[1], sha: meta[2] });
    }
  } catch {
    // leave map empty — nothing resolvable at this (repo, ref), never a throw
  }
  repoRefBlobCache.set(key, map);
  return map;
}

/**
 * ONE `git cat-file --batch` call per (repo, ref), fed every blob sha at
 * that ref (from `batchRefBlobs`) on stdin in a single spawn, returning the
 * raw bytes of each. Memoized per (repo, ref) — this is what lets any
 * number of subsequent single-path `contentIdAtRef` calls for the same
 * (repo, ref) cost zero additional spawns, mirroring `batchTrackedBlobs`'s
 * "paid once per repo" posture.
 *
 * `--batch` output per object is `"<sha> <type> <size>\n<content>\n"`, or
 * `"<sha> missing\n"` for a sha it can't find (never expected here, since
 * every sha fed in came from `ls-tree` moments earlier, but handled rather
 * than assumed away).
 *
 * @param {string} repoRoot
 * @param {string} ref
 * @returns {Map<string, Buffer>} blob sha -> raw content bytes
 */
export function batchRefObjects(repoRoot, ref) {
  const key = `${repoRoot}\u0000${ref}`;
  if (repoRefObjectCache.has(key)) return repoRefObjectCache.get(key);
  const map = new Map();
  const blobs = batchRefBlobs(repoRoot, ref);
  const shas = [];
  for (const entry of blobs.values()) {
    if (entry.type === "blob") shas.push(entry.sha);
  }
  if (shas.length === 0) {
    repoRefObjectCache.set(key, map);
    return map;
  }
  try {
    // No `encoding` — execFileSync returns a raw Buffer, which is what we
    // need to hash (matches the working-tree path's raw-byte hashing). Feed
    // every sha on stdin in one shot via the `input` option.
    const out = execGit(["-C", repoRoot, "cat-file", "--batch"], {
      input: shas.join("\n") + "\n",
    });
    let offset = 0;
    while (offset < out.length) {
      const headerEnd = out.indexOf(0x0a, offset); // '\n'
      if (headerEnd === -1) break;
      const header = out.subarray(offset, headerEnd).toString("utf8");
      const parts = header.trim().split(/\s+/);
      if (parts.length < 3 || parts[1] === "missing") {
        // "<sha> missing" — no content line follows.
        offset = headerEnd + 1;
        continue;
      }
      const [sha, , sizeStr] = parts;
      const size = parseInt(sizeStr, 10);
      const contentStart = headerEnd + 1;
      const contentEnd = contentStart + size;
      map.set(sha, Buffer.from(out.subarray(contentStart, contentEnd)));
      offset = contentEnd + 1; // skip the trailing newline after content
    }
  } catch {
    // leave map empty — degrades to "read-error" for every path at this
    // (repo, ref), never a throw.
  }
  repoRefObjectCache.set(key, map);
  return map;
}

/**
 * Ref resolution: hash the content as it existed at `ref`. Uses the two
 * batched, memoized helpers above so any number of paths resolved at the
 * same (repo, ref) cost exactly one `ls-tree` + one `cat-file --batch`
 * spawn total, never a spawn pair per path.
 */
function contentIdAtRef(repoRoot, relPath, ref) {
  const entry = batchRefBlobs(repoRoot, ref).get(relPath);
  if (!entry) return unresolved("not-found");
  // "tree" = directory; "commit" = submodule gitlink — neither is content.
  if (entry.type !== "blob") return unresolved("is-directory");

  const buf = batchRefObjects(repoRoot, ref).get(entry.sha);
  if (!buf) return unresolved("read-error");
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
 * @param {{ref?: string, wantGitBlob?: boolean}} [opts] - `wantGitBlob` (default
 *   FALSE) opts in to the git retrieval hint on the working-tree path, at the
 *   cost of one `git ls-files -s` + one `git status --porcelain` per repo. It
 *   is off by default because it dominated `reconcile()` while no production
 *   caller read the result — see `contentIdWorkingTree` for the measurement.
 *   Ignored with `ref`: that path gets its blob sha free from `ls-tree` and
 *   spawns nothing extra either way.
 *
 *   With `ref`, read content as it existed at
 *   that ref (via the batched `ls-tree`/`cat-file --batch` pair above)
 *   instead of the working tree. Same repo is resolved from `absPath`
 *   either way — never assume a caller-supplied repo, always resolve
 *   per-side (plan §1 non-negotiable #1: 37% of edges cross a repo
 *   boundary).
 * @returns {{
 *   id: string|null,
 *   alg: "sha256",
 *   gitBlob: string|null,
 *   unresolvable: "no-repo"|"not-found"|"is-directory"|"lfs-pointer"|"read-error"|null
 * }}
 */
export function contentId(absPath, opts = {}) {
  const { ref, wantGitBlob = false } = opts;
  const repoRoot = resolveRepo(absPath);
  if (!repoRoot) return unresolved("no-repo");

  const relPath = path.relative(repoRoot, path.resolve(absPath));

  if (ref) return contentIdAtRef(repoRoot, relPath, ref);
  return contentIdWorkingTree(repoRoot, relPath, absPath, wantGitBlob);
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
 * @param {{wantGitBlob?: boolean}} [opts] - default FALSE; see `contentId`. With
 *   it off this function makes **zero** git subprocesses, which is asserted in
 *   tests/watcher/content-id.test.mjs rather than left to a timing measurement.
 * @returns {Map<string, ReturnType<typeof contentId>>} absPath -> result
 */
export function hashMany(absPaths, opts = {}) {
  const { wantGitBlob = false } = opts;
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
    results.set(absPath, contentId(absPath, { wantGitBlob }));
  }
  for (const [repoRoot, paths] of byRepo) {
    if (wantGitBlob) {
      batchTrackedBlobs(repoRoot); // primes the one ls-files call for this repo
      dirtySet(repoRoot); // primes the one status call for this repo
    }
    for (const absPath of paths) {
      results.set(absPath, contentId(absPath, { wantGitBlob }));
    }
  }

  return results;
}
