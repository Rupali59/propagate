/**
 * lib/worktrees/cleaner-gc.mjs — propagate's side of the cleaner contract C1 (propagate#274, #446): run the cleaner's
 * `scripts/worktree-gc.sh` over a set of repos and hand back what it said. propagate never decides a verdict here;
 * the cleaner classifies and removes, this file only calls it, reads its `--json`, and passes its exit code through.
 *
 * C1: `<cleanerDir>/scripts/worktree-gc.sh [--json] [--apply] <repo-or-worktree>...`. A dry run unless `--apply`
 * (the flag is passed ONLY when the caller asked, tests/unit/worktrees-cleaner.test.mjs proves it on the argv the
 * stub records). Exit 0 clean or applied, 1 findings or refused, 2 could not run.
 *
 * ABSENCE IS NEVER A ZERO (rule:discernment-checks §2). An unset cleanerDir, a missing script, a spawn failure, an
 * unexpected exit and output that is not JSON are each their own coded result with exit 2.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export const CLEANER_SCRIPT = path.join("scripts", "worktree-gc.sh");
export const CLEANER_AUDIT = path.join("logs", "last-audit.json");

/** The two files propagate reads from a cleaner checkout. Pure. */
export function cleanerPaths(cleanerDir) {
  return { script: path.join(cleanerDir, CLEANER_SCRIPT), audit: path.join(cleanerDir, CLEANER_AUDIT) };
}

const FULL_SHA = /^[0-9a-f]{40}$/;
const hasHead = (r) => typeof r?.head === "string" && FULL_SHA.test(r.head);

/**
 * C4 routes. The top-level `routes` list is read first; a route lacking a full 40-char head borrows it from the
 * matching `proposal.tier_b[]` row (same path, else same repo and issue), whose `route.head` or row `head` carries it.
 * A route still without one is returned as-is: routes.mjs reports it as "head missing" and never calls a body hash a head.
 */
function collectRoutes(parsed, c) {
  const top = Array.isArray(parsed.routes) ? parsed.routes : Array.isArray(c.routes) ? c.routes : null;
  const rows = Array.isArray(parsed.proposal?.tier_b) ? parsed.proposal.tier_b : [];
  const fromRows = rows.filter((w) => w?.route).map((w) => ({ path: w.path, branch: w.branch, verdict: w.verdict, ...w.route, head: hasHead(w.route) ? w.route.head : w.head }));
  return (top ?? fromRows).map((r) => {
    if (!r || typeof r !== "object" || hasHead(r)) return r;
    const m = fromRows.find((x) => hasHead(x) && ((r.path && x.path === r.path) || (x.repo === r.repo && x.issue === r.issue)));
    return m ? { ...r, head: m.head } : r;
  });
}

const fail = (code, reason) => ({ ok: false, exit: 2, code, reason });

/**
 * Normalise C1's `--json` into `{applied, actions, refused, routes, summary, rawRoutes}`. The cleaner prints the apply
 * result under `apply_result` when `--apply` ran, and its classify result (no `actions`) on a dry run; both are read,
 * and a dry run's plan is taken from `proposal.apply` so the same fields exist either way. `routes` may sit at the top
 * level or inside `apply_result`. Returns null for a value that is not an object: the caller reports it, never "empty".
 */
export function normaliseGcResult(parsed) {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const c = parsed.apply_result && typeof parsed.apply_result === "object" ? parsed.apply_result : parsed;
  const planned = Array.isArray(parsed.proposal?.apply)
    ? parsed.proposal.apply.map((a) => ({ path: a.path, verdict: a.verdict, status: "planned" }))
    : [];
  return {
    applied: c.applied === true,
    actions: Array.isArray(c.actions) ? c.actions : planned,
    refused: Array.isArray(c.refused) ? c.refused : [],
    routes: collectRoutes(parsed, c),
    summary: parsed.summary && typeof parsed.summary === "object" ? parsed.summary : null,
    note: typeof c.note === "string" ? c.note : null,
  };
}

/**
 * Run the cleaner over `paths`.
 * @param {{cleanerDir: string|null, paths: string[], apply?: boolean, spawn?: Function, exists?: Function, env?: object}} o
 * @returns {{ok:false, exit:2, code:string, reason:string} | {ok:true, exit:number, argv:string[], result:object}}
 */
export function runCleanerGc({ cleanerDir, paths, apply = false, spawn = spawnSync, exists = existsSync, env = process.env }) {
  if (typeof cleanerDir !== "string" || !cleanerDir.length) {
    return fail("CLEANER_NOT_CONFIGURED", "cleaner not configured: set PROPAGATE_CLEANER_DIR, or integrations.cleanerDir in ~/.propagate/config.yml");
  }
  // An empty list is deliberate: the cleaner then derives its own repository set (C1) and floor-checks it itself.
  if (!Array.isArray(paths)) return fail("CLEANER_NO_PATHS", "paths must be a list; an empty list lets the cleaner derive its own repository set");
  const { script } = cleanerPaths(cleanerDir);
  if (!exists(script)) return fail("CLEANER_SCRIPT_MISSING", `the cleaner's worktree-gc.sh is not at ${script}`);
  const argv = ["--json", ...(apply ? ["--apply"] : []), ...paths];
  const r = spawn(script, argv, { encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) return fail("CLEANER_SPAWN", `could not run ${script}: ${r.error.message}`);
  if (r.status === null) return fail("CLEANER_SIGNAL", `${script} was killed by ${r.signal ?? "a signal"}`);
  if (![0, 1, 2].includes(r.status)) return fail("CLEANER_EXIT", `${script} exited ${r.status}, which is not a documented C1 exit (0, 1 or 2)`);
  if (r.status === 2) return fail("CLEANER_COULD_NOT_RUN", `the cleaner could not run: ${String(r.stderr ?? "").trim() || "(no stderr)"}`);
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    return fail("CLEANER_BAD_OUTPUT", `the cleaner exited ${r.status} but its stdout is not JSON (first 120 bytes: ${JSON.stringify(String(r.stdout ?? "").slice(0, 120))})`);
  }
  const result = normaliseGcResult(parsed);
  if (!result) return fail("CLEANER_BAD_OUTPUT", "the cleaner printed JSON that is not an object");
  return { ok: true, exit: r.status, argv, result };
}
