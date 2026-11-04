/**
 * lib/edges/rekey.mjs — `propagate rekey`: carry an edge's verification history
 * across a re-identification, by appending ONE forward-link event.
 *
 * THE PROBLEM. An edge id is `sha8(node_id, downstream, why)` (events.mjs
 * `edgeId`). Rewording a sidecar `why:` — or renaming either file — mints a new
 * id. The old id's verdicts stay in the store under an id nothing declares, and
 * the new id reads NEVER_VERIFIED. Worse than losing a CLEAN: a DIVERGED edge
 * comes back as "never judged", which is a different claim from "judged, and
 * both sides moved" (2026-08-17, a DIVERGED edge dropped off the worklist that
 * way; 2026-10-28, d7a473c9 with 8 verdicts became 26533048 with none).
 *
 * THE MECHANISM. One event on the NEW edge id, `disposition: "rekeyed"`,
 * carrying `from_edge_id` and the OLD edge's latest pinned pair and position.
 * reconcile then derives the new edge's state from exactly the pair the old edge
 * was judged at: CLEAN stays CLEAN, DIVERGED stays DIVERGED. Nothing existing is
 * edited, so this is not the id remap that DECISIONS 2026-08-22 rejected for
 * rewriting an append-only store.
 *
 * D7: this module returns data and prints nothing. cli.mjs's `rekeyCmd` is the
 * thin arm. `planRekey` never writes; `applyRekey` is the only function here
 * that does, and it writes exactly one event.
 *
 * ABSENCE MUST BE ATTRIBUTABLE (rule:discernment-checks §2). Every refusal below
 * is a named reason with its own exit code. None is a silent no-op, and "no
 * candidates" is a refusal too, with its own code.
 */

import { WORKSPACES } from "../core/config.mjs";
import { reconcile, reduceLastPinning, stateFromPin } from "./reconcile.mjs";
import { edgeEventIndex, appendEvent } from "./events.mjs";
import { resolveByKind, resolveExecution } from "./provenance.mjs";

/** Reason code -> process exit code. 2 is reserved for usage errors by the CLI arm. */
export const REKEY_EXIT = Object.freeze({
  "to-not-declared": 11,
  "to-has-events": 12,
  "from-still-declared": 13,
  "nothing-to-carry": 14,
  "already-rekeyed": 15,
  "no-candidates": 16,
});

/**
 * The fields copied VERBATIM from the old edge's latest pinning event. The two
 * content ids are what reconcile compares; the position fields are what `settle`
 * / `historyFromEvents` use as the "since last pinning verify" diff base
 * (`lastVerified`: observed_at_commit, observed_dirty, observed_on_branch,
 * downstream_at_commit, downstream_dirty). The two `*_on_ref` fields are copied
 * because validateEvent requires them to be present on every event.
 */
const CARRIED_FIELDS = Object.freeze([
  "source_content",
  "downstream_content",
  "observed_on_ref",
  "observed_at_commit",
  "observed_on_branch",
  "observed_dirty",
  "downstream_on_ref",
  "downstream_at_commit",
  "downstream_on_branch",
  "downstream_dirty",
]);

/** Fields validateEvent requires to be PRESENT (null is legal; omission is not). */
const REQUIRED_PRESENT = Object.freeze(["observed_on_ref", "downstream_on_ref"]);

/**
 * Read the two inputs a plan needs. Split out so tests (and callers that already
 * hold them) can hand `planRekey` data instead of a store.
 */
async function loadInputs(opts) {
  const rows = opts.rows ?? (await reconcile(opts.workspaces ?? WORKSPACES)).rows;
  const events = opts.events ?? opts.index?.events ?? (await edgeEventIndex()).events;
  return { rows, events };
}

/**
 * Orphaned edge ids that could be the predecessor of `newRow`.
 *
 * ORPHANED: has events, and no sidecar declares it now. Candidate: it shares
 * the new edge's `node_id`, OR its last pin's `source_content` /
 * `downstream_content` equals what the new edge's files hold now. Events do not
 * record the downstream PATH, so "shares a downstream" cannot be read off them;
 * a content match is the nearest thing the store can answer, and it is what a
 * pure file rename looks like (same bytes, new path). Each candidate says which
 * test matched, so a weak match is visible as one.
 *
 * Edges already rekeyed onward (some event has from_edge_id === id) are listed
 * with `rekeyedTo` set rather than hidden: they are refused by `planRekey`, and
 * hiding them would make "why is my edge not listed" unanswerable.
 *
 * @returns {{edge_id: string, node_id: string, lastDisposition: string|null,
 *   lastTs: string|null, verdicts: number, matchedBy: string[], rekeyedTo: string|null}[]}
 *   newest first
 */
export function findOrphanCandidates(newRow, rows, events) {
  const declared = new Set(rows.map((r) => r.edge_id));
  const byEdge = new Map();
  for (const e of events) {
    if (!e?.edge_id) continue;
    if (!byEdge.has(e.edge_id)) byEdge.set(e.edge_id, []);
    byEdge.get(e.edge_id).push(e);
  }
  const lastPin = reduceLastPinning(events);
  const rekeyedTo = new Map();
  for (const e of events) {
    if (e?.disposition === "rekeyed" && e.from_edge_id) rekeyedTo.set(e.from_edge_id, e.edge_id);
  }

  const out = [];
  for (const [id, evs] of byEdge) {
    if (declared.has(id) || id === newRow.edge_id) continue;
    const pin = lastPin.get(id) ?? null;
    const matchedBy = [];
    if (evs.some((e) => e.node_id === newRow.node_id)) matchedBy.push("same node_id");
    if (pin?.downstream_content && pin.downstream_content === newRow.downstream?.contentId) {
      matchedBy.push("downstream content equals the new edge's downstream now");
    }
    if (pin?.source_content && pin.source_content === newRow.source?.contentId) {
      matchedBy.push("source content equals the new edge's source now");
    }
    if (matchedBy.length === 0) continue;
    const sorted = [...evs].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
    out.push({
      edge_id: id,
      node_id: sorted[0].node_id ?? null,
      lastDisposition: sorted[0].disposition ?? null,
      lastTs: sorted[0].ts ?? null,
      verdicts: evs.filter((e) => e.disposition !== "deferred" && e.disposition !== "rekeyed").length,
      matchedBy,
      rekeyedTo: rekeyedTo.get(id) ?? null,
    });
  }
  out.sort((a, b) => (a.lastTs < b.lastTs ? 1 : a.lastTs > b.lastTs ? -1 : 0));
  return out;
}

/** The "this is what the edge is" triple, for the side-by-side print. */
function describeRow(row) {
  return {
    edge_id: row.edge_id,
    node_id: row.node_id,
    source: row.source?.path ?? null,
    downstream: row.downstream?.path ?? null,
    why: row.why ?? null,
  };
}

function refusal(reason, message, extra = {}) {
  return { ok: false, refusal: reason, exitCode: REKEY_EXIT[reason], message, ...extra };
}

/**
 * Decide whether `oldId -> newId` may be written, and say exactly what would be.
 * NEVER writes.
 *
 * Refusals, in the order they are checked (each a distinct reason and exit code):
 *   1 to-not-declared     `newId` is not a currently declared edge.
 *   2 to-has-events       `newId` already has events; merging two histories is ambiguous.
 *   3 from-still-declared `oldId` is still declared, so this is not a rename and
 *                         writing would leave two live edges sharing one history.
 *   4 nothing-to-carry    `oldId` has no pinning event carrying content (only
 *                         deferred, or its last pin is `decoupled`).
 *   5 already-rekeyed     another event already continues `oldId`; a second would fork it.
 *
 * `--from` and `--to` MAY differ in node_id and downstream (a file rename); the
 * plan carries both triples so a mismatch is visible rather than refused.
 *
 * @param {string} oldId
 * @param {string} newId
 * @param {{rows?: object[], events?: object[], workspaces?: object[], reason?: string, by?: string}} [opts]
 * @returns {Promise<
 *   {ok: false, refusal: string, exitCode: number, message: string}
 *   | {ok: true, from: object, to: object, event: object, predictedState: string, carried: object, mismatch: string[]}
 * >}
 */
export async function planRekey(oldId, newId, opts = {}) {
  const { rows, events } = await loadInputs(opts);

  const newRow = rows.find((r) => r.edge_id === newId) ?? null;
  if (!newRow) {
    return refusal(
      "to-not-declared",
      `--to ${newId} is not a currently declared edge. Make the sidecar edit first, then run \`propagate reconcile --all\` ` +
        `to read the new edge id.`,
    );
  }

  if (events.some((e) => e?.edge_id === newId)) {
    return refusal(
      "to-has-events",
      `--to ${newId} already has events, so rekeying onto it would merge two histories and the order is ambiguous. ` +
        `Nothing is written. \`propagate why ${newId}\` shows what it has.`,
    );
  }

  const oldRow = rows.find((r) => r.edge_id === oldId) ?? null;
  if (oldRow) {
    return refusal(
      "from-still-declared",
      `--from ${oldId} is still a declared edge, so this is not a rename: ${oldId} and ${newId} are both live. ` +
        `Writing would leave two edges sharing one history. Remove or reword the old declaration first.`,
      { from: describeRow(oldRow), to: describeRow(newRow) },
    );
  }

  const lastPin = reduceLastPinning(events).get(oldId) ?? null;
  if (!lastPin || !lastPin.source_content || !lastPin.downstream_content) {
    const why = !lastPin
      ? `${oldId} has no pinning event at all (no events, or only \`deferred\`)`
      : `${oldId}'s last pinning event is \`${lastPin.disposition}\`, which carries no content`;
    return refusal(
      "nothing-to-carry",
      `${why}, so there is no verified pair to carry. Verify the new edge instead: ` +
        `propagate verify --edge ${newId} --disposition <d> --reason '<what you checked, as file:line>' --apply`,
    );
  }

  const successor = events.find(
    (e) => e?.disposition === "rekeyed" && e.from_edge_id === oldId,
  );
  if (successor) {
    return refusal(
      "already-rekeyed",
      `--from ${oldId} was already continued by ${successor.edge_id} (event ${successor.event_id ?? "?"}). ` +
        `A second rekey would fork its history. Nothing is written.`,
    );
  }

  const carried = {};
  for (const f of CARRIED_FIELDS) if (f in lastPin) carried[f] = lastPin[f];
  // A pin written before the ref pair existed has no *_on_ref at all. validateEvent
  // demands presence, and null is the honest value ("not recorded"), never a guess.
  for (const f of REQUIRED_PRESENT) if (!(f in carried)) carried[f] = null;

  const reason =
    opts.reason ||
    `edge re-identified: ${oldId} continues as ${newId} (reworded why or renamed file); verification carried, not redone`;

  const event = {
    edge_id: newId,
    node_id: newRow.node_id,
    disposition: "rekeyed",
    from_edge_id: oldId,
    from_node_id: lastPin.node_id ?? null,
    carried_disposition: lastPin.disposition,
    carried_event_id: lastPin.event_id ?? null,
    carried_ts: lastPin.ts ?? null,
    by: opts.by || process.env.USER || "rekey",
    reason,
    ...carried,
    // Who DECIDED, and who EXECUTED this write, as every other event records them.
    by_kind: resolveByKind("human"),
    ...resolveExecution(),
  };

  const predictedState = stateFromPin(
    lastPin,
    newRow.source?.contentId,
    newRow.downstream?.contentId,
  );

  const from = { edge_id: oldId, node_id: lastPin.node_id ?? null, lastDisposition: lastPin.disposition, lastTs: lastPin.ts ?? null };
  const to = describeRow(newRow);
  const mismatch = [];
  if (from.node_id && from.node_id !== to.node_id) mismatch.push(`node_id differs: ${from.node_id} -> ${to.node_id}`);

  return { ok: true, from, to, event, predictedState, carried, mismatch };
}

/**
 * Write the planned event. The ONLY writer in this module, one event, through
 * `appendEvent` so validateEvent stays the one place the rules live.
 *
 * @param {{ok: true, event: object}} plan from planRekey
 * @returns {Promise<object>} the stamped event
 */
export async function applyRekey(plan) {
  if (!plan || plan.ok !== true) throw new Error("applyRekey: refusing to write without an ok plan from planRekey");
  return appendEvent(plan.event);
}

/**
 * Candidates for `--to newId`, with the same declared/has-events checks the plan
 * makes first, so listing candidates for an undeclared edge is a refusal and not
 * a list that cannot be acted on.
 *
 * @returns {Promise<{ok: true, to: object, candidates: object[]} | {ok: false, refusal: string, exitCode: number, message: string}>}
 */
export async function listRekeyCandidates(newId, opts = {}) {
  const { rows, events } = await loadInputs(opts);
  const newRow = rows.find((r) => r.edge_id === newId) ?? null;
  if (!newRow) {
    return refusal(
      "to-not-declared",
      `--to ${newId} is not a currently declared edge. Make the sidecar edit first, then run \`propagate reconcile --all\` ` +
        `to read the new edge id.`,
    );
  }
  if (events.some((e) => e?.edge_id === newId)) {
    return refusal(
      "to-has-events",
      `--to ${newId} already has events, so it cannot be the target of a rekey. \`propagate why ${newId}\` shows what it has.`,
    );
  }
  const candidates = findOrphanCandidates(newRow, rows, events);
  if (candidates.length === 0) {
    return refusal(
      "no-candidates",
      `no orphaned edge shares ${newId}'s node_id or its files' current content. Pass --from <old_edge_id> if you know it ` +
        `(\`propagate why <id>\` shows any edge's history), or verify the new edge fresh.`,
      { to: describeRow(newRow) },
    );
  }
  return { ok: true, to: describeRow(newRow), candidates };
}
