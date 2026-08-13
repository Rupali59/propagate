/**
 * Prints the resolved state/lock/heartbeat/log/plist paths as JSON.
 *
 * Exists because lib/config.mjs (and lib/plist.mjs's PLIST_PATH, which is
 * derived from it) compute these as module-level consts at import time --
 * so exercising a different PROPAGATE_STATE_DIR per test case requires a
 * fresh subprocess per case, not an in-process re-import. Run via
 * spawnSync(process.execPath, [this file], { env }).
 */
import { STATE_DIR, STATE_PATH, LOCK_PATH, HEARTBEAT_PATH, WATCHER_LOG, SKILL_DIR } from "../../lib/config.mjs";
import { PLIST_PATH, LABEL } from "../../lib/plist.mjs";

console.log(
  JSON.stringify({
    STATE_DIR,
    STATE_PATH,
    LOCK_PATH,
    HEARTBEAT_PATH,
    WATCHER_LOG,
    PLIST_PATH,
    LABEL,
    SKILL_DIR,
  }),
);
