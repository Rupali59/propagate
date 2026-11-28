/**
 * ledger.mjs: the ledger and migration commands (migrate-ledger, migrate-refs, migrate, relocate-ledger, freeze-ledger, init, reload), moved out of cli.mjs (#163, epic #143).
 */
import { existsSync } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { homedir as _homedir } from "node:os";
const HOME_DIR = _homedir();
import { WORKSPACES, SEARCH_ROOTS, SKILL_DIR } from "../lib/core/config.mjs";
import { reconcile } from "../lib/edges/reconcile.mjs";
import { discoverWorkspacesSync } from "../lib/core/discovery.mjs";
import { regeneratePlist, reloadLaunchd, PLIST_PATH } from "../lib/core/plist.mjs";
import { migrateLedger } from "../lib/edges/migrate-ledger.mjs";
import { relocateLedger } from "../lib/edges/relocate-ledger.mjs";
import { freezeLedgerV1 } from "../lib/edges/freeze-ledger.mjs";
import { RESET, DIM, RED, GREEN, YELLOW, BOLD } from "./ansi.mjs";

/**
 * `migrate-ledger` — thin dispatch arm (D7): argv parsing and printing only.
 * All logic lives in lib/edges/migrate-ledger.mjs. Built per
 * docs/DECISIONS.md (2026-08-10, "the 69 misfiled hub rows are deferred") —
 * append-only close-and-re-emit with a manifest, never an in-place rewrite.
 *
 * Dry-run by default; `--apply` writes. The source ledger is NEVER written.
 *
 * `--all-refs` / `--from-ref <ref>` (docs/ISSUES.md N25): sweep the source
 * repo's branches via `git show`, never `git checkout`. Mutually exclusive
 * with each other. In this mode `--from` names the CONCEPTUAL ledger path
 * (workspace-root/docsdir/PROPAGATION_LEDGER.jsonl) — it need not exist on
 * whatever branch happens to be checked out, so the working-tree existence
 * check below is skipped; the repo itself must still exist and be a git repo.
 */
export async function migrateLedgerCmd(argv = []) {
  const asJson = argv.includes("--json");
  const apply = argv.includes("--apply");
  const allRefs = argv.includes("--all-refs");
  const fromIdx = argv.indexOf("--from");
  const intoIdx = argv.indexOf("--into");
  const fromRefIdx = argv.indexOf("--from-ref");
  const fromPath = fromIdx >= 0 ? argv[fromIdx + 1] : undefined;
  const intoPath = intoIdx >= 0 ? argv[intoIdx + 1] : undefined;
  const fromRef = fromRefIdx >= 0 ? argv[fromRefIdx + 1] : undefined;

  if (!fromPath || !intoPath) {
    console.error(`${RED}error:${RESET} usage: node cli.mjs migrate-ledger --from <ledger.jsonl> --into <ledger.jsonl> [--apply] [--all-refs | --from-ref <ref>] [--json]`);
    console.error(`${DIM}Dry-run by default. --apply writes. The --from ledger is never written.${RESET}`);
    process.exit(2);
  }
  if (allRefs && fromRef) {
    console.error(`${RED}error:${RESET} --all-refs and --from-ref are mutually exclusive`);
    process.exit(2);
  }
  if (!allRefs && !fromRef && !existsSync(fromPath)) {
    console.error(`${RED}error:${RESET} --from ledger does not exist: ${fromPath}`);
    process.exit(2);
  }

  let result;
  try {
    result = await migrateLedger({ fromPath, intoPath, apply, allRefs, fromRef });
  } catch (err) {
    console.error(`${RED}error:${RESET} ${err.message}`);
    process.exit(2);
  }

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  }

  const verb = apply ? "migrated" : "would migrate";
  console.log(`${BOLD}# migrate-ledger${RESET}  ${DIM}(${apply ? "APPLY" : "dry-run — nothing written"})${RESET}\n`);
  console.log(`  from:   ${result.from}`);
  console.log(`  into:   ${result.into}`);
  console.log(`  prefix: ${result.prefix || DIM + "(none)" + RESET}\n`);
  if (result.refMode) {
    console.log(`  refs swept: ${result.refsSwept.map((r) => r.ref).join(", ") || DIM + "(none)" + RESET}`);
    if (result.skippedRefs.length > 0) {
      console.log(`  ${YELLOW}refs skipped:${RESET}`);
      for (const s of result.skippedRefs) {
        console.log(`    ${DIM}-${RESET} ${s.ref}: ${s.reason}`);
      }
    }
    if (result.duplicateEventsCollapsed > 0) {
      console.log(`  ${result.duplicateEventsCollapsed} duplicate sighting(s) on other refs collapsed into their canonical row`);
    }
    // N41 — CONTESTED rows, printed loudly and never folded into the collapse
    // count above. A collapse is bookkeeping; this is two humans disagreeing
    // about one edge, and the old behaviour resolved it by sort order and said
    // nothing. It is a flag on the row, not a rejection: the row migrated, and
    // what needs a person is the disagreement.
    if (result.contested?.length) {
      console.log(
        `\n  ${YELLOW}${result.contested.length} CONTESTED row(s)${RESET} — the same logical row carries ` +
          `different final statuses on different branches:`,
      );
      for (const c of result.contested) {
        // dedupeKey is `type|source|timestamp` — see lib/edges/migrate-ledger.mjs.
        const [, source, ts] = c.key.split("|");
        console.log(`    ${source ?? c.key} ${DIM}${ts ?? ""}${RESET}`);
        for (const d of c.dispositions) console.log(`      ${d.ref.padEnd(34)} ${d.status}`);
      }
      console.log(
        `  ${DIM}The row migrated and carries a \`contested\` flag. Reconcile deliberately — ` +
          `sort order is not a decision.${RESET}`,
      );
    }
    const multiRef = result.idMap.filter((r) => r.appearedOnRefs && r.appearedOnRefs.length > 1);
    if (multiRef.length > 0) {
      console.log(`  ${DIM}rows seen on more than one ref:${RESET}`);
      for (const r of multiRef) {
        console.log(`    ${DIM}-${RESET} ${r.newId} (source id ${r.oldId} on ${r.ref}) also on: ${r.appearedOnRefs.filter((x) => x !== r.ref).join(", ")}`);
      }
    }
    console.log("");
  }
  console.log(`  ${verb} ${result.migrated} row(s), skipped ${result.skipped} already-migrated row(s)`);
  console.log(`  transitions: ${result.transitionsMigrated} migrated, ${result.transitionsSkipped} skipped, ${result.orphanTransitions} orphaned`);
  if (result.manifestPath) {
    console.log(`\n  manifest: ${result.manifestPath}`);
  } else if (apply) {
    console.log(`\n  ${DIM}no manifest written — nothing new was migrated${RESET}`);
  }
  if (!apply) {
    console.log(`\n${DIM}Re-run with --apply to write.${RESET}`);
  }
}

/**
 * `relocate-ledger` — thin dispatch arm (D7): argv parsing and printing only.
 * All logic lives in lib/edges/relocate-ledger.mjs. Moves ONE workspace's
 * ledger pair onto the `propagation/` layout via `git mv`, so history
 * follows. This is a relocation, never a row migration — see that module's
 * header and docs/DECISIONS.md "a propagation/ folder in every workspace".
 *
 * Dry-run by default; `--apply` writes.
 */
/**
 * `migrate` — bring a workspace to the v3 propagation layout.
 *
 * Dry-run by default, mirroring `relocate-ledger`. The preview and the write
 * come from the SAME plan object, so what it shows is what it would do.
 *
 * It prints four categories rather than one list, because collapsing them is
 * how this command would destroy state: a pointer stub migrated over the real
 * file it points at, or two genuine files silently reconciled by whichever was
 * written last.
 */
/**
 * `migrate-refs <workspace> [--apply]` — adopt a v1 branch registry.
 *
 * WIRED BECAUSE IT WAS NOT. `lib/refs/migrate-refs.mjs` shipped correct, tested
 * across six behaviours, and reachable from NOTHING outside its own test file —
 * the first live conversion was performed by an ad-hoc script. That is
 * `rule:enforcement-watches-itself` instance 6 word for word: "correct, tested,
 * unreachable". A capability nobody can invoke is indistinguishable from one
 * that was never built, and its tests pass either way.
 *
 * Dry-run by default, matching `migrate` and `relocate-ledger` rather than
 * inventing a third preview posture (`rule:safety-flag-needs-a-test`: the two
 * neighbours whose posture you reason by analogy from are exactly what produced
 * three instances of an armed --dry-run in this tree).
 */
export async function migrateRefsCmd(argv = []) {
  const asJson = argv.includes("--json");
  const apply = argv.includes("--apply");
  const wsIdx = argv.indexOf("--workspace");
  const workspace = wsIdx >= 0 ? argv[wsIdx + 1] : argv.find((a) => !a.startsWith("--"));

  if (!workspace) {
    console.error(`${RED}error:${RESET} usage: node cli.mjs migrate-refs <workspace> [--apply] [--json]`);
    console.error(`${DIM}Dry-run by default. --apply writes the snapshot and appends lifecycle events.${RESET}`);
    process.exit(2);
  }

  // ISSUES N55's blocking defect. This used to hand `workspace` straight to
  // `migrateRefs`, which joins `propagation/refs` onto it -- so a bare NAME,
  // the form the usage line above documents and the form `doctor` told people
  // to type, resolved against the CWD, found nothing, and exited 0 reporting
  // `0 projects`. Under `--apply` it would have created a stray
  // `./<name>/propagation/refs/` tree and left the real registry untouched.
  const { WORKSPACES } = await import("../lib/core/config.mjs");
  const { resolveWorkspace } = await import("../lib/core/discovery.mjs");
  const resolved = resolveWorkspace(workspace, WORKSPACES);
  if (!resolved.ok) {
    console.error(`${RED}error:${RESET} ${resolved.reason}`);
    process.exit(2);
  }

  const { migrateRefs } = await import("../lib/refs/migrate-refs.mjs");
  let plan;
  try {
    plan = await migrateRefs({ workspace: resolved.workspace.root, apply });
  } catch (err) {
    // Includes the concurrent-writer abort and the unparseable-snapshot refusal.
    // Both are refusals to proceed, not crashes, and both must reach the operator
    // with their reason intact rather than as a stack trace.
    console.error(`${RED}error:${RESET} ${err?.message ?? err}`);
    process.exit(1);
  }

  if (asJson) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  const verb = apply ? (plan.unchanged ? "unchanged" : "applied") : "would apply";
  console.log(`${verb}: ${plan.projects} projects · ${plan.refs} refs · previous snapshot ${plan.previous}`);
  // Distinguish "no transitions" from "did not look" — the events array being
  // empty after a real diff is a finding (agreement), not silence.
  if (!plan.events.length) {
    console.log(`${DIM}no ref transitions since the previous capture${RESET}`);
  } else {
    const byKind = {};
    for (const e of plan.events) byKind[e.type ?? e.event] = (byKind[e.type ?? e.event] ?? 0) + 1;
    console.log(
      Object.entries(byKind)
        .map(([k, n]) => `${k} ${n}`)
        .join(" · "),
    );
    for (const e of plan.events.slice(0, 20)) {
      console.log(`  ${e.type ?? e.event} ${e.project}/${e.ref ?? e.path}${e.classification ? ` (${e.classification})` : ""}`);
    }
    if (plan.events.length > 20) console.log(`  ${DIM}… ${plan.events.length - 20} more${RESET}`);
  }
  if (!apply) console.log(`${DIM}nothing written — re-run with --apply${RESET}`);
}

export async function migrateCmd(argv = []) {
  const asJson = argv.includes("--json");
  const apply = argv.includes("--apply");
  // Deliberately hoist a directory that looks like an undeclared workspace.
  // Gated because the alternative — inferring it — is how a workspace's state
  // gets pulled into its parent cross-repo, with its history left behind.
  const force = argv.includes("--force");
  // SEPARATE from --force on purpose: see migrateWorkspace's pre-flight. `git mv`
  // stages, so a dirty target tree means the next commit by whoever else is
  // working there adopts this migration. Measured 2026-09-28 — it did.
  const allowDirty = argv.includes("--allow-dirty");
  const wsIdx = argv.indexOf("--workspace");
  const workspace = wsIdx >= 0 ? argv[wsIdx + 1] : argv.find((a) => !a.startsWith("--"));

  if (!workspace) {
    console.error(`${RED}error:${RESET} usage: node cli.mjs migrate <workspace> [--apply] [--force] [--allow-dirty] [--json]`);
    console.error(`${DIM}Dry-run by default. --apply performs the moves.${RESET}`);
    process.exit(2);
  }

  // THE SAME DEFECT `migrate-refs` HAD (N55), found 2026-09-27 while trying to
  // finish a half-migrated workspace with it. `planMigration` joins
  // `propagation` onto whatever it is given, so a bare NAME resolved against the
  // CWD. Measured from the propagate repo:
  //
  //   migrate obsidian-vk-publish   -> propagate/obsidian-vk-publish/propagation, 0 moves
  //   migrate /Users/…/obsidian-vk-publish -> the workspace's own, 1 move
  //
  // Under `--apply` the first form would have created a stray propagation tree
  // INSIDE the propagate repo and reported 0 moves, while the real workspace
  // stayed half-migrated -- which is exactly why it still was.
  const { WORKSPACES } = await import("../lib/core/config.mjs");
  const { resolveWorkspace } = await import("../lib/core/discovery.mjs");
  const resolvedWs = resolveWorkspace(workspace, WORKSPACES);
  if (!resolvedWs.ok) {
    console.error(`${RED}error:${RESET} ${resolvedWs.reason}`);
    process.exit(2);
  }

  const { migrateWorkspace, planMigration, orphanedByMigration, sidecarsNamingMoves } = await import("../lib/migrate/workspace.mjs");

  let plan;
  try {
    plan = planMigration(resolvedWs.workspace.root, { includeUndeclared: force });
  } catch (err) {
    console.error(`${RED}error:${RESET} ${err?.message ?? err}`);
    process.exit(1);
  }

  // The accepted loss, enumerated BEFORE anything moves. Edge identity embeds
  // the path (lib/edges/reconcile.mjs:99), so a moved file's verification
  // becomes unreachable. Naming it is what separates an accepted trade from a
  // silent one.
  // ATTRIBUTABLE, never silently empty. The first version of this called a
  // function that does not exist and swallowed the ReferenceError, so the
  // guardrail reported "no verifications at risk" for every workspace — the
  // exact silent-zero this command exists to prevent, written into the command
  // itself. If the enumeration cannot run, it says so and the operator decides.
  let orphans = [];
  let orphanError = null;
  try {
    const { rows } = await reconcile(WORKSPACES);
    orphans = orphanedByMigration(rows, plan);
  } catch (err) {
    orphanError = err?.message ?? String(err);
  }
  const losing = orphans.filter((o) => o.losesVerification);

  if (asJson) {
    const result = apply ? await migrateWorkspace({ workspace: resolvedWs.workspace.root, apply: true, force, allowDirty }) : { ...plan, applied: false };
    console.log(JSON.stringify({ ...result, orphans }, null, 2));
    return;
  }

  const short = (p) => String(p).replace(`${HOME_DIR}/Documents/GitHub/`, "");
  console.log(`${BOLD}migrate${RESET} ${short(plan.workspace)}${apply ? "" : `  ${DIM}(dry run)${RESET}`}`);
  // BOTH WORDS, not just `missing`. `conformance()` returns `missing` AND `empty`
  // (N82's vocabulary: absent, present-but-empty, hollow, never-started are four
  // different facts). This line printed only `missing`, so a workspace failing for
  // an EMPTY directory rendered as `no — missing ` with nothing after it — the
  // exact unattributable output N82 was filed to remove, surviving in a renderer
  // the fix did not reach. Found 2026-09-28 on Motion-Graphics, whose only defect
  // is an empty `state/`.
  const cb = plan.conformanceBefore;
  const why = [
    cb.missing?.length ? `missing ${cb.missing.join(", ")}` : null,
    cb.empty?.length ? `present but EMPTY: ${cb.empty.join(", ")}` : null,
  ].filter(Boolean).join("; ");
  console.log(`  ${DIM}conforms before:${RESET} ${cb.conforms ? "yes" : `no — ${why || "reason not reported — the conformance check returned neither missing nor empty, which is a gap in this renderer"}`}`);

  for (const c of plan.creates) console.log(`  ${GREEN}create${RESET}  ${short(c)}`);
  for (const m of plan.moves) {
    console.log(`  ${GREEN}move${RESET}    ${short(m.from)}`);
    console.log(`          ${DIM}-> ${short(m.to)}${m.crossRepo ? "  (cross-repo: history stays behind)" : ""}${RESET}`);
  }
  for (const a of plan.alreadyMigrated) console.log(`  ${DIM}skip    ${short(a.from)} — ${a.reason}${RESET}`);
  for (const n of plan.notes ?? []) console.log(`  ${YELLOW}note${RESET}    ${short(n.from)} — ${n.reason}`);
  for (const c of plan.conflicts) console.log(`  ${RED}conflict${RESET} ${short(c.from)} — ${c.reason}`);
  // Rendered in the DRY RUN, so the operator sees this before choosing, rather
  // than discovering it as a refusal after typing --apply.
  for (const u of plan.undeclaredWorkspaces ?? []) {
    console.log(`  ${YELLOW}undeclared workspace${RESET} ${short(u.from)}`);
    console.log(`          ${DIM}${u.reason}${RESET}`);
  }
  if ((plan.undeclaredWorkspaces ?? []).length) {
    const names = [...new Set(plan.undeclaredWorkspaces.map((u) => u.project))];
    console.log(
      `  ${DIM}--apply will REFUSE while these are undeclared. Add \`workspace: true\` to ` +
        `${names.map((n) => `${n}/.propagates.yml`).join(", ")}, or pass --force to hoist them.${RESET}`,
    );
  }

  if (orphanError) {
    console.log(
      `\n  ${RED}could not enumerate at-risk verifications${RESET} ${DIM}(${orphanError})${RESET}\n` +
        `  ${DIM}This is UNKNOWN, not zero. Moving files changes edge identity; do not --apply until this resolves.${RESET}`,
    );
  } else if (losing.length) {
    console.log(`\n  ${YELLOW}${losing.length} verified edge(s) will lose their baseline${RESET} ${DIM}— edge identity embeds the path${RESET}`);
    for (const o of losing.slice(0, 8)) console.log(`    ${DIM}${o.edge_id}  ${short(o.source)}${RESET}`);
    console.log(`  ${DIM}Their events remain in the append-only store; nothing resolves them again.${RESET}`);
    console.log(`  ${DIM}Re-baseline afterwards, recorded AS a re-baseline naming this migration.${RESET}`);
  }

  // Declared edges that name a path this migration moves. REPORTS, never
  // rewrites — a sidecar key is relative to its own directory and the same
  // basename recurs across ~29 files, so blind substitution is how a working
  // declaration becomes a wrong one silently.
  //
  // Rendered BEFORE the dry-run return, deliberately: this is the list you act
  // on when deciding whether to --apply, so printing it only after the move had
  // already happened would be the wrong half of the workflow.
  //
  // Wired 2026-08-24. sidecarsNamingMoves had ZERO callers since it was written
  // — correct, tested by nothing, unreachable, so the capability the plan's M2
  // step 4 requires was indistinguishable from one never built
  // (rule:enforcement-watches-itself §2).
  try {
    const naming = sidecarsNamingMoves(plan, SEARCH_ROOTS.length ? SEARCH_ROOTS : [plan.workspace]);
    for (const h of naming) {
      console.log(`  ${YELLOW}sidecar${RESET}  ${short(h.sidecar)} names ${short(h.names)}`);
      console.log(`          ${DIM}-> update that entry to ${h.suggested}${RESET}`);
    }
    if (!naming.length && plan.moves.length) {
      console.log(`  ${DIM}sidecar  no declared edge names a moved path${RESET}`);
    }
  } catch (err) {
    // A failed scan must never read as "nothing to update".
    console.log(`  ${YELLOW}sidecar${RESET}  scan failed — ${err.message} ${DIM}(UNKNOWN, not zero)${RESET}`);
  }

  if (!apply) {
    console.log(`\n  ${DIM}nothing written. re-run with --apply${RESET}`);
    return;
  }

  let result;
  try {
    result = await migrateWorkspace({ workspace: resolvedWs.workspace.root, apply: true, force, now: new Date().toISOString() });
  } catch (err) {
    console.error(`\n${RED}refused:${RESET} ${err?.message ?? err}`);
    process.exit(1);
  }
  for (const s of result.sidecars ?? []) {
    console.log(`  ${s.written ? GREEN + "sidecar" + RESET : DIM + "sidecar" + RESET}  ${short(s.path)}${s.written ? "" : ` ${DIM}(${s.reason})${RESET}`}`);
  }
  for (const cr of result.created ?? []) {
    console.log(
      `  ${cr.written ? GREEN + "created" + RESET : DIM + "created" + RESET}  ${short(cr.path)}` +
        `${cr.written ? "" : ` ${DIM}(${cr.reason})${RESET}`}`,
    );
  }
  // A refs pair that could not be built is a REASON, not a silent gap. Without
  // this line the run reported "still missing refs/snapshot.json" and left the
  // reader to guess whether the workspace is not a repo, or the build failed.
  if (result.registry?.error) {
    console.log(`  ${YELLOW}refs${RESET}  not written — ${result.registry.error}`);
  }
  const c = result.conformanceAfter;
  console.log(`\n  ${c.conforms ? GREEN + "✓" + RESET : RED + "✗" + RESET} conforms after: ${c.conforms ? "yes" : `no — still missing ${c.missing.join(", ")}`}`);
}

export async function relocateLedgerCmd(argv = []) {
  const asJson = argv.includes("--json");
  const apply = argv.includes("--apply");
  const wsIdx = argv.indexOf("--workspace");
  const workspace = wsIdx >= 0 ? argv[wsIdx + 1] : undefined;

  if (!workspace) {
    console.error(`${RED}error:${RESET} usage: node cli.mjs relocate-ledger --workspace <root> [--apply] [--json]`);
    console.error(`${DIM}Dry-run by default. --apply performs the git mv.${RESET}`);
    process.exit(2);
  }

  let result;
  try {
    result = await relocateLedger({ workspace, apply });
  } catch (err) {
    if (asJson) {
      console.log(JSON.stringify({ error: err.message }, null, 2));
    } else {
      console.error(`${RED}error:${RESET} ${err.message}`);
    }
    process.exit(2);
  }

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const verb = apply ? "relocated" : "would relocate";
  console.log(`${BOLD}# relocate-ledger${RESET}  ${DIM}(${apply ? "APPLY" : "dry-run — nothing written"})${RESET}\n`);
  console.log(`  workspace: ${result.workspace}`);
  console.log(`  ${verb}:`);
  console.log(`    ${result.from.jsonl} -> ${result.into.jsonl}`);
  if (result.from.md) console.log(`    ${result.from.md} -> ${result.into.md}`);
  console.log(`  rows: ${result.rowCount}`);
  if (!apply) {
    console.log(`\n${DIM}Re-run with --apply to write.${RESET}`);
  }
}

/**
 * `freeze-ledger` — thin dispatch arm: argv parsing and printing only. All
 * logic and every refusal live in lib/edges/freeze-ledger.mjs.
 *
 * Dry-run by default, matching `relocate-ledger` and `migrate`. The preview and
 * the write take the SAME path through freezeLedgerV1, so a dry run cannot
 * promise something apply would not do.
 */
export async function freezeLedgerCmd(argv = []) {
  const asJson = argv.includes("--json");
  const apply = argv.includes("--apply");
  const wsIdx = argv.indexOf("--workspace");
  const workspace = wsIdx >= 0 ? argv[wsIdx + 1] : undefined;
  const stampIdx = argv.indexOf("--stamp");
  const stamp = stampIdx >= 0 ? argv[stampIdx + 1] : undefined;
  const cross = argv.includes("--cross");

  if (!workspace) {
    console.error(`${RED}error:${RESET} usage: node cli.mjs freeze-ledger --workspace <root> [--cross] [--apply] [--stamp <date>] [--json]`);
    console.error(`${DIM}Dry-run by default. --apply moves the v1 rows and the .md into propagation/archive/.${RESET}`);
    process.exit(2);
  }

  let result;
  try {
    let ledgerOverride = null;
    if (cross) {
      // Discovery resolves a workspace's OWN ledger; the cross-repo one shares
      // the hub's propagation/ dir and is invisible to it.
      const { CROSS_LEDGER_JSONL, CROSS_LEDGER_MD } = await import("../lib/core/config.mjs");
      ledgerOverride = { jsonl: CROSS_LEDGER_JSONL, md: CROSS_LEDGER_MD };
    }
    result = await freezeLedgerV1({
      workspace,
      apply,
      ...(stamp ? { stamp } : {}),
      ...(ledgerOverride ? { ledger: ledgerOverride } : {}),
    });
  } catch (err) {
    if (asJson) console.log(JSON.stringify({ error: err.message }, null, 2));
    else console.error(`${RED}error:${RESET} ${err.message}`);
    process.exit(2);
  }

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`${BOLD}# freeze-ledger${RESET}  ${DIM}(${apply ? "APPLY" : "dry-run — nothing written"})${RESET}\n`);
  console.log(`  workspace: ${result.workspace}`);
  if (result.skipped) {
    // A named skip, never silence: eight of fourteen ledgers are legitimately empty.
    console.log(`  ${DIM}${result.skipped}${RESET}`);
    return;
  }
  console.log(`  ${apply ? "froze" : "would freeze"}:`);
  console.log(`    ${result.from.jsonl} -> ${result.into.jsonl}`);
  if (result.from.md) console.log(`    ${result.from.md} -> ${result.into.md}`);
  console.log(`  lines: ${result.lines}`);
  if (!apply) console.log(`\n${DIM}Re-run with --apply to write.${RESET}`);
}

/**
 * Scaffold a `.propagates.yml` marker. Two legitimate marker kinds (A3,
 * docs/ISSUES.md N15): a ledger-owning `--workspace` root (default — that is
 * what someone running `init` almost always means) or an edge-only
 * `--edges-only` sidecar with no `workspace: true`.
 *
 * Does NOT touch the plist or launchd (N14, docs/ISSUES.md — that used to be
 * a silent side effect of `init`, and a scoped/test run of `init` could
 * disarm the real watcher). Run `node cli.mjs reload` afterward.
 *
 * When `--workspace` is used, verifies the new directory is actually visible
 * to discovery afterward and exits non-zero if not (N15) — an init that
 * cannot produce a discoverable workspace must not report success.
 */
export async function init(targetDir, flags = []) {
  if (!targetDir) {
    console.error(`${RED}error:${RESET} usage: node cli.mjs init <dir> [--workspace|--edges-only]`);
    console.error(
      `${DIM}init scaffolds a .propagates.yml in ONE directory. To configure this${RESET}\n` +
        `${DIM}machine's install (search roots, scheduler), run: node cli.mjs setup${RESET}`,
    );
    process.exit(2);
  }
  if (flags.includes("--workspace") && flags.includes("--edges-only")) {
    console.error(`${RED}error:${RESET} --workspace and --edges-only are mutually exclusive`);
    process.exit(2);
  }
  const asWorkspace = !flags.includes("--edges-only"); // default: --workspace
  const abs = path.resolve(targetDir);
  if (!existsSync(abs)) {
    console.error(`${RED}error:${RESET} ${abs} does not exist`);
    process.exit(2);
  }
  const stats = await stat(abs);
  if (!stats.isDirectory()) {
    console.error(`${RED}error:${RESET} ${abs} is not a directory`);
    process.exit(2);
  }

  // Verify target is under one of SEARCH_ROOTS (otherwise discovery won't find it).
  const underSearchRoot = SEARCH_ROOTS.some((r) => abs.startsWith(r + path.sep) || abs === r);
  if (!underSearchRoot) {
    console.log(
      `${YELLOW}warning:${RESET} ${abs} is not under any SEARCH_ROOTS (${SEARCH_ROOTS.join(", ")}).`,
    );
    console.log(`${DIM}discovery walks SEARCH_ROOTS only; add the parent to lib/config.mjs SEARCH_ROOTS if needed.${RESET}`);
  }

  const markerPath = path.join(abs, ".propagates.yml");
  if (existsSync(markerPath)) {
    console.log(`${YELLOW}already initialized:${RESET} ${markerPath} exists`);
  } else {
    const workspaceLine = asWorkspace ? "workspace: true\n\n" : "";
    const template = `# Propagation sidecar for ${path.basename(abs)} — auto-generated by \`/propagate init\`
# on ${new Date().toISOString().slice(0, 10)}.
#
# Declare source-of-truth files and their downstreams. Drift is derived on
# demand — run \`node ${SKILL_DIR}/cli.mjs reconcile\` to check
# whether a declared source has moved out of sync with its downstream(s).
# Walk through open v1 rows via \`node ${SKILL_DIR}/cli.mjs status\`.
#
# Example:
#   sources:
#     CLAUDE.md:
#       propagates_to:
#         - path: server/auth/telegram.js
#           why: "Auth posture documented in CLAUDE.md must match HMAC impl"
#           kind: code

${workspaceLine}sources: {}
`;
    await writeFile(markerPath, template, "utf8");
    console.log(`${GREEN}✓${RESET} created ${markerPath} ${DIM}(${asWorkspace ? "workspace: true — ledger-owning root" : "edges-only sidecar"})${RESET}`);
  }

  // Re-discover workspaces (now includes the new one if under SEARCH_ROOTS and asWorkspace)
  const { workspaces } = discoverWorkspacesSync(SEARCH_ROOTS);
  console.log(`${DIM}discovered ${workspaces.length} workspace${workspaces.length === 1 ? "" : "s"}:${RESET}`);
  for (const ws of workspaces) {
    const isNew = ws.root === abs;
    console.log(`  ${isNew ? GREEN + "+" : DIM + " "}${RESET} ${ws.name}  ${DIM}${ws.root}${RESET}`);
  }

  if (asWorkspace) {
    const found = workspaces.some((ws) => ws.root === abs);
    if (!found) {
      console.error(
        `\n${RED}✗ init failed:${RESET} ${abs} does not appear in discovery after being marked ` +
          `--workspace. It printed "created" but is not discoverable — that is not success.`,
      );
      console.error(
        `${DIM}check: is it under SEARCH_ROOTS? does the marker parse (run \`node cli.mjs doctor\`)? ` +
          `is \`workspace: true\` present and a strict boolean?${RESET}`,
      );
      process.exit(1);
    }
    console.log(`${GREEN}✓${RESET} verified: discoverable as a workspace`);

    // ── assert the ledger pair, do not assume it (docs/ISSUES.md N24) ──────
    //
    // `init` is one of LEDGER_SCAFFOLDING_VERBS, so the discovery call above
    // reached `ensureLedgerPair` and SHOULD have created the pair. "Should"
    // is the problem: `ensureLedgerPair` is deliberately best-effort and
    // swallows its errors, so a read-only directory or a permission fault
    // leaves no pair and says nothing — and `init complete.` printed anyway.
    //
    // N24 was filed twice on exactly this (Obsidian and Motherboard, both
    // 2026-08-14, both doctor 1 -> 3, both fixed by hand) and
    // .templates/NEW-PROJECT-CHECKLIST.md documents the workaround rather
    // than the fix. A success banner that outranks a check that just failed
    // is the inverse of the silent no-op this register exists to catch.
    //
    // Paths come from the workspace record discovery already built — no
    // second resolution, and no restating the layout, which is canonical in
    // docs/REFERENCE.md §"Ledger layout".
    const created = workspaces.find((ws) => ws.root === abs);
    const missing = [created.ledgerJsonl, created.ledgerMd].filter((p) => !existsSync(p));
    if (missing.length > 0) {
      console.error(
        `\n${RED}✗ init incomplete:${RESET} the ledger pair was not created:`,
      );
      for (const m of missing) console.error(`    ${m}`);
      console.error(
        // Deliberately does NOT contain the success banner's own wording.
        // The first draft explained itself as "`init complete.` is NOT being
        // claimed" — which made the string appear in stderr and broke the
        // test asserting the banner is absent. An error message that quotes
        // the phrase it denies is indistinguishable from the success it is
        // denying, to any check that greps for it.
        `${DIM}the marker is written and the workspace IS discoverable, so this is not a ` +
          `rollback — but success is NOT being claimed, because \`doctor\` will fail its ` +
          `"ledger JSONL/MD exists" checks until these exist. Check directory permissions, ` +
          `then re-run.${RESET}`,
      );
      process.exit(1);
    }
    console.log(
      `${GREEN}✓${RESET} ledger pair created ${DIM}${path.dirname(created.ledgerJsonl)}${RESET}`,
    );
  }

  console.log(`\n${GREEN}${BOLD}init complete.${RESET}`);
  console.log(`${DIM}next: edit ${markerPath} to declare source files + downstreams${RESET}`);
  // `reload` (regenerate plist + reload launchd) is obsolete as of 2026-08-14
  // — its only target was the now-retired v1 watcher (docs/DECISIONS.md
  // 2026-08-14; docs/REFERENCE.md's `reload` entry). Point at the live
  // detection path instead of a step that no longer does anything useful.
  console.log(`${DIM}then: run \`node cli.mjs reconcile\` to check the new edges for drift on demand${RESET}`);
}

/**
 * Regenerate the plist from currently-discovered workspaces and reload
 * launchd. Split out of `init` (N14, docs/ISSUES.md) — a setup command that
 * silently re-armed launchd as a side effect was the worst possible shape
 * for the bug where a scoped/test discovery run wrote the real plist with 0
 * WatchPaths. This is that side effect, made explicit and opt-in.
 *
 * OBSOLETE as of 2026-08-14 (docs/DECISIONS.md): the only plist this ever
 * regenerated is the v1 watcher's (`lib/plist.mjs` never touches the digest
 * plist — grep confirms it), and the watcher is retired. Not removed here
 * (no live launchd command was run to enact or verify a removal decision —
 * out of scope for that change) but there is no remaining reason to run it.
 */
export async function reload() {
  console.log(`${BOLD}regenerating plist${RESET} ${DIM}${PLIST_PATH}${RESET}`);
  const result = await regeneratePlist({ workspaces: WORKSPACES });
  if (!result.ok) {
    console.error(`${RED}refused:${RESET} ${result.error}`);
    process.exit(1);
  }
  console.log(`${GREEN}✓${RESET} plist written with ${result.watchedRoots.length} workspace root${result.watchedRoots.length === 1 ? "" : "s"}`);

  console.log(`\n${BOLD}reloading launchd${RESET}`);
  try {
    const out = reloadLaunchd();
    console.log(out.split("\n").map((l) => `  ${DIM}${l}${RESET}`).join("\n"));
    console.log(`${GREEN}✓${RESET} launchd reloaded`);
  } catch (err) {
    console.error(`${RED}reload failed:${RESET} ${err.message}`);
    console.error(`${DIM}fix the error then run: launchctl bootstrap gui/$(id -u) ${PLIST_PATH}${RESET}`);
    process.exit(1);
  }
}
