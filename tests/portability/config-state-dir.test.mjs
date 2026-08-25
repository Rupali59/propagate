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
 * Test 1 below WAS "prove the defaults are unchanged" — that resolved paths equal
 * SKILL_DIR when PROPAGATE_STATE_DIR is unset. Its stated reason was that otherwise
 * "the live watcher loses its mtime baseline on the next run".
 *
 * CHANGED DELIBERATELY 2026-08-20, not tuned until it passed. That watcher was RETIRED
 * 2026-08-14 and refuses to run; `state.json` is a fossil `doctor` now reports as info
 * (GOTCHAS G50). The harm the guard named no longer exists, while the arrangement it
 * protected did real damage: state lived beside the code, in the directory a
 * marketplace update replaces wholesale, and the test suite appended 1170 bytes to a
 * production `watcher.log` on every run (2.9 MB accumulated).
 *
 * The general form of G12 — "a default that moves loses state silently" — still binds,
 * and is discharged by lib/setup.mjs migrateLegacyState(), which MOVES the live
 * artifacts rather than orphaning them. Guarded by tests/setup-migration.test.mjs.
 *
 * So the invariant flips: the default is now ~/.propagate, and the thing asserted is
 * that NO state path resolves inside the skill directory
 * (tests/state-isolation.test.mjs).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SKILL_DIR } from "../../lib/core/config.mjs";

/** The default state home, as of 2026-08-20. Was SKILL_DIR; see the header. */
const DEFAULT_STATE_DIR = path.join(os.homedir(), ".propagate");

const HELPER_PATH = fileURLToPath(new URL("../helpers/print-config-paths.mjs", import.meta.url));

/** A harmless empty scratch dir, so discovery at import-time has nothing real to walk. */
async function emptySearchRoot() {
  return mkdtemp(path.join(tmpdir(), "config-state-dir-search-"));
}

function runHelper(env) {
  // `undefined` DELETES the variable rather than inheriting it. Spreading process.env
  // meant the "PROPAGATE_STATE_DIR is unset" cases silently inherited whatever the
  // runner exported — and once npm test began setting it (2026-08-20, to stop the
  // suite writing production state), the unset case stopped being unset and the test
  // was asserting on the runner's value. A case that cannot reach the state it names
  // is a case that proves nothing.
  const merged = { ...process.env, ...env };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete merged[k];
  const result = spawnSync(process.execPath, [HELPER_PATH], {
    encoding: "utf8",
    env: merged,
  });
  assert.equal(result.status, 0, `helper subprocess failed: ${result.stderr}`);
  return JSON.parse(result.stdout.trim().split("\n").pop());
}

test("defaults unchanged: resolved paths equal today's literals when PROPAGATE_STATE_DIR is unset", async () => {
  const searchRoot = await emptySearchRoot();
  try {
    // `undefined`, NOT `delete`. runHelper spreads process.env first, so a key that is
    // merely absent from the override is re-supplied by the parent — which is exactly
    // what happened once npm test started exporting PROPAGATE_STATE_DIR. Present-and-
    // undefined is the only form that can unset.
    const paths = runHelper({ PROPAGATE_SEARCH_ROOTS: searchRoot, PROPAGATE_STATE_DIR: undefined });

    assert.equal(paths.STATE_DIR, DEFAULT_STATE_DIR, "STATE_DIR defaults to ~/.propagate when unset");
    assert.equal(paths.STATE_PATH, path.join(DEFAULT_STATE_DIR, "state.json"));
    assert.equal(paths.LOCK_PATH, path.join(DEFAULT_STATE_DIR, ".lock-target"));
    assert.equal(paths.HEARTBEAT_PATH, path.join(DEFAULT_STATE_DIR, "heartbeat"));
    assert.equal(paths.WATCHER_LOG, path.join(DEFAULT_STATE_DIR, "watcher.log"));
    assert.equal(
      paths.PLIST_PATH,
      path.join(os.homedir(), "Library", "LaunchAgents", `${paths.LABEL}.plist`),
      "PLIST_PATH must still resolve under ~/Library/LaunchAgents when STATE_DIR is unset",
    );
  } finally {
    await rm(searchRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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
    assert.notEqual(paths.STATE_PATH, path.join(DEFAULT_STATE_DIR, "state.json"));
    assert.notEqual(
      paths.PLIST_PATH,
      path.join(os.homedir(), "Library", "LaunchAgents", `${paths.LABEL}.plist`),
    );
  } finally {
    await rm(searchRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    await rm(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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
    await rm(searchRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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
    assert.equal(paths.STATE_DIR, DEFAULT_STATE_DIR, "an unusable explicit override degrades to the DEFAULT state dir, not to the skill dir");
    assert.equal(paths.STATE_PATH, path.join(DEFAULT_STATE_DIR, "state.json"));
    assert.equal(
      paths.PLIST_PATH,
      path.join(os.homedir(), "Library", "LaunchAgents", `${paths.LABEL}.plist`),
    );
  } finally {
    await rm(searchRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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
    assert.equal(paths.STATE_DIR, DEFAULT_STATE_DIR);
    assert.equal(paths.STATE_PATH, path.join(DEFAULT_STATE_DIR, "state.json"));
  } finally {
    await rm(searchRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
