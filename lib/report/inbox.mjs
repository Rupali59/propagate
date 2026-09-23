/**
 * inbox.mjs — the five divisions, from ONE reconcile pass.
 *
 * WHY DIVISIONS AND NOT TABS. The eight tabs this replaces are a taxonomy of
 * the places propagate READS FROM: queue, issues, todos, handovers, gotchas,
 * health, rules, graph. Nobody opens the page thinking "I'll do some
 * handovers"; they think "what is blocked on me?" — and no tab answered that.
 * These five divide by the item's relationship to the human instead, and every
 * one is derived from data that already existed:
 *
 *   READY         fixOrder items with nothing blocking them  -> the only writable one
 *   BLOCKED       fixOrder items with an unsettled ancestor  -> the writer refuses these
 *   PARKED        examined, judged, deliberately deferred    -> on no surface before now
 *   BASELINE GAP  never verified, split four ways            -> one number hid a third
 *                                                               that can never clear
 *   REFERENCE     registers, doctor, gotchas                 -> read-only, and looks it
 *
 * ONE PASS, NOT FIVE. `reconcile` is 865 ms over 1010 expanded edges, measured.
 * Five divisions each calling it would be ~4.3 s for one answer computed five
 * times. Everything below is derived from a single `rows`.
 *
 * PER-DIVISION FAILURE. A division that throws reports its own error and the
 * other four still render. The exception is `reconcile` itself: there is no
 * page without it, so that failure is the whole payload's. This matters because
 * an empty division renders as "nothing to do", which is the opposite of what a
 * crash means (`rule:discernment-checks` §6).
 *
 * WHAT IS DELIBERATELY *NOT* HERE. Two things are lazy, both because they cost
 * more than the entire rest of the page and neither is needed to decide what to
 * work on next:
 *
 *   checkRules                      831 ms   (measured)
 *   planBaseline(baseline-from-git) 1052 ms  (measured)
 *
 * Inlining them would take the page from ~620 ms to well over 2 s — worse than
 * the 1452 ms this module exists to fix. BASELINE GAP therefore ships its TOTAL
 * inline, which `planBaseline("none")` yields in 0 ms, and fetches the four-way
 * split on demand. `bucketsLazy: true` says so in the payload rather than
 * leaving a consumer to infer it from nulls.
 */

import { buildQueue, historyByEdge, orderFor, shortPath } from "./queue.mjs";
import { sideOf, HUB } from "./surface.mjs";

/**
 * Which side of the hub/workspace line an edge crosses.
 *
 * STAMPED SERVER-SIDE ON PURPOSE. This rule lived twice — once here and once
 * as a regex in the browser — so the contract about what the hub owns was
 * maintained in two languages. The client now reads `side` and `boundary` off
 * the payload and owns no copy of the rule (the N86 shape: two readers of one
 * fact, free to disagree, with nothing comparing them).
 */
export function boundaryOf(sourceAbs, downstreamAbs, root = "") {
  const a = sideOf(sourceAbs, root);
  const b = sideOf(downstreamAbs, root);
  if (a === HUB && b === HUB) return "hub-internal";
  if (a === HUB || b === HUB) return "crosses the line";
  return a || b || "elsewhere";
}

/**
 * Run `fn` and return its shape with an `error` field that is honest.
 *
 * TWO WAYS A DIVISION FAILS, AND ONLY ONE IS A THROW. `registerQueue` reports
 * its failures by RETURNING `{error, issues: null, todos: null}` — deliberately,
 * so a caller gets the shape it expects with the reason in it. A wrapper that
 * only catches throws therefore stamps `error: null` on a division that plainly
 * failed, and the page renders "nothing to do" over a crash.
 *
 * Caught live while building this: REFERENCE reported `error: null` and held
 * `backlogFn is required`. That is the same defect this whole module exists to
 * fix, one level down, written an hour after describing it — which is why the
 * check is structural here rather than a note telling each division to remember.
 *
 * So: a nested value carrying a truthy `.error` is hoisted. `sources` names
 * which one, because "REFERENCE failed" and "REFERENCE's register walk failed"
 * are different facts and only the second is fixable.
 *
 * NO CURRENT DIVISION EXERCISES THE HOIST — stated plainly rather than left to
 * be discovered. The one that did (REFERENCE) became lazy, and the three that
 * remain return arrays and scalars. It is kept because the next division to
 * wrap a sub-payload would otherwise reintroduce the exact bug it was written
 * for, and it is exported and tested directly so it is not a capability that
 * only looks present (`rule:enforcement-watches-itself`).
 */
export function division(fn, empty) {
  let out;
  try {
    out = fn();
  } catch (err) {
    // NEVER `{...empty}` with a populated list — see the header. The empty
    // shape here is all-null so a renderer cannot mistake it for a result.
    return { ...empty, error: String(err?.message ?? err), sources: null };
  }
  const nested = Object.entries(out)
    .filter(([, v]) => v && typeof v === "object" && typeof v.error === "string" && v.error)
    .map(([k, v]) => `${k}: ${v.error}`);
  return { ...out, error: nested.length ? nested.join("; ") : null, sources: nested.length ? nested : null };
}

/**
 * READY and BLOCKED: the two halves of the actionable set.
 *
 * They must sum to the actionable total. `unplaced` is carried rather than
 * assumed to be zero — both sides filter on `isActionable`, so a non-zero here
 * is a real join failure, and silently defaulting those rows into READY is
 * precisely how a division starts asserting something it never checked.
 */
export function splitWorklist(items) {
  const ready = items.filter((i) => i.blocked === false);
  const blocked = items.filter((i) => i.blocked === true);
  const unplaced = items.filter((i) => i.orderMissing !== null);
  return { ready, blocked, unplaced };
}

/**
 * PARKED — examined, judged, and deliberately deferred.
 *
 * `deferred` is a FLAG beside the state, not a ninth state: these rows still
 * read NEVER_VERIFIED, which is why `isActionable` drops them and why they have
 * been invisible everywhere except `status` and `bootstrap`. Someone read each
 * one, wrote a reason, and parked it; the system then stopped showing them.
 *
 * AGE, NOT A DUE DATE. How long a row has sat deferred is derivable from the
 * event. A revisit date is not recorded anywhere and inventing one would put a
 * number on screen that no file backs.
 */
export function parkedFrom(rows, root = "", now = Date.now()) {
  const out = [];
  for (const r of rows ?? []) {
    if (!r.deferred) continue;
    const ts = r.deferred.ts ?? r.deferred.at ?? null;
    const parsed = ts ? Date.parse(ts) : NaN;
    out.push({
      edge_id: r.edge_id,
      node_id: r.node_id,
      state: r.state,
      source: r.source?.path ?? null,
      downstream: r.downstream?.path ?? null,
      sourceShort: shortPath(r.source?.path, root),
      downstreamShort: shortPath(r.downstream?.path, root),
      boundary: boundaryOf(r.source?.path, r.downstream?.path, root),
      why: r.why ?? null,
      // The recorded human judgement. Null reason is reported as null, not as
      // an empty string — "deferred with no reason given" is a finding.
      reason: r.deferred.reason ?? null,
      by: r.deferred.by ?? null,
      since: ts,
      ageDays: Number.isFinite(parsed) ? Math.floor((now - parsed) / 86400000) : null,
    });
  }
  out.sort((a, b) => (b.ageDays ?? -1) - (a.ageDays ?? -1));
  return out;
}

/**
 * The payload. `deps` is injectable so this is testable without a filesystem.
 */
export async function inboxPayload(opts = {}) {
  const root = opts.root ?? "";
  const deps = opts.deps ?? (await defaultDeps());
  const now = opts.now ?? Date.now();

  // THE ONE PASS. A throw here is the whole page's, not a division's.
  let rows, stats;
  try {
    const workspaces = await deps.loadWorkspaces();
    ({ rows, stats } = await deps.reconcile(workspaces, {}));
  } catch (err) {
    return {
      fatal: `reconcile failed: ${String(err?.message ?? err)}`,
      divisions: null,
      generatedAt: new Date(now).toISOString(),
    };
  }

  const history = await deps.historyByEdge().catch(() => new Map());
  const order = orderFor(rows);
  const items = buildQueue(rows, history, { root, order }).map((i) => ({
    ...i,
    boundary: boundaryOf(i.source, i.downstream, root),
    side: sideOf(i.source, root),
  }));

  const worklist = division(() => {
    const { ready, blocked, unplaced } = splitWorklist(items);
    return { ready, blocked, unplaced: unplaced.length, actionable: items.length };
  }, { ready: null, blocked: null, unplaced: null, actionable: null });

  const parked = division(() => ({ items: parkedFrom(rows, root, now) }), { items: null });

  const gap = division(() => {
    // Policy "none" costs 0 ms and still classifies the deferred set out,
    // which is the only bucket PARKED needs. The other four require a git walk
    // per repo and are fetched separately — see the header.
    const { neverVerifiedCount, outcomes } = deps.planBaseline(rows, "none");
    return {
      total: neverVerifiedCount,
      deferred: outcomes.examinedAndDeferred.length,
      buckets: null,
      bucketsLazy: true,
    };
  }, { total: null, deferred: null, buckets: null, bucketsLazy: true });

  // REFERENCE IS LAZY TOO. Profiled 2026-09-21: registerQueue plus its backlog
  // walk is 188 ms of a 731 ms warm page — 26% — and it is the one division
  // nobody acts in. First paint is now the three you work in; handovers,
  // gotchas, doctor and rules all load when the division is opened.
  const reference = { registers: null, lazy: true, error: null, sources: null };

  return {
    fatal: null,
    divisions: { worklist, parked, gap, reference },
    declared: stats?.edges ?? null,
    expanded: stats?.expanded ?? rows.length,
    generatedAt: new Date(now).toISOString(),
  };
}

/**
 * REFERENCE, on demand. 188 ms, measured — a walk of every register in the tree.
 */
export async function referencePayload(opts = {}) {
  const deps = opts.deps ?? (await defaultDeps());
  try {
    const registers = deps.registerQueue();
    // registerQueue reports failure by RETURNING it, so the nested error is
    // hoisted here for the same reason `division` hoists it: an empty register
    // list renders as "nothing to do", which is the opposite of a crash.
    return { registers, error: registers?.error ?? null };
  } catch (err) {
    return { registers: null, error: String(err?.message ?? err) };
  }
}

/**
 * The four-way baseline split, on demand. 1052 ms, measured — a git walk per
 * repo, which is what distinguishes "no co-commit exists" from "we never
 * looked". The buckets are EXHAUSTIVE over the never-verified set and that is
 * asserted here rather than trusted: a bucket total that does not reconcile
 * with the whole would render as a backlog smaller than it is.
 */
export async function baselineBuckets(opts = {}) {
  const deps = opts.deps ?? (await defaultDeps());
  try {
    const workspaces = await deps.loadWorkspaces();
    const { rows } = await deps.reconcile(workspaces, {});
    const { outcomes, neverVerifiedCount } = deps.planBaseline(rows, "baseline-from-git", {
      bound: opts.bound,
    });
    const buckets = {
      baselineable: outcomes.baselined.length,
      noCoCommit: outcomes.noCoCommit.length,
      boundReached: outcomes.boundReached.length,
      // PERMANENT, and labelled as such. A cross-repo edge cannot have a
      // shared commit by construction — two independent histories — so this
      // slice of the backlog can never clear and must not read as work.
      ineligibleCrossRepo: outcomes.ineligibleCrossRepo.length,
      examinedAndDeferred: outcomes.examinedAndDeferred.length,
    };
    const sum = Object.values(buckets).reduce((a, b) => a + b, 0);
    return {
      buckets,
      total: neverVerifiedCount,
      // Never silently swallowed: if these disagree the division is showing a
      // backlog that does not add up to itself.
      accountedFor: sum === neverVerifiedCount,
      unaccounted: neverVerifiedCount - sum,
      permanent: buckets.ineligibleCrossRepo,
      error: null,
    };
  } catch (err) {
    return { buckets: null, total: null, accountedFor: null, error: String(err?.message ?? err) };
  }
}

export async function defaultDeps() {
  const { reconcile } = await import("../edges/reconcile.mjs");
  const { WORKSPACES } = await import("../core/config.mjs");
  const { planBaseline } = await import("../edges/bootstrap.mjs");
  const { registerQueue } = await import("../registers/queue.mjs");
  // backlogFn IS REQUIRED and registerQueue reports its absence by returning an
  // error rather than throwing — so omitting it yields an empty REFERENCE that
  // looks like "no registers in this tree". It was omitted here for exactly one
  // test run before `division` started hoisting nested errors and said so.
  const { backlog } = await import("./backlog.mjs");
  return {
    reconcile,
    loadWorkspaces: async () => WORKSPACES,
    planBaseline,
    registerQueue: () => registerQueue({ backlogFn: backlog }),
    historyByEdge,
  };
}
