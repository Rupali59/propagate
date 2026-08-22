/**
 * lib/edges/provenance.mjs — the one place that decides an event's
 * observed-ref and observed-position fields (D3/§2 of
 * docs/deferred/2026-08-20-two-tier-ref-aware-ledger.md).
 *
 * Before this module, `row.source.ref || "working-tree"` was written
 * verbatim at three call sites (cli.mjs:3449, cli.mjs:3514,
 * lib/edges/bootstrap.mjs:375) and collapsed two different situations into
 * one string:
 *
 *   resolved to a named ref     -> the ref               (fine)
 *   resolution genuinely FAILED -> also "working-tree"    (wrong)
 *
 * A failed lookup was indistinguishable from a successful working-tree
 * read — rule:discernment-checks §2 ("absence must be attributable"),
 * violated in the one field the two-tier ledger design depends on.
 * `resolveObservedRef` below is the single rule; all three call sites route
 * through it. Do not re-inline the `||` expression anywhere else.
 *
 * Reuse note (checked before writing this file): `resolveSide()` in
 * lib/edges/refs.mjs (~line 340) already resolves a path to `{ref, error}`,
 * exactly the shape this module needs — but it is a private, unexported
 * function, and it also drives `enumerateRefs()` (a full
 * `git for-each-ref` enumeration) that this narrower question doesn't need.
 * What `resolveSide()` itself reuses for the ref/error half is
 * `getGitContext()` (lib/core/git-context.mjs) — that primitive IS
 * exported, is exactly what both call sites need, and is reused here
 * directly rather than duplicated. `refs.mjs` is out of this lane's owned
 * files (W2/reconcile territory), so exporting `resolveSide()` itself was
 * not an option here.
 */

import { getGitContext } from "../core/git-context.mjs";

/** `by_kind` values a new event may carry (plan §2). */
export const BY_KINDS = Object.freeze(["human", "agent", "hook", "digest", "bootstrap"]);

/**
 * Decide `observed_on_ref` for one side of a declared edge — the shape
 * reconcile() already returns on `row.source` / `row.downstream`:
 * `{path: string, ref: string|null, ...}`.
 *
 * `side.ref` is the EXPLICIT ref the caller reconciled against (only ever
 * set when reconcile() is invoked with `--ref`/`--all-refs`; as of this
 * wedge every production call site reconciles the working tree, so
 * `side.ref` is always null today — see the deferred design's D9, not yet
 * wired). When it's set, it already IS the resolved ref: no git call
 * needed, and it is returned as-is.
 *
 * When absent, this is the implicit working-tree case. Rather than
 * ASSUMING "working-tree" the way the old expression did, this resolves
 * `side.path`'s current git context for real, so a genuine resolution
 * failure (corrupt repo, git missing from PATH, a git subprocess timeout)
 * can be told apart from an honest working-tree read.
 *
 * Three outcomes, never collapsed:
 * @param {{path?: string, ref?: string|null}} side
 * @returns {{observed_on_ref: string|null, observed_on_ref_error: string|null}}
 */
export function resolveObservedRef(side) {
  if (side && side.ref) {
    // Already resolved to a named ref by the caller.
    return { observed_on_ref: side.ref, observed_on_ref_error: null };
  }

  const filePath = side && side.path;
  if (!filePath) {
    // Nothing to resolve against — never invent a ref, but this also isn't
    // a failure; there is simply no path-scoped git state in play.
    return { observed_on_ref: "working-tree", observed_on_ref_error: null };
  }

  const { context, error } = getGitContext(filePath);
  if (error) {
    // A git subprocess genuinely failed. This must NEVER read the same as
    // a clean working-tree observation.
    return { observed_on_ref: null, observed_on_ref_error: error };
  }
  // context === null with no error: getGitContext's own documented
  // non-error case (filePath is legitimately outside any git repo), or a
  // resolved context with a null branch (detached HEAD, itself not an
  // error). Either way this is a genuine, un-failed working-tree read.
  return { observed_on_ref: "working-tree", observed_on_ref_error: null };
}

/**
 * `by_kind` for a new event. `PROPAGATE_BY_KIND` lets a wrapping hook,
 * agent, or the digest identify itself without this module — or its
 * callers — needing to enumerate every future caller; falls back to the
 * call site's own default when unset or not one of `BY_KINDS`.
 *
 * @param {string} defaultKind
 * @returns {string}
 */
export function resolveByKind(defaultKind) {
  const envKind = process.env.PROPAGATE_BY_KIND;
  if (envKind && BY_KINDS.includes(envKind)) return envKind;
  return defaultKind;
}

/**
 * Position + dirty-tree honesty (plan §2). Resolves the CURRENT git
 * position for `filePath` at the moment of the call — commit, branch,
 * dirty — via the same `getGitContext()` primitive `resolveObservedRef`
 * uses. `observed_dirty` is load-bearing: a dirty working tree means the
 * content actually hashed was never at `observed_at_commit`, so the commit
 * does NOT attribute the observation on its own — callers/readers must
 * check `observed_dirty` before treating `observed_at_commit` as precise.
 *
 * @param {string} filePath
 * @returns {{observed_at_commit: string|null, observed_on_branch: string|null, observed_dirty: boolean|null, observed_position_error: string|null}}
 */
export function resolveObservedPosition(filePath) {
  if (!filePath) {
    return {
      observed_at_commit: null,
      observed_on_branch: null,
      observed_dirty: null,
      observed_position_error: null,
    };
  }
  const { context, error } = getGitContext(filePath);
  if (!context) {
    return {
      observed_at_commit: null,
      observed_on_branch: null,
      observed_dirty: null,
      observed_position_error: error,
    };
  }
  return {
    observed_at_commit: context.sha,
    observed_on_branch: context.branch,
    observed_dirty: context.dirty,
    observed_position_error: null,
  };
}

/**
 * Convenience wrapper combining `resolveObservedRef`,
 * `resolveObservedPosition` and `resolveByKind` — the full set of
 * provenance fields one reconcile() row needs for a new event payload.
 * Each half is also exported individually above because the RED tests
 * exercise them independently (a failed ref lookup must not depend on
 * position resolution succeeding, and vice versa).
 *
 * BOTH SIDES, since 2026-08-22. An edge has two ends and the payload built
 * at every call site already pins two content hashes (`source_content` /
 * `downstream_content`); until this change the ref, commit, branch and
 * dirty-state described only `row.source`. For the ~13% of edges whose
 * sides live in different repos with independent branch lines, the
 * downstream hash was taken somewhere the ledger could not name. The two
 * sides are resolved INDEPENDENTLY — one failing must not contaminate the
 * other — and the source-side field names are unprefixed for continuity
 * with the 1,912 events already in the store:
 *
 *   observed_on_ref / observed_at_commit / …   -> the SOURCE side
 *   downstream_on_ref / downstream_at_commit / … -> the DOWNSTREAM side
 *
 * Both refs are always PRESENT (a string, or `null` on genuine failure —
 * never omitted, since `null` here is a meaningful fact, not an absence).
 * That distinction is load-bearing downstream: `validateEvent` checks key
 * presence rather than truthiness precisely because `null` is legal, and a
 * reader must be able to tell three things apart —
 *
 *   field absent      -> a pre-2026-08-22 event that never recorded it
 *   field === null    -> resolution genuinely failed (see the *_error)
 *   "working-tree"    -> an honest working-tree read
 *
 * The four `*_error` fields are diagnostic-only and are omitted entirely
 * when there is nothing to report, so a normal successful event doesn't
 * carry four permanent `null` columns.
 *
 * @param {{source?: {path?: string, ref?: string|null}, downstream?: {path?: string, ref?: string|null}}} row
 * @param {string} byKindDefault
 * @returns {{
 *   observed_on_ref: string|null, observed_on_ref_error?: string,
 *   observed_at_commit: string|null, observed_on_branch: string|null,
 *   observed_dirty: boolean|null, observed_position_error?: string,
 *   downstream_on_ref: string|null, downstream_on_ref_error?: string,
 *   downstream_at_commit: string|null, downstream_on_branch: string|null,
 *   downstream_dirty: boolean|null, downstream_position_error?: string,
 *   by_kind: string,
 * }}
 */
export function resolveProvenance(row, byKindDefault) {
  const sourceSide = row && row.source;
  const downstreamSide = row && row.downstream;

  const refResult = resolveObservedRef(sourceSide);
  const posResult = resolveObservedPosition(sourceSide && sourceSide.path);
  const dsRefResult = resolveObservedRef(downstreamSide);
  const dsPosResult = resolveObservedPosition(downstreamSide && downstreamSide.path);

  const out = {
    observed_on_ref: refResult.observed_on_ref,
    observed_at_commit: posResult.observed_at_commit,
    observed_on_branch: posResult.observed_on_branch,
    observed_dirty: posResult.observed_dirty,
    downstream_on_ref: dsRefResult.observed_on_ref,
    downstream_at_commit: dsPosResult.observed_at_commit,
    downstream_on_branch: dsPosResult.observed_on_branch,
    downstream_dirty: dsPosResult.observed_dirty,
    by_kind: resolveByKind(byKindDefault),
  };
  if (refResult.observed_on_ref_error) out.observed_on_ref_error = refResult.observed_on_ref_error;
  if (posResult.observed_position_error) out.observed_position_error = posResult.observed_position_error;
  if (dsRefResult.observed_on_ref_error) out.downstream_on_ref_error = dsRefResult.observed_on_ref_error;
  if (dsPosResult.observed_position_error) out.downstream_position_error = dsPosResult.observed_position_error;
  return out;
}
