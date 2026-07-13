/**
 * State store: mtimes per watched file, last invocation timestamp.
 *
 * Atomic write via temp+rename. On corruption: read .bak, then rebuild
 * from disk (mtime-scan) if .bak is also bad. Never throws to caller —
 * worst case returns an empty state and the next pass repopulates.
 */

import { readFile, writeFile, rename, stat } from "node:fs/promises";
import { existsSync, copyFileSync } from "node:fs";

/**
 * @typedef {Object} State
 * @property {Record<string, number>} mtimes - path -> mtime in ms
 * @property {number} lastRunAt - epoch ms of last successful watcher run
 * @property {number} version - schema version for future migrations
 */

const CURRENT_VERSION = 1;

/** @returns {State} */
function emptyState() {
  return { mtimes: {}, lastRunAt: 0, version: CURRENT_VERSION };
}

/**
 * Read state.json. Falls back to .bak then to empty on parse error.
 * @param {string} statePath
 * @returns {Promise<State>}
 */
export async function readState(statePath) {
  for (const candidate of [statePath, `${statePath}.bak`]) {
    if (!existsSync(candidate)) continue;
    try {
      const raw = await readFile(candidate, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.mtimes) {
        return { ...emptyState(), ...parsed };
      }
    } catch {
      // try next candidate
    }
  }
  return emptyState();
}

/**
 * Write state.json atomically. Rotates current → .bak before writing.
 * Never throws — logs to stderr on failure (watcher continues).
 * @param {string} statePath
 * @param {State} state
 */
export async function writeState(statePath, state) {
  const tmp = `${statePath}.tmp.${process.pid}`;
  const bak = `${statePath}.bak`;
  try {
    // Rotate current to .bak
    if (existsSync(statePath)) {
      try {
        copyFileSync(statePath, bak);
      } catch {
        // best-effort
      }
    }
    await writeFile(tmp, JSON.stringify(state, null, 2));
    await rename(tmp, statePath);
  } catch (err) {
    process.stderr.write(`[propagate] state write failed: ${err.message}\n`);
  }
}

/**
 * Did the given file change since last run?
 * Returns the new mtime if changed; null otherwise.
 */
export async function detectMtimeChange(statePath, filePath, state) {
  let s;
  try {
    s = await stat(filePath);
  } catch {
    return null;
  }
  const last = state.mtimes[filePath];
  const now = s.mtimeMs;
  if (last === undefined || now > last) {
    return now;
  }
  return null;
}

/**
 * GC: drop state.mtimes keys not in keepSet. keepSet must contain every path the
 * watcher still tracks this fire (intra candidates + declared sources + cross edges).
 * Without this, deleted edges leak keys forever and stale keys can mask live drift (adv B1).
 * @param {State} state
 * @param {Set<string>} keepSet
 * @returns {number} keys pruned
 */
export function pruneMtimes(state, keepSet) {
  let pruned = 0;
  for (const key of Object.keys(state.mtimes)) {
    if (!keepSet.has(key)) { delete state.mtimes[key]; pruned++; }
  }
  return pruned;
}
