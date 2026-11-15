/**
 * `work prune` (propagate#150, C9b and R19): delete finished history. The only place the append-only `work_events` table
 * loses rows. Age is the item's LAST event, never `created`: an item created long ago and acked yesterday is recent.
 * Only `acked` and `expired` items go; `pending`, `claimed` and `parked` are never touched, whatever their age.
 */
import { fail } from "./errors.mjs";

export const DEFAULT_PRUNE_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {object} db an open read-write handle
 * @param {{olderThanDays?: number, apply?: boolean}} args
 * @param {{now?: () => number}} opts
 * @returns {{dry_run: boolean, older_than_days: number, items: number, events: number, ids: string[]}}
 */
export function prune(db, { olderThanDays = DEFAULT_PRUNE_DAYS, apply = false } = {}, { now = Date.now } = {}) {
  if (!Number.isFinite(olderThanDays) || olderThanDays < 0) {
    fail("WORK_USAGE", `--older-than needs a number of days, got ${olderThanDays}`, "propagate work prune --older-than 180");
  }
  const cutoff = now() - olderThanDays * DAY_MS;
  // last event time, falling back to `created` for an item with no events (never written by this code, but cheap to cover)
  const find = () => db.prepare(
    `SELECT i.id AS id FROM work_items i
     WHERE i.state IN ('acked', 'expired')
       AND COALESCE((SELECT MAX(e.at) FROM work_events e WHERE e.id = i.id), i.created) < ?
     ORDER BY i.created, i.id`,
  ).all(cutoff).map((r) => r.id);
  const countEvents = (ids) => ids.reduce((n, id) => n + db.prepare("SELECT COUNT(*) AS n FROM work_events WHERE id = ?").get(id).n, 0);

  if (!apply) {
    const ids = find();
    return { dry_run: true, older_than_days: olderThanDays, items: ids.length, events: countEvents(ids), ids };
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    const ids = find();
    const events = countEvents(ids);
    const delEv = db.prepare("DELETE FROM work_events WHERE id = ?");
    const delIt = db.prepare("DELETE FROM work_items WHERE id = ?");
    for (const id of ids) { delEv.run(id); delIt.run(id); }
    db.exec("COMMIT");
    return { dry_run: false, older_than_days: olderThanDays, items: ids.length, events, ids };
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* no transaction left */ }
    throw e;
  }
}
