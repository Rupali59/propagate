#!/usr/bin/env node
/**
 * /propagate daily digest — the replacement for the cut web UI, and the
 * adoption probe that gates any future UI (docs/DECISIONS.md 2026-08-10,
 * "the local web UI is cut").
 *
 * Leads with the SINCE-LAST-RUN DIFF, not totals. A digest that restates
 * "95 open" every morning is the exact failure already demonstrated by
 * PROPAGATION_CROSS_LEDGER.md reading "Watcher healthy" for a month while
 * frozen. See docs/DECISIONS.md "renderMarkdown is idempotent" entry.
 *
 * Usage:
 *   node digest.mjs             — compute diff, deliver, persist new state
 *   node digest.mjs --dry-run   — print, write NO state
 *   node digest.mjs --stdout    — print instead of delivering
 *
 * Zero new npm deps. Imports lib/ primitives directly — does not shell out
 * to cli.mjs and screen-scrape its text output. A handful of pure, already-
 * tested helpers (heartbeatState, findDuplicateOpenAcrossLedgers,
 * parsePlistWatchPaths, expectedWatchPaths) are imported as named exports
 * from cli.mjs — that's a module import of pure functions, not a subprocess.
 */

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";

import {
  WORKSPACES,
  HEARTBEAT_PATH,
  DISCOVERY_DEGRADED,
  SUSPICIOUS_MARKERS,
  CROSS_LEDGER_JSONL,
  SEARCH_ROOTS,
  SKILL_DIR, INTEGRATIONS } from "./lib/core/config.mjs";
import { readLedgerWithStats, lastActivityAt } from "./lib/edges/ledger.mjs";
import { reconcile, inboundRows, toNodeId } from "./lib/edges/reconcile.mjs";
import { PLIST_PATH, heartbeatState } from "./lib/core/plist.mjs";
import { notify } from "./lib/report/notify.mjs";
import {
  findDuplicateOpenAcrossLedgers,
  parsePlistWatchPaths,
  expectedWatchPaths,
} from "./cli.mjs";
import { rebuildIndex, latestMtimeUnderDir } from "./lib/skills/index-db.mjs";
import { scanSkills, probeTranscripts } from "./lib/skills/skills-scan.mjs";
import { readMetricsRecords, evaluateExpectations } from "./lib/report/metrics.mjs";
import { inventory as buildInventory } from "./lib/report/inventory.mjs";
import { readSystemsTable, pickAdoptionAsk, formatAdoptionLines } from "./lib/report/adoption.mjs";
import { backlog as buildBacklog } from "./lib/report/backlog.mjs";
import {
  rollup as buildRollup,
  renderRollup as renderRollupBody,
  bodyHash as rollupBodyHash,
  parseFooter as parseRollupFooter,
  compareInputs as compareRollupInputs,
} from "./lib/report/rollup.mjs";
// `artifactPath()` only — never anything that writes. commands/rollup.mjs is
// the one file in this codebase allowed to call writeFileSync on
// ECOSYSTEM.md (its own header says so); importing its READ-ONLY path helper
// avoids a second, driftable copy of "SEARCH_ROOTS[0] + ARTIFACT_NAME" (the
// same two-ledger reasoning backlog.mjs:836-846 already gives for not
// copying an item between registers, one layer down at a single constant).
import { artifactPath as rollupArtifactPath } from "./commands/rollup.mjs";

const HOME = os.homedir();
const DIGEST_STATE_PATH = path.join(HOME, ".claude", "propagate-digest-state.json");
const DAILY_MD_PATH = path.join(HOME, ".claude", "DAILY.md");

// ─────────────────────────────────────────────────────────────────────────────
// Disk hygiene — measurement only, never deletion. `df` free space is the
// authoritative number; `du` sizes are apparent-size hints only (APFS clones
// mean du can wildly overstate what's actually reclaimable — see
// docs/DECISIONS.md and the digest task brief for the uv-cache measurement
// that proved this: du said -35.5 GiB, df moved ~2 GiB).
// ─────────────────────────────────────────────────────────────────────────────

// Was path.join(HOME, "Documents", "GitHub") — so the digest ignored
// PROPAGATE_SEARCH_ROOTS entirely and, on any other layout, discovered zero
// projects while reporting a healthy run.
const GITHUB_ROOT = SEARCH_ROOTS[0];
const DISK_DATA_VOLUME = "/System/Volumes/Data";
const DISK_BUDGET_MS = 25000;
const SIX_WEEKS_MS = 6 * 7 * 24 * 60 * 60 * 1000;
const KB_PER_GB = 1024 * 1024;

// Cross-platform caches first, then the macOS ~/Library ones. Every entry is
// existence-checked downstream, so a path that is wrong for the platform is
// harmless — but listing five ~/Library paths unconditionally made the disk
// section read as "nothing to reclaim" on Linux rather than "not applicable".
const CACHE_PATHS = [
  path.join(HOME, ".cache", "uv"),
  path.join(HOME, ".npm"),
  path.join(HOME, ".cache", "puppeteer"),
  path.join(HOME, ".bun"),
  ...(process.platform === "darwin"
    ? [
        path.join(HOME, "Library", "pnpm"),
        path.join(HOME, "Library", "Caches", "ms-playwright"),
        path.join(HOME, "Library", "Caches", "Homebrew"),
        path.join(HOME, "Library", "Caches", "pip"),
        path.join(HOME, "Library", "Caches", "go-build"),
      ]
    : [
        path.join(HOME, ".cache", "pnpm"),
        path.join(HOME, ".cache", "ms-playwright"),
        path.join(HOME, ".cache", "pip"),
        path.join(HOME, ".cache", "go-build"),
      ]),
];

/** `df -k <path>` -> { availKb, usedPct }, or null on any failure. */
function safeDf(target) {
  try {
    const out = execFileSync("df", ["-k", target], { encoding: "utf8", timeout: 5000 });
    const lines = out.trim().split("\n");
    const cols = lines[lines.length - 1].trim().split(/\s+/);
    const availKb = parseInt(cols[3], 10);
    const usedPct = parseInt(cols[4], 10); // "83%" -> 83
    if (!Number.isFinite(availKb) || !Number.isFinite(usedPct)) return null;
    return { availKb, usedPct };
  } catch {
    return null;
  }
}

/** `du -sk <path>` apparent size in KB, or null if missing/failed. Never throws. */
function safeDuKb(target) {
  if (!existsSync(target)) return null;
  try {
    const out = execFileSync("du", ["-sk", target], { encoding: "utf8", timeout: 10000 });
    const kb = parseInt(out.trim().split(/\s+/)[0], 10);
    return Number.isFinite(kb) ? kb : null;
  } catch {
    return null;
  }
}

/**
 * Newest mtime (ms) of any file under dir, skipping node_modules/.next/.git.
 * Null when the directory is missing; never throws.
 *
 * Was `find … -exec stat -f %m {} +`. `-f` is BSD stat; GNU spells it `-c %Y`, so the
 * whole pipeline threw on Linux and this returned null — indistinguishable from "no files
 * here". The digest then read as "nothing to report" rather than "could not measure",
 * which is the attributable-absence failure (G2). A pure walk also removes a spawn, which
 * is the measured cost in this codebase (G6), and survives a PATH without `find` at all.
 */
function safeNewestMtimeMs(dir, timeoutMs) {
  if (!existsSync(dir)) return null;
  const SKIP = new Set(["node_modules", ".next", ".git"]);
  const deadline = Date.now() + Math.max(500, timeoutMs || 0);
  let max = 0;
  const walk = (d, depth) => {
    if (depth > 6 || Date.now() > deadline) return;
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return; // unreadable subtree is not a reason to abandon the rest
    }
    for (const e of entries) {
      if (Date.now() > deadline) return;
      if (e.isDirectory()) {
        if (SKIP.has(e.name)) continue;
        walk(path.join(d, e.name), depth + 1);
      } else if (e.isFile()) {
        try {
          const m = statSync(path.join(d, e.name)).mtimeMs;
          if (m > max) max = m;
        } catch {
          // vanished between readdir and stat; skip it
        }
      }
    }
  };
  try {
    walk(dir, 0);
  } catch {
    return null;
  }
  return max > 0 ? max : null;
}

/** package.json dirs at depth<=3 under GITHUB_ROOT, excluding node_modules. Empty array on failure. */
function discoverProjectDirs() {
  try {
    const out = execFileSync(
      "find",
      [GITHUB_ROOT, "-maxdepth", "4", "-name", "package.json", "-not", "-path", "*/node_modules/*"],
      { encoding: "utf8", timeout: 5000 },
    );
    return out
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((p) => path.dirname(p));
  } catch {
    return [];
  }
}

/**
 * Disk hygiene snapshot: authoritative df free space, plus apparent-size
 * (du) hints for fixed cache paths and per-project node_modules/.next, plus
 * newest-source-file mtime for dormancy checks. Every measurement is
 * individually guarded; a missing path or slow du must never break the
 * digest. Total wall time is capped by DISK_BUDGET_MS — remaining
 * measurements are skipped (and `truncated: true` set) rather than let a
 * slow disk hang the only reporting channel that currently works.
 */
async function diskSnapshot(indexDb = null) {
  const start = Date.now();
  const result = {
    availKb: null,
    usedPct: null,
    caches: [],
    projects: [],
    truncated: false,
  };

  try {
    const df = safeDf(DISK_DATA_VOLUME);
    if (df) {
      result.availKb = df.availKb;
      result.usedPct = df.usedPct;
    }
  } catch {
    // safeDf already never throws; belt-and-suspenders.
  }

  for (const p of CACHE_PATHS) {
    if (Date.now() - start > DISK_BUDGET_MS) {
      result.truncated = true;
      break;
    }
    try {
      const kb = safeDuKb(p);
      if (kb !== null) result.caches.push({ path: p, apparentKb: kb });
    } catch {
      // ignore, per-path
    }
  }

  let projectDirs = [];
  try {
    projectDirs = discoverProjectDirs();
  } catch {
    projectDirs = [];
  }

  for (const dir of projectDirs) {
    if (Date.now() - start > DISK_BUDGET_MS) {
      result.truncated = true;
      break;
    }
    try {
      const nodeModulesKb = safeDuKb(path.join(dir, "node_modules"));
      const nextKb = safeDuKb(path.join(dir, ".next"));
      if (nodeModulesKb === null && nextKb === null) continue;
      // Reuse the propagate index's already-scanned STATE.md/DECISIONS.md/
      // ledger mtimes as a free "is this project active" signal, instead of
      // spending a `find -exec stat` walk (safeNewestMtimeMs) on every
      // project dir. This is what let the 25s budget blow past 10/29
      // projects on the first real run — see docs/DECISIONS.md "prevention
      // lives in the existing digest, not a new daemon". Only dirs with no
      // indexed file (no STATE.md/DECISIONS.md/ledger under them) fall back
      // to the real walk.
      const indexedMtime = indexDb ? latestMtimeUnderDir(indexDb, dir) : null;
      let newestSourceMs = indexedMtime ? new Date(indexedMtime).getTime() : null;
      if (newestSourceMs === null) {
        const budgetLeft = DISK_BUDGET_MS - (Date.now() - start);
        newestSourceMs = budgetLeft > 1000 ? safeNewestMtimeMs(dir, Math.min(4000, budgetLeft)) : null;
      }
      result.projects.push({ dir, nodeModulesKb, nextKb, newestSourceMs });
    } catch {
      // ignore, per-project
    }
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot — the current state of the world, built from lib/ primitives.
// Mirrors cli.mjs's statusJson() shape but is computed independently so this
// file never depends on cli.mjs's non-exported internals.
// ─────────────────────────────────────────────────────────────────────────────

async function watcherSnapshot() {
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
  return { heartbeatMs, ageSeconds, state: heartbeatState(ageSeconds) };
}

async function ledgerSnapshot(jsonlPath) {
  const exists = existsSync(jsonlPath);
  const { rows, malformed } = exists
    ? await readLedgerWithStats(jsonlPath)
    : { rows: [], malformed: 0 };
  const open = rows.filter((r) => r.status === "open");
  const done = rows.filter((r) => r.status === "done");
  const wontfix = rows.filter((r) => r.status === "wontfix");
  const lastActivityIso = exists ? await lastActivityAt(jsonlPath) : null;
  const quietDays = lastActivityIso
    ? Math.floor((Date.now() - new Date(lastActivityIso).getTime()) / (1000 * 60 * 60 * 24))
    : null;
  return {
    counts: { total: rows.length, open: open.length, done: done.length, wontfix: wontfix.length },
    malformed,
    quietDays,
    openRows: open.map((r) => ({
      id: r.id,
      source: r.source ?? null,
      downstreamCount: Array.isArray(r.downstream) ? r.downstream.length : 0,
    })),
  };
}

async function plistMismatch() {
  if (!existsSync(PLIST_PATH)) return { checked: false, mismatched: false, detail: "plist not installed" };
  let xml;
  try {
    xml = await readFile(PLIST_PATH, "utf8");
  } catch (err) {
    return { checked: false, mismatched: false, detail: `read failed: ${err.message}` };
  }
  const actual = new Set(parsePlistWatchPaths(xml));
  const expected = expectedWatchPaths(WORKSPACES);
  const missing = [...expected].filter((p) => !actual.has(p));
  const extra = [...actual].filter((p) => !expected.has(p));
  return { checked: true, mismatched: missing.length > 0 || extra.length > 0, missing, extra };
}

/**
 * `doctor`-recorded metrics (docs/OBSERVABILITY.md §6 step 1/step 4). Reads
 * metrics.jsonl (lib/metrics.mjs) rather than re-running doctor's checks —
 * digest is a delivery channel over what doctor already persisted, not a
 * second computation of the same numbers. `doctor` runs by hand or via
 * whatever wraps it; digest reports the newest record left since it last ran,
 * so a fast burst between `doctor` invocations is only visible the next
 * digest cycle (accepted latency — doctor remains the point-in-time check;
 * see docs/OBSERVABILITY.md §4/§6).
 */
async function metricsSnapshot() {
  let records;
  try {
    records = await readMetricsRecords();
  } catch (err) {
    return { available: false, error: String(err.message || err) };
  }
  if (records.length === 0) return { available: false, error: "no doctor runs recorded yet" };
  const latest = records[records.length - 1];
  const violations = evaluateExpectations(latest.metrics || {});
  return { available: true, latest, violations };
}

/**
 * Run reconcile() exactly ONCE for the whole digest (task constraint: both
 * the INBOUND section and the new DRIFT section derive from this single
 * call — never a second reconcile()). Never fatal: same belt-and-suspenders
 * as disk/skills/lifecycle above — a reconcile bug must not take down the
 * only reporting channel that currently works. On failure, both downstream
 * snapshots must say "status unknown", never render as "no drift" (G2).
 */
async function reconcileOnce() {
  try {
    const { rows } = await reconcile(WORKSPACES);
    return { available: true, rows };
  } catch (err) {
    return { available: false, error: String(err.message || err), rows: [] };
  }
}

/**
 * Inbound cross-repo drift, per workspace (2026-08 plan Part 2: "the digest
 * gains an inbound section"). A pure filter over the ONE shared reconcile()
 * call (`reconcileOnce()`, above) — lib/reconcile.mjs's `inboundRows`,
 * treating each discovered WORKSPACES root as the repo boundary, same as
 * `check`'s and `reconcile --inbound`'s CLI surfaces. Only DRIFTED/DIVERGED
 * edges are reported — an inbound edge that is still CLEAN or
 * NEVER_VERIFIED is not something to wake up to.
 *
 * Distinct from the existing cross-repo decision-relay layer (cross.mjs /
 * CROSS_LEDGER_JSONL, digest.mjs:335-ish) — that relays `flow: decision`
 * events; this is edge drift derived by reconcile(). Different problem,
 * different section, no overlap to dedupe (G20 doesn't apply — nothing here
 * restates a fact another section already reports).
 *
 * @param {{available: boolean, rows: object[], error?: string}} reconcileResult
 * @param {{root: string, name: string}[]} [workspaces] defaults to the real
 *   discovered WORKSPACES; overridable so tests can supply fake roots
 *   without touching real discovery.
 */
function inboundSnapshot(reconcileResult, workspaces = WORKSPACES) {
  if (!reconcileResult.available) return { available: false, error: reconcileResult.error };
  const rows = reconcileResult.rows;
  const byWorkspace = [];
  for (const ws of workspaces) {
    const drifted = inboundRows(rows, ws.root).filter((r) => r.state === "DRIFTED" || r.state === "DIVERGED");
    if (drifted.length === 0) continue;
    byWorkspace.push({
      name: ws.name,
      rows: drifted.map((r) => ({
        edge_id: r.edge_id,
        source: path.relative(ws.root, r.source.path),
        downstream: r.downstream.path ? path.relative(ws.root, r.downstream.path) : "(unmatched)",
        state: r.state,
      })),
    });
  }
  return { available: true, byWorkspace };
}

/**
 * The DRIFT section (watcher retirement: reconcile() replaces the v1
 * launchd watcher as the source of drift rows — see file header + task
 * brief). Partitions every DRIFTED/DIVERGED row from the SAME reconcile()
 * call `inboundSnapshot()` uses, so the digest never reports one edge in
 * two sections (G20):
 *
 *   - `sameRepo`  — `row.sameRepo === true`: both sides in one repo. This
 *     is the intra-repo drift the retired watcher used to write.
 *   - `outboundUnknown` — cross-repo (`sameRepo === false`) rows whose
 *     downstream is NOT under any discovered WORKSPACES root, i.e. exactly
 *     the complement of what `inboundSnapshot()` reports. A cross-repo row
 *     inbound to a known workspace belongs to INBOUND, not here — computed
 *     by re-running the identical `inboundRows()` filter used there and
 *     excluding whatever it matches, so the two sections can never overlap
 *     and no row can fall through either (G2: absence must be
 *     attributable, not silent).
 *
 * Together, INBOUND + DRIFT.sameRepo + DRIFT.outboundUnknown is exhaustive
 * over every DRIFTED/DIVERGED row — asserted directly in
 * tests/digest-drift.test.mjs.
 *
 * @param {{available: boolean, rows: object[], error?: string}} reconcileResult
 * @param {{root: string, name: string}[]} [workspaces] defaults to the real
 *   discovered WORKSPACES; overridable so tests can supply fake roots
 *   without touching real discovery. Must be the SAME list passed to
 *   `inboundSnapshot()` for the same reconcile run, or the partition
 *   invariant (INBOUND + DRIFT exhaustive, no overlap) does not hold.
 */
function driftSnapshot(reconcileResult, workspaces = WORKSPACES) {
  if (!reconcileResult.available) return { available: false, error: reconcileResult.error };
  const rows = reconcileResult.rows;
  const driftRows = rows.filter((r) => r.state === "DRIFTED" || r.state === "DIVERGED");
  const sameRepoRows = driftRows.filter((r) => r.sameRepo === true);
  const crossRepoRows = driftRows.filter((r) => r.sameRepo === false);

  // Everything in crossRepoRows that ANY known workspace already claims as
  // inbound — the exact set INBOUND reports. Whatever's left is the gap.
  const inboundEdgeIds = new Set();
  for (const ws of workspaces) {
    for (const r of inboundRows(crossRepoRows, ws.root)) inboundEdgeIds.add(r.edge_id);
  }
  const outboundUnknownRows = crossRepoRows.filter((r) => !inboundEdgeIds.has(r.edge_id));

  const formatRow = (r) => ({
    edge_id: r.edge_id,
    source: r.node_id,
    downstream: r.downstream.path ? toNodeId(r.downstream.path) : "(unmatched)",
    state: r.state,
  });

  return {
    available: true,
    total: driftRows.length,
    sameRepo: sameRepoRows.map(formatRow),
    outboundUnknown: outboundUnknownRows.map(formatRow),
  };
}

/**
 * Build the full snapshot the digest diffs against. Not the same object as
 * cli.mjs's statusJson() — computed independently from lib/ primitives.
 */
async function buildSnapshot(indexDb = null, { dryRun = false } = {}) {
  const watcher = await watcherSnapshot();
  const workspaces = [];
  const ledgerEntries = [];
  for (const ws of WORKSPACES) {
    const block = await ledgerSnapshot(ws.ledgerJsonl);
    workspaces.push({ name: ws.name, root: ws.root, ledgerJsonl: ws.ledgerJsonl, ...block });
    ledgerEntries.push({
      workspaceRoot: ws.root,
      ledgerPath: ws.ledgerJsonl,
      rows: [...block.openRows.map((r) => ({ status: "open", source: r.source }))],
    });
  }
  const crossBlock = await ledgerSnapshot(CROSS_LEDGER_JSONL);
  const cross = { name: "cross", root: SEARCH_ROOTS[0], ledgerJsonl: CROSS_LEDGER_JSONL, ...crossBlock };

  const duplicateOpenAcrossLedgers = findDuplicateOpenAcrossLedgers(ledgerEntries);
  const plist = await plistMismatch();

  let disk;
  try {
    disk = await diskSnapshot(indexDb);
  } catch (err) {
    // diskSnapshot() already guards every individual measurement; this is
    // the outermost belt-and-suspenders so a disk-hygiene bug can never take
    // down the only reporting channel that currently works.
    disk = { availKb: null, usedPct: null, caches: [], projects: [], truncated: true, error: String(err.message || err) };
  }

  let skills;
  try {
    skills = skillsSnapshot(indexDb);
  } catch (err) {
    // Same belt-and-suspenders as disk: a skills bug must never take down the
    // only reporting channel that currently works.
    skills = { available: false, error: String(err.message || err) };
  }

  let lifecycle;
  try {
    lifecycle = await lifecycleSweep(dryRun);
  } catch (err) {
    lifecycle = { available: false, error: String(err.message || err) };
  }

  const metrics = await metricsSnapshot();
  // ONE reconcile() call, shared by INBOUND and DRIFT (task constraint — see
  // reconcileOnce()'s doc comment). Neither downstream snapshot re-derives it.
  const reconcileResult = await reconcileOnce();
  const inbound = inboundSnapshot(reconcileResult);
  const drift = driftSnapshot(reconcileResult);

  // Walked ONCE here, shared by the digest's own INVENTORY section below AND
  // by the ecosystem rollup further down (rollup.mjs's own doc comment:
  // "pass that existing result into rollup() rather than walking a second
  // time — rollup({searchRoots, backlogResult, inventoryResult}) accepts
  // pre-computed results for exactly this reason"). A throw here is
  // swallowed to `null` rather than caught-and-reported directly: each of
  // the two consumers below (inventorySnapshot(), rollupSnapshot()) falls
  // back to re-deriving on its own and reports ITS OWN failure independently
  // — one walk failing must not silently make the OTHER section look like
  // "zero items" instead of "could not measure" (G2).
  let invRawResult = null;
  try {
    invRawResult = buildInventory();
  } catch {
    invRawResult = null;
  }

  let inv;
  try {
    inv = inventorySnapshot(invRawResult);
  } catch (err) {
    // Same belt-and-suspenders as disk/skills/lifecycle above: a bug in the
    // self-adoption probe must never take down the only reporting channel
    // that currently works.
    inv = { available: false, error: String(err.message || err) };
  }

  let adoption;
  try {
    adoption = adoptionSnapshot();
  } catch (err) {
    // Same belt-and-suspenders as disk/skills/lifecycle/inventory above: a
    // bug in the adoption trigger must never take down the only reporting
    // channel that currently works.
    adoption = { available: false, error: String(err.message || err) };
  }

  // backlog() has no other caller in this file (unlike inventory() above,
  // which the INVENTORY section already needed) — walked here solely for
  // rollup(). Still computed once and threaded through, per the same
  // "pre-computed results" contract, so a future second consumer of backlog
  // data in this file does not reintroduce a duplicate walk by accident.
  let backlogRawResult = null;
  try {
    backlogRawResult = buildBacklog({ searchRoots: SEARCH_ROOTS });
  } catch {
    backlogRawResult = null;
  }

  let roll;
  try {
    roll = rollupSnapshot({ backlogResult: backlogRawResult, inventoryResult: invRawResult });
  } catch (err) {
    // Same belt-and-suspenders as disk/skills/lifecycle/inventory/adoption
    // above: a bug in the ecosystem rollup must never take down the only
    // reporting channel that currently works.
    roll = { available: false, error: String(err.message || err) };
  }

  return {
    generatedAt: new Date().toISOString(),
    degraded: DISCOVERY_DEGRADED,
    suspiciousMarkers: SUSPICIOUS_MARKERS,
    watcher,
    workspaces,
    cross,
    duplicateOpenAcrossLedgers,
    plist,
    disk,
    skills,
    lifecycle,
    metrics,
    inbound,
    drift,
    inventory: inv,
    adoption,
    rollup: roll,
  };
}

/**
 * The one unattended mutation in this whole system: reap quarantined skills
 * that neither probe has ever seen and that are past the age threshold.
 *
 * Reaping runs here rather than in a detector because it is the half of
 * auto-creation that is genuinely safe — it only ever touches the quarantine
 * tier, it archives to a tarball before deleting, it keeps the skill if the
 * archive fails, and the kill switch stops it. Creation is explicit instead;
 * see lib/skills-create.mjs for the measurement that decided that.
 */
async function lifecycleSweep(dryRun = false) {
  const lc = await import("./lib/skills/skills-lifecycle.mjs");
  const { probeTranscripts } = await import("./lib/skills/skills-scan.mjs");
  const { quarantined, promoted } = lc.scanLifecycle({ transcripts: probeTranscripts().byName });
  const ready = lc.promotable(quarantined);
  const candidates = lc.reapable(quarantined);
  // apply:!dryRun. reap() also refuses when disarmed and archives before
  // deleting, but those are inner guards; this is the one that makes the
  // documented "--dry-run — write NO state" promise true. It was false until
  // 2026-08-14: dryRun lived only in runDigest and gated state-writing and
  // delivery, so a "preview" ran an armed deletion. Nothing was lost (zero
  // skills were reapable when it was found) — see docs/GOTCHAS.md G22.
  const reaped = candidates.length
    ? await lc.reap(candidates, { apply: !dryRun })
    : { applied: false, planned: [], done: [] };
  return {
    available: true,
    disarmed: lc.isDisarmed(),
    quarantined: quarantined.length,
    promoted: promoted.length,
    readyToPromote: ready.map((s) => ({ name: s.name, uses: Math.max(s.usageCount, s.transcriptCount) })),
    reaped: (reaped.done || []).filter((d) => d.removed).map((d) => d.id),
    reapBlocked: reaped.reason === "disarmed" ? reaped.planned.map((p) => p.id) : [],
    // Named separately from reapBlocked so a preview never reads as a kill
    // switch firing — two different reasons for the same absence (G2).
    reapPreviewOnly: dryRun ? (reaped.planned || []).map((p) => p.id) : [],
  };
}

/**
 * Skill inventory for the digest, read from the already-rebuilt index rather
 * than re-scanning. Returns available:false when the index has no skill rows
 * (e.g. a rebuild that ran without the opt-in sweep) so the formatter can stay
 * silent instead of reporting a confident zero.
 */
function skillsSnapshot(indexDb) {
  if (!indexDb) return { available: false, error: "no index" };
  const row = indexDb
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(never_invoked) AS never_invoked,
              SUM(CASE WHEN dangling = 1 THEN 1 ELSE 0 END) AS dangling,
              SUM(CASE WHEN usage_count = 0 AND transcript_count > 0 THEN 1 ELSE 0 END) AS disagreement
       FROM skill`,
    )
    .get();
  if (!row || !row.total) return { available: false, error: "no skill rows" };
  const ids = indexDb.prepare(`SELECT id FROM skill ORDER BY id`).all().map((r) => r.id);
  return {
    available: true,
    total: row.total,
    neverInvoked: Number(row.never_invoked ?? 0),
    dangling: Number(row.dangling ?? 0),
    disagreement: Number(row.disagreement ?? 0),
    ids,
  };
}

/**
 * The self-adoption probe (lib/inventory.mjs) -- skills/plugins/repos/
 * standalone artifacts, classified with evidence. Read-only, same
 * belt-and-suspenders contract as skillsSnapshot()/lifecycleSweep() above:
 * a bug in the inventory probe must never take down the only reporting
 * channel that currently works (buildSnapshot() also wraps this call site).
 *
 * This is the probe's self-adoption answer: if the inventory tool itself
 * goes unused, its own digest section — driven by the same appeared/
 * disappeared diffing as SKILLS below — reports nothing changed and, after
 * enough quiet days, that silence is itself visible in the quiet-day line.
 *
 * Accepts an optional pre-computed `inv` (from `buildInventory()`) so
 * `buildSnapshot()` can walk once and share the result with `rollupSnapshot()`
 * below — falls back to walking itself when called with no argument (every
 * existing test and every other caller of this function).
 */
function inventorySnapshot(inv) {
  inv = inv ?? buildInventory();
  const ids = [];
  for (const items of Object.values(inv.categories)) {
    for (const item of items) ids.push({ id: item.id, status: item.status });
  }
  return {
    available: true,
    generatedAt: inv.generatedAt,
    counts: inv.counts,
    ids,
    droppedCount: inv.dropped.length,
    budgetExceeded: inv.budgetExceeded,
  };
}

/**
 * The adoption trigger (task brief Component 1; lib/adoption.mjs has the
 * full rationale). Read-only over `docs/SYSTEMS.md`; picks at most ONE row
 * to ask about, deterministically, from the table's current content -- no
 * new state store (G20). Wrapped in the same belt-and-suspenders try/catch
 * as skills/lifecycle/inventory above: a bug here must never take down the
 * only reporting channel that currently works.
 */
function adoptionSnapshot() {
  const { rows, error } = readSystemsTable();
  if (error) return { available: false, error };
  const ask = pickAdoptionAsk(rows);
  return { available: true, ask };
}

/**
 * Mirrors `commands/rollup.mjs`'s `detectHandEdit` test EXACTLY — recompute
 * the on-disk body hash via the SAME `bodyHash` function `renderRollup`
 * itself uses to write the footer, and compare it to the footer's stored
 * `body:` field. That function is not exported (this lane does not touch
 * `commands/`, per the plan's build sequence: Lane C owns that file), so the
 * three-way test is restated here against the same imported primitives
 * (`parseFooter`, `bodyHash`) rather than re-derived a second, subtly
 * different way. If `commands/rollup.mjs`'s test ever changes, this one must
 * change with it by hand — there is no shared call site to keep the two
 * honest beyond both importing the same `lib/report/rollup.mjs` functions.
 */
function rollupIsHandEdited(existingText) {
  const parsed = parseRollupFooter(existingText);
  if (parsed === null || parsed.malformed) return true;
  const actualFull = rollupBodyHash(existingText);
  if (actualFull === null) return true;
  return actualFull.slice(0, 12) !== parsed.body;
}

/**
 * The ecosystem rollup — "what have we built, what is open" across the
 * whole tree, via `lib/report/rollup.mjs`'s `rollup()`. Read-only, same
 * belt-and-suspenders contract as disk/skills/lifecycle/inventory/adoption
 * above: this function is free to throw; `buildSnapshot()`'s own try/catch
 * around the call site is what keeps a bug here from taking down the only
 * reporting channel that currently works.
 *
 * *** THE CONSTRAINT THAT MATTERS MOST IN THIS WHOLE SLOT, STATED HERE
 * BECAUSE THIS IS WHERE SOMEONE WOULD "HELPFULLY" BREAK IT: this function
 * calls `rollup()` and `renderRollup()` to DERIVE the current state of the
 * tree, in memory, so it can compare that derivation against whatever is
 * ALREADY on disk. It never calls `writeFileSync` and never regenerates
 * `ECOSYSTEM.md`. If it did, the comparison below would become a check that
 * cannot fail — the file it just wrote would always match a fresh
 * derivation, because it IS that derivation, computed moments earlier. That
 * is the exact failure this file's own header was written about ("reading
 * 'Watcher healthy' for a month while frozen"), one layer up. `commands/
 * rollup.mjs` is the only file in this codebase permitted to write
 * ECOSYSTEM.md — see its own header — and the "helpful" auto-regenerate
 * refactor that collapses the two is a two-line change someone will propose
 * within a month of reading this comment. Don't make it.
 *
 * Computes TWO independent facts about the tree, because they answer two
 * different questions and one can be true while the other is false for
 * weeks at a time (plan: "Two independent diffs, both needed"):
 *
 *   (a) `fileStale` / `handEdited` — is `ECOSYSTEM.md`, as it sits ON DISK
 *       RIGHT NOW, current against a fresh derivation? Re-read and
 *       re-compared EVERY digest run (never cached), because a human can
 *       run `propagate rollup` between one digest run and the next and this
 *       function must see that the moment it happens, not a day later.
 *       `fileStale` is true when the file is absent, hand-edited, OR its
 *       stored input hashes disagree with a fresh derivation — the same
 *       three "not safe to trust" cases `propagate rollup --check` treats
 *       as non-current.
 *   (b) the input-transition slot computed separately in `computeDiff`
 *       (`inputsChanged`/`inputsAppeared`/`inputsVanished`/
 *       `becameUnreadable`) — has anything changed in the TREE's inputs
 *       since the LAST DIGEST RUN, independent of whether `ECOSYSTEM.md`
 *       has ever been generated at all. (a) can be true for weeks (nobody
 *       ran `propagate rollup`) while (b) is empty (nothing has moved since
 *       yesterday's digest) — see the file header for why the digest leads
 *       with diffs, never restated totals.
 *
 * Accepts pre-computed `backlogResult`/`inventoryResult` so a caller that
 * already walked the tree (this file's own `buildSnapshot()`, which already
 * calls `inventory()` for the INVENTORY section) does not pay for a second
 * walk — `rollup({searchRoots, backlogResult, inventoryResult})` exists in
 * `lib/report/rollup.mjs` for exactly this.
 */
function rollupSnapshot({ backlogResult, inventoryResult } = {}) {
  const result = buildRollup({ searchRoots: SEARCH_ROOTS, backlogResult, inventoryResult });
  const rendered = renderRollupBody(result);
  const fullBodyHash = rollupBodyHash(rendered);
  const currentInputs = result.inputs; // Map<shortPath, sha12|"ABSENT"|"UNREADABLE:...">

  const artifact = rollupArtifactPath();
  let artifactExists = false;
  let handEdited = false;
  let fileStale = true; // absent == stale, same reading `rollup --check` gives an ungenerated file

  if (artifact && existsSync(artifact)) {
    artifactExists = true;
    let existingText = null;
    try {
      existingText = readFileSync(artifact, "utf8");
    } catch {
      // Unreadable existing file: treat like hand-edited/foreign rather than
      // throwing this whole snapshot away over one stat-then-read race.
      handEdited = true;
      fileStale = true;
    }
    if (existingText !== null) {
      handEdited = rollupIsHandEdited(existingText);
      if (handEdited) {
        fileStale = true;
      } else {
        const parsed = parseRollupFooter(existingText);
        const storedInputs = parsed && !parsed.malformed ? parsed.inputs : new Map();
        const diff = compareRollupInputs(storedInputs, currentInputs);
        fileStale =
          diff.changed.length > 0 ||
          diff.appeared.length > 0 ||
          diff.vanished.length > 0 ||
          diff.becameUnreadable.length > 0;
      }
    }
  }

  return {
    available: true,
    // Short (12-hex) to match the footer's own `body:` field and
    // toStateRollup's lean-prior discipline below — never the full 64-hex,
    // never the rendered body itself.
    bodyHash: fullBodyHash ? fullBodyHash.slice(0, 12) : null,
    inputs: Object.fromEntries(currentInputs),
    artifactExists,
    handEdited,
    fileStale,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Digest-state persistence — a lean prior snapshot (open row ids + a few
// fields per row) sufficient to compute the diff. Atomic write via
// temp+rename, matching lib/state.mjs's pattern.
// ─────────────────────────────────────────────────────────────────────────────

function toStateWorkspace(ws) {
  return {
    total: ws.counts.total,
    open: ws.counts.open,
    done: ws.counts.done,
    wontfix: ws.counts.wontfix,
    openRows: ws.openRows.map((r) => ({ id: r.id, source: r.source, downstreamCount: r.downstreamCount })),
  };
}

/** Lean prior-skills record: the id set plus the alarm counters, so the next
 *  run can diff appearances/disappearances instead of restating the inventory. */
function toStateSkills(skills) {
  if (!skills || !skills.available) return null;
  return {
    total: skills.total,
    ids: skills.ids,
    dangling: skills.dangling,
    disagreement: skills.disagreement,
  };
}

/** Lean prior-disk record: apparent sizes only, keyed by path — enough to diff, not re-derive. */
function toStateDisk(disk) {
  if (!disk) return null;
  const caches = {};
  for (const c of disk.caches) caches[c.path] = c.apparentKb;
  const projects = {};
  for (const p of disk.projects) projects[p.dir] = { nodeModulesKb: p.nodeModulesKb, nextKb: p.nextKb };
  return { availKb: disk.availKb, usedPct: disk.usedPct, caches, projects };
}

/** Lean prior-metrics record: the last-seen run's metrics values + run_id, so
 *  the next digest can diff "changed since we last reported" without
 *  re-reading every record between the two digest runs. */
function toStateMetrics(metrics) {
  if (!metrics || !metrics.available) return null;
  return { runId: metrics.latest.run_id, ts: metrics.latest.ts, values: metrics.latest.metrics };
}

/** Lean prior-inventory record: id -> status map, plus the standing counts,
 *  enough to diff appearances/disappearances/status-transitions without
 *  restating the full evidence strings (those are re-derived fresh each run
 *  from lib/inventory.mjs, never carried in state). */
function toStateInventory(inv) {
  if (!inv || !inv.available) return null;
  const statusById = {};
  for (const { id, status } of inv.ids) statusById[id] = status;
  return { counts: inv.counts, statusById };
}

/**
 * Lean prior-rollup record: ONLY the body hash and the per-input hash map —
 * never the rendered `ECOSYSTEM.md` Markdown body itself. Same discipline as
 * `toStateInventory` above not carrying inventory's evidence strings: the
 * body can run to hundreds of KB across a growing tree, and the whole point
 * of this record is that `compareInputs()` (a pure hash comparison) can
 * re-derive everything the next digest needs from it — the body text itself
 * is neither read nor needed for that comparison, so keeping it here would
 * be pure bloat on `~/.claude/propagate-digest-state.json`, growing forever,
 * for zero downstream benefit.
 */
function toStateRollup(roll) {
  if (!roll || !roll.available) return null;
  return { bodyHash: roll.bodyHash, inputs: roll.inputs };
}

function snapshotToDigestState(snapshot) {
  const workspaces = {};
  for (const ws of snapshot.workspaces) workspaces[ws.name] = toStateWorkspace(ws);
  return {
    version: 1,
    lastRunAt: snapshot.generatedAt,
    workspaces,
    cross: toStateWorkspace(snapshot.cross),
    disk: toStateDisk(snapshot.disk),
    skills: toStateSkills(snapshot.skills),
    metrics: toStateMetrics(snapshot.metrics),
    inventory: toStateInventory(snapshot.inventory),
    rollup: toStateRollup(snapshot.rollup),
  };
}

export async function readDigestState(statePath = DIGEST_STATE_PATH) {
  if (!existsSync(statePath)) return null;
  try {
    const raw = await readFile(statePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.workspaces) return parsed;
    return null;
  } catch {
    return null;
  }
}

export async function writeDigestState(state, statePath = DIGEST_STATE_PATH) {
  await mkdir(path.dirname(statePath), { recursive: true });
  const tmp = `${statePath}.tmp.${process.pid}`;
  await writeFile(tmp, JSON.stringify(state, null, 2));
  await rename(tmp, statePath);
}

// ─────────────────────────────────────────────────────────────────────────────
// Diff — the core logic. Pure function of (snapshot, priorDigestState) so it
// is directly unit-testable without touching real ledgers.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} snapshot from buildSnapshot()
 * @param {object|null} prior from readDigestState() — null on first run
 * @returns {object} diff report, consumed by formatDigest()
 */
export function computeDiff(snapshot, prior) {
  const broken = [];

  // v1 watcher retired 2026-08-14 (docs/DECISIONS.md) — heartbeat staleness
  // is no longer a failure signal. Reporting it as `broken` here would mean
  // this digest complains forever about a component that is *supposed* to be
  // gone (the task brief's "do not leave a line that will read dead
  // forever"). `snapshot.watcher` is kept only as informational history (see
  // formatDigest's watcherLine); the fact that CAN now fail is whether the
  // replacement — reconcile(), shared by the DRIFT/INBOUND sections below —
  // actually completed. `snapshot.drift` is undefined in older/synthetic
  // snapshots (tests), so absence is treated as "not measured", not broken.
  const reconcileAvailable = snapshot.drift ? snapshot.drift.available !== false : true;
  if (!reconcileAvailable) {
    broken.push({
      kind: "reconcile",
      detail: `reconcile() did not complete — the v1 watcher's replacement: ${snapshot.drift.error || "unknown error"}`,
    });
  }
  if (snapshot.degraded) {
    broken.push({ kind: "discovery", detail: "DISCOVERY_DEGRADED — markers seen but zero workspaces resolved" });
  }
  if (snapshot.suspiciousMarkers && snapshot.suspiciousMarkers.length > 0) {
    for (const m of snapshot.suspiciousMarkers) {
      broken.push({ kind: "suspiciousMarker", detail: `${m.path}: ${m.reason}` });
    }
  }
  if (snapshot.plist.checked && snapshot.plist.mismatched) {
    broken.push({
      kind: "plist",
      detail: `WatchPaths drifted from discovered workspaces (missing: ${snapshot.plist.missing.length}, extra: ${snapshot.plist.extra.length})`,
    });
  }
  const allLedgers = [...snapshot.workspaces, snapshot.cross];
  for (const ws of allLedgers) {
    if (ws.malformed > 0) {
      broken.push({ kind: "malformedLedgerLines", detail: `${ws.name}: ${ws.malformed} malformed line(s)` });
    }
  }
  if (snapshot.duplicateOpenAcrossLedgers.count > 0) {
    broken.push({
      kind: "duplicateOpenAcrossLedgers",
      detail: `${snapshot.duplicateOpenAcrossLedgers.count} source(s) open in more than one ledger`,
    });
  }
  // docs/OBSERVABILITY.md §6 step 4: expectation violations recorded by the
  // most recent `doctor` run are delivered here, not re-derived — digest
  // reports what doctor already asserted and persisted (lib/metrics.mjs).
  if (snapshot.metrics?.available) {
    for (const v of snapshot.metrics.violations) {
      broken.push({ kind: "metricExpectation", detail: `${v.describe} — observed ${JSON.stringify(v.observed)}` });
    }
  }

  const firstRun = prior === null;
  const newByWorkspace = [];
  const closedByWorkspace = [];

  if (!firstRun) {
    for (const ws of allLedgers) {
      const priorWs = ws.name === "cross" ? prior.cross : prior.workspaces?.[ws.name];
      const priorOpenIds = new Set((priorWs?.openRows ?? []).map((r) => r.id));
      const currentOpenIds = new Set(ws.openRows.map((r) => r.id));

      const newRows = ws.openRows.filter((r) => !priorOpenIds.has(r.id));
      if (newRows.length > 0) newByWorkspace.push({ name: ws.name, rows: newRows });

      const closedRows = (priorWs?.openRows ?? []).filter((r) => !currentOpenIds.has(r.id));
      if (closedRows.length > 0) closedByWorkspace.push({ name: ws.name, rows: closedRows });
    }
  }

  const totals = {
    open: allLedgers.reduce((sum, ws) => sum + ws.counts.open, 0),
    workspaces: snapshot.workspaces.length,
  };

  // ── Disk hygiene ──────────────────────────────────────────────────────────
  // Emit lines ONLY when a threshold trips (see formatDigest's quiet-day
  // suppression, which now also gates on diskLines being empty). Critical
  // low space routes through `broken` — the channel that already escalates
  // to the macOS notification, per the digest task's constraint not to build
  // a second escalation path.
  const diskLines = [];
  if (snapshot.disk) {
    const d = snapshot.disk;
    const priorDisk = prior?.disk ?? null;

    if (typeof d.availKb === "number") {
      const availGb = d.availKb / KB_PER_GB;
      if (availGb < 30) {
        broken.push({ kind: "diskCritical", detail: `disk free ${availGb.toFixed(1)} GiB (df) — below 30 GiB` });
      } else if (availGb < 60) {
        diskLines.push(`WARN: disk free ${availGb.toFixed(1)} GiB (df) — below 60 GiB threshold`);
        if (priorDisk) {
          const deltas = [];
          for (const c of d.caches) {
            const priorKb = priorDisk.caches?.[c.path];
            if (typeof priorKb === "number") deltas.push({ label: c.path, deltaGb: (c.apparentKb - priorKb) / KB_PER_GB });
          }
          for (const p of d.projects) {
            const priorP = priorDisk.projects?.[p.dir];
            if (priorP) {
              const priorTotal = (priorP.nodeModulesKb || 0) + (priorP.nextKb || 0);
              const curTotal = (p.nodeModulesKb || 0) + (p.nextKb || 0);
              deltas.push({ label: p.dir, deltaGb: (curTotal - priorTotal) / KB_PER_GB });
            }
          }
          const top3 = deltas
            .filter((x) => x.deltaGb > 0)
            .sort((a, b) => b.deltaGb - a.deltaGb)
            .slice(0, 3);
          for (const t of top3) diskLines.push(`  top growth: ${t.label} +${t.deltaGb.toFixed(1)} GiB (apparent, du)`);
        }
      }
    }

    // Any single cache that grew >5 GiB apparent since last run — independent of the availGb bands above.
    if (priorDisk) {
      for (const c of d.caches) {
        const priorKb = priorDisk.caches?.[c.path];
        if (typeof priorKb === "number") {
          const deltaGb = (c.apparentKb - priorKb) / KB_PER_GB;
          if (deltaGb > 5) diskLines.push(`GROWTH: ${c.path} grew ${deltaGb.toFixed(1)} GiB (apparent, du) since last run`);
        }
      }
    }

    // Dormant project still holding a heavy node_modules — report, never delete.
    const now = Date.now();
    for (const p of d.projects) {
      const nmKb = p.nodeModulesKb || 0;
      if (nmKb > 200 * 1024 && p.newestSourceMs && now - p.newestSourceMs > SIX_WEEKS_MS) {
        const idleDays = Math.floor((now - p.newestSourceMs) / (24 * 60 * 60 * 1000));
        diskLines.push(`prunable: ${p.dir} — node_modules ${(nmKb / KB_PER_GB).toFixed(1)} GiB (apparent, du), idle ${idleDays}d`);
      }
    }

    if (d.truncated) diskLines.push("(disk measurement truncated — time budget exceeded, partial data above)");
  }

  const hasChange = newByWorkspace.length > 0 || closedByWorkspace.length > 0;

  // ── Doctor-recorded metrics ─────────────────────────────────────────────
  // Diff-only, same reasoning as disk/skills: a block restating "12 open, 3
  // sidecars loaded" every morning is wallpaper within a week — the exact
  // failure this whole file exists to avoid (see file header). Report what
  // CHANGED since the last digest, not the standing numbers.
  const metricLines = [];
  if (snapshot.metrics?.available) {
    const priorMetrics = prior?.metrics ?? null;
    const currentValues = snapshot.metrics.latest.metrics || {};
    if (priorMetrics && priorMetrics.values) {
      if (priorMetrics.runId === snapshot.metrics.latest.run_id) {
        // Same doctor run already reported last digest cycle — nothing new
        // to say, so say nothing (not "0 change" wallpaper).
      } else {
        for (const key of Object.keys(currentValues)) {
          const before = priorMetrics.values[key];
          const after = currentValues[key];
          if (typeof before === "number" && typeof after === "number" && before !== after) {
            const sign = after > before ? "+" : "";
            metricLines.push(`${key}: ${before} -> ${after} (${sign}${after - before})`);
          }
        }
      }
    } else if (!firstRun) {
      // Metrics recording came online since the last digest with no prior
      // baseline to diff against — state that once, the same way the skills
      // block states its first inventory once.
      metricLines.push(`doctor metrics online: run ${snapshot.metrics.latest.run_id}, ${Object.keys(currentValues).length} keys`);
    }
  } else if (snapshot.metrics?.error && !firstRun && prior?.metrics) {
    // Metrics WAS available last digest and is not now — the R6 vanished-
    // signal case, one level up: the whole store, not just a key.
    metricLines.push(`!! doctor metrics no longer available: ${snapshot.metrics.error}`);
  }

  // ── Skills ────────────────────────────────────────────────────────────
  // Diff-only, for the same reason disk is threshold-only: a block that
  // restates "92 skills, 36 never invoked" every morning is wallpaper within a
  // week, which is precisely how PROPAGATION_CROSS_LEDGER.md came to read
  // "Watcher healthy" for a month. Report what CHANGED.
  const skillLines = [];
  const sk = snapshot.skills;
  const priorSk = prior?.skills ?? null;
  if (sk?.available) {
    if (priorSk && Array.isArray(priorSk.ids)) {
      const before = new Set(priorSk.ids);
      const after = new Set(sk.ids);
      const added = sk.ids.filter((id) => !before.has(id));
      const removed = priorSk.ids.filter((id) => !after.has(id));
      if (added.length) skillLines.push(`+${added.length} appeared: ${added.slice(0, 6).join(", ")}${added.length > 6 ? ` (+${added.length - 6} more)` : ""}`);
      if (removed.length) skillLines.push(`-${removed.length} removed: ${removed.slice(0, 6).join(", ")}${removed.length > 6 ? ` (+${removed.length - 6} more)` : ""}`);
      // Alarms fire on transition, not on persistence, so a known-and-accepted
      // dangling symlink does not nag daily.
      if (sk.dangling !== priorSk.dangling && sk.dangling > 0) {
        skillLines.push(`${sk.dangling} dangling SKILL.md symlink(s)`);
      }
      if (sk.disagreement > 0 && sk.disagreement !== priorSk.disagreement) {
        skillLines.push(`!! ${sk.disagreement} skill(s) in transcripts but absent from skillUsage — the primary liveness probe has lost events`);
      }
    } else if (!firstRun) {
      // Index gained skill rows for the first time; state the baseline once.
      skillLines.push(`inventory online: ${sk.total} skills, ${sk.neverInvoked} never invoked`);
    }
  }

  // ── Inventory (self-adoption probe) ─────────────────────────────────────
  // Diff-only, same reasoning as SKILLS immediately above and the file
  // header's founding lesson: a section that reprints "175 items, 34 never
  // invoked" every morning becomes furniture. Reports status TRANSITIONS
  // (new dormant items, items that became active), not standing totals —
  // this is also the self-adoption answer for lib/inventory.mjs itself: if
  // nothing about the inventory changes for weeks, this section says
  // nothing for weeks, and that silence is legitimate signal rather than a
  // reason to keep restating a total nobody re-reads.
  const inventoryLines = [];
  const invSnap = snapshot.inventory;
  const priorInv = prior?.inventory ?? null;
  if (invSnap?.available) {
    if (priorInv && priorInv.statusById) {
      const beforeIds = new Set(Object.keys(priorInv.statusById));
      const afterIds = new Set(invSnap.ids.map((r) => r.id));

      const appeared = invSnap.ids.filter((r) => !beforeIds.has(r.id));
      const disappeared = [...beforeIds].filter((id) => !afterIds.has(id));
      const transitioned = invSnap.ids.filter(
        (r) => beforeIds.has(r.id) && priorInv.statusById[r.id] !== r.status,
      );

      if (appeared.length) {
        const dormantAppeared = appeared.filter((r) => r.status === "dormant" || r.status === "installed-never-invoked");
        if (dormantAppeared.length) {
          inventoryLines.push(
            `+${dormantAppeared.length} new dormant/never-invoked: ${dormantAppeared.slice(0, 6).map((r) => r.id).join(", ")}${dormantAppeared.length > 6 ? ` (+${dormantAppeared.length - 6} more)` : ""}`,
          );
        }
        const otherAppeared = appeared.length - dormantAppeared.length;
        if (otherAppeared > 0) inventoryLines.push(`+${otherAppeared} other new item(s)`);
      }
      if (disappeared.length) {
        inventoryLines.push(`-${disappeared.length} removed: ${disappeared.slice(0, 6).join(", ")}${disappeared.length > 6 ? ` (+${disappeared.length - 6} more)` : ""}`);
      }
      for (const r of transitioned.slice(0, 10)) {
        inventoryLines.push(`${r.id}: ${priorInv.statusById[r.id]} -> ${r.status}`);
      }
      if (transitioned.length > 10) inventoryLines.push(`  (+${transitioned.length - 10} more transitions)`);
    } else if (!firstRun) {
      // Probe came online since the last digest with no prior baseline —
      // state that once, same idiom as the skills/metrics baseline lines.
      inventoryLines.push(`inventory online: ${invSnap.counts.total} items across skills/plugins/repos/standalone`);
    }
    if (invSnap.budgetExceeded) {
      inventoryLines.push(`!! repo walk time budget exceeded — inventory is partial this run`);
    }
  } else if (invSnap?.error && !firstRun && prior?.inventory) {
    // Vanished-signal case (R6): the whole probe failed, not just a value
    // within it.
    inventoryLines.push(`!! inventory probe unavailable: ${invSnap.error}`);
  }

  // Lifecycle events are always worth a line — they are actions the system took
  // or is waiting on, not standing facts, so they cannot become wallpaper.
  const lc = snapshot.lifecycle;
  if (lc?.available) {
    for (const r of lc.readyToPromote) {
      skillLines.push(`ready to promote: quarantine:${r.name} (${r.uses} uses) — \`propagate skills-promote ${r.name}\``);
    }
    for (const id of lc.reaped) skillLines.push(`reaped ${id} — unused past the age threshold, archived first`);
    if (lc.reapBlocked.length) {
      skillLines.push(`DISARMED: would have reaped ${lc.reapBlocked.join(", ")} (rm ~/.claude/skills-registry.off to re-arm)`);
    }
  }

  // ── Inbound cross-repo drift ────────────────────────────────────────────
  // State-based, not diff-based — same shape as `broken`, not the
  // appeared/disappeared diffing skills/metrics use. An inbound edge that
  // drifted yesterday and is still drifted today is still the fact a person
  // in that repo needs on their way to touching it; suppressing it after
  // the first mention would be exactly the "reads healthy while actually
  // frozen" failure this whole file exists to avoid (see file header).
  // Renders nothing when the list is empty — a section that always prints
  // becomes furniture (plan Part 2).
  const inboundLines = [];
  if (snapshot.inbound?.available) {
    for (const ws of snapshot.inbound.byWorkspace) {
      for (const r of ws.rows) {
        inboundLines.push(`${ws.name}: ${r.source} → ${r.downstream}   ${r.state}`);
      }
    }
  } else if (snapshot.inbound?.error && !firstRun) {
    // Vanished-signal case (R6), one level up: the whole computation, not
    // just a value within it.
    inboundLines.push(`!! inbound reconciliation unavailable: ${snapshot.inbound.error}`);
  }

  // ── Drift (watcher retirement) ──────────────────────────────────────────
  // State-based, same shape as INBOUND directly above — a DRIFTED edge is
  // still the fact someone needs on the way to touching that file, whether
  // it drifted yesterday or five minutes ago. Renders nothing when empty
  // (plan/task constraint) and participates in the quiet-day collapse below.
  // Partition discipline (G20): every row here is EITHER same-repo OR
  // cross-repo-but-outside-any-known-workspace — never a row already
  // reported by INBOUND above. See driftSnapshot()'s doc comment.
  const driftLines = [];
  if (snapshot.drift?.available) {
    for (const r of snapshot.drift.sameRepo) {
      driftLines.push(`${r.source} → ${r.downstream}   ${r.state}`);
    }
    for (const r of snapshot.drift.outboundUnknown) {
      driftLines.push(`outbound — downstream outside any known workspace: ${r.source} → ${r.downstream}   ${r.state}`);
    }
  } else if (snapshot.drift?.error && !firstRun) {
    // Vanished-signal case (R6): reconcile() failed, so drift status is
    // UNKNOWN — never rendered as "no drift" (G2).
    driftLines.push(`!! drift reconciliation unavailable: ${snapshot.drift.error}`);
  }

  // ── Adoption trigger (task brief Component 1) ──────────────────────────
  // State-based, like INBOUND/DRIFT above, not diff-based: a genuine open
  // question ("earned it? retire it? not yet?") is still the fact someone
  // needs on their way past this digest, whether it first appeared today or
  // a week ago -- suppressing it after one mention would defeat the entire
  // point of building a trigger for a taboo that has never once been
  // exercised (lib/adoption.mjs header). Renders zero lines when there is
  // nothing to ask (task constraint: silence, never an empty section).
  const adoptionLines = [];
  if (snapshot.adoption?.available) {
    if (snapshot.adoption.ask) adoptionLines.push(...formatAdoptionLines(snapshot.adoption.ask));
  } else if (snapshot.adoption?.error && !firstRun) {
    // Vanished-signal case (R6): the probe failed outright, never rendered
    // as "nothing to ask" (G2).
    adoptionLines.push(`!! adoption trigger unavailable: ${snapshot.adoption.error}`);
  }

  // ── Ecosystem rollup (Phase 1 Task E) ───────────────────────────────────
  // Two INDEPENDENT facts, computed and rendered together because they
  // share one section but must never be collapsed into one boolean — see
  // rollupSnapshot()'s doc comment for the full argument:
  //
  //   (a) fileStale / handEdited / artifactExists — STATE-based, like
  //       INBOUND/DRIFT/ADOPTION above, not diff-based: whether ECOSYSTEM.md
  //       is currently trustworthy is a fact about right now, not about what
  //       changed since yesterday's digest, so it renders every run it is
  //       true, never only on the day it became true. Read straight off the
  //       snapshot (computed against the live file at snapshot time,
  //       PURELY-COMPUTED-FROM-HERE-ON in this function) — this function
  //       itself never touches a filesystem, keeping computeDiff pure.
  //   (b) inputsChanged / inputsAppeared / inputsVanished / becameUnreadable
  //       — DIFF-based, same idiom as SKILLS/METRICS/INVENTORY above:
  //       last digest's stored `rollup.inputs` (this file's own lean prior,
  //       `toStateRollup`) vs the current snapshot's, via the SAME
  //       `compareInputs()` `commands/rollup.mjs --check` uses — never a
  //       second, hand-rolled diff. Suppressed on firstRun (no prior to
  //       diff against, same as every other diff-based section); a single
  //       "online" line the first time a prior digest state exists but
  //       carries no `rollup` key yet (this feature shipped after that
  //       state file was written) — same idiom as the skills/metrics/
  //       inventory "online" lines above, never a full false-appeared dump
  //       of every tracked input on the day this feature is deployed.
  //
  // `+` (appeared) is the transition an mtime-based design could never
  // report at all (nothing to compare a NEW file's timestamp against).
  // `!` (becameUnreadable) is the one a naive design reports as "unchanged"
  // (a file that goes from readable to EACCES has no later mtime to notice).
  const ecosystemLines = [];
  let inputsChanged = [];
  let inputsAppeared = [];
  let inputsVanished = [];
  let becameUnreadable = [];
  let fileStale = null; // null == unknown (rollup unavailable), never "false"
  let handEdited = null;

  if (snapshot.rollup?.available) {
    fileStale = snapshot.rollup.fileStale;
    handEdited = snapshot.rollup.handEdited;

    if (!snapshot.rollup.artifactExists) {
      ecosystemLines.push("ECOSYSTEM.md does not exist yet — `propagate rollup` to generate it.");
    } else if (handEdited) {
      ecosystemLines.push(
        "ECOSYSTEM.md was hand-edited since it was last generated — `propagate rollup --force` to discard and regenerate.",
      );
    } else if (fileStale) {
      ecosystemLines.push(
        "ECOSYSTEM.md is stale — the tree has moved since it was last generated. `propagate rollup` to refresh.",
      );
    }

    const priorRollup = prior?.rollup ?? null;
    if (priorRollup && priorRollup.inputs) {
      const priorInputs = new Map(Object.entries(priorRollup.inputs));
      const currentInputs = new Map(Object.entries(snapshot.rollup.inputs || {}));
      const cmp = compareRollupInputs(priorInputs, currentInputs);
      inputsChanged = cmp.changed;
      inputsAppeared = cmp.appeared;
      inputsVanished = cmp.vanished;
      becameUnreadable = cmp.becameUnreadable;

      // No leading indentation baked in here — formatDigest adds exactly one
      // level of indent uniformly to every ecosystemLines entry, same as
      // diskLines/skillLines/adoptionLines. Baking a second indent in here
      // would double it for these lines only.
      for (const { key, after } of inputsAppeared) ecosystemLines.push(`+ ${key} (${after})`);
      for (const { key, before } of inputsVanished) ecosystemLines.push(`- ${key} (was ${before})`);
      for (const { key, before, after } of inputsChanged) ecosystemLines.push(`~ ${key} (${before} -> ${after})`);
      for (const { key, before, after } of becameUnreadable) {
        ecosystemLines.push(`! ${key} became unreadable (${before} -> ${after})`);
      }
    } else if (!firstRun) {
      ecosystemLines.push(
        `ecosystem rollup online: ${Object.keys(snapshot.rollup.inputs || {}).length} tracked input(s)`,
      );
    }
  } else if (snapshot.rollup?.error && !firstRun) {
    // Vanished-signal / outright-failure case, same shape as INBOUND/DRIFT
    // above: reported every run it is true, never collapsed into silence
    // (G2) and never rendered as "ECOSYSTEM.md is fine" (fileStale/
    // handEdited stay `null` — unknown — rather than `false`, per
    // rule:discernment-checks §2/§6: absence must be attributable, and a
    // reader that cannot report ITS OWN failure must not report absence
    // instead).
    ecosystemLines.push(`!! ecosystem rollup unavailable: ${snapshot.rollup.error}`);
  }

  return {
    firstRun,
    broken,
    newByWorkspace,
    closedByWorkspace,
    totals,
    // Kept only as informational history — v1 watcher retired 2026-08-14, see
    // the `broken` computation above. Nothing downstream should treat
    // `watcher.state` as a health signal anymore; `reconcile` is.
    watcher: snapshot.watcher,
    reconcile: { available: reconcileAvailable, error: snapshot.drift?.error ?? null },
    hasChange,
    diskLines,
    skillLines,
    metricLines,
    inboundLines,
    driftLines,
    inventoryLines,
    adoptionLines,
    ecosystemLines,
    // Raw, structured rollup-diff fields, exposed alongside the rendered
    // `ecosystemLines` above so a test can assert on the classification
    // directly (per-transition) rather than only on rendered text — same
    // reason `newByWorkspace`/`closedByWorkspace` are exposed as structured
    // data next to the rendered NEW DRIFT / CLOSED sections.
    inputsChanged,
    inputsAppeared,
    inputsVanished,
    becameUnreadable,
    fileStale,
    handEdited,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatting — WHAT CHANGED leads; totals trail as a one-line footer.
// ─────────────────────────────────────────────────────────────────────────────

export function formatDigest(diff) {
  const lines = [];
  // v1 watcher retired 2026-08-14 — this line reports the retirement plus the
  // replacement's health (reconcile completion) instead of a heartbeat age
  // that would otherwise climb forever and read as "dead" (task brief).
  const watcherLine = `watcher: retired (v2 reconcile ${diff.reconcile.available ? "ok" : "FAILED"})`;

  const diskLines = diff.diskLines || [];
  const skillLines = diff.skillLines || [];
  const metricLines = diff.metricLines || [];
  const inboundLines = diff.inboundLines || [];
  const driftLines = diff.driftLines || [];
  const inventoryLines = diff.inventoryLines || [];
  const adoptionLines = diff.adoptionLines || [];
  const ecosystemLines = diff.ecosystemLines || [];

  if (
    diff.broken.length === 0 &&
    !diff.firstRun &&
    !diff.hasChange &&
    diskLines.length === 0 &&
    skillLines.length === 0 &&
    metricLines.length === 0 &&
    inboundLines.length === 0 &&
    driftLines.length === 0 &&
    inventoryLines.length === 0 &&
    adoptionLines.length === 0 &&
    ecosystemLines.length === 0
  ) {
    // Quiet day. One short line, not a full report. Disk hygiene prints ZERO
    // lines here too, on purpose — see digest.mjs disk-hygiene section: a
    // digest that restates disk facts every day is the same wallpaper
    // failure mode the whole file is built to avoid.
    lines.push(`propagate: no change, ${watcherLine}, ${diff.totals.open} open`);
    return lines.join("\n");
  }

  lines.push(`propagate digest — ${new Date().toISOString()}`);
  lines.push("");

  if (diff.firstRun) {
    lines.push(
      `FIRST RUN — no prior digest state, nothing to diff against. ` +
        `Currently ${diff.totals.open} open across ${diff.totals.workspaces} workspace(s). ` +
        `This run establishes the baseline; tomorrow's digest will show what changed.`,
    );
    lines.push("");
  }

  if (diff.broken.length > 0) {
    lines.push(`BROKEN (${diff.broken.length}):`);
    for (const b of diff.broken) lines.push(`  ✗ [${b.kind}] ${b.detail}`);
    lines.push("");
  }

  if (diskLines.length > 0) {
    lines.push(`DISK:`);
    for (const l of diskLines) lines.push(`  ${l}`);
    lines.push("");
  }

  if (skillLines.length > 0) {
    lines.push(`SKILLS:`);
    for (const l of skillLines) lines.push(`  ${l}`);
    lines.push("");
  }

  if (inventoryLines.length > 0) {
    lines.push(`INVENTORY (self-adoption probe) — changed since last run:`);
    for (const l of inventoryLines) lines.push(`  ${l}`);
    lines.push("");
  }

  if (adoptionLines.length > 0) {
    lines.push(`ADOPTION — one question (docs/SYSTEMS.md):`);
    for (const l of adoptionLines) lines.push(`  ${l}`);
    lines.push("");
  }

  // ECOSYSTEM — the rollup section (Phase 1 Task E). `ecosystemLines` is
  // already fully rendered by computeDiff() above (the "+ appeared / -
  // vanished / ~ changed / ! became-unreadable" glyphs and the
  // stale/hand-edited state lines) — this block only decides WHETHER a
  // section header wraps them, same shape as every section above it.
  // Emitted only when non-empty: a header with nothing under it would be
  // exactly the wallpaper this whole file exists to avoid.
  if (ecosystemLines.length > 0) {
    lines.push(`ECOSYSTEM — ECOSYSTEM.md rollup:`);
    for (const l of ecosystemLines) lines.push(`  ${l}`);
    lines.push("");
  }

  if (metricLines.length > 0) {
    lines.push(`METRICS (doctor):`);
    for (const l of metricLines) lines.push(`  ${l}`);
    lines.push("");
  }

  if (inboundLines.length > 0) {
    lines.push(`INBOUND (${inboundLines.length}) — cross-repo edges pointing at your workspaces, drifted or diverged:`);
    for (const l of inboundLines) lines.push(`  ${l}`);
    lines.push("");
  }

  if (driftLines.length > 0) {
    lines.push(`DRIFT (${driftLines.length}) — reconciled edges that moved since last verified:`);
    for (const l of driftLines) lines.push(`  ${l}`);
    lines.push("");
  }

  if (diff.newByWorkspace.length > 0) {
    const totalNew = diff.newByWorkspace.reduce((s, w) => s + w.rows.length, 0);
    lines.push(`NEW DRIFT (${totalNew}):`);
    for (const w of diff.newByWorkspace) {
      lines.push(`  ${w.name}:`);
      for (const r of w.rows) {
        lines.push(`    + ${r.source ?? "(no source)"}  [downstream: ${r.downstreamCount}]`);
      }
    }
    lines.push("");
  }

  if (diff.closedByWorkspace.length > 0) {
    const totalClosed = diff.closedByWorkspace.reduce((s, w) => s + w.rows.length, 0);
    lines.push(`CLOSED (${totalClosed}):`);
    for (const w of diff.closedByWorkspace) {
      lines.push(`  ${w.name}:`);
      for (const r of w.rows) {
        lines.push(`    ✓ ${r.source ?? "(no source)"}`);
      }
    }
    lines.push("");
  }

  if (!diff.firstRun && diff.newByWorkspace.length === 0 && diff.closedByWorkspace.length === 0) {
    lines.push("(no new or closed rows since last run)");
    lines.push("");
  }

  lines.push(`— ${diff.totals.open} open across ${diff.totals.workspaces} workspace(s), ${watcherLine}`);

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Delivery — pluggable so the channel can change without touching diff logic.
// Preference order: telegram skill's non-interactive send path (if it
// exposes one) > DAILY.md append (newest first) + macOS notification.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Look for a usable non-interactive send script inside the telegram skill.
 * Returns a delivery function or null if the skill / a send path isn't
 * available. Kept separate from the fallback so the "which channel" choice
 * is explicit and testable.
 */
async function resolveTelegramDelivery() {
  // INTEGRATIONS.telegramDir, not a path rebuilt from HOME: the integration already
  // existed for exactly this, and rebuilding it here meant PROPAGATE_TELEGRAM_DIR
  // configured the value nobody read.
  const skillDir = INTEGRATIONS.telegramDir;
  if (!skillDir) return null;
  if (!existsSync(skillDir)) return null;
  const skillMdPath = path.join(skillDir, "SKILL.md");
  if (!existsSync(skillMdPath)) return null;
  // No SKILL.md / no skill directory found on this machine as of writing —
  // deferred until the skill exists. If it later ships a scriptable send
  // path, wire it here rather than reaching for it ad hoc at digest time.
  return null;
}

async function deliverViaDailyMdAndNotify(text) {
  const stamp = new Date().toISOString();
  const entry = `## ${stamp}\n\n${text}\n`;
  let existing = "";
  if (existsSync(DAILY_MD_PATH)) {
    existing = await readFile(DAILY_MD_PATH, "utf8");
  }
  const updated = existing.length > 0 ? `${entry}\n---\n\n${existing}` : entry;
  await mkdir(path.dirname(DAILY_MD_PATH), { recursive: true });
  const tmp = `${DAILY_MD_PATH}.tmp.${process.pid}`;
  await writeFile(tmp, updated, "utf8");
  await rename(tmp, DAILY_MD_PATH);

  const firstLine = text.split("\n").find((l) => l.trim().length > 0) || "propagate digest";
  await notify("propagate digest", firstLine.slice(0, 200));
}

/**
 * Choose and run delivery. Returns the channel name used, for reporting.
 */
async function deliverDigest(text) {
  const telegram = await resolveTelegramDelivery();
  if (telegram) {
    await telegram(text);
    return "telegram";
  }
  await deliverViaDailyMdAndNotify(text);
  return "daily.md+notify";
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

/** Rebuild the propagate index at the start of the run — read-only over the
 * corpus, well under a second (see lib/index-db.mjs). Its source_file table
 * then lets diskSnapshot() skip a `find` walk for every project dir that
 * already has an indexed STATE.md/DECISIONS.md/ledger. Never fatal: a
 * rebuild failure just means diskSnapshot() falls back to its own walk. */
async function rebuildIndexForDigest() {
  const dbPath = path.join(SKILL_DIR, "index.db");
  try {
    const result = rebuildIndex({ dbPath, roots: SEARCH_ROOTS, skillDir: SKILL_DIR, scanSkillsFn: scanSkills, probeTranscriptsFn: probeTranscripts });
    process.stderr.write(
      `[propagate-digest] index rebuilt in ${result.timingsMs.total}ms (${result.counts.ledger_row} ledger rows, ${result.counts.decision} decisions)\n`,
    );
    return result.db;
  } catch (err) {
    process.stderr.write(`[propagate-digest] index rebuild failed (non-fatal): ${err.message}\n`);
    return null;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const stdoutOnly = args.includes("--stdout");

  // --install generates the plist FILE and stops. Loading it is a separate,
  // deliberate step -- touching launchd is a one-way door and stays the
  // human's, per SKILL.md's contract. Same pattern as `monitor --install`.
  if (args.includes("--install")) {
    const { writeDigestPlist, DIGEST_LABEL } = await import("./lib/core/plist.mjs");
    const res = await writeDigestPlist();
    console.log(`wrote ${res.path}`);
    console.log(`\nNot loaded. To arm it:`);
    console.log(`  launchctl bootstrap gui/$(id -u) ${JSON.stringify(res.path)}`);
    console.log(`To disarm:`);
    console.log(`  launchctl bootout gui/$(id -u)/${DIGEST_LABEL}`);
    return;
  }

  const indexDb = await rebuildIndexForDigest();
  try {
    await runDigest({ dryRun, stdoutOnly, indexDb });
  } finally {
    if (indexDb) indexDb.close();
  }
}

async function runDigest({ dryRun, stdoutOnly, indexDb }) {
  const snapshot = await buildSnapshot(indexDb, { dryRun });
  const prior = dryRun ? await readDigestState() : await readDigestState();
  const diff = computeDiff(snapshot, prior);
  const text = formatDigest(diff);

  if (stdoutOnly || dryRun) {
    console.log(text);
  }

  if (!dryRun) {
    if (!stdoutOnly) {
      const channel = await deliverDigest(text);
      process.stderr.write(`[propagate-digest] delivered via ${channel}\n`);
    }
    await writeDigestState(snapshotToDigestState(snapshot));
  }
}

const _invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (_invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`[propagate-digest] fatal: ${err.stack || err.message}\n`);
    process.exit(1);
  });
}

export {
  buildSnapshot,
  deliverDigest,
  DIGEST_STATE_PATH,
  DAILY_MD_PATH,
  snapshotToDigestState as snapshotToDigestStateForTest,
  inboundSnapshot as inboundSnapshotForTest,
  driftSnapshot as driftSnapshotForTest,
  inventorySnapshot as inventorySnapshotForTest,
  adoptionSnapshot as adoptionSnapshotForTest,
  rollupSnapshot as rollupSnapshotForTest,
  safeNewestMtimeMs as safeNewestMtimeMsForTest,
};
