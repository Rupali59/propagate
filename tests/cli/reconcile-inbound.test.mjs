/**
 * Tests for lib/reconcile.mjs's `inboundRows` — the delivery query (2026-08
 * plan Part 2, "make drift that arrives from another repo visible where a
 * person can act on it"). A pure filter over reconcile()'s own rows:
 *
 *   inbound(repoRoot) = rows where downstream.path is under repoRoot
 *                         AND source.path is NOT under repoRoot
 *
 * Unit-testable without touching disk for the containment logic itself
 * (fake/non-existent paths fall back to path.resolve when realpath fails);
 * one test below deliberately DOES touch disk to exercise the realpath
 * resolution a symlinked/worktree repo needs (plan: "resolve repoRoot by
 * realpath — symlinks and worktrees make one directory reachable several
 * ways, and that blind spot already hid an orphaned ledger (B1)").
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { inboundRows } from "../../lib/edges/reconcile.mjs";

/** Minimal reconcile()-shaped row — only the fields inboundRows reads. */
function row(sourcePath, downstreamPath, state = "DRIFTED") {
  return {
    node_id: `node:${sourcePath}`,
    edge_id: `edge:${sourcePath}:${downstreamPath}`,
    source: { path: sourcePath, ref: null, contentId: "s", unresolvable: null },
    downstream: { path: downstreamPath, ref: null, contentId: "d", unresolvable: null },
    state,
    since: null,
    last: null,
    deferred: null,
    glob: null,
    sameRepo: false,
    unresolvable: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 1. Selects edges whose downstream is in the repo and source is not.
// ─────────────────────────────────────────────────────────────────────────

test("inboundRows — selects edges whose downstream is under repoRoot and whose source is not", () => {
  const repoRoot = "/fake/downstream-repo";
  const rows = [
    row("/fake/upstream-repo/persona/profile.yaml", "/fake/downstream-repo/lib/content.ts"),
    row("/fake/upstream-repo/persona/profile.yaml", "/fake/downstream-repo/lib/design-content.ts", "CLEAN"),
    row("/fake/elsewhere/other.md", "/fake/downstream-repo/nested/dir/file.ts"),
  ];

  const inbound = inboundRows(rows, repoRoot);
  assert.equal(inbound.length, 3);
  assert.ok(inbound.every((r) => r.downstream.path.startsWith(repoRoot + path.sep)));
  assert.ok(inbound.every((r) => !r.source.path.startsWith(repoRoot + path.sep)));
});

// ─────────────────────────────────────────────────────────────────────────
// 2. Excludes same-repo edges — both sides inside repoRoot is not "inbound".
// ─────────────────────────────────────────────────────────────────────────

test("inboundRows — excludes edges whose source is ALSO under repoRoot (same-repo drift is not inbound)", () => {
  const repoRoot = "/fake/downstream-repo";
  const rows = [
    row("/fake/downstream-repo/SPEC.md", "/fake/downstream-repo/lib/engine.ts"), // same repo
    row("/fake/upstream-repo/persona/profile.yaml", "/fake/downstream-repo/lib/content.ts"), // real inbound
  ];

  const inbound = inboundRows(rows, repoRoot);
  assert.equal(inbound.length, 1);
  assert.equal(inbound[0].source.path, "/fake/upstream-repo/persona/profile.yaml");
});

test("inboundRows — a row whose downstream is outside repoRoot entirely is excluded", () => {
  const repoRoot = "/fake/downstream-repo";
  const rows = [row("/fake/downstream-repo/SPEC.md", "/fake/unrelated-repo/lib/engine.ts")];
  assert.deepEqual(inboundRows(rows, repoRoot), []);
});

test("inboundRows — a row with a null downstream (e.g. UNMATCHED glob) is excluded, not thrown on", () => {
  const repoRoot = "/fake/downstream-repo";
  const rows = [row("/fake/upstream/src.txt", null, "UNMATCHED")];
  assert.deepEqual(inboundRows(rows, repoRoot), []);
});

// ─────────────────────────────────────────────────────────────────────────
// 3. realpath: a repo reachable via a symlink still matches.
// ─────────────────────────────────────────────────────────────────────────

test("inboundRows — a repo reached through a symlinked path still matches its real downstream rows", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "inbound-realpath-"));
  try {
    const realRepo = path.join(parent, "real-downstream-repo");
    await mkdir(path.join(realRepo, "lib"), { recursive: true });
    const linkPath = path.join(parent, "linked-downstream-repo");
    await symlink(realRepo, linkPath, "dir");

    const upstreamSrc = path.join(parent, "upstream-repo", "persona", "profile.yaml");
    const realDownstream = path.join(realRepo, "lib", "content.ts");
    // Must exist on disk: realpathSync only resolves symlink components
    // (e.g. macOS's /tmp -> /private/tmp) for paths that are actually
    // there — a nonexistent path falls back to path.resolve(), which would
    // leave the two sides of the comparison resolved inconsistently and
    // make this test assert nothing about realpath at all.
    await writeFile(realDownstream, "export const name = 'v1';\n");

    const rows = [row(upstreamSrc, realDownstream)];

    // Filtering by the SYMLINKED path must still find the row whose
    // downstream is recorded under the real path — and vice versa.
    const viaSymlink = inboundRows(rows, linkPath);
    assert.equal(viaSymlink.length, 1, "repoRoot given as a symlink must still match the real downstream path");

    const viaReal = inboundRows(rows, realRepo);
    assert.equal(viaReal.length, 1, "repoRoot given as the real path matches directly");
  } finally {
    await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("inboundRows — repoRoot itself (not a subpath) still counts as under it", () => {
  const rows = [row("/fake/upstream/src.txt", "/fake/downstream-repo")];
  const inbound = inboundRows(rows, "/fake/downstream-repo");
  assert.equal(inbound.length, 1);
});
