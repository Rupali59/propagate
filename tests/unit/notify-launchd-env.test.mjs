/**
 * notify-launchd-env.test.mjs — propagate#312: the notifier must resolve under launchd's environment.
 *
 * launchd gives a job PATH=/usr/bin:/bin:/usr/sbin:/sbin (gotcha G-Y), so `resolveBin` alone missed Homebrew and
 * notify() fell to osascript: credited to Script Editor, no click target. The resolution here runs in a CHILD under
 * `env -i`, because this process's PATH is the developer's and would pass for the wrong reason.
 *
 * MUTATION RECORDED: make `homebrewNotifier()` in lib/report/notify.mjs return null -> the first test goes red
 * with "resolved to null" (run by hand; restored).
 *
 * Run: PROPAGATE_STATE_DIR="$(mktemp -d)" node --test tests/unit/notify-launchd-env.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { LAUNCHD_PATH, renderMonitorPlist } from "../../lib/core/plist.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PREFIXES = ["/opt/homebrew/bin", "/usr/local/bin"];
// An isolated HOME, never the runner's (tests/portability/state-isolation.test.mjs, N46).
const HOME = mkdtempSync(path.join(tmpdir(), "notify-env-"));
const installed = PREFIXES.map((d) => path.join(d, "terminal-notifier")).find((p) => existsSync(p));

function resolveUnder(env) {
  const code = `import(${JSON.stringify(path.join(ROOT, "lib/report/notify.mjs"))}).then((m) => console.log(JSON.stringify(m.resolveNotifier())))`;
  const r = spawnSync("/usr/bin/env", ["-i", ...env, process.execPath, "-e", code], { encoding: "utf8" });
  assert.equal(r.status, 0, `child failed: ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split("\n").pop());
}

test("under env -i with launchd's PATH, terminal-notifier is resolved from the Homebrew prefixes", { skip: installed ? false : "terminal-notifier is not installed in /opt/homebrew/bin or /usr/local/bin on this machine" }, () => {
  const got = resolveUnder([`HOME=${HOME}`, "PATH=/usr/bin:/bin:/usr/sbin:/sbin"]);
  assert.equal(got, installed, `resolved to ${got}, expected ${installed}`);
});

test("under env -i with launchd's PATH and no prefix holding it, the answer is null, never a literal path", { skip: installed ? "terminal-notifier is installed here, so the absent case cannot be constructed" : false }, () => {
  assert.equal(resolveUnder([`HOME=${HOME}`, "PATH=/usr/bin:/bin"]), null);
});

test("the monitor plist declares PATH (Homebrew first), LANG and LC_ALL", () => {
  const xml = renderMonitorPlist({ stateDir: "/tmp/x" });
  assert.equal(LAUNCHD_PATH, "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
  for (const [k, v] of [["PATH", LAUNCHD_PATH], ["LANG", "en_US.UTF-8"], ["LC_ALL", "en_US.UTF-8"], ["PROPAGATE_ORIGIN", "monitor"]]) {
    assert.ok(xml.includes(`<key>${k}</key>\n    <string>${v}</string>`), `monitor plist lacks ${k}=${v}`);
  }
});
