/**
 * lib/guard/log.mjs — the CLI side of the background-guard log (propagate#294).
 *
 * hooks/background-guard.mjs APPENDS rows to `$PROPAGATE_STATE_DIR/guard/YYYY-MM.jsonl` (UTC month of the row's `ts`);
 * it never lists or deletes them, because a hook runs on every Bash call and must stay cheap and fail open. This module
 * owns the other half, pruning, and `propagate day open` calls it. A month file is removed once the month it covers
 * ENDED more than GUARD_RETENTION_DAYS days ago. A name that is not `YYYY-MM.jsonl` with a real month is never touched.
 */
import { readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { stateDir } from "../core/paths.mjs";

export const GUARD_RETENTION_DAYS = 90;
const MONTH_FILE = /^(\d{4})-(0[1-9]|1[0-2])\.jsonl$/;
const DAY_MS = 86400000;

export const guardDir = (dir = stateDir()) => path.join(dir, "guard");

/**
 * Remove the month files that ended more than 90 days before `now`. An absent `guard/` (an install from before #294,
 * or one that has logged nothing yet) removes nothing and creates nothing.
 * @returns {string[]} the removed file names, sorted
 */
export function pruneGuard(dir = stateDir(), now = Date.now()) {
  const d = guardDir(dir);
  let names;
  try {
    names = readdirSync(d);
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  const cutoff = now - GUARD_RETENTION_DAYS * DAY_MS;
  const removed = [];
  for (const name of names.sort()) {
    const m = MONTH_FILE.exec(name);
    if (!m) continue;
    // Date.UTC takes a 0-based month, so the 1-based month number IS the first day of the next month: when it ended.
    const ended = Date.UTC(Number(m[1]), Number(m[2]), 1);
    if (ended >= cutoff) continue;
    rmSync(path.join(d, name), { force: true });
    removed.push(name);
  }
  return removed;
}
