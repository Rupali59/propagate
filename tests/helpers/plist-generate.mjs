/**
 * Calls regeneratePlist(), writeMonitorPlist() and writeDigestPlist() and prints
 * the results as JSON. Invoked as a subprocess so it can be run from a COPIED
 * skill directory (see tests/portability/plist-relocation.test.mjs) -- SKILL_DIR
 * self-derives from `import.meta.url` at import time, so only running this file
 * from the copy actually exercises "the skill moved" rather than asserting it.
 */
import { regeneratePlist, writeMonitorPlist, writeDigestPlist, PLIST_PATH, MONITOR_PLIST_PATH, DIGEST_PLIST_PATH } from "../../lib/core/plist.mjs";
import { SKILL_DIR } from "../../lib/core/config.mjs";

const workspaces = JSON.parse(process.argv[2] || "[]");
const watcher = await regeneratePlist({ workspaces });
const monitor = await writeMonitorPlist({ workspaces });
const digest = await writeDigestPlist();

console.log(
  JSON.stringify({
    skillDir: SKILL_DIR,
    watcher: { ...watcher, resolvedPath: PLIST_PATH },
    monitor: { ...monitor, resolvedPath: MONITOR_PLIST_PATH },
    digest: { ...digest, resolvedPath: DIGEST_PLIST_PATH },
  }),
);
