/**
 * P3 (docs/plans -- "hooks + plists"): the three generated plists (watcher,
 * monitor, digest) must not bake in a version-pinned Homebrew node path, and
 * must follow the skill if it moves -- because until now the digest plist was
 * hand-maintained (lib/core/plist.mjs never wrote it) and the monitor plist
 * already carried a Cellar-versioned node path on this machine, one
 * `brew upgrade node` away from breaking (docs/GOTCHAS.md G48 shape).
 *
 * Two things asserted, both by regenerating and reading the actual XML, never
 * by trusting a comment:
 *   1. No `/opt/homebrew/Cellar/` in any generated ProgramArguments.
 *   2. Regenerating from a COPY of the skill at a different path produces
 *      plists whose ProgramArguments point at the COPY, not the original --
 *      proving SKILL_DIR (and therefore the node/script paths) are derived,
 *      not hardcoded.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, cp, symlink, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const HELPER_REL = "tests/helpers/plist-generate.mjs";

async function freshStateDir(prefix) {
  return mkdtemp(path.join(tmpdir(), prefix));
}

function runHelper(helperAbsPath, stateDir, workspaces) {
  const result = spawnSync(process.execPath, [helperAbsPath, JSON.stringify(workspaces)], {
    encoding: "utf8",
    env: {
      ...process.env,
      PROPAGATE_STATE_DIR: stateDir,
      PROPAGATE_SEARCH_ROOTS: stateDir, // harmless empty dir; discovery finds nothing real
    },
  });
  assert.equal(result.status, 0, `helper subprocess failed: ${result.stderr}`);
  return JSON.parse(result.stdout.trim().split("\n").pop());
}

test("generated plists never contain a version-pinned Homebrew Cellar node path", async () => {
  const stateDir = await freshStateDir("plist-relocation-cellar-");
  const wsRoot = await mkdtemp(path.join(tmpdir(), "plist-relocation-ws-"));
  try {
    const helperAbsPath = path.join(REPO_ROOT, HELPER_REL);
    const out = runHelper(helperAbsPath, stateDir, [{ name: "fake", root: wsRoot }]);

    for (const [label, entry] of Object.entries({ watcher: out.watcher, monitor: out.monitor, digest: out.digest })) {
      assert.equal(entry.ok, true, `${label}: expected ok, got ${JSON.stringify(entry)}`);
      const content = await readFile(entry.resolvedPath, "utf8");
      assert.doesNotMatch(content, /\/opt\/homebrew\/Cellar\//, `${label} plist must not pin a Cellar-versioned node path`);
      assert.match(content, /<key>ProgramArguments<\/key>/);
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    await rm(wsRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("regenerating from a relocated copy of the skill produces the relocated path, not the original", async () => {
  const stateDir = await freshStateDir("plist-relocation-move-");
  const wsRoot = await mkdtemp(path.join(tmpdir(), "plist-relocation-ws-"));
  const skillCopy = await mkdtemp(path.join(tmpdir(), "plist-relocation-skillcopy-"));
  try {
    // Copy everything the import chain needs, minus node_modules (symlinked --
    // config.mjs imports `yaml`, and copying node_modules would be ~4MB of
    // pointless I/O per run). .git is skipped too; irrelevant to module resolution.
    for (const entry of ["cli.mjs", "digest.mjs", "package.json", "SKILL.md", "lib", "tests"]) {
      const src = path.join(REPO_ROOT, entry);
      if (existsSync(src)) {
        await cp(src, path.join(skillCopy, entry), { recursive: true });
      }
    }
    await symlink(path.join(REPO_ROOT, "node_modules"), path.join(skillCopy, "node_modules"));

    // Resolve realpaths: tmpdir() returns /var/... on macOS, which is a symlink to
    // /private/var/...; SKILL_DIR walks a resolved fileURLToPath, so it reports the
    // realpath. Compare like with like rather than asserting the pre-symlink form.
    const skillCopyReal = await realpath(skillCopy);
    const repoRootReal = await realpath(REPO_ROOT);

    const helperAbsPath = path.join(skillCopy, HELPER_REL);
    const out = runHelper(helperAbsPath, stateDir, [{ name: "fake", root: wsRoot }]);

    assert.equal(out.skillDir, skillCopyReal, "SKILL_DIR must self-locate to the copy, not the original checkout");
    assert.notEqual(out.skillDir, repoRootReal);

    for (const [label, entry, script] of [
      ["watcher", out.watcher, "watcher.mjs"],
      ["monitor", out.monitor, "cli.mjs"],
      ["digest", out.digest, "digest.mjs"],
    ]) {
      assert.equal(entry.ok, true, `${label}: expected ok, got ${JSON.stringify(entry)}`);
      const content = await readFile(entry.resolvedPath, "utf8");
      assert.match(
        content,
        new RegExp(path.join(skillCopyReal, script).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        `${label} plist must reference the relocated ${script}, not the original checkout`,
      );
      assert.doesNotMatch(
        content,
        new RegExp(repoRootReal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        `${label} plist must not still reference the original checkout path`,
      );
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    await rm(wsRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    await rm(skillCopy, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
