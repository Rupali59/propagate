/**
 * states.mjs — the ONLY place an edge state is defined.
 *
 * Phase 1 of the graph model (#127, fixes #118). Before this file the same
 * eight state strings were re-spelled in `graph.mjs`, `status.mjs`,
 * `surface.mjs`, `inbox.mjs`, `ui.mjs`, `ui.client.js` and `bootstrap.mjs`,
 * each with its own idea of what a deferred edge was. The measured result
 * (#118): `status` said "10 deferred" while `graph` listed the same ten as
 * NEVER_VERIFIED and let them block their downstreams.
 *
 * PURE. No imports, no filesystem. A reader compares against these exports or
 * asks `actionOf`; a state string literal used in a comparison anywhere else
 * is caught by tests/unit/state-vocabulary-floor.test.mjs.
 */

/** The closed list. `reconcile` produces exactly these and nothing else. */
export const EDGE_STATES = Object.freeze([
  "CLEAN",
  "DRIFTED",
  "REVERSED",
  "DIVERGED",
  "NEVER_VERIFIED",
  "DEFERRED",
  "DECOUPLED",
  "UNMATCHED",
  "UNRESOLVABLE",
  "NOT_PRESENT_ON_REF",
]);

/**
 * States that mean "this edge is not settled" for ordering: an unsettled edge
 * blocks the verifications beneath it. DEFERRED and DECOUPLED are NOT here, by
 * design: a parked edge was examined and set aside, a decoupled one is no
 * longer a dependency, and neither may hold a downstream back (#118).
 */
export const UNSETTLED = Object.freeze(
  new Set(["DRIFTED", "REVERSED", "DIVERGED", "NEVER_VERIFIED", "UNRESOLVABLE"]),
);

/**
 * States that represent real movement someone should act on. NEVER_VERIFIED and
 * DEFERRED are deliberately NOT here: 447 baseline gaps would drown the edges
 * that moved. `fixOrder({includeUnverified: true})` opts both back in.
 */
export const ACTIONABLE = Object.freeze(new Set(["DRIFTED", "REVERSED", "DIVERGED", "UNMATCHED"]));

/**
 * Edge states, worst first. A node takes the worst state among its edges, and
 * `fixOrder` sorts by this rank rather than by name (N89: alphabetical and
 * severity disagree right after DIVERGED).
 */
export const DISPLAY_ORDER = Object.freeze([
  "DIVERGED",
  "REVERSED",
  "DRIFTED",
  "UNMATCHED",
  "UNRESOLVABLE",
  "NOT_PRESENT_ON_REF",
  "NEVER_VERIFIED",
  "DEFERRED",
  "DECOUPLED",
  "CLEAN",
]);

/** What a person does with an edge, one word each. The vocabulary every surface shows. */
export const ACTIONS = Object.freeze({
  JUDGE: "judge",
  PICK_A_SIDE: "pick-a-side",
  BLOCKED: "blocked",
  PARKED: "parked",
  NEVER_JUDGED: "never-judged",
  BROKEN: "broken",
  DONE: "done",
  UNKNOWN: "unknown",
});

/**
 * The state -> action table (graph-model plan, "State -> action"). `blocked` is
 * true when an unsettled ancestor holds the edge back; it only matters for the
 * three states a person could otherwise act on.
 *
 * An unrecognised state returns "unknown", never a guess: a state nobody has
 * mapped must stay visible, not fall into "done".
 *
 * @param {string} state
 * @param {boolean} [blocked]
 * @returns {string} one of ACTIONS
 */
export function actionOf(state, blocked = false) {
  switch (state) {
    case "DRIFTED":
    case "REVERSED":
      return blocked ? ACTIONS.BLOCKED : ACTIONS.JUDGE;
    case "DIVERGED":
      return blocked ? ACTIONS.BLOCKED : ACTIONS.PICK_A_SIDE;
    case "DEFERRED":
      return ACTIONS.PARKED;
    case "NEVER_VERIFIED":
      return ACTIONS.NEVER_JUDGED;
    case "UNMATCHED":
    case "UNRESOLVABLE":
    case "NOT_PRESENT_ON_REF":
      return ACTIONS.BROKEN;
    case "CLEAN":
    case "DECOUPLED":
      return ACTIONS.DONE;
    default:
      return ACTIONS.UNKNOWN;
  }
}
