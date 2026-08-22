/**
 * F2 — contentIdAtRef must not spawn git per (path, ref).
 *
 * Before this fix, `contentIdAtRef` made TWO git spawns per (path, ref):
 * `git ls-tree <ref> -- <path>` and `git cat-file -p <ref>:<path>`. Under
 * `reconcile --all-refs` that is O(paths x refs) spawns — ~176k for the
 * real workload this was measured against. The fix batches both: one
 * `git ls-tree -r -t -z <ref>` and one `git cat-file --batch` per (repo,
 * ref), memoized for the process — mirroring the working-tree path's
 * existing `batchTrackedBlobs`/`dirtySet` discipline (lib/edges/content-id.mjs
 * §6b).
 *
 * This test asserts the SPAWN COUNT, not wall time — wall-time assertions
 * are flaky and don't actually prove the O(1)-per-repo property; counting
 * `execGit` invocations does.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  contentId,
  batchRefBlobs,
  batchRefObjects,
  clearHashCache,
  clearRepoCaches,
  __getSpawnCountForTests,
  __resetSpawnCountForTests,
} from "../../lib/edges/content-id.mjs";

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function makeTempRepo(prefix = "ref-batching-") {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "Test"], dir);
  return dir;
}

// ---------------------------------------------------------------------------
// 1. spawn count is O(refs), not O(paths x refs)
// ---------------------------------------------------------------------------
test("resolving contentId at a ref for N>=20 files across 2 branches spawns git a bounded number of times, not once per (path, ref)", async () => {
  const repo = await makeTempRepo();
  const N = 24;
  const paths = [];
  for (let i = 0; i < N; i++) {
    const relPath = `file-${i}.txt`;
    await writeFile(path.join(repo, relPath), `contents ${i} on main\n`);
    paths.push(relPath);
  }
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "main commit"], repo);
  const mainSha = git(["rev-parse", "HEAD"], repo);

  git(["checkout", "-q", "-b", "second"], repo);
  for (const relPath of paths) {
    await writeFile(path.join(repo, relPath), `contents for ${relPath} on second\n`);
  }
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "second branch commit"], repo);
  const secondSha = git(["rev-parse", "HEAD"], repo);

  clearHashCache();
  clearRepoCaches();
  __resetSpawnCountForTests();

  const results = [];
  for (const ref of [mainSha, secondSha]) {
    for (const relPath of paths) {
      results.push(contentId(path.join(repo, relPath), { ref }));
    }
  }

  assert.equal(results.length, N * 2);
  for (const r of results) {
    assert.equal(r.unresolvable, null, `expected every path resolvable, got ${r.unresolvable}`);
    assert.ok(r.id);
    assert.ok(r.gitBlob);
  }

  const spawns = __getSpawnCountForTests();
  // Two refs -> at most one `ls-tree` + one `cat-file --batch` PER ref = 4
  // spawns total, regardless of N*2 = 48 (path, ref) resolutions. Bound it
  // well under N*2 to prove this is O(refs), not O(paths x refs).
  assert.ok(
    spawns <= 4,
    `expected O(1) git spawns per (repo, ref) for ${N} files x 2 refs, got ${spawns}`,
  );
});

// ---------------------------------------------------------------------------
// 2. correctness preserved — a ref-derived id matches the working-tree id
//    for an unchanged file. This is the assertion that would catch the
//    "just use git's blob sha" mistake: a blob sha and a sha256-of-raw-bytes
//    id are different address spaces and must never be substituted for
//    one another, but a ref-derived sha256 and a working-tree sha256 of the
//    SAME bytes must always agree.
// ---------------------------------------------------------------------------
test("contentId at a ref equals contentId in the working tree for an unchanged file, via the batched path", async () => {
  const repo = await makeTempRepo();
  const filePath = path.join(repo, "unchanged.txt");
  await writeFile(filePath, "stable content\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "initial"], repo);
  const sha = git(["rev-parse", "HEAD"], repo);

  clearHashCache();
  clearRepoCaches();

  const working = contentId(filePath);
  const atRef = contentId(filePath, { ref: sha });

  assert.equal(working.unresolvable, null);
  assert.equal(atRef.unresolvable, null);
  assert.equal(working.alg, "sha256");
  assert.equal(atRef.alg, "sha256");
  assert.equal(working.id, atRef.id, "ref-derived and working-tree-derived content ids must be comparable");
  // And explicitly: neither is git's blob sha (different address spaces).
  assert.notEqual(atRef.id, atRef.gitBlob);
});

// ---------------------------------------------------------------------------
// 3. batchRefBlobs / batchRefObjects direct coverage
// ---------------------------------------------------------------------------
test("batchRefBlobs returns every path's type+sha at a ref from one ls-tree call, including directories", async () => {
  const repo = await makeTempRepo();
  await writeFile(path.join(repo, "top.txt"), "top\n");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.join(repo, "adir"));
  await writeFile(path.join(repo, "adir", "inner.txt"), "inner\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "initial"], repo);
  const sha = git(["rev-parse", "HEAD"], repo);
  clearRepoCaches();

  const blobs = batchRefBlobs(repo, sha);
  assert.equal(blobs.get("top.txt").type, "blob");
  assert.equal(blobs.get("adir/inner.txt").type, "blob");
  assert.equal(blobs.get("adir").type, "tree", "a directory must appear as a tree entry, not be dropped by -r");
});

test("batchRefObjects returns raw bytes for every blob at a ref from one cat-file --batch call", async () => {
  const repo = await makeTempRepo();
  await writeFile(path.join(repo, "a.txt"), "aaa\n");
  await writeFile(path.join(repo, "b.txt"), "bbb\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "initial"], repo);
  const sha = git(["rev-parse", "HEAD"], repo);
  clearRepoCaches();

  const blobs = batchRefBlobs(repo, sha);
  const objects = batchRefObjects(repo, sha);

  assert.equal(objects.get(blobs.get("a.txt").sha).toString("utf8"), "aaa\n");
  assert.equal(objects.get(blobs.get("b.txt").sha).toString("utf8"), "bbb\n");
});

// ---------------------------------------------------------------------------
// 4. MUTATION CHECK — the caller of the assertion, not shipped here, does
//    the actual break/restore/re-green cycle against this file's exported
//    behavior. This test just needs to be a faithful, sensitive witness:
//    if batchRefBlobs/batchRefObjects stop being consulted, every path at
//    a ref reads unresolvable, and the spawn-count assertion above breaks
//    too (mutating batching to "empty map" is asserted separately, by hand,
//    as required verification — see the session report, not this file).
// ---------------------------------------------------------------------------
test("an unresolvable ref (bad sha) degrades every path to not-found, never throws, and costs bounded spawns", async () => {
  const repo = await makeTempRepo();
  await writeFile(path.join(repo, "file.txt"), "hello\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "initial"], repo);

  clearRepoCaches();
  __resetSpawnCountForTests();

  assert.doesNotThrow(() => contentId(path.join(repo, "file.txt"), { ref: "not-a-real-ref" }));
  const result = contentId(path.join(repo, "file.txt"), { ref: "not-a-real-ref" });
  assert.equal(result.unresolvable, "not-found");
  assert.equal(result.id, null);

  const spawns = __getSpawnCountForTests();
  assert.ok(spawns <= 2, `expected O(1) spawns even for a bad ref, got ${spawns}`);
});
