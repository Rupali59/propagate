/**
 * reconcile.mjs — F2: dry-run by default, and the ONLY function in this lane
 * allowed to write the identity map or the reconciliation log.
 * `docs/plans/2026-09-23-reminders-todo-bridge.md` D1/D2, F2, H2, H5.
 *
 * WHAT THIS DOES NOT DO, STATED PLAINLY (see the report this lane hands
 * back). The spec's goal state is a reminder "appears as an item in that
 * project's register." Nothing in this repo inserts a NEW line into a
 * hand-written TODOS.md — `lib/registers/write.mjs`'s own header says so:
 * every planner there edits exactly one EXISTING line, and insertion
 * ("HANDOVERS.md resolution ... is a different operation") is explicitly
 * out of that module's scope. Building an inserter, plus a reader able to
 * say "this TODO line IS this reminder," is real, unscoped work — it is not
 * in this lane's file list (`lib/core/plist.mjs`, `docs/SYSTEMS.md`, new
 * files under `lib/reminders/`, the doctor check) and the identity map is
 * explicitly provisional pending PR-003. So THIS module reconciles the one
 * side it can honestly observe — a reminder's own completion state, against
 * what this tool last recorded about it — and durably records the decision
 * when `apply` is set. It never writes to a project's register; every
 * result carries `writesToRegister: false` so that gap cannot be missed by
 * a caller reading the return value instead of this comment.
 *
 * H5 (ties are held, never silently resolved) does not yet apply in full:
 * that rule is about two INDEPENDENT writers disagreeing, and this module
 * only ever compares a reminder against this tool's OWN prior observation of
 * that same reminder — there is one clock, not two, until a register reader
 * exists. `completed`/`reopened` below are that one-sided comparison, named
 * honestly rather than as a resolved tie.
 */
import { readReminders } from "./read.mjs";
import { loadIdentityMap, saveIdentityMap, assignId, recordObservation } from "./identity-map.mjs";
import { appendReconcileEvent } from "./reconcile-log.mjs";
import { STATE_DIR } from "../core/config.mjs";

/** Every disposition this reconciler can produce. Exported so a test can
 *  assert it looped over all of them (F2's "not one disposition"). */
export const DISPOSITIONS = Object.freeze([
  "new",
  "no-change",
  "completed",
  "reopened",
  "held-untagged",
  "held-unknown-tag",
]);

/**
 * @param {import("./normalize.mjs").normalizeRecord extends (...a:any)=>infer T ? T : never} item
 * @param {{lastObserved: {completed: boolean, completedAt: string|null}|null}|null} priorEntry
 */
function dispositionForRoutedItem(item, priorEntry) {
  if (!priorEntry || priorEntry.lastObserved === null) return "new";
  if (priorEntry.lastObserved.completed === item.completed) return "no-change";
  return item.completed ? "completed" : "reopened";
}

/**
 * Compute the full reconciliation plan for the current read, and — only
 * when `apply` is true — persist it. Every other call, including a failed
 * (`ok:false`) read, touches neither the identity map nor the
 * reconciliation log.
 *
 * @param {{
 *   readRemindersFn?: () => Promise<*>,
 *   stateDir?: string,
 *   apply?: boolean,
 *   now?: () => string,
 * }} [opts]
 */
export async function reconcileReminders({
  readRemindersFn = readReminders,
  stateDir = STATE_DIR,
  apply = false,
  now = () => new Date().toISOString(),
} = {}) {
  const result = await readRemindersFn();

  // INCONCLUSIVE IS NOT "NOTHING TO RECONCILE". Never fall through to the
  // write path below on a could-not-look read, whatever `apply` says —
  // rule:discernment-checks §2/§6, and F1's whole point one layer down.
  if (!result.ok) {
    return {
      ok: false,
      applied: false,
      reason: result.reason,
      reasonDetail: result.reasonDetail,
      code: result.code,
    };
  }

  // Loaded regardless of `apply` -- a READ is not the unsafe path. Every
  // mutation below happens only in a LOCAL copy (`map`), never on disk,
  // until the `if (apply)` block at the bottom.
  let map = await loadIdentityMap(stateDir);
  const nowIso = now();
  const rows = [];

  for (const item of result.items) {
    if (item.route.kind !== "routed") {
      // Held items are reported for visibility, exactly as `propagate
      // reminders` already reports them (L4) — but they route to no
      // project, so there is nothing to reconcile and no identity is
      // minted for them. Minting an id for an item that will never be
      // written anywhere would be state with no reader (GOTCHAS G18's
      // shape, one level early).
      rows.push({
        reminderId: item.id,
        prId: null,
        tag: item.route.kind === "held-unknown-tag" ? item.route.tag : null,
        project: null,
        disposition: item.route.kind, // "held-untagged" | "held-unknown-tag"
        completed: item.completed,
        completedAt: item.completedAt,
      });
      continue;
    }

    const priorEntry = map.entries[item.id] ?? null;
    const disposition = dispositionForRoutedItem(item, priorEntry);

    const assigned = assignId(map, item.id, nowIso);
    map = assigned.map;
    map = recordObservation(map, item.id, { completed: item.completed, completedAt: item.completedAt });

    rows.push({
      reminderId: item.id,
      prId: assigned.id,
      tag: item.route.tag,
      project: item.route.project,
      disposition,
      completed: item.completed,
      completedAt: item.completedAt,
    });
  }

  const byDisposition = Object.fromEntries(DISPOSITIONS.map((d) => [d, 0]));
  for (const row of rows) byDisposition[row.disposition] += 1;
  const summary = { total: rows.length, byDisposition };

  if (!apply) {
    // F2. Nothing past this point may run when apply is false. The test
    // that guards this snapshots the WHOLE reminders state subtree before
    // and after a dry run, across every disposition this function can
    // produce — never trusting the word "dry" in this branch's own name.
    return { ok: true, applied: false, list: result.list, rows, summary, writesToRegister: false };
  }

  await saveIdentityMap(map, stateDir);
  await appendReconcileEvent({ ts: nowIso, list: result.list, rows, summary }, stateDir);

  return { ok: true, applied: true, list: result.list, rows, summary, writesToRegister: false };
}
