/**
 * lib/edges/why.mjs — the decision chain behind `propagate why <edge_id>`.
 *
 * §4 of ~/.claude/plans/status-temporal-plum.md (lane W3), sitting directly
 * on the provenance wedge lane W1 landed (`lib/edges/provenance.mjs`,
 * `observed_at_commit` / `observed_on_branch` / `observed_dirty` / `by_kind`
 * on new events) and on the append-only v2 event store
 * (`lib/edges/events.mjs`).
 *
 * D7 (this skill's own decomposition plan): commands land as a lib module
 * that holds the logic, plus a THIN dispatch arm in cli.mjs that parses
 * argv, prints, and sets the exit code. This file is the module — it
 * returns plain data and prints nothing. cli.mjs's `whyCmd()` is the arm.
 *
 * FILTERING IS THE POINT (brief §4): of 1347 live events, 716 are
 * `no-change-needed` and 444 are `baselined` — an unfiltered chain buries
 * the moments a human actually changed their mind. `describeWhy` keeps an
 * event only when its disposition DIFFERS from the previously-kept one for
 * that edge; `{ all: true }` renders every event instead.
 *
 * ABSENCE MUST BE ATTRIBUTABLE (rule:discernment-checks §2). Three cases
 * that must never collapse into one blank or one guess:
 *
 *   "unknown-edge" — this edge_id is not declared by any sidecar reconcile()
 *                    can currently see, AND has zero events. Most likely a
 *                    typo or an edge that no longer exists.
 *   "no-events"    — this edge_id IS currently declared, but has never been
 *                     verified — the honest NEVER_VERIFIED starting point,
 *                     not an error.
 *   "found"        — events exist. Individual events written before lane W1
 *                     (all 1347 pre-wedge events) carry no
 *                     observed_at_commit/observed_on_branch; each such entry
 *                     renders `position.recorded === false`, never a blank
 *                     or invented position. The same holds one lane later
 *                     for the downstream end: every event minted before
 *                     2026-08-22 renders `downstreamPosition.recorded ===
 *                     false` and a null `downstream_on_ref`.
 */

import { WORKSPACES } from "../core/config.mjs";
import { reconcile } from "./reconcile.mjs";
import { readEvents } from "./events.mjs";

/**
 * True when an event carries any provenance-wedge position field for the
 * named side. `prefix` is "observed" for the SOURCE end and "downstream"
 * for the other — the field naming the store has carried since the ref
 * pair landed (2026-08-22); see lib/edges/provenance.mjs.
 */
function hasRecordedPosition(event, prefix = "observed") {
  const commitKey = prefix === "observed" ? "observed_at_commit" : "downstream_at_commit";
  const branchKey = prefix === "observed" ? "observed_on_branch" : "downstream_on_branch";
  return event[commitKey] != null || event[branchKey] != null;
}

/**
 * One side's position, or an attributable statement that it was not
 * recorded. Never a blank and never a guess: an event minted before its
 * lane landed genuinely does not know where it was observed, and saying so
 * is the answer (rule:discernment-checks §2).
 */
function positionFor(event, prefix, note) {
  if (!hasRecordedPosition(event, prefix)) return { recorded: false, note };
  const p = prefix === "observed"
    ? { commit: event.observed_at_commit, branch: event.observed_on_branch, dirty: event.observed_dirty }
    : { commit: event.downstream_at_commit, branch: event.downstream_on_branch, dirty: event.downstream_dirty };
  return {
    recorded: true,
    commit: p.commit ?? null,
    branch: p.branch ?? null,
    dirty: p.dirty ?? null,
  };
}

/**
 * One event -> one rendered chain entry.
 *
 * BOTH ends. The design's stated success criterion is that `propagate why`
 * "renders the decision chain, including the branch each decision was made
 * on" — and a decision about an edge was made against two files, which for
 * ~13% of edges live in different repos on independent branch lines. The
 * source-only rendering could not express that at all.
 */
function toEntry(event) {
  const position = positionFor(
    event,
    "observed",
    "position not recorded (written before provenance was tracked)",
  );
  const downstreamPosition = positionFor(
    event,
    "downstream",
    "downstream position not recorded (written before the ref pair was tracked)",
  );

  return {
    event_id: event.event_id ?? null,
    ts: event.ts ?? null,
    disposition: event.disposition ?? null,
    by: event.by ?? null,
    by_kind: event.by_kind ?? null,
    reason: event.reason ?? null,
    observed_on_ref: event.observed_on_ref ?? null,
    // `?? null` collapses absent and null, which is right HERE and only
    // here: `why` renders a human-facing chain, and both mean "this entry
    // cannot tell you the downstream ref". The distinction that matters —
    // absent (pre-pair event) vs null (resolution failed) — is preserved
    // in the store itself and enforced by validateEvent.
    downstream_on_ref: event.downstream_on_ref ?? null,
    position,
    downstreamPosition,
  };
}

/**
 * Keep an event only where its disposition differs from the previously
 * KEPT one. `events` must already be sorted ascending by `ts`. The first
 * event is always kept — there is no "previous" to differ from.
 */
function collapseToDispositionChanges(sortedEvents) {
  const kept = [];
  let lastDisposition = undefined;
  for (const e of sortedEvents) {
    if (kept.length === 0 || e.disposition !== lastDisposition) {
      kept.push(e);
      lastDisposition = e.disposition;
    }
  }
  return kept;
}

/**
 * Whether `edgeId` is currently declared by any sidecar reconcile() can see
 * right now — the fact that distinguishes "no-events" (declared, never
 * verified) from "unknown-edge" (not declared, and no events either).
 * reconcile() is read-only by contract (lib/edges/reconcile.mjs's own
 * header) — this is a plain read, same as every other reconcile() caller.
 */
async function isCurrentlyDeclared(edgeId) {
  const { rows } = await reconcile(WORKSPACES);
  return rows.some((r) => r.edge_id === edgeId);
}

/**
 * Build the decision chain for one edge.
 *
 * @param {string} edgeId
 * @param {{all?: boolean}} [opts] - `all: true` renders every event; default
 *   renders only disposition changes (see module doc).
 * @returns {Promise<{
 *   edge_id: string,
 *   status: "unknown-edge"|"no-events"|"found",
 *   message?: string,
 *   totalEvents: number,
 *   malformed: number,
 *   shown: object[],
 * }>}
 */
export async function describeWhy(edgeId, opts = {}) {
  const { all = false } = opts;
  const { events, malformed } = await readEvents({ edgeId });

  if (events.length === 0) {
    const declared = await isCurrentlyDeclared(edgeId);
    if (declared) {
      return {
        edge_id: edgeId,
        status: "no-events",
        message: `no verification events recorded for ${edgeId} (currently declared, never verified — NEVER_VERIFIED)`,
        totalEvents: 0,
        malformed,
        shown: [],
      };
    }
    return {
      edge_id: edgeId,
      status: "unknown-edge",
      message: `unknown edge id ${edgeId} — not found among currently declared edges, and no events recorded for it`,
      totalEvents: 0,
      malformed,
      shown: [],
    };
  }

  const sorted = [...events].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const chain = all ? sorted : collapseToDispositionChanges(sorted);

  return {
    edge_id: edgeId,
    status: "found",
    totalEvents: events.length,
    malformed,
    shown: chain.map(toEntry),
  };
}
