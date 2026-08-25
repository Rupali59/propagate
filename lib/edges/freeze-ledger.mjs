/**
 * freeze-ledger.mjs — make the v1 freeze STRUCTURAL instead of inferred.
 *
 * THE DEFECT THIS EXISTS TO FIX. `status` printed
 * "frozen: N v1 events, all closed — history, not a worklist" on the strength of
 * `rows.filter(r => r.status === "open").length === 0`. It read no version field,
 * because no ledger row had one. So "frozen history" and "nothing happens to be
 * open right now" rendered IDENTICALLY, and appending a single open event turned
 * 1,850 rows of settled history back into a worklist. A freeze inferred from a
 * filter returning empty is not a freeze.
 *
 * WHY RELOCATE RATHER THAN STAMP IN PLACE. Ledger v1 rows carry no discriminator —
 * their four types (`status_change`, `drift`, `code_drift`, `manual`) are the same
 * names v2 uses — so the era cannot be recovered later from shape. The two ways to
 * fix that are stamping every existing row, which REWRITES an append-only store,
 * or moving them somewhere the location itself declares the era. The layout at
 * lib/core/v3-layout.mjs:31 already reserved `archive/  frozen v1 rows` for
 * exactly this, so relocation is the documented intent and it leaves the
 * append-only invariant untouched.
 *
 * WHY THIS IS SAFE, measured rather than assumed. Every `readLedger` call site
 * filters `status === "open"` (cli.mjs:739, 804, 859, 927, 3502, 3689), and
 * `status --all` reported `0 open across 14 ledgers` before this ran. Relocating
 * closed rows changes no open-filter's answer. The guards below refuse the cases
 * where that reasoning would NOT hold, rather than trusting it to stay true.
 *
 * THE `.md` GOES WITH IT — N42, decided 2026-08-25. A frozen ledger's rendered
 * Markdown is a historical artifact by definition. Moving it beside its `.jsonl`
 * preserves the hand-written prose (ManavDaehi's is 50 lines, 39 of them prose)
 * instead of destroying it, and leaves no half-machine/half-hand-written file to
 * rot — the conflation `rule:state-and-decisions` names. `renderMarkdown` is
 * retired in the same change; there is nothing left for it to render.
 *
 * DRY-RUN BY DEFAULT, same posture as `relocateLedger` and `migrate`. Without
 * `apply` nothing is written and the tree is byte-identical afterwards — asserted
 * on the tree, not on this function's return value (rule:safety-flag-needs-a-test).
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { discoverWorkspacesSync, EMPTY_LEDGER_MD } from "../core/discovery.mjs";
import { LEDGER_SCHEMA, ledgerArchiveDir, readLedgerByEra, archivePrefixFor } from "./ledger.mjs";

function gitMv(cwd, from, to) {
  execFileSync("git", ["mv", from, to], { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

/** True when `file` is tracked by the git repo containing it. */
function isTracked(cwd, file) {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", file], {
      cwd,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Freeze a workspace's v1 ledger into `propagation/archive/`.
 *
 * @param {{workspace: string, apply?: boolean, stamp?: string, ledger?: {jsonl: string, md: string}}} opts
 *   `stamp` names the archive files (default `2026-08-24`); injectable so tests
 *   are not time-dependent.
 *
 *   `ledger` targets a ledger discovery does NOT resolve. The hub keeps two in
 *   one directory — `propagation/ledger.jsonl` (its workspace ledger, which
 *   discovery returns) and `propagation/PROPAGATION_CROSS_LEDGER.jsonl` (the
 *   cross-repo one, which it does not). Without this the cross ledger could
 *   never be frozen, and its rows would sit unaccounted forever while every
 *   reader reported green. `workspace` is still required: it is the git repo the
 *   `git mv` runs in, and the refusal guards apply identically.
 * @returns {Promise<object>} same shape dry-run or applied, distinguished by `applied`.
 */
export async function freezeLedgerV1({ workspace, apply = false, stamp = "2026-08-24", ledger = null }) {
  if (!workspace) throw new Error("freeze-ledger: --workspace is required");
  const wsRoot = path.resolve(workspace);
  if (!existsSync(wsRoot)) {
    throw new Error(`freeze-ledger: workspace root does not exist: ${wsRoot}`);
  }

  // Resolve through the same discovery everything else uses. Never reconstruct
  // a ledger path — relocate-ledger.mjs:65-68 records why.
  const { workspaces } = discoverWorkspacesSync([wsRoot], 0);
  const record = workspaces.find((w) => path.resolve(w.root) === wsRoot);
  if (!record) {
    throw new Error(
      `freeze-ledger: ${wsRoot} is not a discoverable workspace (no .propagates.yml with workspace: true at its root)`,
    );
  }

  const sourceJsonl = ledger?.jsonl ?? record.ledgerJsonl;
  const sourceMd = ledger?.md ?? record.ledgerMd;
  const archiveDir = ledgerArchiveDir(sourceJsonl);
  // Same derivation the reader uses, so a ledger's archive is always the one it
  // will later be read back from. Two ledgers share the hub's propagation/ dir.
  const prefix = archivePrefixFor(sourceJsonl);
  const archiveJsonl = path.join(archiveDir, `${prefix}${stamp}.jsonl`);
  const archiveMd = path.join(archiveDir, `${prefix}${stamp}.md`);

  const era = await readLedgerByEra(sourceJsonl);

  const plan = {
    applied: false,
    workspace: wsRoot,
    from: { jsonl: sourceJsonl, md: existsSync(sourceMd) ? sourceMd : null },
    into: { jsonl: archiveJsonl, md: archiveMd },
    lines: era.total - era.v1.length, // physical lines in the LIVE ledger only
    alreadyFrozen: era.v1.length,
  };

  // ── Nothing to do is a NAMED outcome, not an error and not a silent pass ──
  // Eight of the fourteen ledgers have zero rows. They must not grow an
  // `archive/`; V3_REQUIRED deliberately omits it for exactly this reason.
  if (!existsSync(sourceJsonl) || plan.lines === 0) {
    return { ...plan, skipped: "nothing to freeze — the live ledger has no rows" };
  }

  // ── Refuse loudly, BEFORE writing anything ───────────────────────────────

  // (1) Mixed era. Relocating a schema-2 row into `ledger-v1-*.jsonl` would
  //     relabel current work as history — the one outcome worse than not
  //     freezing at all.
  if (era.current.length > 0) {
    throw new Error(
      `freeze-ledger: ${sourceJsonl} already holds ${era.current.length} schema-${LEDGER_SCHEMA} row(s). ` +
        `Freezing would relabel live v2 events as v1 history. Drain or split them first.`,
    );
  }

  // (2) Open work. `status`'s open-filters are why relocation is safe; an open
  //     row is precisely the case where that stops being true, and freezing it
  //     would hide a worklist rather than archive a history.
  const { readLedger } = await import("./ledger.mjs");
  const open = (await readLedger(sourceJsonl)).filter((r) => r.status === "open");
  if (open.length > 0) {
    throw new Error(
      `freeze-ledger: ${wsRoot} has ${open.length} OPEN row(s) (${open
        .slice(0, 3)
        .map((r) => r.id)
        .join(", ")}). Freezing open work hides a worklist. Drain them first.`,
    );
  }

  // (3) Never clobber an existing archive.
  for (const target of [archiveJsonl, archiveMd]) {
    if (existsSync(target)) {
      throw new Error(`freeze-ledger: ${target} already exists — refusing to overwrite frozen history`);
    }
  }

  if (!apply) return plan;

  // ── Apply ────────────────────────────────────────────────────────────────
  await mkdir(archiveDir, { recursive: true });

  const bytesBefore = await readFile(sourceJsonl, "utf8");

  // `git mv` where the file is tracked, so `git log --follow` reaches the
  // pre-freeze commits; a plain rename would lose that and not stage anything.
  if (isTracked(wsRoot, sourceJsonl)) {
    gitMv(wsRoot, sourceJsonl, archiveJsonl);
  } else {
    await writeFile(archiveJsonl, bytesBefore);
  }

  // The live ledger must continue to EXIST at its canonical path — discovery
  // and every reader resolve it there. Empty, ready for schema-2 events.
  await writeFile(sourceJsonl, "");

  if (plan.from.md) {
    if (isTracked(wsRoot, sourceMd)) gitMv(wsRoot, sourceMd, archiveMd);
    else await writeFile(archiveMd, await readFile(sourceMd, "utf8"));
    plan.into.mdWritten = true;
  } else {
    plan.into.md = null;
  }

  // THE PAIR MUST SURVIVE THE FREEZE. `init` asserts a workspace has BOTH a
  // ledger .jsonl and a .md (N24), and doctor checks it per workspace — moving
  // the .md away without replacement turned Keerti red the moment this first
  // ran. Caught because that check is real; it fired within seconds.
  //
  // The placeholder is the SAME body `init` scaffolds, imported rather than
  // re-typed, so there is one definition of what an empty ledger.md says. Since
  // Phase D removed `renderMarkdown`, that body now states plainly that nothing
  // regenerates it and points at `status`/`graph`.
  await writeFile(sourceMd, EMPTY_LEDGER_MD);

  // Track both new files. `git mv` staged the moves; these two are new paths and
  // would otherwise sit untracked — a workspace whose ledger is invisible to git
  // is exactly the "phantom ledger" state relocate-ledger refuses to create.
  for (const f of [sourceJsonl, sourceMd]) {
    try {
      execFileSync("git", ["add", f], { cwd: wsRoot, stdio: ["ignore", "ignore", "pipe"] });
    } catch {
      // Not a git repo, or the path is ignored. Not fatal — the files exist,
      // which is what every reader needs; say nothing rather than fail the freeze.
    }
  }

  // ── Assert the move, do not assume it ────────────────────────────────────
  const bytesAfter = await readFile(archiveJsonl, "utf8");
  if (bytesAfter !== bytesBefore) {
    throw new Error(
      `freeze-ledger: archived bytes differ from the source (${bytesBefore.length} -> ${bytesAfter.length}). ` +
        `The move did not preserve content.`,
    );
  }

  const eraAfter = await readLedgerByEra(sourceJsonl);
  if (eraAfter.v1.length !== plan.lines || eraAfter.current.length !== 0 || eraAfter.refused.length !== 0) {
    throw new Error(
      `freeze-ledger: post-freeze census disagrees — expected ${plan.lines} v1 / 0 current / 0 refused, ` +
        `got ${eraAfter.v1.length} / ${eraAfter.current.length} / ${eraAfter.refused.length}`,
    );
  }

  return { ...plan, applied: true };
}
