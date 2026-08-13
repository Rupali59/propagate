/**
 * Skill config + paths. Single place to know where things live.
 *
 * V2: workspaces auto-discovered from .propagates.yml markers under
 * SEARCH_ROOTS (instead of hardcoded). Backwards-compatible: callers
 * still import { WORKSPACES } and get the same array shape.
 */

import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

import { discoverWorkspacesSync } from "./discovery.mjs";

const HOME = os.homedir();

/**
 * Where this skill actually lives, derived from this file's own location.
 *
 * Was hardcoded to ~/.claude/skills/propagate, which meant the skill could not
 * find itself anywhere else -- installed as a marketplace plugin, cloned for
 * development, or run from a worktree, every path built from it pointed at a
 * directory that did not exist. `import.meta.url` is the only self-location
 * that survives being moved.
 */
export const SKILL_DIR = path.resolve(fileURLToPath(import.meta.url), "..", "..");

/**
 * Roots under which workspace discovery walks looking for `.propagates.yml`
 * markers. Each root is walked to a configurable max depth (see discovery.mjs).
 *
 * `~/Documents/GitHub` is this author's layout, not a law. Override with
 * PROPAGATE_SEARCH_ROOTS (colon-separated, like PATH) on any machine that keeps
 * code elsewhere -- without it, discovery on another machine silently finds
 * zero workspaces and the watcher reports healthy forever, which is precisely
 * the "abandoned automation reports itself healthy" failure this skill exists
 * to catch.
 *
 * Nonexistent roots are dropped rather than carried, so a stale entry in the
 * env var cannot make every later walk fail.
 */
export const SEARCH_ROOTS = (() => {
  const raw = process.env.PROPAGATE_SEARCH_ROOTS;
  const candidates = raw
    ? raw.split(":").map((s) => s.trim()).filter(Boolean)
    : [path.join(HOME, "Documents", "GitHub")];
  const usable = candidates.filter((p) => existsSync(p));
  return usable.length ? usable : candidates;
})();

/**
 * Workspaces watched for propagation. Discovered at module-load time
 * (sync) by walking SEARCH_ROOTS for .propagates.yml markers flagged
 * `workspace: true`. To onboard a new workspace, drop a .propagates.yml at
 * its root with `workspace: true` (or use the CLI: `node cli.mjs init
 * <dir>`) and reload the watcher.
 *
 * Each record: { name, root, ledgerJsonl, ledgerMd, scanDirs }
 */
const _discovery = discoverWorkspacesSync(SEARCH_ROOTS);
export const WORKSPACES = _discovery.workspaces;

/**
 * True when `.propagates.yml` markers exist on disk but none opted into
 * `workspace: true` — the exact failure mode of the 2026-08-10 discovery
 * bug (schema rejecting the field before markers used it, or every marker
 * un-flagged). Surfaced so `doctor`/`status` can warn instead of silently
 * reporting zero workspaces as if that were healthy.
 */
export const DISCOVERY_DEGRADED = _discovery.degraded;

/**
 * Partial-loss signal, distinct from DISCOVERY_DEGRADED (which only trips on
 * total collapse — markers seen but zero workspaces found). This is non-empty
 * when ONE marker among several is broken — corrupted YAML, a `workspace` key
 * present but not a strict boolean (e.g. `workspace: "true"`), or an
 * exception while building its workspace record — while the rest of
 * discovery still succeeds. Array of `{path, reason}`. `doctor()` and
 * `status --all --json` must both surface this as a real problem, not a log
 * line — see docs/DECISIONS.md 2026-08-10 "workspace roots become explicit."
 */
export const SUSPICIOUS_MARKERS = _discovery.suspiciousMarkers;

/** State / lock / heartbeat paths (per-skill, not per-workspace). */
export const STATE_PATH = path.join(SKILL_DIR, "state.json");
export const LOCK_PATH = path.join(SKILL_DIR, ".lock-target");
export const HEARTBEAT_PATH = path.join(SKILL_DIR, "heartbeat");
export const WATCHER_LOG = path.join(SKILL_DIR, "watcher.log");

/** Race-guard window — re-read mtime after this delay to avoid mid-edit reads. */
export const MTIME_REVERIFY_DELAY_MS = 3000;

/** Parent-level cross-repo ledger (federated cross edges write here, not per-workspace). */
export const CROSS_LEDGER_JSONL = path.join(SEARCH_ROOTS[0], "PROPAGATION_CROSS_LEDGER.jsonl");
export const CROSS_LEDGER_MD = path.join(SEARCH_ROOTS[0], "PROPAGATION_CROSS_LEDGER.md");
/** Two-allowlist config + schema, kept in the skill dir (NOT a SEARCH_ROOT) to avoid discovery/feedback. */
export const CROSS_ALLOW_PATH = path.join(SKILL_DIR, "cross-allow.yml");
export const CROSS_SCHEMA_PATH = path.join(SKILL_DIR, "propagates-cross.schema.json");
/**
 * Decision-trigger bootstrap cutoff (§4b/G6): DECISIONS.md entries dated BEFORE this
 * are seeded-as-processed silently on first run; entries on/after FIRE once. Matches the
 * decisions-check Affects-tag cutoff so we fire exactly the recent partner decisions.
 */
export const CROSS_TRIGGER_EPOCH = "2026-06-09";

/**
 * Code paths whose values are canonical-with a constitution-doc section.
 *
 * V2: this hardcoded list is deprecated. Per-workspace entries live in
 * `<workspace-root>/.code-canonical.yml` (loaded by lib/code-canonical.mjs).
 * The watcher merges per-workspace entries at scan time.
 *
 * Kept as an empty array for backwards-compat with any callers that
 * import CODE_CANONICAL. New entries should NOT be added here.
 */
export const CODE_CANONICAL = [];
