/**
 * Tests for lib/content-id.mjs — the identity primitive for propagate v2.
 *
 * Strategy: build real temp git repos (execFileSync git init/commit), same
 * scaffolding as tests/git-context-stamp.test.mjs. Never mock git — assert
 * against real repos so a wrong assumption about git's behavior (e.g. `git
 * show` on a directory not throwing) gets caught, not hidden.
 *
 * Run: `npm test` (node --test tests/)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  contentId,
  resolveRepo,
  batchTrackedBlobs,
  hashMany,
  clearHashCache,
  clearRepoCaches,
  __getSpawnCountForTests,
  __resetSpawnCountForTests,
} from "../../lib/edges/content-id.mjs";

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function gitBlobSha(cwd, relPath) {
  return git(["hash-object", relPath], cwd);
}

async function makeTempRepo(prefix = "content-id-") {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "Test"], dir);
  return dir;
}

// -----------------------------------------------------------------------
// 1. same file, working tree vs {ref} at a commit where it is unchanged
// -----------------------------------------------------------------------
test("working tree and {ref} agree when the file is unchanged since that commit", async () => {
  const repo = await makeTempRepo();
  const filePath = path.join(repo, "file.txt");
  await writeFile(filePath, "hello\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "initial"], repo);
  const sha = git(["rev-parse", "HEAD"], repo);

  const working = contentId(filePath);
  const atRef = contentId(filePath, { ref: sha });

  assert.equal(working.unresolvable, null);
  assert.equal(atRef.unresolvable, null);
  assert.equal(working.id, atRef.id);
  assert.equal(working.alg, "sha256");
  assert.equal(atRef.alg, "sha256");
});

// -----------------------------------------------------------------------
// 2. file changed since a commit -> ids differ between working tree and ref
// -----------------------------------------------------------------------
test("working tree and {ref} disagree once the file changes after that commit", async () => {
  const repo = await makeTempRepo();
  const filePath = path.join(repo, "file.txt");
  await writeFile(filePath, "hello\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "initial"], repo);
  const sha = git(["rev-parse", "HEAD"], repo);

  await writeFile(filePath, "hello, changed\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "second"], repo);

  const working = contentId(filePath);
  const atRef = contentId(filePath, { ref: sha });

  assert.equal(working.unresolvable, null);
  assert.equal(atRef.unresolvable, null);
  assert.notEqual(working.id, atRef.id);
});

// -----------------------------------------------------------------------
// 3. gitBlob present for a tracked clean file; null for a dirty file
// -----------------------------------------------------------------------
test("gitBlob is populated for a tracked clean file and null for a dirty one", async () => {
  const repo = await makeTempRepo();
  const cleanPath = path.join(repo, "clean.txt");
  const dirtyPath = path.join(repo, "dirty.txt");
  await writeFile(cleanPath, "clean\n");
  await writeFile(dirtyPath, "will be dirtied\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "initial"], repo);

  // Dirty it after the commit, without staging/committing again.
  await writeFile(dirtyPath, "dirtied now\n");
  clearRepoCaches();

  // R2/D11: the git hint is opt-in now — these tests are its only consumers.
  const clean = contentId(cleanPath, { wantGitBlob: true });
  const dirty = contentId(dirtyPath, { wantGitBlob: true });

  assert.equal(clean.unresolvable, null);
  assert.ok(clean.gitBlob, "expected a gitBlob hint for a tracked clean file");
  assert.equal(clean.gitBlob, gitBlobSha(repo, "clean.txt"));

  assert.equal(dirty.unresolvable, null);
  assert.equal(dirty.gitBlob, null, "a dirty file's bytes are not in the object store — hint must be null");
});

// -----------------------------------------------------------------------
// 4. our sha256 differs from the git blob sha — different address spaces
// -----------------------------------------------------------------------
test("our sha256 content id differs from git's own blob sha (different address spaces)", async () => {
  const repo = await makeTempRepo();
  const filePath = path.join(repo, "file.txt");
  await writeFile(filePath, "hello\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "initial"], repo);
  clearRepoCaches();

  const result = contentId(filePath, { wantGitBlob: true });
  const blobSha = gitBlobSha(repo, "file.txt");

  assert.equal(result.gitBlob, blobSha, "the hint should match git's real blob sha");
  // The load-bearing assertion: our content id is NOT git's blob sha. git
  // hashes "blob <len>\0" + bytes with sha1; we hash raw bytes with sha256.
  // Nobody should ever "simplify" one into the other.
  assert.notEqual(
    result.id,
    result.gitBlob,
    "content_id (our sha256 of raw bytes) must differ from gitBlob (git's sha1 of the git object) — asserted explicitly so this is never collapsed",
  );
  assert.equal(result.id.length, 64, "sha256 hex digest is 64 chars");
  assert.equal(result.gitBlob.length, 40, "git's sha1 blob sha is 40 chars");
});

// -----------------------------------------------------------------------
// 5. file outside any repo -> unresolvable: "no-repo", no throw
// -----------------------------------------------------------------------
test("hashMany makes ZERO git spawns by default, and exactly two per repo when the hint is asked for", async () => {
  // R2/D11 — the durable guard for the change that removed 48 git subprocesses
  // (2,905ms of summed `git` time) from `reconcile()` on the real tree. It
  // asserts the SPAWN COUNT, not a duration, for two reasons: a timing
  // assertion is flaky on a shared machine and gets deleted the first time CI
  // hiccups, and wall-clock here varies ~1.8x run to run in both directions,
  // so a duration would be the wrong thing to pin even if it were stable.
  // The spawn count does not move. See docs/DATA_MODEL.md §11.
  //
  // The two calls being gated (`git ls-files -s`, `git status --porcelain`)
  // were 69% of reconcile and served only `gitBlob`, which no production
  // caller reads. If a future change makes them unconditional again, this
  // goes red immediately and names why.
  const repo = await makeTempRepo();
  const paths = [];
  for (const name of ["a.txt", "b.txt", "c.txt"]) {
    const p = path.join(repo, name);
    await writeFile(p, `${name}\n`);
    paths.push(p);
  }
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "three files"], repo);

  clearHashCache();
  clearRepoCaches();
  __resetSpawnCountForTests();

  const plain = hashMany(paths);
  assert.equal(
    __getSpawnCountForTests(),
    0,
    "the default path must not spawn git at all — that is the whole point of the flag",
  );
  // Content identity is unaffected: every file still resolves, with a real id.
  for (const p of paths) {
    assert.equal(plain.get(p).unresolvable, null);
    assert.ok(plain.get(p).id, "an id is still produced without any git call");
    assert.equal(plain.get(p).gitBlob, null, "no hint was asked for, so none is offered");
  }

  clearHashCache();
  clearRepoCaches();
  __resetSpawnCountForTests();

  const hinted = hashMany(paths, { wantGitBlob: true });
  assert.equal(
    __getSpawnCountForTests(),
    2,
    "asking for the hint costs exactly one ls-files + one status for the repo, never per file",
  );
  for (const p of paths) {
    assert.ok(hinted.get(p).gitBlob, "the hint still works when asked for — it was gated, not deleted");
  }
  // Same content id either way: the flag must change cost, never identity.
  for (const p of paths) {
    assert.equal(plain.get(p).id, hinted.get(p).id);
  }

  await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

test("a file outside any git repo resolves to unresolvable: no-repo, never throws", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "content-id-orphan-"));
  const filePath = path.join(dir, "not-in-a-repo.txt");
  await writeFile(filePath, "orphan\n");

  assert.doesNotThrow(() => contentId(filePath));
  const result = contentId(filePath);
  assert.equal(result.id, null);
  assert.equal(result.gitBlob, null);
  assert.equal(result.unresolvable, "no-repo");
  assert.equal(resolveRepo(filePath), null);
});

// -----------------------------------------------------------------------
// 6. missing file -> "not-found"; directory -> "is-directory"
// -----------------------------------------------------------------------
test("a missing path resolves to not-found; a directory resolves to is-directory", async () => {
  const repo = await makeTempRepo();
  await writeFile(path.join(repo, "placeholder.txt"), "x\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "initial"], repo);

  const missing = contentId(path.join(repo, "does-not-exist.txt"));
  assert.equal(missing.unresolvable, "not-found");
  assert.equal(missing.id, null);

  const dirPath = path.join(repo, "a-directory");
  await mkdir(dirPath);
  const dirResult = contentId(dirPath);
  assert.equal(dirResult.unresolvable, "is-directory");
  assert.equal(dirResult.id, null);
});

test("a directory declared as a downstream at a ref also resolves to is-directory, not a throw", async () => {
  const repo = await makeTempRepo();
  await mkdir(path.join(repo, "adir"));
  await writeFile(path.join(repo, "adir", "inner.txt"), "inner\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "initial"], repo);
  const sha = git(["rev-parse", "HEAD"], repo);

  const result = contentId(path.join(repo, "adir"), { ref: sha });
  assert.equal(result.unresolvable, "is-directory");
  assert.equal(result.id, null);
});

test("a path that never existed at a given ref resolves to not-found at that ref", async () => {
  const repo = await makeTempRepo();
  await writeFile(path.join(repo, "file.txt"), "hello\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "initial"], repo);
  const sha = git(["rev-parse", "HEAD"], repo);

  const result = contentId(path.join(repo, "never-existed.txt"), { ref: sha });
  assert.equal(result.unresolvable, "not-found");
  assert.equal(result.id, null);
});

// -----------------------------------------------------------------------
// 7. LFS pointer -> "lfs-pointer"
// -----------------------------------------------------------------------
test("a git-lfs pointer file resolves to unresolvable: lfs-pointer, in the working tree and at a ref", async () => {
  const repo = await makeTempRepo();
  const filePath = path.join(repo, "asset.bin");
  const pointerBody =
    "version https://git-lfs.github.com/spec/v1\n" +
    "oid sha256:0000000000000000000000000000000000000000000000000000000000aa\n" +
    "size 12345\n";
  await writeFile(filePath, pointerBody);
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "lfs pointer"], repo);
  const sha = git(["rev-parse", "HEAD"], repo);
  clearRepoCaches();

  const working = contentId(filePath);
  assert.equal(working.unresolvable, "lfs-pointer");
  assert.equal(working.id, null);
  assert.equal(working.gitBlob, null, "no id extended means no hint either — never a half-resolved result");

  const atRef = contentId(filePath, { ref: sha });
  assert.equal(atRef.unresolvable, "lfs-pointer");
  assert.equal(atRef.id, null);
});

// -----------------------------------------------------------------------
// 8. cold vs warm cache -> identical ids
// -----------------------------------------------------------------------
test("a cold hash cache and a warm one produce identical content ids — deleting the cache costs time, not correctness", async () => {
  const repo = await makeTempRepo();
  const filePath = path.join(repo, "file.txt");
  await writeFile(filePath, "hello\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "initial"], repo);

  clearHashCache();
  clearRepoCaches();
  const cold = contentId(filePath); // populates the cache
  const warm = contentId(filePath); // hits the cache

  assert.deepEqual(cold, warm);

  clearHashCache(); // force a second cold pass
  const coldAgain = contentId(filePath);
  assert.deepEqual(coldAgain, cold, "clearing the cache must only cost time, never change the result");
});

// -----------------------------------------------------------------------
// 9. batching: hashing N files performs O(1) git spawns, not O(N)
// -----------------------------------------------------------------------
test("hashMany over N files in one repo spawns git a bounded number of times, not once per file", async () => {
  const repo = await makeTempRepo();
  const N = 25;
  const paths = [];
  for (let i = 0; i < N; i++) {
    const p = path.join(repo, `file-${i}.txt`);
    await writeFile(p, `contents ${i}\n`);
    paths.push(p);
  }
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "many files"], repo);

  clearHashCache();
  clearRepoCaches();
  __resetSpawnCountForTests();

  // wantGitBlob:true so the O(1)-per-repo spawn assertion below still has
  // spawns to count — it is the batching property being tested, not the hint.
  const results = hashMany(paths, { wantGitBlob: true });

  assert.equal(results.size, N);
  for (const p of paths) {
    const r = results.get(p);
    assert.equal(r.unresolvable, null);
    assert.ok(r.id);
    assert.ok(r.gitBlob);
  }

  const spawns = __getSpawnCountForTests();
  // One repo -> one ls-files + one status, no matter how many files. Bound
  // it well under N (25 files) to prove this is O(1)-per-repo, not O(N).
  assert.ok(
    spawns <= 2,
    `expected O(1) git spawns for ${N} files in one repo, got ${spawns}`,
  );
});

test("hashMany across two repos spawns git a bounded number of times per repo, not per file", async () => {
  const repoA = await makeTempRepo("content-id-a-");
  const repoB = await makeTempRepo("content-id-b-");
  const pathsA = [];
  const pathsB = [];
  for (let i = 0; i < 10; i++) {
    const pa = path.join(repoA, `a-${i}.txt`);
    const pb = path.join(repoB, `b-${i}.txt`);
    await writeFile(pa, `a ${i}\n`);
    await writeFile(pb, `b ${i}\n`);
    pathsA.push(pa);
    pathsB.push(pb);
  }
  git(["add", "."], repoA);
  git(["commit", "-q", "-m", "repo a"], repoA);
  git(["add", "."], repoB);
  git(["commit", "-q", "-m", "repo b"], repoB);

  clearHashCache();
  clearRepoCaches();
  __resetSpawnCountForTests();

  const results = hashMany([...pathsA, ...pathsB]);
  assert.equal(results.size, 20);

  const spawns = __getSpawnCountForTests();
  // Two repos -> at most 2 ls-files + 2 status = 4 spawns total, regardless
  // of the 20 files hashed.
  assert.ok(
    spawns <= 4,
    `expected O(1) git spawns per repo (2 repos) for 20 files, got ${spawns}`,
  );
});

// -----------------------------------------------------------------------
// batchTrackedBlobs — direct coverage of the exported batching primitive
// -----------------------------------------------------------------------
test("batchTrackedBlobs returns every tracked file's blob sha from one ls-files call", async () => {
  const repo = await makeTempRepo();
  await writeFile(path.join(repo, "one.txt"), "1\n");
  await writeFile(path.join(repo, "two.txt"), "2\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "initial"], repo);
  clearRepoCaches();

  const map = batchTrackedBlobs(repo);
  assert.equal(map.size, 2);
  assert.equal(map.get("one.txt"), gitBlobSha(repo, "one.txt"));
  assert.equal(map.get("two.txt"), gitBlobSha(repo, "two.txt"));
});

test("resolveRepo walks up from a nested file to the repo root", async () => {
  const repo = await makeTempRepo();
  const nestedDir = path.join(repo, "a", "b", "c");
  await mkdir(nestedDir, { recursive: true });
  const filePath = path.join(nestedDir, "deep.txt");
  await writeFile(filePath, "deep\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "initial"], repo);

  assert.equal(resolveRepo(filePath), repo);
});
