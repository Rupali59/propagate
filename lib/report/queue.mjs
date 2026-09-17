/**
 * queue.mjs — the disposition backlog, modelled as a work queue.
 *
 * WHY THIS IS A QUEUE AND NOT A REPORT. Every actionable edge is already a task:
 * it has an id, a state, a specific thing to read, and exactly one completion
 * action (`verify --edge <id> --disposition <d>`). Nothing had to be invented to
 * make it one. The separate `~/.claude/pending-queue.json` runner queue is a
 * DIFFERENT thing — unattended Claude pickup — and has been empty and unloaded
 * since 2026-07-29; this module deliberately does not touch it.
 *
 * WHAT IT ADDS OVER `status` / `graph`: per-row history and a noise signal.
 * N85 measured that 83% of edges with >=4 dispositions are majority
 * `no-change-needed`, so a queue that shows only "42 actionable" reproduces in a
 * window the exact problem the terminal already has. Each row therefore carries
 * how many times it has been judged and how often the answer was "nothing" —
 * which is the number that tells a reader whether to look hard or look fast.
 *
 * Derivation only. Prints nothing, writes nothing, opens no socket.
 */

import { readEvents } from "../edges/events.mjs";
import { isActionable } from "../graph/graph.mjs";

/** Workspace-qualified, middle-elided. Same discriminator problem the monitor
 *  notification had: 53 files in this tree are named `CLAUDE.md`. */
export function shortPath(abs, root) {
  if (!abs) return "(glob)";
  const base = root ? (root.endsWith("/") ? root : root + "/") : "";
  const rel = base && abs.startsWith(base) ? abs.slice(base.length) : abs;
  const parts = rel.split("/").filter(Boolean);
  if (parts.length <= 3) return parts.join("/");
  return `${parts[0]}/…/${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

/**
 * Per-edge disposition history, keyed by edge_id.
 *
 * Built from the event store in ONE pass rather than per row — the store is
 * ~2800 events and the actionable set is ~44, so a per-row read would be 44
 * full scans for one answer each.
 */
export async function historyByEdge() {
  // readEvents returns `{ events, malformed }` — NOT a bare array. The malformed
  // count is deliberately surfaced rather than swallowed: "no history" and "the
  // store has unreadable lines" are different facts (`rule:discernment-checks` §2).
  const { events, malformed } = await readEvents({});
  const map = new Map();
  map.malformed = malformed ?? 0;
  for (const e of events ?? []) {
    if (!e?.edge_id) continue;
    const h = map.get(e.edge_id) ?? { total: 0, noChange: 0, last: null, lastVerified: null, dispositions: [] };
    h.total += 1;
    if (e.disposition === "no-change-needed") h.noChange += 1;
    h.dispositions.push({ ts: e.ts, disposition: e.disposition, by: e.by, reason: e.reason ?? null });
    if (!h.last || String(e.ts) > String(h.last.ts)) h.last = { ts: e.ts, disposition: e.disposition, reason: e.reason ?? null };

    // THE COMMIT THE SOURCE SAT AT WHEN THIS WAS LAST JUDGED — the one piece of
    // data that makes real evidence derivable, and it was already being walked
    // past. Collected in the SAME pass rather than a second read of a
    // ~2900-event store.
    //
    // The raw field is `observed_at_commit`. `why` renders a composed
    // `position.commit`, and reading THAT name off a raw event reports zero for
    // every edge -- a plausible number produced entirely by the ruler
    // (rule:discernment-checks section 4).
    if (e.observed_at_commit && (!h.lastVerified || String(e.ts) > String(h.lastVerified.ts))) {
      h.lastVerified = { ts: e.ts, commit: e.observed_at_commit, dirty: !!e.observed_dirty, branch: e.observed_on_branch ?? null };
    }
    map.set(e.edge_id, h);
  }
  return map;
}

/**
 * The queue: one entry per actionable edge, newest-judged last.
 *
 * `noiseRatio` is null — never 0 — when an edge has no history. "Never judged"
 * and "judged and always a no-op" are different facts and a 0 would assert the
 * second (`rule:discernment-checks` §2). The UI renders them differently.
 */
export function buildQueue(rows, history, opts = {}) {
  const root = opts.root ?? "";
  const items = (rows ?? [])
    .filter((r) => isActionable(r.state))
    .map((r) => {
      const h = history?.get?.(r.edge_id) ?? null;
      const total = h?.total ?? 0;
      return {
        edge_id: r.edge_id,
        node_id: r.node_id,
        state: r.state,
        source: r.source?.path ?? null,
        downstream: r.downstream?.path ?? null,
        sourceShort: shortPath(r.source?.path, root),
        downstreamShort: shortPath(r.downstream?.path, root),
        why: r.why ?? null,
        judgedCount: total,
        noiseRatio: total > 0 ? (h.noChange / total) : null,
        last: h?.last ?? null,
        // Null when this edge has never been judged -- which the evidence reader
        // reports as "no commit to compare against", NOT as "nothing changed".
        lastVerified: h?.lastVerified ?? null,
        // Which dispositions this row may legally accept. The UI must not offer a
        // control that the write path will refuse — a button that always errors is
        // worse than an absent one.
        allowed: r.state === "DIVERGED" ? ["both-reconciled"] : ALLOWED_NON_DIVERGED,
      };
    });
  // Heaviest history last: an edge judged nine times and always "no" is the one a
  // reader should spend least on, so it should not sit at the top of the list.
  items.sort((a, b) => (a.noiseRatio ?? -1) - (b.noiseRatio ?? -1) || a.judgedCount - b.judgedCount);
  return items;
}

const ALLOWED_NON_DIVERGED = Object.freeze([
  "propagated",
  "no-change-needed",
  "source-corrected",
  "decoupled",
  "deferred",
  "wontfix",
]);

/** Counts for the header, each a distinct fact rather than one blended total. */
export function queueSummary(items) {
  const byState = {};
  for (const i of items) byState[i.state] = (byState[i.state] ?? 0) + 1;
  const judged = items.filter((i) => i.judgedCount > 0);
  const neverJudged = items.length - judged.length;
  const highNoise = judged.filter((i) => i.noiseRatio >= 0.5).length;
  return { total: items.length, byState, neverJudged, judged: judged.length, highNoise };
}

/**
 * The full payload: items + summary + the declared total.
 *
 * A denominator is carried so a consumer can say "nothing actionable" WITHOUT it
 * reading as "nothing declared" — an empty queue over 1003 edges and an empty
 * queue over zero edges are different facts (`rule:discernment-checks` §2), and
 * a widget showing a bare 0 cannot distinguish them.
 *
 * TWO DENOMINATORS, BECAUSE THERE ARE TWO NUMBERS. This function used to return
 * `declared: rows.length`, and `rows` is the GLOB-EXPANDED set. So every
 * renderer said "of 1003 declared" while the sidecars actually declare **493**
 * — `reconcile` reports both, as `stats.edges` and `stats.expanded`. That is
 * exactly the compare-unlike-things failure `rule:discernment-checks` §5 names,
 * and the one N85 was corrected for. `declared` now means declared.
 *
 * `declared` is kept as a key rather than renamed away so an older consumer
 * reading it gets the RIGHT number instead of a silent `undefined` — a rename
 * would turn a wrong label into a missing value, which reads as "not measured".
 */
export async function queuePayload(opts = {}) {
  const deps = opts.deps ?? (await defaultDeps());
  const workspaces = await deps.loadWorkspaces();
  const { rows, stats } = await deps.reconcile(workspaces, {});
  const history = await historyByEdge();
  const items = buildQueue(rows, history, { root: opts.root });
  return {
    items,
    summary: queueSummary(items),
    declared: stats?.edges ?? null,
    expanded: stats?.expanded ?? rows.length,
    generatedAt: new Date().toISOString(),
  };
}

export async function defaultDeps() {
  const { reconcile } = await import("../edges/reconcile.mjs");
  // WORKSPACES is a resolved constant, not a function — config.mjs runs discovery
  // once at import. `verify` uses the same value, so the UI, the widget and the
  // CLI cannot disagree about what the graph contains (the N86 shape).
  const { WORKSPACES } = await import("../core/config.mjs");
  return { reconcile, loadWorkspaces: async () => WORKSPACES };
}
