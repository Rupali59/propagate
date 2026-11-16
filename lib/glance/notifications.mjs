/**
 * notifications.mjs — which ids to tell a person about, and what the notification says (propagate#296, design §5).
 *
 * THE RULE. Notify on ADDITIONS ONLY, keyed on a stable id (`signal:<stable subject>`: `edge:<edge_id>`,
 * `doctor:<section>:<check_id>`, `job:<label>`, `work:<id>`; never a content hash, never a number):
 *   - an id present on the previous run is a CONTINUATION: silent, however much its bytes or its numbers churn;
 *   - an id that left and comes back within HOLD_MS (24 h) is a RE-ENTRY: silent;
 *   - anything else is an ADDITION: notified once;
 *   - removal never notifies;
 *   - the first run with no record of a channel SEEDS it silently, so an upgrade does not replay every open finding.
 *
 * WHY NOT THE CONTENT TRIPLE (supersedes lib/report/monitor.mjs's 2026-08-17 key). `(edge_id, source_content,
 * downstream_content)` suppresses only when NOTHING changed, and editing a declared file is a change, so every edit
 * re-notified an edge already known: measured 2026-08-29, 76% of notifications were the same edge again; measured
 * 2026-11-16, one edge 92 times in 300 rows and every 30-minute run notifying. The tests pin this: a mutation that
 * puts content back into the key turns "a changing edge notifies once" red.
 *
 * ACKS. An acked id is still RECORDED as present (so acking does not turn its later return into a fresh addition
 * sooner than the hold allows), but its addition is OWED rather than sent: when the ack stops applying (a snooze
 * that ran out) and the id is still present, the owed notification goes then. An untimed ack lasts the episode, so its
 * owed notification is only ever sent by a new episode, which is an addition anyway.
 *
 * FAILS TOWARD TELLING. An absent store seeds (silence is right: nothing new happened, the tool was upgraded). A
 * CORRUPT store is not an upgrade: every present id is treated as new and notified once (the tell-again direction),
 * and the store is rewritten. Neither throws.
 *
 *   $STATE/notify-state.json  { schema_version: 1, channels: { "<channel>": { seeded_at, last_run,
 *                                ids: { "<id>": { present, since, last_seen, owed } } } } }
 *
 * PURE except readNotifyState / writeNotifyState.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

import { renderLines } from "./render.mjs";

export const HOLD_MS = 24 * 3600000;
export const NOTIFY_STATE_VERSION = 1;
export const notifyStatePath = (dir) => path.join(dir, "notify-state.json");

/** @returns {{status: "absent"|"corrupt"|"newer"|"ok", state: object|null, reason?: string}} never throws */
export function readNotifyState(dir) {
  let text;
  try {
    text = readFileSync(notifyStatePath(dir), "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return { status: "absent", state: null };
    return { status: "corrupt", state: null, reason: e.code ?? e.message };
  }
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return { status: "corrupt", state: null, reason: "not valid JSON" };
  }
  if (!j || typeof j !== "object" || typeof j.channels !== "object" || j.channels === null) return { status: "corrupt", state: null, reason: "no channels object" };
  if (typeof j.schema_version === "number" && j.schema_version > NOTIFY_STATE_VERSION) return { status: "newer", state: null, reason: "notify-state format newer than this reader" };
  return { status: "ok", state: j };
}

/** Atomic write (temp file, rename). Throws; the monitor catches and logs it. */
export function writeNotifyState(state, dir) {
  const target = notifyStatePath(dir);
  const tmp = `${target}.${process.pid}.tmp`;
  mkdirSync(path.dirname(target), { recursive: true });
  try {
    writeFileSync(tmp, JSON.stringify({ ...state, schema_version: NOTIFY_STATE_VERSION }, null, 2) + "\n");
    renameSync(tmp, target);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return target;
}

/**
 * Decide one channel's notifications for this run. PURE.
 *
 * @param {{read: {status: string, state: object|null}, channel: string, ids: string[], now: number, holdMs?: number,
 *          acked?: (id: string, since: string) => boolean}} a
 *   read  - readNotifyState's result (the whole store); `acked(id, since)` says whether an ack holds for this episode
 * @returns {{notify: string[], continuing: string[], reentered: string[], owed: string[], seeded: boolean,
 *            corrupt: boolean, next: object}} `next` is this channel's new record; mergeChannel puts it in the store
 */
export function decideChannel({ read, channel, ids, now, holdMs = HOLD_MS, acked = () => false }) {
  const nowIso = new Date(now).toISOString();
  const corrupt = read?.status === "corrupt" || read?.status === "newer";
  const prior = read?.status === "ok" ? read.state?.channels?.[channel] ?? null : null;
  // Seed: no record of THIS channel and nothing wrong with the store. A corrupt store never seeds.
  const seeded = !corrupt && prior === null;
  const prev = prior?.ids ?? {};
  const out = { notify: [], continuing: [], reentered: [], owed: [], seeded, corrupt };
  const nextIds = {};
  const current = new Set(ids);
  for (const id of current) {
    const p = prev[id];
    let since;
    let owed;
    if (p && p.present) {
      since = p.since;
      owed = p.owed === true;
      out.continuing.push(id);
    } else if (p && now - Date.parse(p.last_seen) <= holdMs) {
      since = p.since;
      owed = p.owed === true;
      out.reentered.push(id);
    } else {
      since = nowIso;
      owed = !seeded; // an addition is owed a notification; a seeded id is not
    }
    if (owed) {
      if (acked(id, since)) out.owed.push(id);
      else {
        out.notify.push(id);
        owed = false;
      }
    }
    nextIds[id] = { present: true, since, last_seen: nowIso, owed };
  }
  // Ids that left: kept, absent, until the hold runs out. Past it a return is an addition, so the record is dropped
  // and the store stays bounded by "present now, or seen within 24 h".
  for (const [id, p] of Object.entries(prev)) {
    if (current.has(id)) continue;
    const seen = Date.parse(p?.last_seen ?? "");
    if (Number.isNaN(seen) || now - seen > holdMs) continue;
    nextIds[id] = { ...p, present: false };
  }
  return { ...out, next: { seeded_at: prior?.seeded_at ?? nowIso, last_run: nowIso, ids: nextIds } };
}

/** The store with one channel replaced. A corrupt or newer store is started over. */
export function mergeChannel(read, channel, next) {
  const base = read?.status === "ok" && read.state ? read.state : { channels: {} };
  return { ...base, channels: { ...(base.channels ?? {}), [channel]: next } };
}

// ── what the glance channel watches, and what it says ──────────────────────

/**
 * The glance items that may notify: needs-you and broken (an unknown counts as broken, by the glance contract), minus
 * the `edges` signal, because the monitor's own edge channel already notifies per edge and a second, aggregate
 * notification for the same edges would be the duplicate this change exists to remove.
 */
export function glanceCandidates(glance) {
  return (glance?.items ?? []).filter((i) => (i.verdict === "needs_you" || i.verdict === "broken") && i.signal !== "edges");
}

const VERDICT_WORD = { needs_you: "Needs you", broken: "Broken" };
const wordOf = (it) => (it.flag === "unknown" ? "Unknown" : VERDICT_WORD[it.verdict] ?? "Broken");

/**
 * One grouped notification for this run's glance additions. Title: the verdict word and the item ("Needs you: work
 * ..."), or the counts when there are several ("propagate: 2 need you, 1 broken"). Body: each item's fix, at most 3
 * lines. `route` is a UI route from the fixed vocabulary (lib/report/notify.mjs uiRoute), never item text.
 */
export function formatGlanceNotification(items) {
  const needs = items.filter((i) => i.verdict === "needs_you");
  const broken = items.filter((i) => i.verdict !== "needs_you");
  const ordered = [...needs, ...broken];
  const fixOf = (i) => i.fix?.command ?? i.fix?.text ?? "propagate glance";
  if (ordered.length === 1) {
    const it = ordered[0];
    return { title: `${wordOf(it)}: ${it.subject}: ${it.what}`.slice(0, 120), body: fixOf(it), route: { kind: "glance", id: it.id } };
  }
  const parts = [];
  if (needs.length) parts.push(`${needs.length} ${needs.length === 1 ? "needs" : "need"} you`);
  if (broken.length) parts.push(`${broken.length} broken`);
  // One line per distinct (subject, fix): five doctor checks with one fix are one line, "doctor (5): ...".
  const byLine = new Map();
  for (const i of ordered) {
    const k = `${i.subject}\u0000${fixOf(i)}`;
    byLine.set(k, (byLine.get(k) ?? 0) + 1);
  }
  const all = [...byLine].map(([k, n]) => {
    const [subject, fix] = k.split("\u0000");
    return `${subject}${n > 1 ? ` (${n})` : ""}: ${fix}`;
  });
  const lines = all.slice(0, 3);
  if (all.length > 3) lines.push(`+${all.length - 3} more`);
  return { title: `propagate: ${parts.join(", ")}`, body: lines.join("\n"), route: { kind: "glance", id: null } };
}

/**
 * The digest notification: its body is the glance's VERDICT LINE (the first line `propagate glance` prints: the top
 * problem source, or "all clear"), never the digest's timestamp heading. A glance that cannot be read says so.
 * @param {{state: string, glance?: object, stale?: boolean, ageMs?: number, reason?: string}} gs readGlanceState()
 */
export function digestNotification(gs) {
  const title = "propagate digest";
  const route = { kind: "glance", id: null };
  if (!gs || gs.state === "absent") return { title, body: "glance: not computed yet; run propagate glance", route };
  if (gs.state !== "ok") return { title, body: `glance unavailable (${gs.reason ?? gs.state}): run propagate glance`, route };
  const first = (renderLines(gs.glance, { color: false })[0] ?? "").replace(/\s+/g, " ").trim();
  if (gs.stale) return { title, body: `glance is stale; run propagate glance (last: ${first})`.slice(0, 200), route };
  return { title, body: first.slice(0, 200), route };
}
