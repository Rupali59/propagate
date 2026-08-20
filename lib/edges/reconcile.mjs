/**
 * reconcile.mjs — the derivation at the heart of v2.
 *
 * See /Users/rupali.b/.claude/plans/okay-i-dont-think-logical-haven.md
 * §3 (derived state, four live states + per-side context), §3b/§3c (the
 * spike that validated this), §4 (dispositions), §5c (glob expansion).
 *
 * THIS PHASE IS READ-ONLY. `reconcile()` derives and returns; it writes
 * nothing — no ledger, no store, no state.json. The only I/O is reading
 * sidecars off disk (via lib/edges.mjs / lib/frontmatter.mjs, same as v1),
 * reading the v2 event store (lib/events.mjs, foundation-only, not wired
 * into the watcher), and hashing file content (lib/content-id.mjs).
 *
 * The derivation, per edge, in a per-side context:
 *
 *   context = (source @ refA, downstream @ refB)   // each side its OWN repo
 *                                                   // both default to the working tree
 *   last    = the most recent PINNING event for this edge_id (deferred never pins)
 *   S1, D1  = current content ids of the two sides
 *
 *     no last                      -> NEVER_VERIFIED
 *     a side absent (not-found)    -> NOT_PRESENT_ON_REF
 *     S1=S0 & D1=D0                -> CLEAN
 *     S1≠S0 & D1=D0                -> DRIFTED     source moved; propagate forward
 *     S1=S0 & D1≠D0                -> REVERSED    downstream moved; code changed, doc didn't
 *     S1≠S0 & D1≠D0                -> DIVERGED    both moved independently; a human decides
 *
 * Two states the plan's six-state table doesn't name but the failure-modes
 * table (and §5c) require to never be silent:
 *
 *   UNMATCHED     — a glob downstream currently matches zero files. A glob is
 *                   a generator, not an edge (§5c); zero matches must be
 *                   reported, never make the edge vanish (open half of T2, G1/G2).
 *   UNRESOLVABLE  — a side failed to resolve for a reason OTHER than
 *                   "file doesn't exist" (no-repo, is-directory, lfs-pointer,
 *                   read-error). Distinct from NOT_PRESENT_ON_REF, which is
 *                   the normal, meaningful "this file doesn't exist at this
 *                   ref" case in the plan's own model.
 *
 * "You need the LAST pinning event per edge, not set membership." This
 * reduction keeps every field of the winning event (never v1's fold, which
 * copied one field and discarded the rest — see lib/events.mjs's module
 * doc and GOTCHAS.md). `wontfix` is a pinning disposition, so a later
 * content change re-arms the edge to DRIFTED — deliberate, tested (plan §9
 * verification #6).
 */

import path from "node:path";
import { globSync, realpathSync } from "node:fs";

import { findAllSidecarsRecursive } from "./edges.mjs";
import { loadSidecar, downstreamsFor } from "./frontmatter.mjs";
import { contentId, resolveRepo, hashMany } from "./content-id.mjs";
import { readEvents, edgeId } from "./events.mjs";

export const STATES = Object.freeze([
  "NEVER_VERIFIED",
  "NOT_PRESENT_ON_REF",
  "CLEAN",
  "DRIFTED",
  "REVERSED",
  "DIVERGED",
  "UNMATCHED",
  "UNRESOLVABLE",
]);

// A downstream `path` that contains glob metacharacters is a generator, not
// a concrete edge (plan §5c). Same test the watcher uses (watcher.mjs).
const GLOB_CHARS = /[*?[\]]/;

/**
 * `<repo-basename>:<repo-relative-path>` — same convention as
 * `correlationKey()` (lib/worktrees.mjs:298-321), reused for identity
 * consistency rather than reinvented. Falls back to the absolute path when
 * `absPath` isn't inside any repo (legitimate — a workspace-root doc, or
 * one of the (today: zero) non-git paths §2b's correction discusses) —
 * never thrown away, never invented as a repo it isn't in.
 *
 * @param {string} absPath
 * @returns {string}
 */
export function toNodeId(absPath) {
  const repoRoot = resolveRepo(absPath);
  if (!repoRoot) return absPath;
  const rel = path.relative(repoRoot, absPath) || ".";
  return `${path.basename(repoRoot)}:${rel}`;
}

/**
 * Reduce the event log to the latest PINNING event per edge_id — keeping
 * every field of the winning record (not v1's one-field fold; see module
 * doc). "deferred" never pins (lib/events.mjs's validateEvent enforces this
 * at write time), so it's excluded here by construction — a wontfix,
 * baselined, propagated, no-change-needed, source-corrected, or
 * both-reconciled event all pin and are eligible.
 *
 * @param {object[]} events
 * @returns {Map<string, object>} edge_id -> the latest pinning event, whole
 */
function reduceLastPinning(events) {
  const map = new Map();
  for (const e of events) {
    if (!e || e.disposition === "deferred") continue;
    const cur = map.get(e.edge_id);
    if (!cur || e.ts > cur.ts) map.set(e.edge_id, e);
  }
  return map;
}

/** Same reduction, but for `deferred` events only (never pins; §"Surface a later deferred"). */
function reduceLastDeferred(events) {
  const map = new Map();
  for (const e of events) {
    if (!e || e.disposition !== "deferred") continue;
    const cur = map.get(e.edge_id);
    if (!cur || e.ts > cur.ts) map.set(e.edge_id, e);
  }
  return map;
}

function bump(stats, state) {
  stats.byState[state] = (stats.byState[state] || 0) + 1;
}

/**
 * Enumerate every declared (source, downstream-pattern, why) triple across
 * the given workspaces — the GENERATORS, before glob expansion. Reuses
 * `findAllSidecarsRecursive`/`loadSidecar`/`downstreamsFor` exactly as
 * lib/edges.mjs does (GOTCHAS G14: reuse, don't re-parse YAML). A sidecar
 * that fails to load is skipped, never thrown — that failure is `doctor`'s
 * job to surface (Phase A: a bad sidecar must not disable reconcile any
 * more than it should disable the watcher).
 *
 * @param {{root: string}[]} workspaces
 * @param {(g: {sourceAbs: string, pattern: string, why: string, kind: string}) => boolean} [edgeFilter]
 * @returns {Promise<{sourceAbs: string, pattern: string, why: string, kind: string, sidecarDir: string}[]>}
 */
async function enumerateGenerators(workspaces, edgeFilter) {
  const workspaceRoots = workspaces.map((w) => w.root);
  const generators = [];
  for (const ws of workspaces) {
    const sidecarPaths = await findAllSidecarsRecursive(ws.root, workspaceRoots);
    for (const sidecarPath of sidecarPaths) {
      let sidecar;
      try {
        sidecar = await loadSidecar(sidecarPath);
      } catch {
        continue; // malformed sidecar: doctor's concern, not reconcile's (Phase A)
      }
      if (!sidecar || !sidecar.sources) continue;
      const sidecarDir = path.dirname(sidecarPath);
      for (const sourceKey of Object.keys(sidecar.sources)) {
        const downstreams = downstreamsFor(sidecar, sourceKey);
        const sourceAbs = path.resolve(sidecarDir, sourceKey);
        for (const d of downstreams) {
          const gen = { sourceAbs, pattern: d.path, why: d.why, kind: d.kind || "prose", sidecarDir };
          if (edgeFilter && !edgeFilter(gen)) continue;
          generators.push(gen);
        }
      }
    }
  }
  return generators;
}

/**
 * Expand each generator into one or more CONCRETE edges (plan §5c). A
 * literal path is already concrete (one edge). A glob fs-expands relative
 * to the sidecar dir, same `globSync`/`node_modules` filter the watcher
 * uses (watcher.mjs) so reconcile and the watcher agree on what a glob
 * matches. Zero matches -> ONE `unmatchedGlob` edge, carrying the pattern
 * as its own identity — it must be visible, never vanish (G1/G2, T2).
 *
 * @param {ReturnType<typeof enumerateGenerators> extends Promise<infer T> ? T : never} generators
 */
function expandGenerators(generators) {
  const expanded = [];
  for (const g of generators) {
    if (!GLOB_CHARS.test(g.pattern)) {
      expanded.push({ ...g, downstreamAbs: path.resolve(g.sidecarDir, g.pattern), glob: null, unmatchedGlob: false });
      continue;
    }
    let matches = [];
    try {
      matches = globSync(g.pattern, { cwd: g.sidecarDir }).filter((m) => !m.includes("node_modules/"));
    } catch {
      matches = [];
    }
    if (matches.length === 0) {
      expanded.push({ ...g, downstreamAbs: null, glob: g.pattern, unmatchedGlob: true });
      continue;
    }
    for (const m of matches) {
      expanded.push({ ...g, downstreamAbs: path.resolve(g.sidecarDir, m), glob: g.pattern, unmatchedGlob: false });
    }
  }
  return expanded;
}

/**
 * The derivation. Read-only: reads sidecars + the event store + file
 * content; writes nothing.
 *
 * Performance (G6, plan §6b): batches per repo, never per file/edge. When
 * neither `refs.source` nor `refs.downstream` is given (the common case —
 * both sides default to the working tree), every content id is resolved
 * through ONE `hashMany()` call over the full deduplicated path set, so
 * `git ls-files -s` / `git status --porcelain` each run once per repo no
 * matter how many edges reference it. Explicit refs fall back to per-call
 * `contentId(path, {ref})` (one `git ls-tree` + one `git cat-file` per
 * resolution) — accepted because ref-pinned reconciliation is the rarer,
 * deliberate case, not the hot path this file's perf budget targets.
 *
 * @param {{root: string}[]} workspaces
 * @param {{
 *   refs?: {source?: string, downstream?: string},
 *   edgeFilter?: (g: {sourceAbs: string, pattern: string, why: string, kind: string}) => boolean,
 * }} [opts]
 * @returns {Promise<{
 *   rows: Array<{
 *     node_id: string, edge_id: string,
 *     source: {path: string, ref: string|null, contentId: string|null, unresolvable: string|null},
 *     downstream: {path: string|null, ref: string|null, contentId: string|null, unresolvable: string|null},
 *     state: string, since: string|null, last: object|null, deferred: object|null,
 *     glob: string|null, kind: string, why: string,
 *     sameRepo: boolean|null, unresolvable: string|null,
 *   }>,
 *   stats: {byState: Record<string, number>, edges: number, expanded: number, unresolvable: number, durationMs: number},
 * }>}
 */
export async function reconcile(workspaces, opts = {}) {
  const t0 = Date.now();
  const { refs = {}, edgeFilter } = opts;
  const sourceRef = refs.source || null;
  const downstreamRef = refs.downstream || null;
  const refFree = !sourceRef && !downstreamRef;

  const stats = { byState: {}, edges: 0, expanded: 0, unresolvable: 0, durationMs: 0 };

  const [{ events }, generators] = await Promise.all([
    readEvents(),
    enumerateGenerators(workspaces, edgeFilter),
  ]);
  stats.edges = generators.length;

  const lastPin = reduceLastPinning(events);
  const lastDeferred = reduceLastDeferred(events);

  const expanded = expandGenerators(generators);
  stats.expanded = expanded.length;

  // Batch-hash the working-tree case (G6's non-negotiable): one pass over
  // every unique path this reconcile touches, grouped per repo inside
  // hashMany itself. Ref-pinned resolution can't share this cache (a
  // different ref means different bytes), so it resolves per-call below.
  let batched = null;
  if (refFree) {
    const uniquePaths = new Set();
    for (const e of expanded) {
      uniquePaths.add(e.sourceAbs);
      if (e.downstreamAbs) uniquePaths.add(e.downstreamAbs);
    }
    batched = hashMany(Array.from(uniquePaths));
  }

  function resolve(absPath, ref) {
    if (!ref && batched) return batched.get(absPath);
    return contentId(absPath, ref ? { ref } : {});
  }

  const rows = [];
  for (const e of expanded) {
    const nodeId = toNodeId(e.sourceAbs);

    if (e.unmatchedGlob) {
      const edgeIdVal = edgeId(nodeId, e.glob, e.why);
      rows.push({
        node_id: nodeId,
        edge_id: edgeIdVal,
        source: { path: e.sourceAbs, ref: sourceRef, contentId: null, unresolvable: null },
        downstream: { path: null, ref: downstreamRef, contentId: null, unresolvable: "unmatched-glob" },
        state: "UNMATCHED",
        since: null,
        last: null,
        deferred: null,
        glob: e.glob,
        kind: e.kind,
        why: e.why,
        sameRepo: null,
        unresolvable: "unmatched-glob",
      });
      bump(stats, "UNMATCHED");
      stats.unresolvable++;
      continue;
    }

    const edgeIdVal = edgeId(nodeId, e.downstreamAbs, e.why);
    const sourceRepo = resolveRepo(e.sourceAbs);
    const downstreamRepo = resolveRepo(e.downstreamAbs);
    const sameRepo = Boolean(sourceRepo && downstreamRepo && sourceRepo === downstreamRepo);

    const sRes = resolve(e.sourceAbs, sourceRef);
    const dRes = resolve(e.downstreamAbs, downstreamRef);

    let state;
    let unresolvableReason = null;
    const last = lastPin.get(edgeIdVal) || null;

    if (sRes.unresolvable || dRes.unresolvable) {
      // "a side absent" per the plan's own table: the normal, meaningful
      // case is the file genuinely not existing at this ref/working tree.
      // Anything else (no-repo, is-directory, lfs-pointer, read-error) is a
      // DIFFERENT kind of failure and must not be reported the same way.
      const reason = sRes.unresolvable === "not-found" || dRes.unresolvable === "not-found"
        ? "not-found"
        : sRes.unresolvable || dRes.unresolvable;
      unresolvableReason = sRes.unresolvable || dRes.unresolvable;
      state = reason === "not-found" ? "NOT_PRESENT_ON_REF" : "UNRESOLVABLE";
      stats.unresolvable++;
    } else if (!last) {
      state = "NEVER_VERIFIED";
    } else {
      const sChanged = sRes.id !== last.source_content;
      const dChanged = dRes.id !== last.downstream_content;
      if (!sChanged && !dChanged) state = "CLEAN";
      else if (sChanged && !dChanged) state = "DRIFTED";
      else if (!sChanged && dChanged) state = "REVERSED";
      else state = "DIVERGED";
    }

    const deferredEvent = lastDeferred.get(edgeIdVal) || null;
    const deferredAfterPin = deferredEvent && (!last || deferredEvent.ts > last.ts) ? deferredEvent : null;

    rows.push({
      node_id: nodeId,
      edge_id: edgeIdVal,
      source: {
        path: e.sourceAbs,
        ref: sourceRef,
        contentId: sRes.id,
        unresolvable: sRes.unresolvable,
      },
      downstream: {
        path: e.downstreamAbs,
        ref: downstreamRef,
        contentId: dRes.id,
        unresolvable: dRes.unresolvable,
      },
      state,
      since: last ? last.ts : null,
      last,
      deferred: deferredAfterPin,
      glob: e.glob,
      kind: e.kind,
      why: e.why,
      sameRepo,
      unresolvable: unresolvableReason,
    });
    bump(stats, state);
  }

  stats.durationMs = Date.now() - t0;
  return { rows, stats };
}

/**
 * Group already-reconciled rows for human-facing display and for `verify`'s
 * `--glob`/`--node` selection (plan §5c, §3c: "grouped output shows one
 * header per group with its member count and states, so a human sees '1
 * decision, 20 members' instead of 20 rows"). Pure and read-only — takes
 * `reconcile()`'s own output and groups it; derives nothing new.
 *
 * "glob" groups by the declaring generator (`row.glob`) — the §5c case: one
 * globbed source expanding to ~20 files is one decision, not 20. "node"
 * groups by `row.node_id` — the parallel-coordination case (§7's `verify
 * --node`): every edge sharing the same logical node collapses to one
 * header. Rows with no value for the chosen key (e.g. `glob: null` on a
 * literal, non-glob edge) are never dropped — they come back in
 * `ungrouped`, same discipline as G1/G2 (absence must be visible, not
 * silently folded away).
 *
 * "none" (the default) is a pass-through: `groups` is empty and every row
 * comes back in `ungrouped`, so existing callers that don't pass
 * `groupBy` see byte-identical behaviour to before this function existed.
 *
 * @param {Array} rows - reconcile()'s output rows
 * @param {"glob"|"node"|"none"} [groupBy]
 * @returns {{
 *   groups: Array<{key: string, count: number, states: Record<string, number>, rows: Array}>,
 *   ungrouped: Array,
 * }}
 */
export function groupRows(rows, groupBy = "none") {
  if (groupBy !== "glob" && groupBy !== "node") {
    return { groups: [], ungrouped: rows };
  }
  const keyOf = groupBy === "glob" ? (r) => r.glob : (r) => r.node_id;

  const map = new Map(); // key -> rows[]
  const ungrouped = [];
  for (const r of rows) {
    const key = keyOf(r);
    if (!key) {
      ungrouped.push(r);
      continue;
    }
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  }

  const groups = [...map.entries()].map(([key, rs]) => {
    const states = {};
    for (const r of rs) states[r.state] = (states[r.state] || 0) + 1;
    return { key, count: rs.length, states, rows: rs };
  });

  return { groups, ungrouped };
}

/**
 * `realpath` when the path exists, else `path.resolve` — never throws. Two
 * different repo-boundary bugs in this codebase both trace back to comparing
 * un-resolved paths (B1's orphaned ledger; G4's "key by realpath" rule): a
 * worktree or a symlinked directory makes one physical repo reachable by
 * several path strings, and a plain `startsWith` prefix check silently
 * misses the ones that don't match byte-for-byte.
 *
 * @param {string} p
 * @returns {string}
 */
function realOrResolved(p) {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * The delivery query (plan Part 2, "the inbound view is a filter, not new
 * computation"): edges whose downstream lives inside `repoRoot` and whose
 * source arrives from somewhere else. Nothing today tells a person working
 * in the downstream repo that an upstream file changed underneath them —
 * this is the read that answers it, applied as a pure filter over
 * `reconcile()`'s own rows (which already carry absolute paths on both
 * sides plus `sameRepo`).
 *
 * Deliberately NOT keyed off `row.sameRepo` — that flag answers "do the two
 * sides resolve to the same git repo", which is a different (coarser)
 * question than "is the downstream physically under this directory". A
 * same-repo edge whose downstream sits under `repoRoot` is correctly
 * excluded either way (its source is also under `repoRoot`), so the two
 * framings agree on every case that matters; this one is chosen because it
 * matches the plan's own definition verbatim and needs nothing from
 * `resolveRepo` beyond what `realOrResolved` already gives it.
 *
 * `repoRoot` is resolved by realpath before comparison, and so is every
 * candidate path — a worktree or a symlinked checkout must not create a
 * blind spot the way it did for B1's orphaned ledger.
 *
 * @param {Array} rows - reconcile()'s output rows
 * @param {string} repoRoot - absolute path to the repo to filter for (a
 *   symlink or worktree path is fine — resolved internally)
 * @returns {Array} the subset of `rows` inbound to `repoRoot`
 */
export function inboundRows(rows, repoRoot) {
  const root = realOrResolved(repoRoot);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;

  function isUnder(p) {
    if (!p) return false;
    const real = realOrResolved(p);
    return real === root || real.startsWith(prefix);
  }

  return rows.filter((r) => isUnder(r.downstream.path) && !isUnder(r.source.path));
}
