#!/usr/bin/env node
/**
 * ⚠️ RETIRED 2026-08-14 — see docs/DECISIONS.md 2026-08-14 ("the v1 watcher
 * is retired"). Do NOT re-enable this file's launchd plist, and do not run
 * it by hand, without reading that entry in full first.
 *
 * Why: measured 4,420 runs / 4,384 no-ops (99.2% found nothing), and its
 * state.json mtime baseline caused two incidents in one day (a state wipe
 * that fired ~120 spurious drift rows, and plist overwrites — see
 * docs/GOTCHAS.md G10/G11/G13). `reconcile` (lib/reconcile.mjs, on demand),
 * `check` (the pre-push gate), and the daily digest's DRIFT/INBOUND sections
 * derive drift from content instead of remembering it, and now replace this
 * file's coverage in production. The one thing genuinely lost by retiring
 * this file is sub-daily proactive notification — reconcile/check/digest are
 * on-demand or once-a-day, not a ~60s background fire. See the DECISIONS.md
 * entry for the full tradeoff.
 *
 * This file stays on disk as history and as the reference for what v1 did —
 * it is not deleted. Its exported functions (processCrossRepo,
 * __setCrossPathsForTest, etc.) are still imported directly by several
 * tests (grep `from "../watcher.mjs"` under tests/) and that import path is
 * unaffected. Only running it as a script (`node watcher.mjs`) is blocked —
 * see the refusal at the bottom of this file.
 *
 * ---------------------------------------------------------------------------
 * Original v1 doc comment, preserved for reference:
 *
 * Propagation watcher — invoked by launchd WatchPaths when files in
 * monitored directories change. Stateless across invocations (state lives
 * in state.json).
 *
 * Flow per invocation:
 *   1. Acquire lock (skip if held → next change re-triggers)
 *   2. For each workspace, scan WatchDirs for files with .propagates.yml
 *      sibling sidecars
 *   3. For each file whose mtime advanced since last run AND that appears
 *      as a `source:` in a sidecar:
 *        a. Re-verify mtime after a 3s sleep (atomic-replace race guard)
 *        b. Look up downstreams in sidecar
 *        c. Append a `drift` row to PROPAGATION_LEDGER.jsonl
 *        d. Re-render PROPAGATION_LEDGER.md
 *        e. Update state.json with new mtime
 *   4. osascript notification + heartbeat
 *   5. Release lock
 *
 * Errors are caught and logged. The watcher exits 0 even on failure so
 * launchd doesn't backoff/disable the agent.
 */

import { readdir, stat, appendFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync, globSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  WORKSPACES,
  STATE_PATH,
  LOCK_PATH,
  HEARTBEAT_PATH,
  WATCHER_LOG,
  MTIME_REVERIFY_DELAY_MS,
  SKILL_DIR,
  SEARCH_ROOTS,
  CROSS_LEDGER_JSONL,
  CROSS_LEDGER_MD,
} from "./lib/config.mjs";
import { loadCodeCanonicalSync } from "./lib/code-canonical.mjs";
import { readState, writeState, detectMtimeChange, pruneMtimes, pruneCrossDecisions } from "./lib/state.mjs";
import { parseDecisions } from "./lib/decisions.mjs";
import { CROSS_TRIGGER_EPOCH } from "./lib/config.mjs";
import { acquireLock } from "./lib/lock.mjs";
import {
  loadSidecar,
  findSidecarFor,
  downstreamsFor,
  SidecarError,
} from "./lib/frontmatter.mjs";
import {
  enumerateDeclaredSources,
  synthesizeKindCodeEntries,
} from "./lib/edges.mjs";
import {
  appendRowWithId,
  hasOpenDuplicateDrift,
  renderMarkdown,
} from "./lib/ledger.mjs";
import {
  loadCrossRepoSync,
  discoverCrossReposSync,
  resolveTarget,
  crossCorrelationId,
  resolvePartner,
} from "./lib/cross-repo.mjs";
import { notify, heartbeat } from "./lib/notify.mjs";
import {
  enumerateWorktrees,
  expandWorktreePaths,
  worktreeStamp,
  correlationKey,
} from "./lib/worktrees.mjs";
import { getGitContext } from "./lib/git-context.mjs";

const FILE_BASENAMES_OF_INTEREST = (basename) =>
  basename === "CLAUDE.md" ||
  basename.endsWith(".md");

async function log(line) {
  try {
    await appendFile(WATCHER_LOG, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* ignore */
  }
}

/** Walk a directory, return absolute paths of candidate files (one level). */
async function listCandidates(dir) {
  if (!existsSync(dir)) return [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && FILE_BASENAMES_OF_INTEREST(e.name))
    .map((e) => path.join(dir, e.name));
}

export async function processChange(workspace, filePath, state, worktreeMap) {
  const newMtime = await detectMtimeChange(STATE_PATH, filePath, state);
  if (newMtime === null) return null;

  // Race guard: wait, then re-check mtime to detect mid-edit reads.
  await sleep(MTIME_REVERIFY_DELAY_MS);
  let stillStable = true;
  try {
    const s = await stat(filePath);
    if (s.mtimeMs !== newMtime) {
      // Another save happened during the window; let the next launchd fire handle it.
      stillStable = false;
    }
  } catch {
    stillStable = false;
  }
  if (!stillStable) {
    await log(`skip (still being edited): ${filePath}`);
    return null;
  }

  const sidecarPath = findSidecarFor(filePath, workspace.root);
  if (!sidecarPath) {
    // No sidecar covers this file. Still update mtime so we don't replay.
    state.mtimes[filePath] = newMtime;
    return null;
  }

  let sidecar;
  try {
    sidecar = await loadSidecar(sidecarPath);
  } catch (err) {
    if (err instanceof SidecarError) {
      await log(`sidecar error: ${err.message}`);
      // Still update mtime — don't replay forever on a broken sidecar.
      state.mtimes[filePath] = newMtime;
      return { sidecarError: err.message };
    }
    throw err;
  }

  const sourceKey = path.relative(path.dirname(sidecarPath), filePath);
  const downstreams = downstreamsFor(sidecar, sourceKey);
  state.mtimes[filePath] = newMtime;

  if (downstreams.length === 0) {
    // File is watched but isn't declared as a propagation source. No-op.
    return null;
  }

  // Resolve downstream paths. Asymmetric worktree handling (2026-06-09):
  // expand via worktree map but KEEP ONLY THE CANONICAL WORKTREE in the
  // downstream list. Secondary worktrees are dropped to avoid the N×M
  // ghost-row class — every canonical-doc edit was firing N downstream
  // rows per worktree, and rows referencing a pruned worktree path
  // (e.g. VipinKaushik-location-shape/) became permanently-open ghosts.
  //
  // Pre-merge edits in secondary worktrees still surface via
  // processCodeCanonical (source-side: drift fires from the worktree
  // path with source_worktree.branch annotation). Coverage is preserved;
  // we just don't multiply downstream rows.
  const resolvedDownstreams = [];
  const sidecarDir = path.dirname(sidecarPath);
  for (const d of downstreams) {
    const kind = d.kind || "prose";
    // Glob downstream (e.g. `style/pages/**/*.md`): fs-expand relative to the
    // sidecar dir. Store ONE summary entry (glob + match count + sample) rather
    // than fanning out to N rows — keeps the row/notification readable. 0 matches
    // → warn and skip (never push the literal glob string as a "path").
    if (/[*?[\]]/.test(d.path)) {
      let matches = [];
      try {
        matches = globSync(d.path, { cwd: sidecarDir }).filter((m) => !m.includes("node_modules/"));
      } catch (err) {
        await log(`glob downstream error: ${d.path} (${err.message})`);
      }
      if (matches.length === 0) {
        await log(`glob downstream matched 0 files: ${d.path} (from ${sourceKey})`);
        continue;
      }
      resolvedDownstreams.push({
        path: d.path,
        why: d.why,
        kind,
        glob_matched: matches.length,
        sample: matches.slice(0, 10),
      });
      continue;
    }
    const declaredAbs = path.resolve(sidecarDir, d.path);
    const allExpansions = expandWorktreePaths(declaredAbs, worktreeMap);
    const expansions = allExpansions.filter(
      (e) => !e.worktree || e.worktree.isCanonical,
    );
    if (expansions.length === 0) {
      // No on-disk match in canonical worktrees — fall back to recording
      // the canonical declaration so drain still surfaces it.
      resolvedDownstreams.push({ path: d.path, why: d.why, kind });
      continue;
    }
    for (const exp of expansions) {
      const entry = {
        path:
          expansions.length === 1 && exp.path === declaredAbs
            ? d.path
            : exp.path,
        why: d.why,
        kind,
      };
      // Canonical worktree gets no `worktree` stamp (back-compat).
      // Secondary worktrees never appear here (filtered out above).
      resolvedDownstreams.push(entry);
    }
  }

  const sourceRel = path.relative(workspace.root, filePath);
  // Append-time dedup: don't re-log identical drift on every mtime bump.
  const dsPaths = resolvedDownstreams.map((d) => d.path);
  if (await hasOpenDuplicateDrift(workspace.ledgerJsonl, sourceRel, dsPaths)) {
    await log(`drift deduped: ${sourceRel} (identical open row already exists)`);
    return { deduped: true, sourceRel };
  }
  const change = `auto-detected edit (mtime advanced)`;
  const corrId = correlationKey(filePath, worktreeMap);
  const { context: gitContext, error: gitError } = getGitContext(filePath);
  if (gitError) await log(gitError);

  const row = {
    type: "drift",
    source: sourceRel,
    change,
    downstream: resolvedDownstreams,
    status: "open",
    pending_graph_augment: resolvedDownstreams.some((d) => d.kind === "code"),
  };
  if (corrId) row.correlation_id = corrId;
  if (gitContext) row.git = gitContext;

  const id = await appendRowWithId(workspace.ledgerJsonl, row);

  await log(`drift logged: ${sourceRel} -> ${resolvedDownstreams.length} downstream`);
  return { id, sourceRel, count: resolvedDownstreams.length };
}

/**
 * Code-canonical scan — bidirectional drift detection, worktree-aware.
 *
 * `upstreams` is an ARRAY of `{upstreamDoc, upstreamSection, note}` — one
 * codePath can be coupled to multiple docs (declared in both
 * `.code-canonical.yml` and a `.propagates.yml` `kind: code` edge, or
 * pointing at two docs). Callers group entries by codePath BEFORE calling
 * this (G3 — eng-review): merging here, one row per codePath, keeps a
 * changed code file from firing N rows or cross-suppressing when the same
 * file is declared more than once.
 *
 * For codePath, expand the canonical code path to all worktree-equivalents
 * via `expandWorktreePaths`. For each worktree whose copy of the file
 * changed, fire ONE `code_drift` row whose `downstream[]` lists every
 * upstream doc to verify (the row's `source` includes the worktree's path
 * so drain can locate the actual edit; `correlation_id` groups all
 * worktree-copies of the same logical file so drain dedupes the
 * upstream-verification prompt).
 *
 * Dedup is `state.mtimes` mtime-advance (per file) + the caller's grouping
 * by codePath — NOT `hasOpenDuplicateDrift` (eng-review F2: that helper
 * filters `type === "drift"` only and ignores `code_drift`, so it was never
 * applicable here). Consequence (correct, not a bug): after a drain
 * (`status_change -> done`), a subsequent real edit of the code file
 * re-fires — the doc genuinely needs re-verification after each code
 * change.
 *
 * Bootstrap behaviour: on first-observation of a sibling-worktree path
 * (state.mtimes[filePath] === undefined AND the worktree is NOT canonical),
 * we record the mtime silently and skip the row. Without this, deploying
 * the worktree-aware watcher floods the ledger with one row per
 * sibling-worktree file on first fire (S2 — bootstrap seed).
 */
export async function processCodeCanonical(workspace, codePath, upstreams, state, worktreeMap) {
  // De-dup upstream docs — a codePath can arrive here with the same doc
  // declared twice (e.g. present in both .code-canonical.yml AND a
  // kind:code sidecar edge). One downstream entry per doc, not per
  // declaration.
  const seenDocs = new Map();
  for (const u of upstreams) {
    if (u && u.upstreamDoc && !seenDocs.has(u.upstreamDoc)) seenDocs.set(u.upstreamDoc, u);
  }
  const uniqueUpstreams = [...seenDocs.values()];
  if (uniqueUpstreams.length === 0) return null;

  const canonicalAbs = path.resolve(workspace.root, codePath);
  const expansions = expandWorktreePaths(canonicalAbs, worktreeMap);
  if (expansions.length === 0) {
    // Canonical doesn't exist and no worktree has the file — nothing to do.
    return null;
  }

  const results = [];
  for (const exp of expansions) {
    const filePath = exp.path;
    const isBootstrap = state.mtimes[filePath] === undefined;

    const newMtime = await detectMtimeChange(STATE_PATH, filePath, state);
    if (newMtime === null) continue;

    // Race guard.
    await sleep(MTIME_REVERIFY_DELAY_MS);
    try {
      const s = await stat(filePath);
      if (s.mtimeMs !== newMtime) {
        await log(`skip code-canonical (still being edited): ${filePath}`);
        continue;
      }
    } catch {
      continue;
    }

    state.mtimes[filePath] = newMtime;

    // Bootstrap seed: silently record mtime for sibling-worktree files on
    // first observation. Prevents flood on first deploy. Canonical
    // worktree edits always fire (matches pre-worktree behaviour).
    const isCanonical = !exp.worktree || exp.worktree.isCanonical;
    if (isBootstrap && !isCanonical) {
      await log(`bootstrap seed (no row): ${filePath}`);
      continue;
    }

    const sourceForRow = path.relative(workspace.root, filePath);
    const corrId = correlationKey(filePath, worktreeMap);
    const stamp = worktreeStamp(exp.worktree);
    const { context: gitContext, error: gitError } = getGitContext(filePath);
    if (gitError) await log(gitError);

    const downstream = uniqueUpstreams.map((u) => ({
      path: u.upstreamDoc,
      why: u.upstreamSection,
      kind: "prose",
    }));
    const changeSummary =
      uniqueUpstreams.length === 1
        ? `code-canonical edit — verify ${uniqueUpstreams[0].upstreamDoc} ${uniqueUpstreams[0].upstreamSection} still matches`
        : `code-canonical edit — verify ${uniqueUpstreams.length} upstream docs still match`;
    const notes = uniqueUpstreams.map((u) => u.note).filter(Boolean).join("; ");

    const row = {
      type: "code_drift",
      source: sourceForRow,
      change: changeSummary,
      downstream,
      status: "open",
      notes,
    };
    if (corrId) row.correlation_id = corrId;
    if (stamp) row.source_worktree = stamp;
    if (gitContext) row.git = gitContext;

    const id = await appendRowWithId(workspace.ledgerJsonl, row);
    await log(
      `code_drift logged: ${sourceForRow} -> upstream ${uniqueUpstreams
        .map((u) => `${u.upstreamDoc} ${u.upstreamSection}`)
        .join(", ")}`,
    );
    results.push({ id, sourceRel: sourceForRow, count: downstream.length, kind: "code_drift" });
  }
  return results.length > 0 ? results : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cross-repo pass (federated .propagates-cross.yml → parent cross-ledger)
// ─────────────────────────────────────────────────────────────────────────────

// Test hook: override the search roots + cross-ledger paths.
let _crossCfg = { searchRoots: SEARCH_ROOTS, crossJsonl: CROSS_LEDGER_JSONL, crossMd: CROSS_LEDGER_MD };
export function __setCrossPathsForTest(cfg) { _crossCfg = { ..._crossCfg, ...cfg }; }

/**
 * Cross-repo pass. Runs inside the outer lock, before writeState.
 * Push: my declared `source` changes → row telling external consumers to re-verify.
 * Pull: external `watch` file changes → row for the declaring repo.
 * Every tracked path is added to crossKeepSet for GC. Returns event count.
 */
export async function processCrossRepo(state, crossKeepSet) {
  const repos = discoverCrossReposSync(_crossCfg.searchRoots);
  let events = 0;

  for (const repo of repos) {
    let edges;
    try {
      edges = loadCrossRepoSync(repo.root);
    } catch (err) {
      await log(`cross: bad .propagates-cross.yml in ${repo.name}: ${err.message}`);
      continue;
    }

    // PUSH — watch my own source files; on change, fire to external consumers.
    for (const edge of edges.pushEdges) {
      const srcAbs = path.resolve(repo.root, edge.source);
      crossKeepSet.add(srcAbs);
      if (!existsSync(srcAbs)) { await log(`cross: push source missing ${srcAbs}`); continue; }
      const known = state.mtimes[srcAbs] !== undefined;
      const changed = await detectMtimeChange(STATE_PATH, srcAbs, state);
      if (changed === null) continue;
      state.mtimes[srcAbs] = changed;
      if (!known) continue; // bootstrap seed, no fire
      const downstream = [];
      for (const a of edge.affects) {
        const r = resolveTarget(repo.root, a.path);
        if (!r.ok) { await log(`cross: push target ${a.path} rejected (${r.reason})`); continue; }
        downstream.push({ path: a.path, why: a.why, kind: "code" });
      }
      if (downstream.length === 0) continue;
      const corr = crossCorrelationId(srcAbs, path.resolve(repo.root, edge.affects[0].path));
      await appendRowWithId(_crossCfg.crossJsonl, {
        type: "drift", source: path.relative(repo.root, srcAbs),
        change: "cross-repo contract changed (outbound)", downstream, status: "open",
        flow: "platform_contract", direction: "outbound", origin_repo: repo.name,
        partner: resolvePartner(edge.affects[0].path), correlation_id: corr,
      });
      events++;
    }

    // PULL — watch external files; on change, fire a row for me.
    for (const edge of edges.pullEdges) {
      const r = resolveTarget(repo.root, edge.watch);
      const watchAbs = r.abs;
      crossKeepSet.add(watchAbs);
      if (!r.ok) {
        if (r.reason === "missing") {
          // Rename/move IS the drift when we had previously seen this file (adv B1).
          if (state.mtimes[watchAbs] !== undefined) {
            const forAbs = path.resolve(repo.root, edge.for || ".");
            await appendRowWithId(_crossCfg.crossJsonl, {
              type: "drift", source: path.relative(repo.root, watchAbs),
              change: `cross-repo ${edge.flow} target moved/missing — was tracked, now gone; verify ${edge.for}`,
              downstream: [{ path: edge.for, why: edge.why, kind: "code" }], status: "open",
              flow: edge.flow, direction: "inbound", origin_repo: repo.name,
              partner: resolvePartner(watchAbs), correlation_id: crossCorrelationId(watchAbs, forAbs),
            });
            delete state.mtimes[watchAbs];   // clear so we don't re-fire every tick
            events++;
          } else {
            await log(`cross: pull watch missing (never seen) ${watchAbs}`);
          }
        } else {
          await log(`cross: pull watch ${edge.watch} rejected (${r.reason})`);
        }
        continue;
      }
      const known = state.mtimes[watchAbs] !== undefined;
      const changed = await detectMtimeChange(STATE_PATH, watchAbs, state);
      if (changed === null) continue;
      state.mtimes[watchAbs] = changed;
      if (!known) continue; // bootstrap seed, no fire
      const forAbs = path.resolve(repo.root, edge.for || ".");
      const corr = crossCorrelationId(watchAbs, forAbs);
      await appendRowWithId(_crossCfg.crossJsonl, {
        type: "drift", source: path.relative(repo.root, watchAbs),
        change: `cross-repo ${edge.flow} changed (inbound) — verify ${edge.for}`,
        downstream: [{ path: edge.for, why: edge.why, kind: "code" }], status: "open",
        flow: edge.flow, direction: "inbound", origin_repo: repo.name,
        partner: resolvePartner(watchAbs), correlation_id: corr,
      });
      events++;
    }
  }

  // Unconditional: the staleness banner is time-derived, so gating on events
  // let the cross-ledger freeze at "Watcher healthy" for 28+ days. renderMarkdown
  // is idempotent (content-diff guard), so this is a no-op write when nothing
  // changed.
  try { await renderMarkdown(_crossCfg.crossJsonl, _crossCfg.crossMd); }
  catch (err) { await log(`cross: render failed: ${err.message}`); }
  return events;
}

/**
 * Decision-driven trigger (§4b, Slice 2). Parse each cross-repo participant's
 * workspace DECISIONS.md; for entries whose Affects: names a partner (via the shared
 * alias table), fire a `flow: decision` relay row — but seed pre-CROSS_TRIGGER_EPOCH
 * entries as processed WITHOUT firing (bootstrap, G6) so onboarding fires only the
 * recent, genuinely-un-relayed partner decisions. Returns {events, liveKeys}.
 */
export async function processDecisions(state, nowMs) {
  const repos = discoverCrossReposSync(_crossCfg.searchRoots);
  const liveKeys = new Set();
  const firstRun = Object.keys(state.crossDecisions ?? {}).length === 0;
  let events = 0, seeded = 0;

  for (const repo of repos) {
    const decPath = path.join(repo.root, "docs", "DECISIONS.md");
    if (!existsSync(decPath)) continue;
    let entries;
    try { entries = parseDecisions(readFileSync(decPath, "utf8")); }
    catch (err) { await log(`cross-decision: parse failed ${decPath}: ${err.message}`); continue; }

    for (const e of entries) {
      if (e.title.includes("<")) continue;                 // template/convention example (e.g. "<title>") — not a real decision
      const partners = [...new Set(e.tokens.map(resolvePartner).filter(Boolean))];
      if (partners.length === 0) continue;                 // no partner named → skip
      const fullKey = `${repo.name}:workspace:${e.key}`;
      liveKeys.add(fullKey);
      if (state.crossDecisions[fullKey]) continue;         // already processed
      if (e.date < CROSS_TRIGGER_EPOCH) {                  // bootstrap seed, no fire (G6)
        state.crossDecisions[fullKey] = true; seeded++; continue;
      }
      for (const partner of partners) {                    // fire one relay row per partner
        await appendRowWithId(_crossCfg.crossJsonl, {
          type: "drift", source: path.relative(repo.root, decPath),
          change: `decision affects ${partner} — relay/verify: ${e.title.slice(0, 80)}`,
          downstream: [{ path: partner, why: e.title.slice(0, 120), kind: "prose" }],
          status: "open", flow: "decision", direction: "outbound",
          origin_repo: repo.name, partner, correlation_id: `decision:${fullKey}:${partner}`,
        });
        events++;
      }
      state.crossDecisions[fullKey] = true;                // mark AFTER firing (fire-first: a crash re-fires, never loses a relay)
      if (e.collision) await log(`cross-decision: collision-disambiguated ${fullKey}`);
    }
  }

  if (firstRun && seeded > 0) {
    await log(`cross-decision: first run — seeded ${seeded} historical partner decisions as processed (pre-${CROSS_TRIGGER_EPOCH})`);
  }
  // Unconditional for the same reason as processCrossRepo; idempotent render
  // makes the duplicate call per fire a no-op when the body is unchanged.
  try { await renderMarkdown(_crossCfg.crossJsonl, _crossCfg.crossMd); }
  catch (err) { await log(`cross-decision: render failed: ${err.message}`); }
  return { events, liveKeys };
}

async function main() {
  await mkdir(SKILL_DIR, { recursive: true });

  // Touch lock target so proper-lockfile has a real path to lock around.
  try {
    await appendFile(LOCK_PATH, "");
  } catch {
    /* ignore */
  }

  const release = await acquireLock(LOCK_PATH, { retries: 8 });
  if (!release) {
    await log("skip: another invocation holds the lock");
    return;
  }

  try {
    const state = await readState(STATE_PATH);
    const events = [];

    for (const workspace of WORKSPACES) {
      // Ensure ledger directory exists
      await mkdir(path.dirname(workspace.ledgerJsonl), { recursive: true });
      if (!existsSync(workspace.ledgerJsonl)) {
        await appendFile(workspace.ledgerJsonl, "");
      }

      // Enumerate worktrees ONCE per workspace per fire. Build a map of
      // canonical-repo-path → [worktree, ...] used by both processChange
      // (to expand downstream paths) and processCodeCanonical (to scan
      // each worktree's copy of canonical code paths). Empty map for
      // workspaces with no git repos or when `git` is unavailable —
      // watcher behaviour falls back to canonical-only, identical to
      // pre-T2.
      let worktreeMap;
      try {
        worktreeMap = await enumerateWorktrees(workspace.root);
      } catch (err) {
        await log(`worktree enumeration failed for ${workspace.name}: ${err.message}`);
        worktreeMap = new Map();
      }

      // B0 loop protection moved into renderMarkdown (content-diff guard), so
      // no event-count bookkeeping is needed here. Writing the ledger MD still
      // ticks mtime and triggers launchd via WatchPaths, but that now happens
      // only on a genuine content change rather than on every fire.

      for (const relDir of workspace.scanDirs) {
        const dir = path.resolve(workspace.root, relDir);
        const candidates = await listCandidates(dir);
        for (const file of candidates) {
          try {
            const result = await processChange(workspace, file, state, worktreeMap);
            if (result && result.id) events.push({ workspace: workspace.name, ...result });
          } catch (err) {
            await log(`error processing ${file}: ${err.message}`);
          }
        }
      }

      // Discovery-driven source scan (added 2026-06-09 — D8). Walks every
      // .propagates.yml under workspace root (skipping node_modules, .git,
      // .worktrees, etc.) and processes each declared source. Catches
      // sources in subdirectories that scanDirs doesn't reach (e.g.
      // astroacharya/app/middleware/api_key.py, VipinKaushik-mb/server/models/*).
      // Additive — sources already processed via scanDirs get deduped by
      // processChange's mtime check.
      let declaredSources;
      try {
        declaredSources = await enumerateDeclaredSources(workspace.root, log);
      } catch (err) {
        await log(`enumerateDeclaredSources failed for ${workspace.name}: ${err.message}`);
        declaredSources = [];
      }
      for (const file of declaredSources) {
        try {
          const result = await processChange(workspace, file, state, worktreeMap);
          if (result && result.id) events.push({ workspace: workspace.name, ...result });
        } catch (err) {
          await log(`error processing declared source ${file}: ${err.message}`);
        }
      }

      // Code-canonical scan — bidirectional drift detection. Entries come
      // from TWO sources, merged (G3): the per-workspace .code-canonical.yml
      // AND every `.propagates.yml` `kind: code` downstream, synthesized
      // into the same shape. Grouped by codePath BEFORE calling
      // processCodeCanonical so a code file declared in both sidecars (or
      // pointing at two docs) fires ONE code_drift row with N downstreams,
      // not N rows. For each declared code path under this workspace,
      // expand to all worktrees and fire a code_drift row pointing upstream
      // when any worktree's copy mtime advances. Returns an array of
      // results (one per firing worktree) or null if no firings.
      let canonicalEntries = [];
      try {
        canonicalEntries = loadCodeCanonicalSync(workspace.root);
      } catch (err) {
        await log(`error loading .code-canonical.yml for ${workspace.name}: ${err.message}`);
      }
      let synthesizedEntries = [];
      try {
        synthesizedEntries = await synthesizeKindCodeEntries(workspace.root, log);
      } catch (err) {
        await log(`error synthesizing kind:code edges for ${workspace.name}: ${err.message}`);
      }
      const groupedByCodePath = new Map();
      for (const entry of [...canonicalEntries, ...synthesizedEntries]) {
        if (!entry.codePath || !entry.upstreamDoc) continue;
        const list = groupedByCodePath.get(entry.codePath) || [];
        list.push({
          upstreamDoc: entry.upstreamDoc,
          upstreamSection: entry.upstreamSection,
          note: entry.note,
        });
        groupedByCodePath.set(entry.codePath, list);
      }
      for (const [codePath, upstreams] of groupedByCodePath) {
        try {
          const results = await processCodeCanonical(workspace, codePath, upstreams, state, worktreeMap);
          if (results) {
            for (const r of results) {
              events.push({ workspace: workspace.name, ...r });
            }
          }
        } catch (err) {
          await log(`error processing code-canonical ${codePath}: ${err.message}`);
        }
      }

      // Re-render on every fire. The staleness tripwire in the MD header is
      // time-derived, so gating the render on "this workspace had new events"
      // meant a ledger that went silent froze its own health banner at whatever
      // it last said — "Watcher healthy" on a ledger dead for weeks.
      //
      // Loop safety (B0) now lives in renderMarkdown itself: it diffs the
      // rendered body against the file, ignoring the generated-at footer, and
      // returns false without writing when nothing changed. So mtime only ticks
      // on a real content change (≈ once/day when daysAgo increments), not on
      // every fire.
      try {
        await renderMarkdown(workspace.ledgerJsonl, workspace.ledgerMd);
      } catch (err) {
        await log(`render failed for ${workspace.name}: ${err.message}`);
      }
    }

    // Cross-repo pass (federated .propagates-cross.yml → parent cross-ledger).
    // crossKeepSet collects only the cross paths tracked THIS fire (starts empty),
    // so a deleted cross edge's foreign key is absent and gets GC'd below.
    const crossKeepSet = new Set();
    try {
      const crossEvents = await processCrossRepo(state, crossKeepSet);
      if (crossEvents > 0) await log(`cross: ${crossEvents} cross-repo events`);
    } catch (err) {
      await log(`cross-repo pass failed: ${err.message}`);
    }

    // GC (adv B1): prune only FOREIGN keys (outside every workspace root) that are no
    // longer a tracked cross path — i.e. deleted cross edges. Intra-workspace keys are
    // always kept (managed by the existing intra flow; untouched here).
    const gcKeep = new Set(crossKeepSet);
    for (const key of Object.keys(state.mtimes)) {
      if (WORKSPACES.some((w) => key === w.root || key.startsWith(w.root + path.sep))) gcKeep.add(key);
    }
    const pruned = pruneMtimes(state, gcKeep);
    if (pruned > 0) await log(`state GC: pruned ${pruned} stale cross mtime keys`);

    // Decision-driven trigger (§4b, Slice 2): DECISIONS.md Affects:<partner> → relay row.
    try {
      const { events: decEvents, liveKeys } = await processDecisions(state, Date.now());
      if (decEvents > 0) await log(`cross-decision: ${decEvents} relay rows`);
      const decPruned = pruneCrossDecisions(state, liveKeys, Date.now());
      if (decPruned > 0) await log(`cross-decision GC: pruned ${decPruned} stale keys`);
    } catch (err) {
      await log(`cross-decision pass failed: ${err.message}`);
    }

    state.lastRunAt = Date.now();
    await writeState(STATE_PATH, state);
    await heartbeat(HEARTBEAT_PATH);

    if (events.length > 0) {
      const proseCount = events.filter((e) => e.kind !== "code_drift").length;
      const codeCount = events.filter((e) => e.kind === "code_drift").length;
      const summary = events
        .map((e) => {
          const tag = e.kind === "code_drift" ? "↑" : "→";
          return `${path.basename(e.sourceRel)} ${tag} ${e.count}`;
        })
        .join(", ");
      const title =
        codeCount > 0 && proseCount > 0
          ? `Propagation: ${proseCount} drift + ${codeCount} code drift`
          : codeCount > 0
            ? `Propagation: ${codeCount} code drift event${codeCount === 1 ? "" : "s"}`
            : `Propagation: ${proseCount} drift event${proseCount === 1 ? "" : "s"}`;
      await notify(title, summary);
      await log(`run complete: ${events.length} events (${proseCount} drift, ${codeCount} code_drift)`);
    } else {
      await log("run complete: no drift");
    }
  } finally {
    await release();
  }
}

// Only run the watcher when executed directly (node watcher.mjs), NOT when a test
// imports processCrossRepo/__setCrossPathsForTest from this module.
const _invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (_invokedDirectly) {
  // RETIRED 2026-08-14 (see the file header and docs/DECISIONS.md 2026-08-14).
  // Refuse loudly rather than silently writing v1 rows into ledgers nothing
  // else maintains — a quiet no-op here would be exactly the failure class
  // (docs/GOTCHAS.md G1/G2) this whole codebase exists to prevent.
  // Set PROPAGATE_ALLOW_RETIRED_WATCHER=1 to override for a deliberate,
  // one-off historical run (e.g. reproducing a pre-retirement bug) — never
  // for routine use, and never from launchd.
  if (process.env.PROPAGATE_ALLOW_RETIRED_WATCHER !== "1") {
    console.error(
      [
        "propagate: the v1 watcher is RETIRED and refuses to run.",
        "",
        "Measured 4,420 runs / 4,384 no-ops (99.2% found nothing), and its",
        "state.json mtime baseline caused two incidents in one day. `reconcile`,",
        "`check`, and the daily digest's DRIFT/INBOUND sections replace its",
        "coverage — see docs/DECISIONS.md 2026-08-14 before doing anything else.",
        "",
        "If you deliberately need a one-off historical run, re-run with",
        "PROPAGATE_ALLOW_RETIRED_WATCHER=1 set — never from launchd, never routinely.",
      ].join("\n"),
    );
    process.exit(1);
  }
  main().catch(async (err) => {
    await log(`fatal: ${err.stack || err.message}`);
    // exit 0 so launchd doesn't disable us
    process.exit(0);
  });
}
