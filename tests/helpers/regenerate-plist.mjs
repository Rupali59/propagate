/**
 * Calls regeneratePlist() with the workspaces given as a JSON array on argv[2]
 * and prints the result as JSON. A dedicated subprocess entrypoint because
 * lib/plist.mjs's PLIST_PATH (via lib/config.mjs's STATE_DIR) is a
 * module-level const resolved at import time from PROPAGATE_STATE_DIR --
 * each test case needs a fresh process, not an in-process re-import (ESM
 * module caching would otherwise reuse the first process's resolved paths).
 */
import { regeneratePlist, PLIST_PATH } from "../../lib/plist.mjs";

const workspaces = JSON.parse(process.argv[2] || "[]");
const result = await regeneratePlist({ workspaces });
console.log(JSON.stringify({ ...result, resolvedPlistPath: PLIST_PATH }));
