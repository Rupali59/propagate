/**
 * `init` / `reload` split (docs/ISSUES.md N14, N15).
 *
 * Safety note: this file NEVER exercises reloadLaunchd()/launchctl, even
 * scoped or under a throwaway label. A launchd job's ProgramArguments carry
 * no environment, so if a scoped test job were ever left registered (e.g. a
 * crashed test skipping cleanup) it would run the REAL watcher.mjs against
 * REAL production paths once its StartInterval elapsed -- exactly the
 * outcome the task's safety section forbids ("never run the watcher against
 * the real workspaces during this task"). So:
 *
 *   - the `init` tests below run the real CLI as a subprocess, scoped via
 *     PROPAGATE_SEARCH_ROOTS + PROPAGATE_STATE_DIR, and assert the plist file
 *     is never written -- this is safe because `init` (per N14's fix) no
 *     longer calls regeneratePlist/reloadLaunchd at all, so nothing launchd
 *     can ever run is created.
 *   - the "reload does what init doesn't" half is proven at the source level
 *     (reload's body calls regeneratePlist + reloadLaunchd; init's does not)
 *     rather than by actually invoking `node cli.mjs reload`, which is the
 *     one command in this codebase that is *supposed* to touch real launchd
 *     state and therefore must stay manual/deliberate, never exercised by CI.
 *   - regeneratePlist's actual write behavior (the machinery `reload` calls)
 *     is covered separately, launchctl-free, in tests/plist-watch-roots.test.mjs.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, mkdir, readdir, writeFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI_PATH = fileURLToPath(new URL("../../cli.mjs", import.meta.url));

async function scopedRoots() {
  const searchRoot = await mkdtemp(path.join(tmpdir(), "init-reload-search-"));
  const stateDir = await mkdtemp(path.join(tmpdir(), "init-reload-state-"));
  return { searchRoot, stateDir };
}

function runCli(args, { searchRoot, stateDir }, extraEnv = {}) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PROPAGATE_SEARCH_ROOTS: searchRoot,
      PROPAGATE_STATE_DIR: stateDir,
      ...extraEnv,
    },
  });
}

test("init --workspace writes `workspace: true` and is discoverable (N15)", async () => {
  const roots = await scopedRoots();
  const target = path.join(roots.searchRoot, "new-project");
  await mkdir(target, { recursive: true });
  try {
    const result = runCli(["init", target, "--workspace"], roots);
    const out = result.stdout + result.stderr;
    assert.equal(result.status, 0, `init --workspace should succeed: ${out}`);
    assert.match(out, /verified: discoverable as a workspace/);

    const marker = await readFile(path.join(target, ".propagates.yml"), "utf8");
    assert.match(marker, /^workspace:\s*true\s*$/m);
  } finally {
    await rm(roots.searchRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    await rm(roots.stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("init --edges-only writes today's template and does NOT claim to be a workspace", async () => {
  const roots = await scopedRoots();
  const target = path.join(roots.searchRoot, "edges-only-project");
  await mkdir(target, { recursive: true });
  try {
    const result = runCli(["init", target, "--edges-only"], roots);
    const out = result.stdout + result.stderr;
    assert.equal(result.status, 0, `init --edges-only should succeed: ${out}`);
    assert.doesNotMatch(out, /verified: discoverable as a workspace/);
    assert.match(out, /edges-only sidecar/);

    const marker = await readFile(path.join(target, ".propagates.yml"), "utf8");
    assert.doesNotMatch(marker, /^workspace:\s*true\s*$/m);
  } finally {
    await rm(roots.searchRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    await rm(roots.stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("init defaults to --workspace when no flag is given", async () => {
  const roots = await scopedRoots();
  const target = path.join(roots.searchRoot, "default-flag-project");
  await mkdir(target, { recursive: true });
  try {
    const result = runCli(["init", target], roots);
    assert.equal(result.status, 0);
    const marker = await readFile(path.join(target, ".propagates.yml"), "utf8");
    assert.match(marker, /^workspace:\s*true\s*$/m);
  } finally {
    await rm(roots.searchRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    await rm(roots.stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("init --workspace exits non-zero when discovery still cannot see the new directory (N15)", async () => {
  const roots = await scopedRoots();
  // Deliberately OUTSIDE searchRoot, so discovery (scoped to searchRoot) can
  // never find it no matter what the marker says -- this is the "created but
  // not discoverable" failure the fix must catch and refuse to call success.
  const outsideDir = await mkdtemp(path.join(tmpdir(), "init-reload-outside-"));
  try {
    const result = runCli(["init", outsideDir, "--workspace"], roots);
    const out = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, `init must fail loudly, not report success: ${out}`);
    assert.match(out, /init failed/);
    assert.match(out, /not discoverable/);
    // The marker was still created -- init's failure is about the discovery
    // contract, not about refusing to write the file at all.
    assert.equal(existsSync(path.join(outsideDir, ".propagates.yml")), true);
  } finally {
    await rm(roots.searchRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    await rm(roots.stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    await rm(outsideDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("init never touches the plist (N14) — no plist file appears under the scoped state dir", async () => {
  const roots = await scopedRoots();
  const target = path.join(roots.searchRoot, "no-plist-project");
  await mkdir(target, { recursive: true });
  try {
    const result = runCli(["init", target, "--workspace"], roots);
    assert.equal(result.status, 0);

    const filesInStateDir = existsSync(roots.stateDir) ? await readdir(roots.stateDir) : [];
    const plistFiles = filesInStateDir.filter((f) => f.endsWith(".plist"));
    assert.deepEqual(plistFiles, [], "init must not write any .plist file");
  } finally {
    await rm(roots.searchRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    await rm(roots.stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("source wiring: init's body never calls regeneratePlist/reloadLaunchd; reload's body calls both", async () => {
  const src = await readFile(CLI_PATH, "utf8");

  const initMatch = src.match(/async function init\(targetDir[\s\S]*?\n}\n\n\/\*\*/);
  assert.ok(initMatch, "could not locate init() body for source inspection");
  const initBody = initMatch[0];
  assert.doesNotMatch(initBody, /regeneratePlist\(/, "init must not call regeneratePlist");
  assert.doesNotMatch(initBody, /reloadLaunchd\(/, "init must not call reloadLaunchd");

  const reloadMatch = src.match(/async function reload\(\)\s*\{[\s\S]*?\n}\n/);
  assert.ok(reloadMatch, "could not locate reload() body for source inspection");
  const reloadBody = reloadMatch[0];
  assert.match(reloadBody, /regeneratePlist\(/, "reload must call regeneratePlist");
  assert.match(reloadBody, /reloadLaunchd\(/, "reload must call reloadLaunchd");
});

test("`reload` is wired into the mode dispatch chain", async () => {
  const src = await readFile(CLI_PATH, "utf8");
  assert.match(src, /mode === "reload"/);
});

// ─────────────────────────────────────────────────────────────────────────
// `init` must ASSERT the ledger pair, not assume it — docs/ISSUES.md N24.
//
// N24 was filed after Obsidian and Motherboard both went doctor 1 -> 3 on
// 2026-08-14, immediately after a "successful" init, and both were fixed by
// hand. The defect is not that creation was missing — `init` is one of
// LEDGER_SCAFFOLDING_VERBS, so discovery does create the pair. It is that
// `ensureLedgerPair` is deliberately best-effort and silent, so when
// creation fails `init complete.` printed anyway: a success banner
// outranking a check that had just failed.
//
// The negative case is the one that matters. A test that only proves the
// happy path leaves exactly the check N24 asked for unverified.
// ─────────────────────────────────────────────────────────────────────────

test("init --workspace creates the CANONICAL propagation/ pair and says so", async () => {
  const roots = await scopedRoots();
  const target = path.join(roots.searchRoot, "canon-project");
  await mkdir(target, { recursive: true });
  try {
    const result = runCli(["init", target, "--workspace"], roots);
    const out = result.stdout + result.stderr;
    assert.equal(result.status, 0, `init should succeed: ${out}`);
    assert.match(out, /ledger pair created/);
    assert.match(out, /init complete/);
    assert.ok(existsSync(path.join(target, "propagation", "ledger.jsonl")));
    assert.ok(existsSync(path.join(target, "propagation", "ledger.md")));
    // The superseded layouts must NOT be created alongside it.
    assert.ok(!existsSync(path.join(target, ".propagation", "ledger.jsonl")));
    assert.ok(!existsSync(path.join(target, "docs", "PROPAGATION_LEDGER.jsonl")));
  } finally {
    await rm(roots.searchRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    await rm(roots.stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("init --workspace REFUSES to print `init complete.` when the ledger pair cannot be created", async () => {
  const roots = await scopedRoots();
  const target = path.join(roots.searchRoot, "readonly-project");
  await mkdir(target, { recursive: true });
  // Write the marker first, then make the directory unwritable: `init` finds
  // the marker already present, discovery resolves the workspace, and
  // ensureLedgerPair's mkdir fails — silently, by design. This is the real
  // shape of the N24 failure, not a mocked one.
  await writeFile(path.join(target, ".propagates.yml"), "workspace: true\n\nsources: {}\n");
  await chmod(target, 0o555);
  try {
    const result = runCli(["init", target, "--workspace"], roots);
    const out = result.stdout + result.stderr;
    assert.equal(result.status, 1, `init must exit non-zero when the pair is missing: ${out}`);
    assert.match(out, /init incomplete/);
    assert.match(out, /ledger\.jsonl/, "the failure must NAME the missing file");
    assert.doesNotMatch(
      out,
      /init complete/,
      "a success banner must never outrank a check that just failed — this is N24 itself",
    );
  } finally {
    await chmod(target, 0o755);
    await rm(roots.searchRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    await rm(roots.stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
