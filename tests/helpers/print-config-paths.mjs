/**
 * Prints the resolved state/lock/heartbeat/log/plist paths as JSON.
 *
 * Exists because lib/config.mjs (and lib/plist.mjs's PLIST_PATH, which is
 * derived from it) compute these as module-level consts at import time --
 * so exercising a different PROPAGATE_STATE_DIR per test case requires a
 * fresh subprocess per case, not an in-process re-import. Run via
 * spawnSync(process.execPath, [this file], { env }).
 */
import {
  STATE_DIR,
  STATE_PATH,
  LOCK_PATH,
  HEARTBEAT_PATH,
  WATCHER_LOG,
  SKILL_DIR,
  CROSS_ALLOW_PATH,
  CROSS_ALLOW_SHIPPED,
} from "../../lib/core/config.mjs";
import { PLIST_PATH, LABEL } from "../../lib/core/plist.mjs";
import { existsSync } from "node:fs";

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
    CROSS_ALLOW_PATH,
    CROSS_ALLOW_SHIPPED,
    CROSS_ALLOW_PATH_EXISTS: existsSync(CROSS_ALLOW_PATH),
    CROSS_ALLOW_SHIPPED_EXISTS: existsSync(CROSS_ALLOW_SHIPPED),
  }),
);
