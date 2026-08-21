/**
 * `cli doctor` — wire `findLedgersUnder` (lib/edges/refs.mjs) into doctor as an
 * INFORMATIONAL section. Plan: ~/.claude/plans/status-temporal-plum.md, P4
 * "undiscoverable-ledger report" (§Phase 1 → 1e).
 *
 * `findLedgersUnder` has zero production callers today — only `enumerateRefs`
 * is imported from refs.mjs anywhere (bootstrap.mjs). It walks dot-directories
 * to depth 8 and, for each ledger it finds, calls `discoverWorkspacesSync`
 * (read-only) to say whether the running watcher's discovery would ever see
 * it, and why not (dot-directory | depth | no-workspace-marker).
 *
 * HARD CONSTRAINT this file exists to pin: this section must NEVER fail
 * doctor. It is information, not a defect — a red doctor here would train
 * people to ignore it (docs/GOTCHAS.md G1, G23).
 *
 * Fixture placement note: doctor already carries a SEPARATE, pre-existing,
 * HARD-FAILING check — `findUnownedLedgers` / "no unowned ledger files"
 * (lib/edges/ledger.mjs, wired in cli.mjs before this change) — which walks
 * the same tree with its own SKIP set (node_modules, .git, .next, dist,
 * build, .turbo... , .gstack, among others) and does NOT exclude dot-dirs in
 * general. Planting a ledger under an arbitrary dot-directory (e.g.
 * `.claude/worktrees/...`, the plan's known live example) would ALSO trip
 * that pre-existing hard check, making it impossible to demonstrate "doctor
 * still exits 0" — not because of a bug in this new section, but because of
 * the other one. `.gstack` is the one directory name skipped by
 * findUnownedLedgers's walk but NOT by findLedgersUnder's (HEAVY_SKIP_DIR_NAMES
 * / SKIP_DIR_NAMES in refs.mjs and discovery.mjs — neither lists `.gstack`),
 * so planting there isolates the two mechanisms and lets this test assert
 * what it is actually testing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { undiscoverableLedgersReport } from "../../cli.mjs";

const CLI_PATH = fileURLToPath(new URL("../../cli.mjs", import.meta.url));

/**
 * Same shape as doctor.test.mjs's makeWorkspace, PLUS the two artifacts a
 * fully-green doctor run also needs (that file's tests never assert overall
 * exit 0, so it doesn't seed these) — a rendered ledger MD, and one event in
 * the v2 event store under `PROPAGATE_STATE_DIR` (= `root` in `runDoctor`
 * below). Needed here because this file's tests DO assert exit 0, to pin
 * "an undiscoverable ledger is informational, never a doctor failure."
 */
async function makeWorkspace(lines) {
  const root = await mkdtemp(path.join(tmpdir(), "doctor-undiscoverable-"));
  await writeFile(path.join(root, ".propagates.yml"), "workspace: true\nsources: {}\n", "utf8");
  const docsDir = path.join(root, "docs");
  await mkdir(docsDir, { recursive: true });
  const jsonlPath = path.join(docsDir, "PROPAGATION_LEDGER.jsonl");
  await writeFile(jsonlPath, lines.join("\n") + (lines.length ? "\n" : ""), "utf8");
  await writeFile(path.join(docsDir, "PROPAGATION_LEDGER.md"), "# Propagation Ledger\n\n(rendered by test fixture)\n", "utf8");

  const eventsDir = path.join(root, "events");
  await mkdir(eventsDir, { recursive: true });
  const shard = new Date().toISOString().slice(0, 7) + ".jsonl";
  await writeFile(
    path.join(eventsDir, shard),
    JSON.stringify({
      event_id: "01FIXTURE0000000000000000",
      edge_id: "fixture-edge",
      node_id: "fixture-node",
      disposition: "verified",
      source_content: "abc123",
      downstream_content: "def456",
      ts: new Date().toISOString(),
      hash_alg: "sha256",
    }) + "\n",
    "utf8",
  );

  return { root, jsonlPath };
}

function driftLine(id, overrides = {}) {
  return JSON.stringify({
    type: "drift",
    id,
    timestamp: new Date(Date.now() - 60_000).toISOString(),
    source: `${id}.md`,
    change: `drift on ${id}`,
    status: "open",
    ...overrides,
  });
}

/** Plant a second, orphaned ledger under `.gstack/<nested>/docs/` below `root`. */
async function plantDotDirLedger(root, openRows = 1) {
  const nestedDocs = path.join(root, ".gstack", "nested-thing", "docs");
  await mkdir(nestedDocs, { recursive: true });
  const jsonlPath = path.join(nestedDocs, "PROPAGATION_LEDGER.jsonl");
  const lines = [];
  for (let i = 0; i < openRows; i++) lines.push(driftLine(`hidden-${i}`));
  // One closed row too, to prove the count is folded (last-status-per-id),
  // not a raw line count (docs/GOTCHAS.md — "501 where the truth was 8").
  lines.push(driftLine("hidden-closed"));
  lines.push(
    JSON.stringify({
      type: "status_change",
      id: "hidden-closed",
      timestamp: new Date().toISOString(),
      status: "done",
    }),
  );
  await writeFile(jsonlPath, lines.join("\n") + "\n", "utf8");
  return jsonlPath;
}

function runDoctor(root, stateDir = root) {
  return spawnSync(process.execPath, [CLI_PATH, "doctor"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PROPAGATE_SEARCH_ROOTS: root, PROPAGATE_STATE_DIR: stateDir },
  });
}

test("doctor names a ledger hidden in a dot-directory, with its folded open-row count, and still exits 0", async () => {
  const { root } = await makeWorkspace([driftLine("001")]);
  try {
    const hiddenPath = await plantDotDirLedger(root, 1);
    const result = runDoctor(root);
    const out = result.stdout + result.stderr;

    assert.equal(result.status, 0, "an undiscoverable ledger must be informational, never a doctor failure");
    assert.match(out, /Undiscoverable ledgers/i, "a labeled section must exist");
    assert.match(
      out,
      new RegExp(hiddenPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      "output names the hidden ledger's path",
    );
    assert.match(out, /dot-directory/, "output names WHY it's undiscoverable");
    // 1 open (folded), not 2 raw "open" lines and not the closed row.
    assert.match(out, /\b1\b[^\n]*open/i, "output reports the folded open-row count, not the raw line count");

    // Sanity: the OTHER, pre-existing hard check must not have also fired —
    // proves this fixture isolates the two mechanisms as the header above claims.
    assert.doesNotMatch(out, /✗[^\n]*no unowned ledger files/, ".gstack must be skipped by the other check");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor reports none-found (not a silent empty section) when nothing is hidden", async () => {
  const { root } = await makeWorkspace([driftLine("001")]);
  try {
    const result = runDoctor(root);
    const out = result.stdout + result.stderr;
    assert.equal(result.status, 0);
    assert.match(out, /Undiscoverable ledgers/i);
    assert.match(out, /none-found/, "absence must be attributable (rule:discernment-checks §2), not a blank section");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── Direct unit tests of the exported report function — the no-roots and
// walk-failed branches are impractical to force from a real machine's
// search roots, so they're pinned directly (same pattern as
// decisionsAttributionReport above, for the same reason). ──

test("undiscoverableLedgersReport: no search roots configured reports no-roots, not none-found", async () => {
  const report = await undiscoverableLedgersReport([]);
  assert.equal(report.status, "no-roots");
  assert.deepEqual(report.findings, []);
});

test("undiscoverableLedgersReport: a real root with nothing hidden reports none-found", async () => {
  const { root } = await makeWorkspace([driftLine("001")]);
  try {
    const report = await undiscoverableLedgersReport([root]);
    assert.equal(report.status, "none-found");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("undiscoverableLedgersReport: finds a dot-directory ledger and reports its reason + folded open count", async () => {
  const { root } = await makeWorkspace([driftLine("001")]);
  try {
    await plantDotDirLedger(root, 2);
    const report = await undiscoverableLedgersReport([root]);
    assert.equal(report.status, "found");
    assert.equal(report.findings.length, 1);
    assert.equal(report.findings[0].reason, "dot-directory");
    assert.equal(report.findings[0].open, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
