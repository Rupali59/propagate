/**
 * `node cli.mjs relocate-ledger --workspace <root> [--apply] [--json]` — the
 * thin dispatch arm (D7) in cli.mjs, wrapping lib/edges/relocate-ledger.mjs.
 * Exercises the real subprocess, not the library function directly (that's
 * tests/unit/relocate-ledger.test.mjs), so the exact CLI usage stays honest.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI_PATH = fileURLToPath(new URL("../../cli.mjs", import.meta.url));

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function runCli(argv, cwd) {
  return spawnSync(process.execPath, [CLI_PATH, ...argv], { cwd, encoding: "utf8" });
}

async function makeWorkspace() {
  const root = await mkdtemp(path.join(tmpdir(), "relocate-cli-"));
  git(["init", "-q", "-b", "main"], root);
  git(["config", "user.email", "test@example.com"], root);
  git(["config", "user.name", "Test"], root);
  await writeFile(path.join(root, ".propagates.yml"), "workspace: true\nsources: {}\n", "utf8");
  const docsDir = path.join(root, "docs");
  await mkdir(docsDir, { recursive: true });
  await writeFile(
    path.join(docsDir, "PROPAGATION_LEDGER.jsonl"),
    JSON.stringify({
      type: "drift",
      id: "001",
      timestamp: "2026-08-01T00:00:00.000Z",
      source: "a.md",
      change: "c",
      status: "open",
    }) + "\n",
    "utf8",
  );
  await writeFile(path.join(docsDir, "PROPAGATION_LEDGER.md"), "# Propagation Ledger\n", "utf8");
  git(["add", "-A"], root);
  git(["commit", "-q", "-m", "seed"], root);
  return root;
}

test("relocate-ledger: no --workspace prints usage and exits non-zero", (t) => {
  const r = runCli(["relocate-ledger"], process.cwd());
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /usage: node cli\.mjs relocate-ledger --workspace/);
});

test("relocate-ledger: dry-run (default) reports the move and writes nothing", async (t) => {
  const root = await makeWorkspace();
  t.after(() => rm(root, { recursive: true, force: true }));

  const r = runCli(["relocate-ledger", "--workspace", root], root);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /dry-run/i);
  assert.match(r.stdout, /docs.*PROPAGATION_LEDGER\.jsonl/s);
  assert.match(r.stdout, /propagation.*ledger\.jsonl/s);
  assert.equal(existsSync(path.join(root, "propagation")), false, "dry-run must not create propagation/");
});

test("relocate-ledger --apply --json performs the move and reports JSON", async (t) => {
  const root = await makeWorkspace();
  t.after(() => rm(root, { recursive: true, force: true }));

  const r = runCli(["relocate-ledger", "--workspace", root, "--apply", "--json"], root);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.applied, true);
  assert.equal(parsed.into.jsonl, path.join(root, "propagation", "ledger.jsonl"));
  assert.equal(existsSync(path.join(root, "docs", "PROPAGATION_LEDGER.jsonl")), false);
  assert.equal(existsSync(path.join(root, "propagation", "ledger.jsonl")), true);
});

test("relocate-ledger --apply a second time refuses via JSON error, not a crash", async (t) => {
  const root = await makeWorkspace();
  t.after(() => rm(root, { recursive: true, force: true }));

  runCli(["relocate-ledger", "--workspace", root, "--apply"], root);
  const r2 = runCli(["relocate-ledger", "--workspace", root, "--apply", "--json"], root);
  assert.notEqual(r2.status, 0);
  const parsed = JSON.parse(r2.stdout);
  assert.match(parsed.error, /already on the propagation\/ layout/i);
});
