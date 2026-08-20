/**
 * Tests for lib/refs.mjs — the timeline coordinator (propagate v2, plan §3/§7).
 *
 * Strategy mirrors tests/git-context-stamp.test.mjs and tests/worktrees.test.mjs:
 * real temp git repos via execFileSync, no mocking of git itself. The one
 * exception is the "git failure" case, which needs a directory that carries
 * a `.git` marker but isn't a functioning repo, so enumerateRefs's git calls
 * throw for a reason OTHER than "not a repo here" (see lib/refs.mjs's
 * hasGitMarker-first design, which makes this distinguishable without
 * sniffing stderr text).
 *
 * Run: `npm test` (node --test tests/)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// macOS: /tmp (and mkdtemp's os.tmpdir() base) is a symlink to /private/tmp.
// git always reports worktree paths through their realpath, so test-side
// comparisons must resolve symlinks the same way or every path assertion
// mismatches on a real macOS box despite the library being correct.
function real(p) {
  return realpathSync(p);
}

import { enumerateRefs, findLedgersUnder, refsForEdge } from "../../lib/edges/refs.mjs";

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function makeTempRepo(prefix = "refs-test-") {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "Test"], dir);
  return dir;
}

async function commitFile(dir, name, contents) {
  await writeFile(path.join(dir, name), contents);
  git(["add", "."], dir);
  git(["commit", "-q", "-m", `add ${name}`], dir);
}

// ─────────────────────────────────────────────────────────────────────────
// enumerateRefs
// ─────────────────────────────────────────────────────────────────────────

test("enumerateRefs — a repo with 2 worktrees enumerates both, canonical flagged correctly", async () => {
  const repo = await makeTempRepo();
  await commitFile(repo, "file.txt", "hello\n");

  const wtDir = await mkdtemp(path.join(tmpdir(), "refs-test-wt-"));
  const secondaryPath = path.join(wtDir, "secondary");
  git(["worktree", "add", "-q", "-b", "feature/x", secondaryPath], repo);

  const { refs, error } = await enumerateRefs(repo);
  assert.equal(error, null);

  const worktreeRefs = refs.filter((r) => r.kind === "worktree");
  assert.equal(worktreeRefs.length, 2, "expected canonical + secondary worktree entries");

  const canonical = worktreeRefs.find((r) => r.path === real(repo));
  const secondary = worktreeRefs.find((r) => r.path === real(secondaryPath));
  assert.ok(canonical, "canonical worktree entry present");
  assert.ok(secondary, "secondary worktree entry present");
  assert.equal(canonical.isCanonical, true);
  assert.equal(secondary.isCanonical, false);
  assert.equal(canonical.ref, "main");
  assert.equal(secondary.ref, "feature/x");
  assert.equal(secondary.detached, false);

  // Branch enumeration must also see the branch even though it's a
  // worktree's checkout target.
  const branchRefs = refs.filter((r) => r.kind === "branch");
  const featureBranch = branchRefs.find((r) => r.ref === "feature/x");
  assert.ok(featureBranch, "feature/x branch present in branch-kind refs");
  assert.equal(featureBranch.path, null);
});

test("enumerateRefs — detached HEAD worktree reports ref:null, detached:true, no invented name", async () => {
  const repo = await makeTempRepo();
  await commitFile(repo, "file.txt", "hello\n");
  const sha = git(["rev-parse", "HEAD"], repo);

  const wtDir = await mkdtemp(path.join(tmpdir(), "refs-test-detached-"));
  const detachedPath = path.join(wtDir, "detached");
  git(["worktree", "add", "-q", "--detach", detachedPath, sha], repo);

  const { refs, error } = await enumerateRefs(repo);
  assert.equal(error, null);

  const detachedEntry = refs.find((r) => r.kind === "worktree" && r.path === real(detachedPath));
  assert.ok(detachedEntry, "detached worktree entry present");
  assert.equal(detachedEntry.ref, null);
  assert.equal(detachedEntry.detached, true);
  assert.equal(detachedEntry.head, sha);
});

test("enumerateRefs — non-git directory returns empty refs and error:null, distinguishable from a failure", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "refs-test-nongit-"));
  const { refs, error } = await enumerateRefs(dir);
  assert.deepEqual(refs, []);
  assert.equal(error, null);
});

test("enumerateRefs — a git failure never throws and populates error, distinct from the non-repo case", async () => {
  // A directory that carries a .git marker (so it is NOT the "no repo here"
  // case) but is not a functioning repo, so the actual git calls fail.
  const dir = await mkdtemp(path.join(tmpdir(), "refs-test-brokengit-"));
  await mkdir(path.join(dir, ".git")); // marker present, but empty — not a valid repo

  await assert.doesNotReject(async () => enumerateRefs(dir));
  const { refs, error } = await enumerateRefs(dir);
  assert.deepEqual(refs, []);
  assert.ok(error && error.length > 0, "expected a non-empty error string");
});

test("enumerateRefs — missing path reports error, not a silent empty non-repo answer", async () => {
  const { refs, error } = await enumerateRefs("/no/such/path/at/all/12345");
  assert.deepEqual(refs, []);
  assert.ok(error && error.length > 0);
});

// ─────────────────────────────────────────────────────────────────────────
// findLedgersUnder
// ─────────────────────────────────────────────────────────────────────────

test("findLedgersUnder — a ledger inside .claude/worktrees/<n>/docs/ is found and marked dot-directory-undiscoverable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "refs-test-findledgers-"));
  const nestedDocs = path.join(
    root,
    "PanditPawanKaushik",
    ".claude",
    "worktrees",
    "client-answers-propagation",
    "docs",
  );
  await mkdir(nestedDocs, { recursive: true });
  const ledgerPath = path.join(nestedDocs, "PROPAGATION_LEDGER.jsonl");
  await writeFile(ledgerPath, '{"id":"1"}\n');

  const findings = findLedgersUnder(root);
  const found = findings.find((f) => f.path === path.resolve(ledgerPath));
  assert.ok(found, "expected the nested worktree ledger to be found by the raw walk");
  assert.equal(found.discoverable, false);
  assert.equal(found.reason, "dot-directory");
});

test("findLedgersUnder — a normally-discoverable ledger is marked discoverable:true", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "refs-test-findledgers-ok-"));
  const wsRoot = path.join(root, "SomeWorkspace");
  const docsDir = path.join(wsRoot, "docs");
  await mkdir(docsDir, { recursive: true });
  await writeFile(path.join(wsRoot, ".propagates.yml"), "workspace: true\nsources: {}\n");
  const ledgerPath = path.join(docsDir, "PROPAGATION_LEDGER.jsonl");
  await writeFile(ledgerPath, '{"id":"1"}\n');

  const findings = findLedgersUnder(root);
  const found = findings.find((f) => f.path === path.resolve(ledgerPath));
  assert.ok(found, "expected the workspace ledger to be found");
  assert.equal(found.discoverable, true);
  assert.equal(found.reason, null);
});

test("findLedgersUnder — empty/non-existent root returns []", () => {
  assert.deepEqual(findLedgersUnder("/no/such/root/98765"), []);
});

// ─────────────────────────────────────────────────────────────────────────
// refsForEdge
// ─────────────────────────────────────────────────────────────────────────

test("refsForEdge — two sides in different repos resolve independently, sameRepo:false", async () => {
  const repoA = await makeTempRepo("refs-test-edge-a-");
  await commitFile(repoA, "source.md", "source content\n");
  const repoB = await makeTempRepo("refs-test-edge-b-");
  await commitFile(repoB, "downstream.ts", "downstream content\n");

  const { source, downstream, sameRepo } = await refsForEdge(
    path.join(repoA, "source.md"),
    path.join(repoB, "downstream.ts"),
  );

  assert.equal(sameRepo, false);
  assert.equal(source.repoRoot, repoA);
  assert.equal(downstream.repoRoot, repoB);
  assert.equal(source.ref, "main");
  assert.equal(downstream.ref, "main");
  assert.ok(source.head && downstream.head);
  assert.notEqual(source.head, downstream.head);
  assert.equal(source.error, null);
  assert.equal(downstream.error, null);
});

test("refsForEdge — two sides in the same repo resolve with sameRepo:true", async () => {
  const repo = await makeTempRepo("refs-test-edge-same-");
  await commitFile(repo, "source.md", "source content\n");
  await commitFile(repo, "downstream.ts", "downstream content\n");

  const { source, downstream, sameRepo } = await refsForEdge(
    path.join(repo, "source.md"),
    path.join(repo, "downstream.ts"),
  );

  assert.equal(sameRepo, true);
  assert.equal(source.repoRoot, repo);
  assert.equal(downstream.repoRoot, repo);
  assert.equal(source.head, downstream.head);
});

test("refsForEdge — a side outside any repo resolves to repoRoot:null without throwing", async () => {
  const repo = await makeTempRepo("refs-test-edge-orphan-");
  await commitFile(repo, "source.md", "source content\n");
  const orphanDir = await mkdtemp(path.join(tmpdir(), "refs-test-orphan-"));
  const orphanFile = path.join(orphanDir, "no-repo.md");
  await writeFile(orphanFile, "outside any repo\n");

  const { source, downstream, sameRepo } = await refsForEdge(
    path.join(repo, "source.md"),
    orphanFile,
  );

  assert.equal(sameRepo, false);
  assert.equal(source.repoRoot, repo);
  assert.equal(downstream.repoRoot, null);
  assert.equal(downstream.ref, null);
  assert.equal(downstream.error, null);
});
