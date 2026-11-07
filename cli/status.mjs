/**
 * status.mjs — the `propagate status` command family.
 *
 * Last of the T5 extractions, and a family for the same reason drain was: the
 * dispatcher calls `status`, which itself calls `statusJson` for --json, and
 * both rest on `coverageFrom`, `relToWs` and `isMoved`. None of those
 * four has another caller, so all five moved together and none became a lib
 * export for the sake of it.
 *
 * `currentWorkspace` and `formatAge`/`rowAgeMs` went to lib/ ahead of this
 * (config.mjs and edges/ledger.mjs), because those ARE shared — `status` and
 * `drain` both use them, and a helper two families need belongs to neither.
 *
 * FIVE BRANCHES, all verified against a stashed HEAD rather than one of them:
 * bare, --json, --all, --cross, and `--all --json` — which is not redundant,
 * because --all wins over --json and produces the human table, not one line of
 * JSON. Extracting `docs` and `drain` each shipped a broken branch that the
 * default path did not reveal.
 *
 * Import prefix is `../lib/…` from here. G60.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { execSync, execFileSync } from "node:child_process";

import { RESET, DIM, RED, GREEN, YELLOW, BOLD } from "./ansi.mjs";
import {
  WORKSPACES,
  SEARCH_ROOTS_DIAGNOSTIC,
  CROSS_LEDGER_JSONL,
  searchRootsExplain,
  currentWorkspace,
  HEARTBEAT_PATH,
  STATE_PATH,
  LAUNCHD_ACTIVE,
  SEARCH_ROOTS,
  DISCOVERY_DEGRADED,
  SUSPICIOUS_MARKERS,
} from "../lib/core/config.mjs";
import { LABEL as LAUNCHD_LABEL, heartbeatState } from "../lib/core/plist.mjs";
import {
  readLedger,
  readLedgerByEra,
  findUnownedLedgers,
  classifyUnownedLedger,
  formatAge,
  LEDGER_SCHEMA,
  readLedgerWithStats,
  lastActivityAt,
  openCount,
} from "../lib/edges/ledger.mjs";
import { reconcile } from "../lib/edges/reconcile.mjs";
import { ACTIONS, actionOf } from "../lib/edges/states.mjs";
import { buildGraph, blockedBy } from "../lib/graph/graph.mjs";


/**
 * Bucket reconcile's rows into the numbers `status` leads with.
 *
 * Every edge lands in exactly one bucket and the buckets sum to the total —
 * asserted in tests/cli/status-coverage.test.mjs, because a bucket that silently
 * drops a state is how a real row stayed invisible for two months (ISSUES N1).
 * An unrecognised state is therefore COUNTED as unevaluable and named, never
 * skipped: a state we do not understand is not a pass.
 *
 * `deferred` is its own bucket, split out of `never_verified` (ISSUES N71).
 * `state === "NEVER_VERIFIED"` means "no PINNING event" (reconcile.mjs's
 * `last`), but a row can carry a `deferred` event beside that — someone
 * looked at it and deliberately parked it with a reason, which is not the
 * same fact as "nobody has looked." Those rows must not be described as a
 * baseline gap or pointed at `bootstrap`: N71 measured 31 such edges, every
 * one examined and parked on 2026-09-10, none a gap `bootstrap` should be
 * filling. (Whether `lib/edges/bootstrap.mjs`'s `planBaseline` itself
 * excludes deferred rows from what it will act on is a separate, unverified
 * question — it filters on `state === "NEVER_VERIFIED"` alone, with no
 * `deferred` check visible at the point this was written, so the remediation
 * text here may be undoing less than it claims. That is `status`'s wording,
 * not `bootstrap`'s behaviour, and out of this fix's scope.)
 *
 * `ok` is deliberately strict — it requires full coverage, not merely the
 * absence of known problems. The defect this replaces was `✓ no open drift
 * events`, which a tree nobody had ever verified printed just as readily as a
 * fully-checked one. Full coverage is achievable rather than aspirational
 * (PanditPawanKaushik drove CLEAN 380 -> 516 in one pass), and a missing tick
 * costs nothing: `status` has no red state and exits 0 either way.
 */




/**
 * Watcher liveness block for `status --json`. Derives `state` ONLY from the
 * heartbeat file — never from ledger content (see heartbeatState doc comment).
 */
async function watcherJsonBlock() {
  let heartbeatMs = null;
  let ageSeconds = null;
  if (existsSync(HEARTBEAT_PATH)) {
    const raw = (await readFile(HEARTBEAT_PATH, "utf8")).trim();
    const ts = parseInt(raw, 10);
    if (Number.isFinite(ts)) {
      heartbeatMs = ts;
      ageSeconds = Math.floor((Date.now() - ts) / 1000);
    }
  }
  // Only ask launchd when launchd is the configured scheduler AND this is macOS.
  // Elsewhere the answer is "not configured", which is a different fact from "not
  // loaded" — and shelling out to a binary that cannot exist is how an optional
  // component starts reading as a broken one.
  let launchdLoaded = false;
  if (LAUNCHD_ACTIVE) {
    try {
      const out = execSync("launchctl list", { encoding: "utf8" });
      launchdLoaded = out.split("\n").some((l) => l.includes(LAUNCHD_LABEL));
    } catch {
      launchdLoaded = false;
    }
  }
  let trackedFiles = 0;
  if (existsSync(STATE_PATH)) {
    try {
      const parsed = JSON.parse(await readFile(STATE_PATH, "utf8"));
      trackedFiles = Object.keys(parsed.mtimes || {}).length;
    } catch {
      /* leave 0 */
    }
  }
  return {
    heartbeatMs,
    ageSeconds,
    state: heartbeatState(ageSeconds),
    launchdLoaded,
    trackedFiles,
  };
}

/**
 * Ledger-derived status block, shared shape for a workspace and for cross.
 * `quietDays` derives ONLY from ledger content (lastActivityAt) — never
 * combined with watcher heartbeat (see docs/DECISIONS.md discovery-partition
 * entry: a quiet ledger on a healthy watcher is a distinct, valid state).
 */
async function ledgerJsonBlock(jsonlPath) {
  // null => no hub declared, so there is no cross-ledger path to test. Asking
  // existsSync(null) is the DEP0187 warning that review 2026-08-23 caught.
  const exists = jsonlPath !== null && jsonlPath !== undefined && existsSync(jsonlPath);
  const { rows, malformed, unknownTypes } = exists
    ? await readLedgerWithStats(jsonlPath)
    : { rows: [], malformed: 0, unknownTypes: {}, manual: [] };
  const open = rows.filter((r) => r.status === "open");
  const done = rows.filter((r) => r.status === "done");
  const wontfix = rows.filter((r) => r.status === "wontfix");
  const lastActivityIso = exists ? await lastActivityAt(jsonlPath) : null;
  const quietDays = lastActivityIso
    ? Math.floor((Date.now() - new Date(lastActivityIso).getTime()) / (1000 * 60 * 60 * 24))
    : null;
  return {
    counts: { total: rows.length, open: open.length, done: done.length, wontfix: wontfix.length },
    lastActivityIso,
    quietDays,
    malformed,
    unknownTypes,
    openRows: open.map((r) => ({
      id: r.id,
      source: r.source ?? null,
      change: r.change ?? null,
      downstream: r.downstream ?? [],
      correlation_id: r.correlation_id ?? null,
    })),
  };
}

/** Root of the nearest ancestor workspace, or null. */
export function nestedUnderOf(ws, workspaces) {
  const ancestors = workspaces.filter(
    (o) => o.root !== ws.root && (ws.root === o.root || ws.root.startsWith(o.root + path.sep)),
  );
  if (ancestors.length === 0) return null;
  const nearest = ancestors.reduce((best, o) => (o.root.length > best.root.length ? o : best));
  return nearest.root;
}

// DRIFTED / REVERSED / DIVERGED, whether or not an ancestor blocks them. Derived from the
// shared state -> action table (states.mjs), not re-spelled here.
const isMoved = (state) => {
  const a = actionOf(state);
  return a === ACTIONS.JUDGE || a === ACTIONS.PICK_A_SIDE;
};

/**
 * Exported for direct testing (ISSUES N70's `forced` count). The CLI fixture
 * used by tests/cli/verify-flags.test.mjs has no ledger file, so `status`
 * short-circuits with "(no ledger file yet)" before it ever reaches this
 * function -- an output-level assertion there passed for the wrong reason,
 * which is worse than failing. Testing the counter directly is the honest
 * version: it is where the distinction is actually made.
 */
export function coverageFrom(rows) {
  const byState = {};
  let verified = 0, actionable = 0, never_verified = 0, cannot_evaluate = 0, deferred = 0;
  // The action buckets (graph-model plan, "State -> action"): every edge lands in exactly one.
  const by = { done: 0, judge: 0, pickASide: 0, blocked: 0, parked: 0, neverJudged: 0, broken: 0, unknown: 0 };
  // ISSUES N70. A CLEAN edge whose last verification was FORCED past an
  // unsettled source is a weaker claim than an ordinary CLEAN, and until the
  // event carried `out_of_order` the two rendered identically -- so the ledger
  // could not answer "which of these were forced?", which is the first thing
  // `rule:adversarial-review-reads-the-ledger` says to ask before trusting a
  // green result. Counted WITHIN verified, not beside it: it is still verified,
  // just on a weaker footing, and splitting it out would overstate the problem.
  let forced = 0;
  const unknown_states = {};

  // Blocked is a graph query (an unsettled ancestor), so it needs the graph over
  // these rows. Built once; blockedBy walks it per moved edge.
  const graph = buildGraph(rows);
  const isBlocked = (r) => blockedBy(graph, r.edge_id).length > 0;

  for (const r of rows) {
    const s = r.state;
    byState[s] = (byState[s] || 0) + 1;
    const moved = isMoved(s);
    const action = actionOf(s, moved && isBlocked(r));
    if (s === "CLEAN") {
      verified++;
      // `last` is the whole event (lib/edges/reconcile.mjs's reduceLastPinning
      // stores it verbatim), so the field is here with no fold change.
      if (r.last?.out_of_order) forced++;
    }
    // `deferred` is its own bucket (N71, #118): reconcile now says DEFERRED for an
    // edge whose only verdict is a deferral, so no `row.deferred` re-derivation here.
    switch (action) {
      case ACTIONS.DONE: by.done++; break;
      case ACTIONS.JUDGE: by.judge++; actionable++; break;
      case ACTIONS.PICK_A_SIDE: by.pickASide++; actionable++; break;
      case ACTIONS.BLOCKED: by.blocked++; actionable++; break;
      case ACTIONS.PARKED: by.parked++; deferred++; break;
      case ACTIONS.NEVER_JUDGED: by.neverJudged++; never_verified++; break;
      case ACTIONS.BROKEN: by.broken++; cannot_evaluate++; break;
      default:
        // Not silently dropped. Counted where it cannot be mistaken for clean.
        by.unknown++;
        cannot_evaluate++;
        unknown_states[s] = (unknown_states[s] || 0) + 1;
    }
  }
  const edges = rows.length;
  return {
    edges, verified, actionable, never_verified, cannot_evaluate, deferred, forced,
    // The action vocabulary, one word per bucket; sums with `unknown` to `edges`.
    done: by.done, judge: by.judge, pick_a_side: by.pickASide, blocked: by.blocked,
    parked: by.parked, never_judged: by.neverJudged, broken: by.broken, unknown: by.unknown,
    byState, unknown_states,
    // deferred keeps `ok` false too — "examined, not resolved" is still
    // outstanding, just not a baseline gap and not what `bootstrap` fixes.
    ok: edges > 0 && actionable === 0 && cannot_evaluate === 0
      && never_verified === 0 && deferred === 0,
  };
}

function relToWs(ws, abs) {
  if (!abs) return "(unresolved)";
  return abs.startsWith(ws.root) ? abs.slice(ws.root.length).replace(/^\//, "") : abs;
}

/**
 * propagate#122. Verification pins CONTENT, not a branch, so after a checkout of a sibling branch a
 * settled edge reads DRIFTED / REVERSED / DIVERGED with nothing saying it is a branch effect. The
 * pinning event already records the branch each side was observed on (`observed_on_branch`,
 * `downstream_on_branch`), and reconcile puts that whole event on `row.last`. This compares those with
 * the branch checked out NOW. Attribution only: no edge state, fold or event field changes.
 *
 * `currentBranchOf(absPath)` returns the branch name, "" for a detached HEAD, or null when it cannot be
 * read. Absence is attributable (rule:discernment-checks section 2): an event without a branch field
 * (older events, or verified on a detached HEAD) or an unreadable repo counts as `unknown`, never as a
 * match. A detached HEAD now is reported as currentBranch "detached", never as a match either.
 *
 * @returns {{otherBranch: {edge_id: string, verifiedOn: string, currentBranch: string, side: "source"|"downstream"|"both"}[], unknown: number, moved: number}}
 */
// `repoOf(absPath)` names the repo an edge lives in, so the text can say WHOSE branch moved. The hub reports edges
// from every workspace, and "you are on X" printed to someone on the hub's `main` named another repo's branch
// (measured 2026-11-07: Keerti/retail-restock-fiori on issue-61-shared-standards). Optional: it defaults to the
// production branch function's own `repoOf`, else null.
export function branchAttribution(rows, currentBranchOf, repoOf = currentBranchOf?.repoOf) {
  const otherBranch = [];
  let unknown = 0, moved = 0;
  for (const r of rows) {
    if (!isMoved(r.state) || !r.last) continue;
    moved++;
    const sides = [
      ["source", r.last.observed_on_branch, r.source?.path],
      ["downstream", r.last.downstream_on_branch, r.downstream?.path],
    ];
    const differing = [];
    let resolvedAll = true;
    for (const [side, verifiedOn, absPath] of sides) {
      if (typeof verifiedOn !== "string" || !verifiedOn || !absPath) { resolvedAll = false; continue; }
      let cur = null;
      try { cur = currentBranchOf(absPath); } catch { cur = null; }
      if (cur === null || cur === undefined) { resolvedAll = false; continue; }
      const currentBranch = cur === "" ? "detached" : cur;
      if (currentBranch !== verifiedOn) differing.push({ side, verifiedOn, currentBranch });
    }
    if (differing.length === 0) {
      // Not attributed: "same branch" and "could not tell" are different facts, only the latter is counted.
      if (!resolvedAll) unknown++;
      continue;
    }
    const first = differing[0];
    let repo = null;
    try { repo = repoOf ? (repoOf(first.side === "source" ? r.source?.path : r.downstream?.path) ?? null) : null; } catch { repo = null; }
    otherBranch.push({
      edge_id: r.edge_id,
      repo,
      verifiedOn: first.verifiedOn,
      currentBranch: first.currentBranch,
      side: differing.length === 2 ? "both" : first.side,
    });
  }
  return { otherBranch, unknown, moved };
}

/** Production `currentBranchOf`: one `git rev-parse --show-toplevel` per directory, one `branch --show-current` per repo. Never throws. */
export function makeCurrentBranchOf() {
  const rootOf = new Map();
  const branchOf = new Map();
  const git = (cwd, args) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  const rootFor = (absPath) => {
    const dir = path.dirname(absPath);
    if (!rootOf.has(dir)) rootOf.set(dir, git(dir, ["rev-parse", "--show-toplevel"]));
    return rootOf.get(dir);
  };
  const fn = (absPath) => {
    try {
      const root = rootFor(absPath);
      if (!branchOf.has(root)) branchOf.set(root, git(root, ["branch", "--show-current"]));
      return branchOf.get(root);
    } catch {
      return null;
    }
  };
  // The same cached root lookup, so naming the repo costs no extra git call.
  fn.repoOf = (absPath) => {
    try { return rootFor(absPath); } catch { return null; }
  };
  return fn;
}

/**
 * The status text lines for branchAttribution, grouped by repo, then verifiedOn -> currentBranch. Empty when nothing
 * is attributed. Names the REPO whose branch moved, never "you": the reader may be on another repo entirely.
 */
export function branchAttributionLines(attr, cwd = process.cwd()) {
  const groups = new Map();
  for (const o of attr.otherBranch) {
    const k = `${o.repo ?? ""}\u0000${o.verifiedOn}\u0000${o.currentBranch}`;
    groups.set(k, (groups.get(k) || 0) + 1);
  }
  const label = (repo) => {
    if (!repo) return "their repo";
    const rel = path.relative(cwd, repo);
    return rel === "" ? "this repo" : rel.startsWith("..") ? repo : rel;
  };
  return [...groups].map(([k, n]) => {
    const [repo, from, to] = k.split("\u0000");
    return `${n} of ${attr.moved} in ${label(repo)} were last verified on ${from}; that repo is now on ${to}. ` +
      `Settling them there now would pin ${to}'s content (GOTCHAS G87).`;
  });
}

async function statusJson() {
  const watcher = await watcherJsonBlock();
  const workspaces = [];
  for (const ws of WORKSPACES) {
    const ledgerBlock = await ledgerJsonBlock(ws.ledgerJsonl);
    workspaces.push({
      name: ws.name,
      root: ws.root,
      ledgerJsonl: ws.ledgerJsonl,
      nestedUnder: nestedUnderOf(ws, WORKSPACES),
      ...ledgerBlock,
    });
  }
  const crossLedgerBlock = await ledgerJsonBlock(CROSS_LEDGER_JSONL);
  const cross = {
    name: "cross",
    root: SEARCH_ROOTS[0],
    ledgerJsonl: CROSS_LEDGER_JSONL,
    nestedUnder: null,
    ...crossLedgerBlock,
  };
  // Derived state, not ledger rows. The v1 ledger is frozen history; the
  // question "is anything wrong" is answered by reconcile against content.
  const { rows: reconcileRows } = await reconcile(WORKSPACES);
  const cov = coverageFrom(reconcileRows);
  const { moved: _moved, ...branch_attribution } = branchAttribution(reconcileRows, makeCurrentBranchOf());

  return {
    generatedAt: new Date().toISOString(),
    degraded: DISCOVERY_DEGRADED,
    suspiciousMarkers: SUSPICIOUS_MARKERS,
    watcher,
    workspaces,
    cross,
    ...cov,
    // Additive (propagate#122): which moved edges were last verified on another branch than the one checked out.
    branch_attribution,
  };
}

export async function status() {
  // A fresh machine used to reach the end of this function having printed
  // NOTHING, and exit 0 — indistinguishable from a clean tree, which is the
  // failure this skill exists to catch (lib/config.mjs:33-38 predicted it).
  // Non-zero exit, because "I found nothing because I was pointed nowhere" is
  // not a healthy state and must not be scriptable as one.
  if (SEARCH_ROOTS_DIAGNOSTIC !== "ok" && !process.argv.includes("--json")) {
    console.error(`${RED}✗ no workspaces${RESET} — ${searchRootsExplain()}`);
    process.exitCode = 1;
    return;
  }
  if (process.argv.includes("--json")) {
    const obj = await statusJson();
    console.log(JSON.stringify(obj));
    return;
  }
  if (process.argv.includes("--cross")) {
    const { CROSS_LEDGER_JSONL } = await import("../lib/core/config.mjs");
    const rows = (await readLedger(CROSS_LEDGER_JSONL)).filter((r) => r.status === "open");
    console.log(`${BOLD}# Cross-repo — ${rows.length} open${RESET}`);
    for (const r of rows) {
      console.log(`  #${r.id} [${r.direction}] ${r.origin_repo} → ${r.partner}: ${r.source} → ${(r.downstream || []).map((d) => d.path).join(", ")}`);
    }
    return;
  }
  // Default: only THIS project's queue (the workspace containing cwd). `--all`
  // relays every workspace. Cross-repo dependencies still surface below.
  const showAll = process.argv.includes("--all");
  const cur = currentWorkspace();
  const targets = showAll || !cur ? WORKSPACES : [cur];
  for (const ws of targets) {
    const scopeTag =
      !showAll && cur ? `  ${DIM}(this project — --all for every workspace)${RESET}` : "";
    console.log(`${BOLD}# ${ws.name}${RESET}${scopeTag}`);
    if (!existsSync(ws.ledgerJsonl)) {
      console.log(`  ${DIM}(no ledger file yet)${RESET}\n`);
      continue;
    }
    // ── derived state first ────────────────────────────────────────────────
    // The v1 ledger below is FROZEN history. "Is anything wrong" is answered by
    // reconcile against current content, and the coverage counts print on every
    // run so a verdict can never be read without the sample it rests on.
    const { rows: recRows } = await reconcile([ws]);
    const cov = coverageFrom(recRows);
    console.log(
      `  ${cov.edges} edges · ${cov.done} done` +
        // N70: only when there ARE forced ones. A `0 forced` on every clean
        // tree is noise that teaches people to skip the line.
        (cov.forced ? ` ${DIM}(${cov.forced} forced)${RESET}` : "") +
        ` · ${cov.judge} judge · ${cov.pick_a_side} pick a side · ${cov.blocked} blocked · ` +
        `${cov.parked} parked · ${cov.never_judged} never judged · ${cov.broken} broken` +
        (cov.unknown ? ` · ${YELLOW}${cov.unknown} unrecognised${RESET}` : "") +
        (cov.ok ? `  ${GREEN}✓${RESET}` : ""),
    );

    if (cov.actionable > 0) {
      const act = recRows.filter((r) => isMoved(r.state));
      console.log(`\n  ${YELLOW}needs attention (${act.length})${RESET}`);
      for (const r of act.slice(0, 10)) {
        const src = relToWs(ws, r.source?.path);
        const dst = relToWs(ws, r.downstream?.path);
        console.log(`    ${r.state.padEnd(9)} ${src} → ${dst}`);
      }
      if (act.length > 10) {
        console.log(`    ${DIM}… and ${act.length - 10} more — \`graph\` prints the fix order${RESET}`);
      }
      for (const line of branchAttributionLines(branchAttribution(recRows, makeCurrentBranchOf()))) {
        console.log(`  ${YELLOW}${line}${RESET}`);
      }
    }
    if (cov.cannot_evaluate > 0) {
      // Never folded into clean: this is a question we failed to answer.
      const un = recRows.filter((r) => {
        const a = actionOf(r.state);
        return a === ACTIONS.BROKEN || a === ACTIONS.UNKNOWN;
      });
      console.log(`\n  ${YELLOW}cannot evaluate (${un.length})${RESET} ${DIM}— not a pass${RESET}`);
      for (const r of un.slice(0, 5)) {
        console.log(`    ${r.state.padEnd(19)} ${relToWs(ws, r.source?.path)}`);
      }
      if (Object.keys(cov.unknown_states).length) {
        console.log(`    ${YELLOW}unrecognised state(s): ${Object.keys(cov.unknown_states).join(", ")}${RESET}`);
      }
    }
    if (cov.never_verified > 0) {
      console.log(
        `\n  ${DIM}never judged (${cov.never_judged}) — a baseline gap, not drift. ` +
          `\`bootstrap\` to triage.${RESET}`,
      );
    }
    if (cov.deferred > 0) {
      // NOT a baseline gap (N71): these edges carry a deferred event, so
      // someone already looked and parked them with a reason. Never offered
      // `bootstrap` — that remediation is for edges nobody has examined.
      console.log(
        `\n  ${DIM}parked (${cov.parked}) — examined, not resolved. ` +
          `\`why <edge>\` for the reason.${RESET}`,
      );
    }

    // ── v1, as history ─────────────────────────────────────────────────────
    // CLASSIFIED BY THE DECLARED ERA, not by `open.length === 0`. That
    // inference made "frozen history" and "nothing happens to be open right
    // now" render IDENTICALLY — one open event turned settled history back into
    // a worklist. See lib/edges/freeze-ledger.mjs for why the freeze relocates.
    const rows = await readLedger(ws.ledgerJsonl);
    const open = rows.filter((r) => r.status === "open");
    const era = await readLedgerByEra(ws.ledgerJsonl);
    if (open.length === 0) {
      if (era.v1.length) {
        console.log(
          `\n  ${DIM}frozen: ${era.v1.length} v1 event(s) in archive/ — history, not a worklist${RESET}`,
        );
      }
      // An UNFROZEN ledger is a different fact from a frozen one, and from an
      // empty one. Saying "frozen" here would be the original defect restated.
      if (era.refused.length) {
        console.log(
          `\n  ${YELLOW}${era.refused.length} line(s) declare no schema ${LEDGER_SCHEMA}${RESET}` +
            `${DIM} — not yet frozen. \`freeze-ledger --workspace <ws> --apply\`.${RESET}`,
        );
      }
      if (era.current.length) {
        console.log(`\n  ${DIM}${era.current.length} schema-${LEDGER_SCHEMA} event(s), none open${RESET}`);
      }
      console.log("");
      continue;
    }
    const bySource = new Map();
    for (const r of open) {
      const src = r.source || "(unknown source)";
      if (!bySource.has(src)) bySource.set(src, []);
      bySource.get(src).push(r);
    }
    const proseCount = open.filter((r) => r.type !== "code_drift").length;
    const codeCount = open.filter((r) => r.type === "code_drift").length;
    const breakdown =
      codeCount > 0 && proseCount > 0
        ? ` (${proseCount} drift, ${codeCount} code drift)`
        : codeCount > 0
          ? " (all code drift)"
          : "";
    console.log(
      `  ${YELLOW}${open.length}${RESET} open event${open.length === 1 ? "" : "s"}${breakdown}:\n`,
    );
    for (const [src, items] of bySource) {
      console.log(`  ${BOLD}${src}${RESET}`);
      for (const r of items) {
        const isCodeDrift = r.type === "code_drift";
        const kindTag = isCodeDrift
          ? ` ${YELLOW}[code drift — verify upstream]${RESET}`
          : "";
        const graphTag = r.pending_graph_augment
          ? ` ${DIM}[needs graph-augment]${RESET}`
          : "";
        console.log(`    ${YELLOW}#${r.id}${RESET}  ${r.change}${kindTag}${graphTag}`);
        for (const d of r.downstream || []) {
          const arrow = isCodeDrift ? "↑" : "→";
          console.log(`      ${DIM}${arrow} ${d.path}  (${d.kind}: ${d.why})${RESET}`);
        }
        if (r.notes) console.log(`      ${DIM}notes: ${r.notes}${RESET}`);
      }
      console.log();
    }
  }

  // `--all` means the whole project, so it must include the cross-repo ledger and
  // a total. Before 2026-08-15 it iterated discovered workspaces only: the cross
  // ledger was reachable via `status --cross` and read by digest.mjs, but never
  // counted here, so `--all` reported 4 open where the tree had 8.
  if (showAll) {
    let crossOpen = [];
    try {
      crossOpen = (await readLedger(CROSS_LEDGER_JSONL)).filter((r) => r.status === "open");
    } catch {
      /* no cross ledger — reported as 0 below, not silently omitted */
    }
    console.log(`${BOLD}# Cross-repo${RESET}`);
    if (crossOpen.length === 0) {
      console.log(`  ${GREEN}✓ no open cross-repo rows${RESET}\n`);
    } else {
      console.log(`  ${YELLOW}${crossOpen.length}${RESET} open:\n`);
      for (const r of crossOpen) {
        console.log(
          `    ${YELLOW}#${r.id}${RESET} [${r.direction}] ${r.origin_repo} → ${r.partner}: ${r.source}`,
        );
      }
      console.log();
    }

    // Rollup. Counts are FOLDED (last status per id), never raw `open` lines —
    // the ledger is append-only, so line-counting gave 501 where the truth was 8.
    let wsOpen = 0;
    let ledgerCount = 1; // cross
    for (const ws of WORKSPACES) {
      if (!existsSync(ws.ledgerJsonl)) continue;
      ledgerCount++;
      wsOpen += await openCount(ws.ledgerJsonl);
    }
    // CROSS_LEDGER_JSONL is null when no hub is configured — it is derived from
    // the hub, and an unconfigured hub is a VALUE, not a path. Feeding that null
    // to findUnownedLedgers threw `paths[0] must be of type string`, which the
    // catch below reported under the WRONG check name ("no unreachable workspace
    // markers"), so a config problem read as a marker problem.
    const ownedLedgers = [...WORKSPACES.map((w) => w.ledgerJsonl), CROSS_LEDGER_JSONL].filter(Boolean);
    const unowned = await findUnownedLedgers(SEARCH_ROOTS, ownedLedgers);
    const orphans = [];
    const snapshots = [];
    for (const p of unowned) {
      const c = await classifyUnownedLedger(p, ownedLedgers);
      (c.kind === "snapshot" ? snapshots : orphans).push({ p, ...c });
    }
    // Snapshots are branch-time copies of an owned ledger — counting their stale
    // `open` rows would over-report exactly as badly as ignoring them under-reported.
    const unownedOpen = orphans.reduce((n, o) => n + o.openRows, 0);

    const total = wsOpen + crossOpen.length + unownedOpen;
    console.log(
      `${BOLD}${WORKSPACES.length} workspace${WORKSPACES.length === 1 ? "" : "s"} + cross — ${total} open across ${ledgerCount + unowned.length} ledger${ledgerCount + unowned.length === 1 ? "" : "s"}${RESET}`,
    );
    if (orphans.length) {
      // Named, not hidden: these rows are real and no command can act on them.
      console.log(
        `  ${YELLOW}⚠ ${orphans.length} ledger file(s) owned by no workspace${RESET} ${DIM}(${unownedOpen} of the open rows above; \`doctor\` names them)${RESET}`,
      );
      for (const o of orphans) console.log(`    ${DIM}${o.p}${RESET}`);
    }
    for (const s of snapshots) {
      console.log(
        `  ${DIM}· branch snapshot, not counted: ${s.p} (${s.openRows} stale open row(s))${RESET}`,
      );
    }
    console.log();
  }

  // "Unless there is a dependency": in scoped mode, surface open cross-repo rows
  // whose origin repo lives inside THIS workspace (this project's outbound deps).
  if (!showAll && cur) {
    let crossRows = [];
    try {
      const { CROSS_LEDGER_JSONL } = await import("../lib/core/config.mjs");
      crossRows = (await readLedger(CROSS_LEDGER_JSONL)).filter((r) => r.status === "open");
    } catch {
      /* no cross ledger */
    }
    const mine = crossRows.filter(
      (r) => r.origin_repo && existsSync(path.join(cur.root, r.origin_repo)),
    );
    if (mine.length) {
      console.log(
        `${BOLD}# Cross-repo dependencies (${mine.length})${RESET}  ${DIM}(propagate status --cross for detail)${RESET}`,
      );
      for (const r of mine) {
        console.log(`  ${YELLOW}#${r.id}${RESET} ${r.origin_repo} → ${r.partner}: ${r.source}`);
      }
      console.log();
    }
  }
}
