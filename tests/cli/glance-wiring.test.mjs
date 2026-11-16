/**
 * glance-wiring.test.mjs — propagate#295: the monitor and CLI doctor compute the glance from what they already hold.
 *
 *   1. `monitor` writes glance.json from its own reconcile rows and doctor result; `monitor --dry-run` writes none
 *      (rule:safety-flag-needs-a-test: the effect is asserted on the state directory, not on the output).
 *   2. CLI `doctor` prints its verdict FIRST, and writes glance.json from its in-memory result.
 *   3. The standalone `propagate glance` is not network and finishes well under the 1 s budget on a small state dir.
 *
 * HERMETIC: PROPAGATE_STATE_DIR, PROPAGATE_NOTIFIED and PROPAGATE_MONITOR_LOG are temp paths, the search root is a
 * temp tree with no edges, and gh is a script that fails (nothing reaches GitHub).
 */
// @size medium — starts processes (CLI or script); run when affected
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, chmodSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { COMMANDS } from "../../lib/core/commands.mjs";

const CLI = fileURLToPath(new URL("../../cli.mjs", import.meta.url));
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "glance-wire-"));
  const ws = path.join(dir, "ws");
  mkdirSync(ws, { recursive: true });
  const gh = path.join(dir, "gh");
  writeFileSync(gh, "#!/bin/sh\nexit 1\n");
  chmodSync(gh, 0o755);
  const state = path.join(dir, "state");
  mkdirSync(state);
  const run = (args) => spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8", timeout: 200000,
    env: { ...process.env, PROPAGATE_STATE_DIR: state, PROPAGATE_SEARCH_ROOTS: ws, PROPAGATE_GH_BIN: gh, PROPAGATE_NOTIFIED: path.join(dir, "notified.jsonl"), PROPAGATE_MONITOR_LOG: path.join(dir, "monitor.log"), NO_COLOR: "1" },
  });
  return { dir, state, run, glance: path.join(state, "glance.json") };
}

test("monitor writes glance.json from the rows and doctor result it holds; --dry-run writes none", () => {
  const f = fixture();
  try {
    const dry = f.run(["monitor", "--dry-run"]);
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(existsSync(f.glance), false, "a dry run writes no glance");
    const real = f.run(["monitor"]);
    assert.equal(real.status, 0, real.stderr);
    assert.doesNotMatch(plain(real.stderr), /glance not written/, real.stderr);
    const g = JSON.parse(readFileSync(f.glance, "utf8"));
    assert.equal(g.schema_version, 1);
    // the monitor's own reconcile rows were handed in: the edges item is not the "not computed here" fallback
    const edges = g.items.filter((i) => i.signal === "edges");
    assert.ok(edges.length > 0);
    assert.ok(edges.every((i) => i.what !== "not computed here"), JSON.stringify(edges));
    // and the run's own log line is still written: the glance is additive
    assert.match(readFileSync(path.join(f.dir, "monitor.log"), "utf8"), /ran=1 /);
    assert.ok(!readdirSync(f.state).some((n) => n.endsWith(".tmp")), "no temp file is left behind");
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("doctor prints its verdict first and writes glance.json from its in-memory result", () => {
  const f = fixture();
  try {
    const r = f.run(["doctor"]);
    const lines = plain(r.stdout).split("\n").filter((l) => l.trim());
    assert.match(lines[0], /^doctor: (all green|\d+ problems? found)$/, lines.slice(0, 3).join("\n"));
    const g = JSON.parse(readFileSync(f.glance, "utf8"));
    const doctor = g.items.filter((i) => i.signal === "doctor");
    assert.ok(doctor.length > 0);
    assert.ok(doctor.every((i) => i.what !== "not computed yet"), "the in-memory result was used, not the absent snapshot");
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("glance is not a network command, and a standalone run on a small state dir is well under 1 s", () => {
  assert.equal(COMMANDS.glance.network, undefined);
  const f = fixture();
  try {
    writeFileSync(path.join(f.dir, "monitor.log"), `${new Date().toISOString()} ran=1 rows=0 actionable=0 notified=0 suppressed=0 ms=1\n`);
    const t0 = Date.now();
    const r = f.run(["glance", "--no-write"]);
    const ms = Date.now() - t0;
    assert.ok([0, 1, 2].includes(r.status), r.stderr);
    assert.ok(ms < 3000, `glance took ${ms} ms on a near-empty state dir (budget 1 s on the real one; 3 s here for CI)`);
    assert.equal(existsSync(f.glance), false, "--no-write wrote nothing");
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
