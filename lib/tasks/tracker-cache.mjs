/**
 * The synchronous half of the GitHub tracker reader: where the last refresh left its result, and
 * how old it is. Read by `backlog()` (which is synchronous and offline, and is called by doctor,
 * the monitor, digest, the dashboard and the rollup), so this file may not import anything that
 * spawns a process or opens a socket. The async half, which does the fetching, is `tracker.mjs`;
 * it re-exports `readTrackerCache` so callers can import both from the one place.
 *
 * WHY A SEPARATE FILE: `tracker.mjs` needs `parseGithubIssuesUrl` from `lib/report/backlog.mjs`,
 * and `backlog.mjs` needs to read the cache. One file holding both would be an import cycle.
 *
 * THE CACHE: `<stateDir>/tracker-cache.json`, `{version, writtenAt, trackers: {<key>: entry}}`,
 * one entry per (repo, label filter). An entry is
 *   { key, repo, labels?, delegatedTo, status: "counted"|"unreadable"|"unsupported", reason?,
 *     open?, capped?, fetchedAt, checkedAt, stale, issues: [{number,title,url,labels,...}] }
 * `fetchedAt` is the last SUCCESSFUL read; `checkedAt` the last attempt. A failed refresh keeps the
 * previous `issues` and sets `stale: true`, so a network blip turns rows grey instead of deleting
 * them (rule:discernment-checks §2: a tracker that could not be read is never "0 open").
 *
 * An absent cache is NOT an empty one: `present: false` and the caller reports every tracker as
 * `not-fetched`, never as 0.
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

import { stateDir as defaultStateDir } from "../core/paths.mjs";

export const TRACKER_CACHE_FILE = "tracker-cache.json";
export const TRACKER_CACHE_VERSION = 1;

/** Absolute path of the cache for a state directory (env-aware by default, G56). */
export function trackerCachePath(dir = defaultStateDir()) {
  return path.join(dir, TRACKER_CACHE_FILE);
}

/**
 * Read the last refresh result. Never throws.
 *
 * @param {{stateDir?: string, now?: number}} [o]
 * @returns {{path: string, present: boolean, error: string|null, writtenAt: string|null,
 *            ageMs: number|null, entries: Record<string, object>}}
 */
export function readTrackerCache({ stateDir = defaultStateDir(), now = Date.now() } = {}) {
  const file = trackerCachePath(stateDir);
  const absent = { path: file, present: false, error: null, writtenAt: null, ageMs: null, entries: {} };
  if (!existsSync(file)) return absent;
  let data;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return { ...absent, error: `${file} could not be read: ${String(err?.message ?? err)}` };
  }
  if (!data || typeof data !== "object" || data.version !== TRACKER_CACHE_VERSION || !data.trackers || typeof data.trackers !== "object") {
    return { ...absent, error: `${file} is not a version-${TRACKER_CACHE_VERSION} tracker cache` };
  }
  const writtenMs = Date.parse(data.writtenAt);
  return {
    path: file,
    present: true,
    error: null,
    writtenAt: Number.isFinite(writtenMs) ? new Date(writtenMs).toISOString() : null,
    ageMs: Number.isFinite(writtenMs) ? Math.max(0, now - writtenMs) : null,
    entries: data.trackers,
  };
}

/** "2 h ago" / "35 s ago" / "unknown age". One wording for the CLI, the dashboard text and the rollup. */
export function formatAge(ageMs) {
  if (typeof ageMs !== "number" || !Number.isFinite(ageMs)) return "unknown age";
  const s = Math.round(ageMs / 1000);
  if (s < 90) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}
