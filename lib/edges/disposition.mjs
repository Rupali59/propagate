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

import { resolveProvenance, resolveExecution } from "./provenance.mjs";
import { DISPOSITIONS } from "./events.mjs";

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
 * @param {{outOfOrder?: boolean, bypassed?: string[]}} [opts] - ISSUES N70
 */
export function buildEventPayload(row, disposition, reason, by, opts = {}) {
  const payload = {
    edge_id: row.edge_id,
    node_id: row.node_id,
    disposition,
    by: by || process.env.USER || "verify",
    ...resolveProvenance(row, "human"),
    // `by_kind` above is who DECIDED; these two are who EXECUTED and in which
    // session -- see resolveExecution.
    ...resolveExecution(),
  };
  // N70 (S1). `--out-of-order` overrides a refusal that exists because pinning
  // a downstream against an unconfirmed source records a verification nobody
  // performed -- and until now the override was discarded at the moment it was
  // created. `status` then showed CLEAN for a forced edge and an ordinary one
  // alike, so the ledger could not answer "which of these were forced?", which
  // is the first question `rule:adversarial-review-reads-the-ledger` asks.
  //
  // Written ONLY when true: a `false` on every ordinary event would be noise on
  // 2771 rows to carry information about seven, and absence already reads as
  // "not forced" unambiguously.
  if (opts.outOfOrder) {
    payload.out_of_order = true;
    // The upstreams that were unsettled AT THE TIME. "It was forced" is weaker
    // than "it was forced past these", and only the second survives as evidence
    // once those upstreams resolve and stop looking like blockers.
    if (opts.bypassed && opts.bypassed.length) payload.bypassed_upstreams = opts.bypassed;
  }
  if (reason !== undefined) payload.reason = reason;
  if (disposition !== "deferred") {
    payload.source_content = row.source.contentId;
    payload.downstream_content = row.downstream.contentId;
  }
  return payload;
}

// ─────────────────────────────────────────────────────────────────────────────
// WHICH DISPOSITIONS AN EDGE MAY ACCEPT — one predicate, three callers.
//
// `verify` enforced two guards inline (the DIVERGED pairing above, and an
// ordering guard in cli.mjs), `lib/report/queue.mjs` computed its own `allowed`
// from the DIVERGED rule alone, and the UI trusted the queue's list. So for a
// BLOCKED edge the queue offered options the CLI would then refuse — a button
// that always errors. The ordering half had no home at all: `GUARD_EXEMPT` was
// a literal inside `verifyCmd`.
//
// `allowedDispositions` is DERIVED from the two guards rather than restating
// them, so a caller that asks "what may this edge take" and a caller that asks
// "may it take THIS" cannot disagree: both are the same two predicates.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dispositions the ordering guard lets through even when the edge's own source
 * is unsettled.
 *
 *   deferred   — pins nothing; validateEvent refuses content on it, so there is
 *                no pair to pin wrongly.
 *   decoupled  — removes the edge; removal cannot be out of order.
 * NOT exempt: wontfix and baselined both pin, and a baseline against an
 * unverified source is precisely the claim `validateEvent` already refuses to
 * let masquerade as a verification.
 */
export const GUARD_EXEMPT = Object.freeze(new Set(["deferred", "decoupled"]));

/** Dispositions that must carry a typed reason (validateEvent enforces the same pair). */
export const REASON_REQUIRED = Object.freeze(new Set(["wontfix", "baselined"]));

/**
 * The ordering guard, as a predicate: does this disposition pin against a
 * source that is itself unsettled? `blockers` is `blockedBy(graph, edge_id)`.
 */
export function orderingBlocks(blockers, disposition) {
  return Array.isArray(blockers) && blockers.length > 0 && !GUARD_EXEMPT.has(disposition);
}

/**
 * What an edge may be settled with.
 *
 * - `allowed`      — accepted as-is: passes the DIVERGED pairing and the ordering guard.
 * - `viaOutOfOrder`— passes the DIVERGED pairing and is refused ONLY by the ordering
 *                    guard, so `--out-of-order` is the (deliberate) route to it.
 * - `needsReason`  — the members of `allowed` + `viaOutOfOrder` that require a reason.
 *
 * `baselined` is included wherever `verify` accepts it (every non-DIVERGED edge).
 *
 * @param {{state: string}} row
 * @param {Array<object>} blockers - unsettled upstream edges, from `blockedBy`
 * @returns {{allowed: string[], viaOutOfOrder: string[], needsReason: string[], blocked: boolean}}
 */
export function allowedDispositions(row, blockers = []) {
  const allowed = [];
  const viaOutOfOrder = [];
  for (const d of DISPOSITIONS) {
    if (divergedGuard(row.state, d)) continue;
    if (orderingBlocks(blockers, d)) viaOutOfOrder.push(d);
    else allowed.push(d);
  }
  return {
    allowed,
    viaOutOfOrder,
    needsReason: [...allowed, ...viaOutOfOrder].filter((d) => REASON_REQUIRED.has(d)),
    blocked: Array.isArray(blockers) && blockers.length > 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE COMMAND A REFUSAL POINTS AT. Always `--edge`, never `--glob`: `--glob` is
// exact equality on a field that is null for every literal-path edge (G74), so
// a printed `--glob` command selects nothing. A reason is shell-quoted — a
// reason is prose, and prose contains quotes, `$` and backticks.
// ─────────────────────────────────────────────────────────────────────────────

/** POSIX single-quote a string so it survives a shell as ONE argument. */
export function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * The exact `verify` invocation for one edge.
 *
 * @param {{edge: string, disposition: string, reason?: string, outOfOrder?: boolean, apply?: boolean}} o
 */
/**
 * The reason slot in every printed `verify` command. It names what a reason must
 * CONTAIN rather than standing for "a reason": a reason is a claim, nothing checks
 * it, and on 2026-10-02 three were written ahead of the check they asserted ("read
 * both sides, they agree") -- one of them closing two edges wrongly, twice. Asking
 * for `file:line` at the moment of writing makes a reason with no evidence look
 * empty. One constant, so settle and the refusal hints cannot drift apart.
 */
export const REASON_PLACEHOLDER = "<what you checked, as file:line>";
export const REASON_PLACEHOLDER_BOTH = "<what you checked on both sides, as file:line>";

export function verifyCommand({ edge, disposition, reason, outOfOrder = false, apply = true }) {
  const parts = ["propagate", "verify", "--edge", edge, "--disposition", disposition];
  if (reason !== undefined) parts.push("--reason", shellQuote(reason));
  if (outOfOrder) parts.push("--out-of-order");
  if (apply) parts.push("--apply");
  return parts.join(" ");
}

/**
 * The DIVERGED refusal for a caller that can print a command: the guard's own
 * message (which keeps "a human must look at both sides first") followed by the
 * corrected invocation, so the refusal is the next step rather than a dead end.
 */
export function divergedRefusal(row, disposition) {
  const base = divergedGuard(row.state, disposition);
  if (!base) return null;
  if (row.state !== "DIVERGED") return base;
  const cmd = verifyCommand({
    edge: row.edge_id,
    disposition: "both-reconciled",
    reason: REASON_PLACEHOLDER_BOTH,
  });
  return `${base}\n  after looking at both sides, run: ${cmd}`;
}
