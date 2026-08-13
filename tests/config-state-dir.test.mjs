/**
 * PROPAGATE_STATE_DIR (docs/ISSUES.md N13/N14) — the one override that
 * relocates state.json (+ .bak), the lock file, the heartbeat, the watcher
 * log, AND the plist together.
 *
 * lib/config.mjs and lib/plist.mjs compute these as module-level consts at
 * import time, so exercising different env combinations requires a fresh
 * subprocess per case (tests/helpers/print-config-paths.mjs), not an
 * in-process re-import — same pattern as tests/doctor.test.mjs.
 *
 * Test 1 below is the regression guard STOP-phase Phase B asked for by name:
 * "prove the defaults are unchanged" — if this ever fails, the live watcher
 * loses its mtime baseline on the next run and every tracked file re-fires as
 * first-observation (N13, again, self-inflicted).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SKILL_DIR } from "../lib/config.mjs";

const HELPER_PATH = fileURLToPath(new URL("./helpers/print-config-paths.mjs", import.meta.url));

/** A harmless empty scratch dir, so discovery at import-time has nothing real to walk. */
async function emptySearchRoot() {
  return mkdtemp(path.join(tmpdir(), "config-state-dir-search-"));
}

function runHelper(env) {
  const result = spawnSync(process.execPath, [HELPER_PATH], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  assert.equal(result.status, 0, `helper subprocess failed: ${result.stderr}`);
  return JSON.parse(result.stdout.trim().split("\n").pop());
}

test("defaults unchanged: resolved paths equal today's literals when PROPAGATE_STATE_DIR is unset", async () => {
  const searchRoot = await emptySearchRoot();
  try {
    const env = { ...process.env, PROPAGATE_SEARCH_ROOTS: searchRoot };
    delete env.PROPAGATE_STATE_DIR;
    const paths = runHelper(env);

    assert.equal(paths.STATE_DIR, null, "STATE_DIR must be null (default) when unset");
    assert.equal(paths.STATE_PATH, path.join(SKILL_DIR, "state.json"));
    assert.equal(paths.LOCK_PATH, path.join(SKILL_DIR, ".lock-target"));
    assert.equal(paths.HEARTBEAT_PATH, path.join(SKILL_DIR, "heartbeat"));
    assert.equal(paths.WATCHER_LOG, path.join(SKILL_DIR, "watcher.log"));
    assert.equal(
      paths.PLIST_PATH,
      path.join(os.homedir(), "Library", "LaunchAgents", `${paths.LABEL}.plist`),
      "PLIST_PATH must still resolve under ~/Library/LaunchAgents when STATE_DIR is unset",
    );
  } finally {
    await rm(searchRoot, { recursive: true, force: true });
  }
});

test("PROPAGATE_STATE_DIR relocates state, lock, heartbeat, watcher log AND the plist together", async () => {
  const searchRoot = await emptySearchRoot();
  const stateDir = await mkdtemp(path.join(tmpdir(), "config-state-dir-target-"));
  try {
    const env = {
      ...process.env,
      PROPAGATE_SEARCH_ROOTS: searchRoot,
      PROPAGATE_STATE_DIR: stateDir,
    };
    const paths = runHelper(env);

    assert.equal(paths.STATE_DIR, path.resolve(stateDir));
    assert.equal(paths.STATE_PATH, path.join(stateDir, "state.json"));
    assert.equal(paths.LOCK_PATH, path.join(stateDir, ".lock-target"));
    assert.equal(paths.HEARTBEAT_PATH, path.join(stateDir, "heartbeat"));
    assert.equal(paths.WATCHER_LOG, path.join(stateDir, "watcher.log"));
    assert.equal(paths.PLIST_PATH, path.join(stateDir, `${paths.LABEL}.plist`));

    // Not one of them still points at the production location.
    assert.notEqual(paths.STATE_PATH, path.join(SKILL_DIR, "state.json"));
    assert.notEqual(
      paths.PLIST_PATH,
      path.join(os.homedir(), "Library", "LaunchAgents", `${paths.LABEL}.plist`),
    );
  } finally {
    await rm(searchRoot, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("PROPAGATE_STATE_DIR relocates into a directory that doesn't exist yet (created on demand)", async () => {
  const searchRoot = await emptySearchRoot();
  const parent = await mkdtemp(path.join(tmpdir(), "config-state-dir-parent-"));
  const stateDir = path.join(parent, "nested", "state-dir");
  try {
    const env = {
      ...process.env,
      PROPAGATE_SEARCH_ROOTS: searchRoot,
      PROPAGATE_STATE_DIR: stateDir,
    };
    const paths = runHelper(env);
    assert.equal(paths.STATE_DIR, path.resolve(stateDir));
    assert.equal(paths.STATE_PATH, path.join(stateDir, "state.json"));
  } finally {
    await rm(searchRoot, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test("a bad PROPAGATE_STATE_DIR (a file, not a directory) warns and falls back to defaults; config.mjs does not throw", async () => {
  const searchRoot = await emptySearchRoot();
  const parent = await mkdtemp(path.join(tmpdir(), "config-state-dir-badfile-"));
  const notADir = path.join(parent, "im-a-file");
  await writeFile(notADir, "not a directory\n", "utf8");
  try {
    const result = spawnSync(process.execPath, [HELPER_PATH], {
      encoding: "utf8",
      env: {
        ...process.env,
        PROPAGATE_SEARCH_ROOTS: searchRoot,
        PROPAGATE_STATE_DIR: notADir,
      },
    });
    assert.equal(result.status, 0, `module load must not throw/crash: ${result.stderr}`);
    assert.match(result.stderr, /PROPAGATE_STATE_DIR/, "a warning is logged naming the env var");
    assert.match(result.stderr, /falling back/i);

    const paths = JSON.parse(result.stdout.trim().split("\n").pop());
    assert.equal(paths.STATE_DIR, null, "falls back to the default (null) state dir");
    assert.equal(paths.STATE_PATH, path.join(SKILL_DIR, "state.json"));
    assert.equal(
      paths.PLIST_PATH,
      path.join(os.homedir(), "Library", "LaunchAgents", `${paths.LABEL}.plist`),
    );
  } finally {
    await rm(searchRoot, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test("an unwritable PROPAGATE_STATE_DIR parent (nonexistent, uncreatable) warns and falls back, never throws", async () => {
  const searchRoot = await emptySearchRoot();
  // A path under /dev/null cannot be mkdir'd -- reliable cross-platform "uncreatable" case.
  const uncreatable = path.join("/dev/null", "cannot-make-this");
  try {
    const result = spawnSync(process.execPath, [HELPER_PATH], {
      encoding: "utf8",
      env: {
        ...process.env,
        PROPAGATE_SEARCH_ROOTS: searchRoot,
        PROPAGATE_STATE_DIR: uncreatable,
      },
    });
    assert.equal(result.status, 0, `module load must not throw/crash: ${result.stderr}`);
    assert.match(result.stderr, /PROPAGATE_STATE_DIR/);
    const paths = JSON.parse(result.stdout.trim().split("\n").pop());
    assert.equal(paths.STATE_DIR, null);
    assert.equal(paths.STATE_PATH, path.join(SKILL_DIR, "state.json"));
  } finally {
    await rm(searchRoot, { recursive: true, force: true });
  }
});
