/**
 * stream.mjs — "what changed since I last looked", over the append-only event ledger.
 *
 * See ~/.claude/plans/i-saw-it-what-starry-sparkle.md, "The architecture: one
 * derivation, three renderers": `streamPayload` is collected ONCE and rendered
 * by the UI panel, the widget's one-number summary, and `journal --since`
 * (already exists, unchanged). This module derives; it prints nothing and
 * opens no socket.
 *
 * MUST FOLD, NOT COUNT. tests/unit/whole-project-ledger.test.mjs:16-19 is the
 * cost of getting this wrong: 501 reported open where the truth was 8, because
 * the ledger is append-only and a closed row keeps its original `open` line
 * forever. The same shape applies here: an edge that was deferred and later
 * resolved inside the reported window must read RESOLVED, never "has a
 * deferred event in it". `foldWindow()` below keeps only the LATEST event per
 * edge_id, exactly the reduction `reduceLastPinning`/`reduceLastDeferred`
 * (lib/edges/reconcile.mjs:117-136) already perform -- see the note on those
 * two at the bottom of this file for why they are not imported directly.
 *
 * MUST NOT claim suppressed identities. `monitor.log` carries counters only;
 * `notified.jsonl` carries identities for NOTIFIED events alone, FIFO-capped,
 * and the suppressed set is computed in memory and never persisted -- it
 * cannot be reconstructed after the fact, because the dedup key is a content
 * triple and reconcile() derives only from CURRENT content. So this payload
 * carries no field purporting to list what was suppressed. See the negative
 * assertion in tests/unit/stream.test.mjs -- deliberately, so nobody adds one.
 *
 * MUST tolerate two schema vintages. `downstream_on_ref` is absent (key not
 * present) on every event written before 2026-08-22; present-and-null means a
 * real resolution failure; present-and-a-string means resolved. Three
 * different facts (lib/edges/events.mjs's validateEvent comment says so at
 * length) and `refVintage()` below keeps them distinguishable rather than
 * collapsing "absent" and "null" into the same falsy branch.
 */

import path from "node:path";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";

import { STATE_DIR } from "../core/config.mjs";
import { stateDir } from "../core/paths.mjs";
import { readEvents } from "../edges/events.mjs";
import { historyByEdge } from "./queue.mjs";

const ROOT = STATE_DIR || stateDir();

/** A single ISO string -- the one new piece of persisted state this build adds. */
export const CURSOR_PATH = process.env.PROPAGATE_STREAM_CURSOR || path.join(ROOT, "stream-cursor.json");

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function sevenDaysAgo(now = Date.now()) {
  return new Date(now - SEVEN_DAYS_MS).toISOString();
}

function isValidIso(v) {
  return typeof v === "string" && v.length > 0 && !Number.isNaN(Date.parse(v));
}

// ---------------------------------------------------------------------------
// The cursor -- read/write, corruption-attributable.
// ---------------------------------------------------------------------------

/**
 * Read the cursor. Three outcomes, kept distinguishable
 * (rule:discernment-checks §2 -- absence must be attributable, never a bare
 * null or silent default that reads as a clean answer):
 *
 *   "missing" -- no file (first look, or the file was deleted). `since`
 *                defaults to 7 days ago -- NOT "show everything". A lost
 *                cursor must not invent more change than there was
 *                (rule:delegation-criteria §2: a lost baseline that invented
 *                drift once fired ~120 spurious rows from nothing).
 *   "corrupt"  -- the file exists but is unparseable JSON, or its `since` is
 *                 not a valid ISO timestamp. Reported as corruption, not
 *                 silently treated as missing and not as "everything
 *                 changed" -- `since` still defaults to 7 days so a caller
 *                 that ignores `status` still gets the safe answer, but
 *                 `status`/`error`/`raw` are there for one that doesn't.
 *   "ok"       -- a valid cursor was read.
 *
 * @param {string} [file]
 * @returns {Promise<{status: "missing"|"corrupt"|"ok", since: string, error?: string, raw?: string|null}>}
 */
export async function readCursor(file = CURSOR_PATH) {
  if (!existsSync(file)) {
    return { status: "missing", since: sevenDaysAgo() };
  }

  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    return { status: "corrupt", since: sevenDaysAgo(), error: `could not read cursor: ${err.message}`, raw: null };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { status: "corrupt", since: sevenDaysAgo(), error: `cursor is not valid JSON: ${err.message}`, raw };
  }

  const value = parsed?.since;
  if (!isValidIso(value)) {
    return {
      status: "corrupt",
      since: sevenDaysAgo(),
      error: `cursor's "since" is not a valid ISO timestamp: ${JSON.stringify(value)}`,
      raw,
    };
  }

  return { status: "ok", since: value };
}

/**
 * Write the cursor atomically (temp+rename, same discipline as
 * lib/core/state.mjs's writeState). `at` should be the payload's own
 * `generatedAt` -- the moment the caller actually looked, not merely the
 * moment writeCursor happens to run afterward.
 *
 * @param {string} [at] ISO timestamp; defaults to now.
 * @param {string} [file]
 * @returns {Promise<string>} the value written
 */
export async function writeCursor(at = new Date().toISOString(), file = CURSOR_PATH) {
  if (!isValidIso(at)) {
    throw new Error(`writeCursor: "${at}" is not a valid ISO timestamp`);
  }
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  await writeFile(tmp, JSON.stringify({ since: at }, null, 2));
  await rename(tmp, file);
  return at;
}

// ---------------------------------------------------------------------------
// The derivation.
// ---------------------------------------------------------------------------

/**
 * `downstream_on_ref`'s three-way vintage, kept distinguishable rather than
 * collapsed into one falsy check (lib/edges/events.mjs's validateEvent
 * comment names the same three states for the same reason).
 *
 * @param {object} event
 * @returns {{status: "absent"|"unresolved"|"resolved", value: string|null|undefined}}
 */
export function refVintage(event) {
  if (!event || !("downstream_on_ref" in event)) return { status: "absent", value: undefined };
  const value = event.downstream_on_ref;
  return { status: value === null ? "unresolved" : "resolved", value };
}

/**
 * Keep only the LATEST event per edge_id from a flat event list -- the fold.
 * Ties (same millisecond) break on `event_id`'s string order, which is a
 * documented tiebreak only: `event_id` is a ULID but NOT the monotonic
 * variant, so same-millisecond ids sort by a random suffix rather than call
 * order. `ts` is the ordering key; this is never used as a primary sort.
 *
 * Same reduction as `reduceLastPinning`/`reduceLastDeferred`
 * (lib/edges/reconcile.mjs:117-136), generalised to "last of either kind"
 * rather than split by pinning-vs-deferred -- see the module-bottom note on
 * why those two are not imported directly.
 *
 * @param {object[]} events
 * @returns {Map<string, object>} edge_id -> the winning raw event, whole
 */
export function foldWindow(events) {
  const map = new Map();
  for (const e of events ?? []) {
    if (!e?.edge_id) continue;
    const cur = map.get(e.edge_id);
    if (!cur || String(e.ts) > String(cur.ts) || (String(e.ts) === String(cur.ts) && String(e.event_id) > String(cur.event_id))) {
      map.set(e.edge_id, e);
    }
  }
  return map;
}

/**
 * streamPayload({ since }) -- what changed since `since` (or the last 7 days
 * when `since` is absent or unparseable), one row per edge, folded to its
 * current standing rather than counted as raw lines.
 *
 * `open` means the edge's most recent event (of any kind, in or before this
 * window -- see the note in foldWindow's caller below) is a `deferred`
 * disposition: someone looked and asked to come back to it. Anything else
 * (`propagated`, `no-change-needed`, `source-corrected`, `decoupled`,
 * `wontfix`, `baselined`, `both-reconciled`) PINS the pair and reads closed.
 * A raw line count over the same data would see a `deferred` line present
 * for an edge and report it open even when a later event in the same window
 * closed it -- the 501-vs-8 shape with the sign flipped.
 *
 * Every edge reported here has at least one event with `ts >= since`, so its
 * fold-wide latest event (computed by `foldWindow` over the events already
 * fetched for this window) is necessarily also >= since -- the winning event
 * cannot lie outside the window it was drawn from. No second, whole-store
 * read is needed to get the correct "current" answer; `historyByEdge()` is
 * still called, but only for `judgedCount`/`noiseRatio` context (how many
 * times has this edge been judged, ever, and how often was the answer
 * nothing) -- informational, never load-bearing for `open`/`closed`.
 *
 * @param {{since?: string}} [opts]
 * @returns {Promise<object>}
 */
export async function streamPayload({ since } = {}) {
  const givenValid = isValidIso(since);
  const sinceUsed = givenValid ? since : sevenDaysAgo();
  const sinceSource = since === undefined ? "default-7d" : givenValid ? "given" : "invalid-given-defaulted";

  const { events, malformed } = await readEvents({ since: sinceUsed });
  const history = await historyByEdge();
  const winners = foldWindow(events);

  const changed = [...winners.entries()]
    .map(([edgeId, ev]) => {
      const h = history.get(edgeId) ?? null;
      const vintage = refVintage(ev);
      return {
        edge_id: edgeId,
        node_id: ev.node_id ?? null,
        disposition: ev.disposition ?? null,
        open: ev.disposition === "deferred",
        at: ev.ts ?? null,
        by: ev.by ?? null,
        reason: ev.reason ?? null,
        downstreamOnRef: vintage,
        // Context only -- from the whole-history fold, never used to decide
        // open/closed above. Null (not 0) when the edge has no other history
        // beyond this window's own event ("never judged before" vs "judged
        // and always a no-op" are different facts, rule:discernment-checks §2).
        judgedCount: h?.total ?? null,
        noiseRatio: h && h.total > 0 ? h.noChange / h.total : null,
      };
    })
    // Newest first -- what changed MOST RECENTLY is what "since I last
    // looked" means to a reader opening this after a while away.
    .sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? "")));

  const open = changed.filter((c) => c.open).length;

  return {
    since: sinceUsed,
    sinceSource,
    generatedAt: new Date().toISOString(),
    changed,
    summary: {
      total: changed.length,
      open,
      closed: changed.length - open,
    },
    // Distinct from `changed.length` -- lines this window's read could not
    // parse at all, store-wide (readEvents counts every malformed line it
    // sees while scanning, not only ones inside the window). "No malformed
    // lines" and "did not check" must not read the same
    // (rule:discernment-checks §2), so this is always a number, never omitted.
    malformed: malformed ?? 0,
  };
}

/*
 * On `reduceLastPinning`/`reduceLastDeferred` (lib/edges/reconcile.mjs:117-136).
 *
 * The plan names these as the fold to reuse. They are NOT exported from
 * reconcile.mjs -- both are module-private (no `export` keyword) -- so
 * importing them is not possible without editing that file, and
 * lib/edges/reconcile.mjs is outside this lane's owned file set (only
 * lib/report/stream.mjs and its test are owned; see the dispatch brief).
 * Exporting two one-line functions would be a small, low-risk change, but it
 * is a file another lane may also be touching concurrently and editing it
 * was explicitly not authorised here, so this was flagged rather than done.
 *
 * `historyByEdge()` (lib/report/queue.mjs, already exported and already
 * reused elsewhere) computes materially the same reduction -- "last event
 * per edge_id, by ts" -- across the WHOLE store, which is what this module
 * uses for the informational judgedCount/noiseRatio fields above.
 * `foldWindow()` here performs the identical reduction (last-by-ts,
 * ULID-tiebreak) but scoped to the window's own already-fetched events and
 * keeping the FULL raw event (historyByEdge's `last` keeps only
 * {ts, disposition, reason}, dropping `downstream_on_ref`/`node_id`/`by`,
 * which this module needs for schema-vintage and identity fields). It is
 * the same fold, not a competing one: `open`/`closed` here and
 * `historyByEdge`'s `last.disposition` agree by construction, because both
 * are "take the event with the greatest ts for this edge_id" over
 * overlapping data. Anyone doing L2's or a future lane's review should
 * consider whether reduceLastPinning/reduceLastDeferred should be exported
 * and this module's foldWindow retired in favour of them -- left as a
 * finding, not resolved silently here.
 */
