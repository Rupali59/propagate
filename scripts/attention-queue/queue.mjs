/**
 * The attention queue's core (propagate#445): an append-only log of sessions that need the user, read oldest first.
 *
 * `$STATE/attention/queue.jsonl` holds two kinds of line, and no line is ever edited:
 *   {event:"queued",  ts, session_id, tty, cwd, message, notification_type}
 *   {event:"handled", ts, session_id, reason}        reason: focused | stale | cleared
 *
 * A session is PENDING from its `queued` until its next `handled`. A second `queued` for a session that is already
 * pending changes nothing (the first notification is the one that has waited longest). After `handled`, a new
 * notification queues the session again at the back.
 *
 * DEPENDENCY-FREE (node builtins only): the hook imports this on every notification.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

export function queueFile(stateDirPath) {
  return path.join(stateDirPath, "attention", "queue.jsonl");
}

/** Both sides of a tty comparison are normalised: `ps` prints `ttys001`, AppleScript prints `/dev/ttys001`. */
export function normTty(t) {
  const s = String(t ?? "").trim().replace(/^\/dev\//, "");
  return s && s !== "??" && s !== "?" && s !== "-" ? s : "";
}

function appendLine(file, ev) {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(ev) + "\n");
}

/** Queue a session. @returns {boolean} false when it was already pending (nothing written). */
export function append(file, entry, now = new Date()) {
  if (!entry?.session_id) return false;
  if (pending(readEvents(file)).some((e) => e.session_id === entry.session_id)) return false;
  appendLine(file, {
    event: "queued",
    ts: now.toISOString(),
    session_id: entry.session_id,
    tty: normTty(entry.tty),
    cwd: entry.cwd ?? "",
    message: entry.message ?? "",
    notification_type: entry.notification_type ?? "",
  });
  return true;
}

export function markHandled(file, sessionId, reason, now = new Date()) {
  appendLine(file, { event: "handled", ts: now.toISOString(), session_id: sessionId, reason });
}

/** Every parseable line, in file order; a missing file is an empty queue and a bad line is skipped. */
export function readEvents(file) {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev && typeof ev.session_id === "string" && (ev.event === "queued" || ev.event === "handled")) out.push(ev);
    } catch {
      /* skip a torn line */
    }
  }
  return out;
}

/** The pending entries, oldest first. */
export function pending(events) {
  const open = new Map();
  for (const ev of events) {
    if (ev.event === "queued") {
      if (!open.has(ev.session_id)) open.set(ev.session_id, ev);
    } else open.delete(ev.session_id);
  }
  return [...open.values()].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
}

/**
 * The first pending entry whose tty is a live terminal, oldest first, plus the entries passed over.
 * @param {object[]} entries pending, oldest first
 * @param {Iterable<string>} liveTtys
 * @returns {{entry: object|null, skipped: object[]}}
 */
export function pop(entries, liveTtys) {
  const live = new Set([...liveTtys].map(normTty));
  const skipped = [];
  for (const e of entries) {
    if (e.tty && live.has(normTty(e.tty))) return { entry: e, skipped };
    skipped.push(e);
  }
  return { entry: null, skipped };
}
