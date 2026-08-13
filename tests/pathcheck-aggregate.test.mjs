/**
 * `doctor`'s sidecar downstream-path validation used to report one
 * directory-as-downstream defect as TWO counted `doctor` failures: the
 * per-entry `check()` line naming the sidecar and path, AND the aggregate
 * "sidecar downstream paths resolve" `check()` line for the same workspace.
 * `pathProblems` had been declared-but-never-incremented until 2026-08-13
 * (see docs/ISSUES.md A2), so before that fix the aggregate could never go
 * red and the double-count could never fire — it is this session's own
 * defect, introduced by fixing an older one.
 *
 * A detail line and a summary line are both legitimate — the aggregate is a
 * useful run-level tally — but only one of the two may count as a problem.
 * This file locks in: when per-entry failures already fired, the aggregate
 * prints as an informational summary (not a second `✗`); when there are no
 * per-entry failures but there are warnings, the aggregate keeps its
 * existing pass-with-warn-count behaviour, unchanged.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_DIR = fileURLToPath(new URL("..", import.meta.url));
const CLI_PATH = path.join(SKILL_DIR, "cli.mjs");

async function makeWorkspaceWithSidecar({ downstreamPath, kind }) {
  const root = await mkdtemp(path.join(tmpdir(), "pathagg-ws-"));
  await writeFile(path.join(root, ".propagates.yml"), "workspace: true\nsources: {}\n", "utf8");
  const docsDir = path.join(root, "docs");
  await mkdir(docsDir, { recursive: true });
  await writeFile(path.join(docsDir, "PROPAGATION_LEDGER.jsonl"), "", "utf8");

  const subDir = path.join(root, "sub");
  await mkdir(subDir, { recursive: true });
  const sidecarPath = path.join(subDir, ".propagates.yml");
  const kindLine = kind ? `\n        kind: ${kind}` : "";
  await writeFile(
    sidecarPath,
    `sources:\n  a.md:\n    propagates_to:\n      - path: ${downstreamPath}\n        why: "because reasons"${kindLine}\n`,
    "utf8",
  );
  return { root, sidecarPath };
}

function runDoctor(root) {
  return spawnSync(process.execPath, [CLI_PATH, "doctor"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PROPAGATE_SEARCH_ROOTS: root },
  });
}

test("one directory-as-downstream defect produces exactly one counted (✗) problem, plus a visible summary", async () => {
  const { root, sidecarPath } = await makeWorkspaceWithSidecar({ downstreamPath: "admin/app" });
  try {
    await mkdir(path.join(root, "sub", "admin", "app"), { recursive: true });
    const result = runDoctor(root);
    const out = result.stdout + result.stderr;

    // The per-entry line — naming the sidecar and path — must still fail loudly.
    const perEntryFailures = (out.match(/✗.*downstream is a directory/g) || []).length;
    assert.equal(perEntryFailures, 1, `expected exactly 1 per-entry ✗, got ${perEntryFailures}:\n${out}`);

    // The aggregate must NOT also cast a ✗ for the same defect.
    const aggregateFailures = (out.match(/✗.*sidecar downstream paths resolve/g) || []).length;
    assert.equal(
      aggregateFailures,
      0,
      `aggregate must not double-count the per-entry failure as a second ✗, got ${aggregateFailures}:\n${out}`,
    );

    // But the aggregate must still be VISIBLE as a summary (not silently dropped).
    // (`.*` rather than `\s+` between label and count — doctor's `check()`/`info()`
    // insert an ANSI dim-color escape between the two spaces and the detail text.)
    assert.match(
      out,
      /sidecar downstream paths resolve.*1 directory-as-downstream failure/,
      `expected a visible informational summary line:\n${out}`,
    );

    // The offending sidecar must still be named in the per-entry line.
    const relSidecar = path.relative(root, sidecarPath);
    assert.match(out, new RegExp(relSidecar.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("warnings-only case (no directory-as-downstream defects) keeps today's aggregate behaviour: a passing check with a warn count", async () => {
  const { root } = await makeWorkspaceWithSidecar({
    downstreamPath: "not_yet_written.py",
    kind: "code",
  });
  try {
    const result = runDoctor(root);
    const out = result.stdout + result.stderr;

    // No per-entry failures — a declare-ahead `kind: code` missing target is a warn, not a failure.
    assert.doesNotMatch(out, /✗.*not_yet_written\.py/);

    // The aggregate must still be a real, counted PASS (unchanged from before this fix) — it
    // is the sole signal here, so it is not merely informational.
    assert.match(
      out,
      /✓.*sidecar downstream paths resolve.*\d+ warn/,
      `expected the aggregate to still pass with a warn count:\n${out}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
