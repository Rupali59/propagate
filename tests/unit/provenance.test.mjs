/**
 * Tests for lib/edges/provenance.mjs — D3/§2 of
 * docs/deferred/2026-08-20-two-tier-ref-aware-ledger.md (lane W1,
 * ~/.claude/plans/status-temporal-plum.md §1+§2).
 *
 * Strategy for the ref/position resolvers: real temp git repos (same
 * discipline as tests/unit/git-context-stamp.test.mjs, which this file's
 * failure-construction case is deliberately copied from — "a repo with no
 * commits yet" is a real, reproducible way to make `getGitContext` return
 * `{context: null, error: <non-empty>}` without mocking anything). None of
 * these call `appendEvent`, so nothing here touches EVENTS_DIR/STATE_DIR —
 * no subprocess needed (unlike tests/watcher/events.test.mjs).
 *
 * Run: `npm test` (node --test tests/)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  resolveObservedRef,
  resolveObservedPosition,
  resolveByKind,
  resolveProvenance,
  BY_KINDS,
} from "../../lib/edges/provenance.mjs";

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function makeTempRepo(prefix = "provenance-") {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "Test"], dir);
  return dir;
}

// ─────────────────────────────────────────────────────────────────────────
// resolveObservedRef — the three outcomes must never collapse into one.
// ─────────────────────────────────────────────────────────────────────────

test("resolveObservedRef: an explicit ref on the side is returned as-is, no git call, no error", () => {
  const { observed_on_ref, observed_on_ref_error } = resolveObservedRef({
    path: "/does/not/exist/at/all.txt",
    ref: "release/2026-08",
  });
  assert.equal(observed_on_ref, "release/2026-08");
  assert.equal(observed_on_ref_error, null);
});

test("resolveObservedRef: a genuine working-tree read (clean temp repo, committed file) resolves to 'working-tree'", async () => {
  const repo = await makeTempRepo();
  const filePath = path.join(repo, "file.txt");
  await writeFile(filePath, "hello\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "initial"], repo);

  const { observed_on_ref, observed_on_ref_error } = resolveObservedRef({ path: filePath, ref: null });
  assert.equal(observed_on_ref, "working-tree");
  assert.equal(observed_on_ref_error, null);
});

// RED test #1 (brief §1 / plan §"RED first" item 1): a ref that FAILS to
// resolve must produce null + a non-empty error, NEVER "working-tree" —
// the exact confusion this whole wedge exists to remove. Constructed for
// real: a repo with no commits yet makes `git rev-parse HEAD` fail, the
// same failure tests/unit/git-context-stamp.test.mjs already proves
// getGitContext surfaces as {context: null, error: <non-empty>} rather than
// throwing.
test("resolveObservedRef: a genuinely FAILED resolution produces null + a non-empty error, NOT 'working-tree'", async () => {
  const repo = await makeTempRepo();
  const filePath = path.join(repo, "untracked.txt");
  await writeFile(filePath, "no commits yet\n");
  // No commit made — HEAD doesn't resolve to anything; getGitContext's
  // internal `git rev-parse HEAD` throws and is caught as a real failure.

  const { observed_on_ref, observed_on_ref_error } = resolveObservedRef({ path: filePath, ref: null });
  assert.notEqual(observed_on_ref, "working-tree", "a failed lookup must never read as a successful working-tree read");
  assert.equal(observed_on_ref, null);
  assert.ok(
    typeof observed_on_ref_error === "string" && observed_on_ref_error.length > 0,
    "expected a non-empty error string, distinguishing FAILED from working-tree",
  );
});

test("resolveObservedRef: a path genuinely outside any repo is a working-tree read, not a failure", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "provenance-no-repo-"));
  const filePath = path.join(dir, "orphan.txt");
  await writeFile(filePath, "not in any repo\n");

  const { observed_on_ref, observed_on_ref_error } = resolveObservedRef({ path: filePath, ref: null });
  assert.equal(observed_on_ref, "working-tree");
  assert.equal(observed_on_ref_error, null);
});

test("resolveObservedRef: no path at all still never invents a ref, and is not treated as a failure", () => {
  const { observed_on_ref, observed_on_ref_error } = resolveObservedRef({ path: undefined, ref: null });
  assert.equal(observed_on_ref, "working-tree");
  assert.equal(observed_on_ref_error, null);
});

// ─────────────────────────────────────────────────────────────────────────
// resolveObservedPosition — commit/branch/dirty, and dirty-tree honesty.
// ─────────────────────────────────────────────────────────────────────────

test("resolveObservedPosition: a clean committed repo reports the real HEAD sha, branch, and dirty:false", async () => {
  const repo = await makeTempRepo();
  const filePath = path.join(repo, "file.txt");
  await writeFile(filePath, "hello\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "initial"], repo);
  const realSha = git(["rev-parse", "HEAD"], repo);

  const pos = resolveObservedPosition(filePath);
  assert.equal(pos.observed_at_commit, realSha);
  assert.equal(pos.observed_on_branch, "main");
  assert.equal(pos.observed_dirty, false);
  assert.equal(pos.observed_position_error, null);
});

// RED test #3 (brief §"RED first" item 3): observing against a DIRTY tree
// must set observed_dirty: true.
test("resolveObservedPosition: an uncommitted change makes observed_dirty true", async () => {
  const repo = await makeTempRepo();
  const filePath = path.join(repo, "file.txt");
  await writeFile(filePath, "hello\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "initial"], repo);
  const realSha = git(["rev-parse", "HEAD"], repo);

  // Mutate after the commit, without committing again.
  await writeFile(filePath, "hello, but dirty now\n");

  const pos = resolveObservedPosition(filePath);
  assert.equal(pos.observed_dirty, true, "a dirty working tree must be recorded, never silently treated as clean");
  // The commit is still reported (it's the real HEAD) — observed_dirty is
  // what tells a reader the content hashed was never actually AT that
  // commit; the commit alone must never be read as attributing it.
  assert.equal(pos.observed_at_commit, realSha);
});

test("resolveObservedPosition: an untracked new file also makes observed_dirty true", async () => {
  const repo = await makeTempRepo();
  const filePath = path.join(repo, "file.txt");
  await writeFile(filePath, "hello\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "initial"], repo);

  await writeFile(path.join(repo, "new-untracked.txt"), "surprise\n");

  const pos = resolveObservedPosition(filePath);
  assert.equal(pos.observed_dirty, true);
});

test("resolveObservedPosition: a repo with no commits yet degrades to all-null plus a position error, never throws", async () => {
  const repo = await makeTempRepo();
  const filePath = path.join(repo, "untracked.txt");
  await writeFile(filePath, "no commits yet\n");

  assert.doesNotThrow(() => resolveObservedPosition(filePath));
  const pos = resolveObservedPosition(filePath);
  assert.equal(pos.observed_at_commit, null);
  assert.equal(pos.observed_on_branch, null);
  assert.equal(pos.observed_dirty, null);
  assert.ok(pos.observed_position_error && pos.observed_position_error.length > 0);
});

test("resolveObservedPosition: no path is all-null with no error (nothing to resolve, not a failure)", () => {
  const pos = resolveObservedPosition(undefined);
  assert.deepEqual(pos, {
    observed_at_commit: null,
    observed_on_branch: null,
    observed_dirty: null,
    observed_position_error: null,
  });
});

// ─────────────────────────────────────────────────────────────────────────
// resolveByKind
// ─────────────────────────────────────────────────────────────────────────

test("resolveByKind: falls back to the caller's default when PROPAGATE_BY_KIND is unset", () => {
  delete process.env.PROPAGATE_BY_KIND;
  assert.equal(resolveByKind("human"), "human");
  assert.equal(resolveByKind("bootstrap"), "bootstrap");
});

test("resolveByKind: PROPAGATE_BY_KIND overrides the default when it's one of the valid kinds", () => {
  const prior = process.env.PROPAGATE_BY_KIND;
  try {
    process.env.PROPAGATE_BY_KIND = "hook";
    assert.equal(resolveByKind("human"), "hook");
  } finally {
    if (prior === undefined) delete process.env.PROPAGATE_BY_KIND;
    else process.env.PROPAGATE_BY_KIND = prior;
  }
});

test("resolveByKind: an invalid PROPAGATE_BY_KIND value is ignored, falling back to the default", () => {
  const prior = process.env.PROPAGATE_BY_KIND;
  try {
    process.env.PROPAGATE_BY_KIND = "not-a-real-kind";
    assert.equal(resolveByKind("digest"), "digest");
  } finally {
    if (prior === undefined) delete process.env.PROPAGATE_BY_KIND;
    else process.env.PROPAGATE_BY_KIND = prior;
  }
});

test("BY_KINDS names exactly the five kinds the plan specifies", () => {
  assert.deepEqual([...BY_KINDS].sort(), ["agent", "bootstrap", "digest", "hook", "human"]);
});

// ─────────────────────────────────────────────────────────────────────────
// resolveProvenance — the combined shape the three call sites spread into
// an event payload.
// ─────────────────────────────────────────────────────────────────────────

test("resolveProvenance: a clean row produces all six fields, no error keys present", async () => {
  const repo = await makeTempRepo();
  const filePath = path.join(repo, "src.txt");
  await writeFile(filePath, "hello\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "initial"], repo);
  const realSha = git(["rev-parse", "HEAD"], repo);

  const row = { source: { path: filePath, ref: null } };
  const out = resolveProvenance(row, "human");

  assert.equal(out.observed_on_ref, "working-tree");
  assert.equal(out.observed_at_commit, realSha);
  assert.equal(out.observed_on_branch, "main");
  assert.equal(out.observed_dirty, false);
  assert.equal(out.by_kind, "human");
  assert.ok(!("observed_on_ref_error" in out), "no error key on a clean resolution");
  assert.ok(!("observed_position_error" in out), "no error key on a clean resolution");
});

test("resolveProvenance: an explicit ref bypasses ref resolution but position is still resolved from the real repo", async () => {
  const repo = await makeTempRepo();
  const filePath = path.join(repo, "src.txt");
  await writeFile(filePath, "hello\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "initial"], repo);

  const row = { source: { path: filePath, ref: "some-other-branch" } };
  const out = resolveProvenance(row, "bootstrap");

  assert.equal(out.observed_on_ref, "some-other-branch");
  assert.equal(out.observed_on_branch, "main", "position resolution reads the CURRENT repo state, independent of the explicit ref");
  assert.equal(out.by_kind, "bootstrap");
});
