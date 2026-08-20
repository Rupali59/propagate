/**
 * Process lock around the watcher.
 *
 * Why: launchd WatchPaths fires per change. Two rapid file changes can
 * spawn two concurrent watcher processes; both would read state.json,
 * compute downstreams, and write — last-writer-wins clobber. Lock makes
 * the work serial.
 */

import lockfile from "proper-lockfile";

/**
 * Acquire the lock with retry. Returns a release function, or null if
 * we couldn't get the lock within the budget (another invocation owns it).
 *
 * @param {string} lockTarget - path to a real file (lock is .lock alongside)
 * @param {object} opts
 * @param {number} opts.retries - max retries
 * @param {number} opts.minDelayMs
 * @param {number} opts.maxDelayMs
 * @returns {Promise<(() => Promise<void>) | null>}
 */
export async function acquireLock(lockTarget, opts = {}) {
  const {
    retries = 8,
    minDelayMs = 100,
    maxDelayMs = 2000,
  } = opts;
  try {
    const release = await lockfile.lock(lockTarget, {
      retries: {
        retries,
        minTimeout: minDelayMs,
        maxTimeout: maxDelayMs,
        factor: 2,
      },
      // Stale: if the lock file is older than this, assume the owner died.
      stale: 60_000,
    });
    return release;
  } catch (err) {
    if (err && err.code === "ELOCKED") return null;
    throw err;
  }
}
