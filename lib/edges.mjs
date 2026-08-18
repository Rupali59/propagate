/**
 * Declared-edge resolvers — pure(ish) functions that read `.propagates.yml`
 * sidecars off disk and answer "what's declared coupled to what."
 *
 * Relocated from watcher.mjs (2026-08 — commit-time `check` mode, F1
 * correction): these four are the DECLARATION-level resolvers the daemon
 * used to discover sources across a workspace. They are behavior-preserving
 * moves — same bodies, same call signatures modulo an added optional
 * `logger` param (the daemon's `log()` was a free variable in watcher.mjs;
 * here it's threaded explicitly so this module has no hard dependency on
 * the watcher's logging).
 *
 * `processChange` / `processCodeCanonical` in watcher.mjs — the EFFECTFUL
 * firing path (glob + worktree expansion + mtime detection + ledger
 * append) — are NOT here and were NOT touched. That fusion is intentional
 * (see watcher.mjs's module docstring) and out of scope for this move.
 */

import { readdir } from "node:fs/promises";
import { existsSync, statSync, realpathSync } from "node:fs";
import path from "node:path";

import { WORKSPACES } from "./config.mjs";
import { loadSidecar, downstreamsFor } from "./frontmatter.mjs";

// Re-exported so callers of lib/edges.mjs have one place to import the full
// declared-edge resolver set from, without also reaching into frontmatter.mjs.
export { downstreamsFor };

/** No-op default logger — callers that don't care about diagnostics (e.g. `check`). */
async function noopLogger() {
  /* no-op */
}

/**
 * Recursively find all .propagates.yml files under a workspace root.
 * Skips node_modules, .git, .next, dist, build, .venv, __pycache__,
 * .worktrees (we don't want to discover sidecars that live in secondary
 * worktrees — primary worktree's sidecar is canonical).
 */
export async function findAllSidecarsRecursive(root, workspaceRoots = WORKSPACES.map((w) => w.root)) {
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
  /*
   * Nearest-ancestor workspace scoping.
   *
   * A source file belongs to the CLOSEST workspace above it, not to every
   * workspace above it. Without this, a repo that is its own workspace but also
   * sits under a broader one (e.g. Keerti-portfolio inside the GitHub hub) has
   * every one of its sidecar sources processed twice — firing duplicate rows
   * into two different ledgers for a single edit.
   *
   * Stopping the walk at another workspace's root means that workspace's own
   * sweep is the only one that sees its sidecars. Workspaces that do NOT contain
   * a nested workspace are completely unaffected.
   *
   * `workspaceRoots` defaults to the real, discovered WORKSPACES list (all
   * production call sites rely on this default and never pass a second arg).
   * It's an explicit parameter purely so tests can exercise this scoping
   * logic against synthetic fixture trees instead of the real, machine-specific
   * workspace set.
   */
  const rootAbs = path.resolve(root);
  const nestedWorkspaceRoots = new Set(
    workspaceRoots.map((r) => path.resolve(r)).filter((r) => r !== rootAbs),
  );

  const found = [];
  // Cycle guard for the symlink branch below, keyed on resolved path.
  const walked = new Set();

  async function walk(dir) {
    let real;
    try { real = realpathSync(dir); } catch { real = dir; }
    if (walked.has(real)) return;
    walked.add(real);

    if (!existsSync(dir)) return;
    // Hand off to the nested workspace's own sweep.
    if (path.resolve(dir) !== rootAbs && nestedWorkspaceRoots.has(path.resolve(dir))) return;
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
      } else if (e.isSymbolicLink()) {
        // Follow a link ONLY when it carries a marker (N29). Same rule and same
        // reason as lib/discovery.mjs's listDirs — and it has to be repeated
        // here because these are two independent walks: discovery finds
        // WORKSPACES, this finds SIDECARS, and fixing only the first left the
        // expanded edge count at 711 -> 711 with five edges declared.
        if (SKIP_DIRS.has(e.name)) continue;
        const linked = path.join(dir, e.name);
        try {
          if (!statSync(linked).isDirectory()) continue;
          if (!existsSync(path.join(linked, ".propagates.yml"))) continue;
        } catch {
          continue; // dangling or unreadable
        }
        await walk(linked);
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
 *
 * @param {string} workspaceRoot
 * @param {(line: string) => Promise<void>} [logger] optional diagnostic sink
 *   (defaults to a no-op). watcher.mjs passes its own log() so broken-sidecar
 *   diagnostics still land in watcher.log; callers like `check` can ignore it.
 */
export async function enumerateDeclaredSources(workspaceRoot, logger = noopLogger) {
  const sources = new Set();
  const sidecars = await findAllSidecarsRecursive(workspaceRoot);
  for (const sidecarPath of sidecars) {
    let sidecar;
    try {
      sidecar = await loadSidecar(sidecarPath);
    } catch (err) {
      // Broken sidecar — log via caller-supplied logger, don't fail enumeration.
      await logger(`enumerateDeclaredSources: skip broken sidecar ${sidecarPath}: ${err.message}`);
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

/**
 * Synthesize code-canonical entries from every `.propagates.yml` `kind: code`
 * downstream declared anywhere under workspaceRoot (G3 — closes #43's gap: a
 * `kind: code` downstream previously only fired forward, doc -> verify code;
 * this makes the coupling fire code -> verify doc too).
 *
 * Reuses the same sidecar discovery + loading as enumerateDeclaredSources,
 * plus downstreamsFor to read each source's declared downstreams.
 *
 * Shape matches loadCodeCanonicalSync's output exactly:
 *   {codePath, upstreamDoc, upstreamSection, note}
 * Both codePath and upstreamDoc are WORKSPACE-RELATIVE (eng-review F4) —
 * processCodeCanonical re-resolves them against workspace.root, so an
 * absolute path here would double-resolve and never match on disk.
 *
 * Glob kind:code downstreams (e.g. `lib/**\/*.ts`) are deferred: logged and
 * skipped, matching the existing 0-match glob handling in processChange.
 *
 * @param {string} workspaceRoot
 * @param {(line: string) => Promise<void>} [logger] optional diagnostic sink
 */
export async function synthesizeKindCodeEntries(workspaceRoot, logger = noopLogger) {
  const synthesized = [];
  const sidecars = await findAllSidecarsRecursive(workspaceRoot);
  for (const sidecarPath of sidecars) {
    let sidecar;
    try {
      sidecar = await loadSidecar(sidecarPath);
    } catch (err) {
      await logger(`synthesizeKindCodeEntries: skip broken sidecar ${sidecarPath}: ${err.message}`);
      continue;
    }
    if (!sidecar || !sidecar.sources) continue;
    const sidecarDir = path.dirname(sidecarPath);
    for (const sourceKey of Object.keys(sidecar.sources)) {
      const downstreams = downstreamsFor(sidecar, sourceKey);
      const sourceAbs = path.resolve(sidecarDir, sourceKey);
      for (const d of downstreams) {
        if ((d.kind || "prose") !== "code") continue;
        if (/[*?[\]]/.test(d.path)) {
          await logger(
            `kind:code glob downstream deferred (log-and-skip): ${d.path} (from ${sourceKey})`,
          );
          continue;
        }
        const codeAbs = path.resolve(sidecarDir, d.path);
        synthesized.push({
          codePath: path.relative(workspaceRoot, codeAbs),
          upstreamDoc: path.relative(workspaceRoot, sourceAbs),
          upstreamSection: d.why || "",
          note: "declared kind:code edge (bidirectional)",
        });
      }
    }
  }
  return synthesized;
}

/**
 * Declaration-level edge map for a workspace — "is this file coupled, to
 * what," NOT the daemon's worktree/glob row-fanout fidelity. Built for
 * `propagate check` (commit-time gate): it needs a fast yes/no + pointer,
 * not a ledger row.
 *
 * - `forward`: srcRel (workspace-relative declared source) -> declared
 *   downstream path strings (workspace-relative for concrete paths; glob
 *   patterns are kept literal — expansion is out of scope here, same as
 *   `synthesizeKindCodeEntries`'s glob deferral below).
 * - `reverse`: codeRel (workspace-relative `kind: code` downstream path) ->
 *   [{upstreamDoc, upstreamSection}, ...]. Sourced straight from
 *   `synthesizeKindCodeEntries`, so it inherits that function's glob
 *   deferral (F2 — documented limitation, not a bug: glob-declared code
 *   edges don't warn).
 *
 * @param {string} workspaceRoot
 * @param {(line: string) => Promise<void>} [logger] optional diagnostic sink
 * @returns {Promise<{forward: Map<string, string[]>, reverse: Map<string, {upstreamDoc: string, upstreamSection: string}[]>}>}
 */
export async function buildEdgeMap(workspaceRoot, logger = noopLogger) {
  const forward = new Map();
  const sidecars = await findAllSidecarsRecursive(workspaceRoot);
  for (const sidecarPath of sidecars) {
    let sidecar;
    try {
      sidecar = await loadSidecar(sidecarPath);
    } catch (err) {
      await logger(`buildEdgeMap: skip broken sidecar ${sidecarPath}: ${err.message}`);
      continue;
    }
    if (!sidecar || !sidecar.sources) continue;
    const sidecarDir = path.dirname(sidecarPath);
    for (const sourceKey of Object.keys(sidecar.sources)) {
      const downstreams = downstreamsFor(sidecar, sourceKey);
      if (downstreams.length === 0) continue;
      const sourceAbs = path.resolve(sidecarDir, sourceKey);
      const sourceRel = path.relative(workspaceRoot, sourceAbs);
      const paths = downstreams.map((d) =>
        /[*?[\]]/.test(d.path) ? d.path : path.relative(workspaceRoot, path.resolve(sidecarDir, d.path)),
      );
      const existing = forward.get(sourceRel) || [];
      forward.set(sourceRel, [...existing, ...paths]);
    }
  }

  const reverse = new Map();
  const synthesized = await synthesizeKindCodeEntries(workspaceRoot, logger);
  for (const entry of synthesized) {
    const list = reverse.get(entry.codePath) || [];
    list.push({ upstreamDoc: entry.upstreamDoc, upstreamSection: entry.upstreamSection });
    reverse.set(entry.codePath, list);
  }

  return { forward, reverse };
}
