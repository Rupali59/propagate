/**
 * The one join (propagate#272): live rows (claude agents --json) joined to the association fold and to the folder
 * resolver. Nothing here persists anything; the live half is derived on every call.
 *
 * An association whose session is absent from the live list reads `ended (not in claude agents)`; it is never dropped.
 */
import path from "node:path";

import { folderOf } from "./resolve.mjs";

export const ENDED_LABEL = "ended (not in claude agents)";
/** The text view lists at most this many ended associations (newest first); `--json` lists them all. */
export const ENDED_TEXT_CAP = 10;

const placeOf = (folder) => (folder.unplaced ? "unplaced" : folder.workspace);

/**
 * @param {{rows: object[], readAt: string}} live from readLive()
 * @param {{byKey: Map<string, object>, corrupt: number}} fold from assoc.fold()
 * @param {object} ctx resolve.loadContext()
 * @returns {{readAt: string, sessions: object[], ended: object[], counts: object, corrupt: number}}
 */
export function buildView(live, fold, ctx) {
  const liveKeys = new Set(live.rows.map((r) => r.key));
  const sessions = live.rows.map((row) => {
    const entry = fold.byKey.get(row.key);
    const folder = folderOf(row.cwd, ctx);
    return { ...row, folder, association: entry?.assoc ?? null, last: entry?.last ?? null };
  });
  const ended = [];
  for (const [rowKey, entry] of fold.byKey) {
    if (!entry.assoc || liveKeys.has(rowKey)) continue;
    ended.push({ rowKey, state: ENDED_LABEL, association: entry.assoc, last: entry.last });
  }
  ended.sort((a, b) => String(b.association.ts).localeCompare(String(a.association.ts)));
  // A launch whose outcome is not a known session (create.mjs keys it `launch:<ts>:<rand>`): its last event is
  // "approved" (crashed before the outcome was written) or "unknown" (a session may have started, no id joined).
  // The CEO review's state machine says such a launch is SHOWN, never hidden. It resolves once a later association
  // for the same item exists: someone found the session and ran `assoc`.
  const unresolved = [];
  for (const [rowKey, entry] of fold.byKey) {
    if (!rowKey.startsWith("launch:")) continue;
    const ev = entry.last;
    if (!ev || (ev.event !== "approved" && ev.event !== "unknown")) continue;
    const found = [...fold.byKey.values()].some((e) => e.assoc && e.assoc.item === ev.item && String(e.assoc.ts) > String(ev.ts));
    if (!found) unresolved.push({ rowKey, event: ev.event, name: ev.name ?? null, item: ev.item ?? null, cwd: ev.cwd ?? null, ts: ev.ts, reason: ev.reason ?? null });
  }
  const counts = {
    live: sessions.length,
    unassociated: sessions.filter((s) => !s.association).length,
    unplaced: sessions.filter((s) => s.folder.unplaced).length,
    unknown: sessions.filter((s) => s.last?.event === "unknown").length + unresolved.length,
    ended: ended.length,
  };
  return { readAt: live.readAt, sessions, ended, unresolved, counts, corrupt: fold.corrupt };
}

/** `5m`, `3h`, `2d`; `-` when there is no start time. */
export function since(startedAt, now) {
  if (typeof startedAt !== "number") return "-";
  const s = Math.max(0, Math.round((now - startedAt) / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

const shortId = (s) => s.id || s.sessionId.slice(0, 8);

export function projectOf(s) {
  if (s.folder.unplaced) return path.basename(s.cwd) || s.cwd;
  return s.folder.all ? "hub (all)" : s.folder.project;
}

function table(rows) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  return rows.map((r) => "  " + r.map((c, i) => String(c).padEnd(widths[i])).join("  ").trimEnd());
}

/**
 * The text table: grouped by workspace; columns project, goal, item, state, since, then id and name (the id is what
 * `assoc` and `show` take). Unassociated rows say `unassociated` in the item column and add one closing hint.
 * @returns {string[]} lines
 */
export function renderView(view, { now = Date.now() } = {}) {
  const out = [];
  if (view.sessions.length === 0) out.push(`0 live sessions (claude agents read ${view.readAt})`);
  const groups = new Map();
  for (const s of view.sessions) {
    const k = placeOf(s.folder);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  for (const [name, list] of [...groups].sort(([a], [b]) => (a === "unplaced") - (b === "unplaced") || a.localeCompare(b))) {
    out.push(name);
    const rows = [["project", "goal", "item", "state", "since", "id", "name"]];
    for (const s of list) {
      const a = s.association;
      rows.push([projectOf(s), a?.goal ?? "-", a ? (a.item ?? "-") : "unassociated", s.state, since(s.startedAt, now), shortId(s), s.name || "-"]);
    }
    out.push(...table(rows), "");
  }
  if (view.unresolved?.length) {
    out.push("launches with no known session (a session may have started; never retried)");
    for (const u of view.unresolved) out.push(`  ${u.ts}  ${u.name ?? "(unnamed)"}  ${u.item ?? "-"}  ${u.event}${u.reason ? ` (${u.reason})` : ""}  in ${u.cwd ?? "?"}`);
    out.push("  find it: claude agents --json, then propagate sessions assoc <id> --goal G<n> --item owner/repo#n");
    out.push("");
  }
  if (view.ended.length) {
    out.push("ended associations (kept as history)");
    const rows = [["project", "goal", "item", "state", "id", "name"]];
    for (const e of view.ended.slice(0, ENDED_TEXT_CAP)) {
      const r = e.association.row ?? {};
      rows.push([e.association.project ?? "-", e.association.goal ?? "-", e.association.item ?? "-", e.state, r.id || String(r.sessionId ?? "").slice(0, 8) || "-", r.name || "-"]);
    }
    out.push(...table(rows));
    if (view.ended.length > ENDED_TEXT_CAP) out.push(`  +${view.ended.length - ENDED_TEXT_CAP} older ended: propagate sessions --json`);
    out.push("");
  }
  if (view.counts.unassociated > 0) out.push("assoc: propagate sessions assoc <id> --from owner/repo#n");
  if (view.corrupt > 0) out.push(`warning: ${view.corrupt} unreadable line(s) in assoc.jsonl were skipped`);
  while (out.length && out[out.length - 1] === "") out.pop();
  return out;
}
