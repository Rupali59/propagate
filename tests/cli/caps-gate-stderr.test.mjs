/**
 * caps-gate-stderr.test.mjs — the REAL `caps --gate` must not leak git's stderr (#69).
 *
 * capsGate() takes `runGit` by injection, and every unit test passes a fake, so the
 * production runGit in cli.mjs was executed by nothing. It called execFileSync with no
 * `stdio`, and Node forwards a child's stderr to the parent's by default. So a staged
 * deletion, which capsGate correctly probes and catches as "deleted in this commit",
 * still printed git's own `fatal: path ... does not exist` into every commit that
 * removed a file. The result was right and the output said it had failed.
 * This runs the actual CLI in a throwaway repo — the arm no other test reaches.
 */
// @size medium — starts processes (CLI or script); run when affected
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const CLI = path.join(import.meta.dirname, "../../cli.mjs");

test("#69: caps --gate on a staged deletion prints no git fatal and still allows it", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "caps-gate-"));
  try {
    const git = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio: "ignore" });
    git("init", "-q");
    git("config", "user.email", "t@example.invalid");
    git("config", "user.name", "t");
    writeFileSync(path.join(dir, "gone.md"), "# soon deleted\n");
    git("add", "gone.md");
    git("commit", "-q", "-m", "seed");
    git("rm", "-q", "gone.md");

    const env = { ...process.env, PROPAGATE_STATE_DIR: mkdtempSync(path.join(tmpdir(), "caps-state-")) };
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, [CLI, "caps", "--gate", "--json"], { cwd: dir, env, encoding: "utf8", timeout: 60000 });

    assert.doesNotMatch(r.stderr, /fatal:/, `git's stderr leaked through the gate: ${r.stderr.trim()}`);
    assert.match(r.stdout + r.stderr, /deleted in this commit|gone\.md|staged/i,
      "the gate must still see the staged deletion — an empty run would pass the stderr check vacuously");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
