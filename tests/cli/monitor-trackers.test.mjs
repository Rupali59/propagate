/**
 * monitor-trackers.test.mjs — the monitor's scheduled run is the background refresher of the GitHub
 * tracker cache (#104, R4), and a failure there must never become a notification.
 *
 * Three properties:
 *   1. `monitor --dry-run` runs NO gh and writes NO cache (rule:safety-flag-needs-a-test: the effect is asserted
 *      on the cache directory, not on the output). A dry run that spends the GitHub REST budget is not dry.
 *   2. a real run refreshes: gh is called and the cache appears (the control for 1).
 *   3. a gh that fails does not fail the run and does not notify: exit 0, the notified store is untouched, and the
 *      stderr line says the refresh was incomplete.
 *
 * HERMETIC: PROPAGATE_STATE_DIR, PROPAGATE_NOTIFIED and PROPAGATE_MONITOR_LOG are temp paths, the search root is
 * a temp tree with no edges, and gh is a script. No notification can be sent because there is nothing to notify.
 */
// @size medium — starts processes (CLI or script); run when affected
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, chmodSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../../cli.mjs", import.meta.url));
const ISSUES = "https://github.com/o/r/issues";
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

function fixture(ghBody) {
  const dir = mkdtempSync(path.join(tmpdir(), "monitor-trk-"));
  const ws = path.join(dir, "ws");
  mkdirSync(ws, { recursive: true });
  writeFileSync(path.join(ws, "TODOS.md"), `# TODOS\n\n**Open work lives in [GitHub issues](${ISSUES}), not in this file.**\n\nThis file was the ledger until 2026-09-18.\n`);
  const gh = path.join(dir, "gh");
  const marker = path.join(dir, "gh-was-called");
  writeFileSync(gh, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n${ghBody}\n`);
  chmodSync(gh, 0o755);
  const state = path.join(dir, "state");
  mkdirSync(state);
  const notified = path.join(dir, "notified.jsonl");
  const run = (args) => spawnSync(process.execPath, [CLI, "monitor", ...args], {
    encoding: "utf8", timeout: 100000,
    env: { ...process.env, PROPAGATE_STATE_DIR: state, PROPAGATE_SEARCH_ROOTS: ws, PROPAGATE_GH_BIN: gh, PROPAGATE_NOTIFIED: notified, PROPAGATE_MONITOR_LOG: path.join(dir, "monitor.log"), NO_COLOR: "1" },
  });
  return { dir, state, marker, notified, run, cache: path.join(state, "tracker-cache.json") };
}
const GOOD = `printf '[{"number":1,"title":"t","html_url":"https://github.com/o/r/issues/1","labels":[]}]'`;

test("monitor --dry-run runs no gh and writes no tracker cache; a real run does both (the control)", () => {
  const f = fixture(GOOD);
  try {
    const before = readdirSync(f.state).sort();
    const dry = f.run(["--dry-run"]);
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(existsSync(f.marker), false, "a dry run must not spend the GitHub REST budget");
    assert.equal(existsSync(f.cache), false, "and must not write the cache");
    assert.deepEqual(readdirSync(f.state).sort(), before.filter((n) => n !== "tracker-cache.json"), "the dry run added nothing to the state directory it could have added the cache to");

    const real = f.run([]);
    assert.equal(real.status, 0, real.stderr);
    assert.equal(existsSync(f.marker), true, "control: the scheduled run refreshes");
    const cache = JSON.parse(readFileSync(f.cache, "utf8"));
    assert.equal(Object.values(cache.trackers)[0].status, "counted");
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("a gh that fails does not fail the monitor and is not a notification: exit 0, nothing recorded as notified, the log line says incomplete", () => {
  const f = fixture(`echo "HTTP 502" >&2\nexit 1`);
  try {
    const r = f.run([]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(f.marker), true, "control: the refresh was attempted");
    assert.match(plain(r.stderr), /GitHub tracker refresh was incomplete \(1 failed, 0 not attempted\)/);
    assert.equal(existsSync(f.notified), false, "an unreadable tracker is not a defect: nothing was notified");
    assert.equal(Object.values(JSON.parse(readFileSync(f.cache, "utf8")).trackers)[0].status, "unreadable");
    assert.match(readFileSync(path.join(f.dir, "monitor.log"), "utf8"), /notified=0/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
