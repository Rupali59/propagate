/**
 * `propagate worktrees [<repo-or-worktree>...] [--apply] [--json]` (propagate#274, #446): run the cleaner's worktree
 * collector (contract C1) over the named repos, or over the repos propagate discovers, and post the issue comments
 * it routes (C4). propagate decides nothing: lib/worktrees/cleaner-gc.mjs calls the cleaner, lib/worktrees/routes.mjs posts.
 *
 * Without --apply the cleaner is called WITHOUT --apply and nothing is posted: the dry run lists what would happen.
 * EXIT. The cleaner's own 0 (clean or applied) and 1 (findings, or refused) pass through; 2 is could not run, and is the
 * answer for an unset cleaner (`cleaner not configured`), never 0. A route whose `gh` call failed raises a clean 0 to 1.
 */
import path from "node:path";

import { stateDir } from "../lib/core/paths.mjs";
import { runCleanerGc, deriveRepos } from "../lib/worktrees/cleaner-gc.mjs";
import { postRoutes } from "../lib/worktrees/routes.mjs";

const USAGE = "usage: propagate worktrees [<repo-or-worktree>...] [--apply] [--json]";

/**
 * @param {string[]} args argv after `worktrees`
 * @param {{cleanerDir?: string|null, workspaces?: object[], stateDirPath?: string, out?: Function, err?: Function, spawn?: Function, ghBin?: string}} [inject] tests
 * @returns {Promise<number>} exit code
 */
export async function worktreesCmd(args, inject = {}) {
  const out = inject.out ?? ((s) => console.log(s));
  const err = inject.err ?? ((s) => console.error(s));
  const flags = args.filter((a) => a.startsWith("--"));
  for (const f of flags) {
    if (f !== "--apply" && f !== "--json") { err(`worktrees: unknown argument ${f}\n${USAGE}`); return 2; }
  }
  const apply = flags.includes("--apply");
  const json = flags.includes("--json");
  const named = args.filter((a) => !a.startsWith("--")).map((p) => path.resolve(p));

  let cleanerDir = inject.cleanerDir;
  if (cleanerDir === undefined) cleanerDir = (await import("../lib/core/config.mjs")).INTEGRATIONS.cleanerDir;

  let repos = named;
  let skipped = [];
  if (!repos.length && cleanerDir) {
    const workspaces = inject.workspaces ?? (await import("../lib/core/config.mjs")).WORKSPACES;
    ({ repos, skipped } = deriveRepos(workspaces, inject.spawn ? { spawn: inject.spawn } : {}));
  }

  const run = runCleanerGc({ cleanerDir, paths: repos, apply, ...(inject.spawn ? { spawn: inject.spawn } : {}) });
  if (!run.ok) {
    if (json) out(JSON.stringify({ ok: false, exit: 2, code: run.code, reason: run.reason, applied: false }, null, 2));
    else err(`worktrees: ${run.reason}`);
    return 2;
  }

  let posts;
  try {
    posts = postRoutes({ routes: run.result.routes, apply, stateDir: inject.stateDirPath ?? stateDir(), ghBin: inject.ghBin, ...(inject.spawn ? { spawn: inject.spawn } : {}) });
  } catch (e) {
    err(`worktrees: could not read the routes ledger (${e.message}); no route was posted`);
    return 2;
  }
  const failed = posts.counts.failed ?? 0;
  const exit = run.exit === 0 && failed ? 1 : run.exit;

  if (json) {
    out(JSON.stringify({ ok: true, exit, applied: apply, repos, skipped_workspaces: skipped, cleaner_exit: run.exit, actions: run.result.actions, refused: run.result.refused, routes: posts.rows, route_counts: posts.counts, note: run.result.note }, null, 2));
    return exit;
  }
  out(`worktrees ${apply ? "(--apply)" : "(dry run)"} over ${repos.length} repositor${repos.length === 1 ? "y" : "ies"}`);
  if (run.result.summary) out(`  cleaner summary: ${run.result.summary.total ?? "?"} worktrees, tier A ${run.result.summary.tier_a ?? "?"}, tier B ${run.result.summary.tier_b ?? "?"}`);
  for (const a of run.result.actions) out(`  ${String(a.status ?? "?").padEnd(8)} ${String(a.verdict ?? "?").padEnd(22)} ${a.path}${a.error ? `  ${a.error}` : ""}`);
  for (const r of run.result.refused) out(`  REFUSED ${r.path}: ${r.reason}`);
  if (run.result.note) out(`  ${run.result.note}`);
  if (!run.result.actions.length && !run.result.refused.length) out("  the cleaner proposed no action");
  for (const r of posts.rows) out(`  route ${r.status}${r.key ? ` ${r.key}` : ""}${r.error ? `: ${r.error}` : ""}`);
  if (!posts.rows.length) out("  routes: none");
  if (!apply && posts.rows.some((r) => r.status === "would-post")) out("  dry run: nothing was removed or posted; pass --apply");
  if (failed) err(`worktrees: ${failed} route comment(s) failed; they are retried on the next --apply`);
  return exit;
}
