/**
 * Workspace discovery — finds dirs containing `.propagates.yml` markers
 * under configured search roots. Synchronous (called at module-load time
 * from config.mjs to keep the public WORKSPACES export shape).
 *
 * A directory is a workspace if it contains `.propagates.yml` at its root.
 * Searched at depth ≤ DEFAULT_MAX_DEPTH below each search root, so both:
 *   - ~/Documents/GitHub/Vipin Kaushik/          (depth 1)
 *   - ~/Documents/GitHub/PanditPawanKaushik/SSJK-mb/  (depth 2)
 * are reachable.
 *
 * Ledger path resolution per workspace:
 *   - If `<root>/docs/` exists  → `<root>/docs/PROPAGATION_LEDGER.{jsonl,md}` (legacy convention)
 *   - Otherwise                 → `<root>/.propagation/ledger.{jsonl,md}` (new convention)
 *
 * scanDirs (relative to workspace root) — directories the watcher walks:
 *   - Always includes "." (root itself)
 *   - Includes "docs" when docs/ exists
 */

import { readdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";

const DEFAULT_MAX_DEPTH = 2;

const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".next",
  ".git",
  "dist",
  "build",
  ".turbo",
  ".vercel",
  ".gstack-backup",
  ".gstack-backup-1779072805",
  ".gstack-backup-20260515135620",
  ".gstack.bak",
  "Library",
  "Trash",
]);

function listDirs(parent) {
  let entries;
  try {
    entries = readdirSync(parent, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIR_NAMES.has(e.name))
    .map((e) => path.join(parent, e.name));
}

function makeWorkspaceRecord(wsRoot) {
  const name = path.basename(wsRoot);
  const docsDir = path.join(wsRoot, "docs");
  const docsExists = existsSync(docsDir);

  const ledgerDir = docsExists ? docsDir : path.join(wsRoot, ".propagation");
  const ledgerJsonl = docsExists
    ? path.join(ledgerDir, "PROPAGATION_LEDGER.jsonl")
    : path.join(ledgerDir, "ledger.jsonl");
  const ledgerMd = docsExists
    ? path.join(ledgerDir, "PROPAGATION_LEDGER.md")
    : path.join(ledgerDir, "ledger.md");

  const scanDirs = docsExists ? ["docs", "."] : ["."];

  return {
    name,
    root: wsRoot,
    ledgerJsonl,
    ledgerMd,
    scanDirs,
  };
}

/**
 * Walk searchRoots looking for dirs with `.propagates.yml`.
 * @param {string[]} searchRoots
 * @param {number} maxDepth - depth below each root to search
 * @returns {Array<{name,root,ledgerJsonl,ledgerMd,scanDirs}>}
 */
export function discoverWorkspacesSync(searchRoots, maxDepth = DEFAULT_MAX_DEPTH) {
  const found = [];
  const seen = new Set();

  function walk(dir, depth) {
    if (depth > maxDepth) return;
    // If this dir has a marker, it's a workspace.
    const markerPath = path.join(dir, ".propagates.yml");
    if (existsSync(markerPath)) {
      try {
        const stat = statSync(markerPath);
        if (stat.isFile()) {
          if (!seen.has(dir)) {
            seen.add(dir);
            found.push(makeWorkspaceRecord(dir));
            // Don't recurse below a workspace — nested workspaces are
            // intentionally NOT supported in V2 (one marker per logical project).
            return;
          }
        }
      } catch {
        /* ignore */
      }
    }
    // Otherwise descend.
    if (depth === maxDepth) return;
    for (const sub of listDirs(dir)) {
      walk(sub, depth + 1);
    }
  }

  for (const root of searchRoots) {
    if (existsSync(root)) walk(root, 0);
  }

  return found;
}
