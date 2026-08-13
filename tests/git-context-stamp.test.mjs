/**
 * Tests for the STAMP half of lib/git-context.mjs (Phase 5, Part A).
 *
 * Strategy: build a real temp git repo (execFileSync git init/commit), then
 * assert getGitContext(filePath) reads the REAL HEAD sha/branch/dirty state
 * — not a mock. findRepoRoot is exercised implicitly by every case.
 *
 * Run: `npm test` (node --test tests/)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { getGitContext, findRepoRoot } from "../lib/git-context.mjs";

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function makeTempRepo(prefix = "git-context-") {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "Test"], dir);
  return dir;
}

test("stamp: a file in a temp git repo carries git:{sha,branch,dirty} with the real HEAD sha", async () => {
  const repo = await makeTempRepo();
  const filePath = path.join(repo, "file.txt");
  await writeFile(filePath, "hello\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "initial"], repo);
  const realSha = git(["rev-parse", "HEAD"], repo);

  const { context, error } = getGitContext(filePath);
  assert.equal(error, null);
  assert.ok(context, "expected a git context");
  assert.equal(context.sha, realSha);
  assert.equal(context.branch, "main");
  assert.equal(typeof context.dirty, "boolean");
});

test("stamp: a source outside any git repo produces no git field and does not throw", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "git-context-orphan-"));
  const filePath = path.join(dir, "not-in-a-repo.txt");
  await writeFile(filePath, "orphan\n");

  assert.doesNotThrow(() => getGitContext(filePath));
  const { context, error } = getGitContext(filePath);
  assert.equal(context, null);
  // Outside-any-repo is the expected case, not a failure — no error either.
  assert.equal(error, null);
  assert.equal(findRepoRoot(filePath), null);
});

test("stamp: dirty is true with uncommitted changes, false when clean", async () => {
  const repo = await makeTempRepo();
  const filePath = path.join(repo, "file.txt");
  await writeFile(filePath, "hello\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "initial"], repo);

  let { context } = getGitContext(filePath);
  assert.equal(context.dirty, false);

  await writeFile(filePath, "hello, again\n");
  ({ context } = getGitContext(filePath));
  assert.equal(context.dirty, true);

  git(["add", "."], repo);
  git(["commit", "-q", "-m", "second"], repo);
  ({ context } = getGitContext(filePath));
  assert.equal(context.dirty, false);
});

test("stamp: detached HEAD records branch: null, not a guessed name", async () => {
  const repo = await makeTempRepo();
  const filePath = path.join(repo, "file.txt");
  await writeFile(filePath, "hello\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "initial"], repo);
  const sha = git(["rev-parse", "HEAD"], repo);
  git(["checkout", "-q", sha], repo); // detach

  const { context, error } = getGitContext(filePath);
  assert.equal(error, null);
  assert.equal(context.branch, null);
  assert.equal(context.sha, sha);
});

test("stamp: a nested file resolves to the repo root via findRepoRoot walking up", async () => {
  const repo = await makeTempRepo();
  const nestedDir = path.join(repo, "a", "b", "c");
  await mkdir(nestedDir, { recursive: true });
  const filePath = path.join(nestedDir, "deep.txt");
  await writeFile(filePath, "deep\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "initial"], repo);

  assert.equal(findRepoRoot(filePath), repo);
  const { context } = getGitContext(filePath);
  assert.equal(context.branch, "main");
});

test("stamp: a repo with no commits yet degrades to context:null plus a logged error, never throws", async () => {
  const repo = await makeTempRepo();
  const filePath = path.join(repo, "untracked.txt");
  await writeFile(filePath, "no commits yet\n");
  // No commit made — HEAD doesn't resolve to anything.

  assert.doesNotThrow(() => getGitContext(filePath));
  const { context, error } = getGitContext(filePath);
  assert.equal(context, null);
  assert.ok(error && error.length > 0, "expected a non-empty error string to log");
});
