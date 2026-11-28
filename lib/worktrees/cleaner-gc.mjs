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

const fail = (code, reason) => ({ ok: false, exit: 2, code, reason });

/** The top-level keys C1's `--json` carries on a dry run and on --apply alike. */
export const CONTRACT_KEYS = ["schema_version", "now", "summary", "applied", "actions", "refused", "routes"];
const LIST_KEYS = new Set(["actions", "refused", "routes"]);

/** The contract keys `parsed` lacks (a list key that is not an array counts as lacking). Pure; [] means complete. */
export function missingContractKeys(parsed) {
  const o = parsed !== null && typeof parsed === "object" ? parsed : {};
  return CONTRACT_KEYS.filter((k) => (LIST_KEYS.has(k) ? !Array.isArray(o[k]) : k === "summary" ? o[k] === null || typeof o[k] !== "object" : o[k] === undefined));
}

/**
 * Normalise C1's `--json` into `{applied, actions, refused, routes, summary}`, reading only the contract shape. Returns
 * null for a value that is not an object; a caller must have checked missingContractKeys first, so nothing here
 * invents an empty plan from a shape it did not understand.
 */
export function normaliseGcResult(parsed) {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return { applied: parsed.applied === true, actions: parsed.actions ?? [], refused: parsed.refused ?? [], routes: parsed.routes ?? [], summary: parsed.summary ?? null };
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
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return fail("CLEANER_BAD_OUTPUT", "the cleaner printed JSON that is not an object");
  const missing = missingContractKeys(parsed);
  if (missing.length) return fail("CLEANER_BAD_CONTRACT", `the cleaner's --json does not match contract C1: missing ${missing.join(", ")}`);
  const result = normaliseGcResult(parsed);
  return { ok: true, exit: r.status, argv, result };
}