/**
 * CROSS_LEDGER_JSONL/MD (lib/core/config.mjs) — must use the SAME
 * existence-keyed cascade discipline as workspace ledgers
 * (lib/core/discovery.mjs makeWorkspaceRecord): prefer
 * `<root>/propagation/PROPAGATION_CROSS_LEDGER.jsonl` ONLY IF that file
 * already exists on disk; otherwise resolve to the current root path.
 *
 * Coordinator-caught defect, 2026-08-21: a first version pointed
 * unconditionally at `propagation/` before any file existed there. That
 * broke the inertness contract the whole propagation/ plan depends on — with
 * no file moved, `readLedger` silently read the (nonexistent) new location
 * as EMPTY rather than erroring, so `status --cross` reported "0 open" for 8
 * real live rows instead of saying it could not find the ledger
 * (rule:discernment-checks §2). This file is the RED-first regression test
 * for that fix: it fails on the pre-fix code (which always resolved to
 * propagation/) and passes once the resolution is keyed on file existence.
 *
 * Module-level consts computed at import time (config.mjs's own
 * documented pattern) — a fresh subprocess per case is required, not an
 * in-process re-import. Same helper as tests/portability/config-state-dir.test.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HELPER_PATH = fileURLToPath(new URL("../helpers/print-config-paths.mjs", import.meta.url));
const CLI_PATH = fileURLToPath(new URL("../../cli.mjs", import.meta.url));

function runHelper(env) {
  const merged = { ...process.env, ...env };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete merged[k];
  const result = spawnSync(process.execPath, [HELPER_PATH], { encoding: "utf8", env: merged });
  assert.equal(result.status, 0, `helper subprocess failed: ${result.stderr}`);
  return JSON.parse(result.stdout.trim().split("\n").pop());
}

function runCli(argv, env) {
  return spawnSync(process.execPath, [CLI_PATH, ...argv], { encoding: "utf8", env: { ...process.env, ...env } });
}

test("CROSS_LEDGER_JSONL resolves to the ROOT path when no propagation/ file exists (the inert default)", async (t) => {
  const searchRoot = await mkdtemp(path.join(tmpdir(), "cross-cascade-root-"));
  const stateDir = await mkdtemp(path.join(tmpdir(), "cross-cascade-state-"));
  t.after(() => Promise.all([
    rm(searchRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
    rm(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  ]));

  const paths = runHelper({ PROPAGATE_SEARCH_ROOTS: searchRoot, PROPAGATE_STATE_DIR: stateDir });

  assert.equal(paths.CROSS_LEDGER_JSONL, path.join(searchRoot, "PROPAGATION_CROSS_LEDGER.jsonl"));
  assert.equal(paths.CROSS_LEDGER_MD, path.join(searchRoot, "PROPAGATION_CROSS_LEDGER.md"));
});

test("CROSS_LEDGER_JSONL resolves to propagation/ when a real ledger file already exists there", async (t) => {
  const searchRoot = await mkdtemp(path.join(tmpdir(), "cross-cascade-moved-"));
  const stateDir = await mkdtemp(path.join(tmpdir(), "cross-cascade-state-"));
  t.after(() => Promise.all([
    rm(searchRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
    rm(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  ]));

  const propagationDir = path.join(searchRoot, "propagation");
  await mkdir(propagationDir, { recursive: true });
  await writeFile(path.join(propagationDir, "PROPAGATION_CROSS_LEDGER.jsonl"), "", "utf8");

  const paths = runHelper({ PROPAGATE_SEARCH_ROOTS: searchRoot, PROPAGATE_STATE_DIR: stateDir });

  assert.equal(paths.CROSS_LEDGER_JSONL, path.join(propagationDir, "PROPAGATION_CROSS_LEDGER.jsonl"));
  assert.equal(paths.CROSS_LEDGER_MD, path.join(propagationDir, "PROPAGATION_CROSS_LEDGER.md"));
});

test("a bare empty propagation/ directory (no ledger file inside) does NOT redirect CROSS_LEDGER_JSONL away from the root path", async (t) => {
  const searchRoot = await mkdtemp(path.join(tmpdir(), "cross-cascade-bare-"));
  const stateDir = await mkdtemp(path.join(tmpdir(), "cross-cascade-state-"));
  t.after(() => Promise.all([
    rm(searchRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
    rm(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  ]));

  await mkdir(path.join(searchRoot, "propagation"), { recursive: true });

  const paths = runHelper({ PROPAGATE_SEARCH_ROOTS: searchRoot, PROPAGATE_STATE_DIR: stateDir });

  assert.equal(
    paths.CROSS_LEDGER_JSONL,
    path.join(searchRoot, "PROPAGATION_CROSS_LEDGER.jsonl"),
    "a directory alone must not win — only a real ledger FILE there does",
  );
});

test("END TO END: status --cross reports real rows at the root path, not '0 open' (the exact regression that was caught)", async (t) => {
  const searchRoot = await mkdtemp(path.join(tmpdir(), "cross-cascade-e2e-"));
  const stateDir = await mkdtemp(path.join(tmpdir(), "cross-cascade-e2e-state-"));
  t.after(() => Promise.all([
    rm(searchRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
    rm(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  ]));

  const ws = path.join(searchRoot, "ws");
  await mkdir(path.join(ws, "docs"), { recursive: true });
  await writeFile(path.join(ws, ".propagates.yml"), "workspace: true\nsources: {}\n", "utf8");
  await writeFile(path.join(ws, "docs", "PROPAGATION_LEDGER.jsonl"), "", "utf8");

  const row = JSON.stringify({
    id: "001",
    type: "drift",
    status: "open",
    timestamp: "2026-08-13T10:55:05.645Z",
    origin_repo: "TestWorkspace",
    partner: "SSJK",
    direction: "outbound",
    source: "docs/DECISIONS.md",
    downstream: [{ path: "SSJK", why: "relay", kind: "prose" }],
  });
  // Root path — no propagation/ dir at all, matching the inert default.
  await writeFile(path.join(searchRoot, "PROPAGATION_CROSS_LEDGER.jsonl"), row + "\n", "utf8");

  const r = runCli(["status", "--cross"], { PROPAGATE_SEARCH_ROOTS: searchRoot, PROPAGATE_STATE_DIR: stateDir });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /Cross-repo\s*—\s*0 open/i, "must not silently report 0 open when 1 real row exists");
  assert.match(r.stdout, /1 open/i);
});
