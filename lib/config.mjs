/**
 * Skill config + paths. Single place to know where things live.
 *
 * V2: workspaces auto-discovered from .propagates.yml markers under
 * SEARCH_ROOTS (instead of hardcoded). Backwards-compatible: callers
 * still import { WORKSPACES } and get the same array shape.
 */

import path from "node:path";
import os from "node:os";

import { discoverWorkspacesSync } from "./discovery.mjs";

const HOME = os.homedir();

export const SKILL_DIR = path.join(HOME, ".claude", "skills", "propagate");

/**
 * Roots under which workspace discovery walks looking for `.propagates.yml`
 * markers. Each root is walked to a configurable max depth (see discovery.mjs).
 *
 * Add additional roots here if you keep code outside ~/Documents/GitHub.
 */
export const SEARCH_ROOTS = [path.join(HOME, "Documents", "GitHub")];

/**
 * Workspaces watched for propagation. Discovered at module-load time
 * (sync) by walking SEARCH_ROOTS for .propagates.yml markers. To onboard a
 * new workspace, drop a .propagates.yml at its root (or use the CLI:
 * `node cli.mjs init <dir>`) and reload the watcher.
 *
 * Each record: { name, root, ledgerJsonl, ledgerMd, scanDirs }
 */
export const WORKSPACES = discoverWorkspacesSync(SEARCH_ROOTS);

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
