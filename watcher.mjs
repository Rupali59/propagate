#!/usr/bin/env node
/**
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
import { existsSync } from "node:fs";
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
} from "./lib/config.mjs";
import { loadCodeCanonicalSync } from "./lib/code-canonical.mjs";
import { readState, writeState, detectMtimeChange } from "./lib/state.mjs";
import { acquireLock } from "./lib/lock.mjs";
import {
  loadSidecar,
  findSidecarFor,
  downstreamsFor,
  SidecarError,
} from "./lib/frontmatter.mjs";
import {
  appendRow,
  nextId,
  renderMarkdown,
} from "./lib/ledger.mjs";
import { notify, heartbeat } from "./lib/notify.mjs";
import {
  enumerateWorktrees,
  expandWorktreePaths,
  worktreeStamp,
  correlationKey,
} from "./lib/worktrees.mjs";

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

/**
 * Recursively find all .propagates.yml files under a workspace root.
 * Skips node_modules, .git, .next, dist, build, .venv, __pycache__,
 * .worktrees (we don't want to discover sidecars that live in secondary
 * worktrees — primary worktree's sidecar is canonical).
 */
async function findAllSidecarsRecursive(root) {
  const SKIP_DIRS = new Set([
    "node_modules",
    ".git",
    ".next",
    "dist",
    "build",
    ".venv",
    "venv",
    "__pycache__",
    ".worktrees",
    ".gstack",
    ".claude",
  ]);
  const found = [];
  async function walk(dir) {
    if (!existsSync(dir)) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        await walk(path.join(dir, e.name));
      } else if (e.isFile() && e.name === ".propagates.yml") {
        found.push(path.join(dir, e.name));
      }
    }
  }
  await walk(root);
  return found;
}

/**
 * Enumerate every file declared as a source in any sidecar under workspaceRoot.
 * Returns absolute paths, deduplicated. Source declarations are resolved
 * relative to the sidecar's own directory (matches loadSidecar / processChange
 * semantics).
 *
 * Why this exists (added 2026-06-09, D8 follow-up):
 * The watcher previously walked only `scanDirs = ["docs", "."]` per workspace —
 * direct children of the workspace root. Sources declared in nested project
 * sidecars (astroacharya/.propagates.yml, VipinKaushik-mb/.propagates.yml)
 * pointing at files in subdirectories (app/, server/, lib/) were never
 * statted, so drift never fired. This enumeration is sidecar-driven:
 * whatever any sidecar declares as a source gets watched, regardless of
 * subdir depth or extension.
 */
async function enumerateDeclaredSources(workspaceRoot) {
  const sources = new Set();
  const sidecars = await findAllSidecarsRecursive(workspaceRoot);
  for (const sidecarPath of sidecars) {
    let sidecar;
    try {
      sidecar = await loadSidecar(sidecarPath);
    } catch (err) {
      // Broken sidecar — log via main loop, don't fail enumeration.
      await log(`enumerateDeclaredSources: skip broken sidecar ${sidecarPath}: ${err.message}`);
      continue;
    }
    if (!sidecar || !sidecar.sources) continue;
    const sidecarDir = path.dirname(sidecarPath);
    for (const sourceKey of Object.keys(sidecar.sources)) {
      // Source key is relative to sidecar dir.
      const sourceAbs = path.resolve(sidecarDir, sourceKey);
      sources.add(sourceAbs);
    }
  }
  return Array.from(sources);
}

async function processChange(workspace, filePath, state, worktreeMap) {
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

  const id = await nextId(workspace.ledgerJsonl);
  const sourceRel = path.relative(workspace.root, filePath);
  const change = `auto-detected edit (mtime advanced)`;
  const corrId = correlationKey(filePath, worktreeMap);

  const row = {
    type: "drift",
    id,
    source: sourceRel,
    change,
    downstream: resolvedDownstreams,
    status: "open",
    pending_graph_augment: resolvedDownstreams.some((d) => d.kind === "code"),
  };
  if (corrId) row.correlation_id = corrId;

  await appendRow(workspace.ledgerJsonl, row);

  await log(`drift logged: ${sourceRel} -> ${resolvedDownstreams.length} downstream`);
  return { id, sourceRel, count: resolvedDownstreams.length };
}

/**
 * Code-canonical scan — bidirectional drift detection, worktree-aware.
 *
 * For each entry in `.code-canonical.yml`, expand the canonical code path
 * to all worktree-equivalents via `expandWorktreePaths`. For each worktree
 * whose copy of the file changed, fire ONE `code_drift` row (the row's
 * `source` includes the worktree's path so drain can locate the actual
 * edit; `correlation_id` groups all worktree-copies of the same logical
 * file so drain dedupes the upstream-verification prompt).
 *
 * Bootstrap behaviour: on first-observation of a sibling-worktree path
 * (state.mtimes[filePath] === undefined AND the worktree is NOT canonical),
 * we record the mtime silently and skip the row. Without this, deploying
 * the worktree-aware watcher floods the ledger with one row per
 * sibling-worktree file on first fire (S2 — bootstrap seed).
 */
async function processCodeCanonical(workspace, entry, state, worktreeMap) {
  const canonicalAbs = path.resolve(workspace.root, entry.codePath);
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

    const id = await nextId(workspace.ledgerJsonl);
    const sourceForRow = path.relative(workspace.root, filePath);
    const corrId = correlationKey(filePath, worktreeMap);
    const stamp = worktreeStamp(exp.worktree);

    const row = {
      type: "code_drift",
      id,
      source: sourceForRow,
      change: `code-canonical edit — verify ${entry.upstreamDoc} ${entry.upstreamSection} still matches`,
      downstream: [
        {
          path: entry.upstreamDoc,
          why: entry.upstreamSection,
          kind: "prose",
        },
      ],
      status: "open",
      notes: entry.note,
    };
    if (corrId) row.correlation_id = corrId;
    if (stamp) row.source_worktree = stamp;

    await appendRow(workspace.ledgerJsonl, row);
    await log(
      `code_drift logged: ${sourceForRow} -> upstream ${entry.upstreamDoc} ${entry.upstreamSection}`,
    );
    results.push({ id, sourceRel: sourceForRow, count: 1, kind: "code_drift" });
  }
  return results.length > 0 ? results : null;
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

      // Track events added during THIS workspace's pass so we can skip the
      // ledger MD re-render when nothing changed. Re-rendering on every fire
      // ticks the ledger file's mtime, which triggers launchd (docs/ is in
      // WatchPaths) and creates a feedback loop firing the watcher ~every
      // 5s indefinitely. Explicit StartInterval in the plist replaces that
      // accidental polling.
      const workspaceEventsStart = events.length;
      const ledgerMdMissing = !existsSync(workspace.ledgerMd);

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
        declaredSources = await enumerateDeclaredSources(workspace.root);
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

      // Code-canonical scan — bidirectional drift detection. V2: entries
      // loaded from per-workspace .code-canonical.yml. For each declared
      // code path under this workspace, expand to all worktrees and fire
      // a code_drift row pointing upstream when any worktree's copy mtime
      // advances. Returns an array of results (one per firing worktree)
      // or null if no firings.
      let canonicalEntries = [];
      try {
        canonicalEntries = loadCodeCanonicalSync(workspace.root);
      } catch (err) {
        await log(`error loading .code-canonical.yml for ${workspace.name}: ${err.message}`);
      }
      for (const entry of canonicalEntries) {
        try {
          const results = await processCodeCanonical(workspace, entry, state, worktreeMap);
          if (results) {
            for (const r of results) {
              events.push({ workspace: workspace.name, ...r });
            }
          }
        } catch (err) {
          await log(`error processing code-canonical ${entry.codePath}: ${err.message}`);
        }
      }

      // Re-render ledger MD only when this workspace had new events or the
      // rendered file is missing entirely (first deploy / accidental delete).
      // Re-rendering on every fire would tick the file mtime and re-trigger
      // launchd via WatchPaths — the feedback loop B0 fix targets.
      const workspaceEventsAdded = events.length - workspaceEventsStart;
      if (workspaceEventsAdded > 0 || ledgerMdMissing) {
        try {
          await renderMarkdown(workspace.ledgerJsonl, workspace.ledgerMd);
        } catch (err) {
          await log(`render failed for ${workspace.name}: ${err.message}`);
        }
      }
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

main().catch(async (err) => {
  await log(`fatal: ${err.stack || err.message}`);
  // exit 0 so launchd doesn't disable us
  process.exit(0);
});
