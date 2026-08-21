/**
 * relocate-ledger: move ONE workspace's ledger pair (.jsonl + .md) onto the
 * `propagation/` layout via `git mv`, so history follows and discovery
 * re-pins to the new location. Per docs/DECISIONS.md ("a propagation/ folder
 * in every workspace") and ~/.claude/plans/status-temporal-plum.md §4, this
 * is a RELOCATION, never a row migration: ids, `source` values, and
 * `status_change` chains are all untouched. `lib/edges/migrate-ledger.mjs`
 * is the wrong tool for this — its `deriveRoots` computes an empty prefix
 * for a same-workspace move (paths survive), but it still renumbers every
 * id for what is only a file move, discarding id continuity for no gain.
 *
 * WHY A BARE `git mv` IS UNSAFE (checked against the current implementation,
 * not hypothetically — see the plan's "Files" section and the phantom-ledger
 * test in tests/unit/relocate-ledger.test.mjs): move a ledger to
 * `propagation/` on a version of discovery.mjs that doesn't know that layout
 * exists, and BOTH older candidates (`docs/PROPAGATION_LEDGER.jsonl`,
 * `.propagation/ledger.jsonl`) vanish at once. The cascade falls through to
 * the `docs/`-exists heuristic, repins to `docs/`, and `ensureLedgerPair`
 * mints a FRESH EMPTY ledger there. The real ledger — now sitting at
 * `propagation/ledger.jsonl` — is unowned by any workspace record and fails
 * `doctor`. Split brain, from a raw file move alone. This module refuses to
 * proceed whenever the workspace already carries more than one live ledger
 * file (see `liveLedgerCandidates`), which is exactly that state, so it can
 * never compound an already-broken migration.
 *
 * Dry-run by default. `--apply` (the `apply: true` option) is the only thing
 * that writes.
 */

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { discoverWorkspacesSync, liveLedgerCandidates } from "../core/discovery.mjs";
import { readLedger } from "./ledger.mjs";

/** Sorted `{id, status}` pairs — the identity+state snapshot relocate-ledger
 * must prove unchanged across the move (step 4 of the plan). Exported for
 * direct testing. */
export function ledgerFingerprint(rows) {
  return rows
    .map((r) => ({ id: String(r.id), status: r.status }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function gitMv(cwd, from, to) {
  execFileSync("git", ["mv", from, to], { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * @param {{workspace: string, apply?: boolean}} opts
 * @returns {Promise<object>} result summary — same shape whether dry-run or applied,
 *   distinguished by `applied`.
 */
export async function relocateLedger({ workspace, apply = false }) {
  if (!workspace) {
    throw new Error("relocate-ledger: --workspace is required");
  }
  const wsRoot = path.resolve(workspace);
  if (!existsSync(wsRoot)) {
    throw new Error(`relocate-ledger: workspace root does not exist: ${wsRoot}`);
  }

  // Resolve the workspace's CURRENT ledger via the same discovery logic
  // everything else in the skill uses — never re-derive independently, and
  // never assume a layout by reconstructing a path (that class of bug is
  // exactly what §2 of the plan this module ships alongside exists to fix).
  const { workspaces } = discoverWorkspacesSync([wsRoot], 0);
  const record = workspaces.find((w) => path.resolve(w.root) === wsRoot);
  if (!record) {
    throw new Error(
      `relocate-ledger: ${wsRoot} is not a discoverable workspace (no .propagates.yml with workspace: true at its root)`,
    );
  }

  const propagationDir = path.join(wsRoot, "propagation");
  const propagationJsonl = path.join(propagationDir, "ledger.jsonl");
  const propagationMd = path.join(propagationDir, "ledger.md");

  if (path.resolve(record.ledgerJsonl) === propagationJsonl) {
    throw new Error(`relocate-ledger: ${wsRoot} is already on the propagation/ layout — nothing to do`);
  }

  // Refuse loudly if the workspace ALREADY has more than one live ledger
  // file — the phantom-ledger state. Compounding an already-split-brain
  // workspace with another move can only make it worse.
  const candidatesBefore = liveLedgerCandidates(wsRoot);
  if (candidatesBefore.length > 1) {
    throw new Error(
      `relocate-ledger: ${wsRoot} already has more than one live ledger file (${candidatesBefore.join(
        ", ",
      )}) — resolve that split brain before relocating`,
    );
  }

  const sourceJsonl = record.ledgerJsonl;
  const sourceMd = record.ledgerMd;

  if (!existsSync(sourceJsonl)) {
    throw new Error(`relocate-ledger: resolved ledger .jsonl does not exist on disk: ${sourceJsonl}`);
  }
  const sourceMdExists = existsSync(sourceMd);

  const rowsBefore = await readLedger(sourceJsonl);
  const fingerprintBefore = ledgerFingerprint(rowsBefore);

  if (!apply) {
    return {
      applied: false,
      workspace: wsRoot,
      from: { jsonl: sourceJsonl, md: sourceMdExists ? sourceMd : null },
      into: { jsonl: propagationJsonl, md: propagationMd },
      rowCount: rowsBefore.length,
    };
  }

  await mkdir(propagationDir, { recursive: true });

  // git mv both files — history follows (`git log --follow` reaches the
  // pre-move commits). A plain fs rename would not carry rename detection
  // the same way, and would not stage the change.
  gitMv(wsRoot, sourceJsonl, propagationJsonl);
  if (sourceMdExists) {
    gitMv(wsRoot, sourceMd, propagationMd);
  }

  // Re-run discovery and assert: (1) the workspace now pins propagation/,
  // and (2) no second ledger was created at the old location — the exact
  // phantom-ledger failure this module exists to prevent.
  const { workspaces: after } = discoverWorkspacesSync([wsRoot], 0);
  const recordAfter = after.find((w) => path.resolve(w.root) === wsRoot);
  const candidatesAfter = liveLedgerCandidates(wsRoot);

  if (!recordAfter || path.resolve(recordAfter.ledgerJsonl) !== propagationJsonl) {
    throw new Error(
      `relocate-ledger: post-move discovery did not pin ${wsRoot} to propagation/ledger.jsonl — got ${
        recordAfter ? recordAfter.ledgerJsonl : "(no workspace record at all)"
      }. The move happened; the ledger is now unowned. Fix discovery before retrying.`,
    );
  }
  if (candidatesAfter.length > 1) {
    throw new Error(
      `relocate-ledger: after moving, ${wsRoot} has more than one live ledger file (${candidatesAfter.join(
        ", ",
      )}) — a phantom ledger was created. The move happened; investigate before proceeding.`,
    );
  }

  const rowsAfter = await readLedger(propagationJsonl);
  const fingerprintAfter = ledgerFingerprint(rowsAfter);
  if (JSON.stringify(fingerprintBefore) !== JSON.stringify(fingerprintAfter)) {
    throw new Error(
      `relocate-ledger: edge ids/states changed across the move for ${wsRoot} — a relocation must never do this. The move happened; investigate before proceeding.`,
    );
  }

  return {
    applied: true,
    workspace: wsRoot,
    from: { jsonl: sourceJsonl, md: sourceMdExists ? sourceMd : null },
    into: { jsonl: propagationJsonl, md: propagationMd },
    rowCount: rowsAfter.length,
  };
}
