/**
 * `propagate check` — commit-time drift gate.
 *
 * Exercises the exported core (`computeCouplings` / `runCheck`) against a
 * temp workspace + sidecar, mirroring tests/watcher.regression.test.mjs /
 * tests/code-drift.test.mjs's temp-dir harness. We drive the core directly
 * rather than shelling out to `node cli.mjs check` so tests don't depend on
 * a real git repo or the real (machine-specific) WORKSPACES list.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { computeCouplings, runCheck, resolveChangedFile } from "../cli.mjs";
import { appendRow } from "../lib/ledger.mjs";

async function makeWorkspace(prefix) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const ledgerJsonl = path.join(root, "PROPAGATION_LEDGER.jsonl");
  const ledgerMd = path.join(root, "PROPAGATION_LEDGER.md");
  return { name: path.basename(root), root, ledgerJsonl, ledgerMd, scanDirs: ["."] };
}

test("check — changed declared code file reports its upstream doc (reverse edge)", async () => {
  const ws = await makeWorkspace("chk-reverse-");
  await mkdir(path.join(ws.root, "lib"), { recursive: true });
  await writeFile(path.join(ws.root, "SPEC.md"), "spec v1");
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

  const couplings = await computeCouplings(["lib/engine.ts"], ws.root, [ws]);
  assert.equal(couplings.length, 1);
  assert.equal(couplings[0].file, "lib/engine.ts");
  assert.deepEqual(couplings[0].coupled, ["SPEC.md"]);
});

test("check — changed prose source reports its downstreams (forward edge)", async () => {
  const ws = await makeWorkspace("chk-forward-");
  await mkdir(path.join(ws.root, "lib"), { recursive: true });
  await writeFile(path.join(ws.root, "SPEC.md"), "spec v1");
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

  const couplings = await computeCouplings(["SPEC.md"], ws.root, [ws]);
  assert.equal(couplings.length, 1);
  assert.equal(couplings[0].file, "SPEC.md");
  assert.deepEqual(couplings[0].coupled, ["lib/engine.ts"]);
});

test("check — unrelated changed file: no coupling reported", async () => {
  const ws = await makeWorkspace("chk-unrelated-");
  await mkdir(path.join(ws.root, "lib"), { recursive: true });
  await writeFile(path.join(ws.root, "SPEC.md"), "spec v1");
  await writeFile(path.join(ws.root, "lib", "engine.ts"), "export function run() {}");
  await writeFile(path.join(ws.root, "README.md"), "unrelated");
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

  const couplings = await computeCouplings(["README.md"], ws.root, [ws]);
  assert.equal(couplings.length, 0);
});

test("check --strict: exits 1 when a coupling exists, 0 when none", async () => {
  const ws = await makeWorkspace("chk-strict-");
  await mkdir(path.join(ws.root, "lib"), { recursive: true });
  await writeFile(path.join(ws.root, "SPEC.md"), "spec v1");
  await writeFile(path.join(ws.root, "lib", "engine.ts"), "export function run() {}");
  await writeFile(path.join(ws.root, "README.md"), "unrelated");
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

  const withCoupling = await runCheck(
    { changedFiles: ["SPEC.md"], repoRoot: ws.root, strict: true },
    [ws],
  );
  assert.equal(withCoupling.exitCode, 1);

  const withoutCoupling = await runCheck(
    { changedFiles: ["README.md"], repoRoot: ws.root, strict: true },
    [ws],
  );
  assert.equal(withoutCoupling.exitCode, 0);
});

test("check: default (non-strict) exits 0 even when a coupling exists", async () => {
  const ws = await makeWorkspace("chk-nonstrict-");
  await mkdir(path.join(ws.root, "lib"), { recursive: true });
  await writeFile(path.join(ws.root, "SPEC.md"), "spec v1");
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

  const result = await runCheck({ changedFiles: ["SPEC.md"], repoRoot: ws.root, strict: false }, [ws]);
  assert.equal(result.exitCode, 0);
  assert.equal(result.couplings.length, 1);
});

test("check: open ledger row for a changed file is surfaced even without a declared edge", async () => {
  const ws = await makeWorkspace("chk-ledger-");
  await writeFile(path.join(ws.root, "orphan.md"), "no sidecar for this one");
  // No .propagates.yml at all — this file isn't declared anywhere — but it
  // already has an open drift row in the ledger (e.g. filed by hand, or by
  // an earlier watcher fire whose sidecar was later removed).
  await appendRow(ws.ledgerJsonl, {
    type: "drift",
    id: "001",
    source: "orphan.md",
    change: "manually filed",
    downstream: [{ path: "somewhere.md", why: "manual", kind: "prose" }],
    status: "open",
  });

  const couplings = await computeCouplings(["orphan.md"], ws.root, [ws]);
  assert.equal(couplings.length, 1);
  assert.equal(couplings[0].file, "orphan.md");
  assert.deepEqual(couplings[0].openLedgerIds, ["001"]);
  assert.deepEqual(couplings[0].coupled, []);
});

test("check: a closed (done) ledger row is NOT surfaced", async () => {
  const ws = await makeWorkspace("chk-closed-");
  await writeFile(path.join(ws.root, "orphan.md"), "closed drift");
  await appendRow(ws.ledgerJsonl, {
    type: "drift",
    id: "001",
    source: "orphan.md",
    change: "manually filed",
    downstream: [{ path: "somewhere.md", why: "manual", kind: "prose" }],
    status: "open",
  });
  await appendRow(ws.ledgerJsonl, { type: "status_change", id: "001", status: "done" });

  const couplings = await computeCouplings(["orphan.md"], ws.root, [ws]);
  assert.equal(couplings.length, 0);
});

test("resolveChangedFile: nearest-ancestor wins for nested workspaces (F4)", async () => {
  const outer = await makeWorkspace("chk-outer-");
  const innerRoot = path.join(outer.root, "nested-repo");
  await mkdir(innerRoot, { recursive: true });
  const inner = { name: "nested-repo", root: innerRoot, ledgerJsonl: path.join(innerRoot, "l.jsonl"), ledgerMd: path.join(innerRoot, "l.md"), scanDirs: ["."] };

  const abs = path.join(innerRoot, "SPEC.md");
  const resolved = resolveChangedFile(abs, [outer, inner]);
  assert.ok(resolved);
  assert.equal(resolved.workspace.name, "nested-repo");
  assert.equal(resolved.rel, "SPEC.md");
});

test("resolveChangedFile: path outside every workspace returns null", () => {
  const resolved = resolveChangedFile("/no/such/workspace/file.md", []);
  assert.equal(resolved, null);
});
