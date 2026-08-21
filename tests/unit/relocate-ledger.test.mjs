/**
 * relocate-ledger (lib/edges/relocate-ledger.mjs) — moves one workspace's
 * ledger pair onto the propagation/ layout via `git mv`. Per
 * ~/.claude/plans/status-temporal-plum.md §4:
 *   1. Resolve the workspace's current ledger, refuse if already on propagation/.
 *   2. git mv both files.
 *   3. Re-run discovery; assert it now pins propagation/ AND no second ledger
 *      was created at the old location.
 *   4. Assert edge ids/states are unchanged across the move.
 *   5. Refuse loudly if the workspace would end with >1 live ledger file.
 *
 * The phantom-ledger hazard (RED item 4 of the plan's verification list):
 * moving a ledger to propagation/ on a discovery.mjs that doesn't know that
 * layout exists causes BOTH older candidates to vanish at once, so the
 * cascade falls to the docs/-exists heuristic, repins to docs/, and
 * `ensureLedgerPair` mints a fresh EMPTY ledger there — the real ledger,
 * now at propagation/, is unowned. This file reproduces that failure
 * mathematically against a frozen copy of the PRE-FIX two-candidate cascade
 * (the shipped discovery.mjs already carries the fix, so the only way to
 * demonstrate the hazard is to reimplement the vulnerable logic exactly as
 * it existed, and show it behaves differently from the current, fixed one),
 * then proves relocate-ledger refuses to run against an already-phantom
 * workspace rather than compounding it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { discoverWorkspacesSync, liveLedgerCandidates } from "../../lib/core/discovery.mjs";
import { relocateLedger, ledgerFingerprint } from "../../lib/edges/relocate-ledger.mjs";
import { readLedger } from "../../lib/edges/ledger.mjs";

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function makeRepo() {
  const root = await mkdtemp(path.join(tmpdir(), "relocate-"));
  git(["init", "-q", "-b", "main"], root);
  git(["config", "user.email", "test@example.com"], root);
  git(["config", "user.name", "Test"], root);
  return root;
}

function driftLine(id) {
  return JSON.stringify({
    type: "drift",
    id,
    timestamp: "2026-08-01T00:00:00.000Z",
    source: `${id}.md`,
    change: `drift on ${id}`,
    status: "open",
  });
}

async function commitAll(root, msg) {
  git(["add", "-A"], root);
  git(["commit", "-q", "-m", msg], root);
}

/** Build a workspace with a live docs/-pinned ledger, committed. */
async function makeDocsWorkspace(root) {
  await writeFile(path.join(root, ".propagates.yml"), "workspace: true\nsources: {}\n", "utf8");
  const docsDir = path.join(root, "docs");
  await mkdir(docsDir, { recursive: true });
  const jsonl = path.join(docsDir, "PROPAGATION_LEDGER.jsonl");
  await writeFile(jsonl, [driftLine("001"), driftLine("002")].join("\n") + "\n", "utf8");
  await writeFile(path.join(docsDir, "PROPAGATION_LEDGER.md"), "# Propagation Ledger\n", "utf8");
  await commitAll(root, "seed workspace");
  return { docsDir, jsonl, md: path.join(docsDir, "PROPAGATION_LEDGER.md") };
}

// ─────────────────────────────────────────────────────────────────────────
// RED item 4: reproduce the phantom-ledger hazard, then assert it's prevented.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Frozen copy of the PRE-FIX two-candidate cascade (discovery.mjs before
 * this plan's §1 change) — deliberately does NOT know about propagation/.
 * Mirrors makeWorkspaceRecord's old body exactly, so it reproduces the
 * hazard rather than approximating it.
 */
function preFixResolve(wsRoot) {
  const docsDir = path.join(wsRoot, "docs");
  const docsExists = existsSync(docsDir);
  const docsJsonl = path.join(docsDir, "PROPAGATION_LEDGER.jsonl");
  const legacyJsonl = path.join(wsRoot, ".propagation", "ledger.jsonl");

  let docsExistsForLedger;
  if (existsSync(docsJsonl)) {
    docsExistsForLedger = true;
  } else if (existsSync(legacyJsonl)) {
    docsExistsForLedger = false;
  } else {
    docsExistsForLedger = docsExists;
  }
  const ledgerHadNoPriorFile = !existsSync(docsJsonl) && !existsSync(legacyJsonl);
  const ledgerDir = docsExistsForLedger ? docsDir : path.join(wsRoot, ".propagation");
  const ledgerJsonl = docsExistsForLedger ? docsJsonl : legacyJsonl;
  return { ledgerJsonl, ledgerHadNoPriorFile, ledgerDir };
}

test("PHANTOM-LEDGER HAZARD, reproduced: a raw move to propagation/ orphans the real ledger under the PRE-FIX cascade", async (t) => {
  const root = await makeRepo();
  const { jsonl } = await makeDocsWorkspace(root);
  t.after(async () => {});

  // Raw move, bypassing relocate-ledger entirely (this is what a bare `git
  // mv` alone would do, or what a stranger unaware of this tool might try).
  const propagationDir = path.join(root, "propagation");
  await mkdir(propagationDir, { recursive: true });
  git(["mv", jsonl, path.join(propagationDir, "ledger.jsonl")], root);

  // Under the PRE-FIX cascade, both old candidates are now gone, so it falls
  // to the docs/-exists heuristic. docs/ still exists (the dir wasn't
  // removed, only the .jsonl moved out of it), so it repins to docs/ and
  // would mint a FRESH EMPTY ledger there on next use.
  const resolved = preFixResolve(root);
  assert.equal(
    resolved.ledgerJsonl,
    path.join(root, "docs", "PROPAGATION_LEDGER.jsonl"),
    "the pre-fix cascade repins to docs/ once both its known candidates vanish",
  );
  assert.equal(resolved.ledgerHadNoPriorFile, true, "pre-fix: neither of its two known candidates exists any more");
  assert.equal(
    existsSync(path.join(propagationDir, "ledger.jsonl")),
    true,
    "the REAL ledger (2 open rows) now sits at propagation/, invisible to the pre-fix cascade",
  );

  // The CURRENT (fixed) cascade does not suffer this — it checks
  // propagation/ first and pins there correctly.
  const { workspaces } = discoverWorkspacesSync([root]);
  assert.equal(workspaces.length, 1);
  assert.equal(workspaces[0].ledgerJsonl, path.join(propagationDir, "ledger.jsonl"));
});

test("relocate-ledger REFUSES to run when the workspace is already in a phantom (multi-ledger) state", async (t) => {
  const root = await makeRepo();
  await makeDocsWorkspace(root);
  await writeFile(path.join(root, ".propagates.yml"), "workspace: true\nsources: {}\n", "utf8");

  // Manufacture the phantom state directly: a live ledger at BOTH docs/ and
  // propagation/ at once (e.g. left behind by an interrupted raw move).
  const propagationDir = path.join(root, "propagation");
  await mkdir(propagationDir, { recursive: true });
  await writeFile(path.join(propagationDir, "ledger.jsonl"), driftLine("999") + "\n", "utf8");
  await commitAll(root, "simulate phantom split brain");

  assert.equal(liveLedgerCandidates(root).length, 2, "fixture sanity: two live candidates");

  await assert.rejects(
    () => relocateLedger({ workspace: root, apply: false }),
    /already on the propagation\/ layout|more than one live ledger file/i,
  );
  await assert.rejects(
    () => relocateLedger({ workspace: root, apply: true }),
    /already on the propagation\/ layout|more than one live ledger file/i,
  );

  // Refusal must not have changed anything on disk.
  assert.equal(liveLedgerCandidates(root).length, 2, "refusal must not touch the phantom state");
});

// ─────────────────────────────────────────────────────────────────────────
// RED item 7: dry-run writes nothing.
// ─────────────────────────────────────────────────────────────────────────

async function snapshotTree(root) {
  const out = new Map();
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name === ".git") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else {
        out.set(full, await readFile(full, "utf8"));
      }
    }
  }
  await walk(root);
  return out;
}

test("relocate-ledger dry-run writes nothing — snapshot equality before/after", async (t) => {
  const root = await makeRepo();
  await makeDocsWorkspace(root);

  const before = await snapshotTree(root);
  const result = await relocateLedger({ workspace: root, apply: false });
  const after = await snapshotTree(root);

  assert.equal(result.applied, false);
  assert.deepEqual([...after.entries()], [...before.entries()], "dry-run must not write, move, or modify any file");
  assert.equal(after.size, before.size, "dry-run must not create or delete any file");
});

test("relocate-ledger dry-run reports the intended move without performing it", async (t) => {
  const root = await makeRepo();
  const { jsonl, md } = await makeDocsWorkspace(root);

  const result = await relocateLedger({ workspace: root, apply: false });

  assert.equal(result.applied, false);
  assert.equal(result.from.jsonl, jsonl);
  assert.equal(result.from.md, md);
  assert.equal(result.into.jsonl, path.join(root, "propagation", "ledger.jsonl"));
  assert.equal(result.rowCount, 2);
  assert.equal(existsSync(path.join(root, "propagation")), false, "dry-run must not even create the directory");
});

// ─────────────────────────────────────────────────────────────────────────
// --apply: the real move, history, ids/state, and re-discovery.
// ─────────────────────────────────────────────────────────────────────────

test("relocate-ledger --apply moves both files via git mv, history follows, ids/state unchanged, and re-discovery pins propagation/", async (t) => {
  const root = await makeRepo();
  const { jsonl, md } = await makeDocsWorkspace(root);
  const rowsBefore = await readLedger(jsonl);
  const fingerprintBefore = ledgerFingerprint(rowsBefore);

  const result = await relocateLedger({ workspace: root, apply: true });

  assert.equal(result.applied, true);
  assert.equal(existsSync(jsonl), false, "old .jsonl location must be gone");
  assert.equal(existsSync(md), false, "old .md location must be gone");

  const newJsonl = path.join(root, "propagation", "ledger.jsonl");
  const newMd = path.join(root, "propagation", "ledger.md");
  assert.equal(existsSync(newJsonl), true);
  assert.equal(existsSync(newMd), true);

  // History followed the move (needs a commit for git mv to register as a
  // rename in log; relocate-ledger itself doesn't commit, so commit here to
  // exercise --follow the same way a real workflow would).
  await commitAll(root, "relocate to propagation/");
  const log = git(["log", "--follow", "--oneline", "--", newJsonl], root);
  assert.match(log, /seed workspace/, "git log --follow on the moved ledger reaches its pre-move commit");

  // No second ledger anywhere.
  assert.equal(liveLedgerCandidates(root).length, 1);

  // Ids/states unchanged.
  const rowsAfter = await readLedger(newJsonl);
  const fingerprintAfter = ledgerFingerprint(rowsAfter);
  assert.deepEqual(fingerprintAfter, fingerprintBefore);

  // Discovery re-pins.
  const { workspaces } = discoverWorkspacesSync([root]);
  assert.equal(workspaces.length, 1);
  assert.equal(workspaces[0].ledgerJsonl, newJsonl);
});

test("relocate-ledger refuses a workspace already on the propagation/ layout", async (t) => {
  const root = await makeRepo();
  await makeDocsWorkspace(root);
  await relocateLedger({ workspace: root, apply: true });

  await assert.rejects(
    () => relocateLedger({ workspace: root, apply: true }),
    /already on the propagation\/ layout/i,
  );
});

test("relocate-ledger refuses a non-workspace directory", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "relocate-nonws-"));
  await assert.rejects(
    () => relocateLedger({ workspace: root, apply: false }),
    /not a discoverable workspace/i,
  );
});
