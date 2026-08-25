/**
 * drain.mjs — the `propagate drain` command family.
 *
 * A FAMILY, NOT A COMMAND, which is why it moved as one unit. `drain` dispatches
 * to `drainList` or `drainClose` on --close/--group, and both share `drainScope`
 * (which workspaces this invocation covers) and `openRowsForWorkspace`. Pulling
 * `drainClose` alone would have left its two helpers behind in cli.mjs with one
 * caller each — the coupling relocated, not removed.
 *
 * `groupOpenRows` travels INSIDE this module rather than into lib/: it has
 * exactly one user. `formatAge` and `rowAgeMs` went to lib/edges/ledger.mjs
 * instead, because `status` uses them too and a helper shared by two families
 * belongs to neither.
 *
 * DRAINCLOSE WRITES. It calls `markStatus`, which appends to the ledger. That is
 * why this module was verified through its read-only modes (`drain`,
 * `--json`, `--all`, each diffed against a stashed HEAD) plus the existing
 * tests/cli/drain.test.mjs and drain-cross.test.mjs, which cover the closing
 * path — and not by running `drain --close` to see what it did.
 *
 * Import prefix is `../lib/…` from here; `../../…` from lib/report/doctor/. G60.
 */

import { existsSync } from "node:fs";

import { RESET, DIM, RED, GREEN, YELLOW, BOLD } from "./ansi.mjs";
import {
  WORKSPACES,
  SEARCH_ROOTS,
  CROSS_LEDGER_JSONL,
  currentWorkspace,
} from "../lib/core/config.mjs";
import { readLedger, markStatus, formatAge, rowAgeMs } from "../lib/edges/ledger.mjs";
import { reconcile } from "../lib/edges/reconcile.mjs";

/**
 * Split open rows into correlation_id groups and an ungrouped remainder.
 * Rows sharing a correlation_id are the same logical change observed on
 * different branches/worktrees — the parallel-coordination behaviour the
 * skill's premise names, so grouping is the default presentation, not an
 * option (SPEC §6, SKILL.md "Correlation grouping matters under the premise").
 */
function drainRowSummary(r) {
  return {
    id: r.id,
    source: r.source ?? null,
    downstreamCount: (r.downstream || []).length,
    ageMs: rowAgeMs(r),
    correlation_id: r.correlation_id ?? null,
  };
}

function groupOpenRows(rows) {
  const groups = new Map(); // correlation_id -> rows[]
  const ungrouped = [];
  for (const r of rows) {
    if (r.correlation_id) {
      if (!groups.has(r.correlation_id)) groups.set(r.correlation_id, []);
      groups.get(r.correlation_id).push(r);
    } else {
      ungrouped.push(r);
    }
  }
  return { groups, ungrouped };
}

/**
 * Which ledgers `drain` may read and close.
 *
 * The cross-repo ledger is included under `--cross` and `--all`. It is not a
 * workspace — it lives at SEARCH_ROOTS[0], outside any of them — so returning
 * WORKSPACES alone made cross rows openable but never closable.
 *
 * That was not theoretical. PanditPawanKaushik/docs/DECISIONS.md 2026-08-15
 * records three cross rows whose relays were verified done by reading the
 * partner repo, and which `drain --close` and `drain --all --close` both
 * refused with "row id(s) not found (or not open) in scope". The rows stayed
 * open for want of scope, and hand-editing the ledger is forbidden by this
 * skill's own rule — so there was no supported way out at all.
 *
 * `--all` includes it because an "all" that silently omits a whole store is the
 * same class of lie this command exists to stop telling. Plain `drain` stays
 * the workspace queue: widening the default would surprise in the other
 * direction, and tests/drain-cross.test.mjs pins both halves.
 */
function drainScope(args) {
  const showAll = args.includes("--all");
  const wantCross = args.includes("--cross") || showAll;
  const cur = currentWorkspace();
  const base = showAll || !cur ? WORKSPACES : [cur];
  const scope = args.includes("--cross") && !showAll ? [] : [...base];
  if (wantCross) {
    scope.push({
      name: "cross-repo",
      root: SEARCH_ROOTS[0],
      ledgerJsonl: CROSS_LEDGER_JSONL,
      isCross: true,
    });
  }
  return scope;
}

/** Open rows for one discovered workspace record (WORKSPACES entry). */
async function openRowsForWorkspace(ws) {
  if (!existsSync(ws.ledgerJsonl)) return [];
  const rows = await readLedger(ws.ledgerJsonl);
  return rows.filter((r) => r.status === "open");
}

/** Workspaces to operate over: current workspace at cwd, unless --all or cwd matches none. */


export async function drainList(args, json) {
  const targets = drainScope(args);

  if (json) {
    const workspaces = [];
    for (const ws of targets) {
      const rows = await openRowsForWorkspace(ws);
      const { groups, ungrouped } = groupOpenRows(rows);
      workspaces.push({
        name: ws.name,
        root: ws.root,
        ledgerJsonl: ws.ledgerJsonl,
        groups: [...groups.entries()].map(([correlation_id, rs]) => ({
          correlation_id,
          count: rs.length,
          rows: rs.map(drainRowSummary),
        })),
        ungrouped: ungrouped.map(drainRowSummary),
      });
    }
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), workspaces }));
    return;
  }

  for (const ws of targets) {
    console.log(`${BOLD}# ${ws.name}${RESET}`);
    const rows = await openRowsForWorkspace(ws);
    if (rows.length === 0) {
      console.log(`  ${GREEN}✓ no open rows${RESET}`);
      // GOTCHAS G38: `drain` handles v1 LEDGER ROWS. `reconcile` derives
      // DRIFTED / REVERSED / DIVERGED / NEVER_VERIFIED from content hashes, and
      // none of those are ledger rows — so "no open rows" is true and, read
      // alone, badly misleading. The entry's whole complaint was "it does not
      // say so"; an operator reached for drain, got a green tick, and concluded
      // there was nothing to do while three edges sat unresolved.
      try {
        const { rows: derived } = await reconcile([ws]);
        // Reuse graph.mjs's ACTIONABLE set rather than re-deriving "not CLEAN".
        // A hand-rolled filter here counted NOT_PRESENT_ON_REF and reported 23
        // where `graph` reported 21 — two commands disagreeing about what needs
        // work, which is worse than either number being slightly wrong.
        const { isActionable } = await import("../lib/graph/graph.mjs");
        const unsettled = derived.filter((r) => isActionable(r.state));
        if (unsettled.length > 0) {
          console.log(
            `  ${YELLOW}but ${unsettled.length} derived edge(s) are not CLEAN${RESET} ` +
              `${DIM}— those are not ledger rows and drain cannot close them.${RESET}`,
          );
          console.log(`  ${DIM}Use ${RESET}${BOLD}propagate graph${RESET}${DIM} for the ordered worklist, then ${RESET}${BOLD}verify --apply${RESET}${DIM}.${RESET}`);
        }
      } catch {
        // A reconcile failure must not break the ledger listing; doctor owns
        // that check. Silence here would be a silent zero, so say it.
        console.log(`  ${DIM}(could not derive edge states — run \`propagate doctor\`)${RESET}`);
      }
      console.log();
      continue;
    }
    const { groups, ungrouped } = groupOpenRows(rows);
    for (const [correlation_id, rs] of groups) {
      console.log(
        `  ${BOLD}${correlation_id}${RESET}  ${DIM}(${rs.length} rows — same logical change, different branch/worktree)${RESET}`,
      );
      for (const r of rs) {
        console.log(
          `    ${YELLOW}#${r.id}${RESET}  ${r.source || "(unknown source)"}  ${DIM}${(r.downstream || []).length} downstream, ${formatAge(rowAgeMs(r))} old${RESET}`,
        );
      }
    }
    for (const r of ungrouped) {
      console.log(
        `  ${YELLOW}#${r.id}${RESET}  ${r.source || "(unknown source)"}  ${DIM}${(r.downstream || []).length} downstream, ${formatAge(rowAgeMs(r))} old${RESET}`,
      );
    }
    console.log();
  }
}

export async function drainClose(args, json) {
  const closeIdx = args.indexOf("--close");
  const groupIdx = args.indexOf("--group");
  const statusIdx = args.indexOf("--status");
  const reasonIdx = args.indexOf("--reason");
  const notesIdx = args.indexOf("--notes");
  const closedByIdx = args.indexOf("--closed-by");

  const closeIds =
    closeIdx !== -1
      ? (args[closeIdx + 1] || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  const groupId = groupIdx !== -1 ? args[groupIdx + 1] : null;
  const status = statusIdx !== -1 ? args[statusIdx + 1] : null;
  const reason = reasonIdx !== -1 ? args[reasonIdx + 1] : undefined;
  const notes = notesIdx !== -1 ? args[notesIdx + 1] : undefined;
  const closedBy = closedByIdx !== -1 ? args[closedByIdx + 1] : "drain";

  if (closeIds.length === 0 && !groupId) {
    console.error(
      `${RED}error:${RESET} nothing to close — pass --close <id[,id...]> and/or --group <correlation_id>`,
    );
    process.exit(2);
  }
  if (!status) {
    console.error(`${RED}error:${RESET} --status <done|wontfix|partial> is required with --close/--group`);
    process.exit(2);
  }
  if (!["done", "wontfix", "partial"].includes(status)) {
    console.error(`${RED}error:${RESET} --status must be one of done|wontfix|partial (got "${status}")`);
    process.exit(2);
  }

  const scope = drainScope(args);
  const openByWs = new Map(); // ws -> open rows
  for (const ws of scope) {
    openByWs.set(ws, await openRowsForWorkspace(ws));
  }

  // Resolve every --close id to the (single) workspace ledger where it's
  // currently open. Ids are file-local (lib/ledger.mjs nextId), so the same
  // id string can legitimately be open in two different ledgers when scoped
  // with --all — that's ambiguous and must fail loudly (I1), not guess.
  const targets = []; // {ws, row}
  const notFound = [];
  for (const id of closeIds) {
    const found = [];
    for (const [ws, rows] of openByWs) {
      const r = rows.find((row) => row.id === id);
      if (r) found.push({ ws, row: r });
    }
    if (found.length === 0) {
      notFound.push(id);
    } else if (found.length > 1) {
      console.error(
        `${RED}error:${RESET} row id "${id}" is open in more than one workspace ledger (${found
          .map((f) => f.ws.name)
          .join(", ")}) — re-run scoped to a single workspace instead of --all`,
      );
      process.exit(1);
    } else {
      targets.push(found[0]);
    }
  }
  if (notFound.length) {
    console.error(
      `${RED}error:${RESET} row id(s) not found (or not open) in scope: ${notFound.join(", ")}`,
    );
    console.error(
      `${DIM}run \`node cli.mjs drain\` (add --all to widen scope) to see current open ids${RESET}`,
    );
    process.exit(1);
  }

  if (groupId) {
    let matched = 0;
    for (const [ws, rows] of openByWs) {
      for (const r of rows) {
        if (r.correlation_id === groupId) {
          targets.push({ ws, row: r });
          matched++;
        }
      }
    }
    if (matched === 0) {
      console.error(`${RED}error:${RESET} no open rows found with correlation_id "${groupId}"`);
      process.exit(1);
    }
  }

  // De-dupe: an id could arrive via both --close and --group.
  const seen = new Set();
  const uniqueTargets = [];
  for (const t of targets) {
    const key = `${t.ws.ledgerJsonl}:${t.row.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueTargets.push(t);
  }

  const opts = { closed_by: closedBy };
  if (notes !== undefined) opts.notes = notes;
  if (status === "wontfix") opts.wontfix_reason = reason;

  const closed = [];
  const failed = [];

  for (const { ws, row } of uniqueTargets) {
    try {
      await markStatus(ws.ledgerJsonl, row.id, status, opts);
    } catch (err) {
      // markStatus throws for status:"wontfix" with no wontfix_reason, and for
      // an invalid closed_by — surface the message, not a stack trace.
      failed.push({ id: row.id, workspace: ws.name, error: err.message });
      continue;
    }
    // Verify the close actually landed — do not trust "did not throw". A
    // wrong-ledger write or a discovery mismatch would otherwise silently
    // no-op and leave the row open (I1: no silent no-op).
    const after = await readLedger(ws.ledgerJsonl);
    const updated = after.find((r) => r.id === row.id);
    const stillOpen = !updated || updated.status === "open";
    if (stillOpen) {
      failed.push({
        id: row.id,
        workspace: ws.name,
        error: "verify-after-write failed: row still open after markStatus",
      });
    } else {
      closed.push({ id: row.id, workspace: ws.name, status: updated.status });
    }
  }

  if (json) {
    console.log(
      JSON.stringify({
        generatedAt: new Date().toISOString(),
        status,
        closed_by: closedBy,
        wontfix_reason: status === "wontfix" ? reason : undefined,
        closed,
        failed,
        exitCode: failed.length ? 1 : 0,
      }),
    );
  } else {
    for (const c of closed) {
      console.log(`${GREEN}✓${RESET} #${c.id}  ${c.workspace}  → ${c.status}  ${DIM}(closed_by: ${closedBy})${RESET}`);
    }
    for (const f of failed) {
      console.log(`${RED}✗${RESET} #${f.id}  ${f.workspace}  ${RED}${f.error}${RESET}`);
    }
  }

  if (failed.length) process.exit(1);
}
