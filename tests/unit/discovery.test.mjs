import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { discoverWorkspacesSync, isWorkspaceMarker, liveLedgerCandidates } from "../../lib/core/discovery.mjs";

async function makeMarker(dir, body) {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, ".propagates.yml"), body, "utf8");
}

const UNFLAGGED = `sources: {}\n`;
const FLAGGED = `workspace: true\nsources: {}\n`;

test("marker without workspace: true is not a workspace, and the walk descends past it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "disc-"));
  await makeMarker(root, UNFLAGGED);
  const childDir = path.join(root, "child");
  await makeMarker(childDir, FLAGGED);

  const { workspaces, markersSeen, degraded } = discoverWorkspacesSync([root]);

  assert.equal(workspaces.length, 1, "only the flagged child is a workspace");
  assert.equal(workspaces[0].root, childDir);
  assert.equal(markersSeen, 2, "both markers were observed during the walk");
  assert.equal(degraded, false);
});

test("parent and child both flagged: both are returned (real nesting)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "disc-"));
  await makeMarker(root, FLAGGED);
  const childDir = path.join(root, "child");
  await makeMarker(childDir, FLAGGED);

  const { workspaces } = discoverWorkspacesSync([root]);
  const roots = workspaces.map((w) => w.root).sort();

  assert.deepEqual(roots, [root, childDir].sort());
});

test("REGRESSION: flagged parent with an unflagged docs/ sidecar yields exactly one workspace, ledger pinned under docs/", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "disc-"));
  await makeMarker(root, FLAGGED);
  const docsDir = path.join(root, "docs");
  await makeMarker(docsDir, UNFLAGGED);

  const { workspaces } = discoverWorkspacesSync([root]);

  assert.equal(workspaces.length, 1, "the docs/ sidecar must not mint a second workspace");
  assert.equal(workspaces[0].root, root);
  assert.equal(
    workspaces[0].ledgerJsonl,
    path.join(root, "docs", "PROPAGATION_LEDGER.jsonl"),
    "docs/ exists, so the legacy convention applies (no existing ledger to pin to)",
  );
});

test("LEDGER PINNING: a workspace with an existing .propagation/ledger.jsonl does not relocate when docs/ is created later", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "disc-"));
  await makeMarker(root, FLAGGED);

  // Simulate a pre-existing ledger at the legacy .propagation/ path.
  const propagationDir = path.join(root, ".propagation");
  await mkdir(propagationDir, { recursive: true });
  await writeFile(path.join(propagationDir, "ledger.jsonl"), "", "utf8");

  // Now a docs/ dir shows up (e.g. someone adds documentation later).
  await mkdir(path.join(root, "docs"), { recursive: true });

  const { workspaces } = discoverWorkspacesSync([root]);

  assert.equal(workspaces.length, 1);
  assert.equal(
    workspaces[0].ledgerJsonl,
    path.join(propagationDir, "ledger.jsonl"),
    "existing ledger must be pinned, not orphaned in favor of the new docs/ convention",
  );
});

test("malformed YAML in a marker is skipped, not thrown", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "disc-"));
  await makeMarker(root, "workspace: true\nsources: {\n  this is not valid yaml: [[[");

  assert.doesNotThrow(() => discoverWorkspacesSync([root]));
  const { workspaces, degraded } = discoverWorkspacesSync([root]);
  assert.equal(workspaces.length, 0);
  assert.equal(degraded, true, "a marker existed but none validly opted in");
});

test("isWorkspaceMarker returns false (never throws) for a missing or malformed file", () => {
  assert.equal(isWorkspaceMarker("/nonexistent/path/.propagates.yml"), false);
});

test("degraded is true when markers exist but none is flagged workspace: true", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "disc-"));
  await makeMarker(root, UNFLAGGED);
  await makeMarker(path.join(root, "child"), UNFLAGGED);

  const { workspaces, degraded } = discoverWorkspacesSync([root]);

  assert.equal(workspaces.length, 0);
  assert.equal(degraded, true);
});

test("degraded is false when no markers exist at all", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "disc-"));

  const { workspaces, markersSeen, degraded } = discoverWorkspacesSync([root]);

  assert.equal(workspaces.length, 0);
  assert.equal(markersSeen, 0);
  assert.equal(degraded, false, "no markers seen at all is not the degraded failure mode");
});

// ─────────────────────────────────────────────────────────────────────────
// propagation/ layout (docs/DECISIONS.md, "a propagation/ folder in every
// workspace"). RED items 1 and 2 of the plan at
// ~/.claude/plans/status-temporal-plum.md.
// ─────────────────────────────────────────────────────────────────────────

test("PROPAGATION/ LAYOUT: a workspace with propagation/ledger.jsonl present resolves to it, first-checked", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "disc-"));
  await makeMarker(root, FLAGGED);

  const propagationDir = path.join(root, "propagation");
  await mkdir(propagationDir, { recursive: true });
  await writeFile(path.join(propagationDir, "ledger.jsonl"), "", "utf8");
  await writeFile(path.join(propagationDir, "ledger.md"), "", "utf8");

  const { workspaces } = discoverWorkspacesSync([root]);

  assert.equal(workspaces.length, 1);
  assert.equal(workspaces[0].ledgerJsonl, path.join(propagationDir, "ledger.jsonl"));
  assert.equal(workspaces[0].ledgerMd, path.join(propagationDir, "ledger.md"));
});

test("PROPAGATION/ LAYOUT: propagation/ledger.jsonl wins even when an older candidate also exists (checked first)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "disc-"));
  await makeMarker(root, FLAGGED);

  // An older docs/-pinned ledger exists too — propagation/ still wins because
  // it is checked FIRST when a file is actually there.
  const docsDir = path.join(root, "docs");
  await mkdir(docsDir, { recursive: true });
  await writeFile(path.join(docsDir, "PROPAGATION_LEDGER.jsonl"), "", "utf8");

  const propagationDir = path.join(root, "propagation");
  await mkdir(propagationDir, { recursive: true });
  await writeFile(path.join(propagationDir, "ledger.jsonl"), "", "utf8");

  const { workspaces } = discoverWorkspacesSync([root]);

  assert.equal(workspaces.length, 1);
  assert.equal(workspaces[0].ledgerJsonl, path.join(propagationDir, "ledger.jsonl"));
});

test("PROPAGATION/ LAYOUT INERTNESS: a bare empty propagation/ directory (no ledger file inside) does NOT relocate a live docs/ ledger", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "disc-"));
  await makeMarker(root, FLAGGED);

  const docsDir = path.join(root, "docs");
  await mkdir(docsDir, { recursive: true });
  await writeFile(path.join(docsDir, "PROPAGATION_LEDGER.jsonl"), "", "utf8");

  // propagation/ shows up as a bare directory — e.g. someone started a git mv
  // and hasn't finished, or a totally unrelated dir with that name. No FILE
  // there yet, so it must not win.
  await mkdir(path.join(root, "propagation"), { recursive: true });

  const { workspaces } = discoverWorkspacesSync([root]);

  assert.equal(workspaces.length, 1);
  assert.equal(
    workspaces[0].ledgerJsonl,
    path.join(docsDir, "PROPAGATION_LEDGER.jsonl"),
    "a bare propagation/ directory must not relocate a live docs/ ledger — only a FILE there wins",
  );
});

test("liveLedgerCandidates: reports every existing candidate ledger .jsonl for a workspace root", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "disc-"));

  assert.deepEqual(liveLedgerCandidates(root), [], "no candidates on a bare directory");

  const docsDir = path.join(root, "docs");
  await mkdir(docsDir, { recursive: true });
  const docsJsonl = path.join(docsDir, "PROPAGATION_LEDGER.jsonl");
  await writeFile(docsJsonl, "", "utf8");

  assert.deepEqual(liveLedgerCandidates(root), [docsJsonl]);

  const propagationDir = path.join(root, "propagation");
  await mkdir(propagationDir, { recursive: true });
  const propagationJsonl = path.join(propagationDir, "ledger.jsonl");
  await writeFile(propagationJsonl, "", "utf8");

  const found = liveLedgerCandidates(root);
  assert.equal(found.length, 2, "both candidates now live — the phantom-ledger state");
  assert.ok(found.includes(docsJsonl));
  assert.ok(found.includes(propagationJsonl));
});
