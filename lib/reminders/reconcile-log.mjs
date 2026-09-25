/**
 * reconcile-log.mjs — the append-only reconciliation log (H2, F2,
 * `docs/plans/2026-09-23-reminders-todo-bridge.md:93-97,204-219`).
 *
 * H2 names what an unguarded write to a store shaped like this one has
 * already cost in THIS repo: N44 (2 junk events, permanent, append-only
 * cannot withdraw them) and the 2026-08-17 incident (11 spurious events, 3
 * silently-closed worklist items). This module is deliberately as small as
 * `lib/edges/events.mjs`'s append primitive: read, and append ONE line.
 * Nothing here decides WHETHER to write — that decision, and the `--apply`
 * gate that guards it, belongs entirely to reconcile.mjs, the sole caller of
 * `appendReconcileEvent` in this lane.
 */
import { existsSync } from "node:fs";
import { readFile, appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { STATE_DIR } from "../core/config.mjs";

/** @param {string} [stateDir] */
export function reconcileLogPath(stateDir = STATE_DIR) {
  return path.join(stateDir, "reminders", "reconcile-log.jsonl");
}

/**
 * Every parseable line. A malformed line is counted, never thrown away
 * silently — `rule:discernment-checks` §2: absence must be attributable.
 *
 * @param {string} [stateDir]
 * @returns {Promise<{rows: object[], malformed: number}>}
 */
export async function readReconcileLog(stateDir = STATE_DIR) {
  const p = reconcileLogPath(stateDir);
  if (!existsSync(p)) return { rows: [], malformed: 0 };
  const raw = await readFile(p, "utf8");
  const rows = [];
  let malformed = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      malformed++;
    }
  }
  return { rows, malformed };
}

/**
 * Append ONE event. THE unsafe path this whole file exists to gate — see
 * reconcile.mjs's `apply` parameter, which is the only thing in this lane
 * allowed to call this function.
 *
 * @param {object} event
 * @param {string} [stateDir]
 */
export async function appendReconcileEvent(event, stateDir = STATE_DIR) {
  const p = reconcileLogPath(stateDir);
  await mkdir(path.dirname(p), { recursive: true });
  await appendFile(p, `${JSON.stringify(event)}\n`, "utf8");
  return { ok: true, path: p };
}
