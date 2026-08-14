#!/usr/bin/env node
/**
 * /propagate CLI — status, doctor, init, check.
 *
 * Usage:
 *   node cli.mjs status         — open rows for THIS project (the workspace at cwd)
 *   node cli.mjs status --all   — every workspace's queue
 *   node cli.mjs status --cross — the cross-repo ledger
 *   node cli.mjs doctor         — health check
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
 *                                            does NOT touch the file unless `--apply` is given.
 *                                            Every write is followed by a re-reconcile that
 *                                            confirms the edge landed in the expected state —
 *                                            failure to confirm is a non-zero exit.
 */

import { existsSync, globSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { execSync, execFileSync } from "node:child_process";

import {
  WORKSPACES,
  STATE_PATH,
  HEARTBEAT_PATH,
  WATCHER_LOG,
  SEARCH_ROOTS,
  DISCOVERY_DEGRADED,
  SUSPICIOUS_MARKERS,
  CROSS_LEDGER_JSONL,
  SKILL_DIR,
  GRAPH_MCP_CACHE_PATH,
} from "./lib/config.mjs";
import YAML from "yaml";

import {
  readLedger,
  readLedgerWithStats,
  lastActivityAt,
  markStatus,
  findUnownedLedgers,
  openCount,
  classifyUnownedLedger,
} from "./lib/ledger.mjs";
import { loadSidecar, SidecarError, downstreamsFor } from "./lib/frontmatter.mjs";
import { discoverCrossReposSync, loadCrossRepoSync, resolveTarget } from "./lib/cross-repo.mjs";
import { buildEdgeMap, findAllSidecarsRecursive } from "./lib/edges.mjs";
import { reconcile, STATES, groupRows, inboundRows } from "./lib/reconcile.mjs";
import { appendEvent, readEvents, DISPOSITIONS, edgeId } from "./lib/events.mjs";
import { gitStage, planBaseline, applyBaseline, BASELINE_POLICIES, DEFAULT_WALK_COMMITS } from "./lib/bootstrap.mjs";
import { parseDecisions, zeroTokenEntries } from "./lib/decisions.mjs";
import {
  METRICS_PATH,
  EXPECTATIONS,
  UNCALIBRATED,
  evaluateExpectations,
  detectVanishedKeys,
  readLastMetricsRecord,
  appendMetricsRecord,
} from "./lib/metrics.mjs";

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
import { discoverWorkspacesSync, isWorkspaceMarker } from "./lib/discovery.mjs";
import { LABEL as LAUNCHD_LABEL, regeneratePlist, reloadLaunchd, PLIST_PATH } from "./lib/plist.mjs";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BOLD = "\x1b[1m";

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers — exported for tests (tests/cli-json.test.mjs).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * N12: classify a DECISIONS.md's `Affects:` attribution health. `lib/decisions.mjs`'s
 * `zeroTokenEntries` already isolates the exact N12 failure mode (regex mismatch,
 * empty field, all-placeholder tokens) — this wraps it into the two shapes
 * `doctor` needs: a hard failure when EVERY entry in a non-empty file parses to
 * zero tokens (the bug returning wholesale), and a named warning when only SOME
 * do (partial attribution loss, still worth flagging by date/title).
 *
 * Exported and pure (text in, verdict out) so it's unit-testable directly
 * against synthetic fixtures, without shelling out to `doctor` as a subprocess
 * or touching the real `docs/DECISIONS.md` — same testability-over-shelling-out
 * reasoning as `computeCouplings`/`runCheck` above.
 * @param {string} text - raw DECISIONS.md content
 * @returns {{entries: Array, zero: Array, allZero: boolean}}
 */
export function decisionsAttributionReport(text) {
  const entries = parseDecisions(text);
  const zero = zeroTokenEntries(entries);
  return { entries, zero, allZero: entries.length > 0 && zero.length === entries.length };
}

/**
 * Watcher liveness derives ONLY from the heartbeat file's age. 70s = the
 * StartInterval (60s) plus slack. Never combine with ledger activity — a
 * quiet ledger on a healthy watcher is not the same signal as a dead watcher.
 * @param {number|null} ageSeconds
 * @returns {"alive"|"late"|"dead"|"never"}
 */
export function heartbeatState(ageSeconds) {
  if (ageSeconds === null || ageSeconds === undefined || !Number.isFinite(ageSeconds)) {
    return "never";
  }
  if (ageSeconds < 70) return "alive";
  if (ageSeconds <= 300) return "late";
  return "dead";
}

/** Extract the <string> entries inside the plist's <key>WatchPaths</key> array. */
export function parsePlistWatchPaths(xml) {
  const m = xml.match(/<key>WatchPaths<\/key>\s*<array>([\s\S]*?)<\/array>/);
  if (!m) return [];
  return [...m[1].matchAll(/<string>([^<]*)<\/string>/g)].map((mm) =>
    mm[1]
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'"),
  );
}

/** Expected WatchPaths for a set of discovered workspaces (root + docs/ when present). */
export function expectedWatchPaths(workspaces) {
  const set = new Set();
  for (const ws of workspaces) {
    set.add(ws.root);
    const docsDir = path.join(ws.root, "docs");
    if (existsSync(docsDir)) set.add(docsDir);
  }
  return set;
}

/**
 * Given every ledger's open rows, find absolute source paths open in more
 * than one ledger — the expiry signal for the deferred hub-row migration
 * (docs/DECISIONS.md 2026-08-10, "the 69 misfiled hub rows are deferred").
 * @param {Array<{workspaceRoot: string, ledgerPath: string, rows: Array}>} ledgerEntries
 * @returns {{count: number, examples: Array<{path: string, ledgers: string[]}>}}
 */
export function findDuplicateOpenAcrossLedgers(ledgerEntries) {
  const bySource = new Map(); // absPath -> Set(ledgerPath)
  for (const { workspaceRoot, ledgerPath, rows } of ledgerEntries) {
    for (const row of rows) {
      if (row.status !== "open" || !row.source) continue;
      const abs = path.resolve(workspaceRoot, row.source);
      if (!bySource.has(abs)) bySource.set(abs, new Set());
      bySource.get(abs).add(ledgerPath);
    }
  }
  const dups = [...bySource.entries()].filter(([, set]) => set.size > 1);
  return {
    count: dups.length,
    examples: dups.slice(0, 5).map(([abs, set]) => ({ path: abs, ledgers: [...set] })),
  };
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

/** Root of the nearest ancestor workspace, or null. */
export function nestedUnderOf(ws, workspaces) {
  const ancestors = workspaces.filter(
    (o) => o.root !== ws.root && (ws.root === o.root || ws.root.startsWith(o.root + path.sep)),
  );
  if (ancestors.length === 0) return null;
  const nearest = ancestors.reduce((best, o) => (o.root.length > best.root.length ? o : best));
  return nearest.root;
}

/**
 * Sweep for `.propagates.yml` markers to `maxDepth`, deeper than discovery's
 * default (2), so a workspace marker discovery silently dropped is caught.
 * Skips dot-directories (e.g. `.claude/worktrees/`) at every level.
 */
async function sweepMarkers(roots, maxDepth) {
  const found = [];
  async function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === ".propagates.yml")) {
      found.push(path.join(dir, ".propagates.yml"));
    }
    if (depth === maxDepth) return;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith(".")) continue; // skip dot-directories (worktree copies etc.)
      if (e.name === "node_modules") continue;
      await walk(path.join(dir, e.name), depth + 1);
    }
  }
  for (const root of roots) {
    if (existsSync(root)) await walk(root, 0);
  }
  return found;
}

/**
 * Classify a single non-glob downstream path declared in a sidecar, relative
 * to that sidecar's own directory (SPEC §3c bug B: a directory declared as a
 * downstream; docs/ISSUES.md N11-adjacent).
 *
 * Distinct from "missing": a directory is always a declaration error — reading
 * it as content fails with EISDIR, and there is no "I intend to create this
 * directory later" allowance the way there is for a not-yet-written `kind:
 * code` file. A missing *file* may be legitimate declare-ahead; a missing
 * *directory-shaped* thing never is, because a directory is never valid
 * content to begin with.
 *
 * @param {string} scDir absolute path to the sidecar's own directory
 * @param {string} downstreamPath the declared `path` (already known non-glob)
 * @returns {Promise<"ok"|"missing"|"is-directory">}
 */
export async function classifyDownstreamPath(scDir, downstreamPath) {
  const abs = path.resolve(scDir, downstreamPath);
  try {
    const st = await stat(abs);
    return st.isDirectory() ? "is-directory" : "ok";
  } catch (err) {
    if (err.code === "ENOENT") return "missing";
    throw err;
  }
}

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

/**
 * The workspace whose root contains the current working directory, or null if
 * cwd is outside every known workspace. Lets `status` default to "this project"
 * instead of relaying every workspace's queue.
 */
function currentWorkspace() {
  const cwd = process.cwd();
  // Nearest ancestor, not first match. A repo registered as its own workspace
  // also sits under a broader one (e.g. Keerti-portfolio inside the GitHub hub),
  // and `.find()` returned whichever was discovered first — so `status` run from
  // inside the repo relayed the hub's queue instead of the repo's. Longest
  // matching root wins, matching `findAllSidecarsRecursive`'s scoping.
  const matches = WORKSPACES.filter(
    (ws) => cwd === ws.root || cwd.startsWith(ws.root + path.sep),
  );
  if (matches.length === 0) return null;
  return matches.reduce((best, ws) => (ws.root.length > best.root.length ? ws : best));
}

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
  let launchdLoaded = false;
  try {
    const out = execSync("launchctl list", { encoding: "utf8" });
    launchdLoaded = out.split("\n").some((l) => l.includes(LAUNCHD_LABEL));
  } catch {
    launchdLoaded = false;
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
  const exists = existsSync(jsonlPath);
  const { rows, malformed, unknownTypes } = exists
    ? await readLedgerWithStats(jsonlPath)
    : { rows: [], malformed: 0, unknownTypes: {} };
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
  return {
    generatedAt: new Date().toISOString(),
    degraded: DISCOVERY_DEGRADED,
    suspiciousMarkers: SUSPICIOUS_MARKERS,
    watcher,
    workspaces,
    cross,
  };
}

async function status() {
  if (process.argv.includes("--json")) {
    const obj = await statusJson();
    console.log(JSON.stringify(obj));
    return;
  }
  if (process.argv.includes("--cross")) {
    const { CROSS_LEDGER_JSONL } = await import("./lib/config.mjs");
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
    const rows = await readLedger(ws.ledgerJsonl);
    const open = rows.filter((r) => r.status === "open");
    if (open.length === 0) {
      console.log(`  ${GREEN}✓ no open drift events${RESET}\n`);
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
    const ownedLedgers = [...WORKSPACES.map((w) => w.ledgerJsonl), CROSS_LEDGER_JSONL];
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
      const { CROSS_LEDGER_JSONL } = await import("./lib/config.mjs");
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
  // Detail collected for the four subjects whose sole assertion now lives in
  // EXPECTATIONS (lib/metrics.mjs, GOTCHAS G20) — the inline check() calls
  // that used to assert these facts were downgraded to info()/warn(), but the
  // exact-offender detail they used to print must still reach the reader, so
  // it's captured here and handed to evaluateExpectations() as context.
  const ledgerUnknownTypesDetails = [];
  const sidecarsRejectedDetails = [];
  let decisionsPath = "";
  let decisionsZeroEntries = [];
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
  console.log(`${BOLD}# launchd watcher — RETIRED 2026-08-14${RESET}`);
  console.log(`  ${DIM}resolved label: ${LAUNCHD_LABEL}${RESET}`);
  console.log(`  ${DIM}see docs/DECISIONS.md 2026-08-14 for why; these are informational, never a failure${RESET}`);
  try {
    const out = execSync("launchctl list", { encoding: "utf8" });
    const loaded = out.split("\n").some((l) => l.includes(LAUNCHD_LABEL));
    info("plist loaded", loaded ? "yes — unloading is a separate, later step; loaded is not a failure here" : "no — unloaded (expected once retirement is complete)");
  } catch (err) {
    info("launchctl unreachable", err.message);
  }

  if (existsSync(HEARTBEAT_PATH)) {
    const raw = (await readFile(HEARTBEAT_PATH, "utf8")).trim();
    const ts = parseInt(raw, 10);
    const ageMs = Date.now() - ts;
    const ageMin = Math.round(ageMs / 60_000);
    const ageDays = Math.round(ageMs / (1000 * 60 * 60 * 24));
    const ageLabel = ageDays > 1 ? `${ageDays} days old` : `${ageMin} min old`;
    info("heartbeat age", `${ageLabel} — a retired component's heartbeat is expected to go stale; not a health signal`);
  } else {
    info("heartbeat file", "does not exist — expected once the watcher has stopped running");
  }

  // Replacement health: does the v2 event store (lib/events.mjs) actually
  // hold the verification history `reconcile` derives drift from, and does
  // `reconcile` itself complete? These are the checks that matter now — see
  // the retirement note above for why the launchd checks above no longer are.
  console.log(`\n${BOLD}# v2 replacement (event store + reconcile)${RESET}`);
  try {
    const { events, malformed } = await readEvents();
    check("event store readable", true, `${events.length} event(s), ${malformed} malformed`);
    check(
      "event store non-empty",
      events.length > 0,
      events.length === 0 ? "no verification events recorded yet — run `bootstrap --apply`" : "",
    );
    if (malformed > 0) {
      check("event store lines all parseable", false, `${malformed} malformed line(s)`);
    }
  } catch (err) {
    check("event store readable", false, err.message);
  }
  try {
    const reconcileStart = Date.now();
    await reconcile(WORKSPACES);
    check("reconcile completes", true, `${Date.now() - reconcileStart}ms`);
  } catch (err) {
    check("reconcile completes", false, err.message);
  }

  console.log(`\n${BOLD}# State${RESET}`);
  check("state.json exists", existsSync(STATE_PATH));
  if (existsSync(STATE_PATH)) {
    try {
      const raw = await readFile(STATE_PATH, "utf8");
      const parsed = JSON.parse(raw);
      stateTrackedFilesCount = Object.keys(parsed.mtimes || {}).length;
      check("state.json parseable", true, `${stateTrackedFilesCount} tracked files`);
    } catch (err) {
      check("state.json parseable", false, err.message);
    }
  }
  if (existsSync(`${STATE_PATH}.bak`)) {
    check("state.json.bak exists", true);
  } else {
    console.log(`  ${YELLOW}!${RESET} state.json.bak exists  ${DIM}no .bak yet (normal until watcher writes for the 2nd time)${RESET}`);
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

  for (const ws of WORKSPACES) {
    console.log(`\n${BOLD}# Workspace: ${ws.name}${RESET}`);
    check("ledger JSONL exists", existsSync(ws.ledgerJsonl));
    if (existsSync(ws.ledgerJsonl)) {
      try {
        const { rows, unknownTypes } = await readLedgerWithStats(ws.ledgerJsonl);
        const openCount = rows.filter((r) => r.status === "open").length;
        rowsOpenTotal += openCount;
        check("ledger JSONL parseable", true, `${rows.length} rows, ${openCount} open`);

        // N1: readLedgerWithStats already counts row types the fold doesn't
        // know how to handle (e.g. hand-authored "manual" rows); readLedger
        // and every one of its callers throw that count away. This used to be
        // a per-workspace FAILURE naming the ledger and offending type
        // strings; the assertion now lives solely in EXPECTATIONS
        // ("ledger.unknown_types == 0", lib/metrics.mjs, GOTCHAS G20) so one
        // bad row prints one ✗, not one per workspace it happens to live in.
        // The path/type/count detail the old check named is preserved here
        // and handed to that single aggregate assertion via context.
        const unknownEntries = Object.entries(unknownTypes);
        const unknownCount = unknownEntries.reduce((sum, [, n]) => sum + n, 0);
        ledgerUnknownTypesTotal += unknownCount;
        if (unknownCount > 0) {
          ledgerUnknownTypesDetails.push(
            `${ws.ledgerJsonl}: ${unknownEntries
              .map(([t, n]) => `"${t}"×${n}`)
              .join(", ")} — unknown to readLedger, silently dropped by the fold (docs/DATA_MODEL.md)`,
          );
        }
        info(
          "no row types unknown to the reader",
          unknownCount ? `${unknownCount} unknown — asserted in Metrics section` : "",
        );
      } catch (err) {
        check("ledger JSONL parseable", false, err.message);
      }
    }
    check("ledger MD exists", existsSync(ws.ledgerMd));

    // Sidecars — those assigned to THIS workspace as nearest owner (see above).
    const sidecars = assignedByWsRoot.get(ws.root) || [];
    console.log(`  ${DIM}found ${sidecars.length} sidecar${sidecars.length === 1 ? "" : "s"}${RESET}`);
    for (const sc of sidecars) {
      const rel = path.relative(ws.root, sc);
      try {
        const loaded = await loadSidecar(sc);
        sidecarsLoadedCount++;
        check(`  ${rel}`, true);
        // Per-entry problems (N9 fix): a bad downstream entry is pruned
        // rather than failing the whole sidecar, but must stay a loud
        // doctor FAILURE naming the sidecar, source key, and path — pruning
        // must not trade one silent failure for another.
        sidecarsProblemsCount += (loaded.problems || []).length;
        for (const p of loaded.problems || []) {
          check(
            `  ${rel}: source "${p.sourceKey}" propagates_to[${p.index}]${p.path ? ` (${p.path})` : ""}`,
            false,
            `pruned — ${p.message}`,
          );
        }
      } catch (err) {
        sidecarsRejectedCount++;
        const msg = err instanceof SidecarError ? err.message.split("] ").pop() : err.message;
        // Assertion moved to EXPECTATIONS ("sidecars.rejected == 0",
        // lib/metrics.mjs, GOTCHAS G20) so one bad sidecar doesn't print two
        // ✗ lines (one here, one in Metrics). Detail preserved for that
        // aggregate check via sidecarsRejectedDetails.
        sidecarsRejectedDetails.push(`${ws.name}/${rel}: ${msg}`);
        info(`  ${rel}`, `rejected — ${msg}`);
      }
    }

    // Path validation: every sidecar downstream target resolves on disk.
    // prose missing → problem (fail); code (declare-ahead) → warn; glob → need ≥1 match.
    let pathProblems = 0;
    let pathWarns = 0;
    for (const sc of sidecars) {
      const scDir = path.dirname(sc);
      let sidecar;
      try {
        sidecar = await loadSidecar(sc);
      } catch {
        continue;
      }
      const rel = path.relative(ws.root, sc);
      for (const [src, body] of Object.entries(sidecar.sources || {})) {
        for (const d of body.propagates_to || []) {
          const kind = d.kind || "prose";
          if (/[*?[\]]/.test(d.path)) {
            let n = 0;
            try {
              n = globSync(d.path, { cwd: scDir }).filter((m) => !m.includes("node_modules/")).length;
            } catch {
              /* ignore */
            }
            if (n === 0) {
              warn(`${rel}: ${src} → ${d.path}`, "glob matched 0 files");
              pathWarns++;
            }
          } else {
            // SPEC §3c bug B: stat the target so a directory-shaped downstream
            // (EISDIR at read time) is distinguished from one that's simply
            // absent. Different problems, different messages, different severities.
            const classification = await classifyDownstreamPath(scDir, d.path);
            if (classification === "is-directory") {
              // Always a FAILURE, never intentional — unlike a missing file,
              // there is no "declare-ahead" reading of "this is a directory".
              check(
                `${rel}: ${src} → ${d.path}`,
                false,
                "downstream is a directory, not a file — a downstream must be a file or a glob, never a bare directory (reads as EISDIR)",
              );
              pathProblems++;
            } else if (classification === "missing") {
              // Warn-only: doctor is a cross-workspace health report — a stale edge
              // in one workspace must not red the aggregate exit code. Per-repo
              // enforcement lives in that repo's pre-commit (check-propagation.sh).
              // v1's prose/code distinction is intentional and unchanged here:
              // `kind: code` missing is declare-ahead, not a bug.
              warn(
                `${rel}: ${src} → ${d.path}`,
                kind === "code" ? "declare-ahead code, not on disk" : "prose downstream missing",
              );
              pathWarns++;
            }
          }
        }
      }
    }
    if (pathProblems === 0) {
      // No per-entry failures fired above — this aggregate is the only signal,
      // so it still counts as a real check (today's behaviour, unchanged).
      check("sidecar downstream paths resolve", true, pathWarns ? `${pathWarns} warn` : "");
    } else {
      // Per-entry `check()` calls above already reported and counted each
      // directory-as-downstream failure individually. Restating the same
      // defect here as a second `✗` would count it twice for one underlying
      // bug (docs/ISSUES.md A2's "5th problem" note, now fixed) — so this is
      // a summary, informational only, not a vote.
      info(
        "sidecar downstream paths resolve",
        `${pathProblems} directory-as-downstream failure${pathProblems === 1 ? "" : "s"} (see above)${pathWarns ? `, ${pathWarns} warn` : ""}`,
      );
    }
  }

  console.log(`\n${BOLD}# Cross-repo${RESET}`);
  try {
    const x = await checkCrossRepo();
    check("cross-repo edges resolve", x.missing === 0 && x.outsideAllowlist === 0,
      `${x.edges} edges, ${x.missing} missing, ${x.outsideAllowlist} outside-allowlist`);
    // G7: every fired row must carry a normalized `partner` join key.
    const { CROSS_LEDGER_JSONL } = await import("./lib/config.mjs");
    const rows = await readLedger(CROSS_LEDGER_JSONL);
    const noPartner = rows.filter((r) => r.type === "drift" && !r.partner).length;
    check("cross rows carry partner", noPartner === 0, `${noPartner} rows missing partner`);
  } catch (err) {
    check("cross-repo check ran", false, err.message);
  }

  console.log(`\n${BOLD}# DECISIONS.md attribution${RESET}`);
  // N12: the mechanism that records *why* a choice was made must be able to
  // read its own Affects: attribution field. A non-empty file where every
  // entry parses to zero tokens means the parser is reading nothing from
  // content that exists — that is always a bug, and it is the exact failure
  // that shipped silently for weeks (all 8 live entries, 0 tokens) before
  // being caught by hand. Checks the skill's own docs/DECISIONS.md.
  try {
    const decPath = path.join(SKILL_DIR, "docs", "DECISIONS.md");
    decisionsPath = decPath;
    if (!existsSync(decPath)) {
      console.log(`  ${DIM}(no docs/DECISIONS.md at ${decPath})${RESET}`);
    } else {
      const text = await readFile(decPath, "utf8");
      const { entries, zero } = decisionsAttributionReport(text);
      decisionsEntriesCount = entries.length;
      decisionsWithTokensCount = entries.length - zero.length;
      decisionsZeroEntries = zero.map((e) => `${e.date} ${e.title || "(untitled)"}`);
      // The count == count assertion (was: fail only when ALL entries are
      // zero; a partial-zero file only warned) now lives solely in
      // EXPECTATIONS ("decisions.with_tokens == decisions.entries",
      // lib/metrics.mjs, GOTCHAS G20) — equality is the correct bar per that
      // entry's basis, so collapsing to one mechanism also closes the gap
      // where a partial-zero file used to only warn. This line stays
      // informational; the try/catch below is the one thing EXPECTATIONS
      // cannot see (a parse that throws leaves entries=0/withTokens=0, which
      // reads as a false "0 == 0" pass) — that failure mode stays here.
      info(
        "Affects: tokens parse",
        `${entries.length} entries, ${entries.length - zero.length} with tokens`,
      );
    }
  } catch (err) {
    check("Affects: tokens parse", false, err.message);
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
  // N7: zero discovered workspaces must fail, not pass. DISCOVERY_DEGRADED
  // only trips when markers were seen on disk but none opted into
  // `workspace: true` (lib/discovery.mjs: `markersSeen > 0 && found.length
  // === 0`). It stays false when SEARCH_ROOTS itself is wrong and zero
  // markers are seen at all — e.g. PROPAGATE_SEARCH_ROOTS pointing outside
  // the real tree — and in that case the per-workspace loop below simply runs
  // zero times, every check in it trivially "passes" by not running, and
  // doctor reports healthy. That is precisely the "abandoned automation
  // reports itself healthy" failure lib/config.mjs's own comment names.
  // Assertion moved to EXPECTATIONS ("workspaces.discovered >= 1",
  // lib/metrics.mjs, GOTCHAS G20) — this was an exact duplicate (same bound,
  // same fact), so it's informational here and asserted once, in Metrics.
  info(
    "at least one workspace discovered",
    WORKSPACES.length === 0
      ? `SEARCH_ROOTS=[${SEARCH_ROOTS.join(", ")}] — zero workspaces found; every per-workspace check below silently did not run`
      : `${WORKSPACES.length} found`,
  );
  if (DISCOVERY_DEGRADED) {
    check(
      "discovery not degraded",
      false,
      "markers found on disk but none opted into workspace: true — discovery is silently swallowing every workspace",
    );
  } else {
    check("discovery not degraded", true);
  }

  // Partial-loss signal (distinct from total-collapse DISCOVERY_DEGRADED
  // above): one marker among several silently dropping out — corrupted YAML,
  // `workspace: "true"` typo'd as a string, or a throw while building its
  // workspace record — while the rest of discovery still succeeds.
  check(
    "no suspicious workspace markers",
    SUSPICIOUS_MARKERS.length === 0,
    SUSPICIOUS_MARKERS.length
      ? SUSPICIOUS_MARKERS.map((m) => `${m.path}: ${m.reason}`).join("; ")
      : "",
  );

  // (a) plist WatchPaths vs currently-discovered workspace roots + docs dirs.
  // GOTCHAS G20: this is the one EXPECTATIONS-adjacent subject that stays
  // inline on purpose, not an oversight. This does exact set-equality
  // (missing/extra paths named individually); EXPECTATIONS only ever held a
  // count floor (`plist.watchpaths >= workspaces.discovered`, N14's
  // zero-collapse regression). The floor is strictly weaker — a wrong-but-
  // same-sized set passes it while failing here — so it was removed from
  // EXPECTATIONS rather than kept as a second, redundant vote alongside this
  // richer check. One fact, one assertion; this one just isn't a duplicate.
  try {
    if (existsSync(PLIST_PATH)) {
      const xml = await readFile(PLIST_PATH, "utf8");
      const actual = new Set(parsePlistWatchPaths(xml));
      plistWatchpathsCount = actual.size;
      const expected = expectedWatchPaths(WORKSPACES);
      const missing = [...expected].filter((p) => !actual.has(p));
      const extra = [...actual].filter((p) => !expected.has(p));
      check(
        "plist WatchPaths matches discovered workspaces",
        missing.length === 0 && extra.length === 0,
        missing.length || extra.length
          ? `missing: ${missing.join(", ") || "(none)"}; stale: ${extra.join(", ") || "(none)"}`
          : "",
      );
    } else {
      // The watcher was retired 2026-08-14 and its plist deleted on purpose, so
      // "no plist" is the expected state, not a fault. This check stayed armed
      // through the retirement and failed every run afterwards — a red check for
      // a component that no longer exists is exactly how a real red check becomes
      // background noise (G20). Informational, never ✗; per G2 it still says
      // *why* it is absent rather than falling silent.
      info(
        "plist WatchPaths — n/a",
        `${PLIST_PATH} does not exist; the watcher was retired 2026-08-14 (docs/DECISIONS.md). Its replacement's health is asserted under "v2 replacement" below.`,
      );
    }
  } catch (err) {
    check("plist WatchPaths matches discovered workspaces", false, err.message);
  }

  // (b) same absolute source open in more than one ledger (see DECISIONS.md
  // "the 69 misfiled hub rows are deferred" — this is that deferral's expiry signal).
  try {
    const ledgerEntries = [];
    for (const ws of WORKSPACES) {
      if (!existsSync(ws.ledgerJsonl)) continue;
      const { rows } = await readLedgerWithStats(ws.ledgerJsonl);
      ledgerEntries.push({ workspaceRoot: ws.root, ledgerPath: ws.ledgerJsonl, rows });
    }
    const dup = findDuplicateOpenAcrossLedgers(ledgerEntries);
    check(
      "no source open in more than one ledger",
      dup.count === 0,
      dup.count
        ? `${dup.count} source path(s) open in >1 ledger, e.g. ${dup.examples
            .map((e) => `${e.path} [${e.ledgers.join(", ")}]`)
            .join("; ")}`
        : "",
    );
  } catch (err) {
    check("no source open in more than one ledger", false, err.message);
  }

  // (c) malformed JSONL lines per ledger — readLedger silently `continue`s
  // past unparseable lines, so the existing "ledger JSONL parseable" check
  // above is vacuous; this makes a non-zero count a real problem.
  try {
    let totalMalformed = 0;
    const perLedger = [];
    for (const ws of WORKSPACES) {
      if (!existsSync(ws.ledgerJsonl)) continue;
      const { malformed } = await readLedgerWithStats(ws.ledgerJsonl);
      totalMalformed += malformed;
      if (malformed > 0) perLedger.push(`${ws.name}: ${malformed}`);
    }
    ledgerMalformedTotal = totalMalformed;
    check(
      "no malformed ledger lines",
      totalMalformed === 0,
      totalMalformed ? perLedger.join(", ") : "",
    );
  } catch (err) {
    check("no malformed ledger lines", false, err.message);
  }

  // (d) `.propagates.yml` markers carrying workspace: true that discovery did
  // NOT return — silently dropping a workspace is the exact failure this
  // fix exists to prevent. Sweeps deeper (depth 5) than discovery (depth 2).
  try {
    const markers = await sweepMarkers(SEARCH_ROOTS, 5);
    const discoveredRoots = new Set(WORKSPACES.map((ws) => ws.root));
    const unreachable = [];
    for (const markerPath of markers) {
      if (!isWorkspaceMarker(markerPath)) continue;
      const dir = path.dirname(markerPath);
      if (!discoveredRoots.has(dir)) unreachable.push(dir);
    }
    check(
      "no unreachable workspace markers",
      unreachable.length === 0,
      unreachable.length ? unreachable.join(", ") : "",
    );

    // A ledger can be real, non-empty and owned by nobody — below the discovery
    // depth limit, or beside a sidecar that never set `workspace: true`. Such a
    // ledger contributes 0 to every total while looking exactly like "no drift".
    // Report it as unreachable rather than dropping it (rule:discernment-checks §2).
    const ownedLedgers = [...WORKSPACES.map((w) => w.ledgerJsonl), CROSS_LEDGER_JSONL];
    const unowned = await findUnownedLedgers(SEARCH_ROOTS, ownedLedgers);
    const orphans = [];
    const snapshots = [];
    for (const p of unowned) {
      const c = await classifyUnownedLedger(p, ownedLedgers);
      (c.kind === "snapshot" ? snapshots : orphans).push({ p, ...c });
    }
    // A branch-time copy of an owned ledger is not a second source of truth, and
    // its stale `open` rows must not be counted (see classifyUnownedLedger).
    // Still reported — invisible-but-harmless is how the original hole formed.
    for (const s of snapshots) {
      info(
        "branch-snapshot ledger (not counted)",
        `${s.p} — all ${s.ids} ids present in ${path.basename(path.dirname(path.dirname(s.of)))}'s ledger; ${s.openRows} row(s) still marked open here are stale branch state`,
      );
    }
    check(
      "no unowned ledger files",
      orphans.length === 0,
      orphans.length
        ? `${orphans.length} ledger file(s) on disk that no workspace owns — their rows are invisible to status/reconcile: ${orphans.map((o) => `${o.p} (${o.openRows} open)`).join("; ")}`
        : "",
    );
  } catch (err) {
    check("no unreachable workspace markers", false, err.message);
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
    const metrics = {
      "workspaces.discovered": WORKSPACES.length,
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
      decisionsPath,
      decisionsZeroEntries,
      ledgerUnknownTypesDetails,
      sidecarsRejectedDetails,
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
# demand — run \`node ~/.claude/skills/propagate/cli.mjs reconcile\` to check
# whether a declared source has moved out of sync with its downstream(s).
# Walk through open v1 rows via \`node ~/.claude/skills/propagate/cli.mjs status\`.
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
export function resolveChangedFile(absPath, workspaces = WORKSPACES) {
  const matches = workspaces.filter(
    (ws) => absPath === ws.root || absPath.startsWith(ws.root + path.sep),
  );
  if (matches.length === 0) return null;
  const ws = matches.reduce((best, w) => (w.root.length > best.root.length ? w : best));
  return { workspace: ws, rel: path.relative(ws.root, absPath) };
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

  const { exitCode, couplings } = await runCheck({ changedFiles, repoRoot, strict, json });
  const inbound = await inboundAdvisory(repoRoot);
  if (json) {
    console.log(
      JSON.stringify({
        generatedAt: new Date().toISOString(),
        repoRoot,
        changedFiles,
        strict,
        exitCode,
        couplings,
        inbound, // advisory only — never affects exitCode, see inboundAdvisory()
      }),
    );
  } else {
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

/** Open rows for one discovered workspace record (WORKSPACES entry). */
async function openRowsForWorkspace(ws) {
  if (!existsSync(ws.ledgerJsonl)) return [];
  const rows = await readLedger(ws.ledgerJsonl);
  return rows.filter((r) => r.status === "open");
}

/**
 * Split open rows into correlation_id groups and an ungrouped remainder.
 * Rows sharing a correlation_id are the same logical change observed on
 * different branches/worktrees — the parallel-coordination behaviour the
 * skill's premise names, so grouping is the default presentation, not an
 * option (SPEC §6, SKILL.md "Correlation grouping matters under the premise").
 */
function groupOpenRows(rows) {
  const groups = new Map(); // correlation_id -> rows[]
  const ungrouped = [];
  for (const r of rows) {
    if (r.correlation_id) {
      if (!groups.has(r.correlation_id)) groups.set(r.correlation_id, []);
      groups.get(r.correlation_id).push(r);
    } else {
      ungrouped.push(r);
    }
  }
  return { groups, ungrouped };
}

function rowAgeMs(r) {
  const t = Date.parse(r.timestamp);
  return Number.isFinite(t) ? Date.now() - t : null;
}

function formatAge(ms) {
  if (ms === null) return "unknown age";
  const days = Math.floor(ms / 86_400_000);
  if (days > 0) return `${days}d`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours > 0) return `${hours}h`;
  const mins = Math.floor(ms / 60_000);
  return `${mins}m`;
}

function drainRowSummary(r) {
  return {
    id: r.id,
    source: r.source ?? null,
    downstreamCount: (r.downstream || []).length,
    ageMs: rowAgeMs(r),
    correlation_id: r.correlation_id ?? null,
  };
}

/** Workspaces to operate over: current workspace at cwd, unless --all or cwd matches none. */
function drainScope(args) {
  const showAll = args.includes("--all");
  const cur = currentWorkspace();
  return showAll || !cur ? WORKSPACES : [cur];
}

async function drainList(args, json) {
  const targets = drainScope(args);

  if (json) {
    const workspaces = [];
    for (const ws of targets) {
      const rows = await openRowsForWorkspace(ws);
      const { groups, ungrouped } = groupOpenRows(rows);
      workspaces.push({
        name: ws.name,
        root: ws.root,
        ledgerJsonl: ws.ledgerJsonl,
        groups: [...groups.entries()].map(([correlation_id, rs]) => ({
          correlation_id,
          count: rs.length,
          rows: rs.map(drainRowSummary),
        })),
        ungrouped: ungrouped.map(drainRowSummary),
      });
    }
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), workspaces }));
    return;
  }

  for (const ws of targets) {
    console.log(`${BOLD}# ${ws.name}${RESET}`);
    const rows = await openRowsForWorkspace(ws);
    if (rows.length === 0) {
      console.log(`  ${GREEN}✓ no open rows${RESET}\n`);
      continue;
    }
    const { groups, ungrouped } = groupOpenRows(rows);
    for (const [correlation_id, rs] of groups) {
      console.log(
        `  ${BOLD}${correlation_id}${RESET}  ${DIM}(${rs.length} rows — same logical change, different branch/worktree)${RESET}`,
      );
      for (const r of rs) {
        console.log(
          `    ${YELLOW}#${r.id}${RESET}  ${r.source || "(unknown source)"}  ${DIM}${(r.downstream || []).length} downstream, ${formatAge(rowAgeMs(r))} old${RESET}`,
        );
      }
    }
    for (const r of ungrouped) {
      console.log(
        `  ${YELLOW}#${r.id}${RESET}  ${r.source || "(unknown source)"}  ${DIM}${(r.downstream || []).length} downstream, ${formatAge(rowAgeMs(r))} old${RESET}`,
      );
    }
    console.log();
  }
}

async function drainClose(args, json) {
  const closeIdx = args.indexOf("--close");
  const groupIdx = args.indexOf("--group");
  const statusIdx = args.indexOf("--status");
  const reasonIdx = args.indexOf("--reason");
  const notesIdx = args.indexOf("--notes");
  const closedByIdx = args.indexOf("--closed-by");

  const closeIds =
    closeIdx !== -1
      ? (args[closeIdx + 1] || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  const groupId = groupIdx !== -1 ? args[groupIdx + 1] : null;
  const status = statusIdx !== -1 ? args[statusIdx + 1] : null;
  const reason = reasonIdx !== -1 ? args[reasonIdx + 1] : undefined;
  const notes = notesIdx !== -1 ? args[notesIdx + 1] : undefined;
  const closedBy = closedByIdx !== -1 ? args[closedByIdx + 1] : "drain";

  if (closeIds.length === 0 && !groupId) {
    console.error(
      `${RED}error:${RESET} nothing to close — pass --close <id[,id...]> and/or --group <correlation_id>`,
    );
    process.exit(2);
  }
  if (!status) {
    console.error(`${RED}error:${RESET} --status <done|wontfix|partial> is required with --close/--group`);
    process.exit(2);
  }
  if (!["done", "wontfix", "partial"].includes(status)) {
    console.error(`${RED}error:${RESET} --status must be one of done|wontfix|partial (got "${status}")`);
    process.exit(2);
  }

  const scope = drainScope(args);
  const openByWs = new Map(); // ws -> open rows
  for (const ws of scope) {
    openByWs.set(ws, await openRowsForWorkspace(ws));
  }

  // Resolve every --close id to the (single) workspace ledger where it's
  // currently open. Ids are file-local (lib/ledger.mjs nextId), so the same
  // id string can legitimately be open in two different ledgers when scoped
  // with --all — that's ambiguous and must fail loudly (I1), not guess.
  const targets = []; // {ws, row}
  const notFound = [];
  for (const id of closeIds) {
    const found = [];
    for (const [ws, rows] of openByWs) {
      const r = rows.find((row) => row.id === id);
      if (r) found.push({ ws, row: r });
    }
    if (found.length === 0) {
      notFound.push(id);
    } else if (found.length > 1) {
      console.error(
        `${RED}error:${RESET} row id "${id}" is open in more than one workspace ledger (${found
          .map((f) => f.ws.name)
          .join(", ")}) — re-run scoped to a single workspace instead of --all`,
      );
      process.exit(1);
    } else {
      targets.push(found[0]);
    }
  }
  if (notFound.length) {
    console.error(
      `${RED}error:${RESET} row id(s) not found (or not open) in scope: ${notFound.join(", ")}`,
    );
    console.error(
      `${DIM}run \`node cli.mjs drain\` (add --all to widen scope) to see current open ids${RESET}`,
    );
    process.exit(1);
  }

  if (groupId) {
    let matched = 0;
    for (const [ws, rows] of openByWs) {
      for (const r of rows) {
        if (r.correlation_id === groupId) {
          targets.push({ ws, row: r });
          matched++;
        }
      }
    }
    if (matched === 0) {
      console.error(`${RED}error:${RESET} no open rows found with correlation_id "${groupId}"`);
      process.exit(1);
    }
  }

  // De-dupe: an id could arrive via both --close and --group.
  const seen = new Set();
  const uniqueTargets = [];
  for (const t of targets) {
    const key = `${t.ws.ledgerJsonl}:${t.row.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueTargets.push(t);
  }

  const opts = { closed_by: closedBy };
  if (notes !== undefined) opts.notes = notes;
  if (status === "wontfix") opts.wontfix_reason = reason;

  const closed = [];
  const failed = [];

  for (const { ws, row } of uniqueTargets) {
    try {
      await markStatus(ws.ledgerJsonl, row.id, status, opts);
    } catch (err) {
      // markStatus throws for status:"wontfix" with no wontfix_reason, and for
      // an invalid closed_by — surface the message, not a stack trace.
      failed.push({ id: row.id, workspace: ws.name, error: err.message });
      continue;
    }
    // Verify the close actually landed — do not trust "did not throw". A
    // wrong-ledger write or a discovery mismatch would otherwise silently
    // no-op and leave the row open (I1: no silent no-op).
    const after = await readLedger(ws.ledgerJsonl);
    const updated = after.find((r) => r.id === row.id);
    const stillOpen = !updated || updated.status === "open";
    if (stillOpen) {
      failed.push({
        id: row.id,
        workspace: ws.name,
        error: "verify-after-write failed: row still open after markStatus",
      });
    } else {
      closed.push({ id: row.id, workspace: ws.name, status: updated.status });
    }
  }

  if (json) {
    console.log(
      JSON.stringify({
        generatedAt: new Date().toISOString(),
        status,
        closed_by: closedBy,
        wontfix_reason: status === "wontfix" ? reason : undefined,
        closed,
        failed,
        exitCode: failed.length ? 1 : 0,
      }),
    );
  } else {
    for (const c of closed) {
      console.log(`${GREEN}✓${RESET} #${c.id}  ${c.workspace}  → ${c.status}  ${DIM}(closed_by: ${closedBy})${RESET}`);
    }
    for (const f of failed) {
      console.log(`${RED}✗${RESET} #${f.id}  ${f.workspace}  ${RED}${f.error}${RESET}`);
    }
  }

  if (failed.length) process.exit(1);
}

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

  if (inbound) {
    await reconcileInbound({ json, groupBy });
    return;
  }

  const cur = currentWorkspace();
  const workspaces = showAll || !cur ? WORKSPACES : [cur];

  const { rows, stats } = await reconcile(workspaces);
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

async function drain() {
  const args = process.argv.slice(3);
  const json = args.includes("--json");
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
            if (edgeId(row.node_id, downstreamAbs, d.why) === row.edge_id) {
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
            if (edgeId(row.node_id, downstreamAbs, d.why) === row.edge_id) {
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
      const payload = {
        edge_id: row.edge_id,
        node_id: row.node_id,
        disposition: "decoupled",
        by: process.env.USER || "verify",
        observed_on_ref: row.source.ref || "working-tree",
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
async function runDispositionBatch(selected, workspaces, opts) {
  const { disposition, reason, json } = opts;

  const applied = [];
  const refused = [];

  for (const row of selected) {
    const refusal = divergedGuard(row.state, disposition);
    if (refusal) {
      refused.push({ edge_id: row.edge_id, node_id: row.node_id, error: refusal });
      continue;
    }

    const payload = {
      edge_id: row.edge_id,
      node_id: row.node_id,
      disposition,
      by: process.env.USER || "verify",
      observed_on_ref: row.source.ref || "working-tree",
    };
    if (reason !== undefined) payload.reason = reason;
    if (disposition !== "deferred") {
      payload.source_content = row.source.contentId;
      payload.downstream_content = row.downstream.contentId;
    }

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
  const { rows } = await reconcile(workspaces);
  const selected = selectVerifyRows(rows, opts);

  if (selected.length === 0) {
    console.error(`${RED}error:${RESET} no edges matched the given selector(s)`);
    process.exit(1);
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
  const { inventory, emitRows, STATUS } = await import("./lib/inventory.mjs");
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
  const { scanSkills, summarize, probeTranscripts, INSTALLER } = await import("./lib/skills-scan.mjs");
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
  const lc = await import("./lib/skills-lifecycle.mjs");
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
  const sc = await import("./lib/skills-create.mjs");
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
  const lc = await import("./lib/skills-lifecycle.mjs");
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
  const { probeTranscripts } = await import("./lib/skills-scan.mjs");
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
async function backlogCmd() {
  const { backlog } = await import("./lib/backlog.mjs");
  const result = backlog();

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`${BOLD}backlog${RESET} ${DIM}${result.generatedAt}${RESET}`);
  console.log(
    `  ${result.totals.stateFilesRead} STATE.md, ${result.totals.todoFilesRead} TODOS.md, ${result.totals.issueFilesRead} docs/ISSUES.md discovered`,
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

  console.log();
  console.log(`  ${BOLD}ranked (${result.ranked.length})${RESET}`);
  for (const item of result.ranked) {
    const pri = item.priority !== null && item.priority !== undefined ? `P${item.priority} ` : "";
    const loc = item.sources.length > 1 ? item.sources.map((s) => `${s.file}:${s.line}`).join(", ") : `${item.file}:${item.line}`;
    console.log(`    ${pri}${item.text}  ${DIM}${loc}${RESET}`);
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
if (_invokedDirectly) {
  const mode = process.argv[2] || "status";
  if (mode === "status") {
    await status();
  } else if (mode === "doctor") {
    await doctor();
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
  } else if (mode === "backlog") {
    await backlogCmd();
  } else {
    console.error(`unknown mode: ${mode}`);
    console.error("usage: node cli.mjs [status|doctor|init <dir> [--workspace|--edges-only]|reload|check [--changed|--range <a>..<b>|--staged] [--strict]|drain [--all] [--close <id>[,<id>...] --status <done|wontfix|partial> [--reason ...] [--notes ...] [--closed-by ...]] [--group <correlation_id> ...] [--json]|reconcile [--all] [--inbound] [--group-by glob|node|none] [--json]|verify (--edge <id>|--node <id>|--glob <pattern>) [--state <STATE>] --disposition <d> [--reason ...] [--apply] [--json]|bootstrap [--baseline-from-git|--baseline-all|--none] [--bound <n>] [--apply] [--json]|inventory [--json|--emit-rows]|skills [--json]|skills-create <name> <intent>|skills-promote <name>|skills-demote <name>|skills-reap [--apply]|backlog [--json]]");
    process.exit(2);
  }
}
