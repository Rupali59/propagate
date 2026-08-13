/**
 * G1 — `check --range` shell-injection (docs/ISSUES.md G1).
 *
 * Pre-fix, `cli.mjs:923` built a command STRING (`git diff --name-only
 * ${range}`) and ran it through `execSync`, which spawns a shell. Any shell
 * metacharacter in `--range` — a value that, per SKILL.md/docs/REFERENCE.md,
 * a pre-push hook feeds from attacker-controlled ref names on `stdin` —
 * executed as a second command.
 *
 * Fix: `gitDiffNames` now takes an argv ARRAY and runs `execFileSync("git",
 * args, ...)`, which never spawns a shell — the hostile string is passed to
 * git as one literal argument (an invalid revision), git errors out, and
 * `check` exits 2. No side effect.
 *
 * These tests exercise the real CLI as a subprocess (not the exported core),
 * because the vulnerability lived in `check()`'s argv handling and the
 * `execFileSync` call itself — the exact path a git hook would take.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { gitDiffNames } from "../cli.mjs";

const CLI_PATH = fileURLToPath(new URL("../cli.mjs", import.meta.url));

/** Build a throwaway git repo with two commits, returning root + both shas. */
async function makeGitRepo() {
  const root = await mkdtemp(path.join(tmpdir(), "chk-inject-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");

  await writeFile(path.join(root, "a.txt"), "v1\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "first");
  const sha1 = git("rev-parse", "HEAD").trim();

  await writeFile(path.join(root, "a.txt"), "v2\n");
  await writeFile(path.join(root, "b.txt"), "new file\n");
  git("add", "-A");
  git("commit", "-q", "-m", "second");
  const sha2 = git("rev-parse", "HEAD").trim();

  return { root, sha1, sha2 };
}

/** Run `node cli.mjs check ...` as a real subprocess, isolated from the real workspace tree. */
function runCli(args, cwd) {
  return spawnSync(process.execPath, [CLI_PATH, "check", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, PROPAGATE_SEARCH_ROOTS: cwd },
  });
}

test("gitDiffNames: hostile --range with ';' does not execute a second command", async () => {
  const { root, sha1 } = await makeGitRepo();
  const marker = path.join(tmpdir(), `propagate-pwned-${randomUUID()}`);
  try {
    const hostileRange = `${sha1}; touch ${marker}`;
    const result = runCli(["--range", hostileRange], root);

    assert.equal(
      existsSync(marker),
      false,
      "the injected `touch` must never run — execFileSync passes the whole string as one git argument",
    );
    // git rejects the bogus revision spec; gitDiffNames reports the failure
    // and exits 2 rather than silently swallowing it.
    assert.equal(result.status, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(marker, { force: true });
  }
});

test("gitDiffNames: hostile --range with $(...) command substitution does not execute", async () => {
  const { root, sha1 } = await makeGitRepo();
  const marker = path.join(tmpdir(), `propagate-pwned-${randomUUID()}`);
  try {
    const hostileRange = `${sha1}..$(touch ${marker})`;
    const result = runCli(["--range", hostileRange], root);

    assert.equal(
      existsSync(marker),
      false,
      "command substitution must never execute — there is no shell in the execFileSync path",
    );
    assert.equal(result.status, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(marker, { force: true });
  }
});

test("gitDiffNames: hostile --staged-adjacent backtick payload does not execute", async () => {
  const { root, sha1 } = await makeGitRepo();
  const marker = path.join(tmpdir(), `propagate-pwned-${randomUUID()}`);
  try {
    const hostileRange = "`touch " + marker + "`";
    const result = runCli(["--range", hostileRange], root);

    assert.equal(existsSync(marker), false, "backtick command substitution must never execute");
    assert.equal(result.status, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(marker, { force: true });
  }
});

test("check --range: legitimate range still returns the right changed files (behaviour preserved)", async () => {
  const { root, sha1, sha2 } = await makeGitRepo();
  try {
    const result = runCli(["--range", `${sha1}..${sha2}`, "--json"], root);
    assert.equal(result.status, 0);
    const parsed = JSON.parse(result.stdout);
    assert.deepEqual(parsed.changedFiles.sort(), ["a.txt", "b.txt"]);
    assert.equal(parsed.exitCode, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("gitDiffNames (direct): legitimate array-form git diff resolves the right files", async () => {
  const { root, sha1, sha2 } = await makeGitRepo();
  try {
    const files = gitDiffNames(["diff", "--name-only", `${sha1}..${sha2}`], root);
    assert.deepEqual(files.sort(), ["a.txt", "b.txt"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
