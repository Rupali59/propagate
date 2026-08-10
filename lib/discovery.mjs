/**
 * Workspace discovery — finds dirs containing `.propagates.yml` markers
 * under configured search roots. Synchronous (called at module-load time
 * from config.mjs to keep the public WORKSPACES export shape).
 *
 * A `.propagates.yml` marker means "edge declarations live here" by default.
 * It is ALSO a ledger-owning workspace root only when it opts in with
 * `workspace: true` (see propagates.schema.json). The walk always descends
 * past a marker regardless of that flag — nested workspaces are real (e.g.
 * PanditPawanKaushik/SSJK-mb nested under PanditPawanKaushik) and a
 * non-workspace marker (e.g. a `docs/` sidecar) must not swallow anything
 * beneath it.
 *
 * Searched at depth ≤ DEFAULT_MAX_DEPTH below each search root, so both:
 *   - ~/Documents/GitHub/Vipin Kaushik/          (depth 1)
 *   - ~/Documents/GitHub/PanditPawanKaushik/SSJK-mb/  (depth 2)
 * are reachable.
 *
 * Ledger path resolution per workspace (see makeWorkspaceRecord):
 *   - If a ledger file ALREADY EXISTS at either candidate path, pin to that
 *     one — never relocate a live ledger because a `docs/` dir later appears.
 *   - Otherwise, `<root>/docs/` existing selects the legacy
 *     `docs/PROPAGATION_LEDGER.{jsonl,md}` convention; its absence selects
 *     `.propagation/ledger.{jsonl,md}`.
 *
 * scanDirs (relative to workspace root) — directories the watcher walks:
 *   - Always includes "." (root itself)
 *   - Includes "docs" when docs/ exists
 *
 * `discoverWorkspacesSync` never throws — a malformed marker, an unreadable
 * dir, or an empty result all resolve gracefully. It returns
 * `{ workspaces, markersSeen, degraded, suspiciousMarkers }`; `degraded` is
 * true when markers were found on disk but none opted into `workspace: true`
 * (a signal that something upstream — like the schema not yet declaring the
 * field — is silently swallowing every workspace, i.e. TOTAL collapse).
 *
 * `degraded` only catches n=0-workspaces collapse. If a single workspace
 * silently drops out (corrupted marker, typo'd `workspace: "true"`, an
 * exception while building its record) while the rest stay valid,
 * `degraded` stays false. `suspiciousMarkers` is the partial-loss signal:
 * an array of `{path, reason}` for every marker that is (a) unparseable
 * YAML, (b) has a `workspace` key present but not a strict boolean, or (c)
 * parsed fine but threw while building its workspace record. Callers
 * (doctor, status --json) must surface this list as a real problem, not a
 * log line — that's the whole point of Part A.
 */

import { readdirSync, existsSync, statSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

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

/**
 * Classify a `.propagates.yml` marker's `workspace` field into one of three
 * outcomes, never throwing:
 *   - flagged true            -> { isWorkspace: true,  suspicious: null }
 *   - absent or explicit false -> { isWorkspace: false, suspicious: null }
 *   - PRESENT BUT MALFORMED   -> { isWorkspace: false, suspicious: {path, reason} }
 *     (unparseable YAML, or `workspace` present with a non-boolean value,
 *     e.g. a typo'd `workspace: "true"` string or `workspace: yes` parsed
 *     as a plain scalar rather than a boolean)
 *
 * Deliberately does NOT coerce a truthy-looking non-boolean to `true` —
 * that would silently promote a typo'd marker instead of surfacing it.
 * Strict boolean semantics are kept for promotion; the malformed case is
 * routed into `suspicious` so `discoverWorkspacesSync` can report it instead
 * of dropping it on the floor.
 *
 * Sync + dependency-light on purpose: it CANNOT import lib/frontmatter.mjs,
 * which has a top-level await on the ajv schema compile — importing it here
 * would deadlock module load (config.mjs calls discoverWorkspacesSync at
 * module-load time, synchronously).
 */
export function classifyMarker(markerPath) {
  let parsed;
  try {
    parsed = parseYaml(readFileSync(markerPath, "utf8"));
  } catch (err) {
    return {
      isWorkspace: false,
      suspicious: { path: markerPath, reason: `unparseable YAML: ${err.message}` },
    };
  }
  const value = parsed?.workspace;
  if (value === true) return { isWorkspace: true, suspicious: null };
  if (value === undefined || value === false) return { isWorkspace: false, suspicious: null };
  return {
    isWorkspace: false,
    suspicious: {
      path: markerPath,
      reason: `workspace key present but not a strict boolean (got ${JSON.stringify(value)})`,
    },
  };
}

/**
 * Returns true iff the given `.propagates.yml` parses and has `workspace: true`
 * at its top level. Must never throw — a bad marker (malformed YAML, unreadable
 * file, non-object body) is treated as "not a workspace", never bubbled up.
 * Thin wrapper over `classifyMarker` kept for callers that only care about
 * the boolean (e.g. cli.mjs's unreachable-marker sweep).
 */
export function isWorkspaceMarker(markerPath) {
  return classifyMarker(markerPath).isWorkspace;
}

/**
 * Resolve the ledger location for a workspace root.
 *
 * Pinning rule: if a ledger file ALREADY EXISTS at either candidate path, use
 * that one — never relocate a live ledger just because a `docs/` dir showed up
 * later. Only fall back to the `docs/`-exists heuristic when NEITHER ledger
 * file exists yet (i.e. this is a brand-new workspace).
 */
function makeWorkspaceRecord(wsRoot) {
  const name = path.basename(wsRoot);
  const docsDir = path.join(wsRoot, "docs");
  const docsExists = existsSync(docsDir);

  const docsJsonl = path.join(docsDir, "PROPAGATION_LEDGER.jsonl");
  const legacyJsonl = path.join(wsRoot, ".propagation", "ledger.jsonl");

  let docsExistsForLedger;
  if (existsSync(docsJsonl)) {
    docsExistsForLedger = true;
  } else if (existsSync(legacyJsonl)) {
    docsExistsForLedger = false;
  } else {
    docsExistsForLedger = docsExists;
  }

  const ledgerDir = docsExistsForLedger ? docsDir : path.join(wsRoot, ".propagation");
  const ledgerJsonl = docsExistsForLedger
    ? docsJsonl
    : legacyJsonl;
  const ledgerMd = docsExistsForLedger
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
  const suspiciousMarkers = [];
  let markersSeen = 0;

  function walk(dir, depth) {
    if (depth > maxDepth) return;
    // If this dir has a marker, count it. It's only a workspace when the
    // marker explicitly opts in with `workspace: true`. Either way, we
    // ALWAYS keep descending — a marker is an edge declaration by default,
    // not a ledger boundary, and nested workspaces are real (e.g.
    // PanditPawanKaushik/SSJK-mb under PanditPawanKaushik).
    const markerPath = path.join(dir, ".propagates.yml");
    if (existsSync(markerPath)) {
      try {
        const stat = statSync(markerPath);
        if (stat.isFile()) {
          markersSeen += 1;
          const { isWorkspace, suspicious } = classifyMarker(markerPath);
          if (suspicious) suspiciousMarkers.push(suspicious);
          if (isWorkspace && !seen.has(dir)) {
            seen.add(dir);
            try {
              found.push(makeWorkspaceRecord(dir));
            } catch (err) {
              suspiciousMarkers.push({
                path: markerPath,
                reason: `workspace record construction threw: ${err.message}`,
              });
            }
          }
        }
      } catch {
        /* ignore */
      }
    }
    // Descend regardless of marker status.
    if (depth === maxDepth) return;
    for (const sub of listDirs(dir)) {
      walk(sub, depth + 1);
    }
  }

  try {
    for (const root of searchRoots) {
      if (existsSync(root)) walk(root, 0);
    }
  } catch {
    /* discovery must never throw */
  }

  const degraded = markersSeen > 0 && found.length === 0;
  return { workspaces: found, markersSeen, degraded, suspiciousMarkers };
}
