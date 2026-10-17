/**
 * widget/open-ui.sh and the stale-BUILD check (outside review F5, 2026-10-15).
 *
 * A server whose token still answers can nonetheless be running OLDER CODE than
 * the files on disk: the page is read from disk per request, the endpoints are
 * whatever the process started with. tests/cli/widget-scripts.test.mjs covers the
 * stale-TOKEN cases; this file covers the build comparison, with the same stubs
 * (curl, lsof, ps, open, and a node that announces a URL and sleeps).
 *
 * The expected id is computed by lib/report/ui-build.mjs on a fixture commands/
 * folder, and the script computes its own with shasum. A pass therefore also
 * proves the two implementations agree on the same bytes.
 */
// @size medium — starts processes (CLI or script); run when affected
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildId } from "../../lib/report/ui-build.mjs";

const OPENUI = path.resolve(import.meta.dirname, "..", "..", "widget", "open-ui.sh");
const OLD_URL = "http://127.0.0.1:4599/?token=aaaa";
const NEW_URL = "http://127.0.0.1:4599/?token=bbbb";

function sandbox({ versionBody, files = true, recordedPid, holderPid, psCommands = {} }) {
  const dir = mkdtempSync(path.join(tmpdir(), "open-ui-build-"));
  const bin = path.join(dir, "bin");
  const state = path.join(dir, "state");
  mkdirSync(bin);
  mkdirSync(state);
  const stub = (name, body) => { writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`); chmodSync(path.join(bin, name), 0o755); };
  if (files) {
    mkdirSync(path.join(dir, "commands", "ui", "css"), { recursive: true });
    writeFileSync(path.join(dir, "commands", "ui.mjs"), "server code\n");
    writeFileSync(path.join(dir, "commands", "ui.client.js"), "client code\n");
    writeFileSync(path.join(dir, "commands", "ui", "css", "10-a.css"), "a{}\n");
    writeFileSync(path.join(dir, "commands", "ui", "css", "90-z.css"), "z{}\n");
  }
  writeFileSync(path.join(state, "ui-url"), OLD_URL);
  if (recordedPid) writeFileSync(path.join(state, "ui-pid"), String(recordedPid));
  // The page answers 200; /api/version answers whatever the scenario says.
  writeFileSync(path.join(dir, "version-body"), versionBody ?? "");
  stub("curl", `case "$*" in *api/version*) cat "${dir}/version-body";; *) echo -n 200;; esac`);
  stub("node", `echo "$$ $@" >> "${dir}/node-calls"\necho "propagate ui — ${NEW_URL}"\nexec sleep 30`);
  stub("lsof", holderPid ? `kill -0 ${holderPid} 2>/dev/null && echo ${holderPid}; exit 0` : "exit 0");
  const psCases = Object.entries(psCommands).map(([pid, cmd]) => `[ "$4" = "${pid}" ] && { echo ${JSON.stringify(cmd)}; exit 0; }`).join("\n");
  stub("ps", `${psCases}\nexit 1`);
  stub("open", `echo "$1" > "${dir}/opened"`);
  return { dir, bin, state, id: files ? buildId(path.join(dir, "commands")) : null, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function run(sb) {
  return spawnSync("/bin/bash", [OPENUI], {
    env: {
      HOME: sb.dir, PATH: `${sb.bin}:/usr/bin:/bin`, PROPAGATE_STATE_DIR: sb.state, TMPDIR: sb.dir,
      PROPAGATE_NODE: path.join(sb.bin, "node"), PROPAGATE_CLI: path.join(sb.dir, "cli.mjs"), PROPAGATE_OPEN: path.join(sb.bin, "open"),
    },
    encoding: "utf8",
    timeout: 60000,
  });
}
const spawned = (sb) => (existsSync(path.join(sb.dir, "node-calls")) ? readFileSync(path.join(sb.dir, "node-calls"), "utf8").trim().split("\n").filter(Boolean) : []);
const victim = () => Number(spawnSync("/bin/bash", ["-c", "sleep 120 >/dev/null 2>&1 & echo $!"], { encoding: "utf8" }).stdout.trim());
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const killNew = (sb) => { try { process.kill(Number(readFileSync(path.join(sb.state, "ui-pid"), "utf8")), "SIGKILL"); } catch { /* none */ } };

test("a live server whose /api/version build MATCHES the files on disk is reused", () => {
  const sb0 = sandbox({ versionBody: "" });
  writeFileSync(path.join(sb0.dir, "version-body"), JSON.stringify({ ok: true, build: sb0.id }));
  try {
    const r = run(sb0);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(spawned(sb0), [], "a current server must not be restarted");
    assert.equal(readFileSync(path.join(sb0.dir, "opened"), "utf8").trim(), OLD_URL);
  } finally { sb0.cleanup(); }
});

test("a live server whose build DIFFERS is replaced -- the verified old pid stopped, one new server started", () => {
  const v = victim();
  const sb = sandbox({ versionBody: JSON.stringify({ ok: true, build: "0000000000000000" }), recordedPid: v, holderPid: v, psCommands: { [v]: "node /x/propagate/cli.mjs ui" } });
  try {
    assert.ok(alive(v));
    const r = run(sb);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(alive(v), false, "the behind server must be stopped");
    assert.equal(spawned(sb).length, 1);
    assert.equal(readFileSync(path.join(sb.state, "ui-url"), "utf8"), NEW_URL);
    assert.equal(readFileSync(path.join(sb.dir, "opened"), "utf8").trim(), NEW_URL);
  } finally { killNew(sb); try { process.kill(v, "SIGKILL"); } catch { /* gone */ } sb.cleanup(); }
});

test("a server too old to HAVE /api/version ('no such endpoint') is behind", () => {
  const v = victim();
  const sb = sandbox({ versionBody: JSON.stringify({ ok: false, error: "no such endpoint" }), recordedPid: v, holderPid: v, psCommands: { [v]: "node /x/propagate/cli.mjs ui" } });
  try {
    const r = run(sb);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(alive(v), false);
    assert.equal(spawned(sb).length, 1);
  } finally { killNew(sb); try { process.kill(v, "SIGKILL"); } catch { /* gone */ } sb.cleanup(); }
});

test("behind, but the holder cannot be identified: nothing is killed or started, and the message names the real reason", () => {
  const holder = victim();
  const sb = sandbox({ versionBody: JSON.stringify({ ok: true, build: "0000000000000000" }), holderPid: holder, psCommands: { [holder]: "node /x/propagate/cli.mjs ui" } });
  try {
    const r = run(sb);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /older code than the files on disk/);
    assert.doesNotMatch(r.stderr, /token is not accepted/, "the old message would blame the token for a build mismatch");
    assert.ok(alive(holder), "an unrecorded process must never be killed");
    assert.deepEqual(spawned(sb), []);
  } finally { try { process.kill(holder, "SIGKILL"); } catch { /* gone */ } sb.cleanup(); }
});

test("cannot tell (unparseable version answer, or no files on disk) is left alone, not restarted", () => {
  const garbled = sandbox({ versionBody: "<html>proxy error</html>" });
  const nofiles = sandbox({ versionBody: JSON.stringify({ ok: true, build: "0000000000000000" }), files: false });
  try {
    for (const sb of [garbled, nofiles]) {
      const r = run(sb);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(spawned(sb), [], "a restart that cannot be justified replaces a healthy UI on every click");
    }
  } finally { garbled.cleanup(); nofiles.cleanup(); }
});

// ── T3 (2026-10-16): ui-url, ui-pid and ui.log were 0644 and the log holds the token URL ──
// Asserted on the FILES' modes after the run, never on anything the script printed.
const modeOf = (f) => (statSync(f).mode & 0o777).toString(8);

test("open-ui.sh leaves ui-url, ui-pid and ui.log at mode 600 -- files it creates AND 0644 ones an older run left behind", () => {
  const v = victim();
  const sb = sandbox({ versionBody: JSON.stringify({ ok: true, build: "0000000000000000" }), recordedPid: v, holderPid: v, psCommands: { [v]: "node /x/propagate/cli.mjs ui" } });
  try {
    // The sandbox wrote ui-url and ui-pid with the default umask; an old ui.log is added the same way.
    writeFileSync(path.join(sb.state, "ui.log"), "old log\n");
    for (const f of ["ui-url", "ui-pid", "ui.log"]) chmodSync(path.join(sb.state, f), 0o644);
    assert.equal(modeOf(path.join(sb.state, "ui-url")), "644");
    const r = run(sb);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(spawned(sb).length, 1, "the scenario must have restarted the server, i.e. rewritten all three files");
    for (const f of ["ui-url", "ui-pid", "ui.log"]) assert.equal(modeOf(path.join(sb.state, f)), "600", `${f} must be owner-only`);
  } finally { killNew(sb); try { process.kill(v, "SIGKILL"); } catch { /* gone */ } sb.cleanup(); }
});

test("open-ui.sh tightens an old 0644 ui-url even when it only REUSES the server (nothing is rewritten)", () => {
  const sb0 = sandbox({ versionBody: "" });
  writeFileSync(path.join(sb0.dir, "version-body"), JSON.stringify({ ok: true, build: sb0.id }));
  try {
    chmodSync(path.join(sb0.state, "ui-url"), 0o644);
    const r = run(sb0);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(spawned(sb0), []);
    assert.equal(modeOf(path.join(sb0.state, "ui-url")), "600");
  } finally { sb0.cleanup(); }
});

test("open-ui.sh CREATES ui-url, ui-pid and ui.log at mode 600 on a cold start (no earlier files for a chmod to rescue)", () => {
  const sb = sandbox({ versionBody: "" });
  try {
    for (const f of ["ui-url", "ui-pid", "ui.log"]) rmSync(path.join(sb.state, f), { force: true });
    const r = run(sb);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(spawned(sb).length, 1, "a cold start must start exactly one server");
    for (const f of ["ui-url", "ui-pid", "ui.log"]) {
      assert.ok(existsSync(path.join(sb.state, f)), `${f} must have been created by this run`);
      assert.equal(modeOf(path.join(sb.state, f)), "600", `${f} must be owner-only without relying on a chmod`);
    }
  } finally { killNew(sb); sb.cleanup(); }
});

// ROTATED (2026-10-16): --rotate-token rewrites ui-token while a running server keeps the old token
// in memory; the plan promised the next click would replace it, and Lane F found nothing did.
test("a rotated token (ui-token differs from ui-url's) replaces the server -- verified pid, one new start", () => {
  const v = victim();
  const sb = sandbox({ versionBody: "", recordedPid: v, holderPid: v, psCommands: { [v]: "node /x/propagate/cli.mjs ui" } });
  writeFileSync(path.join(sb.dir, "version-body"), JSON.stringify({ ok: true, build: sb.id }));
  writeFileSync(path.join(sb.state, "ui-token"), "bbbb\n");
  try {
    const r = run(sb);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(alive(v), false, "the server still on the old token must be stopped");
    assert.equal(spawned(sb).length, 1, "exactly one new server");
    assert.equal(readFileSync(path.join(sb.dir, "opened"), "utf8").trim(), NEW_URL);
  } finally { killNew(sb); try { process.kill(v, "SIGKILL"); } catch { /* gone */ } sb.cleanup(); }
});

test("a token file that MATCHES ui-url is not a rotation: the live server is reused", () => {
  const sb = sandbox({ versionBody: "" });
  writeFileSync(path.join(sb.dir, "version-body"), JSON.stringify({ ok: true, build: sb.id }));
  writeFileSync(path.join(sb.state, "ui-token"), "aaaa\n");
  try {
    const r = run(sb);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(spawned(sb), [], "a matching token must not restart anything");
  } finally { sb.cleanup(); }
});
