/**
 * lib/report/goals-check.mjs: `propagate goals check` (propagate#264), the deterministic half of the goal workflow.
 *
 * `checkGoals` is PURE: parsed GOALS.md files plus the board items already read, in; a verdict out. It reads no file
 * and makes no call, so `day open` can run it on the boards it already holds and a test can feed it literals.
 *
 * It never reports a clause it did not check as a pass (`rule:discernment-checks` §2): what could not be checked is
 * named in `notChecked`, and a blind read (no GOALS.md, no board) is `blind`, which the command turns into exit 2.
 *
 * Clauses (violation.clause):
 *   active-goals     0 active goals, or more than MAX_ACTIVE
 *   goal-undeclared  a Ready / In progress item names a goal no file declares active
 *   item-fields      a Ready / In progress item lacks a Goal, Priority, Model, Size or Done when (and Order, Ready only)
 *   appetite         an active goal records no appetite, or is past it with no Retro line on or after its end
 * Not checked, always: "plan names a goal" (needs #244).
 *
 * Input shapes:
 *   files  = parseGoalsFile results (entries carry id via goalId, status, active, activeSince, appetiteWeeks, retros)
 *   boards = [{number, title, hasGoalField, truncated?: string[], items: [{ref, status: "Ready"|"In progress", fields, doneWhen}]}]
 */

import { goalId } from "./goals.mjs";

export const MAX_ACTIVE = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const NOT_A_GOAL = new Set(["parked", "idea"]);

/** Case-insensitive read of one board field from an item's `fields` map; undefined when unset or blank. */
function field(item, name) {
  for (const [k, v] of Object.entries(item?.fields ?? {})) {
    if (k.toLowerCase() === name.toLowerCase()) return typeof v === "string" && v.trim() === "" ? undefined : v;
  }
  return undefined;
}

const toYmd = (ms) => new Date(ms).toISOString().slice(0, 10);

/** The date an active goal's appetite ends: its start plus N weeks. */
export function appetiteEnd(since, weeks) {
  return toYmd(Date.parse(`${since}T00:00:00Z`) + weeks * 7 * DAY_MS);
}

/**
 * @param {{files: object[], boards: object[], now?: number|Date}} a
 * @returns {{ok: boolean, blind: string|null, violations: {clause: string, subject: string, reason: string}[], notChecked: string[], counts: object}}
 */
export function checkGoals({ files, boards, now = Date.now() }) {
  const violations = [];
  const notChecked = [];
  const counts = { files: (files ?? []).length, goals: 0, active: 0, boards: (boards ?? []).length, itemsChecked: 0 };
  const result = (blind) => ({ ok: !blind && violations.length === 0, blind, violations, notChecked, counts });

  // The floors: a scan over nothing has gone blind, it has not found nothing.
  if (!files || files.length === 0) return result("no GOALS.md found: an empty scan, not a clean one");
  if (!boards || boards.length === 0) return result("no board was read: a blind read, not a clean one");

  const declared = new Map(); // id -> entry
  const active = [];
  for (const f of files) {
    if (f.unread) {
      notChecked.push(`${f.file}: unread (${f.reason})`);
      continue;
    }
    for (const e of f.entries) {
      counts.goals += 1;
      declared.set(goalId(e), e);
      if (e.active) active.push(e);
      else if (e.activeSince && e.status === "unknown") {
        notChecked.push(`goal ${goalId(e)} has an Active since line but its status is unknown (no Done when or Resolved), so it is not counted active`);
      }
    }
  }
  counts.active = active.length;
  const activeIds = new Set(active.map(goalId));

  // Clause: active goals.
  if (active.length === 0) {
    violations.push({ clause: "active-goals", subject: "(none)", reason: "0 active goals: no GOALS.md has written its cycle-1 lines" });
  } else if (active.length > MAX_ACTIVE) {
    violations.push({ clause: "active-goals", subject: active.map(goalId).join(", "), reason: `${active.length} active goals, the limit is ${MAX_ACTIVE}` });
  }

  // Clause: appetite.
  const today = toYmd(now instanceof Date ? now.getTime() : now);
  for (const e of active) {
    const id = goalId(e);
    if (e.appetiteWeeks === null || e.appetiteWeeks === undefined) {
      violations.push({ clause: "appetite", subject: id, reason: `no appetite recorded (Active since ${e.activeSince})` });
      continue;
    }
    const end = appetiteEnd(e.activeSince, e.appetiteWeeks);
    if (end < today) {
      const retro = (e.retros ?? []).some((r) => r.date >= end);
      if (!retro) violations.push({ clause: "appetite", subject: id, reason: `past its appetite (${e.appetiteWeeks} weeks from ${e.activeSince} ended ${end}) with no Retro line dated ${end} or later` });
    }
  }

  // Clauses: what the boards say.
  const undeclared = new Map(); // goal id -> item refs
  for (const b of boards) {
    const items = b.items ?? [];
    if (!b.hasGoalField) {
      notChecked.push(`board ${b.number} ${b.title}: has no Goal field, so its ${items.length} Ready / In progress item(s) are not checked`);
      continue;
    }
    for (const t of b.truncated ?? []) notChecked.push(`${t}: only the first 100 were read and checked, the rest were not (no paging yet)`);
    for (const it of items) {
      counts.itemsChecked += 1;
      const missing = [];
      const g = field(it, "Goal");
      if (g === undefined) missing.push("Goal");
      else if (NOT_A_GOAL.has(String(g).toLowerCase())) missing.push(`Goal (is ${g})`);
      else if (!activeIds.has(String(g))) {
        if (!undeclared.has(String(g))) undeclared.set(String(g), []);
        undeclared.get(String(g)).push(it.ref);
      }
      if (field(it, "Priority") === undefined) missing.push("Priority");
      if (field(it, "Model") === undefined) missing.push("Model");
      if (field(it, "Size") === undefined) missing.push("Size");
      if (!it.doneWhen) missing.push("Done when");
      // In progress work carries no Order by design (finish first): Order is required of Ready items only.
      if (it.status === "Ready" && field(it, "Order") === undefined) missing.push("Order");
      if (missing.length) violations.push({ clause: "item-fields", subject: it.ref, reason: `${it.status} item is missing ${missing.join(", ")}` });
    }
  }
  for (const [g, refs] of undeclared) {
    const how = declared.has(g) ? "is declared but not active" : "is declared in no GOALS.md";
    violations.push({ clause: "goal-undeclared", subject: g, reason: `board item(s) ${refs.join(", ")} use goal ${g}, which ${how}` });
  }

  // Not built yet: reported, never passed.
  notChecked.push("plan names a goal: needs #244");

  return result(null);
}

/** The one line `day open` prints. */
export function goalsSummaryLine(g) {
  if (g.blind) return `goals: not checked: ${g.blind}`;
  const v = g.violations.length;
  const head = `goals: ${g.counts.active} active`;
  const tail = `${g.notChecked.length} not checked (propagate goals check lists them)`;
  return v === 0 ? `${head} · no violations · ${tail}` : `${head} · ${v} violation(s) · ${tail}`;
}
