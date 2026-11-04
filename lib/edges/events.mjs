/**
 * events.mjs — the v2 verification store.
 *
 * Foundation only (per the plan at
 * ~/.claude/plans/okay-i-dont-think-logical-haven.md §2/§2b/§4). NOT wired
 * into watcher.mjs, cli.mjs, or digest.mjs — v1 keeps running untouched.
 *
 * A record here is a VERIFICATION, not a drift. It asserts "these two blobs
 * (source, downstream) are consistent with each other," pinned by content on
 * both sides so the fact is ref-independent: merging two stores is a set
 * union that cannot conflict, and a verification made on one branch applies
 * automatically after merge because the same blob pair arrives with it.
 *
 * There is no fold. v1's `readLedgerWithStats` fold (docs/DATA_MODEL.md §4)
 * copied exactly one field (`status`) from a Transition onto an Event and
 * dropped everything else — 556 rows of hand-written `wontfix_reason`
 * became permanently unreadable. Events here are immutable, independent
 * facts; every field written is a field a reader gets back. A line this
 * reader cannot parse is COUNTED (`malformed`), never silently skipped
 * (GOTCHAS G1: a check that cannot fail is worse than no check; N1: an
 * `unknownTypes` count computed and thrown away made a real row invisible
 * for two months).
 *
 * Store layout ($STATE_DIR/events/, sharded by month):
 *
 *   ~/.propagate/events/2026-08.jsonl
 *   ~/.propagate/events/2026-09.jsonl
 *
 * Respects PROPAGATE_STATE_DIR (lib/config.mjs's STATE_DIR). When unset, the
 * default is `~/.propagate`, deliberately NOT `SKILL_DIR` (the plugin
 * install directory) — a marketplace update destroys that directory (N13/
 * N14), and this store, unlike v1's state.json/lock/heartbeat, is durable
 * history that must survive one. See plan §2b's literal example path.
 *
 * Concurrency: appends are serialized per shard file with the same
 * lock-then-append discipline as `appendRowWithId` in lib/ledger.mjs
 * (`acquireLock` from lib/lock.mjs, high retry budget for write bursts).
 * ULIDs mean no read-then-mint race exists for the id itself — the lock
 * exists solely so concurrent writers never interleave partial JSON lines
 * onto the same file.
 */

import { appendFile, readFile, readdir, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { acquireLock } from "../core/lock.mjs";
import { STATE_DIR } from "../core/config.mjs";
import { stateDir } from "../core/paths.mjs";

/**
 * Default store root when PROPAGATE_STATE_DIR is unset. Deliberately NOT
 * SKILL_DIR (see module doc) — this is the corrected default the plan calls
 * out, distinct from v1's scheduling-cache state which still defaults into
 * the plugin directory.
 */
const DEFAULT_EVENTS_ROOT = stateDir();

/** $STATE_DIR/events (or ~/.propagate/events when PROPAGATE_STATE_DIR is unset). */
export const EVENTS_DIR = path.join(STATE_DIR || DEFAULT_EVENTS_ROOT, "events");

// ---------------------------------------------------------------------------
// ULID — Crockford base32, 48-bit time + 80-bit randomness, dependency-free.
// ---------------------------------------------------------------------------

/** Crockford's Base32 alphabet: excludes I, L, O, U to avoid transcription errors. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Encode a non-negative integer into `len` base32 characters, zero-padded. */
function encodeTime(ms, len) {
  let n = ms;
  let out = "";
  for (let i = 0; i < len; i++) {
    out = CROCKFORD[n % 32] + out;
    n = Math.floor(n / 32);
  }
  return out;
}

/** `len` random base32 characters (5 bits each) via crypto.randomInt. */
function encodeRandom(len) {
  let out = "";
  for (let i = 0; i < len; i++) {
    out += CROCKFORD[crypto.randomInt(0, 32)];
  }
  return out;
}

/**
 * Mint a ULID: 10 chars of millisecond timestamp (50 bits, covers 48) +
 * 16 chars of randomness (80 bits). Lexicographic sort order matches
 * creation order across different milliseconds — this is NOT the monotonic
 * ULID variant, so two ids minted within the same millisecond sort by their
 * random suffix, not by call order (acceptable: the plan's own test only
 * requires that they DIFFER, not that they order).
 *
 * Why not v1's `String(max+1).padStart(3,"0")` (lib/ledger.mjs:250): that
 * scheme mints from the max id already on disk with no lock across the
 * read-write gap for two of its four call sites (N3) — two branches
 * appending from the same max both produce "256", a live collision. A ULID
 * needs no read of prior state at all.
 */
export function mintEventId() {
  return encodeTime(Date.now(), 10) + encodeRandom(16);
}

// ---------------------------------------------------------------------------
// edge_id — stable sha8 of (node_id, downstream, why).
// ---------------------------------------------------------------------------

/**
 * Stable, deterministic 8-hex-char id for a declared coupling. Same three
 * inputs always produce the same id; any one input differing changes it.
 * NUL-joined so `("a","b","c")` cannot collide with `("ab","","c")` etc.
 */
export function edgeId(nodeId, downstreamPath, why) {
  return crypto
    .createHash("sha256")
    .update(`${nodeId}\u0000${downstreamPath}\u0000${why}`)
    .digest("hex")
    .slice(0, 8);
}

// ---------------------------------------------------------------------------
// Dispositions (plan §4) — validated strictly.
// ---------------------------------------------------------------------------

export const DISPOSITIONS = Object.freeze([
  "propagated",
  "no-change-needed",
  "source-corrected",
  "both-reconciled",
  "decoupled",
  "deferred",
  "wontfix",
  "baselined",
  "rekeyed",
]);

/**
 * The dispositions a person may ASSERT with `verify`: every disposition except
 * `rekeyed`.
 *
 * `rekeyed` is a forward link written by `propagate rekey` ("this edge continues
 * <from_edge_id>", carrying the old edge's last pinned pair), not a judgement
 * that a source and downstream agree. It is in DISPOSITIONS so `appendEvent`
 * validates it, and it is excluded HERE so nothing that offers or accepts a
 * verdict can name it. `allowedDispositions` (lib/edges/disposition.mjs) and
 * `verify --disposition` (cli.mjs) both iterate this one constant, so the two
 * cannot disagree about it.
 */
export const VERIFY_DISPOSITIONS = Object.freeze(DISPOSITIONS.filter((d) => d !== "rekeyed"));

const VALID_DISPOSITIONS = new Set(DISPOSITIONS);

/**
 * Validate one event before it is written. Every thrown error names the
 * event id and the offending field (GOTCHAS G2: absence must be
 * attributable; an error that doesn't say where is one nobody can act on).
 *
 * Rules (plan §4, "DISPOSITIONS ... validate strictly"):
 *  - unknown disposition -> throw
 *  - "wontfix" without `reason` -> throw (SPEC §5; v1's 556 unexplained
 *    wontfix_reason rows are why)
 *  - "baselined" without a `reason` naming its evidence -> throw. A baseline
 *    is a claim, not a verification, and must never be indistinguishable
 *    from one.
 *  - missing `source_content` or `downstream_content` on any disposition
 *    that pins a pair -> throw. Every disposition except "deferred" and
 *    "decoupled" pins.
 *  - "decoupled" removes the edge from its sidecar, so nothing ever reads its
 *    pin; content is recorded when resolvable and NOT required. An UNMATCHED
 *    glob has no downstream, so requiring it made that removal unrecordable
 *    (N119: the sidecar edit landed, the event write threw).
 *  - "rekeyed" without `from_edge_id` or without `reason` -> throw, and a
 *    `from_edge_id` equal to its own `edge_id` -> throw. It pins (it carries the
 *    old edge's last pair), so the content checks below apply to it unchanged.
 *  - "deferred" MUST NOT pin (it does not re-pin; it records that someone
 *    looked) -> throw if either content field is present.
 */
function validateEvent(event, eventId) {
  const disposition = event?.disposition;

  if (!VALID_DISPOSITIONS.has(disposition)) {
    throw new Error(
      `appendEvent: event ${eventId} — unknown disposition ${JSON.stringify(disposition)} on field "disposition"; ` +
        `must be one of ${DISPOSITIONS.join(" | ")}`,
    );
  }

  if (!event.edge_id) {
    throw new Error(`appendEvent: event ${eventId} — missing required field "edge_id"`);
  }
  if (!event.node_id) {
    throw new Error(`appendEvent: event ${eventId} — missing required field "node_id"`);
  }

  if (disposition === "wontfix" && !event.reason) {
    throw new Error(
      `appendEvent: event ${eventId} — disposition "wontfix" requires field "reason" (SPEC §5; ` +
        `v1 has 556 unexplained wontfix_reason rows because nothing enforced this)`,
    );
  }

  if (disposition === "baselined" && !event.reason) {
    throw new Error(
      `appendEvent: event ${eventId} — disposition "baselined" requires field "reason" naming its ` +
        `evidence; a baseline is a claim, not a verification, and must never be indistinguishable from one`,
    );
  }

  if (disposition === "rekeyed") {
    if (!event.from_edge_id) {
      throw new Error(
        `appendEvent: event ${eventId} — disposition "rekeyed" requires field "from_edge_id" naming ` +
          `the edge this one continues`,
      );
    }
    if (event.from_edge_id === event.edge_id) {
      throw new Error(
        `appendEvent: event ${eventId} — disposition "rekeyed" has from_edge_id equal to its own ` +
          `edge_id (${event.edge_id}); an edge cannot continue itself`,
      );
    }
    if (!event.reason) {
      throw new Error(
        `appendEvent: event ${eventId} — disposition "rekeyed" requires field "reason"; a re-identification ` +
          `is a claim that two ids are one coupling and must say why`,
      );
    }
  }

  // ── the ref pair ────────────────────────────────────────────────────────
  //
  // An edge has two ends. Every disposition — including `deferred`, which
  // records that someone LOOKED — must name the ref each end was observed
  // at, or the event cannot say where its content was read from. Until
  // 2026-08-22 only the source's ref was recorded, so the downstream half
  // of a cross-repo edge was observed somewhere unnameable.
  //
  // PRESENCE, not truthiness. `null` is a legal, meaningful value here: a
  // genuine resolution failure, carrying its own `*_on_ref_error`. The
  // content checks below can use `!event.x` because a falsy hash is always
  // wrong; a falsy ref is not. Three states must stay distinguishable —
  // absent (a pre-2026-08-22 event), `null` (resolution failed), and a
  // string (resolved, possibly "working-tree").
  for (const field of ["observed_on_ref", "downstream_on_ref"]) {
    if (!(field in event)) {
      throw new Error(
        `appendEvent: event ${eventId} — disposition "${disposition}" is missing field ` +
          `"${field}". An edge has two ends and an event must name the ref each was observed ` +
          `at; use resolveProvenance() (lib/edges/provenance.mjs) rather than setting these by ` +
          `hand. \`null\` is accepted for a genuine resolution failure — omission is not.`,
      );
    }
  }

  if (disposition === "deferred") {
    if (event.source_content != null || event.downstream_content != null) {
      throw new Error(
        `appendEvent: event ${eventId} — disposition "deferred" must not pin content; fields ` +
          `"source_content"/"downstream_content" must be absent. "deferred" records that someone ` +
          `looked, it does not re-pin.`,
      );
    }
  } else if (disposition !== "decoupled") {
    if (!event.source_content) {
      throw new Error(
        `appendEvent: event ${eventId} — disposition "${disposition}" pins a pair and is missing ` +
          `field "source_content"`,
      );
    }
    if (!event.downstream_content) {
      throw new Error(
        `appendEvent: event ${eventId} — disposition "${disposition}" pins a pair and is missing ` +
          `field "downstream_content"`,
      );
    }
  }
}

/**
 * Run `validateEvent`'s rules WITHOUT writing, for `verify`'s dry run.
 *
 * A dry run that reports "would write 7 events" for a payload `appendEvent`
 * would reject is a dry run that lies — the whole value of the preview is that
 * it predicts the real outcome. Shares the one validator rather than
 * re-implementing the rules, so the two can never drift (GOTCHAS G20: one
 * fact, one assertion).
 *
 * @param {object} event
 * @returns {string|null} the error message, or null when the event is valid
 */
export function dryValidateEvent(event) {
  try {
    validateEvent(event, "(dry-run)");
    return null;
  } catch (err) {
    return err.message;
  }
}

// ---------------------------------------------------------------------------
// Store: sharded-by-month JSONL, atomic append under lock.
// ---------------------------------------------------------------------------

/** `2026-08.jsonl` for an ISO timestamp or Date — sharding key is the UTC year-month. */
function shardFileForTs(ts) {
  const iso = ts instanceof Date ? ts.toISOString() : ts;
  return `${iso.slice(0, 7)}.jsonl`;
}

/** Absolute shard path for an ISO timestamp or Date. */
export function shardPathForTs(ts) {
  return path.join(EVENTS_DIR, shardFileForTs(ts));
}

/**
 * Append one verification event. Mints `event_id` (ULID) and `ts` (ISO
 * 8601, "now" unless `opts.now` is supplied — test-only hook for exercising
 * month sharding deterministically without waiting on the calendar) — any
 * `event_id`/`ts` the caller passed in `event` is ignored and overwritten,
 * since minting is this function's job, not the caller's.
 *
 * Validates BEFORE acquiring the lock or touching disk — an invalid event
 * must never be written (see validateEvent).
 *
 * @param {object} event - see the record shape in the module doc / plan §2.
 *   Required: edge_id, node_id, disposition. Conditionally required per
 *   disposition: reason (wontfix/baselined), source_content+downstream_content
 *   (everything except deferred).
 * @param {{now?: Date}} [opts]
 * @returns {Promise<object>} the stamped, written event (event_id, ts, hash_alg added)
 */
export async function appendEvent(event, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const eventId = mintEventId();

  validateEvent(event, eventId);

  const ts = now.toISOString();
  const stamped = {
    ...event,
    event_id: eventId,
    ts,
    hash_alg: event.hash_alg || "sha256",
  };

  const shardPath = shardPathForTs(ts);
  await mkdir(EVENTS_DIR, { recursive: true });
  // proper-lockfile lstat's the target before locking — file must exist.
  if (!existsSync(shardPath)) {
    await appendFile(shardPath, "");
  }
  // High retry budget: same reasoning as appendRowWithId (lib/ledger.mjs) —
  // many writers may contend for one shard in a burst; drain it rather than
  // exhausting a small retry budget.
  const release = await acquireLock(shardPath, { retries: 50, minDelayMs: 20, maxDelayMs: 200 });
  if (!release) {
    throw new Error(`appendEvent: could not acquire lock on ${shardPath} after retries`);
  }
  try {
    await appendFile(shardPath, JSON.stringify(stamped) + "\n");
  } finally {
    await release();
  }

  return stamped;
}

/**
 * Read events across all shards, optionally filtered.
 *
 * Corrupt/unparseable lines are COUNTED in `malformed` and skipped — never
 * silently dropped with no signal (GOTCHAS G1/G2; N1's `unknownTypes`
 * computed-and-discarded is exactly the failure this must not repeat).
 *
 * @param {{edgeId?: string, since?: string}} [filter]
 *   `edgeId` — exact match against `event.edge_id`.
 *   `since` — ISO timestamp string; keeps events with `ts >= since`
 *   (safe as string comparison because both are ISO 8601 UTC).
 * @returns {Promise<{events: object[], malformed: number}>}
 */
export async function readEvents(filter = {}) {
  const { edgeId: filterEdgeId, since } = filter;
  const events = [];
  let malformed = 0;

  if (!existsSync(EVENTS_DIR)) return { events, malformed };

  const files = (await readdir(EVENTS_DIR))
    .filter((f) => f.endsWith(".jsonl"))
    .sort();

  for (const file of files) {
    const raw = await readFile(path.join(EVENTS_DIR, file), "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        malformed++;
        continue;
      }
      if (filterEdgeId && row.edge_id !== filterEdgeId) continue;
      if (since && !(typeof row.ts === "string" && row.ts >= since)) continue;
      events.push(row);
    }
  }

  return { events, malformed };
}

/**
 * Order events by `(ts, event_id)`: `ts` is the ordering key, `event_id`'s string order breaks a
 * `ts` tie. `event_id` is a ULID but NOT the monotonic variant, so a same-millisecond tie breaks
 * on a random suffix, never on call order. It is a documented tiebreak, not a claim about which
 * happened first. A missing `ts` or `event_id` sorts as the empty string, never throws.
 */
function compareEvents(a, b) {
  const at = String(a?.ts ?? "");
  const bt = String(b?.ts ?? "");
  if (at !== bt) return at < bt ? -1 : 1;
  const ai = String(a?.event_id ?? "");
  const bi = String(b?.event_id ?? "");
  return ai < bi ? -1 : ai > bi ? 1 : 0;
}

/**
 * The pure half of `edgeEventIndex`: events in, the index out. Exported so a test (or a caller
 * that already holds events) builds the index from a literal.
 *
 * `events` is every event ordered by `(ts, event_id)`; `byEdge` maps `edge_id` to that edge's
 * events in the same order. An event with no `edge_id` stays in `events` and in no `byEdge`
 * list, so a reader that wants every line still sees it.
 *
 * @param {object[]} rawEvents
 * @param {number} [malformed]
 * @returns {{events: object[], byEdge: Map<string, object[]>, malformed: number}}
 */
export function indexEvents(rawEvents, malformed = 0) {
  const events = [...(rawEvents ?? [])].sort(compareEvents);
  const byEdge = new Map();
  for (const e of events) {
    if (!e?.edge_id) continue;
    const list = byEdge.get(e.edge_id);
    if (list) list.push(e);
    else byEdge.set(e.edge_id, [e]);
  }
  return { events, byEdge, malformed: malformed ?? 0 };
}

/**
 * Read the log ONCE into a `Map<edge_id, events[]>` ordered by `(ts, event_id)`.
 *
 * The nine readers of the event log each used to read it (and some folded it) on their own;
 * they take this index instead. In memory, per command: no cache and no store. Named
 * `edgeEventIndex`, not `index`, because #111's `propagate index` is a different thing.
 * Takes `readEvents`'s filter so a caller may still narrow the read.
 *
 * @param {{edgeId?: string, since?: string}} [filter]
 * @returns {Promise<{events: object[], byEdge: Map<string, object[]>, malformed: number}>}
 */
export async function edgeEventIndex(filter = {}) {
  const { events, malformed } = await readEvents(filter);
  return indexEvents(events, malformed);
}
