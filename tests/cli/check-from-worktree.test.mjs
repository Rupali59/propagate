/**
 * #333 — `check --changed` run from a linked worktree under `.claude/worktrees/<name>`
 * printed nothing, because discovery skips dot-directories. These run the real CLI.
 */
// @size medium — starts processes (CLI or script); run when affected

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI_PATH = fileURLToPath(new URL("../../cli.mjs", import.meta.url));

function runCheck(cwd, searchRoot) {
  return spawnSync(process.execPath, [CLI_PATH, "check", "--changed"], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, PROPAGATE_SEARCH_ROOTS: searchRoot },
  });
}

function vcs(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

test("check --changed from a .claude/worktrees path resolves the worktree's own sidecar", async () => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "chk-wt-")));
  const repo = path.join(base, "repo");
  try {
    await mkdir(repo);
    vcs(repo, "init", "-q", "-b", "main");
    vcs(repo, "config", "user.email", "t@example.com");
    vcs(repo, "config", "user.name", "T");
    await writeFile(
      path.join(repo, ".propagates.yml"),
      "workspace: true\nsources:\n  a.md:\n    propagates_to:\n      - path: b.md\n        why: b follows a\n",
    );
    await writeFile(path.join(repo, "a.md"), "v1\n");
    await writeFile(path.join(repo, "b.md"), "v1\n");
    await writeFile(path.join(repo, ".gitignore"), ".claude/\n");
    vcs(repo, "add", "-A");
    vcs(repo, "commit", "-q", "-m", "init");
    const wt = path.join(repo, ".claude", "worktrees", "feat-1-x");
    vcs(repo, "worktree", "add", "-q", "-b", "feat/1-x", wt);
    await writeFile(path.join(wt, "a.md"), "v2\n");

    // The search root holds no workspace: discovery cannot find the worktree.
    const empty = path.join(base, "empty");
    await mkdir(empty);
    const r = runCheck(wt, empty);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /a\.md → verify: b\.md/, `expected a coupling line, got: ${r.stdout}${r.stderr}`);
  } finally {
    await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("check --changed where no workspace resolves says so and exits non-zero", async () => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "chk-nows-")));
  try {
    vcs(base, "init", "-q", "-b", "main");
    vcs(base, "config", "user.email", "t@example.com");
    vcs(base, "config", "user.name", "T");
    await writeFile(path.join(base, "a.txt"), "x\n");
    vcs(base, "add", "-A");
    vcs(base, "commit", "-q", "-m", "init");
    const r = runCheck(base, path.join(base, "nowhere"));
    assert.notEqual(r.status, 0);
    const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(r.stderr, new RegExp(`no workspace resolved for ${escaped}`));
  } finally {
    await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
