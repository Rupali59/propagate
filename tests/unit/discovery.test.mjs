import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
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

test("REGRESSION: flagged parent with an unflagged docs/ sidecar yields exactly one workspace, ledger canonical", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "disc-"));
  await makeMarker(root, FLAGGED);
  const docsDir = path.join(root, "docs");
  await makeMarker(docsDir, UNFLAGGED);

  const { workspaces } = discoverWorkspacesSync([root]);

  assert.equal(workspaces.length, 1, "the docs/ sidecar must not mint a second workspace");
  assert.equal(workspaces[0].root, root);
  // CHANGED 2026-08-22. This assertion used to read
  // `docs/PROPAGATION_LEDGER.jsonl`, with the rationale "docs/ exists, so
  // the legacy convention applies (no existing ledger to pin to)". That
  // sentence describes the accident, not a requirement: with NO ledger
  // anywhere, the mere presence of a docs/ directory decided the ledger's
  // home. New workspaces now pin the canonical layout instead.
  //
  // This test's REGRESSION subject -- one marker in docs/ must not mint a
  // second workspace -- is the assertion above and is untouched.
  assert.equal(
    workspaces[0].ledgerJsonl,
    path.join(root, "propagation", "ledger.jsonl"),
    "a brand-new workspace pins the canonical layout regardless of whether docs/ exists",
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

// ─────────────────────────────────────────────────────────────────────────
// A BRAND-NEW workspace must land at the CANONICAL layout.
//
// docs/REFERENCE.md §"Ledger layout" is canonical: every workspace keeps its
// propagation items in `<workspace>/propagation/`, and
// `docs/PROPAGATION_LEDGER.*` / `.propagation/ledger.*` are the SUPERSEDED
// forms. Until 2026-08-22 `makeWorkspaceRecord`'s fallback produced one of
// the two superseded layouts for every new workspace — `docs/` if that
// directory happened to exist, `.propagation/` otherwise — so `init` could
// never create the canonical one.
//
// That is the cause docs/DECISIONS.md described as contained but not
// removed: "the location remains an accident of directory layout at
// first-write time; the guard contains the damage but does not remove the
// cause." Three layouts across eight ledgers came from exactly this.
//
// The PINNING rule is untouched and is what makes this safe to change: a
// workspace with a live ledger at either superseded path still pins there.
// Only the no-ledger-anywhere case moves.
// ─────────────────────────────────────────────────────────────────────────

test("discovery: a brand-new workspace with NO docs/ pins the canonical propagation/ layout", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "disc-canon-nodocs-"));
  try {
    await writeFile(path.join(root, ".propagates.yml"), "workspace: true\n\nsources: {}\n");
    const { workspaces } = discoverWorkspacesSync([root]);
    const ws = workspaces.find((w) => w.root === root);
    assert.ok(ws, "the marked root must be discovered");
    assert.equal(ws.ledgerJsonl, path.join(root, "propagation", "ledger.jsonl"));
    assert.equal(ws.ledgerMd, path.join(root, "propagation", "ledger.md"));
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("discovery: a brand-new workspace WITH docs/ still pins propagation/, not docs/", async () => {
  // The docs/-exists heuristic is the specific accident being removed: the
  // mere presence of a docs/ directory decided the ledger's home.
  const root = await mkdtemp(path.join(tmpdir(), "disc-canon-docs-"));
  try {
    await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(path.join(root, ".propagates.yml"), "workspace: true\n\nsources: {}\n");
    const { workspaces } = discoverWorkspacesSync([root]);
    const ws = workspaces.find((w) => w.root === root);
    assert.equal(ws.ledgerJsonl, path.join(root, "propagation", "ledger.jsonl"));
    assert.ok(
      !existsSync(path.join(root, "docs", "PROPAGATION_LEDGER.jsonl")),
      "a superseded ledger must not be created alongside the canonical one",
    );
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("discovery: an EXISTING superseded ledger is still pinned — the move never relocates live data", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "disc-canon-pin-"));
  try {
    await mkdir(path.join(root, "docs"), { recursive: true });
    const live = path.join(root, "docs", "PROPAGATION_LEDGER.jsonl");
    await writeFile(live, '{"id":1,"status":"open"}\n');
    await writeFile(path.join(root, ".propagates.yml"), "workspace: true\n\nsources: {}\n");
    const { workspaces } = discoverWorkspacesSync([root]);
    const ws = workspaces.find((w) => w.root === root);
    assert.equal(ws.ledgerJsonl, live, "a live ledger must stay pinned where it is");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
