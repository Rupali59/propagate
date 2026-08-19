/**
 * Scheduling is optional, and "none" is a first-class answer.
 *
 * launchd was the only path: `launchctl` in doctor/status, `osascript` and
 * terminal-notifier for delivery, plists generated into ~/Library/LaunchAgents.
 * docs/ISSUES.md files that as "macOS-only … no Linux/remote path", deferred by design.
 *
 * But nothing here NEEDS a scheduler. The v1 watcher is retired, `reconcile` derives drift
 * from content in ~1.2s, and `rule:delegation-criteria` §2 prefers derive-on-demand outright.
 * A machine with no scheduler loses proactive notification and nothing else — so that must
 * read as "not configured", never as a failed check. A red tick for an absent optional
 * component is the same lie as a green tick for a broken one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LIB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib", "config.mjs");

function loadWith(configYml, env = {}) {
  const home = mkdtempSync(path.join(tmpdir(), "sched-"));
  const stateDir = path.join(home, ".propagate");
  mkdirSync(stateDir, { recursive: true });
  if (configYml !== undefined) writeFileSync(path.join(stateDir, "config.yml"), configYml);
  const code = `import(${JSON.stringify(LIB)}).then((m) =>
    process.stdout.write(JSON.stringify({ scheduler: m.SCHEDULER ?? null })))`;
  try {
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      env: { ...process.env, HOME: home, PROPAGATE_STATE_DIR: stateDir, ...env },
      encoding: "utf8",
    });
    if (r.status !== 0) return { ok: false, stderr: r.stderr ?? "" };
    return { ok: true, ...JSON.parse(r.stdout) };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("scheduler defaults to launchd on darwin and none elsewhere", () => {
  const r = loadWith(undefined);
  assert.ok(r.ok, r.stderr);
  const expected = process.platform === "darwin" ? "launchd" : "none";
  assert.equal(
    r.scheduler,
    expected,
    "the default must follow the platform — launchd on a machine that has no launchd is a " +
      "declaration that will never come true",
  );
});

test("config.yml can select none, and env beats file", () => {
  assert.equal(loadWith("scheduler: none\n").scheduler, "none");
  assert.equal(
    loadWith("scheduler: none\n", { PROPAGATE_SCHEDULER: "launchd" }).scheduler,
    "launchd",
    "same precedence as every other setting: env > file > default",
  );
});

test("an unknown scheduler falls back to none rather than throwing", () => {
  // config.mjs must never throw at module load — STATE.md known hazards: a throw here
  // bricks watcher, CLI and UI simultaneously. A typo is a typo, not an outage.
  const r = loadWith("scheduler: nonsense\n");
  assert.ok(r.ok, `module load threw on a bad scheduler value:\n${r.stderr}`);
  assert.equal(r.scheduler, "none");
});
