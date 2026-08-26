#!/usr/bin/env node
/**
 * /propagate CLI — status, doctor, init, check.
 *
 * Usage:
 *   node cli.mjs status         — open rows for THIS project (the workspace at cwd)
 *   node cli.mjs status --all   — every workspace's queue
 *   node cli.mjs status --cross — the cross-repo ledger
 *   node cli.mjs doctor         — health check
 *   node cli.mjs rules <list|check|selftest|promote> [--json]
 *                                            — canonical-rules lifecycle: which CLAUDE.md files
 *                                              RESTATE a rule instead of referencing it. `check`
 *                                              exits non-zero when it scanned NOTHING, not only
 *                                              when it found something.
 *   node cli.mjs setup [--roots <a>[:<b>]] [--force] [--json]
 *                                            — install-time bootstrap: write ~/.propagate/config.yml
 *                                              and REFUSE to report success unless discovery then
 *                                              finds >=1 workspace. Distinct from `init` (one
 *                                              sidecar) and `bootstrap` (baseline edges).
 *   node cli.mjs release --check [--json]
 *                                            — runs the four release gates (docs/RELEASE.md):
 *                                              VERSION/manifests agree, suite green, `make-public
 *                                              --check`, stranger install. Publishes nothing —
 *                                              there is no --apply; a human runs step 5 by hand.
 *   node cli.mjs init <dir> [--workspace|--edges-only]
 *                               — scaffold a `.propagates.yml` marker. --workspace (default)
 *                                 writes `workspace: true` (a ledger-owning root) and verifies
 *                                 discovery can see it, failing loudly if not; --edges-only
 *                                 writes today's sourceless template (an edge-only sidecar).
 *                                 Does NOT touch the plist or launchd — run `reload` after.
 *   node cli.mjs reload         — regenerate the plist from discovered workspaces + reload launchd
 *                                 (refuses to write a plist with 0 watch roots)
 *   node cli.mjs check --changed          — commit-time drift gate: warn on coupled files
 *                                            (working tree + staged, vs HEAD)
 *   node cli.mjs check --range <a>..<b>   — same, over an explicit git range (CI)
 *   node cli.mjs check --staged           — staged files only (pre-commit use)
 *   node cli.mjs check ... --strict       — exit 1 (not 0) when couplings are found
 *   node cli.mjs check ... --json         — machine-readable result (couplings + exit code)
 *                                            Also prints inbound cross-repo drift as an
 *                                            ADVISORY (never affects exitCode — the gate stays
 *                                            flagged off; plan Part 2).
 *   node cli.mjs drain                    — list open rows, grouped by correlation_id (read-only)
 *   node cli.mjs drain --all              — every workspace's queue
 *   node cli.mjs drain --close <id>[,<id>...] --status <done|wontfix|partial>
 *                      [--reason "..."] [--notes "..."] [--closed-by <who>]
 *                                         — batch close (non-interactive; SPEC §6)
 *   node cli.mjs drain --group <correlation_id> --status <...> [...]
 *                                         — close every open row sharing that correlation_id
 *   node cli.mjs drain ... --json         — machine-readable result on either mode
 *   node cli.mjs bootstrap [--baseline-from-git|--baseline-all|--none] [--apply] [--json]
 *                                         — v2 write side (plan Part 1): turns the
 *                                            NEVER_VERIFIED starting position into an honest
 *                                            baseline. Dry-run by default; --apply writes. The
 *                                            git stage runs first (offers `git init` for a
 *                                            non-repo workspace, never runs it without --apply),
 *                                            then reconciles, then classifies every
 *                                            NEVER_VERIFIED edge under the chosen policy
 *                                            (baseline-from-git is the default AND the
 *                                            recommended one — dry-run is what makes previewing
 *                                            it safe). Every applied write is a `baselined`
 *                                            event, never `verified` — a baseline is a claim,
 *                                            not a verification (plan §3/§5).
 *   node cli.mjs reconcile                — v2 derivation (READ-ONLY): derives state per
 *                                            declared edge from content + the v2 event store;
 *                                            writes nothing. Current workspace by default.
 *   node cli.mjs reconcile --all          — every workspace
 *   node cli.mjs reconcile --group-by <glob|node|none>
 *                                         — group the printed rows (default none = unchanged
 *                                            output). "glob": one header per generator, "node":
 *                                            one header per logical file (worktree coordination).
 *   node cli.mjs reconcile --json         — machine-readable {generatedAt, stats, rows, groups}
 *   node cli.mjs reconcile --inbound      — delivery view (2026-08 plan Part 2): edges whose
 *                                            downstream lives in the repo at cwd and whose
 *                                            source arrives from another repo — the question
 *                                            "has anything upstream drifted into what I'm about
 *                                            to touch?", answered by filtering reconcile()'s own
 *                                            rows (lib/reconcile.mjs's inboundRows), not new
 *                                            computation. Reconciles every workspace (a
 *                                            cross-repo edge's sidecar lives beside its SOURCE,
 *                                            outside this repo by definition) then filters.
 *                                            Composes with --json and --group-by. Pull-based:
 *                                            see docs/INBOUND.md for what this does not do.
 *   node cli.mjs verify --edge <edge_id> | --node <node_id> | --glob <pattern>
 *                       [--state <STATE>] --disposition <d> [--reason "..."] [--apply] [--json]
 *                                         — v2 write side (READ+WRITE): record a verification
 *                                            against the current derived state (plan §4). At
 *                                            least one selector required; `--state` narrows
 *                                            within it. Batch is the default — a matched glob
 *                                            or node applies the same disposition/reason to
 *                                            every member, one event per edge. `both-reconciled`
 *                                            is the only disposition that may follow a DIVERGED
 *                                            edge; everything else on DIVERGED is refused.
 *                                            `decoupled` prints the required sidecar edit and
 *                                            DRY RUN BY DEFAULT for every disposition: prints what
 *                                            it would write and touches neither the event store nor
 *                                            any sidecar unless `--apply` is given. (Before
 *                                            2026-08-17 `--apply` gated only the `decoupled`
 *                                            sidecar edit and the other seven dispositions wrote
 *                                            immediately — see docs/GOTCHAS.md.)
 *                                            Every write is followed by a re-reconcile that
 *                                            confirms the edge landed in the expected state —
 *                                            failure to confirm is a non-zero exit.
 */

import { existsSync, globSync, realpathSync, readdirSync, statSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { homedir as _homedir } from "node:os";
const HOME_DIR = _homedir();
import { execSync, execFileSync } from "node:child_process";

import {
  WORKSPACES,
  STATE_PATH,
  HEARTBEAT_PATH,
  WATCHER_LOG,
  SEARCH_ROOTS,
  SEARCH_ROOTS_DIAGNOSTIC,
  SCHEDULER,
  LAUNCHD_ACTIVE,
  searchRootsExplain,
  DISCOVERY_DEGRADED,
  SUSPICIOUS_MARKERS,
  CROSS_LEDGER_JSONL,
  SKILL_DIR,
  GRAPH_MCP_CACHE_PATH,
  RULES_DIR,
  CONFIG_PATH,
  STATE_DIR as CONFIG_ROOT_DIR,
  MAX_DEPTH,
} from "./lib/core/config.mjs";
import YAML from "yaml";

// Five helpers moved out of cli.mjs 2026-08-25 (#31 T2) so doctor's extracted
// sections can use them without importing cli.mjs back. Imported with a REAL
// binding (not `export … from`, which creates none) because cli.mjs still calls
// shortPath in 17 places, and re-exported because three of them are imported
// from this module by tests/cli/cli-json.test.mjs.
import { parsePlistWatchPaths, expectedWatchPaths } from "./lib/core/plist.mjs";
import { findDuplicateOpenAcrossLedgers } from "./lib/edges/ledger.mjs";
import { sweepMarkers } from "./lib/core/discovery.mjs";
import { shortPath, currentWorkspace } from "./lib/core/config.mjs";
export { parsePlistWatchPaths, expectedWatchPaths, findDuplicateOpenAcrossLedgers };

import {
  readLedger,
  readLedgerWithStats,
  lastActivityAt,
  markStatus,
  findUnownedLedgers,
  openCount,
  classifyUnownedLedger,
  readLedgerByEra,
  LEDGER_SCHEMA,
  formatAge,
} from "./lib/edges/ledger.mjs";
import { findLedgersUnder } from "./lib/edges/refs.mjs";
import { loadSidecar, SidecarError, downstreamsFor } from "./lib/edges/frontmatter.mjs";
import { discoverCrossReposSync, loadCrossRepoSync, resolveTarget } from "./lib/edges/cross-repo.mjs";
import { buildEdgeMap, findAllSidecarsRecursive } from "./lib/edges/edges.mjs";
import { reconcile, STATES, groupRows, inboundRows, edgeIdFor } from "./lib/edges/reconcile.mjs";
import { appendEvent, readEvents, DISPOSITIONS, edgeId } from "./lib/edges/events.mjs";
import { gitStage, planBaseline, applyBaseline, BASELINE_POLICIES, DEFAULT_WALK_COMMITS } from "./lib/edges/bootstrap.mjs";
import { resolveProvenance, resolveObservedRef } from "./lib/edges/provenance.mjs";
import { appendRun } from "./lib/core/runs.mjs";
import { describeWhy } from "./lib/edges/why.mjs";
import {
  METRICS_PATH,
  EXPECTATIONS,
  UNCALIBRATED,
  evaluateExpectations,
  detectVanishedKeys,
  readLastMetricsRecord,
  appendMetricsRecord,
} from "./lib/report/metrics.mjs";

/**
 * Validate cross-repo edges: load each .propagates-cross.yml, resolve every
 * source/watch/affects target, count missing + outside-allowlist. Exported for test.
 */
export async function checkCrossRepo(searchRoots = SEARCH_ROOTS) {
  const repos = discoverCrossReposSync(searchRoots);
  let edges = 0, missing = 0, outsideAllowlist = 0;
  for (const repo of repos) {
    let e;
    try { e = loadCrossRepoSync(repo.root); } catch { continue; }
    const targets = [
      ...e.pushEdges.flatMap((p) => p.affects.map((a) => a.path)),
      ...e.pullEdges.map((p) => p.watch),
    ];
    for (const t of targets) {
      edges++;
      const r = resolveTarget(repo.root, t);
      if (r.reason === "missing") missing++;
      else if (r.reason === "outside-partner" || r.reason === "not-contract") outsideAllowlist++;
    }
  }
  return { edges, missing, outsideAllowlist };
}
import { discoverWorkspacesSync, isWorkspaceMarker, liveLedgerCandidates } from "./lib/core/discovery.mjs";
import { parseRootsArg, probeRoots, renderConfig, verifyDiscovery, PROBE_LAYOUTS, migrateLegacyState } from "./lib/core/setup.mjs";
import { updateNotice, formatUpdateNotice } from "./lib/core/update-notice.mjs";
import { LABEL as LAUNCHD_LABEL, regeneratePlist, reloadLaunchd, PLIST_PATH } from "./lib/core/plist.mjs";
import { runReleaseCheck } from "./lib/core/release.mjs";
import { migrateLedger } from "./lib/edges/migrate-ledger.mjs";
import { relocateLedger } from "./lib/edges/relocate-ledger.mjs";
import { freezeLedgerV1 } from "./lib/edges/freeze-ledger.mjs";

// Colour constants live in the layer that prints — commands/ansi.mjs — so there
// is ONE definition rather than a copy here and a copy per command module.
import { RESET, DIM, RED, GREEN, YELLOW, BOLD } from "./commands/ansi.mjs";


/**
 * Render a Reporter's drained entries (lib/report/doctor/reporter.mjs).
 *
 * This is the ONLY place doctor's extracted sections turn into stdout, and it
 * reproduces `doctor()`'s own check/warn/info/note formatting exactly — the
 * split must be byte-identical, so the format lives in one place rather than
 * being re-derived per module. Modules under lib/ collect entries and print
 * nothing; no module there contains an ANSI escape, and this keeps it that way.
 */
function renderDoctorEntries(entries) {
  for (const e of entries) {
    const d = e.detail;
    if (e.kind === "pass") {
      console.log(`  ${GREEN}\u2713${RESET} ${e.label}${d ? "  " + DIM + d + RESET : ""}`);
    } else if (e.kind === "fail") {
      console.log(`  ${RED}\u2717${RESET} ${e.label}${d ? "  " + RED + d + RESET : ""}`);
    } else if (e.kind === "warn") {
      console.log(`  ${YELLOW}!${RESET} ${e.label}${d ? "  " + DIM + d + RESET : ""}`);
    } else if (e.kind === "header") {
      console.log(`${e.leadingBlank ? "\n" : ""}${BOLD}${e.label}${RESET}`);
    } else if (e.kind === "note") {
      // Marker-less dim line — context about a check that could NOT run.
      console.log(`  ${DIM}${e.label}${RESET}`);
    } else {
      console.log(`  ${DIM}\u00b7${RESET} ${e.label}${d ? "  " + DIM + d + RESET : ""}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers — exported for tests (tests/cli-json.test.mjs).
// ─────────────────────────────────────────────────────────────────────────────

// `decisionsAttributionReport` moved to lib/report/decisions.mjs 2026-08-25, beside the two functions it
// composes. Re-exported here because tests/cli/doctor.test.mjs and
// tests/cli/doctor-undiscoverable-ledgers.test.mjs import it from this module,
// and because an extracted doctor section needs it without importing cli.mjs
// back (a cycle). The jsdoc above describes the re-export; the implementation
// and its rationale live at the new home.
export { decisionsAttributionReport } from "./lib/report/decisions.mjs";

/**
 * Report ledgers `findLedgersUnder` (lib/edges/refs.mjs) finds that
 * `discoverWorkspacesSync` would not — dot-directories, past `DEFAULT_MAX_DEPTH`,
 * or below a sidecar that never opted in with `workspace: true`. Plan:
 * ~/.claude/plans/status-temporal-plum.md P4 "undiscoverable-ledger report".
 *
 * `findLedgersUnder` existed with zero production callers (only `enumerateRefs`
 * was ever imported from refs.mjs, by lib/edges/bootstrap.mjs) — a correct,
 * built capability nothing watched (docs/GOTCHAS.md G48). This wires it in as
 * a `doctor` section, deliberately INFORMATIONAL: a ledger being invisible to
 * discovery is a real gap worth naming, but it is not, by itself, a defect in
 * the repo being checked — reporting it with a `✗` would train people to
 * ignore doctor (G1, G23).
 *
 * NOT the same coverage as the pre-existing `findUnownedLedgers` / "no unowned
 * ledger files" hard check already in `doctor` below: that one has its own raw
 * walk with its own SKIP set (deliberately not excluding dot-dirs so it can
 * catch exactly the PanditPawanKaushik-worktree class of case) and fails
 * doctor outright. This section adds the WHY — dot-directory / depth /
 * no-workspace-marker, taken from `discoverWorkspacesSync`'s actual read-only
 * ground truth — that the other check does not carry. See P4's verification
 * report for a live-machine finding: the two mechanisms overlap for most
 * inputs, but not all (`.gstack` is skipped by one and not the other).
 *
 * Every non-finding case is named per `rule:discernment-checks` §2 — "no
 * result" and "no result *because*" must never collapse into the same output:
 *   - `no-roots`     — SEARCH_ROOTS resolved to nothing to walk
 *   - `walk-failed`  — the raw filesystem walk itself threw
 *   - `none-found`   — the walk ran and found nothing undiscoverable
 *   - `found`        — findings[], each `{ path, reason, open }`
 *
 * `open` is the FOLDED open-row count (openCount(), reused rather than
 * reimplemented — the ledger is append-only, so a closed row keeps its
 * original `open` line and a raw line count overcounts; docs/GOTCHAS.md
 * "501 where the truth was 8"). `open` is `-1` when the ledger itself could
 * not be read — still reported by path and reason, never silently dropped.
 *
 * Exported (not inlined in `doctor()`) so the no-roots/walk-failed branches —
 * impractical to force from a real machine's configured search roots — can be
 * pinned directly, same reasoning as `decisionsAttributionReport` above.
 *
 * @param {string[]} searchRoots
 * @returns {Promise<{status: "no-roots"|"walk-failed"|"none-found"|"found", findings: Array<{path: string, reason: string, open: number}>, error?: string}>}
 */
export async function undiscoverableLedgersReport(searchRoots) {
  if (!searchRoots || searchRoots.length === 0) {
    return { status: "no-roots", findings: [] };
  }

  let rawFindings;
  try {
    const seen = new Set();
    rawFindings = [];
    for (const root of searchRoots) {
      for (const f of findLedgersUnder(root)) {
        if (seen.has(f.path)) continue;
        seen.add(f.path);
        rawFindings.push(f);
      }
    }
  } catch (err) {
    return { status: "walk-failed", findings: [], error: err.message };
  }

  const undiscoverable = rawFindings.filter((f) => !f.discoverable);
  if (undiscoverable.length === 0) {
    return { status: "none-found", findings: [] };
  }

  const findings = [];
  for (const f of undiscoverable) {
    let open;
    try {
      open = await openCount(f.path);
    } catch {
      open = -1; // unreadable ledger — still reported, never dropped (G2)
    }
    findings.push({ path: f.path, reason: f.reason, open });
  }
  return { status: "found", findings };
}








/**
 * Assign each unique sidecar (by `fs.realpathSync`) to its nearest — i.e.
 * deepest — owning workspace, so `doctor` validates each sidecar exactly
 * once instead of once per containing workspace.
 *
 * Workspace roots nest (`GitHub` ⊃ `PanditPawanKaushik` ⊃ `SSJK-mb`), and
 * `findSidecars` recursively walks a workspace's *entire* subtree with no
 * awareness of nested workspace boundaries — so a sidecar under `SSJK-mb`
 * is found by all three ancestors' walks. Before this function existed,
 * `doctor` validated (loadSidecar + downstream-path checks) whatever
 * `findSidecars` returned for every workspace independently, so that one
 * sidecar's defects were reported once per containing workspace. See
 * docs/ISSUES.md A2 for the measured consequence (28 sources open in more
 * than one ledger — all nested parent/child pairs).
 *
 * Keyed by realpath, not the raw path string, because symlinks and worktree
 * checkouts make the same file reachable via more than one path — two
 * different raw strings that are the same file must still collapse to one
 * validation, one report.
 *
 * @param {Array<{root: string}>} workspaces
 * @param {Map<string, string[]>} sidecarsByWsRoot ws.root -> absolute sidecar
 *   paths found under it (as returned by `findSidecars(ws.root)`), one entry
 *   per workspace — a sidecar nested under two workspace roots appears in
 *   both entries' arrays, which is exactly the duplication being collapsed.
 * @returns {{assignedByWsRoot: Map<string, string[]>, uniqueCount: number}}
 *   `assignedByWsRoot` covers every workspace passed in (empty array for a
 *   workspace assigned nothing); `uniqueCount` is the number of distinct
 *   real files across all input sidecars — the coverage-invariant target.
 */
export function assignSidecarsToWorkspaces(workspaces, sidecarsByWsRoot) {
  const byRealpath = new Map(); // realpath -> { originalPath, candidates: [ws, ...] }
  for (const ws of workspaces) {
    const list = sidecarsByWsRoot.get(ws.root) || [];
    for (const sc of list) {
      let real;
      try {
        real = realpathSync(sc);
      } catch {
        real = sc; // vanished between find and realpath — fall back to the raw path
      }
      if (!byRealpath.has(real)) byRealpath.set(real, { originalPath: sc, candidates: [] });
      byRealpath.get(real).candidates.push(ws);
    }
  }

  const assignedByWsRoot = new Map(workspaces.map((ws) => [ws.root, []]));
  for (const { originalPath, candidates } of byRealpath.values()) {
    // Deepest wins: the workspace whose root is the longest (most nested)
    // among every workspace whose subtree contains this sidecar.
    const nearest = candidates.reduce((best, ws) => (ws.root.length > best.root.length ? ws : best));
    assignedByWsRoot.get(nearest.root).push(originalPath);
  }

  return { assignedByWsRoot, uniqueCount: byRealpath.size };
}




// `classifyDownstreamPath` moved to lib/edges/edges.mjs 2026-08-25 — it is edge
// semantics, and doctor's extracted per-workspace section needs it without
// importing cli.mjs back. Re-exported because
// tests/unit/downstream-path-guard.test.mjs imports it from here.
// NOTE: a re-export creates NO local binding — any remaining call inside this
// file would throw ReferenceError at runtime, which node --check cannot see.
export { classifyDownstreamPath } from "./lib/edges/edges.mjs";

async function findSidecars(workspaceRoot) {
  const found = [];
  async function walk(dir, depth) {
    if (depth > 6) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".next" || e.name === ".git") continue;
        await walk(p, depth + 1);
      } else if (e.isFile() && e.name === ".propagates.yml") {
        found.push(p);
      }
    }
  }
  await walk(workspaceRoot, 0);
  return found;
}









/** One hour — long enough that repeat `doctor` runs in a session are free, short
 * enough that a genuine MCP registration change is visible same-day. */
const GRAPH_MCP_CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * Probe whether the `code-review-graph` MCP is registered, via `claude mcp
 * list`. Bounded and cached — see docs/ISSUES.md N16: this shell-out was
 * measured taking 17.8s of a ~19s `doctor` run (94%) to report a single
 * WARNING that is known and deferred (TM-064). An unbounded synchronous
 * subprocess inside a health check is a liveness risk, not just slow — a
 * hung `claude` binary would hang `doctor` itself, forever, with no signal.
 *
 * Returns `{ status, checkedAt, fromCache, detail? }` where `status` is one
 * of `"registered" | "not-registered" | "timeout" | "error"`. `"timeout"`
 * and `"error"` are distinct from `"not-registered"` on purpose: "I could
 * not look" and "I looked and it is not there" must never collapse into the
 * same report (that distinction is this register's entire theme — see
 * docs/ISSUES.md's root-defect section). Never returns a bare boolean and
 * never silently maps a timeout to a pass.
 *
 * Result is cached to GRAPH_MCP_CACHE_PATH (respects PROPAGATE_STATE_DIR via
 * lib/config.mjs) for GRAPH_MCP_CACHE_TTL_MS, including timeout/error
 * outcomes — a hung `claude` binary should not cost every `doctor` run 2s
 * for an hour either, and the cached entry still carries its own status so a
 * cached timeout is reported as a cached timeout, not a cached pass.
 *
 * @param {{cachePath?: string, ttlMs?: number, now?: () => number}} [opts] test seams
 */
export async function checkGraphMcpStatus(opts = {}) {
  const cachePath = opts.cachePath ?? GRAPH_MCP_CACHE_PATH;
  const ttlMs = opts.ttlMs ?? GRAPH_MCP_CACHE_TTL_MS;
  const now = opts.now ?? Date.now;

  try {
    if (existsSync(cachePath)) {
      const cached = JSON.parse(await readFile(cachePath, "utf8"));
      if (typeof cached.checkedAt === "number" && now() - cached.checkedAt < ttlMs) {
        return { ...cached, fromCache: true };
      }
    }
  } catch {
    /* corrupt or unreadable cache -- fall through and recompute */
  }

  const runMcpList = opts.runMcpList ?? (() => execSync("claude mcp list 2>&1", { encoding: "utf8", timeout: 2000 }));

  let result;
  try {
    const out = runMcpList();
    result = { status: /code-review-graph/.test(out) ? "registered" : "not-registered", checkedAt: now() };
  } catch (err) {
    // execSync throws on nonzero exit AND on hitting `timeout` -- the timeout
    // case is marked by `killed`/`signal` (Node kills the child with
    // `killSignal`, default SIGTERM) and must stay distinguishable from "ran
    // fine and said no" or "the `claude` binary errored for some other reason".
    const timedOut = err.killed === true || err.signal === "SIGTERM" || err.code === "ETIMEDOUT";
    result = { status: timedOut ? "timeout" : "error", checkedAt: now(), detail: err.message };
  }

  try {
    await mkdir(path.dirname(cachePath), { recursive: true });
    await writeFile(cachePath, JSON.stringify(result), "utf8");
  } catch {
    /* best-effort cache write -- a failed write must not fail the check itself */
  }
  return { ...result, fromCache: false };
}

async function doctor() {
  const doctorStart = Date.now();
  let problems = 0;
  // Metrics counters (docs/OBSERVABILITY.md §6 step 1) — accumulated as the
  // existing checks below run, not recomputed. `doctor` already gathers every
  // one of these; this just keeps a running tally instead of throwing it away.
  let sidecarsLoadedCount = 0;
  let sidecarsRejectedCount = 0;
  let sidecarsProblemsCount = 0;
  let ledgerUnknownTypesTotal = 0;
  let ledgerMalformedTotal = 0;
  let rowsOpenTotal = 0;
  let decisionsEntriesCount = 0;
  let decisionsWithTokensCount = 0;
  let plistWatchpathsCount = 0;
  let stateTrackedFilesCount = 0;
  // Set by checkEnvironment and read by `# Metrics` — the ONE reconcile() of the run (D8).
  let doctorReconcileRows = null;
  // Detail collected for the four subjects whose sole assertion now lives in
  // EXPECTATIONS (lib/metrics.mjs, GOTCHAS G20) — the inline check() calls
  // that used to assert these facts were downgraded to info()/warn(), but the
  // exact-offender detail they used to print must still reach the reader, so
  // it's captured here and handed to evaluateExpectations() as context.
  const ledgerUnknownTypesDetails = [];
  const sidecarsRejectedDetails = [];
  let decisionsPath = "";
  let decisionsZeroEntries = [];
  // Doctor's extracted sections share ONE Reporter (lib/report/doctor/reporter.mjs):
  // it owns `problems`, the only accumulator that is global to the run. Imported
  // dynamically like doctor's other lazy imports (D5) so `propagate status` never
  // pulls this subtree in. Each section imports its own module at its call site.
  const { Reporter } = await import("./lib/report/doctor/reporter.mjs");

  function check(label, ok, detail = "") {
    if (ok) {
      console.log(`  ${GREEN}✓${RESET} ${label}${detail ? "  " + DIM + detail + RESET : ""}`);
    } else {
      console.log(`  ${RED}✗${RESET} ${label}${detail ? "  " + RED + detail + RESET : ""}`);
      problems++;
    }
  }
  function warn(label, detail = "") {
    console.log(`  ${YELLOW}!${RESET} ${label}${detail ? "  " + DIM + detail + RESET : ""}`);
  }
  // Summary line for an aggregate that restates counts already reported by
  // per-entry `check()` failures above it — informational, not a second vote.
  // A run-level summary is useful (see docs/ISSUES.md A2's "5th problem"
  // note); it must never double-count the same underlying defect it is
  // summarizing. Uses a neutral marker (not ✗) precisely so it reads as
  // "here's the tally", not "here's a new failure".
  function info(label, detail = "") {
    console.log(`  ${DIM}·${RESET} ${label}${detail ? "  " + DIM + detail + RESET : ""}`);
  }

  // The v1 launchd watcher is RETIRED (docs/DECISIONS.md 2026-08-14):
  // measured 4,420 runs / 4,384 no-ops (99.2%), plus two incidents in one day
  // traced to its state.json mtime baseline. `reconcile` (on demand) + `check`
  // (pre-push) + the digest's DRIFT/INBOUND sections replace its coverage.
  // Per docs/GOTCHAS.md G2 ("absence must be attributable") this section
  // stays — informational only, never a `check()` — so a reader lands on
  // "retired on purpose" instead of wondering where the watcher checks went.
  // The section that follows ("v2 replacement health") is what can now fail.
  // Extracted to lib/report/doctor/environment.mjs (#31 T2). It owns THREE
  // consecutive sections, so it emits their headers as entries rather than
  // having this caller print them — that is what keeps them ordered with the
  // checks in between. It also owns the single reconcile() call and hands the
  // rows back for `# Metrics` (D8); nothing else may call reconcile in a doctor
  // run, because two calls could report two different trees.
  {
    const { checkEnvironment } = await import("./lib/report/doctor/environment.mjs");
    const reporter = new Reporter();
    const { counts, details } = await checkEnvironment({ reporter });
    renderDoctorEntries(reporter.drain());
    problems += reporter.problems;
    stateTrackedFilesCount = counts.stateTrackedFiles;
    doctorReconcileRows = details.reconcileRows;
  }


  // Sidecars: gather once per workspace root, then collapse duplicates.
  // findSidecars(ws.root) walks that workspace's ENTIRE subtree with no
  // awareness of nested workspace boundaries, so a sidecar under a nested
  // workspace (e.g. SSJK-mb under PanditPawanKaushik under the GitHub hub)
  // is found by every ancestor's walk. assignSidecarsToWorkspaces collapses
  // that to one validation per unique sidecar, owned by its nearest
  // (deepest) workspace. See docs/ISSUES.md A2.
  const sidecarsByWsRoot = new Map();
  for (const ws of WORKSPACES) {
    sidecarsByWsRoot.set(ws.root, await findSidecars(ws.root));
  }
  const { assignedByWsRoot } = assignSidecarsToWorkspaces(WORKSPACES, sidecarsByWsRoot);
  const { checkWorkspace } = await import("./lib/report/doctor/workspaces.mjs");

  for (const ws of WORKSPACES) {
    console.log(`\n${BOLD}# Workspace: ${ws.name}${RESET}`);
    // Extracted to lib/report/doctor/workspaces.mjs (#31 T2). The section's own
    // rationale — why sidecars are assigned across ALL workspaces, and which of
    // its findings are deliberately not failures — moved with the code. Do not
    // restate it here.
    const reporter = new Reporter();
    const { counts, details } = await checkWorkspace({
      ws,
      sidecars: assignedByWsRoot.get(ws.root) || [],
      reporter,
    });
    renderDoctorEntries(reporter.drain());
    problems += reporter.problems;
    // Per-workspace counts, summed into the run-global tallies `# Metrics`
    // reads. Returned values rather than shared mutation (D4): a dropped key
    // is a missing property, not a silent zero.
    rowsOpenTotal += counts.rowsOpen;
    ledgerUnknownTypesTotal += counts.ledgerUnknownTypes;
    sidecarsLoadedCount += counts.sidecarsLoaded;
    sidecarsRejectedCount += counts.sidecarsRejected;
    sidecarsProblemsCount += counts.sidecarsProblems;
    ledgerUnknownTypesDetails.push(...details.ledgerUnknownTypes);
    sidecarsRejectedDetails.push(...details.sidecarsRejected);
  }

  console.log(`\n${BOLD}# Cross-repo${RESET}`);
  try {
    const x = await checkCrossRepo();
    // "Outside the allowlist" means two different things, and conflating them made every
    // fresh install red. If the allowlist is EMPTY, cross-repo is simply not configured —
    // the shipped cross-allow.yml is deliberately empty so a new machine permits no cross
    // edge it was never told about (Phase 2). Failing an install for not having
    // configured an optional feature is the same mistake as failing it for the retired
    // watcher's state.json.
    //
    // If the allowlist is NON-EMPTY and an edge still falls outside it, that IS a
    // failure: a declared edge reaches past a bound someone deliberately set.
    //
    // The safety property is untouched either way — an empty allowlist still permits
    // nothing. This changes only how doctor DESCRIBES that state.
    let allowlistConfigured = false;
    try {
      const { CROSS_ALLOW_PATH } = await import("./lib/core/config.mjs");
      const parsedAllow = YAML.parse(readFileSync(CROSS_ALLOW_PATH, "utf8"));
      allowlistConfigured = Array.isArray(parsedAllow?.partner_roots) && parsedAllow.partner_roots.length > 0;
    } catch {
      allowlistConfigured = false;
    }
    const crossDetail = `${x.edges} edges, ${x.missing} missing, ${x.outsideAllowlist} outside-allowlist`;
    if (!allowlistConfigured && x.outsideAllowlist > 0 && x.missing === 0) {
      info(
        "cross-repo edges resolve",
        `${crossDetail} — allowlist is empty, so cross-repo is UNCONFIGURED, not violated. ` +
          `Add partner_roots to $PROPAGATE_STATE_DIR/cross-allow.yml to enable these edges.`,
      );
    } else {
      check("cross-repo edges resolve", x.missing === 0 && x.outsideAllowlist === 0, crossDetail);
    }
    // G7: every fired row must carry a normalized `partner` join key.
    //
    // READS BOTH ERAS. This used to read the live ledger only. Once Phase D
    // froze v1 into archive/, that made `noPartner === 0` trivially true — a
    // check that cannot fail (rule:discernment-checks §1), and it would have
    // read as a fix rather than as a relocation. The property is about the v1
    // history, which is exactly what the archive now holds.
    const { CROSS_LEDGER_JSONL } = await import("./lib/core/config.mjs");
    const crossEra = await readLedgerByEra(CROSS_LEDGER_JSONL);
    // EVERY parsed row, not the era buckets. Filtering by era here made the
    // check scan 0 rows on an unfrozen cross ledger and report green — the
    // vacuous pass this very check was repointed to avoid.
    const crossAll = crossEra.all;
    const noPartner = crossAll.filter((r) => r.type === "drift" && !r.partner).length;
    // Scanning nothing and finding nothing are different facts; say which.
    check(
      "cross rows carry partner",
      noPartner === 0,
      `${noPartner} rows missing partner`,
      `${crossAll.length} row(s) scanned across live + archive`,
    );
  } catch (err) {
    check("cross-repo check ran", false, err.message);
  }

  console.log(`\n${BOLD}# DECISIONS.md attribution${RESET}`);
  // FIRST EXTRACTED SECTION (#31 T2). The section's own rationale — N12, why
  // the equality assertion lives in EXPECTATIONS rather than here, and why a
  // THROWN parse must fail rather than read as "0 == 0" — moved with the code
  // to lib/report/doctor/decisions.mjs. Do not restate it here.
  //
  // The shape every other section will follow: build a Reporter, call the
  // module, render its drained entries IMMEDIATELY (so run order is unchanged),
  // add its problems to the run tally, then copy its returned counts/details
  // into the metrics accumulators. Returned values, never shared mutation —
  // a dropped key becomes a missing property instead of a silent zero.
  {
    // Dynamic, like doctor's other 14 imports (D5): a static top-of-file import
    // would pull doctor's whole subtree into `propagate status`/`check`/`drain`,
    // a startup cost on a published binary that no test would catch.
    const { checkDecisions } = await import("./lib/report/doctor/decisions.mjs");
    const reporter = new Reporter();
    const { counts, details } = await checkDecisions({ skillDir: SKILL_DIR, reporter });
    renderDoctorEntries(reporter.drain());
    problems += reporter.problems;
    decisionsEntriesCount = counts.decisionsEntries;
    decisionsWithTokensCount = counts.decisionsWithTokens;
    decisionsPath = details.decisionsPath;
    decisionsZeroEntries = details.decisionsZeroEntries;
  }

  // # Backlog — todos, issues and handovers. Dynamic import for the same reason
  // as the block above (D5). Reports counts as context and NAMES only defects:
  // the open-item list is 500 long and belongs in `propagate backlog`.
  {
    const { checkBacklog } = await import("./lib/report/doctor/backlog.mjs");
    const reporter = new Reporter();
    const { counts } = await checkBacklog({ reporter });
    renderDoctorEntries(reporter.drain());
    problems += reporter.problems;
    // counts are returned for the same reason every doctor module returns them
    // (D4 — a dropped key becomes a missing property, not a silent zero), and
    // deliberately not stored: nothing reads them yet. Wiring them into
    // `# Metrics` is a separate, deliberate step, and an unread accumulator
    // here would be exactly the dead state this codebase keeps deleting.
    void counts;
  }

  console.log(`\n${BOLD}# Graph integration${RESET}`);
  {
    const graphResult = await checkGraphMcpStatus();
    const ageMin = Math.max(0, Math.round((Date.now() - graphResult.checkedAt) / 60_000));
    const cacheNote = graphResult.fromCache ? ` (cached ${ageMin}m ago)` : "";
    if (graphResult.status === "registered") {
      check("code-review-graph MCP registered", true, cacheNote.trim());
    } else if (graphResult.status === "not-registered") {
      console.log(`  ${YELLOW}!${RESET} code-review-graph MCP not registered  ${DIM}(V1 expected; see TM-064)${cacheNote}${RESET}`);
    } else if (graphResult.status === "timeout") {
      // Explicit unknown state, not a pass and not a silent skip: "I could
      // not look" must read differently from "I looked and it's fine".
      console.log(`  ${YELLOW}!${RESET} graph integration check timed out after 2s — status unknown${DIM}${cacheNote}${RESET}`);
    } else {
      console.log(
        `  ${YELLOW}!${RESET} graph integration check failed — status unknown  ${DIM}${graphResult.detail || ""}${cacheNote}${RESET}`,
      );
    }
  }

  console.log(`\n${BOLD}# Discovery integrity${RESET}`);
  // Extracted to lib/report/doctor/discovery.mjs (#31 T2). Grouped by which
  // accumulators it owns — ledger.malformed and plist.watchpaths, and nothing
  // else writes them — rather than by topic; the module doc says why, and why a
  // finer split is easy from there but was not done in this pass.
  {
    const { checkDiscovery } = await import("./lib/report/doctor/discovery.mjs");
    const reporter = new Reporter();
    const { counts } = await checkDiscovery({ reporter });
    renderDoctorEntries(reporter.drain());
    problems += reporter.problems;
    ledgerMalformedTotal = counts.ledgerMalformed;
    plistWatchpathsCount = counts.plistWatchpaths;
  }

  console.log(`\n${BOLD}# Undiscoverable ledgers (informational)${RESET}`);
  console.log(
    `  ${DIM}ledgers findLedgersUnder() reaches that discovery would not — see lib/edges/refs.mjs header. Never a doctor failure.${RESET}`,
  );
  try {
    const undiscoverableReport = await undiscoverableLedgersReport(SEARCH_ROOTS);
    if (undiscoverableReport.status === "no-roots") {
      info("undiscoverable-ledger scan", "no-roots — no search roots configured");
    } else if (undiscoverableReport.status === "walk-failed") {
      info("undiscoverable-ledger scan", `walk-failed — ${undiscoverableReport.error}`);
    } else if (undiscoverableReport.status === "none-found") {
      info("undiscoverable-ledger scan", "none-found");
    } else {
      for (const f of undiscoverableReport.findings) {
        info(
          `undiscoverable ledger (${f.reason})`,
          `${f.path} — ${f.open < 0 ? "open count unreadable" : `${f.open} open row(s)`}`,
        );
      }
    }
  } catch (err) {
    // Reporting must never break doctor (same discipline as the symlink scan above).
    info("undiscoverable-ledger scan", `walk-failed — ${err.message}`);
  }

  console.log(`\n${BOLD}# Log tail${RESET}`);
  if (existsSync(WATCHER_LOG)) {
    const raw = await readFile(WATCHER_LOG, "utf8");
    const lines = raw.trim().split("\n");
    const last = lines.slice(-3);
    for (const l of last) console.log(`  ${DIM}${l}${RESET}`);
  } else {
    console.log(`  ${DIM}(no log yet)${RESET}`);
  }

  console.log(`\n${BOLD}# Metrics${RESET}`);
  // docs/OBSERVABILITY.md §6 step 1: persist what doctor already computed
  // above instead of throwing it away. Nothing here is newly derived — every
  // value was already gathered by a check() above; this just tallies it,
  // asserts the calibrated expectations, and records the run.
  {
    // Doc-structure metrics. Deduped by resolved path — workspaces nest, and counting
    // a nested doc twice inflated an earlier census from 1339 to 2219.
    let docsProseOnly = 0;
    let docsSupersedesUnresolvable = 0;
    // Gotchas liveness. `gotchas` is the one kind that can be present, current and
    // correctly reconciled while delivering NOTHING: its entries carry executable
    // triggers, and a trigger that cannot fire is a hazard documented but not
    // delivered. N45 measured 3 of 10 inert while --selftest reported green.
    // Staleness checks structurally cannot see this, so it is tallied here.
    //
    // `null` until the walk runs, never 0 — a 0 would assert "every hazard fires"
    // on a scan that never happened (rule:discernment-checks §2).
    let gotchasScanned = null;
    let gotchasFiles = 0;
    const gotchasInert = [];
    try {
      const { proseOnlySupersession, kindOf } = await import("./lib/report/doc-kind.mjs");
      const { selftestProblems } = await import("./lib/gotchas/parse.mjs");
      const { globSync } = await import("node:fs");
      const seenDocs = new Set();
      for (const ws of WORKSPACES) {
        let found = [];
        let gotchasExtra = [];
        try {
          found = globSync(path.join(ws.root, "**", "docs", "**", "*.md"));
          // The propagation layout is NOT under a `docs/` directory, so the glob
          // above cannot see it. Measured 2026-08-23: the moment two GOTCHAS.md
          // files migrated to propagation/state/, this census fell 9 -> 7 and
          // would have reported the migration as REDUCING adoption. A metric that
          // moves because the file moved is measuring the walk, not the tree.
          //
          // Kept SEPARATE from `found`, deliberately. Folding these 21 files into
          // the shared loop pushed docs.supersession_prose_only from 101 to 104 and
          // tripped its ratchet — not because any doc got worse, but because the
          // population grew under a baseline calibrated on the docs/ tree. Widening
          // a scan must never look like a regression in a metric it does not own.
          gotchasExtra = globSync(path.join(ws.root, "**", "propagation", "state", "*", "*.md"));
        } catch {
          continue;
        }
        // 0 ONLY ONCE A GLOB HAS ACTUALLY RUN. This assignment used to sit above
        // the loop, so zero discovered workspaces rendered
        // "0 GOTCHAS.md of 0 docs scanned — none adopted yet" — a confident
        // report of a scan that never happened, three lines under a comment
        // promising the opposite. Review 2026-08-23 reproduced it with an
        // unconfigured HOME.
        //
        // "Found nothing" and "looked at nothing" are different facts and only
        // one is a pass (rule:discernment-checks §2) — which is the rule this
        // census exists to enforce, failing inside its own implementation.
        if (gotchasScanned === null) gotchasScanned = 0;
        // `found` feeds every metric; `gotchasExtra` feeds only the gotchas tally.
        // Set, not Array.includes: the membership test runs once per doc, and
        // an array scan inside that loop is O(docs x extras) for no reason.
        const gotchasExtraSet = new Set(gotchasExtra);
        for (const d of found.concat(gotchasExtra)) {
          if (d.includes("node_modules")) continue;
          const abs = path.resolve(d);
          if (seenDocs.has(abs)) continue;
          seenDocs.add(abs);
          gotchasScanned++;
          // ONE kindOf per doc. It reads the file to parse frontmatter, so the
          // gotchas check and the supersedes loop calling it separately meant
          // 1,326 redundant reads per `doctor` run — added by the gotchas census
          // and invisible because the result was still correct.
          const kind = kindOf(abs);
          if (kind.kind === "gotchas") {
            gotchasFiles++;
            const problems = selftestProblems([abs]);
            if (problems.length) gotchasInert.push({ file: abs, problems });
          }
          if (gotchasExtraSet.has(d)) continue; // ratchet-bearing metrics below own the docs/ tree only
          if (proseOnlySupersession(abs)) docsProseOnly++;
          for (const t of kind.supersedes) {
            const [rel] = t.split("#");
            if (!existsSync(path.resolve(path.dirname(abs), rel))) docsSupersedesUnresolvable++;
          }
        }
      }
    } catch {
      // Leave both at 0 rather than crashing doctor; the expectations below treat
      // "0 because it never ran" the same as "0 because it is clean", which is the one
      // weakness here and is why the prose ratchet is a floor, not an equality.
      //
      // gotchasScanned deliberately does NOT share that weakness: it stays null if the
      // walk threw before starting, so "looked at nothing" cannot render as "found
      // nothing". Reproducing the known weakness in new code would be choosing it.
    }

    // INFORMATIONAL, not a check(). Not every repo needs a GOTCHAS.md — a doc-only
    // husk has no hazards to record — so failing a build on adoption would train
    // people to ignore the line. What must never happen is silence: the count was
    // last measured by hand, written into rule:every-project-carries-gotchas, and
    // was five days stale by the time anyone read it. Derive it, do not restate it.
    if (gotchasScanned === null) {
      info("gotchas", "not scanned — the doc walk did not run, so adoption is UNKNOWN, not zero");
    } else {
      // Always name the denominator. "3 files" is not checkable later; "3 of 412
      // docs scanned" is, and it is the difference between a fact and a number.
      info(
        "gotchas",
        `${gotchasFiles} GOTCHAS.md of ${gotchasScanned} docs scanned` +
          (gotchasFiles === 0 ? " — none adopted yet" : ""),
      );
      // "no entries parsed" is a FORMAT problem, not an inert-trigger problem.
      const unreadable = gotchasInert.filter((g) => g.problems.some((p) => /0 carry a \*\*Trigger/.test(p)));
      const inertEntries = gotchasInert.filter((g) => !unreadable.includes(g));
      if (gotchasInert.length) {
        // The failure the file exists to prevent, reported as green. Name the file
        // AND the entry: "2 inert" without the offender is not actionable.
        info(
          "gotchas inert",
          // TWO DIFFERENT FACTS, and collapsing them hid the worse one. A file
          // whose entries parse but cannot fire is one problem; a file the
          // parser cannot read AT ALL is another, and the second is bigger
          // because nothing in it is reachable.
          //
          // Measured 2026-08-24: the single flagged file was
          // PanditPawanKaushik/docs/gemstone-storefront/shopify/GOTCHAS.md —
          // 478 lines of real, current hazards using `### 1.1` headings instead
          // of `### G1 ·`, so parseEntries returns ZERO entries. Reporting that
          // as "carries an entry that cannot fire" describes a file that has no
          // entries to fire, and buries the fact that the whole file is dark.
          `${unreadable.length} unreadable, ${inertEntries.length} with an entry that cannot fire` +
            ` (of ${gotchasFiles} file(s))`,
        );
        for (const g of gotchasInert.slice(0, 3)) {
          info("", `${shortPath(g.file)} — ${g.problems[0]}`);
        }
        if (gotchasInert.length > 3) info("", `… and ${gotchasInert.length - 3} more`);
      }
    }

    // Graph shape. Derived here rather than in the loop above because it needs
    // the whole reconcile pass, and it is the only metric that can fail for a
    // structural reason (a cycle) rather than a content one. A failure that
    // reports "1 cycle" without naming the pair is not actionable, so the
    // members are carried into the detail via graphCycleMembers.
    // NOT its own check(): a graph failure is a reconcile failure, and
    // "reconcile completes" above already owns that. Adding a second label
    // would have meant a second check nothing could make fail — the exact G1
    // debt tests/doctor-check-coverage.test.mjs exists to stop growing.
    //
    // When the rows are unavailable the metrics stay NULL, never 0. A 0 here
    // would assert "no cycles" on a derivation that never ran, which is the
    // silent-pass failure of rule:discernment-checks §2. null fails the
    // equality assertions below and says why.
    let graphCycles = null;
    let graphDuplicatePairs = null;
    const graphCycleMembers = [];
    const graphDuplicateDetails = [];
    if (doctorReconcileRows) {
      const { buildGraph } = await import("./lib/graph/graph.mjs");
      const g = buildGraph(doctorReconcileRows, { workspaceRoots: WORKSPACES.map((w) => w.root) });
      graphCycles = g.stats.cycles;
      graphDuplicatePairs = g.stats.duplicatePairs;
      for (const c of g.sccs) graphCycleMembers.push(c.map(shortPath).join(" <-> "));
      for (const d of g.duplicatePairs) {
        graphDuplicateDetails.push(
          `${shortPath(d.from)} -> ${shortPath(d.to)} (${d.edges.map((e) => e.edge_id).join(", ")})`,
        );
      }
    }

    const metrics = {
      "workspaces.discovered": WORKSPACES.length,
      "graph.cycles": graphCycles,
      "graph.duplicate_pairs": graphDuplicatePairs,
      "docs.supersession_prose_only": docsProseOnly,
      "docs.supersedes_unresolvable": docsSupersedesUnresolvable,
      "sidecars.loaded": sidecarsLoadedCount,
      "sidecars.rejected": sidecarsRejectedCount,
      "sidecars.problems": sidecarsProblemsCount,
      "ledger.unknown_types": ledgerUnknownTypesTotal,
      "ledger.malformed": ledgerMalformedTotal,
      "rows.open": rowsOpenTotal,
      "decisions.entries": decisionsEntriesCount,
      "decisions.with_tokens": decisionsWithTokensCount,
      "plist.watchpaths": plistWatchpathsCount,
      "state.tracked_files": stateTrackedFilesCount,
      "doctor.duration_ms": Date.now() - doctorStart,
      // Placeholder — the real value (this run's final `problems` count,
      // including the metrics checks below) is assigned right before
      // appendMetricsRecord. The KEY must exist here already: the
      // vanished-key comparison below runs before that assignment, and
      // comparing against a metrics object that hasn't grown its own
      // "doctor.problems" key yet would make the metric look vanished on
      // EVERY run — a self-inflicted instance of the exact R6 failure this
      // check exists to catch.
      "doctor.problems": 0,
    };

    // R6: a metric key that was emitted last run and is silent this run is a
    // violation distinct from an out-of-range value — a vanished signal is the
    // same silent absence one level up. Read the PREVIOUS record before this
    // run's is appended.
    const previousRecord = await readLastMetricsRecord(METRICS_PATH);
    const vanished = detectVanishedKeys(metrics, previousRecord?.metrics ?? null);
    for (const key of vanished) {
      check(
        `metric still emitted: ${key}`,
        false,
        `present in the previous run (${previousRecord.run_id}, ${previousRecord.ts}), absent from this one`,
      );
    }

    // G16: these are predictions, not targets — a violation here is real
    // information, never something to tune away by loosening the assertion.
    // G20: context carries the exact-offender detail the (now-informational)
    // inline checks above used to print, so the sole assertion here is at
    // least as informative as the two-mechanism version it replaced.
    const violations = evaluateExpectations(metrics, EXPECTATIONS, {
      searchRoots: SEARCH_ROOTS,
      searchRootsExplain: WORKSPACES.length === 0 ? searchRootsExplain() : null,
      decisionsPath,
      decisionsZeroEntries,
      ledgerUnknownTypesDetails,
      sidecarsRejectedDetails,
      graphCycleMembers,
      graphDuplicateDetails,
    });
    for (const v of violations) {
      const detailPrefix = v.detail ? `${v.detail} — ` : "";
      check(v.describe, false, `${detailPrefix}observed ${JSON.stringify(v.observed)} — ${v.basis}`);
    }
    if (violations.length === 0) {
      check("all calibrated expectations hold", true, `${EXPECTATIONS.length} checked`);
    }
    info(
      "uncalibrated metrics recorded, not asserted",
      UNCALIBRATED.map((u) => u.key).join(", "),
    );

    // Recorded AFTER the checks above so doctor.problems reflects the true
    // final count, including any violation/vanished-key checks just run.
    metrics["doctor.problems"] = problems;
    const record = await appendMetricsRecord(metrics, { metricsPath: METRICS_PATH });
    info("metrics recorded", `${METRICS_PATH} (run ${record.run_id})`);
  }

  console.log();
  if (problems === 0) {
    console.log(`${GREEN}${BOLD}doctor: all green${RESET}`);
    process.exit(0);
  } else {
    console.log(`${RED}${BOLD}doctor: ${problems} problem${problems === 1 ? "" : "s"} found${RESET}`);
    process.exit(1);
  }
}

/**
 * `rules <list|check|selftest|promote>` — the canonical-rules lifecycle (Phase 5).
 *
 * Absorbed from the standalone `rules/_check.mjs`; lib/rules-check.mjs carries the
 * rationale and the four defects fixed in the move. The command exists because the
 * detector ran on manual invocation only (docs/SYSTEMS.md classed it
 * active-unadopted) — a mechanism nothing calls is a mechanism that decays.
 */
async function rulesCmd() {
  const sub = process.argv[3] || "check";
  const args = process.argv.slice(4);
  const asJson = args.includes("--json");
  const { checkRules, selftest, loadRules } = await import("./lib/rules/rules-check.mjs");

  if (sub === "list") {
    const rules = loadRules(RULES_DIR);
    if (asJson) return void console.log(JSON.stringify(rules.map(({ __file, ...r }) => r), null, 2));
    if (!rules.length) {
      console.log(`${YELLOW}no rules${RESET} in ${RULES_DIR}`);
      console.log(`${DIM}a rule needs \`id\` and \`fingerprint\` in frontmatter; without them it is inert by construction.${RESET}`);
      process.exit(2);
    }
    const { ruleCoverage } = await import("./lib/rules/rules-check.mjs");
    const globalMd = path.join(HOME_DIR, ".claude", "CLAUDE.md");
    const cov = Object.fromEntries(
      ruleCoverage({ rulesDir: RULES_DIR, roots: SEARCH_ROOTS, extra: [globalMd] }).map((c) => [c.id, c]),
    );
    console.log(`\n  ${rules.length} active rule(s) in ${RULES_DIR.replace(HOME_DIR, "~")}\n`);
    console.log(`  ${"rule".padEnd(36)} ${"scope".padEnd(8)} restated  referenced  status`);
    for (const r of rules.sort((a, b) => a.id.localeCompare(b.id))) {
      const c = cov[r.id] ?? { matched: 0, referenced: 0, status: "unexercised" };
      // `unexercised` means the fingerprint matched nothing AND nothing points at the
      // rule. That is an UNKNOWN, not a pass: a fingerprint that cannot fire on real
      // phrasing looks exactly like a tree with nothing to find (N35).
      const mark = c.status === "unexercised" ? `${YELLOW}unexercised${RESET}` : `${DIM}${c.status}${RESET}`;
      console.log(
        `  ${r.id.padEnd(36)} ${DIM}${(r.scope || "?").padEnd(8)}${RESET} ${String(c.matched).padStart(8)}  ${String(c.referenced).padStart(10)}  ${mark}`,
      );
    }
    const unexercised = Object.values(cov).filter((c) => c.status === "unexercised").length;
    if (unexercised) {
      console.log(
        `\n  ${YELLOW}${unexercised} rule(s) unexercised${RESET} ${DIM}— fingerprint matched nothing and nothing references them.\n` +
          `  Not proof of a broken fingerprint: a rule with genuinely nothing restating it looks the same.\n` +
          `  It is an UNKNOWN, and an unknown must not read as a clean result. See docs/ISSUES.md N35.${RESET}`,
      );
    }
    return;
  }

  if (sub === "selftest") {
    const res = selftest({ rulesDir: RULES_DIR });
    if (asJson) return void console.log(JSON.stringify(res, null, 2));
    for (const c of res.checks) {
      const label = c.kind === "fingerprint" ? `${c.id.padEnd(32)} fingerprint fires on its own body` : `override ${String(c.want).padEnd(5)} ${c.why}`;
      console.log(`  ${c.pass ? GREEN + "✓" + RESET : RED + "✗" + RESET} ${label}`);
    }
    console.log(
      res.pass
        ? `\n  ${GREEN}selftest PASS${RESET} — every fingerprint can fire; override detection fires and refuses near-misses`
        : `\n  ${RED}selftest FAIL${RESET} — ${res.failures.join("; ")}`,
    );
    process.exit(res.pass ? 0 : 1);
  }

  if (sub === "promote") {
    console.log(`${YELLOW}not implemented${RESET} — \`rules promote\` is declared in the Phase 5 plan and not built.`);
    console.log(`${DIM}Saying so is the point: docs/LIFECYCLE.md defines PROMOTE, and a command that${RESET}`);
    console.log(`${DIM}silently did nothing would be worse than one that admits the gap. Write the rule${RESET}`);
    console.log(`${DIM}file by hand in ${RULES_DIR.replace(HOME_DIR, "~")}, then run \`rules selftest\`.${RESET}`);
    process.exit(2);
  }

  if (sub !== "check") {
    console.error(`${RED}error:${RESET} usage: node cli.mjs rules <list|check|selftest|promote> [--json]`);
    process.exit(2);
  }

  // The global CLAUDE.md is the rules' former home, so it legitimately contains every
  // fingerprint. Scanned for overrides, excluded from findings — same carve-out the
  // original made, kept because removing it would report 16 false restatements.
  const globalMd = path.join(HOME_DIR, ".claude", "CLAUDE.md");
  const res = checkRules({
    rulesDir: RULES_DIR,
    roots: SEARCH_ROOTS,
    extra: [globalMd],
    exclude: [globalMd],
  });
  if (asJson) {
    console.log(JSON.stringify({ ...res, findings: res.findings.map(({ lines, ...f }) => f) }, null, 2));
    process.exit(res.exitCode);
  }

  if (res.diagnostic !== "ok") {
    // Never render "nothing scanned" as "nothing wrong" — the defect this absorb fixed.
    const why = {
      "no-rules": `no rules found in ${RULES_DIR.replace(HOME_DIR, "~")}`,
      "roots-missing": `configured root(s) do not exist: ${res.missing.join(", ")}`,
      "no-files-scanned": `roots exist but contain no CLAUDE.md — nothing was checked`,
    }[res.diagnostic];
    console.log(`\n  ${RED}rules check did not run:${RESET} ${why}`);
    console.log(`  ${DIM}This is NOT a clean result. Run \`propagate setup\` if the roots are wrong.${RESET}\n`);
    process.exit(res.exitCode);
  }

  const byRule = {};
  for (const f of res.findings) (byRule[f.rule] ??= []).push(f);
  console.log(
    `\n  ${res.rules.length} active rules · ${res.filesScanned} CLAUDE.md scanned` +
      (res.excludedWorktrees
        ? `  ${DIM}(${res.excludedWorktrees} worktree checkout${res.excludedWorktrees === 1 ? "" : "s"} excluded — same file, already scanned at its canonical path)${RESET}`
        : "") +
      `\n`,
  );
  for (const [id, fs] of Object.entries(byRule).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  rule:${id} — restated in ${fs.length} file(s)`);
    for (const f of fs) console.log(`     ${f.file.replace(HOME_DIR, "~")}:${f.hits.slice(0, 3).join(",")}`);
  }
  if (res.overrides.length) {
    console.log(`\n  ${DIM}declared deviations (not drift — ${res.overrides.length}):${RESET}`);
    for (const o of res.overrides) console.log(`     ${o.file.replace(HOME_DIR, "~")}:${o.line}  overrides: ${o.rule}`);
  }
  console.log(
    `\n  ${res.findings.length} restatement(s) across ${new Set(res.findings.map((f) => f.file)).size} file(s)\n`,
  );
  // NOT a failure, and NOT silence either. A file that references a rule AND
  // restates it was excused entirely until 2026-08-24 — measured then at 19
  // files while the line above read "0 restatement(s) across 0 file(s)". The
  // exit code deliberately stays quiet; what changed is that the number exists.
  if (res.referencedRestatements?.length) {
    const byRule = new Map();
    for (const x of res.referencedRestatements) byRule.set(x.rule, (byRule.get(x.rule) ?? 0) + 1);
    console.log(
      `  ${YELLOW}${res.referencedRestatements.length} file(s)${RESET} restate a rule they also reference ` +
        `${DIM}— excused, not checked. Each is a pointer and a copy in one file, which is what a\n` +
        `  half-finished conversion looks like. See docs/ISSUES.md N35.${RESET}`,
    );
    for (const [rule, n] of [...byRule].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${DIM}${rule.padEnd(36)} ${n}${RESET}`);
    }
    console.log("");
  }
  process.exit(res.exitCode);
}



/**
 * `release --check` — thin dispatch arm (D7): argv parsing and printing only.
 * The gates themselves live in lib/core/release.mjs, never here. See
 * docs/RELEASE.md for the procedure and why step 5 (publish) has no flag.
 *
 * There is no `--apply`/publish mode, deliberately: git history is permanent,
 * and this skill's whole premise is that it reports while a human acts.
 */
async function releaseCmd(argv = []) {
  const asJson = argv.includes("--json");
  if (!argv.includes("--check")) {
    console.error(`${RED}error:${RESET} usage: node cli.mjs release --check [--json]`);
    console.error(`${DIM}Runs the four release gates (docs/RELEASE.md) and publishes nothing.${RESET}`);
    console.error(`${DIM}There is no --apply: step 5 ("a human publishes") has no flag on purpose.${RESET}`);
    process.exit(2);
  }

  const result = runReleaseCheck();

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.exitCode);
  }

  const MARK = { passed: `${GREEN}✓${RESET}`, failed: `${RED}✗${RESET}`, "could-not-run": `${DIM}·${RESET}` };
  console.log(`${BOLD}# release --check${RESET}  ${DIM}(docs/RELEASE.md — publishes nothing)${RESET}\n`);
  for (const g of result.gates) {
    const line = g.detail || g.reason || g.status;
    console.log(`  ${MARK[g.status] ?? "?"} ${g.name.padEnd(20)} ${DIM}${line}${RESET}`);
  }

  const failed = result.gates.filter((g) => g.status === "failed");
  const couldNotRun = result.gates.filter((g) => g.status === "could-not-run");
  console.log();
  if (result.overall === "ready") {
    console.log(`${GREEN}${BOLD}release: READY${RESET} — all ${result.gates.length} gates passed. Step 5 (publish) is yours to do by hand.`);
  } else if (result.overall === "blocked") {
    console.log(
      `${RED}${BOLD}release: BLOCKED${RESET} — ${failed.length} gate(s) failed` +
        (couldNotRun.length ? `, ${couldNotRun.length} could not run` : "") +
        `.`,
    );
  } else {
    console.log(
      `${YELLOW}${BOLD}release: INCOMPLETE${RESET} — ${couldNotRun.length} gate(s) could not run. ` +
        `Not a pass — an unanswered gate must never be summarized as ready.`,
    );
  }
  process.exit(result.exitCode);
}

/**
 * `migrate-ledger` — thin dispatch arm (D7): argv parsing and printing only.
 * All logic lives in lib/edges/migrate-ledger.mjs. Built per
 * docs/DECISIONS.md (2026-08-10, "the 69 misfiled hub rows are deferred") —
 * append-only close-and-re-emit with a manifest, never an in-place rewrite.
 *
 * Dry-run by default; `--apply` writes. The source ledger is NEVER written.
 *
 * `--all-refs` / `--from-ref <ref>` (docs/ISSUES.md N25): sweep the source
 * repo's branches via `git show`, never `git checkout`. Mutually exclusive
 * with each other. In this mode `--from` names the CONCEPTUAL ledger path
 * (workspace-root/docsdir/PROPAGATION_LEDGER.jsonl) — it need not exist on
 * whatever branch happens to be checked out, so the working-tree existence
 * check below is skipped; the repo itself must still exist and be a git repo.
 */
async function migrateLedgerCmd(argv = []) {
  const asJson = argv.includes("--json");
  const apply = argv.includes("--apply");
  const allRefs = argv.includes("--all-refs");
  const fromIdx = argv.indexOf("--from");
  const intoIdx = argv.indexOf("--into");
  const fromRefIdx = argv.indexOf("--from-ref");
  const fromPath = fromIdx >= 0 ? argv[fromIdx + 1] : undefined;
  const intoPath = intoIdx >= 0 ? argv[intoIdx + 1] : undefined;
  const fromRef = fromRefIdx >= 0 ? argv[fromRefIdx + 1] : undefined;

  if (!fromPath || !intoPath) {
    console.error(`${RED}error:${RESET} usage: node cli.mjs migrate-ledger --from <ledger.jsonl> --into <ledger.jsonl> [--apply] [--all-refs | --from-ref <ref>] [--json]`);
    console.error(`${DIM}Dry-run by default. --apply writes. The --from ledger is never written.${RESET}`);
    process.exit(2);
  }
  if (allRefs && fromRef) {
    console.error(`${RED}error:${RESET} --all-refs and --from-ref are mutually exclusive`);
    process.exit(2);
  }
  if (!allRefs && !fromRef && !existsSync(fromPath)) {
    console.error(`${RED}error:${RESET} --from ledger does not exist: ${fromPath}`);
    process.exit(2);
  }

  let result;
  try {
    result = await migrateLedger({ fromPath, intoPath, apply, allRefs, fromRef });
  } catch (err) {
    console.error(`${RED}error:${RESET} ${err.message}`);
    process.exit(2);
  }

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  }

  const verb = apply ? "migrated" : "would migrate";
  console.log(`${BOLD}# migrate-ledger${RESET}  ${DIM}(${apply ? "APPLY" : "dry-run — nothing written"})${RESET}\n`);
  console.log(`  from:   ${result.from}`);
  console.log(`  into:   ${result.into}`);
  console.log(`  prefix: ${result.prefix || DIM + "(none)" + RESET}\n`);
  if (result.refMode) {
    console.log(`  refs swept: ${result.refsSwept.map((r) => r.ref).join(", ") || DIM + "(none)" + RESET}`);
    if (result.skippedRefs.length > 0) {
      console.log(`  ${YELLOW}refs skipped:${RESET}`);
      for (const s of result.skippedRefs) {
        console.log(`    ${DIM}-${RESET} ${s.ref}: ${s.reason}`);
      }
    }
    if (result.duplicateEventsCollapsed > 0) {
      console.log(`  ${result.duplicateEventsCollapsed} duplicate sighting(s) on other refs collapsed into their canonical row`);
    }
    // N41 — CONTESTED rows, printed loudly and never folded into the collapse
    // count above. A collapse is bookkeeping; this is two humans disagreeing
    // about one edge, and the old behaviour resolved it by sort order and said
    // nothing. It is a flag on the row, not a rejection: the row migrated, and
    // what needs a person is the disagreement.
    if (result.contested?.length) {
      console.log(
        `\n  ${YELLOW}${result.contested.length} CONTESTED row(s)${RESET} — the same logical row carries ` +
          `different final statuses on different branches:`,
      );
      for (const c of result.contested) {
        // dedupeKey is `type|source|timestamp` — see lib/edges/migrate-ledger.mjs.
        const [, source, ts] = c.key.split("|");
        console.log(`    ${source ?? c.key} ${DIM}${ts ?? ""}${RESET}`);
        for (const d of c.dispositions) console.log(`      ${d.ref.padEnd(34)} ${d.status}`);
      }
      console.log(
        `  ${DIM}The row migrated and carries a \`contested\` flag. Reconcile deliberately — ` +
          `sort order is not a decision.${RESET}`,
      );
    }
    const multiRef = result.idMap.filter((r) => r.appearedOnRefs && r.appearedOnRefs.length > 1);
    if (multiRef.length > 0) {
      console.log(`  ${DIM}rows seen on more than one ref:${RESET}`);
      for (const r of multiRef) {
        console.log(`    ${DIM}-${RESET} ${r.newId} (source id ${r.oldId} on ${r.ref}) also on: ${r.appearedOnRefs.filter((x) => x !== r.ref).join(", ")}`);
      }
    }
    console.log("");
  }
  console.log(`  ${verb} ${result.migrated} row(s), skipped ${result.skipped} already-migrated row(s)`);
  console.log(`  transitions: ${result.transitionsMigrated} migrated, ${result.transitionsSkipped} skipped, ${result.orphanTransitions} orphaned`);
  if (result.manifestPath) {
    console.log(`\n  manifest: ${result.manifestPath}`);
  } else if (apply) {
    console.log(`\n  ${DIM}no manifest written — nothing new was migrated${RESET}`);
  }
  if (!apply) {
    console.log(`\n${DIM}Re-run with --apply to write.${RESET}`);
  }
}

/**
 * `relocate-ledger` — thin dispatch arm (D7): argv parsing and printing only.
 * All logic lives in lib/edges/relocate-ledger.mjs. Moves ONE workspace's
 * ledger pair onto the `propagation/` layout via `git mv`, so history
 * follows. This is a relocation, never a row migration — see that module's
 * header and docs/DECISIONS.md "a propagation/ folder in every workspace".
 *
 * Dry-run by default; `--apply` writes.
 */
/**
 * `migrate` — bring a workspace to the v3 propagation layout.
 *
 * Dry-run by default, mirroring `relocate-ledger`. The preview and the write
 * come from the SAME plan object, so what it shows is what it would do.
 *
 * It prints four categories rather than one list, because collapsing them is
 * how this command would destroy state: a pointer stub migrated over the real
 * file it points at, or two genuine files silently reconciled by whichever was
 * written last.
 */
/**
 * `migrate-refs <workspace> [--apply]` — adopt a v1 branch registry.
 *
 * WIRED BECAUSE IT WAS NOT. `lib/refs/migrate-refs.mjs` shipped correct, tested
 * across six behaviours, and reachable from NOTHING outside its own test file —
 * the first live conversion was performed by an ad-hoc script. That is
 * `rule:enforcement-watches-itself` instance 6 word for word: "correct, tested,
 * unreachable". A capability nobody can invoke is indistinguishable from one
 * that was never built, and its tests pass either way.
 *
 * Dry-run by default, matching `migrate` and `relocate-ledger` rather than
 * inventing a third preview posture (`rule:safety-flag-needs-a-test`: the two
 * neighbours whose posture you reason by analogy from are exactly what produced
 * three instances of an armed --dry-run in this tree).
 */
async function migrateRefsCmd(argv = []) {
  const asJson = argv.includes("--json");
  const apply = argv.includes("--apply");
  const wsIdx = argv.indexOf("--workspace");
  const workspace = wsIdx >= 0 ? argv[wsIdx + 1] : argv.find((a) => !a.startsWith("--"));

  if (!workspace) {
    console.error(`${RED}error:${RESET} usage: node cli.mjs migrate-refs <workspace> [--apply] [--json]`);
    console.error(`${DIM}Dry-run by default. --apply writes the snapshot and appends lifecycle events.${RESET}`);
    process.exit(2);
  }

  const { migrateRefs } = await import("./lib/refs/migrate-refs.mjs");
  let plan;
  try {
    plan = await migrateRefs({ workspace, apply });
  } catch (err) {
    // Includes the concurrent-writer abort and the unparseable-snapshot refusal.
    // Both are refusals to proceed, not crashes, and both must reach the operator
    // with their reason intact rather than as a stack trace.
    console.error(`${RED}error:${RESET} ${err?.message ?? err}`);
    process.exit(1);
  }

  if (asJson) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  const verb = apply ? (plan.unchanged ? "unchanged" : "applied") : "would apply";
  console.log(`${verb}: ${plan.projects} projects · ${plan.refs} refs · previous snapshot ${plan.previous}`);
  // Distinguish "no transitions" from "did not look" — the events array being
  // empty after a real diff is a finding (agreement), not silence.
  if (!plan.events.length) {
    console.log(`${DIM}no ref transitions since the previous capture${RESET}`);
  } else {
    const byKind = {};
    for (const e of plan.events) byKind[e.event] = (byKind[e.event] ?? 0) + 1;
    console.log(
      Object.entries(byKind)
        .map(([k, n]) => `${k} ${n}`)
        .join(" · "),
    );
    for (const e of plan.events.slice(0, 20)) {
      console.log(`  ${e.event} ${e.project}/${e.ref ?? e.path}${e.classification ? ` (${e.classification})` : ""}`);
    }
    if (plan.events.length > 20) console.log(`  ${DIM}… ${plan.events.length - 20} more${RESET}`);
  }
  if (!apply) console.log(`${DIM}nothing written — re-run with --apply${RESET}`);
}

async function migrateCmd(argv = []) {
  const asJson = argv.includes("--json");
  const apply = argv.includes("--apply");
  // Deliberately hoist a directory that looks like an undeclared workspace.
  // Gated because the alternative — inferring it — is how a workspace's state
  // gets pulled into its parent cross-repo, with its history left behind.
  const force = argv.includes("--force");
  const wsIdx = argv.indexOf("--workspace");
  const workspace = wsIdx >= 0 ? argv[wsIdx + 1] : argv.find((a) => !a.startsWith("--"));

  if (!workspace) {
    console.error(`${RED}error:${RESET} usage: node cli.mjs migrate <workspace> [--apply] [--force] [--json]`);
    console.error(`${DIM}Dry-run by default. --apply performs the moves.${RESET}`);
    process.exit(2);
  }

  const { migrateWorkspace, planMigration, orphanedByMigration, sidecarsNamingMoves } = await import("./lib/migrate/workspace.mjs");

  let plan;
  try {
    plan = planMigration(workspace, { includeUndeclared: force });
  } catch (err) {
    console.error(`${RED}error:${RESET} ${err?.message ?? err}`);
    process.exit(1);
  }

  // The accepted loss, enumerated BEFORE anything moves. Edge identity embeds
  // the path (lib/edges/reconcile.mjs:99), so a moved file's verification
  // becomes unreachable. Naming it is what separates an accepted trade from a
  // silent one.
  // ATTRIBUTABLE, never silently empty. The first version of this called a
  // function that does not exist and swallowed the ReferenceError, so the
  // guardrail reported "no verifications at risk" for every workspace — the
  // exact silent-zero this command exists to prevent, written into the command
  // itself. If the enumeration cannot run, it says so and the operator decides.
  let orphans = [];
  let orphanError = null;
  try {
    const { rows } = await reconcile(WORKSPACES);
    orphans = orphanedByMigration(rows, plan);
  } catch (err) {
    orphanError = err?.message ?? String(err);
  }
  const losing = orphans.filter((o) => o.losesVerification);

  if (asJson) {
    const result = apply ? await migrateWorkspace({ workspace, apply: true, force }) : { ...plan, applied: false };
    console.log(JSON.stringify({ ...result, orphans }, null, 2));
    return;
  }

  const short = (p) => String(p).replace(`${HOME_DIR}/Documents/GitHub/`, "");
  console.log(`${BOLD}migrate${RESET} ${short(plan.workspace)}${apply ? "" : `  ${DIM}(dry run)${RESET}`}`);
  console.log(`  ${DIM}conforms before:${RESET} ${plan.conformanceBefore.conforms ? "yes" : `no — missing ${plan.conformanceBefore.missing.join(", ")}`}`);

  for (const c of plan.creates) console.log(`  ${GREEN}create${RESET}  ${short(c)}`);
  for (const m of plan.moves) {
    console.log(`  ${GREEN}move${RESET}    ${short(m.from)}`);
    console.log(`          ${DIM}-> ${short(m.to)}${m.crossRepo ? "  (cross-repo: history stays behind)" : ""}${RESET}`);
  }
  for (const a of plan.alreadyMigrated) console.log(`  ${DIM}skip    ${short(a.from)} — ${a.reason}${RESET}`);
  for (const c of plan.conflicts) console.log(`  ${RED}conflict${RESET} ${short(c.from)} — ${c.reason}`);
  // Rendered in the DRY RUN, so the operator sees this before choosing, rather
  // than discovering it as a refusal after typing --apply.
  for (const u of plan.undeclaredWorkspaces ?? []) {
    console.log(`  ${YELLOW}undeclared workspace${RESET} ${short(u.from)}`);
    console.log(`          ${DIM}${u.reason}${RESET}`);
  }
  if ((plan.undeclaredWorkspaces ?? []).length) {
    const names = [...new Set(plan.undeclaredWorkspaces.map((u) => u.project))];
    console.log(
      `  ${DIM}--apply will REFUSE while these are undeclared. Add \`workspace: true\` to ` +
        `${names.map((n) => `${n}/.propagates.yml`).join(", ")}, or pass --force to hoist them.${RESET}`,
    );
  }

  if (orphanError) {
    console.log(
      `\n  ${RED}could not enumerate at-risk verifications${RESET} ${DIM}(${orphanError})${RESET}\n` +
        `  ${DIM}This is UNKNOWN, not zero. Moving files changes edge identity; do not --apply until this resolves.${RESET}`,
    );
  } else if (losing.length) {
    console.log(`\n  ${YELLOW}${losing.length} verified edge(s) will lose their baseline${RESET} ${DIM}— edge identity embeds the path${RESET}`);
    for (const o of losing.slice(0, 8)) console.log(`    ${DIM}${o.edge_id}  ${short(o.source)}${RESET}`);
    console.log(`  ${DIM}Their events remain in the append-only store; nothing resolves them again.${RESET}`);
    console.log(`  ${DIM}Re-baseline afterwards, recorded AS a re-baseline naming this migration.${RESET}`);
  }

  // Declared edges that name a path this migration moves. REPORTS, never
  // rewrites — a sidecar key is relative to its own directory and the same
  // basename recurs across ~29 files, so blind substitution is how a working
  // declaration becomes a wrong one silently.
  //
  // Rendered BEFORE the dry-run return, deliberately: this is the list you act
  // on when deciding whether to --apply, so printing it only after the move had
  // already happened would be the wrong half of the workflow.
  //
  // Wired 2026-08-24. sidecarsNamingMoves had ZERO callers since it was written
  // — correct, tested by nothing, unreachable, so the capability the plan's M2
  // step 4 requires was indistinguishable from one never built
  // (rule:enforcement-watches-itself §2).
  try {
    const naming = sidecarsNamingMoves(plan, SEARCH_ROOTS.length ? SEARCH_ROOTS : [plan.workspace]);
    for (const h of naming) {
      console.log(`  ${YELLOW}sidecar${RESET}  ${short(h.sidecar)} names ${short(h.names)}`);
      console.log(`          ${DIM}-> update that entry to ${h.suggested}${RESET}`);
    }
    if (!naming.length && plan.moves.length) {
      console.log(`  ${DIM}sidecar  no declared edge names a moved path${RESET}`);
    }
  } catch (err) {
    // A failed scan must never read as "nothing to update".
    console.log(`  ${YELLOW}sidecar${RESET}  scan failed — ${err.message} ${DIM}(UNKNOWN, not zero)${RESET}`);
  }

  if (!apply) {
    console.log(`\n  ${DIM}nothing written. re-run with --apply${RESET}`);
    return;
  }

  let result;
  try {
    result = await migrateWorkspace({ workspace, apply: true, force, now: new Date().toISOString() });
  } catch (err) {
    console.error(`\n${RED}refused:${RESET} ${err?.message ?? err}`);
    process.exit(1);
  }
  for (const s of result.sidecars ?? []) {
    console.log(`  ${s.written ? GREEN + "sidecar" + RESET : DIM + "sidecar" + RESET}  ${short(s.path)}${s.written ? "" : ` ${DIM}(${s.reason})${RESET}`}`);
  }
  for (const cr of result.created ?? []) {
    console.log(
      `  ${cr.written ? GREEN + "created" + RESET : DIM + "created" + RESET}  ${short(cr.path)}` +
        `${cr.written ? "" : ` ${DIM}(${cr.reason})${RESET}`}`,
    );
  }
  // A refs pair that could not be built is a REASON, not a silent gap. Without
  // this line the run reported "still missing refs/snapshot.json" and left the
  // reader to guess whether the workspace is not a repo, or the build failed.
  if (result.registry?.error) {
    console.log(`  ${YELLOW}refs${RESET}  not written — ${result.registry.error}`);
  }
  const c = result.conformanceAfter;
  console.log(`\n  ${c.conforms ? GREEN + "✓" + RESET : RED + "✗" + RESET} conforms after: ${c.conforms ? "yes" : `no — still missing ${c.missing.join(", ")}`}`);
}

async function relocateLedgerCmd(argv = []) {
  const asJson = argv.includes("--json");
  const apply = argv.includes("--apply");
  const wsIdx = argv.indexOf("--workspace");
  const workspace = wsIdx >= 0 ? argv[wsIdx + 1] : undefined;

  if (!workspace) {
    console.error(`${RED}error:${RESET} usage: node cli.mjs relocate-ledger --workspace <root> [--apply] [--json]`);
    console.error(`${DIM}Dry-run by default. --apply performs the git mv.${RESET}`);
    process.exit(2);
  }

  let result;
  try {
    result = await relocateLedger({ workspace, apply });
  } catch (err) {
    if (asJson) {
      console.log(JSON.stringify({ error: err.message }, null, 2));
    } else {
      console.error(`${RED}error:${RESET} ${err.message}`);
    }
    process.exit(2);
  }

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const verb = apply ? "relocated" : "would relocate";
  console.log(`${BOLD}# relocate-ledger${RESET}  ${DIM}(${apply ? "APPLY" : "dry-run — nothing written"})${RESET}\n`);
  console.log(`  workspace: ${result.workspace}`);
  console.log(`  ${verb}:`);
  console.log(`    ${result.from.jsonl} -> ${result.into.jsonl}`);
  if (result.from.md) console.log(`    ${result.from.md} -> ${result.into.md}`);
  console.log(`  rows: ${result.rowCount}`);
  if (!apply) {
    console.log(`\n${DIM}Re-run with --apply to write.${RESET}`);
  }
}

/**
 * `freeze-ledger` — thin dispatch arm: argv parsing and printing only. All
 * logic and every refusal live in lib/edges/freeze-ledger.mjs.
 *
 * Dry-run by default, matching `relocate-ledger` and `migrate`. The preview and
 * the write take the SAME path through freezeLedgerV1, so a dry run cannot
 * promise something apply would not do.
 */
async function freezeLedgerCmd(argv = []) {
  const asJson = argv.includes("--json");
  const apply = argv.includes("--apply");
  const wsIdx = argv.indexOf("--workspace");
  const workspace = wsIdx >= 0 ? argv[wsIdx + 1] : undefined;
  const stampIdx = argv.indexOf("--stamp");
  const stamp = stampIdx >= 0 ? argv[stampIdx + 1] : undefined;
  const cross = argv.includes("--cross");

  if (!workspace) {
    console.error(`${RED}error:${RESET} usage: node cli.mjs freeze-ledger --workspace <root> [--cross] [--apply] [--stamp <date>] [--json]`);
    console.error(`${DIM}Dry-run by default. --apply moves the v1 rows and the .md into propagation/archive/.${RESET}`);
    process.exit(2);
  }

  let result;
  try {
    let ledgerOverride = null;
    if (cross) {
      // Discovery resolves a workspace's OWN ledger; the cross-repo one shares
      // the hub's propagation/ dir and is invisible to it.
      const { CROSS_LEDGER_JSONL, CROSS_LEDGER_MD } = await import("./lib/core/config.mjs");
      ledgerOverride = { jsonl: CROSS_LEDGER_JSONL, md: CROSS_LEDGER_MD };
    }
    result = await freezeLedgerV1({
      workspace,
      apply,
      ...(stamp ? { stamp } : {}),
      ...(ledgerOverride ? { ledger: ledgerOverride } : {}),
    });
  } catch (err) {
    if (asJson) console.log(JSON.stringify({ error: err.message }, null, 2));
    else console.error(`${RED}error:${RESET} ${err.message}`);
    process.exit(2);
  }

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`${BOLD}# freeze-ledger${RESET}  ${DIM}(${apply ? "APPLY" : "dry-run — nothing written"})${RESET}\n`);
  console.log(`  workspace: ${result.workspace}`);
  if (result.skipped) {
    // A named skip, never silence: eight of fourteen ledgers are legitimately empty.
    console.log(`  ${DIM}${result.skipped}${RESET}`);
    return;
  }
  console.log(`  ${apply ? "froze" : "would freeze"}:`);
  console.log(`    ${result.from.jsonl} -> ${result.into.jsonl}`);
  if (result.from.md) console.log(`    ${result.from.md} -> ${result.into.md}`);
  console.log(`  lines: ${result.lines}`);
  if (!apply) console.log(`\n${DIM}Re-run with --apply to write.${RESET}`);
}

/**
 * Scaffold a `.propagates.yml` marker. Two legitimate marker kinds (A3,
 * docs/ISSUES.md N15): a ledger-owning `--workspace` root (default — that is
 * what someone running `init` almost always means) or an edge-only
 * `--edges-only` sidecar with no `workspace: true`.
 *
 * Does NOT touch the plist or launchd (N14, docs/ISSUES.md — that used to be
 * a silent side effect of `init`, and a scoped/test run of `init` could
 * disarm the real watcher). Run `node cli.mjs reload` afterward.
 *
 * When `--workspace` is used, verifies the new directory is actually visible
 * to discovery afterward and exits non-zero if not (N15) — an init that
 * cannot produce a discoverable workspace must not report success.
 */
async function init(targetDir, flags = []) {
  if (!targetDir) {
    console.error(`${RED}error:${RESET} usage: node cli.mjs init <dir> [--workspace|--edges-only]`);
    console.error(
      `${DIM}init scaffolds a .propagates.yml in ONE directory. To configure this${RESET}\n` +
        `${DIM}machine's install (search roots, scheduler), run: node cli.mjs setup${RESET}`,
    );
    process.exit(2);
  }
  if (flags.includes("--workspace") && flags.includes("--edges-only")) {
    console.error(`${RED}error:${RESET} --workspace and --edges-only are mutually exclusive`);
    process.exit(2);
  }
  const asWorkspace = !flags.includes("--edges-only"); // default: --workspace
  const abs = path.resolve(targetDir);
  if (!existsSync(abs)) {
    console.error(`${RED}error:${RESET} ${abs} does not exist`);
    process.exit(2);
  }
  const stats = await stat(abs);
  if (!stats.isDirectory()) {
    console.error(`${RED}error:${RESET} ${abs} is not a directory`);
    process.exit(2);
  }

  // Verify target is under one of SEARCH_ROOTS (otherwise discovery won't find it).
  const underSearchRoot = SEARCH_ROOTS.some((r) => abs.startsWith(r + path.sep) || abs === r);
  if (!underSearchRoot) {
    console.log(
      `${YELLOW}warning:${RESET} ${abs} is not under any SEARCH_ROOTS (${SEARCH_ROOTS.join(", ")}).`,
    );
    console.log(`${DIM}discovery walks SEARCH_ROOTS only; add the parent to lib/config.mjs SEARCH_ROOTS if needed.${RESET}`);
  }

  const markerPath = path.join(abs, ".propagates.yml");
  if (existsSync(markerPath)) {
    console.log(`${YELLOW}already initialized:${RESET} ${markerPath} exists`);
  } else {
    const workspaceLine = asWorkspace ? "workspace: true\n\n" : "";
    const template = `# Propagation sidecar for ${path.basename(abs)} — auto-generated by \`/propagate init\`
# on ${new Date().toISOString().slice(0, 10)}.
#
# Declare source-of-truth files and their downstreams. Drift is derived on
# demand — run \`node ${SKILL_DIR}/cli.mjs reconcile\` to check
# whether a declared source has moved out of sync with its downstream(s).
# Walk through open v1 rows via \`node ${SKILL_DIR}/cli.mjs status\`.
#
# Example:
#   sources:
#     CLAUDE.md:
#       propagates_to:
#         - path: server/auth/telegram.js
#           why: "Auth posture documented in CLAUDE.md must match HMAC impl"
#           kind: code

${workspaceLine}sources: {}
`;
    await writeFile(markerPath, template, "utf8");
    console.log(`${GREEN}✓${RESET} created ${markerPath} ${DIM}(${asWorkspace ? "workspace: true — ledger-owning root" : "edges-only sidecar"})${RESET}`);
  }

  // Re-discover workspaces (now includes the new one if under SEARCH_ROOTS and asWorkspace)
  const { workspaces } = discoverWorkspacesSync(SEARCH_ROOTS);
  console.log(`${DIM}discovered ${workspaces.length} workspace${workspaces.length === 1 ? "" : "s"}:${RESET}`);
  for (const ws of workspaces) {
    const isNew = ws.root === abs;
    console.log(`  ${isNew ? GREEN + "+" : DIM + " "}${RESET} ${ws.name}  ${DIM}${ws.root}${RESET}`);
  }

  if (asWorkspace) {
    const found = workspaces.some((ws) => ws.root === abs);
    if (!found) {
      console.error(
        `\n${RED}✗ init failed:${RESET} ${abs} does not appear in discovery after being marked ` +
          `--workspace. It printed "created" but is not discoverable — that is not success.`,
      );
      console.error(
        `${DIM}check: is it under SEARCH_ROOTS? does the marker parse (run \`node cli.mjs doctor\`)? ` +
          `is \`workspace: true\` present and a strict boolean?${RESET}`,
      );
      process.exit(1);
    }
    console.log(`${GREEN}✓${RESET} verified: discoverable as a workspace`);

    // ── assert the ledger pair, do not assume it (docs/ISSUES.md N24) ──────
    //
    // `init` is one of LEDGER_SCAFFOLDING_VERBS, so the discovery call above
    // reached `ensureLedgerPair` and SHOULD have created the pair. "Should"
    // is the problem: `ensureLedgerPair` is deliberately best-effort and
    // swallows its errors, so a read-only directory or a permission fault
    // leaves no pair and says nothing — and `init complete.` printed anyway.
    //
    // N24 was filed twice on exactly this (Obsidian and Motherboard, both
    // 2026-08-14, both doctor 1 -> 3, both fixed by hand) and
    // .templates/NEW-PROJECT-CHECKLIST.md documents the workaround rather
    // than the fix. A success banner that outranks a check that just failed
    // is the inverse of the silent no-op this register exists to catch.
    //
    // Paths come from the workspace record discovery already built — no
    // second resolution, and no restating the layout, which is canonical in
    // docs/REFERENCE.md §"Ledger layout".
    const created = workspaces.find((ws) => ws.root === abs);
    const missing = [created.ledgerJsonl, created.ledgerMd].filter((p) => !existsSync(p));
    if (missing.length > 0) {
      console.error(
        `\n${RED}✗ init incomplete:${RESET} the ledger pair was not created:`,
      );
      for (const m of missing) console.error(`    ${m}`);
      console.error(
        // Deliberately does NOT contain the success banner's own wording.
        // The first draft explained itself as "`init complete.` is NOT being
        // claimed" — which made the string appear in stderr and broke the
        // test asserting the banner is absent. An error message that quotes
        // the phrase it denies is indistinguishable from the success it is
        // denying, to any check that greps for it.
        `${DIM}the marker is written and the workspace IS discoverable, so this is not a ` +
          `rollback — but success is NOT being claimed, because \`doctor\` will fail its ` +
          `"ledger JSONL/MD exists" checks until these exist. Check directory permissions, ` +
          `then re-run.${RESET}`,
      );
      process.exit(1);
    }
    console.log(
      `${GREEN}✓${RESET} ledger pair created ${DIM}${path.dirname(created.ledgerJsonl)}${RESET}`,
    );
  }

  console.log(`\n${GREEN}${BOLD}init complete.${RESET}`);
  console.log(`${DIM}next: edit ${markerPath} to declare source files + downstreams${RESET}`);
  // `reload` (regenerate plist + reload launchd) is obsolete as of 2026-08-14
  // — its only target was the now-retired v1 watcher (docs/DECISIONS.md
  // 2026-08-14; docs/REFERENCE.md's `reload` entry). Point at the live
  // detection path instead of a step that no longer does anything useful.
  console.log(`${DIM}then: run \`node cli.mjs reconcile\` to check the new edges for drift on demand${RESET}`);
}

/**
 * Regenerate the plist from currently-discovered workspaces and reload
 * launchd. Split out of `init` (N14, docs/ISSUES.md) — a setup command that
 * silently re-armed launchd as a side effect was the worst possible shape
 * for the bug where a scoped/test discovery run wrote the real plist with 0
 * WatchPaths. This is that side effect, made explicit and opt-in.
 *
 * OBSOLETE as of 2026-08-14 (docs/DECISIONS.md): the only plist this ever
 * regenerated is the v1 watcher's (`lib/plist.mjs` never touches the digest
 * plist — grep confirms it), and the watcher is retired. Not removed here
 * (no live launchd command was run to enact or verify a removal decision —
 * out of scope for that change) but there is no remaining reason to run it.
 */
async function reload() {
  console.log(`${BOLD}regenerating plist${RESET} ${DIM}${PLIST_PATH}${RESET}`);
  const result = await regeneratePlist({ workspaces: WORKSPACES });
  if (!result.ok) {
    console.error(`${RED}refused:${RESET} ${result.error}`);
    process.exit(1);
  }
  console.log(`${GREEN}✓${RESET} plist written with ${result.watchedRoots.length} workspace root${result.watchedRoots.length === 1 ? "" : "s"}`);

  console.log(`\n${BOLD}reloading launchd${RESET}`);
  try {
    const out = reloadLaunchd();
    console.log(out.split("\n").map((l) => `  ${DIM}${l}${RESET}`).join("\n"));
    console.log(`${GREEN}✓${RESET} launchd reloaded`);
  } catch (err) {
    console.error(`${RED}reload failed:${RESET} ${err.message}`);
    console.error(`${DIM}fix the error then run: launchctl bootstrap gui/$(id -u) ${PLIST_PATH}${RESET}`);
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// check — commit-time drift gate (git pre-push / CI)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve an absolute changed-file path to the workspace that owns it, via
 * nearest-ancestor matching (same rule as `currentWorkspace()` and
 * `findAllSidecarsRecursive`'s nested-workspace scoping — longest matching
 * root wins).
 * @param {string} absPath
 * @param {Array} workspaces
 * @returns {{workspace: object, rel: string} | null}
 */
/**
 * Symlinked children of a workspace root, as {link, real}. Cached per root.
 *
 * Depth 1 only, and deliberately: this exists to translate ONE path back into the
 * workspace's namespace, not to re-walk the tree. Every symlinked repo in this ecosystem
 * is an immediate child of a search root (`propagate-skill`, `rules`), and a deeper scan
 * on a fallback path would cost syscalls on every unmatched file to buy a case nobody has.
 */
const _wsLinkCache = new Map();
function workspaceLinks(root) {
  if (_wsLinkCache.has(root)) return _wsLinkCache.get(root);
  const links = [];
  try {
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (!e.isSymbolicLink()) continue;
      const link = path.join(root, e.name);
      try {
        links.push({ link, real: realpathSync(link) });
      } catch {
        // dangling link — not a match, not an error
      }
    }
  } catch {
    // unreadable root: no links, never a throw
  }
  _wsLinkCache.set(root, links);
  return links;
}

export function resolveChangedFile(absPath, workspaces = WORKSPACES) {
  const under = (root, p) => p === root || p.startsWith(root + path.sep);
  const pick = (ms, base, p) => {
    const ws = ms.reduce((best, w) => (w.root.length > best.root.length ? w : best));
    return { workspace: ws, rel: path.relative(base(ws), p) };
  };

  const matches = workspaces.filter((ws) => under(ws.root, absPath));
  if (matches.length > 0) return pick(matches, (ws) => ws.root, absPath);

  // N32. Everything except `check` stays in the sidecar's LEXICAL namespace — reconcile
  // resolves sources against a sidecarDir that came from a walk following markered
  // symlinks by their LINK path. `check` is the only caller that injects an external root
  // (`git rev-parse --show-toplevel`), which always reports the REAL path. So a repo
  // reached through a symlink matched nothing here and was dropped silently at the call
  // site — discovery worked, reconcile and graph listed its edges, and only the
  // commit-time gate was dead. In this repo that hid two DRIFTED edges across six commits.
  //
  // The fix translates real -> link, which is the direction that works. Realpath on BOTH
  // sides does not and must not be reintroduced: the workspace root is not the symlink,
  // the file is reachable only through one. lib/reconcile.mjs:431 already realpaths both
  // sides, which is why the inbound advisory functioned while the gate did not.
  let realChanged;
  try {
    realChanged = realpathSync(absPath);
  } catch {
    return null; // deleted file: no realpath, not a match
  }
  for (const ws of workspaces) {
    for (const { link, real } of workspaceLinks(ws.root)) {
      if (!under(real, realChanged)) continue;
      const viaLink = path.join(link, path.relative(real, realChanged));
      if (under(ws.root, viaLink)) {
        return { workspace: ws, rel: path.relative(ws.root, viaLink) };
      }
    }
  }
  // THIRD STRATEGY — both spellings of one directory (2026-08-20).
  //
  // The two above cover: (1) the file is lexically inside a workspace, and (2) N32, a
  // repo reached through a symlink that is a CHILD of the workspace root. Neither covers
  // the root's own ANCESTOR being a symlink: `git rev-parse --show-toplevel` returns a
  // realpath'd `/private/var/...` while discovery holds the lexical `/var/...`, so the
  // prefix test compares two names for the same directory and finds nothing.
  //
  // Found by running the edge lifecycle end to end: an identical fixture fired under
  // $HOME and was SILENT under /var/folders. reconcile said DRIFTED in both — only the
  // gate was dead, which is N32's signature in a new shape.
  //
  // Deliberately LAST. This is not the realpath-on-both-sides approach that was tried
  // and reverted during N32; that was proposed as a replacement for the real -> link
  // translation and breaks N32's case, where the workspace root is not the symlink.
  // Running it only after both existing strategies miss keeps N32 on its own path.
  for (const ws of workspaces) {
    let realRoot;
    try {
      realRoot = realpathSync(ws.root);
    } catch {
      continue; // a workspace root that no longer exists is not a match, and not fatal
    }
    if (under(realRoot, realChanged)) {
      return { workspace: ws, rel: path.relative(realRoot, realChanged) };
    }
  }

  return null;
}

/**
 * Core of `check`: given changed files (paths relative to `repoRoot`, as
 * `git diff --name-only` reports them) resolve each to its workspace's
 * declared edges (F4 — repo-relative -> absolute -> nearest-ancestor
 * workspace -> workspace-relative, on both sides before lookup) and cross-ref
 * the workspace ledger for already-open drift on that file.
 *
 * Exported (not just used internally by `check()`) so tests can drive it
 * directly against a temp workspace, without shelling out to git or reading
 * real WORKSPACES (eng-review: testability over shelling out).
 *
 * @param {string[]} changedRepoRelPaths
 * @param {string} repoRoot absolute path to the git repo root the paths are relative to
 * @param {Array} workspaces defaults to the real discovered WORKSPACES; override in tests
 * @returns {Promise<{file: string, workspace: string, coupled: string[], openLedgerIds: string[]}[]>}
 */
export async function computeCouplings(changedRepoRelPaths, repoRoot, workspaces = WORKSPACES) {
  const edgeMapCache = new Map(); // workspace.root -> {forward, reverse}
  const ledgerCache = new Map(); // workspace.ledgerJsonl -> open rows
  const results = [];

  for (const relPath of changedRepoRelPaths) {
    const abs = path.resolve(repoRoot, relPath);
    const resolved = resolveChangedFile(abs, workspaces);
    if (!resolved) continue;
    const { workspace, rel } = resolved;

    if (!edgeMapCache.has(workspace.root)) {
      edgeMapCache.set(workspace.root, await buildEdgeMap(workspace.root));
    }
    const { forward, reverse } = edgeMapCache.get(workspace.root);

    const coupled = new Set();
    if (forward.has(rel)) for (const p of forward.get(rel)) coupled.add(p);
    if (reverse.has(rel)) for (const u of reverse.get(rel)) coupled.add(u.upstreamDoc);

    if (!ledgerCache.has(workspace.ledgerJsonl)) {
      const rows = existsSync(workspace.ledgerJsonl) ? await readLedger(workspace.ledgerJsonl) : [];
      ledgerCache.set(workspace.ledgerJsonl, rows.filter((r) => r.status === "open"));
    }
    const openIds = ledgerCache
      .get(workspace.ledgerJsonl)
      .filter((r) => r.source === rel)
      .map((r) => r.id);

    if (coupled.size === 0 && openIds.length === 0) continue;
    results.push({ file: rel, workspace: workspace.name, coupled: [...coupled], openLedgerIds: openIds });
  }
  return results;
}

/**
 * Print the grouped warning and return the exit code — separated from
 * `check()`'s arg-parsing/git-shelling so tests can call this directly with
 * a synthetic changed-file list (no git, no real WORKSPACES needed).
 * @returns {Promise<{exitCode: number, couplings: Array}>}
 */
export async function runCheck(
  { changedFiles, repoRoot, strict = false, json = false },
  workspaces = WORKSPACES,
) {
  const couplings = await computeCouplings(changedFiles, repoRoot, workspaces);
  const exitCode = couplings.length === 0 ? 0 : strict ? 1 : 0;
  if (json) {
    // Printing is check()'s job when --json is set (it wraps couplings in an
    // envelope with generatedAt/repoRoot/etc, matching statusJson's shape).
    return { exitCode, couplings };
  }
  if (couplings.length === 0) {
    return { exitCode, couplings };
  }
  console.log(
    `${YELLOW}⚠ ${couplings.length} coupled file${couplings.length === 1 ? "" : "s"} in this change:${RESET}`,
  );
  for (const c of couplings) {
    const parts = [...c.coupled];
    if (c.openLedgerIds.length) {
      parts.push(`open drift ${c.openLedgerIds.map((id) => `#${id}`).join(", ")}`);
    }
    console.log(`  ${c.file} → verify: ${parts.join(", ")}`);
  }
  return { exitCode, couplings };
}

/**
 * Run `git <gitArgs>` and return the list of changed paths (repo-relative),
 * deduped. Takes an argv array and shells out via `execFileSync` — NOT a
 * template string through `execSync` — so a hostile `range` (e.g. from a
 * pre-push hook fed attacker-controlled ref names) is passed to git as a
 * single literal argument and can never be interpreted by a shell. See
 * ISSUES.md G1.
 */
export function gitDiffNames(gitArgs, repoRoot) {
  let out;
  try {
    out = execFileSync("git", gitArgs, { cwd: repoRoot, encoding: "utf8" });
  } catch (err) {
    console.error(`${RED}error:${RESET} git ${gitArgs.join(" ")} failed: ${err.message}`);
    process.exit(2);
  }
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

/**
 * Inbound drift, advisory-only (2026-08 plan Part 2: "the pre-push moment is
 * when the answer matters"). Reconciles every workspace and filters to the
 * edges pointing into `repoRoot` that have actually drifted or diverged —
 * `check`'s existing coupling gate stays exactly as it was; this is a
 * second, independent read layered alongside it, never feeding `exitCode`.
 * Errors are swallowed to `[]`: a reconcile bug must never turn an advisory
 * warning into a broken commit gate.
 */
async function inboundAdvisory(repoRoot) {
  try {
    const { rows: allRows } = await reconcile(WORKSPACES);
    return inboundRows(allRows, repoRoot).filter((r) => r.state === "DRIFTED" || r.state === "DIVERGED");
  } catch {
    return [];
  }
}

function printInboundAdvisory(inbound, repoRoot) {
  if (inbound.length === 0) return;
  console.log(
    `${YELLOW}⚠ ${inbound.length} inbound edge${inbound.length === 1 ? "" : "s"} from another repo drifted (advisory — does not affect this gate):${RESET}`,
  );
  for (const r of inbound) {
    const relSource = path.relative(repoRoot, r.source.path);
    const relDownstream = r.downstream.path ? path.relative(repoRoot, r.downstream.path) : "(unmatched)";
    console.log(`  ${relSource} → ${relDownstream}   ${r.state}`);
  }
}

async function check() {
  const args = process.argv.slice(3);
  const strict = args.includes("--strict");
  const staged = args.includes("--staged");
  const json = args.includes("--json");
  const rangeIdx = args.indexOf("--range");
  const range = rangeIdx !== -1 ? args[rangeIdx + 1] : null;

  let repoRoot;
  try {
    repoRoot = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
  } catch (err) {
    console.error(`${RED}error:${RESET} not inside a git repo (${err.message})`);
    process.exit(2);
  }

  let changedFiles;
  if (range) {
    changedFiles = gitDiffNames(["diff", "--name-only", range], repoRoot);
  } else if (staged) {
    changedFiles = gitDiffNames(["diff", "--name-only", "--cached"], repoRoot);
  } else {
    // --changed (default): working tree + staged vs HEAD, unioned.
    const workingTree = gitDiffNames(["diff", "--name-only", "HEAD"], repoRoot);
    const cached = gitDiffNames(["diff", "--name-only", "--cached"], repoRoot);
    changedFiles = [...new Set([...workingTree, ...cached])];
  }

  // Untracked files are invisible to every mode above — `git diff` compares
  // against the index and HEAD, and a file git has never seen is in neither.
  //
  // GOTCHAS G43: a brand-new `docs/GOTCHAS.md` with a correctly declared edge
  // produced EMPTY output from `check --changed`. The declaration was fine; the
  // file was untracked. Empty output for "your edge is fine" and empty output
  // for "I could not see your file" were the same output — a silent zero (G2).
  //
  // Counted and reported, never silently included: adding them would change what
  // `--changed` means, and the honest fix for a silent zero is to say the number
  // out loud, not to quietly enlarge the set.
  const untracked = range || staged ? [] : gitDiffNames(["ls-files", "--others", "--exclude-standard"], repoRoot);

  const { exitCode, couplings } = await runCheck({ changedFiles, repoRoot, strict, json });
  const inbound = await inboundAdvisory(repoRoot);
  if (json) {
    console.log(
      JSON.stringify({
        generatedAt: new Date().toISOString(),
        repoRoot,
        changedFiles,
        untracked, // G43 — reported, never folded into changedFiles
        strict,
        exitCode,
        couplings,
        inbound, // advisory only — never affects exitCode, see inboundAdvisory()
      }),
    );
  } else {
    if (untracked.length > 0) {
      console.log(
        `${YELLOW}${untracked.length} untracked file(s) not examined${RESET} ` +
          `${DIM}— \`git diff\` cannot see them. \`git add\` and re-run if one of these ` +
          `declares or is declared by an edge.${RESET}`,
      );
      for (const f of untracked.slice(0, 5)) console.log(`  ${DIM}${f}${RESET}`);
      if (untracked.length > 5) console.log(`  ${DIM}… and ${untracked.length - 5} more${RESET}`);
    }
    printInboundAdvisory(inbound, repoRoot);
  }
  process.exit(exitCode);
}

// ─────────────────────────────────────────────────────────────────────────────
// drain — the supported close path (SPEC §6: "new, and required").
//
// Non-interactive by design: this is mechanism, not interaction. `SKILL.md`'s
// drain prose is the human-facing walkthrough (AskUserQuestion per row/group);
// this command is what that walkthrough calls to actually execute a decision.
// No readline/inquirer loop here — a CLI cannot prompt a human, and a prompt
// loop cannot be tested.
//
//   node cli.mjs drain                                   — list, read-only
//   node cli.mjs drain --all                              — every workspace
//   node cli.mjs drain --close <id>[,<id>...] --status <done|wontfix|partial>
//                      [--reason "..."] [--notes "..."] [--closed-by <who>]
//   node cli.mjs drain --group <correlation_id> --status <...> [...]
//   ... --json on either mode
// ─────────────────────────────────────────────────────────────────────────────















/**
 * `reconcile` — the v2 derivation (plan §3/§7). READ-ONLY: derives state
 * from (sidecars @ working tree, the v2 event store, current content) and
 * prints it. Writes nothing — no ledger row, no store entry, no
 * state.json. Also *is* onboarding (plan §7's table): the first run against
 * an empty event store is expected to report almost everything
 * NEVER_VERIFIED, and that is the correct, honest answer, not a bug.
 *
 * `--all` reconciles every discovered workspace. Without it: the workspace
 * at cwd (mirrors `status`'s scoping via `currentWorkspace()`); falls back
 * to every workspace when cwd isn't inside one, same fallback `status` uses.
 * `--json` prints the `{generatedAt, ...}`-enveloped machine-readable form,
 * matching `statusJson()`'s convention.
 */
/**
 * Grouped view (--group-by glob|node), shared by `reconcile` and
 * `reconcile --inbound`: one header per group, member count + state
 * breakdown — "1 decision, N members" instead of N rows (§5c/§3c).
 */
function printGroupedView(groups, ungrouped, groupBy) {
  console.log(`${BOLD}# groups (by ${groupBy})${RESET}\n`);
  for (const g of groups) {
    const statesStr = Object.entries(g.states)
      .map(([s, n]) => `${n} ${s}`)
      .join(", ");
    console.log(`  ${BOLD}${g.key}${RESET}  ${DIM}(${g.count} member${g.count === 1 ? "" : "s"} — ${statesStr})${RESET}`);
  }
  if (ungrouped.length) {
    console.log(`  ${DIM}${ungrouped.length} edge${ungrouped.length === 1 ? "" : "s"} with no ${groupBy} to group by${RESET}`);
  }
  console.log();
}

/** The repo containing cwd, via `git rev-parse` — same resolution `check()` uses. Exits 2, not throws, when cwd isn't inside a repo (a CLI-boundary concern, not a library one). */
function repoRootAtCwd() {
  try {
    return execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
  } catch (err) {
    console.error(`${RED}error:${RESET} not inside a git repo (${err.message})`);
    process.exit(2);
  }
}

/**
 * `reconcile --inbound` — the delivery view (2026-08 plan Part 2: "make
 * drift that arrives from another repo visible where a person can act on
 * it"). A pure filter over reconcile()'s own rows (lib/reconcile.mjs's
 * `inboundRows`) — reconcile already resolves both sides' repos and carries
 * absolute paths on both, so this is not a second computation.
 *
 * Reconciles EVERY discovered workspace, never just cwd's: a cross-repo
 * edge's sidecar lives beside its SOURCE, which by construction sits
 * outside this repo — scoping enumeration to cwd's workspace would
 * silently miss the very edges this view exists to surface.
 *
 * Pull-based, on purpose: this prints on demand, in the repo you're
 * standing in. It does not push anywhere — see docs/INBOUND.md for the
 * limit that follows from that.
 */
async function reconcileInbound({ json, groupBy }) {
  const repoRoot = repoRootAtCwd();

  const { rows: allRows, stats } = await reconcile(WORKSPACES);
  const rows = inboundRows(allRows, repoRoot);
  const { groups, ungrouped } = groupRows(rows, groupBy);

  if (json) {
    console.log(
      JSON.stringify({ generatedAt: new Date().toISOString(), repoRoot, stats, groupBy, groups, ungrouped, rows }),
    );
    return;
  }

  console.log(
    `${BOLD}INBOUND${RESET} — edges pointing at this repo  ${DIM}(${rows.length} of ${stats.expanded} expanded edges)${RESET}\n`,
  );
  if (rows.length === 0) {
    console.log(`  none — no cross-repo edge currently points into ${repoRoot}\n`);
  } else {
    for (const r of rows) {
      const relSource = path.relative(repoRoot, r.source.path);
      const relDownstream = r.downstream.path ? path.relative(repoRoot, r.downstream.path) : "(unmatched)";
      const age = r.since ? `  ${formatAge(Date.now() - Date.parse(r.since))}` : "";
      console.log(`  ${relSource} → ${relDownstream}   ${r.state}${age}`);
    }
    console.log();
  }

  if (groupBy !== "none") printGroupedView(groups, ungrouped, groupBy);
}

/**
 * Persist one run record for `reconcile`'s invocation (plan §3). Called from
 * the CALLER of reconcile(), never from reconcile() itself — reconcile.mjs's
 * own header states it is read-only and must stay that way.
 *
 * `stats.byState` is already the per-state edge count reconcile() returns
 * (used two lines below this call site to print the same numbers), so this
 * reuses it rather than re-deriving it from `rows`. The resolved ref per
 * repo reuses `resolveObservedRef` (lib/edges/provenance.mjs) — the same
 * three-outcome rule the provenance wedge established for events, applied
 * here to workspace roots instead of edge sides.
 *
 * Never lets a run-record write failure take down the `reconcile` command
 * itself: this is an additive audit trail on a command whose primary job is
 * printing a read-only derivation, not a precondition for it succeeding.
 */
async function recordReconcileRun(workspaces, stats) {
  const refs = {};
  for (const ws of workspaces) {
    const { observed_on_ref } = resolveObservedRef({ path: ws.root, ref: null });
    refs[ws.root] = observed_on_ref;
  }
  try {
    await appendRun({
      roots: workspaces.map((ws) => ws.root),
      refs,
      edge_counts: { ...stats.byState },
      durationMs: stats.durationMs,
    });
  } catch (err) {
    console.error(`${DIM}(run record not written: ${err.message})${RESET}`);
  }
}

/**
 * Parse the ref-pair flags shared by `reconcile` and `verify`.
 *
 * `reconcile()` has ALWAYS destructured `opts.refs = {source, downstream}`
 * (reconcile.mjs:250-252) and threaded a ref per side into every row.
 * Nothing ever SET it, so all 1,912 events in the store read "working-tree"
 * on both ends. This is the flag half that connects the two.
 *
 * ONE definition, two commands. `verify` needs it as much as `reconcile`
 * does — a ref that can be reconciled but never verified could never reach
 * an event, so the pair would be unobservable in the store it exists for.
 * lib/edges/provenance.mjs's header records what happened the last time
 * this kind of rule was written out at each call site instead: three copies
 * of `row.source.ref || "working-tree"`, collapsing a failed lookup into a
 * successful read.
 *
 * Two flags rather than one, because the sides are genuinely independent:
 * ~13% of declared edges join files in different repos with unrelated
 * branch lines, and "the ref" is not something those edges have. `--ref` is
 * the both-sides shorthand for the single-repo case and is REJECTED
 * alongside the specific flags rather than silently losing to one of them.
 *
 * @param {string[]} args
 * @returns {{source?: string, downstream?: string}}
 */
function parseRefFlags(args) {
  const refArg = (flag) => {
    const i = args.indexOf(flag);
    if (i === -1) return null;
    const v = args[i + 1];
    if (!v || v.startsWith("--")) {
      console.error(`${RED}error:${RESET} ${flag} requires a ref (got ${JSON.stringify(v ?? null)})`);
      process.exit(2);
    }
    return v;
  };
  const bothRef = refArg("--ref");
  let sourceRef = refArg("--source-ref");
  let downstreamRef = refArg("--downstream-ref");
  if (bothRef && (sourceRef || downstreamRef)) {
    console.error(
      `${RED}error:${RESET} --ref is shorthand for both sides; it cannot be combined with ` +
        `--source-ref/--downstream-ref. Give the two explicitly instead.`,
    );
    process.exit(2);
  }
  if (bothRef) {
    sourceRef = bothRef;
    downstreamRef = bothRef;
  }
  const refs = {};
  if (sourceRef) refs.source = sourceRef;
  if (downstreamRef) refs.downstream = downstreamRef;
  return refs;
}

async function reconcileCmd() {
  const args = process.argv.slice(3);
  const json = args.includes("--json");
  const showAll = args.includes("--all");
  const inbound = args.includes("--inbound");
  const groupByIdx = args.indexOf("--group-by");
  const groupBy = groupByIdx !== -1 ? args[groupByIdx + 1] : "none";
  if (!["glob", "node", "none"].includes(groupBy)) {
    console.error(`${RED}error:${RESET} --group-by must be one of glob|node|none (got ${JSON.stringify(groupBy)})`);
    process.exit(2);
  }

  const refs = parseRefFlags(args);

  if (inbound) {
    if (refs.source || refs.downstream) {
      console.error(`${RED}error:${RESET} --inbound does not take a ref yet (docs/ISSUES.md N25)`);
      process.exit(2);
    }
    await reconcileInbound({ json, groupBy });
    return;
  }

  const cur = currentWorkspace();
  const workspaces = showAll || !cur ? WORKSPACES : [cur];

  const { rows, stats } = await reconcile(workspaces, { refs });
  await recordReconcileRun(workspaces, stats);
  const { groups, ungrouped } = groupRows(rows, groupBy);

  if (json) {
    console.log(
      JSON.stringify({ generatedAt: new Date().toISOString(), stats, groupBy, groups, ungrouped, rows }),
    );
    return;
  }

  console.log(`${BOLD}# reconcile${RESET}  ${DIM}(read-only derivation, writes nothing)${RESET}\n`);
  console.log(
    `  ${workspaces.length} workspace${workspaces.length === 1 ? "" : "s"} — ` +
      `${stats.edges} declared edge${stats.edges === 1 ? "" : "s"} -> ${stats.expanded} expanded ` +
      `(${stats.unresolvable} unresolvable) in ${stats.durationMs}ms\n`,
  );
  for (const state of STATES) {
    const n = stats.byState[state] || 0;
    if (n === 0) continue;
    console.log(`  ${YELLOW}${String(n).padStart(4)}${RESET}  ${state}`);
  }
  console.log();

  // Grouped view (--group-by glob|node). Left out when groupBy === "none" so
  // default output is byte-identical to before this flag existed.
  if (groupBy !== "none") printGroupedView(groups, ungrouped, groupBy);
}

/**
 * `why <edge_id> [--all] [--json]` — thin dispatch arm (D7): parses argv,
 * calls the lib module, prints, sets the exit code. All the logic —
 * disposition-change filtering, the unknown-edge/no-events/found
 * distinction — lives in lib/edges/why.mjs's describeWhy().
 */
async function whyCmd() {
  const args = process.argv.slice(3);
  const json = args.includes("--json");
  const showAll = args.includes("--all");
  const edgeIdArg = args.find((a) => !a.startsWith("--"));

  if (!edgeIdArg) {
    console.error(`${RED}error:${RESET} usage: node cli.mjs why <edge_id> [--all] [--json]`);
    process.exit(2);
  }

  const result = await describeWhy(edgeIdArg, { all: showAll });

  if (json) {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), ...result }));
    process.exit(result.status === "unknown-edge" ? 1 : 0);
  }

  console.log(`${BOLD}# why ${result.edge_id}${RESET}  ${DIM}(${showAll ? "full history" : "disposition changes only"})${RESET}\n`);

  if (result.status !== "found") {
    console.log(`  ${DIM}${result.message}${RESET}`);
    process.exit(result.status === "unknown-edge" ? 1 : 0);
  }

  console.log(
    `  ${result.shown.length} of ${result.totalEvents} event${result.totalEvents === 1 ? "" : "s"} shown` +
      (result.malformed ? `  ${DIM}(${result.malformed} malformed line(s) skipped)${RESET}` : ""),
  );
  console.log();
  for (const e of result.shown) {
    const where = e.position.recorded
      ? `branch=${e.position.branch ?? "(detached)"} commit=${e.position.commit ? e.position.commit.slice(0, 8) : "?"}${e.position.dirty ? " [dirty]" : ""}`
      : `${DIM}${e.position.note}${RESET}`;
    console.log(`  ${e.ts}  ${BOLD}${e.disposition}${RESET}  ${where}`);
    console.log(
      `    ${DIM}by=${e.by ?? "?"} by_kind=${e.by_kind ?? "(not recorded)"} ` +
        `src-ref=${e.observed_on_ref ?? "?"} ds-ref=${e.downstream_on_ref ?? "(not recorded)"}${RESET}`,
    );
    if (e.reason) console.log(`    ${e.reason}`);
    console.log();
  }
  process.exit(0);
}

async function drain() {
  const args = process.argv.slice(3);
  const json = args.includes("--json");
  // The drain family lives in commands/drain.mjs (#31 T5). Dynamic, like the
  // other command modules, so `status`/`check` never load it.
  const { drainList, drainClose } = await import("./commands/drain.mjs");
  if (args.includes("--close") || args.includes("--group")) {
    await drainClose(args, json);
  } else {
    await drainList(args, json);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// verify — the v2 write side (plan §4: dispositions against reconcile's
// derived state, not a remembered ledger row).
//
// Non-interactive by design, same discipline as `drain` above: this is
// mechanism, SKILL.md's prose is the human-facing walkthrough that calls it.
// Batch is the default (plan: "Batch is the default, not a feature") — a
// matched --node/--glob applies the same disposition/reason to every member,
// one event per edge, never a composite event across edges.
// ─────────────────────────────────────────────────────────────────────────────

/** A downstream `path` containing glob metacharacters is a generator, not a
 * concrete edge — same test as lib/reconcile.mjs's (unexported) GLOB_CHARS
 * and watcher.mjs's. Duplicated rather than imported: reconcile.mjs's
 * internals stay reconcile.mjs's (only `groupRows` was added to its exports
 * for this feature), matching content-id.mjs's precedent of duplicating
 * `resolveRepo` rather than reaching into a module another lane owns. */
const VERIFY_GLOB_CHARS = /[*?[\]]/;

function parseVerifyArgs(args) {
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : undefined;
  };
  return {
    edge: get("--edge") ?? null,
    node: get("--node") ?? null,
    glob: get("--glob") ?? null,
    state: get("--state") ?? null,
    disposition: get("--disposition") ?? null,
    reason: get("--reason"),
    apply: args.includes("--apply"),
    json: args.includes("--json"),
    outOfOrder: args.includes("--out-of-order"),
  };
}

/**
 * Selection (plan "THE COMMAND"): every provided selector narrows (AND, not
 * OR) — `--state` on its own is never sufficient (enforced by the caller
 * requiring at least one of --edge/--node/--glob), but combined with one of
 * them it narrows further, e.g. "every member of this glob that is still
 * DRIFTED." Exported for direct testing without a subprocess.
 *
 * @param {Array} rows - reconcile()'s output rows
 * @param {{edge?: string|null, node?: string|null, glob?: string|null, state?: string|null}} sel
 */
export function selectVerifyRows(rows, sel) {
  return rows.filter((r) => {
    if (sel.edge && r.edge_id !== sel.edge) return false;
    if (sel.node && r.node_id !== sel.node) return false;
    if (sel.glob && r.glob !== sel.glob) return false;
    if (sel.state && r.state !== sel.state) return false;
    return true;
  });
}

/**
 * DIVERGED guard (plan "Two need CLI-level care"): `both-reconciled` is the
 * ONLY disposition that may follow a DIVERGED edge, and it may ONLY follow a
 * DIVERGED edge — verifying without reconciling would assert something
 * nobody checked (both sides moved independently since the last known-good
 * pair). Exported for direct testing.
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
 * What state an edge must read after a successful write, per disposition
 * (plan §4's side-effect column). Every disposition re-pins to the CURRENT
 * content pair EXCEPT `deferred`, which never pins — so the state it was in
 * before the write is the state it must still be in after. Exported for
 * direct (non-subprocess) testing of the "verify-after-write" logic.
 *
 * @param {string} disposition
 * @param {string} priorState - the row's state at selection time
 */
export function expectedStateAfter(disposition, priorState) {
  return disposition === "deferred" ? priorState : "CLEAN";
}

/**
 * Verify-after-write (plan, non-negotiable): re-reconcile and confirm every
 * applied edge landed in `expectedStateAfter`. "It didn't throw" is never
 * proof a write landed (GOTCHAS G13). Pure — takes the freshly reconciled
 * rows and the set of writes just applied, returns confirmed/failed; no I/O,
 * so it's directly unit-testable against a synthetic "the state didn't
 * change" fixture without needing to race a real write.
 *
 * @param {Array<{edge_id: string, node_id: string, disposition: string, priorState: string, event_id: string}>} applied
 * @param {Array} afterRows - reconcile()'s output, re-run AFTER the writes
 * @returns {{confirmed: Array, failed: Array}}
 */
export function computeVerifyAfterWrite(applied, afterRows) {
  const afterByEdgeId = new Map(afterRows.map((r) => [r.edge_id, r]));
  const confirmed = [];
  const failed = [];
  for (const a of applied) {
    const after = afterByEdgeId.get(a.edge_id);
    const expected = expectedStateAfter(a.disposition, a.priorState);
    if (!after) {
      failed.push({ ...a, error: "edge vanished after write — cannot confirm" });
    } else if (after.state !== expected) {
      failed.push({ ...a, error: `expected state ${expected} after write, got ${after.state}` });
    } else {
      confirmed.push({ ...a, state: after.state });
    }
  }
  return { confirmed, failed };
}

/**
 * Find the declaring sidecar entry for a reconciled row — the (sidecarPath,
 * sourceKey, propagates_to index) that produced `row.edge_id`. Needed only
 * by `decoupled`, which edits the declaration rather than just the event
 * log; every other disposition needs nothing but the row itself.
 *
 * Recomputes edge_id per candidate declaration (literal path, glob-as-
 * generator, and every current glob match) and compares against
 * `row.edge_id` — the same three shapes lib/reconcile.mjs's
 * `expandGenerators` produces, walked independently here so this file
 * doesn't reach into reconcile.mjs's unexported internals (only `groupRows`
 * was added to its surface for this feature).
 *
 * @param {Array<{root: string}>} workspaces
 * @param {{node_id: string, edge_id: string, source: {path: string}}} row
 * @returns {Promise<{sidecarPath: string, sourceKey: string, index: number, why: string, declaredPath: string}|null>}
 */
async function locateEdgeDeclaration(workspaces, row) {
  const workspaceRoots = workspaces.map((w) => w.root);
  for (const ws of workspaces) {
    const sidecarPaths = await findAllSidecarsRecursive(ws.root, workspaceRoots);
    for (const sidecarPath of sidecarPaths) {
      let sidecar;
      try {
        sidecar = await loadSidecar(sidecarPath);
      } catch {
        continue; // malformed sidecar: doctor's concern, same as reconcile.mjs
      }
      if (!sidecar || !sidecar.sources) continue;
      const sidecarDir = path.dirname(sidecarPath);

      for (const sourceKey of Object.keys(sidecar.sources)) {
        const sourceAbs = path.resolve(sidecarDir, sourceKey);
        if (sourceAbs !== row.source.path) continue;

        const downstreams = downstreamsFor(sidecar, sourceKey);
        for (let index = 0; index < downstreams.length; index++) {
          const d = downstreams[index];
          const isGlob = VERIFY_GLOB_CHARS.test(d.path);

          if (!isGlob) {
            const downstreamAbs = path.resolve(sidecarDir, d.path);
            if (edgeIdFor(row.node_id, downstreamAbs, d.why) === row.edge_id) {
              return { sidecarPath, sourceKey, index, why: d.why, declaredPath: d.path };
            }
            continue;
          }

          // Glob generator — the zero-match ("UNMATCHED") identity is keyed
          // on the pattern text itself (lib/reconcile.mjs's unmatchedGlob
          // row); a genuine match is keyed on the resolved concrete path.
          if (edgeId(row.node_id, d.path, d.why) === row.edge_id) {
            return { sidecarPath, sourceKey, index, why: d.why, declaredPath: d.path };
          }
          let matches = [];
          try {
            matches = globSync(d.path, { cwd: sidecarDir }).filter((m) => !m.includes("node_modules/"));
          } catch {
            matches = [];
          }
          for (const m of matches) {
            const downstreamAbs = path.resolve(sidecarDir, m);
            if (edgeIdFor(row.node_id, downstreamAbs, d.why) === row.edge_id) {
              return { sidecarPath, sourceKey, index, why: d.why, declaredPath: d.path };
            }
          }
        }
      }
    }
  }
  return null;
}

/** Human-readable description of the sidecar edit `decoupled` requires — printed
 * whether or not `--apply` performs it, so the two paths never say different things. */
function describeSidecarEdit(loc) {
  return `remove sources.${JSON.stringify(loc.sourceKey)}.propagates_to[${loc.index}] ` +
    `(downstream: ${loc.declaredPath}, why: ${JSON.stringify(loc.why)}) from ${loc.sidecarPath}`;
}

/**
 * Perform the sidecar edit `decoupled --apply` requires: remove exactly the
 * one `propagates_to` entry the declaration was located at, via `yaml`'s
 * Document API (not parse+reserialize) so comments and formatting elsewhere
 * in the file survive. Drops the whole `sources.<key>` entry when it was the
 * last downstream under that source — an empty `propagates_to: []` left
 * behind is a declaration with nothing to declare.
 */
async function applyDecoupledEdit(loc) {
  const raw = await readFile(loc.sidecarPath, "utf8");
  const doc = YAML.parseDocument(raw);
  const seq = doc.getIn(["sources", loc.sourceKey, "propagates_to"], true);
  if (!seq || !Array.isArray(seq.items)) {
    throw new Error(
      `sources.${JSON.stringify(loc.sourceKey)}.propagates_to not found (or not a sequence) in ${loc.sidecarPath} — sidecar changed since selection?`,
    );
  }
  if (loc.index < 0 || loc.index >= seq.items.length) {
    throw new Error(
      `index ${loc.index} out of range for sources.${JSON.stringify(loc.sourceKey)}.propagates_to (${seq.items.length} entries) in ${loc.sidecarPath} — sidecar changed since selection?`,
    );
  }
  seq.items.splice(loc.index, 1);
  if (seq.items.length === 0) {
    doc.deleteIn(["sources", loc.sourceKey]);
  }
  await writeFile(loc.sidecarPath, String(doc), "utf8");
}

/** `verify --disposition decoupled` — print-by-default, `--apply` to write. */
async function runDecoupled(selected, workspaces, opts) {
  const { apply, reason, json } = opts;
  const results = [];

  for (const row of selected) {
    const loc = await locateEdgeDeclaration(workspaces, row);
    if (!loc) {
      results.push({
        edge_id: row.edge_id,
        node_id: row.node_id,
        ok: false,
        error: "could not locate this edge's declaration in any sidecar (sidecar changed since reconcile ran?)",
      });
      continue;
    }
    const edit = describeSidecarEdit(loc);

    if (!apply) {
      results.push({ edge_id: row.edge_id, node_id: row.node_id, ok: true, applied: false, edit });
      continue;
    }

    // Sidecar edit first: it is the concrete, visible fact. If the event
    // write below fails, "the sidecar no longer declares this" is still
    // true and safe; the reverse order would risk the event claiming
    // "decoupled" while the sidecar still declares the edge — exactly the
    // disagreement the plan warns against.
    try {
      await applyDecoupledEdit(loc);
    } catch (err) {
      results.push({ edge_id: row.edge_id, node_id: row.node_id, ok: false, error: `sidecar edit failed: ${err.message}` });
      continue;
    }

    try {
      const provenance = resolveProvenance(row, "human");
      const payload = {
        edge_id: row.edge_id,
        node_id: row.node_id,
        disposition: "decoupled",
        by: process.env.USER || "verify",
        ...provenance,
        source_content: row.source.contentId,
        downstream_content: row.downstream.contentId,
      };
      if (reason !== undefined) payload.reason = reason;
      const stamped = await appendEvent(payload);
      results.push({ edge_id: row.edge_id, node_id: row.node_id, ok: true, applied: true, edit, event_id: stamped.event_id });
    } catch (err) {
      results.push({
        edge_id: row.edge_id,
        node_id: row.node_id,
        ok: false,
        applied: true,
        edit,
        error: `sidecar edit landed but the event write failed: ${err.message}`,
      });
    }
  }

  // Verify-after-write for the applied removals: the edge must no longer be
  // enumerable at all — a declaration that still resolves after being
  // "removed" is a write that didn't land.
  if (apply) {
    const { rows: afterRows } = await reconcile(workspaces);
    const stillPresent = new Set(afterRows.map((r) => r.edge_id));
    for (const r of results) {
      if (!r.ok || !r.applied) continue;
      if (stillPresent.has(r.edge_id)) {
        r.ok = false;
        r.error = "edge still present after the sidecar edit — write did not land";
      }
    }
  }

  const exitCode = results.some((r) => !r.ok) ? 1 : 0;
  if (json) {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), disposition: "decoupled", apply, results, exitCode }));
  } else {
    for (const r of results) {
      if (r.ok && r.applied) {
        console.log(`${GREEN}✓${RESET} decoupled ${r.edge_id}  ${DIM}${r.edit}${RESET}`);
      } else if (r.ok && !r.applied) {
        console.log(`${YELLOW}·${RESET} would decouple ${r.edge_id}  ${DIM}${r.edit}${RESET}`);
        console.log(`  ${DIM}(pass --apply to perform this edit)${RESET}`);
      } else {
        console.log(`${RED}✗${RESET} ${r.edge_id}  ${RED}${r.error}${RESET}`);
      }
    }
  }
  process.exit(exitCode);
}

/** Every disposition except `decoupled` (handled separately above): append
 * one verification event per selected edge, then confirm the write landed. */
/**
 * The event payload for one row. ONE definition, shared by the dry run and the
 * write — if these two ever built different payloads, the preview would be a
 * description of something that never happens.
 */
function buildEventPayload(row, disposition, reason) {
  const payload = {
    edge_id: row.edge_id,
    node_id: row.node_id,
    disposition,
    by: process.env.USER || "verify",
    ...resolveProvenance(row, "human"),
  };
  if (reason !== undefined) payload.reason = reason;
  if (disposition !== "deferred") {
    payload.source_content = row.source.contentId;
    payload.downstream_content = row.downstream.contentId;
  }
  return payload;
}

async function runDispositionBatch(selected, workspaces, opts) {
  const { disposition, reason, json, apply } = opts;

  // ── dry run by default ────────────────────────────────────────────────────
  //
  // Until 2026-08-17 `--apply` gated ONLY the `decoupled` path (which edits a
  // sidecar file); every other disposition wrote its event the moment the
  // command was invoked. cli.mjs's own header said "does NOT touch the file
  // unless --apply is given", which is true of the sidecar and false of the
  // event store — and a session read it the second way, ran the guard matrix
  // without --apply, and appended 11 events that asserted verifications
  // nobody had performed. Three real worklist items closed themselves.
  //
  // A verification is a claim a human is making. It must not be the default
  // side effect of asking a question. See docs/GOTCHAS.md and the
  // DECISIONS.md entry of the same date.
  if (!apply) {
    // Build the REAL payload and run the REAL validator. Previewing a
    // simplified shape would let the dry run promise a write that `--apply`
    // then refuses (e.g. wontfix with no --reason).
    const { dryValidateEvent } = await import("./lib/edges/events.mjs");
    const preview = selected.map((row) => {
      const payload = buildEventPayload(row, disposition, reason);
      return {
        edge_id: row.edge_id,
        node_id: row.node_id,
        disposition,
        priorState: row.state,
        refusal: divergedGuard(row.state, disposition) || dryValidateEvent(payload) || null,
      };
    });
    if (json) {
      console.log(
        JSON.stringify(
          { generatedAt: new Date().toISOString(), disposition, apply: false, wouldWrite: preview },
          null,
          2,
        ),
      );
      return;
    }
    const writable = preview.filter((p) => !p.refusal);
    console.log(
      `${BOLD}would write ${writable.length} event(s)${RESET} ${DIM}— nothing has been written${RESET}`,
    );
    for (const p of preview) {
      if (p.refusal) {
        console.log(`  ${RED}refused${RESET}  ${p.edge_id}  ${DIM}${p.refusal}${RESET}`);
      } else {
        console.log(`  ${p.edge_id}  ${disposition}  ${DIM}${p.priorState} -> (re-derived after write)${RESET}`);
        console.log(`           ${DIM}${shortPath(p.node_id)}${RESET}`);
      }
    }
    console.log(`\n  ${DIM}pass ${RESET}${BOLD}--apply${RESET}${DIM} to write these to the event store${RESET}`);
    return;
  }

  const applied = [];
  const refused = [];

  for (const row of selected) {
    const refusal = divergedGuard(row.state, disposition);
    if (refusal) {
      refused.push({ edge_id: row.edge_id, node_id: row.node_id, error: refusal });
      continue;
    }

    const payload = buildEventPayload(row, disposition, reason);

    // lib/events.mjs's validateEvent is the one place these rules are
    // enforced (missing reason on wontfix/baselined, deferred pinning
    // content, etc.) — let it throw and surface `err.message` verbatim.
    // Never re-implement the check here, never print a stack trace (GOTCHAS
    // G20 / plan: "let it throw and print err.message").
    let stamped;
    try {
      stamped = await appendEvent(payload);
    } catch (err) {
      refused.push({ edge_id: row.edge_id, node_id: row.node_id, error: err.message });
      continue;
    }
    applied.push({
      edge_id: row.edge_id,
      node_id: row.node_id,
      disposition,
      priorState: row.state,
      event_id: stamped.event_id,
    });
  }

  // Verify after write (non-negotiable): a write that returned is not a
  // write that landed. Re-reconcile ONCE for the whole batch (not per edge —
  // same batching discipline as reconcile() itself) and confirm every
  // applied edge reached its expected state.
  let confirmed = [];
  let failed = [];
  if (applied.length > 0) {
    const { rows: afterRows } = await reconcile(workspaces);
    ({ confirmed, failed } = computeVerifyAfterWrite(applied, afterRows));
  }

  const exitCode = refused.length > 0 || failed.length > 0 ? 1 : 0;

  if (json) {
    console.log(
      JSON.stringify({
        generatedAt: new Date().toISOString(),
        disposition,
        selectedCount: selected.length,
        confirmed,
        refused,
        failed,
        exitCode,
      }),
    );
  } else {
    for (const c of confirmed) {
      console.log(`${GREEN}✓${RESET} ${c.edge_id}  ${disposition} → ${c.state}  ${DIM}(event ${c.event_id})${RESET}`);
    }
    for (const f of failed) {
      console.log(`${RED}✗${RESET} ${f.edge_id}  ${RED}${f.error}${RESET}`);
    }
    for (const r of refused) {
      console.log(`${RED}✗${RESET} ${r.edge_id}  ${RED}${r.error}${RESET}`);
    }
  }
  process.exit(exitCode);
}

async function verifyCmd() {
  const args = process.argv.slice(3);
  const opts = parseVerifyArgs(args);

  if (!opts.edge && !opts.node && !opts.glob) {
    console.error(
      `${RED}error:${RESET} at least one selector is required: --edge <edge_id> | --node <node_id> | --glob <pattern>`,
    );
    process.exit(2);
  }
  if (!opts.disposition) {
    console.error(`${RED}error:${RESET} --disposition <${DISPOSITIONS.join("|")}> is required`);
    process.exit(2);
  }
  if (!DISPOSITIONS.includes(opts.disposition)) {
    console.error(
      `${RED}error:${RESET} unknown disposition ${JSON.stringify(opts.disposition)}; must be one of ${DISPOSITIONS.join(" | ")}`,
    );
    process.exit(2);
  }

  // Selection is precise (an exact edge_id, node_id, or glob string), so
  // `verify` always reconciles the full discovered graph rather than
  // scoping to cwd's workspace the way `status`/`drain`/`reconcile` default
  // to — a selector naming an edge in a different workspace must still
  // resolve, not silently miss.
  const workspaces = WORKSPACES;
  const { rows } = await reconcile(workspaces, { refs: parseRefFlags(process.argv.slice(3)) });
  const selected = selectVerifyRows(rows, opts);

  if (selected.length === 0) {
    console.error(`${RED}error:${RESET} no edges matched the given selector(s)`);
    process.exit(1);
  }

  // ── ordering guard ────────────────────────────────────────────────────────
  //
  // A verification asserts "these two blobs are consistent." If the SOURCE is
  // itself an unsettled downstream, that assertion is about a source nobody
  // has confirmed — and the resulting `propagated` event then reads as CLEAN
  // forever. Measured 2026-08-17: 4 of the 23 non-CLEAN edges sat in exactly
  // that position, and nothing could see it.
  //
  // Warn-with-override rather than hard block: a deferred or wontfix ancestor
  // would otherwise wall off its entire subtree permanently, and the close is
  // the human's call (SKILL.md's "never decide alone" cuts both ways).
  //
  // Exempt by construction:
  //   deferred   — pins nothing; validateEvent in lib/events.mjs refuses
  //                content on it, so there is no pair to pin wrongly.
  //   decoupled  — removes the edge; removal cannot be out of order.
  // NOT exempt: wontfix and baselined both pin, and a baseline against an
  // unverified source is precisely the claim `validateEvent` already refuses
  // to let masquerade as a verification.
  const GUARD_EXEMPT = new Set(["deferred", "decoupled"]);
  if (!GUARD_EXEMPT.has(opts.disposition) && !opts.outOfOrder) {
    const { buildGraph, blockedBy } = await import("./lib/graph/graph.mjs");
    const graph = buildGraph(rows, { workspaceRoots: workspaces.map((w) => w.root) });

    const offenders = [];
    for (const r of selected) {
      const blockers = blockedBy(graph, r.edge_id);
      if (blockers.length) offenders.push({ row: r, blockers });
    }

    if (offenders.length) {
      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              error: "out-of-order",
              disposition: opts.disposition,
              offenders: offenders.map((o) => ({
                edge_id: o.row.edge_id,
                node_id: o.row.node_id,
                source: o.row.source.path,
                downstream: o.row.downstream.path,
                blockedBy: o.blockers,
              })),
              override: "--out-of-order",
            },
            null,
            2,
          ),
        );
        process.exit(3);
      }
      // Group by SOURCE: selecting by --node or --glob routinely picks several
      // edges that share one source, and printing that source's identical
      // upstream list once per edge buries the signal in its own repetition.
      const bySource = new Map();
      for (const o of offenders) {
        const key = o.row.source.path;
        if (!bySource.has(key)) bySource.set(key, { blockers: o.blockers, targets: [] });
        bySource.get(key).targets.push(o.row.downstream.path);
      }

      console.error(`${YELLOW}! OUT OF ORDER${RESET}`);
      for (const [source, { blockers, targets }] of bySource) {
        console.error(`  ${shortPath(source)} is itself ${blockers[0].state}`);
        console.error(`  upstream:`);
        for (const b of blockers) {
          console.error(
            `    ${shortPath(b.from)} -> ${shortPath(b.to)}  ${DIM}(edge ${b.edge_id}, ${b.state})${RESET}`,
          );
        }
        console.error(`  ${DIM}would pin: ${targets.map(shortPath).join(", ")}${RESET}`);
      }
      console.error(
        `\n  Verifying now pins ${offenders.length === 1 ? "that downstream" : "those downstreams"} against a ` +
          `source that is not yet correct.`,
      );
      console.error(`  Fix upstream first, or pass ${BOLD}--out-of-order${RESET}.`);
      console.error(`  ${DIM}\`propagate graph\` prints the whole worklist in dependency order.${RESET}`);
      process.exit(3);
    }
  }

  if (opts.disposition === "decoupled") {
    await runDecoupled(selected, workspaces, opts);
  } else {
    await runDispositionBatch(selected, workspaces, opts);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// bootstrap — plan Part 1 (~/.claude/plans/jolly-waddling-sphinx.md): turns
// the 623 NEVER_VERIFIED starting position into an honest baseline. Dry-run
// by default; --apply writes, same posture as verify --apply.
// ─────────────────────────────────────────────────────────────────────────────

function parseBootstrapArgs(args) {
  const policyFlags = BASELINE_POLICIES.filter((p) => args.includes(`--${p}`));
  const boundIdx = args.indexOf("--bound");
  const bound = boundIdx !== -1 ? parseInt(args[boundIdx + 1], 10) : undefined;
  return {
    policyFlags,
    apply: args.includes("--apply"),
    json: args.includes("--json"),
    bound: Number.isFinite(bound) ? bound : undefined,
  };
}

async function bootstrapCmd() {
  const args = process.argv.slice(3);
  const { policyFlags, apply, json, bound } = parseBootstrapArgs(args);

  if (policyFlags.length > 1) {
    console.error(
      `${RED}error:${RESET} choose exactly one of ${BASELINE_POLICIES.map((p) => `--${p}`).join(" | ")}`,
    );
    process.exit(2);
  }
  // No flag given -> the recommended policy (plan §5), previewed safely
  // because dry-run is this command's default posture regardless of which
  // policy is selected — nothing writes without --apply.
  const policy = policyFlags[0] || "baseline-from-git";
  const walkBound = bound ?? DEFAULT_WALK_COMMITS;

  // Bootstrap is a whole-tree operation (like `doctor`), not scoped to cwd's
  // workspace the way `status`/`drain`/`reconcile` default to — "turn 623
  // edges into an honest starting position" is a tree-wide claim.
  const workspaces = WORKSPACES;

  // 1. THE GIT STAGE — explicit and first (plan §"THE GIT STAGE, EXPLICIT AND FIRST").
  const stage = await gitStage(workspaces, { apply });

  // 2. Enumerate + reconcile. Everything with no prior event reads
  // NEVER_VERIFIED — that is TRUE (plan §5 step 4), the premise this
  // command classifies against.
  const { rows, stats } = await reconcile(workspaces);

  // 3. Baseline, explicitly (plan §5 step 5) — classify, never write yet.
  const { outcomes, neverVerifiedCount } = planBaseline(rows, policy, { bound: walkBound });

  // 4. Apply (or not), then verify-after-write. Reuses verify's own
  // verify-after-write pattern (computeVerifyAfterWrite/expectedStateAfter)
  // rather than re-implementing it: "baselined" pins like every
  // non-deferred disposition, so its expected post-write state is CLEAN,
  // the exact same rule verify already encodes.
  let applied = [];
  let failed = [];
  let confirmed = [];
  let verifyFailed = [];
  if (apply) {
    ({ applied, failed } = await applyBaseline(outcomes));
    if (applied.length > 0) {
      const { rows: afterRows } = await reconcile(workspaces);
      ({ confirmed, failed: verifyFailed } = computeVerifyAfterWrite(applied, afterRows));
    }
  }

  const pct = (n) => (neverVerifiedCount ? `${((n / neverVerifiedCount) * 100).toFixed(1)}%` : "n/a");
  const exitCode = failed.length > 0 || verifyFailed.length > 0 ? 1 : 0;

  if (json) {
    console.log(
      JSON.stringify({
        generatedAt: new Date().toISOString(),
        policy,
        apply,
        bound: walkBound,
        gitStage: stage,
        reconcileStats: stats,
        neverVerifiedCount,
        outcomeCounts: {
          baselined: outcomes.baselined.length,
          noCoCommit: outcomes.noCoCommit.length,
          boundReached: outcomes.boundReached.length,
          ineligibleCrossRepo: outcomes.ineligibleCrossRepo.length,
        },
        applied,
        failed,
        confirmed,
        verifyFailed,
        exitCode,
      }),
    );
    process.exit(exitCode);
  }

  console.log(
    `${BOLD}# bootstrap${RESET}  ${DIM}(${apply ? "APPLY — writing" : "dry run — pass --apply to write"})${RESET}\n`,
  );

  console.log(`${BOLD}## git stage${RESET}`);
  for (const s of stage) {
    if (!s.isRepoNow) {
      console.log(`  ${YELLOW}!${RESET} ${s.root}`);
      console.log(
        `    ${YELLOW}not a git repo — without it there are no refs and the ref lens does not apply${RESET}`,
      );
      console.log(`    ${DIM}offer: ${s.offeredInitCommand}${RESET}`);
      if (s.initError) console.log(`    ${RED}git init failed: ${s.initError}${RESET}`);
      continue;
    }
    const createdTag = s.created ? ` ${GREEN}(created by this run)${RESET}` : "";
    const errTag = s.refsError ? `  ${RED}git error: ${s.refsError}${RESET}` : "";
    console.log(
      `  ${GREEN}✓${RESET} ${s.root}${createdTag}  ${DIM}${s.branches} branch${s.branches === 1 ? "" : "es"}, ` +
        `${s.worktrees} worktree${s.worktrees === 1 ? "" : "s"}${RESET}${errTag}`,
    );
  }

  console.log(`\n${BOLD}## workspace scaffolding${RESET}`);
  for (const ws of workspaces) {
    const markerOk = existsSync(path.join(ws.root, ".propagates.yml"));
    const ledgerOk = existsSync(ws.ledgerJsonl);
    if (markerOk && ledgerOk) {
      console.log(`  ${GREEN}✓${RESET} ${ws.name}  ${DIM}marker + ledger present${RESET}`);
    } else {
      const missing = [!markerOk && "no .propagates.yml marker", !ledgerOk && "no ledger yet"]
        .filter(Boolean)
        .join(", ");
      console.log(
        `  ${YELLOW}!${RESET} ${ws.name}  ${DIM}${missing} — run: node cli.mjs init "${ws.root}"${RESET}`,
      );
    }
  }

  console.log(`\n${BOLD}## baseline (${policy})${RESET}  ${DIM}bound=${walkBound} commits${RESET}`);
  console.log(`  ${neverVerifiedCount} edge${neverVerifiedCount === 1 ? "" : "s"} NEVER_VERIFIED before this run\n`);
  console.log(
    `  ${YELLOW}${String(outcomes.baselined.length).padStart(4)}${RESET}  baselineable  ${DIM}${pct(outcomes.baselined.length)}${RESET}`,
  );
  console.log(
    `  ${YELLOW}${String(outcomes.noCoCommit.length).padStart(4)}${RESET}  no-co-commit  ${DIM}${pct(outcomes.noCoCommit.length)}${RESET}`,
  );
  console.log(
    `  ${YELLOW}${String(outcomes.boundReached.length).padStart(4)}${RESET}  bound-reached  ${DIM}${pct(outcomes.boundReached.length)}${RESET}`,
  );
  console.log(
    `  ${YELLOW}${String(outcomes.ineligibleCrossRepo.length).padStart(4)}${RESET}  ineligible-cross-repo  ${DIM}${pct(outcomes.ineligibleCrossRepo.length)}${RESET}`,
  );

  if (!apply) {
    console.log(
      `\n  ${DIM}dry run — pass --apply to write ${outcomes.baselined.length} "baselined" event${outcomes.baselined.length === 1 ? "" : "s"}${RESET}`,
    );
  } else {
    console.log(`\n${BOLD}## write${RESET}`);
    console.log(
      `  ${GREEN}${confirmed.length}${RESET} confirmed baselined (now CLEAN; disposition "baselined" — never "verified")`,
    );
    if (failed.length) {
      console.log(`  ${RED}${failed.length}${RESET} failed to write:`);
      for (const f of failed) console.log(`    ${RED}✗${RESET} ${f.edge_id}  ${f.error}`);
    }
    if (verifyFailed.length) {
      console.log(`  ${RED}${verifyFailed.length}${RESET} did not confirm after write:`);
      for (const f of verifyFailed) console.log(`    ${RED}✗${RESET} ${f.edge_id}  ${f.error}`);
    }
  }
  process.exit(exitCode);
}

/**
 * `inventory` — the self-adoption probe (task brief, docs/SYSTEMS.md): what
 * was built across skills/plugins/repos/standalone artifacts, classified into
 * SYSTEMS.md's existing status vocabulary, each with its evidence string.
 *
 * Read-only by construction (lib/inventory.mjs never writes/deletes/reaps).
 * `--emit-rows` prints paste-ready SYSTEMS.md rows to STDOUT — it does NOT
 * append to the file. SYSTEMS.md is append-only and a human decides what
 * lands there.
 */
async function inventoryCmd() {
  const { inventory, emitRows, STATUS } = await import("./lib/report/inventory.mjs");
  const inv = inventory();

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(inv, null, 2));
    return;
  }

  if (process.argv.includes("--emit-rows")) {
    for (const row of emitRows(inv)) console.log(row);
    return;
  }

  console.log(`${BOLD}inventory${RESET} ${DIM}${inv.generatedAt}${RESET}`);
  console.log(`  ${DIM}${inv.probeLimits.note}${RESET}`);
  console.log();

  const order = [
    STATUS.ACTIVE,
    STATUS.ACTIVE_UNADOPTED,
    STATUS.PROPOSED,
    STATUS.DORMANT,
    STATUS.RETIRED,
    STATUS.INSTALLED_NEVER_INVOKED,
    STATUS.UNKNOWN,
  ];
  console.log(`  ${BOLD}${inv.counts.total} items${RESET}`);
  for (const status of order) {
    if (!inv.counts[status]) continue;
    const color = status === STATUS.ACTIVE ? GREEN : status === STATUS.UNKNOWN ? RED : status === STATUS.DORMANT || status === STATUS.INSTALLED_NEVER_INVOKED ? YELLOW : DIM;
    console.log(`    ${String(inv.counts[status]).padStart(4)}  ${color}${status}${RESET}`);
  }

  for (const [name, items] of Object.entries(inv.categories)) {
    console.log();
    console.log(`  ${BOLD}${name}${RESET} ${DIM}(${items.length})${RESET}`);
    const byStatus = {};
    for (const item of items) byStatus[item.status] = (byStatus[item.status] ?? 0) + 1;
    for (const [status, count] of Object.entries(byStatus).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(count).padStart(4)}  ${status}`);
    }
  }

  if (inv.dropped.length) {
    console.log();
    console.log(`  ${YELLOW}${inv.dropped.length} path(s) dropped from the repo walk${RESET} ${DIM}(bounded — see --json for the list)${RESET}`);
  }
  if (inv.budgetExceeded) {
    console.log(`  ${YELLOW}repo walk time budget exceeded — results are partial${RESET}`);
  }
}

/**
 * `skills` — inventory of ~/.claude/skills with provenance and liveness.
 *
 * Read-only by construction. It reads ~/.claude.json for the harness-maintained
 * skillUsage counter and never writes there; corrupting that file breaks Claude
 * Code globally.
 *
 * Reports rather than repairs. In particular the frontmatter/directory name
 * mismatches are left alone: Claude Code resolves a skill by its DIRECTORY
 * name, so the mismatch is cosmetic, and "fixing" it would rewrite files inside
 * a git checkout that tracks upstream.
 */
async function skills() {
  const { scanSkills, summarize, probeTranscripts, INSTALLER } = await import("./lib/skills/skills-scan.mjs");
  const tx = probeTranscripts();
  const scan = scanSkills({ transcripts: tx.byName });
  const sum = summarize(scan);

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), summary: sum, ...scan }, null, 2));
    return;
  }

  if (scan.error) {
    console.log(`${RED}cannot read ${scan.skillsDir}: ${scan.error}${RESET}`);
    process.exit(1);
  }

  console.log(`${BOLD}skills${RESET} ${DIM}${scan.skillsDir}${RESET}`);
  console.log(`  ${sum.total} skills`);
  for (const [k, v] of Object.entries(sum.byInstaller).sort((a, b) => b[1] - a[1])) {
    const prov = k === INSTALLER.NPX_SKILLS ? "provenance recorded" : k === INSTALLER.GSTACK ? "provenance implicit (checkout)" : "no provenance";
    console.log(`    ${String(v).padStart(3)}  ${k.padEnd(14)} ${DIM}${prov}${RESET}`);
  }

  const pct = sum.total ? Math.round((sum.neverInvoked / sum.total) * 100) : 0;
  console.log();
  console.log(`  ${YELLOW}${sum.neverInvoked}${RESET} never invoked ${DIM}(${pct}% — zero in skillUsage AND zero in transcripts)${RESET}`);
  if (!tx.scanned) console.log(`  ${YELLOW}transcript probe unavailable${RESET} ${DIM}— never-invoked rests on skillUsage alone${RESET}`);
  if (sum.transcriptOnly) {
    console.log(`  ${RED}${sum.transcriptOnly}${RESET} in transcripts but absent from skillUsage ${DIM}— undermines skillUsage as primary${RESET}`);
  }
  if (sum.dangling) console.log(`  ${RED}${sum.dangling}${RESET} dangling SKILL.md symlink(s)`);
  if (sum.orphanUsageKeys) {
    console.log(`  ${DIM}${sum.orphanUsageKeys} usage keys with no directory (counter is never pruned on delete)${RESET}`);
  }
  if (sum.nameMismatches) {
    console.log(`  ${DIM}${sum.nameMismatches} frontmatter/dir name mismatches — cosmetic, resolution is by directory${RESET}`);
  }

  const top = scan.skills.filter((s) => s.usageCount > 0).sort((a, b) => b.usageCount - a.usageCount);
  if (top.length) {
    console.log();
    console.log(`  ${BOLD}most used${RESET}`);
    for (const s of top.slice(0, 10)) {
      const when = s.lastUsedAt ? new Date(s.lastUsedAt).toISOString().slice(0, 10) : "—";
      console.log(`    ${String(s.usageCount).padStart(4)}  ${s.id.padEnd(30)} ${DIM}${when}${RESET}`);
    }
  }

  if (scan.skills.some((s) => s.dangling)) {
    console.log();
    console.log(`  ${BOLD}dangling${RESET}`);
    for (const s of scan.skills.filter((x) => x.dangling)) console.log(`    ${RED}${s.id}${RESET}`);
  }

  await lifecycleReport(tx);
}

/**
 * The quarantine/promoted tiers of the Tathya marketplace, appended to
 * `skills` output. Separate from the ~/.claude/skills inventory above because
 * they are different populations: that one is what is installed, this one is
 * what the registry is shepherding through a lifecycle.
 */
async function lifecycleReport(tx) {
  const lc = await import("./lib/skills/skills-lifecycle.mjs");
  const { quarantined, promoted } = lc.scanLifecycle({ transcripts: tx.byName });
  if (!quarantined.length && !promoted.length) return;

  const ready = lc.promotable(quarantined);
  const doomed = lc.reapable(quarantined);
  const readyIds = new Set(ready.map((s) => s.id));
  const doomedIds = new Set(doomed.map((s) => s.id));

  console.log();
  console.log(`  ${BOLD}lifecycle${RESET} ${DIM}${lc.MARKETPLACE_DIR}${RESET}`);
  if (lc.isDisarmed()) console.log(`  ${YELLOW}DISARMED${RESET} ${DIM}(${lc.DISARM_FILE} exists — no promote/demote/reap)${RESET}`);

  for (const s of quarantined) {
    const uses = Math.max(s.usageCount, s.transcriptCount);
    const mark = readyIds.has(s.id) ? `${GREEN}ready to promote${RESET}` : doomedIds.has(s.id) ? `${RED}reapable${RESET}` : DIM + `${lc.PROMOTE_MIN_USES - uses} more use(s), reaped in ${Math.max(0, lc.REAP_AFTER_DAYS - s.ageDays)}d` + RESET;
    console.log(`    quarantine  ${s.name.padEnd(26)} uses=${uses} age=${s.ageDays}d  ${mark}`);
  }
  for (const s of promoted) {
    console.log(`    ${GREEN}promoted${RESET}    ${s.name.padEnd(26)} uses=${Math.max(s.usageCount, s.transcriptCount)}`);
  }
}

/** `skills-create <name> <intent...>` — draft, audit, land in quarantine. */
async function skillsCreateCmd() {
  const name = process.argv[3];
  const intent = process.argv.slice(4).join(" ").trim();
  if (!name || !intent) {
    console.error('usage: node cli.mjs skills-create <kebab-name> <what it should do>');
    process.exit(2);
  }
  const sc = await import("./lib/skills/skills-create.mjs");
  const gate = await sc.creationAllowed({ name });
  if (!gate.ok) {
    console.log(`${RED}✗${RESET} refused: ${gate.reason}`);
    process.exit(1);
  }
  console.log(`${DIM}drafting via skill-creator (this spawns claude -p and takes a while)…${RESET}`);
  const res = await sc.createSkill(name, intent);
  if (!res.ok) {
    console.log(`${RED}✗${RESET} ${res.reason}`);
    process.exit(1);
  }
  const a = res.audit;
  const auditLine = !a.ran ? `${YELLOW}audit skipped${RESET} ${DIM}(${a.reason})${RESET}`
    : a.passed ? `${GREEN}audit passed${RESET}` : `${YELLOW}audit failed${RESET} ${DIM}(kept in quarantine — fix or let it be reaped)${RESET}`;
  console.log(`${GREEN}✓${RESET} created ${res.id}  ${auditLine}`);
  console.log(`  ${DIM}${res.dir}${RESET}`);
  console.log(`  ${DIM}invoke it as ${res.id}; it needs ${sc.MAX_QUARANTINED > 0 ? "3" : "3"} uses to be promotable${RESET}`);
}

/** `skills-promote <name>` / `skills-demote <name>` / `skills-reap [--apply]` */
async function skillsLifecycleCmd(mode) {
  const lc = await import("./lib/skills/skills-lifecycle.mjs");
  const name = process.argv[3];

  if (mode === "skills-promote" || mode === "skills-demote") {
    if (!name) {
      console.error(`usage: node cli.mjs ${mode} <skill-name>`);
      process.exit(2);
    }
    const res = mode === "skills-promote" ? await lc.promote(name) : await lc.demote(name);
    if (!res.ok) {
      console.log(`${RED}✗${RESET} ${name}: ${res.reason}`);
      process.exit(1);
    }
    console.log(`${GREEN}✓${RESET} ${res.from} → ${res.to}`);
    return;
  }

  // reap
  const apply = process.argv.includes("--apply");
  const { probeTranscripts } = await import("./lib/skills/skills-scan.mjs");
  const { quarantined } = lc.scanLifecycle({ transcripts: probeTranscripts().byName });
  const candidates = lc.reapable(quarantined);

  if (!candidates.length) {
    console.log(`${DIM}nothing reapable — quarantine has no skill that is both unused and older than ${lc.REAP_AFTER_DAYS}d${RESET}`);
    return;
  }
  const res = await lc.reap(candidates, { apply });
  if (!res.applied) {
    const why = res.reason === "disarmed" ? ` ${YELLOW}(DISARMED)${RESET}` : ` ${DIM}(dry run — pass --apply)${RESET}`;
    console.log(`would reap ${res.planned.length}:${why}`);
    for (const p of res.planned) console.log(`  ${p.id} ${DIM}age ${p.ageDays}d${RESET}`);
    return;
  }
  for (const d of res.done) {
    if (d.removed) console.log(`${GREEN}✓${RESET} reaped ${d.id} ${DIM}→ ${d.archive}${RESET}`);
    else console.log(`${RED}✗${RESET} kept ${d.id}: ${d.reason}`);
  }
}

/**
 * `backlog` — read-only aggregate view (task brief Component 2) over every
 * STATE.md live section, TODOS.md, and docs/ISSUES.md discoverable under
 * SEARCH_ROOTS. No migration, no edits — lib/backlog.mjs never writes
 * anything.
 *
 * The load-bearing property this command must never violate: a file whose
 * format it cannot recognise is reported as UNPARSED, never silently
 * counted as zero open items (G2). `--json` emits the full structured
 * result; the default view prints per-file parsed/unparsed lines plus a
 * ranked, deduped item list.
 */


/**
 * `journal --since <iso> [--until <iso>]` — what was done, and when.
 *
 * Explicit datetimes are required, not a convenience: a bare `--until=2026-08-15` goes
 * through git's approxidate parser and admitted commits stamped 2026-08-15, which is one
 * of the two bugs that moved this figure three times before it settled.
 */
async function journalCmd() {
  const { journal } = await import("./lib/edges/journal.mjs");
  const os = await import("node:os");
  const arg = (f) => {
    const i = process.argv.indexOf(f);
    return i !== -1 ? process.argv[i + 1] : null;
  };
  const since = arg("--since");
  if (!since) {
    console.error("usage: node cli.mjs journal --since <ISO datetime> [--until <ISO datetime>] [--json]");
    console.error('example: --since 2026-08-14T00:00:00+05:30 --until 2026-08-15T00:00:00+05:30');
    process.exit(2);
  }
  const until = arg("--until") ?? new Date().toISOString();
  let out;
  try {
    out = journal(SEARCH_ROOTS, since, until);
  } catch (err) {
    console.error(String(err.message));
    process.exit(2);
  }
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  console.log(
    `${BOLD}# Journal ${since} → ${until}${RESET}\n  ${YELLOW}${out.commits}${RESET} commit(s) across ${YELLOW}${out.reposWithActivity}${RESET} repo(s)  ${DIM}(${out.reposScanned} scanned)${RESET}\n`,
  );
  for (const r of out.byRepo) {
    const link = r.viaSymlink ? ` ${DIM}[via symlink]${RESET}` : "";
    // Authors are printed always, not only when there are several: a journal that reads
    // as one person's day is wrong about who did what.
    console.log(`  ${BOLD}${r.repo.replace(os.homedir(), "~")}${RESET}  ${r.count}${link}  ${DIM}${r.authors.join(", ")}${RESET}`);
    for (const c of r.commits.slice(0, 4)) console.log(`      ${DIM}${c.hash}${RESET} ${c.subject.slice(0, 76)}`);
    if (r.commits.length > 4) console.log(`      ${DIM}… ${r.commits.length - 4} more${RESET}`);
  }
  if (out.symlinkedRepos.length) {
    console.log(`\n  ${DIM}${out.symlinkedRepos.length} repo(s) reached only through a symlink — invisible to \`find\` and to readdirSync().isDirectory()${RESET}`);
  }
}

async function backlogCmd() {
  const { backlog } = await import("./lib/report/backlog.mjs");
  const result = backlog();

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`${BOLD}backlog${RESET} ${DIM}${result.generatedAt}${RESET}`);
  console.log(
    `  ${result.totals.stateFilesRead} STATE.md, ${result.totals.todoFilesRead} TODOS.md, ${result.totals.issueFilesRead} ISSUES.md discovered`,
  );
  console.log();

  const genericFiles = [...result.todoFiles, ...result.issueFiles];
  for (const f of genericFiles) {
    if (f.stub) {
      console.log(`  ${DIM}stub${RESET}      ${f.file} ${DIM}(${f.stubReason})${RESET}`);
    } else if (f.unparsed) {
      console.log(`  ${RED}unparsed${RESET}  ${f.file} ${DIM}— ${f.unparsed}${RESET}`);
    } else {
      console.log(`  ${GREEN}parsed${RESET}    ${f.file} ${DIM}(${f.format}, ${f.parsed} total, ${f.open} open)${RESET}`);
    }
  }
  for (const f of result.stateFiles) {
    const tag = f.error ? `${RED}unparsed${RESET}  ${f.file} ${DIM}— unreadable: ${f.error}${RESET}` : `${GREEN}parsed${RESET}    ${f.file} ${DIM}(state-live-sections, ${f.items.length} open)${RESET}`;
    console.log(`  ${tag}`);
  }
  console.log();

  console.log(
    `  ${BOLD}totals${RESET}: ${result.totals.parsedFiles} parsed / ${result.totals.unparsedFiles} unparsed / ${result.totals.stubFiles} stub files, ${result.totals.parsedItems} open items parsed, ${result.mergedCount} duplicate(s) merged`,
  );
  if (result.totals.unparsedFiles > 0) {
    console.log(`  ${YELLOW}unparsed files never counted as zero — see file list above${RESET}`);
  }
  if (result.dropped.length) {
    console.log(`  ${YELLOW}${result.dropped.length} path(s) dropped from the discovery walk${RESET} ${DIM}(bounded — see --json)${RESET}`);
  }
  if (result.budgetExceeded) {
    console.log(`  ${YELLOW}discovery walk time budget exceeded — results are partial${RESET}`);
  }

  // HANDOVERS. Parsed since 2026-08-22 and rendered nowhere until 2026-08-25 --
  // available in --json, invisible to anyone reading the command. A source that
  // is collected and never shown delivers exactly what one that was never built
  // delivers (rule:enforcement-watches-itself).
  //
  // `unknown` is the honest majority and must be printed as such, not hidden or
  // rounded to open/closed. Measured 2026-08-25: all 4 handover files carry ZERO
  // `**Done when:**` / `**Resolved:**` markers, so all 37 sections are unknown.
  // That IS the finding -- nobody has scoped them -- and it is only actionable
  // if a human can see it.
  const hoFiles = result.handovers?.files ?? [];
  if (hoFiles.length) {
    const secs = hoFiles.flatMap((f) => f.sections ?? []);
    const tally = { open: 0, closed: 0, unknown: 0 };
    for (const sec of secs) tally[sec.status] = (tally[sec.status] ?? 0) + 1;
    console.log();
    console.log(
      `  ${BOLD}handovers${RESET} ${DIM}${hoFiles.length} file(s), ${secs.length} section(s) — ` +
        `${tally.open} open / ${tally.closed} closed / ${tally.unknown} unscoped${RESET}`,
    );
    for (const f of hoFiles) {
      if (f.error) {
        console.log(`    ${RED}unreadable${RESET} ${f.file} ${DIM}— ${f.error}${RESET}`);
        continue;
      }
      const n = (f.sections ?? []).length;
      const unscoped = (f.sections ?? []).filter((x) => x.status === "unknown").length;
      console.log(`    ${f.file} ${DIM}(${n} section(s), ${unscoped} unscoped)${RESET}`);
    }
    for (const sec of secs.filter((x) => x.status === "open")) {
      console.log(`    ${YELLOW}open${RESET}  ${sec.date} · ${sec.title} ${DIM}— done when: ${sec.doneWhen}${RESET}`);
    }
    if (tally.unknown === secs.length && secs.length > 0) {
      console.log(
        `    ${YELLOW}no handover section carries a **Done when:** or **Resolved:** line${RESET} ` +
          `${DIM}— none can be closed, or reported as still open${RESET}`,
      );
    }
  }

  console.log();
  console.log(`  ${BOLD}ranked (${result.ranked.length})${RESET}`);
  for (const item of result.ranked) {
    const pri = item.priority !== null && item.priority !== undefined ? `P${item.priority} ` : "";
    const loc = item.sources.length > 1 ? item.sources.map((s) => `${s.file}:${s.line}`).join(", ") : `${item.file}:${item.line}`;
    console.log(`    ${pri}${item.text}  ${DIM}${loc}${RESET}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// monitor — proactive notification, without the baseline that damned v1.
//
// The v1 watcher diffed against a remembered mtime baseline: it had to CATCH
// the change, and a corrupt baseline invented drift (~120 spurious rows from one
// state wipe). This detects nothing — it runs the same stateless `reconcile` the
// rest of the CLI uses, so a missed or coalesced trigger costs nothing and no run
// can invent anything.
//
// It writes NO drift. Not to a ledger, not to the event store. The only mutable
// thing is a record of what it has already told you, keyed on the content triple
// — see lib/monitor.mjs for why that key and not mtimes.
// ─────────────────────────────────────────────────────────────────────────────

async function monitorCmd() {
  const args = process.argv.slice(3);
  const dryRun = args.includes("--dry-run");
  const json = args.includes("--json");
  const started = Date.now();

  const mon = await import("./lib/report/monitor.mjs");
  const { notify } = await import("./lib/report/notify.mjs");

  // --install generates the plist FILE and stops. Loading it is a separate,
  // deliberate step — touching launchd is a one-way door and stays the human's,
  // per SKILL.md's contract.
  if (args.includes("--install")) {
    const { writeMonitorPlist, MONITOR_LABEL } = await import("./lib/core/plist.mjs");
    const res = await writeMonitorPlist({ workspaces: WORKSPACES });
    if (!res.ok) {
      console.error(`${RED}refused:${RESET} ${res.error}`);
      process.exit(2);
    }
    console.log(`${GREEN}wrote${RESET} ${res.path}`);
    console.log(`  ${DIM}${res.watchPaths.length} watch path(s)${RESET}`);
    console.log(`\n  ${BOLD}Not loaded.${RESET} ${DIM}To arm it:${RESET}`);
    console.log(`    launchctl bootstrap gui/$(id -u) ${JSON.stringify(res.path)}`);
    console.log(`  ${DIM}To disarm:${RESET}`);
    console.log(`    launchctl bootout gui/$(id -u)/${MONITOR_LABEL}`);
    return;
  }

  let rows = [];
  let err = null;
  try {
    ({ rows } = await reconcile(WORKSPACES));
  } catch (e) {
    err = String(e && e.message);
  }

  // A reconcile failure is logged as a run that could not answer — never as a
  // quiet run. "Found nothing" and "could not look" must not share an output
  // (rule:discernment-checks §2).
  if (err) {
    await mon.logRun({ rows: 0, actionable: 0, notified: 0, suppressed: 0, ms: Date.now() - started, error: err });
    console.error(`${RED}monitor: reconcile failed:${RESET} ${err}`);
    process.exit(1);
  }

  const already = await mon.readNotified();
  const { toNotify, suppressed, actionable } = mon.selectToNotify(rows, already);
  const { title, body } = mon.formatNotification(toNotify, { root: SEARCH_ROOTS[0] });

  // Backlog DEFECTS — registers nothing can parse, handovers nothing can close.
  // Never the open items: there are 500 and they are the normal state of a
  // working tree, so notifying on them would mute this channel permanently.
  // The definition is `backlogDefects()` in lib/report/backlog.mjs, the same one
  // doctor reads, so the two can never disagree about what counts as a problem.
  //
  // A reconcile failure above already exited; a backlog failure must not take
  // the monitor down with it, because edge notification is the older and more
  // load-bearing half of this command. It degrades to zero defects and SAYS SO
  // rather than reporting a clean backlog it never managed to read.
  let defects = [];
  let backlogErr = null;
  try {
    const bl = await import("./lib/report/backlog.mjs");
    defects = bl.backlogDefects(bl.backlog());
  } catch (e) {
    backlogErr = String(e && e.message);
  }
  const defectPick = mon.selectDefectsToNotify(defects, already);

  if (!dryRun && toNotify.length > 0) {
    await notify(title, body, { group: "propagate-monitor" });
    await mon.recordNotified(toNotify);
  }
  if (!dryRun && defectPick.toNotify.length > 0) {
    const d = mon.formatDefectNotification(defectPick.toNotify, { root: SEARCH_ROOTS[0] });
    await notify(d.title, d.body, { group: "propagate-monitor" });
    await mon.recordNotified(defectPick.toNotify);
  }
  if (backlogErr) console.error(`${YELLOW}monitor: backlog check could not run:${RESET} ${backlogErr}`);

  const stats = {
    rows: rows.length,
    actionable: actionable.length,
    notified: dryRun ? 0 : toNotify.length,
    suppressed: suppressed.length,
    backlogDefects: defects.length,
    backlogNotified: dryRun ? 0 : defectPick.toNotify.length,
    backlogError: backlogErr,
    ms: Date.now() - started,
  };
  if (!dryRun) await mon.logRun(stats);

  if (json) {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), dryRun, ...stats, would: toNotify.map((r) => ({ edge_id: r.edge_id, state: r.state, source: r.source.path, downstream: r.downstream.path })) }, null, 2));
    return;
  }

  if (toNotify.length === 0) {
    console.log(
      `${GREEN}nothing new${RESET} ${DIM}— ${actionable.length} actionable, all already notified (${stats.ms}ms)${RESET}`,
    );
    return;
  }
  console.log(`${BOLD}${dryRun ? "would notify" : "notified"}: ${title}${RESET}`);
  for (const line of body.split("\n")) console.log(`  ${line}`);
  if (suppressed.length) {
    console.log(`  ${DIM}(${suppressed.length} already notified, unchanged since)${RESET}`);
  }
  if (dryRun) console.log(`\n  ${DIM}--dry-run: nothing sent, nothing recorded${RESET}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// graph — the DAG over the declared couplings (plan: okay-pln-these-out-zany-rain).
//
// READ-ONLY, like `reconcile`, and built entirely on top of it: `reconcile()`
// already answers "what state is each edge in", and lib/graph.mjs answers "how
// are those edges connected, and in what order must they be worked".
//
// The text output leads with the same fix order the HTML page leads with, on
// purpose — a terminal and a page that disagree about the worklist is worse
// than having only one of them.
// ─────────────────────────────────────────────────────────────────────────────

/** Shared by graphCmd and the verify ordering guard, so both see one graph. */
async function loadGraph(workspaces) {
  const { buildGraph } = await import("./lib/graph/graph.mjs");
  const { rows, stats } = await reconcile(workspaces);
  return { graph: buildGraph(rows, { workspaceRoots: workspaces.map((w) => w.root) }), rows, stats };
}



async function graphCmd() {
  const args = process.argv.slice(3);
  const json = args.includes("--json");
  const showAll = args.includes("--all");
  const includeUnverified = args.includes("--include-unverified");
  const htmlIdx = args.indexOf("--html");
  const htmlPath = htmlIdx !== -1 ? args[htmlIdx + 1] : null;
  const nodeIdx = args.indexOf("--node");
  const nodeSel = nodeIdx !== -1 ? args[nodeIdx + 1] : null;

  if (htmlIdx !== -1 && (!htmlPath || htmlPath.startsWith("--"))) {
    console.error(`${RED}error:${RESET} --html requires a destination path`);
    process.exit(2);
  }

  const cur = currentWorkspace();
  const workspaces = showAll || !cur ? WORKSPACES : [cur];

  const { graph } = await loadGraph(workspaces);
  const { fixOrder, neighbourhood } = await import("./lib/graph/graph.mjs");
  const order = fixOrder(graph, { includeUnverified });

  // ── --node: ancestors and descendants of one file ────────────────────────
  if (nodeSel) {
    const match = [...graph.nodes.keys()].filter(
      (p) => p === nodeSel || p.endsWith("/" + nodeSel) || shortPath(p) === nodeSel,
    );
    if (match.length === 0) {
      console.error(`${RED}error:${RESET} no node matched ${JSON.stringify(nodeSel)}`);
      process.exit(1);
    }
    if (match.length > 1) {
      console.error(`${RED}error:${RESET} ${match.length} nodes matched ${JSON.stringify(nodeSel)} — be more specific:`);
      for (const m of match.slice(0, 10)) console.error(`  ${shortPath(m)}`);
      process.exit(2);
    }
    const target = match[0];
    const n = neighbourhood(graph, target);
    if (json) {
      console.log(JSON.stringify({ node: target, ...graph.nodes.get(target), ...n }, null, 2));
      return;
    }
    const meta = graph.nodes.get(target);
    console.log(`${BOLD}${shortPath(target)}${RESET}`);
    console.log(
      `  ${DIM}workspace ${meta.workspace} · layer ${meta.layer} · in ${meta.inDeg} · out ${meta.outDeg}${RESET}`,
    );
    console.log(`\n  ${BOLD}upstream (${n.ancestors.length})${RESET} ${DIM}— changing any of these can reach this file${RESET}`);
    for (const a of n.ancestors.sort()) console.log(`    ${shortPath(a)}`);
    if (!n.ancestors.length) console.log(`    ${DIM}none — this is a root${RESET}`);
    console.log(`\n  ${BOLD}downstream (${n.descendants.length})${RESET} ${DIM}— changing this file can reach these${RESET}`);
    for (const d of n.descendants.sort()) console.log(`    ${shortPath(d)}`);
    if (!n.descendants.length) console.log(`    ${DIM}none — this is a leaf${RESET}`);
    return;
  }

  // ── --html ───────────────────────────────────────────────────────────────
  if (htmlPath) {
    const { renderGraphHtml } = await import("./lib/graph/graph-html.mjs");
    const { writeFile } = await import("node:fs/promises");
    const html = renderGraphHtml(graph, order, { root: SEARCH_ROOTS[0] });
    await writeFile(htmlPath, html, "utf8");
    const kb = (Buffer.byteLength(html, "utf8") / 1024).toFixed(0);
    console.log(`${GREEN}wrote${RESET} ${htmlPath} ${DIM}(${kb} KB, self-contained)${RESET}`);
    console.log(
      `  ${DIM}${graph.stats.nodes} nodes · ${graph.stats.edges} edges · ${order.items.length} on the worklist${RESET}`,
    );
    return;
  }

  // ── --json ───────────────────────────────────────────────────────────────
  if (json) {
    console.log(
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          stats: graph.stats,
          roots: graph.roots,
          leaves: graph.leaves,
          interior: graph.interior,
          sccs: graph.sccs,
          duplicatePairs: graph.duplicatePairs,
          unmatched: graph.unmatched,
          layers: Object.fromEntries(graph.layers),
          topoOrder: graph.topoOrder,
          fixOrder: order.items,
          excludedUnverified: order.excludedUnverified,
        },
        null,
        2,
      ),
    );
    return;
  }

  // ── text ─────────────────────────────────────────────────────────────────
  const s = graph.stats;
  console.log(`${BOLD}# graph${RESET}  ${DIM}(read-only derivation over reconcile)${RESET}\n`);
  console.log(
    `  ${s.nodes} nodes · ${s.edges} edges · ${s.roots} roots · ${s.leaves} leaves · ` +
      `${s.interior} interior · depth ${s.maxDepth}`,
  );

  // Structural defects, each named rather than counted — a bare "1 cycle" is
  // not actionable (GOTCHAS: absence and presence must both be attributable).
  if (s.cycles) {
    console.log(`\n  ${RED}${s.cycles} cycle(s)${RESET} ${DIM}— no canonical direction, so no fix order exists${RESET}`);
    for (const c of graph.sccs) for (const m of c) console.log(`    ${shortPath(m)}`);
  }
  if (s.duplicatePairs) {
    console.log(`\n  ${RED}${s.duplicatePairs} duplicate declaration(s)${RESET} ${DIM}— same pair, two edge ids${RESET}`);
    for (const d of graph.duplicatePairs) {
      console.log(`    ${shortPath(d.from)} -> ${shortPath(d.to)}`);
      for (const e of d.edges) console.log(`      ${DIM}${e.edge_id} — ${e.why || "(no why)"}${RESET}`);
    }
  }
  if (graph.unmatched.length) {
    console.log(`\n  ${YELLOW}${graph.unmatched.length} declaration(s) with no downstream${RESET}`);
    for (const u of graph.unmatched) {
      console.log(
        `    ${shortPath(u.from)} ${u.selfEdge ? "(declared on itself)" : `-> ${u.glob} ${DIM}(matches 0 files)${RESET}`}`,
      );
    }
  }

  console.log(`\n  ${BOLD}fix order${RESET} ${DIM}— root to leaf; working top-down never pins against an unsettled source${RESET}`);
  if (!order.items.length) {
    console.log(`    ${GREEN}nothing actionable${RESET}`);
  }
  for (const [i, it] of order.items.entries()) {
    const target = it.to ? shortPath(it.to) : `(glob ${it.glob})`;
    const blocked = it.blockedBy.length
      ? `  ${RED}BLOCKED by ${it.blockedBy.length}${RESET}`
      : "";
    console.log(
      `    ${String(i + 1).padStart(2)}. ${DIM}L${it.layer}${RESET} ${it.state.padEnd(10)} ` +
        `${shortPath(it.from)} -> ${target}${blocked}`,
    );
    for (const b of it.blockedBy) {
      console.log(`        ${DIM}^ ${shortPath(b.from)} -> ${shortPath(b.to)} is ${b.state}${RESET}`);
    }
  }
  if (order.excludedUnverified) {
    console.log(
      `\n  ${DIM}${order.excludedUnverified} NEVER_VERIFIED edge(s) excluded from the worklist ` +
        `(--include-unverified to show). They still count as unsettled when deciding what blocks what.${RESET}`,
    );
  }
}

// Only dispatch when executed directly (node cli.mjs ...), NOT when a test imports
// checkCrossRepo from this module.
//
// Both sides must be realpath-resolved before comparing. `import.meta.url` is
// already realpathed by the ESM loader, but `process.argv[1]` is the literal
// string the caller typed -- so invoking through a symlink (e.g. a hub-visible
// `GitHub/propagate-skill` pointing here) made the two differ, the guard go
// false, and the CLI exit 0 having done nothing. A silent success is the exact
// "reports itself healthy while doing nothing" failure this skill exists to catch.
//
// `pathToFileURL` rather than a `file://` template literal: the latter does not
// percent-encode, so any path containing a space (`Vipin Kaushik/...`) never
// matched either.
const _invokedDirectly = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false; // argv[1] not a resolvable path (bundled/eval) -- do not dispatch
  }
})();
/**
 * graph-index — build the queryable graph projection over the state ledger.
 *
 * Derived and disposable (lib/graph-index.mjs). Writes to $STATE_DIR, not the
 * plugin dir: a marketplace update destroys that (N13/N14), and this is
 * regenerable anyway. Exits 1 if the projection disagrees with the live
 * derivation — that is a finding about the extractor, never something to tune.
 */
async function graphIndexCmd() {
  const args = process.argv.slice(3);
  const emit = args.includes("--emit") ? args[args.indexOf("--emit") + 1] : "sqlite";
  const outFlag = args.includes("--out") ? args[args.indexOf("--out") + 1] : null;
  const asJson = args.includes("--json");
  // Same root lib/events.mjs uses; deliberately not the plugin dir (N13/N14).
  const root = process.env.PROPAGATE_STATE_DIR || path.join(process.env.HOME || ".", ".propagate");

  const gi = await import("./lib/graph/graph-index.mjs");
  const t0 = Date.now();
  const model = await gi.buildModel(WORKSPACES, {});
  const ms = Date.now() - t0;
  const s = model.stats;

  if (emit === "cypher") {
    const out = outFlag || path.join(root, "graph-index.cypher");
    await writeFile(out, gi.emitCypher(model), "utf8");
    if (asJson) console.log(JSON.stringify({ emit, out, ms, stats: s }, null, 2));
    else console.log(`graph-index  cypher -> ${out} (${ms}ms)`);
    return;
  }
  if (emit !== "sqlite") {
    console.error(`unknown --emit: ${emit} (expected sqlite|cypher)`);
    process.exitCode = 2;
    return;
  }
  const out = outFlag || path.join(root, "graph-index.db");
  gi.emitSqlite(model, out);
  if (asJson) {
    console.log(JSON.stringify({ emit, out, ms, stats: s }, null, 2));
  } else {
    console.log(`graph-index -> ${out} (${ms}ms)\n`);
    console.log(`  ${s.nodes} nodes (${s.files} file, ${s.projects} project, ${s.decisions} decision)`);
    console.log(`  ${s.edges} edges (${s.declares} DECLARES, ${s.affects} AFFECTS, ${s.inProject} IN, ${s.blocks} BLOCKS)`);
    console.log(`  ${s.events} events (${s.eventsMalformed} malformed)`);
    if (s.unresolvedAffects > 0) {
      console.log(
        `\n  ${s.unresolvedAffects} of ${s.affects} AFFECTS tokens resolve to no project.` +
          ` The \`Affects:\` vocabulary is uncontrolled — see v_coverage_gap.`,
      );
    }
    console.log(`\n  views: v_blast_radius, v_archaeology, v_edge_history, v_coverage_gap`);
  }
  if (s.declares !== s.graphEdges || s.files !== s.graphNodes) {
    console.error(
      `graph-index: DISAGREES with the live derivation — ` +
        `projection ${s.files}/${s.declares} vs graph ${s.graphNodes}/${s.graphEdges}`,
    );
    process.exitCode = 1;
  }
}

if (_invokedDirectly) {
  const mode = process.argv[2] || "status";

  // ONE line, at most, on the two commands a person actually types. Wired here rather
  // than inside each command so there is exactly one call site to reason about — and
  // wired at all because the check previously existed and was invoked by nothing, which
  // is GOTCHAS G48 (an enforcement point that watches nothing). Never throws, never
  // blocks: `updateNotice` swallows every failure by construction.
  if (mode === "status" || mode === "doctor") {
    const notice = formatUpdateNotice(updateNotice(), { dim: DIM, reset: RESET });
    if (notice) console.log(notice);
  }

  if (mode === "status") {
    const { status } = await import("./commands/status.mjs");
    await status();
  } else if (mode === "doctor") {
    await doctor();
  } else if (mode === "rules") {
    await rulesCmd();
  } else if (mode === "setup") {
    // Dynamic, like doctor's sections (D5): a static import would pull the
    // commands layer into every `propagate status` / `check` invocation.
    const { setupCmd } = await import("./commands/setup.mjs");
    await setupCmd(process.argv.slice(3));
  } else if (mode === "release") {
    await releaseCmd(process.argv.slice(3));
  } else if (mode === "migrate-ledger") {
    await migrateLedgerCmd(process.argv.slice(3));
  } else if (mode === "relocate-ledger") {
    await relocateLedgerCmd(process.argv.slice(3));
  } else if (mode === "freeze-ledger") {
    await freezeLedgerCmd(process.argv.slice(3));
  } else if (mode === "migrate") {
    await migrateCmd(process.argv.slice(3));
  } else if (mode === "migrate-refs") {
    await migrateRefsCmd(process.argv.slice(3));
  } else if (mode === "init") {
    await init(process.argv[3], process.argv.slice(4));
  } else if (mode === "reload") {
    await reload();
  } else if (mode === "check") {
    await check();
  } else if (mode === "drain") {
    await drain();
  } else if (mode === "reconcile") {
    await reconcileCmd();
  } else if (mode === "why") {
    await whyCmd();
  } else if (mode === "verify") {
    await verifyCmd();
  } else if (mode === "bootstrap") {
    await bootstrapCmd();
  } else if (mode === "inventory") {
    await inventoryCmd();
  } else if (mode === "skills") {
    await skills();
  } else if (mode === "skills-create") {
    await skillsCreateCmd();
  } else if (mode === "skills-promote" || mode === "skills-demote" || mode === "skills-reap") {
    await skillsLifecycleCmd(mode);
  } else if (mode === "journal") {
    await journalCmd();
  } else if (mode === "manifest") {
    const { manifestCmd } = await import("./commands/manifest.mjs");
    await manifestCmd();
  } else if (mode === "docs") {
    const { docsCmd } = await import("./commands/docs.mjs");
    await docsCmd();
  } else if (mode === "backlog") {
    await backlogCmd();
  } else if (mode === "graph") {
    await graphCmd();
  } else if (mode === "graph-index") {
    await graphIndexCmd();
  } else if (mode === "monitor") {
    await monitorCmd();
  } else {
    console.error(`unknown mode: ${mode}`);
    console.error("usage: node cli.mjs [status|doctor|migrate-refs <workspace> [--apply] [--json]|release --check [--json]|init <dir> [--workspace|--edges-only]|reload|check [--changed|--range <a>..<b>|--staged] [--strict]|drain [--all] [--close <id>[,<id>...] --status <done|wontfix|partial> [--reason ...] [--notes ...] [--closed-by ...]] [--group <correlation_id> ...] [--json]|reconcile [--all] [--inbound] [--group-by glob|node|none] [--ref <ref> | --source-ref <ref> --downstream-ref <ref>] [--json]|why <edge_id> [--all] [--json]|verify (--edge <id>|--node <id>|--glob <pattern>) [--state <STATE>] --disposition <d> [--reason ...] [--ref <ref> | --source-ref <ref> --downstream-ref <ref>] [--apply] [--json]|bootstrap [--baseline-from-git|--baseline-all|--none] [--bound <n>] [--apply] [--json]|inventory [--json|--emit-rows]|skills [--json]|skills-create <name> <intent>|skills-promote <name>|skills-demote <name>|skills-reap [--apply]|backlog [--json]|graph-index [--emit sqlite|cypher] [--out <path>] [--json]|graph [--all] [--node <path>] [--include-unverified] [--html <path>] [--json]|monitor [--dry-run] [--json]|manifest <workspace> [--json]|docs [<file>...|--all|--kinds|--structure [--tables]|--superseded [<doc>]]|journal --since <iso> [--until <iso>] [--json]]");
    process.exit(2);
  }
}
