/**
 * The one writer of a session's association from a hook (propagate#442): dispatch-model.mjs and agent-nudge.mjs both
 * append through here, so the rule lives in one place.
 *
 * NEWEST WINS. A session is associated when it has no association, or when it holds a DIFFERENT item; the same item is
 * a no-op. This replaces "never overwrites" (#318): a session that closes #5 and then starts #9 is working on #9, and
 * the log keeps both (the fold's history is the audit trail; nothing here rewrites a line).
 *
 * DEPENDENCY-FREE ON PURPOSE (node builtins only, no proper-lockfile): hooks run on every tool call, and one O_APPEND
 * line is atomic enough for an append-only log, as in session-guide.mjs.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * The association a session currently holds in the log text: the latest `associate` on its rowKey, unless a
 * `forgotten` came after it. Unparseable lines are skipped, as fold() does.
 * When a session holds several (an `assoc` written under a row key, and `session:<id>` keys), the newest by ts wins.
 */
export function existingAssociation(text, sessionId) {
  const cur = new Map();
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (!ev || typeof ev.event !== "string" || typeof ev.rowKey !== "string") continue;
    if (ev.event === "associate") cur.set(ev.rowKey, ev);
    else if (ev.event === "forgotten") cur.set(ev.rowKey, null);
  }
  let best = null;
  for (const a of cur.values()) {
    if (!a || !(a.row?.sessionId === sessionId || a.rowKey === `session:${sessionId}`)) continue;
    if (!best || String(a.ts) >= String(best.ts)) best = a;
  }
  return best;
}

export function readSnapshot(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * The goal of `ref` from TODAY's `day open` snapshot, or null. A missing, unreadable or not-from-today snapshot, or an
 * item not on it, is null and never a guess.
 */
export function goalFromSnapshot(ref, stateDirPath, now = new Date()) {
  const snap = readSnapshot(path.join(stateDirPath, "day", "items.json"));
  const gen = snap && typeof snap.generatedAt === "string" ? new Date(snap.generatedAt) : null;
  if (!gen || Number.isNaN(gen.getTime()) || ymd(gen) !== ymd(now)) return null;
  const goal = snap.items?.[ref]?.goal;
  return typeof goal === "string" && /^G\d+$/.test(goal) ? goal : null;
}

/**
 * Associate the session with `assoc.item` unless it already holds that item.
 * @param {string} sessionId
 * @param {{item: string, goal?: string|null, source?: "dispatch"|"derived", signal?: string|null, goal_source?: string}} assoc
 * @returns {{written: boolean, why?: string, from?: string|null}}
 */
export function associateSession(sessionId, assoc, stateDirPath, now = new Date()) {
  if (!sessionId) return { written: false, why: "no session id in the payload" };
  const dir = path.join(stateDirPath, "sessions");
  const file = path.join(dir, "assoc.jsonl");
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if (e.code !== "ENOENT") throw e; // unreadable is not "no association": refuse rather than write blind
  }
  const have = existingAssociation(text, sessionId);
  if (have && have.item === assoc.item) return { written: false, why: `already associated with ${have.item}` };
  mkdirSync(dir, { recursive: true });
  const ev = {
    ts: now.toISOString(),
    event: "associate",
    rowKey: `session:${sessionId}`,
    goal: assoc.goal ?? null,
    item: assoc.item,
    source: assoc.source ?? "dispatch",
    signal: assoc.signal ?? null,
    workspace: null,
    project: null,
    row: { sessionId },
  };
  if (assoc.goal_source) ev.goal_source = assoc.goal_source;
  appendFileSync(file, JSON.stringify(ev) + "\n");
  return { written: true, from: have?.item ?? null };
}
