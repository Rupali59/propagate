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
 * deferred event in it". `foldWindow()` below takes the edge's STANDING event
 * with `reduceLastPinning`/`reduceLastDeferred` (lib/edges/reconcile.mjs), the
 * same two reducers `reconcile` uses, so this payload and reconcile cannot
 * disagree about which edges are deferred.
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
import { edgeEventIndex } from "../edges/events.mjs";
import { reduceLastPinning, reduceLastDeferred } from "../edges/reconcile.mjs";
import { historyFromEvents } from "./queue.mjs";

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
 * The event that STANDS for each edge, from a flat event list -- the fold.
 *
 * It is reconcile's own fold, not a copy: `reduceLastPinning` and `reduceLastDeferred`
 * (lib/edges/reconcile.mjs), the two reducers `reconcile` calls. An edge's standing event is its
 * latest PIN when it has one, otherwise its latest deferral. A deferral recorded AFTER a pin does
 * not stand in for it: `deriveEdgeState` keeps the pinned state and shows the deferral beside it
 * (DECISIONS 2026-11-05, rule 4), so a stream that called that edge "open" disagreed with
 * `reconcile`, `status` and `graph` (#118, #127 census). Ties (same millisecond) break on
 * `event_id`, the `(ts, event_id)` order `edgeEventIndex` sorts by.
 *
 * Pass an edge's WHOLE history, not just the window's events: a window that holds only the later
 * deferral would otherwise hide the pin that outranks it.
 *
 * @param {object[]} events
 * @returns {Map<string, object>} edge_id -> the standing raw event, whole
 */
export function foldWindow(events) {
  const usable = (events ?? []).filter((e) => e?.edge_id);
  const pins = reduceLastPinning(usable);
  const deferrals = reduceLastDeferred(usable);
  const map = new Map(pins);
  for (const [edgeId, d] of deferrals) {
    // A deferral stands only for an edge no real pin has settled: the same rule reconcile's
    // `deferralAfterPin` + `deriveEdgeState` apply.
    if (!map.has(edgeId)) map.set(edgeId, d);
  }
  return map;
}

/**
 * streamPayload({ since }) -- what changed since `since` (or the last 7 days
 * when `since` is absent or unparseable), one row per edge, folded to its
 * current standing rather than counted as raw lines.
 *
 * An edge is IN the window when it has at least one event with `ts >= since`.
 * `open` means the edge's STANDING event (`foldWindow`: its latest pin, else its
 * latest deferral) is a `deferred` disposition: someone looked and asked to come
 * back to it, and nothing has pinned it since. That is exactly when `reconcile`
 * derives DEFERRED, so the stream, `status` and `graph` agree. A deferral
 * recorded after a real pin does NOT make the edge open (reconcile keeps the
 * pinned state), and the row says so in `standing` and `parkedAfterPin`.
 *
 * The fold runs over each edge's WHOLE history from one index of the store,
 * never over the window's events alone: a window holding only a later deferral
 * would otherwise hide the earlier pin that outranks it, which is the
 * disagreement this replaced. The same index feeds `judgedCount`/`noiseRatio`,
 * so the store is read once per payload, not twice.
 *
 * `at`, `by`, `reason` and `disposition` describe the LATEST event of any kind
 * (what changed most recently, which is what "since I last looked" means).
 *
 * @param {{since?: string, index?: object}} [opts] `index` is an `edgeEventIndex()` result,
 *   for a caller that already holds one
 * @returns {Promise<object>}
 */
export async function streamPayload({ since, index } = {}) {
  const givenValid = isValidIso(since);
  const sinceUsed = givenValid ? since : sevenDaysAgo();
  const sinceSource = since === undefined ? "default-7d" : givenValid ? "given" : "invalid-given-defaulted";

  const idx = index ?? (await edgeEventIndex());
  const history = historyFromEvents(idx.events, idx.malformed);

  const changed = [];
  for (const [edgeId, edgeEvents] of idx.byEdge) {
    if (!edgeEvents.some((e) => typeof e.ts === "string" && e.ts >= sinceUsed)) continue;
    const standing = foldWindow(edgeEvents).get(edgeId);
    const latest = edgeEvents[edgeEvents.length - 1]; // index order is (ts, event_id)
    const h = history.get(edgeId) ?? null;
    const vintage = refVintage(latest);
    const lastDeferred = reduceLastDeferred(edgeEvents).get(edgeId) ?? null;
    const lastPin = reduceLastPinning(edgeEvents).get(edgeId) ?? null;
    changed.push({
      edge_id: edgeId,
      node_id: latest.node_id ?? null,
      disposition: latest.disposition ?? null,
      // What reconcile would call this edge, short of the environment: DEFERRED only when no pin
      // has settled it. `standing` is the disposition that decides it.
      standing: standing?.disposition ?? null,
      open: standing?.disposition === "deferred",
      parkedAfterPin: Boolean(lastPin && lastDeferred && lastDeferred.ts > lastPin.ts),
      at: latest.ts ?? null,
      by: latest.by ?? null,
      reason: latest.reason ?? null,
      downstreamOnRef: vintage,
      // Context only -- from the whole-history fold, never used to decide
      // open/closed above. Null (not 0) when the edge has no other history
      // beyond this window's own event ("never judged before" vs "judged
      // and always a no-op" are different facts, rule:discernment-checks §2).
      judgedCount: h?.total ?? null,
      noiseRatio: h && h.total > 0 ? h.noChange / h.total : null,
    });
  }
  // Newest first -- what changed MOST RECENTLY is what "since I last
  // looked" means to a reader opening this after a while away.
  changed.sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? "")));

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
    // parse at all, store-wide (the index counts every malformed line it
    // sees while scanning, not only ones inside the window). "No malformed
    // lines" and "did not check" must not read the same
    // (rule:discernment-checks §2), so this is always a number, never omitted.
    malformed: idx.malformed ?? 0,
  };
}
