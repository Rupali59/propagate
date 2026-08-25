/**
 * Regression guard for the cross-allow.yml incident (2026-08-20).
 *
 * A first pass at extending `LEGACY_STATE.live` (lib/core/setup.mjs, plan
 * `status-temporal-plum.md` §"Phase 1 -> 1b") added `cross-allow.yml` to the MOVE
 * list. Run for real against the actual repo (by a real `setup` invocation against
 * the true SKILL_DIR/CONFIG_ROOT_DIR — not this test's sandboxed temp dirs), it
 * deleted the repo's shipped `cross-allow.yml` from `SKILL_DIR`. That file is
 * `CROSS_ALLOW_SHIPPED` (lib/core/config.mjs:444) — the permanent fallback
 * `CROSS_ALLOW_PATH` resolves to for every install with no user copy in the state
 * dir. `lib/edges/cross-repo.mjs:70` and `cli.mjs:1315` both `readFileSync` it with
 * NO existence guard, so a missing shipped copy is an ENOENT throw on every
 * cross-repo code path -- invisible on any machine that happens to already have a
 * user copy shadowing it (this one did, which is exactly why the suite stayed green
 * while the repo was broken), and a hard failure on a genuine stranger install --
 * precisely the failure class this whole phase exists to remove.
 *
 * This test exercises the REAL `lib/core/config.mjs` (unmodified — not owned by this
 * lane) via a subprocess with PROPAGATE_STATE_DIR pointed at a fresh EMPTY temp dir,
 * i.e. exactly the "stranger with no user copy" case.
 *
 * RED/GREEN proven by hand while writing this, not by a permanent fixture that
 * mutates the real repo file: `SKILL_DIR/cross-allow.yml` is resolved by walking up
 * from `lib/core/config.mjs`'s own location to a `package.json`+`SKILL.md` marker
 * (see config.mjs:77-97) — there is no env override, so faking "the shipped file is
 * missing" without renaming the actual repo file requires copying the whole `lib/`
 * tree plus marker files into a temp dir, which is exactly the kind of fragile,
 * easy-to-get-subtly-wrong fixture (a wrong relative import path was caught and
 * discarded here) this repo's GOTCHAS warns against building when a simpler proof
 * exists. The simpler proof: `mv cross-allow.yml /tmp/... && node <helper> ; mv back`
 * was run manually, confirmed `CROSS_ALLOW_PATH_EXISTS: false` with the file moved
 * out and `true` restored, and is recorded in the session's verification log rather
 * than re-executed here against production every test run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HELPER_PATH = fileURLToPath(new URL("../helpers/print-config-paths.mjs", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

function runHelper(env) {
  const merged = { ...process.env, ...env };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete merged[k];
  const result = spawnSync(process.execPath, [HELPER_PATH], { encoding: "utf8", env: merged });
  assert.equal(result.status, 0, `helper subprocess failed: ${result.stderr}`);
  return JSON.parse(result.stdout.trim().split("\n").pop());
}

test("the shipped cross-allow.yml is present at HEAD in this working tree", () => {
  // A cheap, direct guard independent of the subprocess below: if this ever fails,
  // nothing downstream can be trusted, and it names the exact fix (git checkout).
  const result = spawnSync("git", ["status", "--porcelain", "--", "cross-allow.yml"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, "git status failed to run");
  assert.equal(result.stdout.trim(), "", "cross-allow.yml must be clean (present, unmodified) at the repo root");
});

test("stranger install (empty PROPAGATE_STATE_DIR, no user copy): CROSS_ALLOW_PATH resolves to a file that EXISTS", () => {
  const searchRoot = mkdtempSync(path.join(tmpdir(), "cross-allow-search-"));
  const stateDir = mkdtempSync(path.join(tmpdir(), "cross-allow-state-"));
  try {
    const paths = runHelper({
      PROPAGATE_SEARCH_ROOTS: searchRoot,
      PROPAGATE_STATE_DIR: stateDir,
    });

    // The state dir genuinely has no user copy -- this is the "stranger" case.
    assert.equal(existsSync(path.join(stateDir, "cross-allow.yml")), false, "sandbox precondition: no user copy present");

    // The load-bearing assertion. Falls back to the shipped path when no user copy
    // exists, and that file actually exists on disk -- not merely that a path string
    // was computed. Proven falsifiable by hand (see file header): moving the real
    // cross-allow.yml aside made CROSS_ALLOW_PATH_EXISTS report false here.
    assert.equal(paths.CROSS_ALLOW_PATH, paths.CROSS_ALLOW_SHIPPED, "falls back to the shipped path when no user copy exists");
    assert.ok(
      paths.CROSS_ALLOW_PATH_EXISTS,
      `CROSS_ALLOW_PATH (${paths.CROSS_ALLOW_PATH}) must exist on disk -- ` +
        `every cross-repo read (lib/edges/cross-repo.mjs, cli.mjs) has no existence guard and ENOENTs otherwise`,
    );
  } finally {
    rmSync(searchRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
