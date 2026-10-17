/**
 * widget-scripts.test.mjs — collect.sh and open-ui.sh run against stubs.
 *
 * WHAT THIS PROVES (plan E1/E2, 2026-10-15). Übersicht has no command timeout and
 * turns ANY stderr into a 500, so collect.sh must be bounded and silent; and a
 * stale `propagate ui` (alive, token rejected) must be replaced only when it is
 * VERIFIED to be `cli.mjs ui`. Every case measures the SIDE EFFECT (processes
 * killed, servers started, what was opened), not the script's own description.
 *
 * Nothing here touches the real UI: node/curl/lsof/ps/open are stubs on PATH.
 */
// @size medium — starts processes (CLI or script); run when affected
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const COLLECT = path.join(ROOT, "widget", "collect.sh");
const OPENUI = path.join(ROOT, "widget", "open-ui.sh");

function sandbox() {
  const dir = mkdtempSync(path.join(tmpdir(), "widget-scripts-"));
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  const home = path.join(dir, "home");
  mkdirSync(path.join(home, "Documents", "GitHub", "propagate"), { recursive: true });
  writeFileSync(path.join(home, "Documents", "GitHub", "propagate", "cli.mjs"), "// stub\n");
  const state = path.join(dir, "state");
  const stub = (name, body) => {
    writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`);
    chmodSync(path.join(bin, name), 0o755);
  };
  return { dir, bin, home, state, stub, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function run(script, sb, env = {}, args = [], timeout = 60000) {
  const t0 = Date.now();
  const r = spawnSync("/bin/bash", [script, ...args], {
    env: { HOME: sb.home, PATH: `${sb.bin}:/usr/bin:/bin`, PROPAGATE_STATE_DIR: sb.state, TMPDIR: sb.dir, ...env },
    encoding: "utf8",
    timeout,
  });
  return { ...r, ms: Date.now() - t0 };
}

// ---------------------------------------------------------------- collect.sh

test("collect.sh: a hung surface is cut at the bound, stdout is exactly the timed-out JSON, stderr empty", () => {
  const sb = sandbox();
  try {
    sb.stub("node", "sleep 60");
    const r = run(COLLECT, sb, { PROPAGATE_NODE: path.join(sb.bin, "node"), PROPAGATE_COLLECT_TIMEOUT: "2" });
    assert.equal(r.stdout, '{"error":"timed out after 2s"}\n');
    assert.equal(r.stderr, "", "stderr must be empty — Übersicht turns any stderr into a 500");
    assert.ok(r.ms < 15000, `returned in ${r.ms}ms; the bound did not hold`);
  } finally { sb.cleanup(); }
});

test("collect.sh: the default bound is 30s (read from the script, not re-measured)", () => {
  assert.match(readFileSync(COLLECT, "utf8"), /PROPAGATE_COLLECT_TIMEOUT:-30\}/);
});

test("collect.sh: node warning on stderr does not reach stderr; JSON survives", () => {
  const sb = sandbox();
  try {
    sb.stub("node", `echo "(node:1) ExperimentalWarning: noisy" >&2\necho '{"ok":true}'`);
    const r = run(COLLECT, sb, { PROPAGATE_NODE: path.join(sb.bin, "node") });
    assert.equal(r.stdout, '{"ok":true}\n');
    assert.equal(r.stderr, "");
  } finally { sb.cleanup(); }
});

test("collect.sh: a failing surface still yields JSON on stdout and nothing on stderr", () => {
  const sb = sandbox();
  try {
    sb.stub("node", `echo boom >&2\nexit 7`);
    const r = run(COLLECT, sb, { PROPAGATE_NODE: path.join(sb.bin, "node") });
    assert.equal(r.stdout, '{"error":"propagate surface exited 7 with no output"}\n');
    assert.equal(r.stderr, "");
  } finally { sb.cleanup(); }
});

// --------------------------------------------------------------- open-ui.sh

const OLD_URL = "http://127.0.0.1:4599/?token=aaaa";
const NEW_URL = "http://127.0.0.1:4599/?token=bbbb";

function uiSandbox({ curlCode, recordedPid, psCommands = {}, holderPid }) {
  const sb = sandbox();
  mkdirSync(sb.state, { recursive: true });
  writeFileSync(path.join(sb.state, "ui-url"), OLD_URL);
  if (recordedPid) writeFileSync(path.join(sb.state, "ui-pid"), String(recordedPid));
  // the "new server": announces a URL then stays alive so its pid can be recorded
  sb.stub("node", `echo "$$ $@" >> "${sb.dir}/node-calls"\necho "propagate ui — ${NEW_URL}"\nexec sleep 30`);
  sb.stub("curl", `echo -n ${curlCode}`);
  // port holder: reported only while that pid is alive (so a real kill frees the port)
  sb.stub("lsof", holderPid ? `kill -0 ${holderPid} 2>/dev/null && echo ${holderPid}; exit 0` : "exit 0");
  const psCases = Object.entries(psCommands)
    .map(([pid, cmd]) => `[ "$4" = "${pid}" ] && { echo ${JSON.stringify(cmd)}; exit 0; }`)
    .join("\n");
  sb.stub("ps", `${psCases}\nexit 1`);
  sb.stub("open", `echo "$1" > "${sb.dir}/opened"`);
  return sb;
}

function env(sb) {
  return { PROPAGATE_NODE: path.join(sb.bin, "node"), PROPAGATE_CLI: path.join(sb.dir, "cli.mjs"), PROPAGATE_OPEN: path.join(sb.bin, "open") };
}
const spawnedServers = (sb) => (existsSync(path.join(sb.dir, "node-calls")) ? readFileSync(path.join(sb.dir, "node-calls"), "utf8").trim().split("\n").filter(Boolean) : []);
const killNewServer = (sb) => {
  try { process.kill(Number(readFileSync(path.join(sb.state, "ui-pid"), "utf8")), "SIGKILL"); } catch { /* already gone */ }
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function spawnVictim() {
  // a real process standing in for the stale server, so a kill is observable
  const r = spawnSync("/bin/bash", ["-c", "sleep 120 >/dev/null 2>&1 & echo $!"], { encoding: "utf8" });
  return Number(r.stdout.trim());
}

test("open-ui.sh (c): a token URL that answers 200 is reused; no server started, URL opened", () => {
  const sb = uiSandbox({ curlCode: 200 });
  try {
    const r = run(OPENUI, sb, env(sb));
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(spawnedServers(sb), []);
    assert.equal(readFileSync(path.join(sb.dir, "opened"), "utf8").trim(), OLD_URL);
  } finally { sb.cleanup(); }
});

test("open-ui.sh (d): stale + recorded pid verified as cli.mjs ui -> old stopped, new started, url+pid rewritten", () => {
  const victim = spawnVictim();
  const sb = uiSandbox({ curlCode: 404, recordedPid: victim, holderPid: victim, psCommands: { [victim]: "node /x/propagate/cli.mjs ui" } });
  try {
    assert.ok(alive(victim));
    const r = run(OPENUI, sb, env(sb));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(alive(victim), false, "the verified stale server must be stopped");
    assert.equal(spawnedServers(sb).length, 1, "exactly one new server");
    assert.equal(readFileSync(path.join(sb.state, "ui-url"), "utf8"), NEW_URL);
    const newPid = Number(readFileSync(path.join(sb.state, "ui-pid"), "utf8"));
    assert.notEqual(newPid, victim);
    assert.equal(readFileSync(path.join(sb.dir, "opened"), "utf8").trim(), NEW_URL);
  } finally { killNewServer(sb); try { process.kill(victim, "SIGKILL"); } catch {} sb.cleanup(); }
});

test("open-ui.sh (e): stale, NO recorded pid, port held -> no second server, no kill, attributable message, non-zero", () => {
  const holder = spawnVictim();
  const sb = uiSandbox({ curlCode: 404, holderPid: holder, psCommands: { [holder]: "node /x/propagate/cli.mjs ui" } });
  try {
    const r = run(OPENUI, sb, env(sb));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, new RegExp(`port 4599 is held by pid ${holder}`));
    assert.deepEqual(spawnedServers(sb), []);
    assert.ok(alive(holder), "an unrecorded process must never be killed, even if it looks like cli.mjs ui");
    assert.equal(existsSync(path.join(sb.dir, "opened")), false);
  } finally { try { process.kill(holder, "SIGKILL"); } catch {} sb.cleanup(); }
});

test("open-ui.sh (f): recorded pid whose command is NOT cli.mjs ui -> not killed, no second server, non-zero", () => {
  const victim = spawnVictim();
  const sb = uiSandbox({ curlCode: 404, recordedPid: victim, holderPid: victim, psCommands: { [victim]: "/usr/bin/python3 some_other_service.py" } });
  try {
    const r = run(OPENUI, sb, env(sb));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /not a propagate ui this script started/);
    assert.ok(alive(victim), "pid reuse: a process that is not cli.mjs ui must survive");
    assert.deepEqual(spawnedServers(sb), []);
  } finally { try { process.kill(victim, "SIGKILL"); } catch {} sb.cleanup(); }
});

test("open-ui.sh: dead (no answer, nothing on the port) -> starts one server and records url+pid", () => {
  const sb = uiSandbox({ curlCode: "000" });
  try {
    const r = run(OPENUI, sb, env(sb));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(spawnedServers(sb).length, 1);
    assert.equal(readFileSync(path.join(sb.state, "ui-url"), "utf8"), NEW_URL);
    assert.match(readFileSync(path.join(sb.state, "ui-pid"), "utf8"), /^\d+$/);
  } finally { killNewServer(sb); sb.cleanup(); }
});
