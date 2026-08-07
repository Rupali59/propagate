/**
 * G1 — the two core fire-paths, previously untested.
 *
 * processChange (.propagates.yml prose source) and processCodeCanonical
 * (.code-canonical.yml code edit) are the two functions that decide when a
 * ledger row fires. All 54 pre-existing tests cover helpers / cross-repo /
 * worktrees around them, but neither had a direct test. This is the safety
 * net for the G3 refactor of processCodeCanonical (multi-upstream downstream[]).
 *
 * Mirrors tests/cross-repo.integration.test.mjs's temp-dir + bare-state
 * harness (that file already exercises the sibling processCrossRepo pass the
 * same way).
 *
 * NOTE: both functions sleep MTIME_REVERIFY_DELAY_MS (3000ms, config.mjs) as
 * a race guard before firing — every firing-path test in this file pays that
 * cost. Kept as-is rather than mocking timers, to test the real exported
 * function unmodified.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { processChange, processCodeCanonical } from "../watcher.mjs";
import { readLedger } from "../lib/ledger.mjs";
import { loadCodeCanonicalSync } from "../lib/code-canonical.mjs";

async function touch(p, when) {
  const t = when ?? new Date();
  await utimes(p, t, t);
}

function freshState() {
  return { mtimes: {}, crossDecisions: {}, lastRunAt: 0, version: 2 };
}

async function makeWorkspace(prefix) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const ledgerJsonl = path.join(root, "PROPAGATION_LEDGER.jsonl");
  const ledgerMd = path.join(root, "PROPAGATION_LEDGER.md");
  return { name: path.basename(root), root, ledgerJsonl, ledgerMd, scanDirs: ["."] };
}

// ─────────────────────────────────────────────────────────────────────────
// processChange
// ─────────────────────────────────────────────────────────────────────────

test("processChange — prose source mtime advance fires one drift row with declared downstreams", async () => {
  const ws = await makeWorkspace("fp-change-");
  const docFile = path.join(ws.root, "SPEC.md");
  const codeFile = path.join(ws.root, "impl.ts");
  await writeFile(docFile, "spec v1");
  await writeFile(codeFile, "impl v1");
  await writeFile(
    path.join(ws.root, ".propagates.yml"),
    `
sources:
  SPEC.md:
    propagates_to:
      - path: impl.ts
        why: implementation must match spec
        kind: code
`,
  );

  const state = freshState();
  const result = await processChange(ws, docFile, state, new Map());
  assert.ok(result && result.id, "fires a row");
  assert.equal(result.count, 1);

  const rows = await readLedger(ws.ledgerJsonl);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, "drift");
  assert.equal(rows[0].source, "SPEC.md");
  assert.equal(rows[0].downstream.length, 1);
  assert.equal(rows[0].downstream[0].path, "impl.ts");
  assert.equal(rows[0].downstream[0].kind, "code");
  assert.equal(rows[0].status, "open");
});

test("processChange — unchanged mtime does not re-fire", async () => {
  const ws = await makeWorkspace("fp-change-nofire-");
  const docFile = path.join(ws.root, "SPEC.md");
  await writeFile(docFile, "spec v1");
  await writeFile(
    path.join(ws.root, ".propagates.yml"),
    `
sources:
  SPEC.md:
    propagates_to:
      - path: impl.ts
        why: implementation must match spec
        kind: code
`,
  );

  const state = freshState();
  const first = await processChange(ws, docFile, state, new Map());
  assert.ok(first && first.id, "first observation fires");

  // Same mtime, no edit — detectMtimeChange returns null, processChange no-ops.
  const second = await processChange(ws, docFile, state, new Map());
  assert.equal(second, null, "no re-fire when mtime hasn't advanced");

  const rows = await readLedger(ws.ledgerJsonl);
  assert.equal(rows.length, 1, "still just the one row");
});

test("processChange — no sidecar covers the file: no-op, mtime still recorded", async () => {
  const ws = await makeWorkspace("fp-change-nosidecar-");
  const orphan = path.join(ws.root, "ORPHAN.md");
  await writeFile(orphan, "not declared anywhere");
  // No .propagates.yml at all in this workspace.

  const state = freshState();
  const result = await processChange(ws, orphan, state, new Map());
  assert.equal(result, null, "no sidecar -> null");
  assert.ok(state.mtimes[orphan] !== undefined, "mtime recorded so we don't replay forever");

  const rows = await readLedger(ws.ledgerJsonl);
  assert.equal(rows.length, 0);
});

test("processChange — sidecar exists but file has no downstreams declared: no-op", async () => {
  const ws = await makeWorkspace("fp-change-nodownstream-");
  const undeclared = path.join(ws.root, "UNDECLARED.md");
  await writeFile(undeclared, "not a declared source");
  await writeFile(
    path.join(ws.root, ".propagates.yml"),
    `
sources:
  SPEC.md:
    propagates_to:
      - path: impl.ts
        why: implementation must match spec
        kind: code
`,
  );

  const state = freshState();
  const result = await processChange(ws, undeclared, state, new Map());
  assert.equal(result, null, "file watched but not declared as a source -> null");

  const rows = await readLedger(ws.ledgerJsonl);
  assert.equal(rows.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────
// processCodeCanonical
// ─────────────────────────────────────────────────────────────────────────

test("processCodeCanonical — .code-canonical.yml code edit fires a code_drift row at the upstream doc", async () => {
  const ws = await makeWorkspace("fp-canon-");
  await mkdir(path.join(ws.root, "lib"), { recursive: true });
  const codeFile = path.join(ws.root, "lib", "pricing.ts");
  await writeFile(codeFile, "export const price = 1;");
  await writeFile(path.join(ws.root, "PRICING.md"), "pricing doc v1");

  await writeFile(
    path.join(ws.root, ".code-canonical.yml"),
    `
canonical_pairs:
  - codePath: lib/pricing.ts
    upstreamDoc: PRICING.md
    upstreamSection: "§Pricing"
    note: "pricing logic and doc must match"
`,
  );
  const loaded = loadCodeCanonicalSync(ws.root);
  assert.equal(loaded.length, 1, "sidecar loads one canonical pair");
  const entry = loaded[0];

  const state = freshState();
  // First observation of the canonical (non-worktree) file: no bootstrap
  // suppression applies to the canonical worktree — it always fires
  // (matches pre-worktree behaviour, per watcher.mjs comment).
  const results = await processCodeCanonical(ws, entry.codePath, [entry], state, new Map());
  assert.ok(results && results.length === 1, "fires one code_drift result");
  assert.equal(results[0].kind, "code_drift");

  const rows = await readLedger(ws.ledgerJsonl);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, "code_drift");
  assert.equal(rows[0].source, "lib/pricing.ts");
  assert.equal(rows[0].downstream.length, 1);
  assert.equal(rows[0].downstream[0].path, "PRICING.md");
  assert.equal(rows[0].downstream[0].kind, "prose");
});

test("processCodeCanonical — unchanged mtime does not re-fire", async () => {
  const ws = await makeWorkspace("fp-canon-nofire-");
  await mkdir(path.join(ws.root, "lib"), { recursive: true });
  const codeFile = path.join(ws.root, "lib", "pricing.ts");
  await writeFile(codeFile, "export const price = 1;");
  await writeFile(path.join(ws.root, "PRICING.md"), "pricing doc v1");
  const entry = {
    codePath: "lib/pricing.ts",
    upstreamDoc: "PRICING.md",
    upstreamSection: "§Pricing",
    note: "",
  };

  const state = freshState();
  const first = await processCodeCanonical(ws, entry.codePath, [entry], state, new Map());
  assert.ok(first && first.length === 1);

  const second = await processCodeCanonical(ws, entry.codePath, [entry], state, new Map());
  assert.equal(second, null, "no re-fire when the code file's mtime hasn't advanced");

  const rows = await readLedger(ws.ledgerJsonl);
  assert.equal(rows.length, 1);
});

test("processCodeCanonical — no code-canonical entries for a workspace with no sidecar: empty array", () => {
  const loaded = loadCodeCanonicalSync("/no/such/workspace/definitely-not-real");
  assert.deepEqual(loaded, []);
});

test("processCodeCanonical — first-observation of a non-canonical sibling-worktree path bootstrap-seeds (no row)", async () => {
  const ws = await makeWorkspace("fp-canon-bootstrap-");
  await mkdir(path.join(ws.root, "lib"), { recursive: true });
  const canonicalCode = path.join(ws.root, "lib", "pricing.ts");
  await writeFile(canonicalCode, "export const price = 1;");
  await writeFile(path.join(ws.root, "PRICING.md"), "pricing doc v1");

  // A sibling worktree with its own copy of the same logical file.
  const siblingRepoPath = path.join(ws.root, ".worktrees", "feature-x");
  await mkdir(path.join(siblingRepoPath, "lib"), { recursive: true });
  const siblingCode = path.join(siblingRepoPath, "lib", "pricing.ts");
  await writeFile(siblingCode, "export const price = 1; // wip");

  const entry = {
    codePath: "lib/pricing.ts",
    upstreamDoc: "PRICING.md",
    upstreamSection: "§Pricing",
    note: "",
  };

  // worktreeMap: canonical repo root -> [canonical worktree, sibling worktree]
  const worktreeMap = new Map();
  worktreeMap.set(ws.root, [
    {
      path: ws.root,
      branch: "main",
      commit: "abc123def456",
      isCanonical: true,
      isLocked: false,
      isBare: false,
    },
    {
      path: siblingRepoPath,
      branch: "feature-x",
      commit: "def456abc123",
      isCanonical: false,
      isLocked: false,
      isBare: false,
    },
  ]);

  const state = freshState();
  const results = await processCodeCanonical(ws, entry.codePath, [entry], state, worktreeMap);

  // Canonical fires (first observation, canonical always fires); sibling
  // worktree is a first observation of a NON-canonical path -> bootstrap
  // seed, no row for it. So exactly one result (the canonical one).
  assert.ok(results && results.length === 1, "only the canonical worktree fires on first run");
  assert.equal(results[0].sourceRel, "lib/pricing.ts");

  const rows = await readLedger(ws.ledgerJsonl);
  assert.equal(rows.length, 1, "sibling worktree's first observation produced no row");
  assert.ok(state.mtimes[siblingCode] !== undefined, "sibling mtime recorded (seeded) despite no row");
});
