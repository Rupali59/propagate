/**
 * settle.mjs — `propagate settle <file>`: the worklist for ONE file, read-only.
 *
 * WHAT IT IS. Settling drift used to cost 10-20 minutes a pass: `reconcile
 * --json` piped through node to find a file's edges, diffs read by hand, two
 * refusals learned by hitting them (out-of-order upstreams; DIVERGED wants
 * `both-reconciled`). Every piece of that was already derivable. This command
 * assembles it, per edge, in fix order, and ends each edge in the exact
 * `verify` command that records the decision.
 *
 * WHAT IT IS NOT: a prompt loop. `cli.mjs` records that propagate CLIs never
 * prompt ("a CLI cannot prompt a human, and a prompt loop cannot be tested") and
 * the Claude Code Bash tool has no TTY on stdin besides. The human walkthrough
 * is the /propagate skill's job (skills/propagate/sections/settle.md): it runs
 * `settle <file> --json`, asks ONE question per edge, then runs the printed
 * command. The edge `commands/settle.mjs -> skills/propagate/sections/settle.md`
 * is declared in this repo's `.propagates.yml` so the two stay in step.
 *
 * READ-ONLY, AND TESTED AS SUCH. This module never calls `appendEvent` and never
 * edits a sidecar -- the tool never edits a downstream (README), and the human
 * picks each disposition. tests/cli/settle.test.mjs snapshots the event store
 * before and after, which is the check that cannot be fooled by this comment.
 *
 * ONE PREDICATE. What an edge may be settled WITH comes from
 * `allowedDispositions` (lib/edges/disposition.mjs) -- the same two guards
 * `verify` enforces, so this never offers an option verify would refuse.
 *
 * Commands it prints always use `--edge`, never `--glob` (GOTCHAS G74: `--glob`
 * is exact equality on a field that is null for every literal-path edge, so a
 * printed `--glob` command selects nothing).
 */

import path from "node:path";

import { allowedDispositions, verifyCommand, shellQuote } from "../lib/edges/disposition.mjs";
import { buildGraph, fixOrder, matchNodePaths } from "../lib/graph/graph.mjs";
import { historyByEdge, defaultDeps } from "../lib/report/queue.mjs";
import { edgeDiff } from "../lib/report/evidence.mjs";
import { shortPath } from "../lib/core/config.mjs";

/** Lines of each diff shown in text mode; `--json` carries the full (clamped) text. */
const TEXT_DIFF_LINES = 24;

/** The placeholder a caller replaces with the human's typed, shell-quoted reason. */
export const REASON_PLACEHOLDER = "<…>";

const colour = (on) => ({
  B: on ? "\x1b[1m" : "",
  D: on ? "\x1b[2m" : "",
  R: on ? "\x1b[0m" : "",
});

/**
 * Derive the settle worklist for a file. Pure of I/O beyond the reads it is
 * handed through `deps` -- nothing here writes.
 *
 * @param {string} sel - what the user typed
 * @param {{loadWorkspaces: Function, reconcile: Function, history?: Function, diff?: Function, cwd?: string}} deps
 * @returns {Promise<{ok: true, ...}|{ok: false, code: number, error: string, candidates?: string[]}>}
 */
export async function settleWorklist(sel, deps) {
  const workspaces = await deps.loadWorkspaces();
  const { rows } = await deps.reconcile(workspaces, {});
  const graph = buildGraph(rows, { workspaceRoots: workspaces.map((w) => w.root) });

  // The matcher is `graph --node`'s, extended by one convenience: a relative
  // path that exists under the cwd. `settle docs/X.md` is what a person types.
  let match = matchNodePaths(graph.nodes.keys(), sel, shortPath);
  if (match.length === 0 && !path.isAbsolute(sel)) {
    match = matchNodePaths(graph.nodes.keys(), path.resolve(deps.cwd ?? process.cwd(), sel), shortPath);
  }
  if (match.length === 0) {
    return {
      ok: false,
      code: 1,
      error: `no file matched ${JSON.stringify(sel)} — it is not the source or downstream of any declared edge`,
    };
  }
  if (match.length > 1) {
    return {
      ok: false,
      code: 2,
      error: `${match.length} files matched ${JSON.stringify(sel)} — be more specific`,
      candidates: match.slice(0, 10),
    };
  }
  const target = match[0];

  const touching = rows.filter((r) => r.source?.path === target || r.downstream?.path === target);
  const byState = {};
  for (const r of touching) byState[r.state] = (byState[r.state] ?? 0) + 1;
  const rowById = new Map(touching.map((r) => [r.edge_id, r]));

  // Fix order is re-derived on every run -- nothing is cached between walks, so
  // an edge settled a minute ago has already left it. includeUnverified: a
  // NEVER_VERIFIED edge is real work here (and the usual reason something else
  // is blocked), unlike on the whole-tree worklist where 88 of them would drown
  // the 23 that moved.
  const { items: ordered } = fixOrder(graph, { includeUnverified: true });
  const mine = ordered
    .map((i, index) => ({ i, index }))
    .filter(({ i }) => i.from === target || i.to === target);

  const history = await (deps.history ?? historyByEdge)();
  const diff = deps.diff ?? edgeDiff;

  const items = [];
  for (const { i, index } of mine) {
    const row = rowById.get(i.edge_id);
    if (!row) continue; // fixOrder and reconcile disagree -- never invent a row
    const h = history.get(i.edge_id) ?? null;
    const blockers = i.blockedBy ?? [];
    const a = allowedDispositions(row, blockers);
    const lv = h?.lastVerified ?? null;

    const d = await diff({
      file: row.source?.path ?? null,
      sinceCommit: lv?.commit ?? null,
      dirty: !!lv?.dirty,
      downstreamFile: row.downstream?.path ?? null,
      downstreamSinceCommit: lv?.downstreamCommit ?? null,
      downstreamDirty: lv?.downstreamDirty ?? null,
    });

    const commands = {};
    for (const disp of a.allowed) {
      commands[disp] = verifyCommand({ edge: i.edge_id, disposition: disp, reason: REASON_PLACEHOLDER });
    }
    const outOfOrderCommands = {};
    for (const disp of a.viaOutOfOrder) {
      outOfOrderCommands[disp] = verifyCommand({
        edge: i.edge_id, disposition: disp, reason: REASON_PLACEHOLDER, outOfOrder: true,
      });
    }

    const srcWs = graph.nodes.get(i.from)?.workspace ?? null;
    items.push({
      order: index + 1,
      edge_id: i.edge_id,
      node_id: i.node_id,
      state: i.state,
      direction: i.to === target ? "into" : "out of",
      source: i.from,
      downstream: i.to ?? null,
      sourceShort: shortPath(i.from),
      downstreamShort: i.to ? shortPath(i.to) : null,
      // One line: a declared reason is often a paragraph with a trailing newline,
      // and printed raw it pushes the edge's own facts off the screen.
      why: row.why ? String(row.why).replace(/\s+/g, " ").trim() : null,
      layer: i.layer,
      judged: h?.total ?? 0,
      prior: (h?.dispositions ?? [])
        .filter((p) => p.reason)
        .sort((x, y) => String(y.ts).localeCompare(String(x.ts)))
        .slice(0, 3),
      last: h?.last ?? null,
      since: lv ? { commit: lv.commit, ts: lv.ts, dirty: lv.dirty } : null,
      diff: d,
      allowed: a.allowed,
      viaOutOfOrder: a.viaOutOfOrder,
      needsReason: a.needsReason,
      blocked: a.blocked,
      blockedBy: blockers.map((b) => ({
        edge_id: b.edge_id,
        state: b.state,
        from: b.from,
        to: b.to,
        fromShort: shortPath(b.from),
        toShort: shortPath(b.to),
        otherWorkspace: (graph.nodes.get(b.from)?.workspace ?? null) !== srcWs,
        // NEVER a dead "walk upstream": the route is a command that works, and
        // for a NEVER_VERIFIED blocker it is the same command (the blocker edge
        // is settled like any other; it simply has no diff).
        route: `propagate settle ${shellQuote(b.to)}`,
      })),
      commands,
      outOfOrderCommands,
    });
  }

  const neverVerified = byState.NEVER_VERIFIED ?? 0;
  return {
    ok: true,
    file: target,
    fileShort: shortPath(target),
    edgesTouching: touching.length,
    byState,
    // "Nothing printed" and "nothing to do" are different facts, and so is
    // "nothing has ever been judged". A file whose edges are ALL NEVER_VERIFIED
    // has no drift and no baseline to diff against; saying so is the difference
    // between an answer and an empty screen.
    allNeverVerified: touching.length > 0 && neverVerified === touching.length,
    items,
    historyMalformed: history.malformed ?? 0,
  };
}

/** Render the worklist for a terminal. */
export function renderSettle(w, { colour: useColour = false } = {}) {
  const { B, D, R } = colour(useColour);
  const out = [];
  out.push(`${B}settle${R} ${w.fileShort}  ${D}(read-only — nothing is written; each edge ends in a verify command)${R}`);
  const states = Object.entries(w.byState).map(([s, n]) => `${n} ${s}`).join(" · ");
  out.push(`  ${w.edgesTouching} edge(s) touch this file: ${states || "none"}`);

  if (w.allNeverVerified) {
    out.push(
      `  every edge on this file is NEVER_VERIFIED — none has ever been judged, so there is no drift to settle and ` +
        `no "since last verify" diff. They are listed so they can be baselined; they also block anything downstream of them.`,
    );
  } else if (w.items.length === 0) {
    out.push(`  nothing to settle — every edge on this file is settled.`);
  }

  w.items.forEach((it, n) => {
    out.push("");
    out.push(
      `${B}[${n + 1}/${w.items.length}] ${it.state}${R}  ${it.edge_id}  ${D}(${it.direction} this file · fix-order #${it.order})${R}`,
    );
    out.push(`    ${it.sourceShort} -> ${it.downstreamShort ?? "(glob matched nothing)"}${it.why ? `   ${D}"${it.why.length > 200 ? it.why.slice(0, 197) + "..." : it.why}"${R}` : ""}`);
    if (it.judged === 0) out.push(`    never judged`);
    else {
      out.push(`    judged ${it.judged}x`);
      for (const p of it.prior) {
        out.push(`      ${D}${String(p.ts).slice(0, 10)} ${p.disposition}${p.by ? ` by ${p.by}` : ""}: ${p.reason}${R}`);
      }
    }
    const dd = it.diff;
    if (dd?.ok) {
      out.push(`    since last pinning verify (${String(dd.since).slice(0, 8)}${it.since?.dirty ? ", tree was dirty" : ""}):`);
      for (const side of [["source", dd], ["downstream", dd.downstream]]) {
        const [label, s] = side;
        if (!s) continue;
        if (!s.ok) out.push(`      ${label}: ${D}${s.reason}${R}`);
        else if (s.empty) out.push(`      ${label}: ${D}unchanged${R}`);
        else {
          const lines = String(s.text).split("\n");
          out.push(`      ${label}:`);
          for (const l of lines.slice(0, TEXT_DIFF_LINES)) out.push(`        ${l}`);
          if (lines.length > TEXT_DIFF_LINES) {
            out.push(`        ${D}… ${lines.length - TEXT_DIFF_LINES} more line(s) — --json carries up to 200${R}`);
          }
        }
      }
    } else if (dd) {
      out.push(`    diff: ${D}${dd.reason}${R}`);
    }
    if (it.blocked) {
      out.push(`    ${B}blocked${R} — the source is itself unsettled:`);
      for (const b of it.blockedBy) {
        out.push(
          `      by ${b.edge_id} (${b.fromShort} -> ${b.toShort}, ${b.state}${b.otherWorkspace ? ", other workspace" : ""})`,
        );
        out.push(`        route: ${b.route}`);
      }
      out.push(`    allowed now: ${it.allowed.join(", ") || "none"}   ${D}(the rest need --out-of-order)${R}`);
    } else {
      out.push(`    allowed: ${it.allowed.join(", ") || "none"}`);
    }
    if (it.needsReason.length) out.push(`    ${D}reason required: ${it.needsReason.join(", ")}${R}`);
    out.push(`    commands ${D}(replace '${REASON_PLACEHOLDER}' with the reason, single-quoted):${R}`);
    for (const [disp, cmd] of Object.entries(it.commands)) out.push(`      ${disp.padEnd(17)} ${cmd}`);
    for (const [disp, cmd] of Object.entries(it.outOfOrderCommands)) out.push(`      ${disp.padEnd(17)} ${cmd}   ${D}(overrides the ordering guard)${R}`);
  });
  return out;
}

export async function settleCmd(argv = [], io = console, deps = null) {
  const asJson = argv.includes("--json");
  const sel = argv.find((a) => !a.startsWith("--"));
  const walkStarted = new Date().toISOString();

  if (!sel) {
    io.log("usage: propagate settle <file> [--json]   (read-only worklist; see `propagate help settle`)");
    return 2;
  }

  let w;
  try {
    w = await settleWorklist(sel, deps ?? (await defaultDeps()));
  } catch (err) {
    const msg = String(err?.message ?? err);
    // A reader that cannot report failure invents an answer: the error rides in
    // the expected shape rather than an empty worklist that reads as "all clear".
    if (asJson) io.log(JSON.stringify({ error: msg, items: null, file: sel, read_only: true }));
    else io.log(`settle: could not derive — ${msg}`);
    return 2;
  }

  if (!w.ok) {
    if (asJson) io.log(JSON.stringify({ error: w.error, candidates: w.candidates ?? null, items: null, file: sel, read_only: true }));
    else {
      io.log(`settle: ${w.error}`);
      for (const c of w.candidates ?? []) io.log(`  ${shortPath(c)}`);
    }
    return w.code;
  }

  if (asJson) {
    io.log(
      JSON.stringify({
        read_only: true,
        walk_started: walkStarted,
        session_id: process.env.CLAUDE_CODE_SESSION_ID || null,
        reason_placeholder: REASON_PLACEHOLDER,
        ...w,
        generatedAt: new Date().toISOString(),
      }),
    );
    return 0;
  }
  for (const line of renderSettle(w, { colour: process.stdout.isTTY })) io.log(line);
  return 0;
}
