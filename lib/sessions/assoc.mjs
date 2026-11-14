/**
 * The association log (propagate#272): which goal and board item a session serves. Append-only
 * `$STATE/sessions/assoc.jsonl`, in the state directory ONLY (the public boundary: machine-local ids and paths never go
 * on GitHub or in a repo). One line per event: `{ts, event, rowKey, ...}`.
 *
 * Events: `associate` and `forgotten` (the read lane); `approved`, `created`, `create-failed`, `unknown`,
 * `stop-requested`, `stopped`, `removed` (the act lane). The fold accepts ANY event name: an event it does not know is
 * kept in history and never fails the read, so a newer writer cannot break an older reader.
 *
 * The log is the audit trail, so nothing here rewrites or deletes a line.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { acquireLock } from "../core/lock.mjs";
import { stateDir } from "../core/paths.mjs";

export const assocPath = (dir = stateDir()) => path.join(dir, "sessions", "assoc.jsonl");

/**
 * Append one event, under a lock. Throws on failure, so a caller about to take a side effect can refuse BEFORE it
 * (the ordering the plan requires: the intent row is written first).
 * @param {{event: string, rowKey: string}} event any other fields are kept
 * @param {{stateDirPath?: string, now?: () => number}} [opts]
 * @returns {Promise<object>} the stored event
 */
export async function append(event, { stateDirPath = stateDir(), now = Date.now } = {}) {
  if (!event || typeof event.event !== "string" || typeof event.rowKey !== "string") {
    throw new Error("assoc event needs string `event` and `rowKey`");
  }
  const file = assocPath(stateDirPath);
  mkdirSync(path.dirname(file), { recursive: true });
  if (!existsSync(file)) writeFileSync(file, "", { flag: "a" });
  const release = await acquireLock(file);
  if (!release) throw new Error(`could not lock ${file}: another writer holds it`);
  try {
    const stored = { ts: new Date(now()).toISOString(), ...event };
    appendFileSync(file, JSON.stringify(stored) + "\n");
    return stored;
  } finally {
    await release();
  }
}

/**
 * Fold the log.
 * @returns {{
 *   byKey: Map<string, {assoc: object|null, last: object, history: object[]}>,
 *   corrupt: number
 * }} `assoc` is the latest `associate` not followed by a `forgotten` (null otherwise); `last` is the latest event of ANY
 *   kind (the act lane reads its state from it); `corrupt` counts unparseable lines, reported and never fatal.
 *   A missing file is an empty fold. An unreadable one throws, so the caller can say so (never an empty view).
 */
export function fold(stateDirPath = stateDir()) {
  const file = assocPath(stateDirPath);
  const byKey = new Map();
  let corrupt = 0;
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      corrupt++;
      continue;
    }
    if (!ev || typeof ev.event !== "string" || typeof ev.rowKey !== "string") {
      corrupt++;
      continue;
    }
    const cur = byKey.get(ev.rowKey) ?? { assoc: null, last: ev, history: [] };
    cur.history.push(ev);
    cur.last = ev;
    if (ev.event === "associate") cur.assoc = ev;
    else if (ev.event === "forgotten") cur.assoc = null;
    byKey.set(ev.rowKey, cur);
  }
  return { byKey, corrupt };
}
