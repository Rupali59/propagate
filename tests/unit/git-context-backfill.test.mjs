/**
 * Tests for the BACKFILL half of lib/git-context.mjs (Phase 5, Part B) and
 * its consumption by lib/ledger.mjs's fold.
 *
 * Run: `npm test` (node --test tests/)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";

import {
  backfillRows,
  backfillWorkspace,
  resolveGitBackfillSidecarPath,
  loadGitBackfillSidecarAt,
} from "../../lib/core/git-context.mjs";
import { appendRow, readLedger } from "../../lib/edges/ledger.mjs";

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function makeTempRepo(prefix = "git-backfill-") {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "Test"], dir);
  return dir;
}

function commit(repo, filename, contents, message) {
  const fp = path.join(repo, filename);
  execFileSync("bash", ["-c", `printf '%s' ${JSON.stringify(contents)} > ${JSON.stringify(fp)}`]);
  git(["add", "."], repo);
  git(["commit", "-q", "-m", message], repo);
}

test("backfill: reconstructs an anchor for a row whose timestamp falls after a known commit, marked reconstructed:true", async () => {
  const repo = await makeTempRepo();
  commit(repo, "pricing.ts", "v1", "initial");
  const firstSha = git(["rev-parse", "HEAD"], repo);
  // A timestamp well after the first (and only) commit.
  const rowTimestamp = new Date(Date.now() + 60_000).toISOString();

  const rows = [{ id: "001", source: "pricing.ts", timestamp: rowTimestamp }];
  const result = backfillRows(rows, repo);

  assert.equal(result.hit, 1);
  assert.equal(result.miss, 0);
  assert.equal(result.entries.length, 1);
  const { git: anchor } = result.entries[0];
  assert.equal(anchor.reconstructed, true);
  assert.equal(anchor.sha, firstSha);
  assert.equal(anchor.branch, "main");
  assert.ok(typeof anchor.method === "string" && anchor.method.includes("rev-list"));
});

test("backfill: a row whose timestamp predates all history gets NO entry, not a guessed one", async () => {
  const repo = await makeTempRepo();
  commit(repo, "pricing.ts", "v1", "initial");

  const rows = [
    { id: "001", source: "pricing.ts", timestamp: "1999-01-01T00:00:00.000Z" },
  ];
  const result = backfillRows(rows, repo);

  assert.equal(result.hit, 0);
  assert.equal(result.miss, 1);
  assert.equal(result.entries.length, 0);
  assert.ok(
    Object.keys(result.missReasons).some((r) => r.includes("predates available history")),
  );
});

test("backfill: a row whose source resolves outside any repo gets NO entry", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "git-backfill-orphan-"));
  const rows = [{ id: "001", source: "orphan.md", timestamp: new Date().toISOString() }];
  const result = backfillRows(rows, dir);

  assert.equal(result.hit, 0);
  assert.equal(result.miss, 1);
  assert.ok(Object.keys(result.missReasons).some((r) => r.includes("repo")));
});

test("backfill: a row that already carries a stamped git field is never touched", async () => {
  const repo = await makeTempRepo();
  commit(repo, "pricing.ts", "v1", "initial");
  const rows = [
    {
      id: "001",
      source: "pricing.ts",
      timestamp: new Date().toISOString(),
      git: { sha: "deadbeef", branch: "main", dirty: false },
    },
  ];
  const result = backfillRows(rows, repo);
  assert.equal(result.alreadyStamped, 1);
  assert.equal(result.hit, 0);
  assert.equal(result.entries.length, 0);
});

test("backfill: writes to the sidecar, never mutates the ledger file bytes", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "git-backfill-ws-"));
  await mkdir(path.join(workspaceRoot, "docs"), { recursive: true });
  git(["init", "-q", "-b", "main"], workspaceRoot);
  git(["config", "user.email", "test@example.com"], workspaceRoot);
  git(["config", "user.name", "Test"], workspaceRoot);
  commit(workspaceRoot, "pricing.ts", "v1", "initial");

  const jsonl = path.join(workspaceRoot, "docs", "PROPAGATION_LEDGER.jsonl");
  const futureTimestamp = new Date(Date.now() + 60_000).toISOString();
  await appendRow(jsonl, {
    type: "drift",
    id: "001",
    source: "pricing.ts",
    change: "edit",
    downstream: [],
    status: "open",
  });
  // appendRow stamps its own "now" timestamp; overwrite the row with a
  // known-future timestamp so it's guaranteed to resolve against the commit
  // made above, keeping this test independent of wall-clock timing.
  const before = await readFile(jsonl, "utf8");
  const rewritten = before.replace(
    /"timestamp":"[^"]+"/,
    `"timestamp":"${futureTimestamp}"`,
  );
  await writeFile(jsonl, rewritten);

  const workspace = { name: "test-ws", root: workspaceRoot, ledgerJsonl: jsonl };
  const ledgerBytesBefore = await readFile(jsonl, "utf8");

  const report = await backfillWorkspace(workspace, readLedger, { dryRun: false });

  const ledgerBytesAfter = await readFile(jsonl, "utf8");
  assert.equal(ledgerBytesAfter, ledgerBytesBefore, "ledger file must be byte-for-byte unchanged");

  const sidecarPath = resolveGitBackfillSidecarPath(jsonl);
  assert.equal(sidecarPath, path.join(workspaceRoot, "docs", ".propagation", "git-backfill.jsonl"));
  assert.ok(existsSync(sidecarPath), "sidecar file should have been written");

  const sidecarMap = loadGitBackfillSidecarAt(sidecarPath);
  assert.ok(sidecarMap.has("001"));
  assert.equal(sidecarMap.get("001").reconstructed, true);
  assert.equal(report.hit, 1);
  assert.equal(report.dryRun, false);
});

test("backfill dry-run does NOT write the sidecar", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "git-backfill-dry-"));
  await mkdir(path.join(workspaceRoot, "docs"), { recursive: true });
  git(["init", "-q", "-b", "main"], workspaceRoot);
  git(["config", "user.email", "test@example.com"], workspaceRoot);
  git(["config", "user.name", "Test"], workspaceRoot);
  commit(workspaceRoot, "pricing.ts", "v1", "initial");

  const jsonl = path.join(workspaceRoot, "docs", "PROPAGATION_LEDGER.jsonl");
  await appendRow(jsonl, {
    type: "drift",
    id: "001",
    source: "pricing.ts",
    change: "edit",
    downstream: [],
    status: "open",
  });

  const workspace = { name: "test-ws", root: workspaceRoot, ledgerJsonl: jsonl };
  const report = await backfillWorkspace(workspace, readLedger, { dryRun: true });
  assert.equal(report.dryRun, true);

  const sidecarPath = resolveGitBackfillSidecarPath(jsonl);
  assert.equal(existsSync(sidecarPath), false, "dry-run must not write anything");
});

test("backfill reports a hit rate (hit + miss + alreadyStamped accounts for every row)", async () => {
  const repo = await makeTempRepo();
  commit(repo, "pricing.ts", "v1", "initial");

  const rows = [
    { id: "001", source: "pricing.ts", timestamp: new Date(Date.now() + 60_000).toISOString() },
    { id: "002", source: "pricing.ts", timestamp: "1999-01-01T00:00:00.000Z" },
    // Note: findRepoRoot only needs the FILE'S DIRECTORY to be inside a
    // repo — it does not require the file itself to exist on disk. A
    // nonexistent-but-in-repo path still resolves to a repo and gets a
    // history-based anchor; "no repo" misses need a path whose directory
    // is genuinely outside any git repo (covered by the dedicated test
    // above), not merely a missing filename inside one.
    { id: "003", source: "no-such-file.md", timestamp: new Date().toISOString() },
    {
      id: "004",
      source: "pricing.ts",
      timestamp: new Date().toISOString(),
      git: { sha: "already", branch: "main", dirty: false },
    },
  ];
  const result = backfillRows(rows, repo);
  assert.equal(result.hit + result.miss + result.alreadyStamped, rows.length);
  assert.equal(result.hit, 2);
  assert.equal(result.miss, 1);
  assert.equal(result.alreadyStamped, 1);
});

test("fold: a folded Event exposes reconstructed context distinguishably from a stamped git field", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "git-backfill-fold-"));
  await mkdir(path.join(workspaceRoot, "docs"), { recursive: true });
  const jsonl = path.join(workspaceRoot, "docs", "PROPAGATION_LEDGER.jsonl");

  await appendRow(jsonl, {
    type: "drift",
    id: "001",
    source: "a.md",
    change: "edit",
    downstream: [],
    status: "open",
    git: { sha: "stampedsha", branch: "main", dirty: false },
  });
  await appendRow(jsonl, {
    type: "drift",
    id: "002",
    source: "b.md",
    change: "edit",
    downstream: [],
    status: "open",
  });

  const sidecarPath = resolveGitBackfillSidecarPath(jsonl);
  await mkdir(path.dirname(sidecarPath), { recursive: true });
  await writeFile(
    sidecarPath,
    [
      JSON.stringify({
        id: "001",
        git: { sha: "shouldneverwin", branch: "main", reconstructed: true, method: "test" },
      }),
      JSON.stringify({
        id: "002",
        git: { sha: "reconstructedsha", branch: "main", reconstructed: true, method: "test" },
      }),
    ].join("\n") + "\n",
  );

  const rows = await readLedger(jsonl);
  const row1 = rows.find((r) => r.id === "001");
  const row2 = rows.find((r) => r.id === "002");

  // Row 001 was stamped — its real `git` field wins, sidecar never overwrites it.
  assert.equal(row1.git.sha, "stampedsha");
  assert.equal(row1.git_reconstructed, undefined);

  // Row 002 has no stamped git — the fold attaches the sidecar value under
  // a DIFFERENT field name, never merged into `git`.
  assert.equal(row2.git, undefined);
  assert.ok(row2.git_reconstructed);
  assert.equal(row2.git_reconstructed.sha, "reconstructedsha");
  assert.equal(row2.git_reconstructed.reconstructed, true);
});
