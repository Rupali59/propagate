/**
 * regeneratePlist's 0-watch-roots guard (docs/ISSUES.md N14).
 *
 * A plist with zero WatchPaths is never a legitimate outcome -- it is always
 * either a misconfiguration (bad SEARCH_ROOTS) or a deliberately scoped run,
 * and writing it over a working plist silently disarms file-event watching
 * (launchd stays loaded but only fires on the StartInterval poll, never on
 * file events -- the exact shape of the live incident this closes).
 *
 * Scoped via BOTH PROPAGATE_SEARCH_ROOTS and PROPAGATE_STATE_DIR (as the task
 * requires) so this test can never touch the real plist even if the guard
 * being tested were broken. Runs through a subprocess helper
 * (tests/helpers/regenerate-plist.mjs) because PLIST_PATH is a module-level
 * const resolved from PROPAGATE_STATE_DIR at import time -- a fresh process
 * per case is the only way to vary it (same pattern as tests/doctor.test.mjs).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HELPER_PATH = fileURLToPath(new URL("../helpers/regenerate-plist.mjs", import.meta.url));

async function freshStateDir() {
  return mkdtemp(path.join(tmpdir(), "plist-watch-roots-state-"));
}

function runRegenerate(stateDir, workspaces) {
  const result = spawnSync(process.execPath, [HELPER_PATH, JSON.stringify(workspaces)], {
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

test("regeneratePlist refuses to write when discovered workspaces is empty (0 watch roots)", async () => {
  const stateDir = await freshStateDir();
  try {
    const out = runRegenerate(stateDir, []);

    assert.equal(out.ok, false, "must refuse, not silently succeed");
    assert.match(out.error, /0 watch roots|zero/i);
    assert.equal(out.path, out.resolvedPlistPath);
    assert.equal(existsSync(out.resolvedPlistPath), false, "must not write anything to disk");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("regeneratePlist writes as before when N>0 workspaces are given", async () => {
  const stateDir = await freshStateDir();
  const fakeWsRoot = await mkdtemp(path.join(tmpdir(), "plist-watch-roots-ws-"));
  try {
    const out = runRegenerate(stateDir, [{ name: "fake", root: fakeWsRoot }]);

    assert.equal(out.ok, true);
    assert.deepEqual(out.watchedRoots, [fakeWsRoot]);
    assert.equal(existsSync(out.resolvedPlistPath), true, "must write the plist");
    const content = await readFile(out.resolvedPlistPath, "utf8");
    assert.match(content, /<key>WatchPaths<\/key>/);
    assert.match(content, new RegExp(fakeWsRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await rm(stateDir, { recursive: true, force: true });
    await rm(fakeWsRoot, { recursive: true, force: true });
  }
});
