/**
 * The work queue's operations (propagate#150): enqueue, claim, ack, release, unpark, expire, list.
 *
 * Every mutating op has an `*InTx(db, ...)` form that runs inside the CALLER's transaction and opens none (R8: syncKind
 * batches many ops into one BEGIN IMMEDIATE), and a public form that opens the database once (or reuses `opts.db`), runs
 * the op in its own BEGIN IMMEDIATE, and writes its `work_events` row in that same transaction.
 *
 * Rules this file leans on:
 *  - The claim is ONE statement, `UPDATE ... WHERE id = (SELECT ...) RETURNING *`: two processes cannot take the same row.
 *  - A claim carries a random `token`; ack and release are fenced by session AND token, never by the clock (R11). A lease
 *    that ran out but was not re-claimed still accepts its own token: the work is at-least-once and consumers are
 *    idempotent, so the token is the safety fence.
 *  - Every optional value is bound as null, never undefined, and every flag as an integer, never a boolean (Node 22.x).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { openDb, LEASE_MS, PARK_AFTER } from "./db.mjs";
import { fail } from "./errors.mjs";

export const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const nul = (v) => (v === undefined ? null : v);
const plain = (row) => (row ? { ...row } : null);
const defaultNewId = (now) => `w_${now.toString(36)}_${randomBytes(3).toString("hex")}`;

/** Run `fn(db)` in BEGIN IMMEDIATE, committing on return and rolling back on a throw. */
function inTx(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn(db);
    db.exec("COMMIT");
    return out;
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* no transaction left */ }
    throw e;
  }
}

/** Open once per public op, unless the caller hands in a handle; close only what this call opened. */
function withDb(opts, fn) {
  if (opts.db) return inTx(opts.db, fn);
  const { db } = openDb(opts.stateDirPath);
  try { return inTx(db, fn); } finally { db.close(); }
}

function event(db, id, op, at, session, detail) {
  db.prepare("INSERT INTO work_events (id, op, at, session, detail) VALUES (?, ?, ?, ?, ?)")
    .run(id, op, at, nul(session), detail === undefined || detail === null ? null : JSON.stringify(detail));
}

const getItem = (db, id) => plain(db.prepare("SELECT * FROM work_items WHERE id = ?").get(id));

// ---- enqueue -----------------------------------------------------------------------------------------------------

export function enqueueInTx(db, { kind, scope, dedupe_key, payload, ttlMs, newId } = {}, { now = Date.now } = {}) {
  const t = now();
  const id = (newId ?? (() => defaultNewId(t)))();
  const body = typeof payload === "string" ? payload : JSON.stringify(payload ?? {});
  const ttl = Number.isFinite(ttlMs) ? ttlMs : DEFAULT_TTL_MS;
  const row = db.prepare(
    `INSERT INTO work_items (id, kind, scope, dedupe_key, payload, created, expires_at, state)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
     ON CONFLICT(dedupe_key) WHERE state <> 'expired' DO NOTHING RETURNING *`,
  ).get(id, kind, nul(scope), dedupe_key, body, t, t + ttl);
  if (row) {
    event(db, id, "enqueue", t, null, { kind, dedupe_key });
    return { item: plain(row), created: true };
  }
  const existing = plain(db.prepare("SELECT * FROM work_items WHERE dedupe_key = ? AND state <> 'expired'").get(dedupe_key));
  return { item: existing, created: false };
}

export function enqueue(args, opts = {}) {
  return withDb(opts, (db) => enqueueInTx(db, args, opts));
}

// ---- claim -------------------------------------------------------------------------------------------------------

export function claimInTx(db, { kind, session } = {}, { now = Date.now } = {}) {
  const t = now();
  const token = randomUUID();
  const row = db.prepare(
    `UPDATE work_items SET state = 'claimed', session = ?, token = ?, lease_until = ?, claims = claims + 1
     WHERE id = (SELECT id FROM work_items WHERE kind = ? AND expires_at > ?
                 AND (state = 'pending' OR (state = 'claimed' AND lease_until <= ?))
                 ORDER BY created, id LIMIT 1)
     RETURNING *`,
  ).get(nul(session), token, t + LEASE_MS, kind, t, t);
  if (!row) return null;
  event(db, row.id, "claim", t, session, { token, claims: row.claims });
  return plain(row);
}

export function claim(args, opts = {}) {
  return withDb(opts, (db) => claimInTx(db, args, opts));
}

// ---- ack and release: fenced by session + token ------------------------------------------------------------------

/**
 * Why did a fenced UPDATE change nothing? Throws the typed refusal; returns `{already: item}` for a repeated ack (R18).
 * `verb` is "ack" or "release".
 */
function refuseFenced(db, id, session, token, verb, t) {
  const row = getItem(db, id);
  if (!row) fail("WORK_NOT_FOUND", `no work item ${id}`, "propagate work list");
  if (row.state === "acked" && row.token === token && (row.session ?? null) === (session ?? null) && verb === "ack") {
    return { already: row };
  }
  if (row.state === "expired" || (row.state !== "acked" && row.expires_at <= t)) {
    fail("WORK_ITEM_EXPIRED", `work item ${id} expired (its issue closed or its ttl passed)`, "the issue closed; nothing to do");
  }
  // Was this token ever issued to this session for this item? Then it held the claim and lost it: re-claimed, released or
  // acked by another. Otherwise it never held it at all.
  const held = db.prepare("SELECT detail FROM work_events WHERE id = ? AND op = 'claim' AND session IS ?").all(id, nul(session))
    .some((e) => { try { return JSON.parse(e.detail).token === token; } catch { return false; } });
  if (held) {
    fail(
      "WORK_LEASE_EXPIRED",
      `your claim on ${id} is no longer current (the lease expired and the item may have been claimed again)`,
      `your lease expired; the item may have been claimed again: run \`propagate work list --kind ${row.kind}\` before redoing any side effect`,
    );
  }
  fail("WORK_NOT_CLAIMANT", `${session ?? "(no session)"} does not hold a claim on ${id}`, `propagate work list --kind ${row.kind}`);
}

export function ackInTx(db, id, { session, token } = {}, { now = Date.now } = {}) {
  const t = now();
  const row = db.prepare(
    `UPDATE work_items SET state = 'acked' WHERE id = ? AND state = 'claimed' AND session IS ? AND token = ? AND expires_at > ?
     RETURNING *`,
  ).get(id, nul(session), nul(token), t);
  if (!row) {
    const r = refuseFenced(db, id, session, token, "ack", t);
    return { ...r.already, already: true };
  }
  event(db, id, "ack", t, session, null);
  return plain(row);
}

export function ack(id, args, opts = {}) {
  return withDb(opts, (db) => ackInTx(db, id, args, opts));
}

export function releaseInTx(db, id, { session, token, refusal = false, reason } = {}, { now = Date.now } = {}) {
  const t = now();
  const flag = refusal ? 1 : 0;
  const row = db.prepare(
    `UPDATE work_items
     SET state = CASE WHEN ? = 1 AND refusals + 1 >= ? THEN 'parked' ELSE 'pending' END,
         refusals = refusals + ?, session = NULL, token = NULL, lease_until = NULL
     WHERE id = ? AND state = 'claimed' AND session IS ? AND token = ? AND expires_at > ?
     RETURNING *`,
  ).get(flag, PARK_AFTER, flag, id, nul(session), nul(token), t);
  if (!row) refuseFenced(db, id, session, token, "release", t);
  event(db, id, "release", t, session, { refusal: flag === 1, reason: nul(reason), parked: row.state === "parked" });
  return plain(row);
}

export function release(id, args, opts = {}) {
  return withDb(opts, (db) => releaseInTx(db, id, args, opts));
}

// ---- unpark and expire -------------------------------------------------------------------------------------------

export function unparkInTx(db, id, { now = Date.now } = {}) {
  const t = now();
  const row = db.prepare(
    `UPDATE work_items SET state = 'pending', refusals = 0, parked_label_seen = 0 WHERE id = ? AND state = 'parked' RETURNING *`,
  ).get(id);
  if (!row) {
    const cur = getItem(db, id);
    if (!cur) fail("WORK_NOT_FOUND", `no work item ${id}`, "propagate work list");
    fail("WORK_USAGE", `work item ${id} is ${cur.state}, not parked`, "propagate work list --state parked");
  }
  event(db, id, "unpark", t, null, null);
  return plain(row);
}

export function unpark(id, opts = {}) {
  return withDb(opts, (db) => unparkInTx(db, id, opts));
}

export function expireInTx(db, id, { reason } = {}, { now = Date.now } = {}) {
  const t = now();
  const row = db.prepare(
    `UPDATE work_items SET state = 'expired', session = NULL, token = NULL, lease_until = NULL
     WHERE id = ? AND state <> 'expired' RETURNING *`,
  ).get(id);
  if (!row) {
    const cur = getItem(db, id);
    if (!cur) fail("WORK_NOT_FOUND", `no work item ${id}`, "propagate work list");
    return cur; // already expired: no second event
  }
  event(db, id, "expire", t, null, { reason: nul(reason) });
  return plain(row);
}

export function expire(id, args, opts = {}) {
  return withDb(opts, (db) => expireInTx(db, id, args, opts));
}

// ---- list --------------------------------------------------------------------------------------------------------

/** pending for an expired lease; expired for a past-ttl item that was never acked (it can never be claimed, R2). */
function effectiveState(row, t) {
  if (row.state === "acked" || row.state === "expired") return row.state;
  if (row.expires_at <= t) return "expired";
  if (row.state === "claimed" && row.lease_until <= t) return "pending";
  return row.state;
}

/** Reads only. `opts.db` may be an `openDbReadOnly` handle (R7); otherwise `stateDirPath` is opened and closed. */
export function list({ kind, state } = {}, { db, stateDirPath, now = Date.now } = {}) {
  const read = (h) => {
    const t = now();
    const rowsOut = kind
      ? h.prepare("SELECT * FROM work_items WHERE kind = ? ORDER BY created, id").all(kind)
      : h.prepare("SELECT * FROM work_items ORDER BY created, id").all();
    return rowsOut.map((r) => ({ ...r, effective_state: effectiveState(r, t) })).filter((r) => !state || r.effective_state === state);
  };
  if (db) return read(db);
  const opened = openDb(stateDirPath);
  try { return read(opened.db); } finally { opened.db.close(); }
}
