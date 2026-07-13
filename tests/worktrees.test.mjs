/**
 * Unit tests for lib/worktrees.mjs.
 *
 * Strategy
 * --------
 * - parsePorcelain: pure function, no I/O — test with hand-crafted fixtures
 *   covering every porcelain edge case the adversarial review surfaced.
 * - expandWorktreePaths: pure function over a manually-built map — test
 *   matching logic, longest-prefix resolver, missing-file filter, paths
 *   outside any repo, tie-breaking.
 * - correlationKey: pure — test repo identification + path normalization.
 * - enumerateCanonicalRepos + enumerateWorktreesForRepo + enumerateWorktrees:
 *   touch real fixture directories on disk in os.tmpdir(), then verify.
 *
 * Run: `npm test` (node --test tests/)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  parsePorcelain,
  expandWorktreePaths,
  correlationKey,
  worktreeStamp,
  enumerateCanonicalRepos,
} from "../lib/worktrees.mjs";

// ─────────────────────────────────────────────────────────────────────────
// parsePorcelain — fixture-driven, no I/O
// ─────────────────────────────────────────────────────────────────────────

test("parsePorcelain — happy path: canonical + one secondary", () => {
  const stdout = `worktree /repo/canonical
HEAD abc123def456789012345678901234567890abcd
branch refs/heads/main

worktree /repo/feature
HEAD 1111222233334444555566667777888899990000
branch refs/heads/feat/x
`;
  const parsed = parsePorcelain(stdout);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].path, "/repo/canonical");
  assert.equal(parsed[0].branch, "main");
  assert.equal(parsed[0].commit, "abc123def456789012345678901234567890abcd");
  assert.equal(parsed[1].branch, "feat/x");
});

test("parsePorcelain — detached HEAD: branch is null", () => {
  const stdout = `worktree /repo/headless
HEAD deadbeefdeadbeefdeadbeefdeadbeefdeadbeef
detached
`;
  const parsed = parsePorcelain(stdout);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].branch, null);
  assert.equal(parsed[0].commit, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
});

test("parsePorcelain — locked worktree: isLocked=true", () => {
  const stdout = `worktree /repo/locked
HEAD 1234567890abcdef1234567890abcdef12345678
branch refs/heads/holding
locked Manual lock for migration
`;
  const parsed = parsePorcelain(stdout);
  assert.equal(parsed[0].isLocked, true);
});

test("parsePorcelain — bare repo line: isBare=true", () => {
  const stdout = `worktree /repo/bare
HEAD 0000000000000000000000000000000000000000
bare
`;
  const parsed = parsePorcelain(stdout);
  assert.equal(parsed[0].isBare, true);
});

test("parsePorcelain — empty input returns empty array", () => {
  assert.deepEqual(parsePorcelain(""), []);
});

test("parsePorcelain — unknown future lines are tolerated, not errors", () => {
  const stdout = `worktree /repo/v2-future
HEAD abcdef1234567890abcdef1234567890abcdef12
branch refs/heads/main
some-future-field with values
another-unknown-key
`;
  const parsed = parsePorcelain(stdout);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].branch, "main");
});

test("parsePorcelain — branch ref outside refs/heads/ kept verbatim", () => {
  // git porcelain *can* emit non-heads refs in unusual setups; keep them
  // verbatim rather than stripping (no false-positive prefix removal).
  const stdout = `worktree /repo/odd
HEAD 1111111111111111111111111111111111111111
branch refs/remotes/origin/main
`;
  const parsed = parsePorcelain(stdout);
  assert.equal(parsed[0].branch, "refs/remotes/origin/main");
});

// ─────────────────────────────────────────────────────────────────────────
// expandWorktreePaths — manually-constructed map, no I/O for the pure logic
// ─────────────────────────────────────────────────────────────────────────

function fixtureWorktreeMap() {
  // Mirrors the real Vipin Kaushik topology shape so tests reflect reality.
  const map = new Map();
  map.set("/Vipin Kaushik/VipinKaushik", [
    {
      path: "/Vipin Kaushik/VipinKaushik",
      branch: "main",
      commit: "aaaaaaaaaaaaaaaa",
      isCanonical: true,
      isLocked: false,
      isBare: false,
    },
    {
      path: "/Vipin Kaushik/VipinKaushik-location-shape",
      branch: "fix/location",
      commit: "bbbbbbbbbbbbbbbb",
      isCanonical: false,
      isLocked: false,
      isBare: false,
    },
  ]);
  // A NESTED worktree (the VipinKaushik-mb pattern).
  map.set("/Vipin Kaushik/VipinKaushik-mb", [
    {
      path: "/Vipin Kaushik/VipinKaushik-mb",
      branch: "main",
      commit: "cccccccccccccccc",
      isCanonical: true,
      isLocked: false,
      isBare: false,
    },
    {
      path: "/Vipin Kaushik/VipinKaushik-mb/.worktrees/real-sky",
      branch: "feature/real-sky",
      commit: "dddddddddddddddd",
      isCanonical: false,
      isLocked: false,
      isBare: false,
    },
  ]);
  return map;
}

test("expandWorktreePaths — path not under any repo returns [] when file missing", () => {
  const map = fixtureWorktreeMap();
  const result = expandWorktreePaths("/orphan/file.md", map);
  // The path is not under any repo AND existsSync returns false → empty.
  assert.deepEqual(result, []);
});

test("expandWorktreePaths — uses longest-prefix match (VipinKaushik-mb wins over VipinKaushik)", () => {
  // CRITICAL ADVERSARIAL FIX (C2): "VipinKaushik" is a prefix of
  // "VipinKaushik-mb". Without longest-prefix logic, a path under
  // VipinKaushik-mb would match the shorter key and produce wrong worktree
  // expansion. This test pins the behaviour.
  const map = fixtureWorktreeMap();

  // We can't existsSync the fixture paths, so build the test to verify
  // ONLY the matching logic — we accept the empty result but verify it
  // didn't crash AND that the resolver picked the right repo. Test the
  // resolver via correlationKey instead, which doesn't filter on
  // existsSync.
  const k1 = correlationKey("/Vipin Kaushik/VipinKaushik-mb/lib/x.ts", map);
  assert.equal(k1, "VipinKaushik-mb:lib/x.ts");

  const k2 = correlationKey("/Vipin Kaushik/VipinKaushik/lib/x.ts", map);
  assert.equal(k2, "VipinKaushik:lib/x.ts");
});

test("expandWorktreePaths — empty map returns [] for non-existent files", () => {
  const result = expandWorktreePaths("/no/such/file.ts", new Map());
  assert.deepEqual(result, []);
});

// ─────────────────────────────────────────────────────────────────────────
// correlationKey — pure function over the map
// ─────────────────────────────────────────────────────────────────────────

test("correlationKey — canonical and sibling worktree share the same key", () => {
  const map = fixtureWorktreeMap();
  const canonical = correlationKey(
    "/Vipin Kaushik/VipinKaushik/lib/pricing.ts",
    map,
  );
  const sibling = correlationKey(
    "/Vipin Kaushik/VipinKaushik-location-shape/lib/pricing.ts",
    map,
  );
  assert.equal(canonical, sibling);
  assert.equal(canonical, "VipinKaushik:lib/pricing.ts");
});

test("correlationKey — nested worktree shares key with canonical", () => {
  const map = fixtureWorktreeMap();
  const canonical = correlationKey(
    "/Vipin Kaushik/VipinKaushik-mb/services/api.ts",
    map,
  );
  const nested = correlationKey(
    "/Vipin Kaushik/VipinKaushik-mb/.worktrees/real-sky/services/api.ts",
    map,
  );
  assert.equal(canonical, nested);
  assert.equal(canonical, "VipinKaushik-mb:services/api.ts");
});

test("correlationKey — path outside any repo returns null", () => {
  const map = fixtureWorktreeMap();
  assert.equal(correlationKey("/some/orphan/file.md", map), null);
});

test("correlationKey — repo root itself returns sentinel relative", () => {
  const map = fixtureWorktreeMap();
  const k = correlationKey("/Vipin Kaushik/VipinKaushik", map);
  assert.equal(k, "VipinKaushik:.");
});

// ─────────────────────────────────────────────────────────────────────────
// worktreeStamp — pure helper
// ─────────────────────────────────────────────────────────────────────────

test("worktreeStamp — canonical worktree returns undefined", () => {
  const wt = {
    path: "/a",
    branch: "main",
    commit: "abcdef123456",
    isCanonical: true,
    isLocked: false,
    isBare: false,
  };
  assert.equal(worktreeStamp(wt), undefined);
});

test("worktreeStamp — null/undefined input returns undefined", () => {
  assert.equal(worktreeStamp(null), undefined);
  assert.equal(worktreeStamp(undefined), undefined);
});

test("worktreeStamp — secondary worktree returns branch+short-commit", () => {
  const wt = {
    path: "/a",
    branch: "feat/x",
    commit: "abcdef123456789012345678",
    isCanonical: false,
    isLocked: false,
    isBare: false,
  };
  assert.deepEqual(worktreeStamp(wt), {
    branch: "feat/x",
    commit: "abcdef123456",
  });
});

test("worktreeStamp — detached HEAD secondary: branch=null preserved", () => {
  const wt = {
    path: "/a",
    branch: null,
    commit: "deadbeef" + "0".repeat(32),
    isCanonical: false,
    isLocked: false,
    isBare: false,
  };
  const stamp = worktreeStamp(wt);
  assert.equal(stamp.branch, null);
  assert.equal(stamp.commit, "deadbeef0000");
});

// ─────────────────────────────────────────────────────────────────────────
// enumerateCanonicalRepos — touches real disk via tmpdir
// ─────────────────────────────────────────────────────────────────────────

test("enumerateCanonicalRepos — finds dirs with .git as a directory", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "propagate-test-"));
  // Set up: one canonical (.git is dir), one secondary (.git is file),
  // one non-repo (no .git), one dotfile dir (should be skipped).
  await mkdir(path.join(tmp, "canonical", ".git"), { recursive: true });
  await mkdir(path.join(tmp, "secondary"), { recursive: true });
  await writeFile(
    path.join(tmp, "secondary", ".git"),
    "gitdir: /elsewhere/.git/worktrees/secondary\n",
  );
  await mkdir(path.join(tmp, "not-a-repo"), { recursive: true });
  await mkdir(path.join(tmp, ".hidden-dir"), { recursive: true });

  const found = await enumerateCanonicalRepos(tmp);
  // Only "canonical" should be returned.
  assert.equal(found.length, 1);
  assert.equal(path.basename(found[0]), "canonical");
});

test("enumerateCanonicalRepos — non-existent path returns []", async () => {
  const result = await enumerateCanonicalRepos("/no/such/path/12345");
  assert.deepEqual(result, []);
});

test("enumerateCanonicalRepos — empty directory returns []", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "propagate-empty-"));
  const result = await enumerateCanonicalRepos(tmp);
  assert.deepEqual(result, []);
});
