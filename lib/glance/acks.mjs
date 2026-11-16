/**
 * acks.mjs — acknowledge and snooze for glance items and notification ids (propagate#296). Node builtins only.
 *
 *   $STATE/glance-acks.json   { schema_version: 1, acks: { "<id>": { at: "<ISO>", until: "<ISO>" | null } } }
 *
 * TWO KINDS, ONE RECORD.
 *   - ACK (`until: null`) holds for the item's CURRENT episode: it applies while the item's `since` is at or before
 *     the ack's `at`. When the item clears and later comes back, its `since` is newer than the ack, so the ack no
 *     longer applies and the return is shown and notified like any other. An ack never has to be cleaned up by a
 *     writer that watched the item leave.
 *   - SNOOZE (`until` set) holds until that instant, whatever the episode. After it, the item is shown again, and a
 *     notification it was owed is sent (lib/glance/notifications.mjs keeps the owed flag).
 *
 * WHAT AN ACK CHANGES: the item is SHOWN as acked (glance.json `ack`, the web view, the terminal `[ACKED]` line) and
 * is NOT NOTIFIED. It does not change the item's verdict, the glance's verdict or `needs_you_ids`: an ack is "I know",
 * not "it is fixed", and a glance that turned green because someone clicked would be the confident wrong answer this
 * tool exists to avoid.
 *
 * FAILS OPEN. A missing file is no acks; a corrupt one is ALSO no acks (and `readAcksState` says which), so the cost
 * of losing it is being told again, never silence.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

export const ACKS_VERSION = 1;
/** Untimed acks older than this are pruned on the next write: an episode that long is not still being watched. */
export const ACK_RETENTION_MS = 90 * 86400000;
/** The shape every id has: `signal:<stable subject>` or a bare signal name. No spaces, no quotes, no shell metacharacters. */
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9:._#~@/+-]{0,199}$/;

export const acksPath = (dir) => path.join(dir, "glance-acks.json");

/** @returns {{status: "absent"|"corrupt"|"ok", acks: Map<string, {at: string, until: string|null}>, reason?: string}} */
export function readAcksState(dir) {
  let text;
  try {
    text = readFileSync(acksPath(dir), "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return { status: "absent", acks: new Map() };
    return { status: "corrupt", acks: new Map(), reason: e.code ?? e.message };
  }
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return { status: "corrupt", acks: new Map(), reason: "not valid JSON" };
  }
  if (!j || typeof j !== "object" || typeof j.acks !== "object" || j.acks === null) return { status: "corrupt", acks: new Map(), reason: "no acks object" };
  const acks = new Map();
  for (const [id, a] of Object.entries(j.acks)) {
    if (!a || typeof a.at !== "string" || Number.isNaN(Date.parse(a.at))) continue;
    const until = typeof a.until === "string" && !Number.isNaN(Date.parse(a.until)) ? a.until : null;
    acks.set(id, { at: a.at, until });
  }
  return { status: "ok", acks };
}

export const readAcks = (dir) => readAcksState(dir).acks;

/**
 * Does this ack hold for an item whose current episode began at `since`?
 * @param {{at: string, until: string|null}|undefined} ack
 * @param {string|null|undefined} since the item's episode start (ISO); absent means "this episode"
 * @param {number} now
 */
export function ackApplies(ack, since, now) {
  if (!ack) return false;
  if (ack.until) return now < Date.parse(ack.until);
  const s = Date.parse(since ?? "");
  return Number.isNaN(s) || s <= Date.parse(ack.at);
}

/** The ack record to attach to an item, or null. */
export function ackFor(acks, id, since, now) {
  const a = acks?.get?.(id);
  return a && ackApplies(a, since, now) ? { at: a.at, until: a.until } : null;
}

/**
 * `--until` values: an ISO date (`2026-11-20`, the START of that UTC day is too early to be useful, so a bare date
 * means the END of it), an ISO date-time, or a duration `<n>h` / `<n>d` from now. Anything else throws, naming it.
 */
export function parseUntil(s, now = Date.now()) {
  const v = String(s ?? "").trim();
  const rel = /^(\d{1,4})([hd])$/.exec(v);
  if (rel) return now + Number(rel[1]) * (rel[2] === "h" ? 3600000 : 86400000);
  if (/^\d{4}-\d\d-\d\d$/.test(v)) {
    const t = Date.parse(`${v}T23:59:59Z`);
    if (!Number.isNaN(t)) return t;
  }
  if (/^\d{4}-\d\d-\d\dT/.test(v)) {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t;
  }
  throw new Error(`--until wants a date (2026-11-20), a date-time (2026-11-20T09:00:00Z) or a duration (24h, 3d); got ${JSON.stringify(v)}`);
}

function writeAll(dir, acks) {
  const target = acksPath(dir);
  const tmp = `${target}.${process.pid}.tmp`;
  mkdirSync(path.dirname(target), { recursive: true });
  const obj = { schema_version: ACKS_VERSION, acks: Object.fromEntries([...acks].sort(([a], [b]) => a.localeCompare(b))) };
  try {
    writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
    renameSync(tmp, target);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return target;
}

function prune(acks, now) {
  for (const [id, a] of acks) {
    if (a.until ? Date.parse(a.until) <= now : now - Date.parse(a.at) > ACK_RETENTION_MS) acks.delete(id);
  }
}

/** Refuses an id that is not id-shaped, before anything is written. */
export function checkIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) throw new Error("no ids given");
  if (ids.length > 500) throw new Error(`${ids.length} ids in one call; at most 500`);
  const bad = ids.filter((id) => typeof id !== "string" || !ID_RE.test(id));
  if (bad.length) throw new Error(`not an item id: ${bad.slice(0, 3).map((x) => JSON.stringify(x)).join(", ")}`);
}

/**
 * Ack (until null) or snooze (until a ms epoch) each id. A corrupt file is REPLACED, and the caller is told so.
 * @returns {{ids: string[], until: string|null, file: string, replacedCorrupt: boolean}}
 */
export function setAcks(dir, ids, { until = null, now = Date.now() } = {}) {
  checkIds(ids);
  if (until !== null && !(Number.isFinite(until) && until > now)) throw new Error("--until must be in the future");
  const st = readAcksState(dir);
  const acks = st.acks;
  prune(acks, now);
  const rec = { at: new Date(now).toISOString(), until: until === null ? null : new Date(until).toISOString() };
  for (const id of ids) acks.set(id, rec);
  return { ids, until: rec.until, file: writeAll(dir, acks), replacedCorrupt: st.status === "corrupt" };
}

/** Remove each id's ack. Ids with none are reported, not refused. */
export function clearAcks(dir, ids, { now = Date.now() } = {}) {
  checkIds(ids);
  const st = readAcksState(dir);
  const acks = st.acks;
  const removed = ids.filter((id) => acks.delete(id));
  prune(acks, now);
  return { removed, missing: ids.filter((id) => !removed.includes(id)), file: writeAll(dir, acks) };
}
