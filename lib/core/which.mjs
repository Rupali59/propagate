/**
 * which.mjs — resolve a binary on PATH, or report it absent.
 *
 * WHY THIS EXISTS. Three call sites hardcoded `/opt/homebrew/bin/<tool>`, which
 * is Apple-Silicon Homebrew specifically. On an Intel Mac (/usr/local/bin), under
 * a version manager, or on Linux, those features were not degraded — they were
 * silently dead, because the absolute path simply did not exist and the failure
 * surfaced as "no results" rather than "tool not found".
 *
 * Returns `null` rather than throwing or guessing. Absence must be attributable
 * (GOTCHAS G2): a caller that gets null can say "rg not installed" instead of
 * reporting an empty search as an answer.
 *
 * No `which`/`where` subprocess: this is called on the module-load path of
 * lib/notify.mjs, and spawning is both the measured hot spot (G6 — "the cost is
 * usually subprocess spawns, not work") and a thing that can fail in ways a
 * directory read cannot.
 */

import { existsSync, statSync } from "node:fs";
import path from "node:path";

/** Cache: PATH does not change within a process, and callers may ask repeatedly. */
const _cache = new Map();

/**
 * @param {string} name bare binary name, e.g. "rg"
 * @returns {string|null} absolute path, or null when not on PATH
 */
export function resolveBin(name) {
  if (typeof name !== "string" || !name.length) return null;
  if (_cache.has(name)) return _cache.get(name);

  let found = null;
  try {
    // Windows would need PATHEXT handling; this skill is POSIX-only today and
    // says so rather than pretending otherwise.
    const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
    for (const dir of dirs) {
      const candidate = path.join(dir, name);
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) {
          found = candidate;
          break;
        }
      } catch {
        // An unreadable PATH entry is not a reason to stop looking at the rest.
      }
    }
  } catch {
    found = null;
  }
  _cache.set(name, found);
  return found;
}

/** True when the binary is available. Sugar for readability at call sites. */
export function hasBin(name) {
  return resolveBin(name) !== null;
}
