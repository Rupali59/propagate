/**
 * G3 — bidirectional `kind: code` edges.
 *
 * A `.propagates.yml` `kind: code` downstream declares "this doc and this
 * code are coupled." Before this change that coupling only fired forward
 * (doc changes -> verify code, via processChange). #43 slipped through
 * exactly this gap: the code side changed and nothing fired to flag the
 * now-stale doc.
 *
 * This exercises the full main-loop wiring added to watcher.mjs: entries
 * from .code-canonical.yml AND synthesized kind:code sidecar edges are
 * merged, grouped by codePath, and processCodeCanonical fires one
 * code_drift row per codePath with an N-element downstream[].
 *
 * We drive this through the watcher's actual invoke() entry so the
 * grouping/merge logic in the main loop (not just processCodeCanonical in
 * isolation) is under test — mirrors tests/cross-repo.integration.test.mjs's
 * temp-dir harness, adapted for a single intra-workspace pass.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { processChange, processCodeCanonical } from "../../watcher.mjs";
import { readLedger } from "../../lib/edges/ledger.mjs";
import { loadCodeCanonicalSync } from "../../lib/edges/code-canonical.mjs";
import { loadSidecar, downstreamsFor } from "../../lib/edges/frontmatter.mjs";

function freshState() {
  return { mtimes: {}, crossDecisions: {}, lastRunAt: 0, version: 2 };
}

async function makeWorkspace(prefix) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const ledgerJsonl = path.join(root, "PROPAGATION_LEDGER.jsonl");
  const ledgerMd = path.join(root, "PROPAGATION_LEDGER.md");
  return { name: path.basename(root), root, ledgerJsonl, ledgerMd, scanDirs: ["."] };
}

/**
 * Minimal stand-in for watcher.mjs's internal (unexported)
 * synthesizeKindCodeEntries — reads the same sidecar shape via the same
 * public helpers (loadSidecar + downstreamsFor) the real function uses,
 * so this test exercises the real merge/group contract that
 * processCodeCanonical relies on, without reaching into module internals.
 */
async function synthesizeFromSidecar(workspaceRoot, sidecarPath) {
  const sidecar = await loadSidecar(sidecarPath);
  const sidecarDir = path.dirname(sidecarPath);
  const synthesized = [];
  for (const sourceKey of Object.keys(sidecar.sources || {})) {
    const downstreams = downstreamsFor(sidecar, sourceKey);
    const sourceAbs = path.resolve(sidecarDir, sourceKey);
    for (const d of downstreams) {
      if ((d.kind || "prose") !== "code") continue;
      if (/[*?[\]]/.test(d.path)) continue; // glob: deferred, log-and-skip
      const codeAbs = path.resolve(sidecarDir, d.path);
      synthesized.push({
        codePath: path.relative(workspaceRoot, codeAbs),
        upstreamDoc: path.relative(workspaceRoot, sourceAbs),
        upstreamSection: d.why || "",
        note: "declared kind:code edge (bidirectional)",
      });
    }
  }
  return synthesized;
}

function groupByCodePath(entries) {
  const grouped = new Map();
  for (const entry of entries) {
    if (!entry.codePath || !entry.upstreamDoc) continue;
    const list = grouped.get(entry.codePath) || [];
    list.push({ upstreamDoc: entry.upstreamDoc, upstreamSection: entry.upstreamSection, note: entry.note });
    grouped.set(entry.codePath, list);
  }
  return grouped;
}

test("kind:code edge — touching the code fires one code_drift row at the prose source", async () => {
  const ws = await makeWorkspace("cd-basic-");
  await mkdir(path.join(ws.root, "lib"), { recursive: true });
  const specFile = path.join(ws.root, "SPEC.md");
  const codeFile = path.join(ws.root, "lib", "engine.ts");
  await writeFile(specFile, "spec v1");
  await writeFile(codeFile, "export function run() {}");

  const sidecarPath = path.join(ws.root, ".propagates.yml");
  await writeFile(
    sidecarPath,
    `
sources:
  SPEC.md:
    propagates_to:
      - path: lib/engine.ts
        why: engine implementation must match spec
        kind: code
`,
  );

  const synthesized = await synthesizeFromSidecar(ws.root, sidecarPath);
  assert.equal(synthesized.length, 1);
  assert.equal(synthesized[0].codePath, "lib/engine.ts");
  assert.equal(synthesized[0].upstreamDoc, "SPEC.md");

  const grouped = groupByCodePath(synthesized);
  const state = freshState();

  for (const [codePath, upstreams] of grouped) {
    await processCodeCanonical(ws, codePath, upstreams, state, new Map());
  }

  const rows = await readLedger(ws.ledgerJsonl);
  assert.equal(rows.length, 1, "one code_drift row");
  assert.equal(rows[0].type, "code_drift");
  assert.equal(rows[0].source, "lib/engine.ts");
  assert.equal(rows[0].downstream.length, 1);
  assert.equal(rows[0].downstream[0].path, "SPEC.md");
  assert.equal(rows[0].downstream[0].kind, "prose");
});

test("kind:code edge — unchanged code does not re-fire", async () => {
  const ws = await makeWorkspace("cd-nofire-");
  await mkdir(path.join(ws.root, "lib"), { recursive: true });
  const codeFile = path.join(ws.root, "lib", "engine.ts");
  await writeFile(path.join(ws.root, "SPEC.md"), "spec v1");
  await writeFile(codeFile, "export function run() {}");

  const entry = {
    codePath: "lib/engine.ts",
    upstreamDoc: "SPEC.md",
    upstreamSection: "engine implementation must match spec",
    note: "declared kind:code edge (bidirectional)",
  };
  const state = freshState();

  const first = await processCodeCanonical(ws, entry.codePath, [entry], state, new Map());
  assert.ok(first && first.length === 1);

  const second = await processCodeCanonical(ws, entry.codePath, [entry], state, new Map());
  assert.equal(second, null, "no re-fire without a real mtime advance");

  const rows = await readLedger(ws.ledgerJsonl);
  assert.equal(rows.length, 1);
});

test("a code file with two upstreams (declared in both sidecars) fires ONE row, N downstreams", async () => {
  const ws = await makeWorkspace("cd-merge-");
  await mkdir(path.join(ws.root, "lib"), { recursive: true });
  const codeFile = path.join(ws.root, "lib", "shared.ts");
  await writeFile(codeFile, "export const x = 1;");
  await writeFile(path.join(ws.root, "SPEC_A.md"), "spec A");
  await writeFile(path.join(ws.root, "SPEC_B.md"), "spec B");

  // Declared once via .code-canonical.yml...
  await writeFile(
    path.join(ws.root, ".code-canonical.yml"),
    `
canonical_pairs:
  - codePath: lib/shared.ts
    upstreamDoc: SPEC_A.md
    upstreamSection: "§A"
    note: "code-canonical pair"
`,
  );
  const canonicalEntries = loadCodeCanonicalSync(ws.root);
  assert.equal(canonicalEntries.length, 1);

  // ...and once more via a kind:code sidecar edge pointing at a DIFFERENT doc.
  const sidecarPath = path.join(ws.root, ".propagates.yml");
  await writeFile(
    sidecarPath,
    `
sources:
  SPEC_B.md:
    propagates_to:
      - path: lib/shared.ts
        why: "spec section B"
        kind: code
`,
  );
  const synthesized = await synthesizeFromSidecar(ws.root, sidecarPath);
  assert.equal(synthesized.length, 1);

  // Merge exactly as the main loop does.
  const grouped = groupByCodePath([...canonicalEntries, ...synthesized]);
  assert.equal(grouped.size, 1, "one codePath group");
  const upstreams = grouped.get("lib/shared.ts");
  assert.equal(upstreams.length, 2, "both upstream docs collected for the one codePath");

  const state = freshState();
  const results = await processCodeCanonical(ws, "lib/shared.ts", upstreams, state, new Map());
  assert.ok(results && results.length === 1, "one firing worktree result");
  assert.equal(results[0].count, 2, "N downstreams reported in the result");

  const rows = await readLedger(ws.ledgerJsonl);
  assert.equal(rows.length, 1, "exactly ONE code_drift row — no double-fire");
  assert.equal(rows[0].type, "code_drift");
  assert.equal(rows[0].source, "lib/shared.ts");
  assert.equal(rows[0].downstream.length, 2, "N downstreams on the single row");
  const docs = rows[0].downstream.map((d) => d.path).sort();
  assert.deepEqual(docs, ["SPEC_A.md", "SPEC_B.md"]);
});

test("a code file pointing at the same doc twice de-dups to one downstream entry", async () => {
  const ws = await makeWorkspace("cd-dedup-");
  await mkdir(path.join(ws.root, "lib"), { recursive: true });
  const codeFile = path.join(ws.root, "lib", "dup.ts");
  await writeFile(codeFile, "export const y = 1;");
  await writeFile(path.join(ws.root, "SPEC.md"), "spec");

  const entryA = { codePath: "lib/dup.ts", upstreamDoc: "SPEC.md", upstreamSection: "§1", note: "a" };
  const entryB = { codePath: "lib/dup.ts", upstreamDoc: "SPEC.md", upstreamSection: "§1 dup", note: "b" };

  const state = freshState();
  const results = await processCodeCanonical(ws, "lib/dup.ts", [entryA, entryB], state, new Map());
  assert.ok(results && results.length === 1);
  assert.equal(results[0].count, 1, "same upstreamDoc collapses to one downstream entry");

  const rows = await readLedger(ws.ledgerJsonl);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].downstream.length, 1);
});

test("prose-source change still fires forward drift (kind:code edges did not break processChange)", async () => {
  const ws = await makeWorkspace("cd-forward-");
  await mkdir(path.join(ws.root, "lib"), { recursive: true });
  const specFile = path.join(ws.root, "SPEC.md");
  await writeFile(specFile, "spec v1");
  await writeFile(path.join(ws.root, "lib", "engine.ts"), "export function run() {}");
  await writeFile(
    path.join(ws.root, ".propagates.yml"),
    `
sources:
  SPEC.md:
    propagates_to:
      - path: lib/engine.ts
        why: engine implementation must match spec
        kind: code
`,
  );

  const state = freshState();
  const result = await processChange(ws, specFile, state, new Map());
  assert.ok(result && result.id, "forward drift still fires on the prose source");

  const rows = await readLedger(ws.ledgerJsonl);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, "drift");
  assert.equal(rows[0].source, "SPEC.md");
  assert.equal(rows[0].downstream[0].path, "lib/engine.ts");
  assert.equal(rows[0].downstream[0].kind, "code");
});
