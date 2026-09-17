/**
 * disposition.mjs — the ONE place a disposition event is built and gated.
 *
 * WHY THIS MODULE EXISTS. `buildEventPayload` and `divergedGuard` lived in
 * `cli.mjs`, which was fine while `verify` was the only writer. It no longer is:
 * `commands/ui.mjs` writes dispositions too. A lib importing `cli.mjs` inverts
 * the dependency and would cycle, so the alternative was a second payload
 * builder in the UI — and two writers constructing the same event separately is
 * precisely the shape this repo keeps finding and filing (N86: one contract,
 * two divergent implementations, five weeks apart).
 *
 * So the seam moved DOWN rather than being duplicated sideways. `cli.mjs` and
 * the UI both import from here; neither owns it.
 *
 * WHAT IS DELIBERATELY NOT HERE. The `--apply` gate. That is a property of each
 * CALLER's contract with its user — the CLI is dry-run by default (N27's fix),
 * the UI's button is the confirmation — and hiding it in a shared builder would
 * make the guard invisible at both call sites. `rule:safety-flag-needs-a-test`:
 * the unsafe path must be named where it is reached.
 */

import { resolveProvenance } from "./provenance.mjs";

/**
 * Refuse a disposition that the edge's state cannot accept.
 *
 * `both-reconciled` is the ONLY disposition that may follow a DIVERGED edge, and
 * it may ONLY follow one — it asserts a human looked at BOTH sides, which is a
 * claim no other disposition makes and one nothing can verify after the fact.
 *
 * @param {string} state - the edge's current derived state
 * @param {string} disposition
 * @returns {string|null} a refusal message, or null when the pairing is allowed
 */
export function divergedGuard(state, disposition) {
  if (state === "DIVERGED" && disposition !== "both-reconciled") {
    return (
      `edge is DIVERGED — both source and downstream changed independently since the last ` +
      `verification. Only "both-reconciled" may resolve a DIVERGED edge (a human must look at ` +
      `both sides first); nothing was verified.`
    );
  }
  if (disposition === "both-reconciled" && state !== "DIVERGED") {
    return `"both-reconciled" only applies to a DIVERGED edge; this edge is ${state}.`;
  }
  return null;
}

/**
 * Build the event a disposition writes.
 *
 * `deferred` deliberately omits the content pair: deferring means "examined, not
 * resolved", so pinning the current bytes would re-baseline the edge and the
 * next real change would read as the first one. Every other disposition pins,
 * because every other disposition is a claim that THIS content was judged.
 *
 * @param {object} row - a reconcile() row
 * @param {string} disposition
 * @param {string} [reason]
 * @param {string} [by] - defaults to $USER; the UI passes its own label
 */
export function buildEventPayload(row, disposition, reason, by) {
  const payload = {
    edge_id: row.edge_id,
    node_id: row.node_id,
    disposition,
    by: by || process.env.USER || "verify",
    ...resolveProvenance(row, "human"),
  };
  if (reason !== undefined) payload.reason = reason;
  if (disposition !== "deferred") {
    payload.source_content = row.source.contentId;
    payload.downstream_content = row.downstream.contentId;
  }
  return payload;
}
