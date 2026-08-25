/**
 * The update check must reach a human, and must never be able to break the CLI.
 *
 * MEASURED BASELINE, 2026-08-20. `bin/propagate-update-check` was written, verified across
 * five behaviours, and then invoked by NOTHING — the only file mentioning it was itself.
 * With a remote deliberately ahead, `doctor` and `status` each said the word "upgrade"
 * zero times.
 *
 * That is GOTCHAS G48 for the third time in this repo: a drift gate rolled out to seven
 * repos but not this one; N6's edge that could not fire while looking declared; and now a
 * check nobody called. Each time the component was correct and unreachable, and each time
 * the tests passed. So the wiring gets its own test, because "it works" and "it runs" are
 * different claims and only the second one was ever in doubt.
 *
 * The second test is the one that matters more in production: this runs on the hot path of
 * the two commands a person types most, so a failure here must degrade to silence rather
 * than take the CLI down with it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(REPO, "cli.mjs");
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

function run(mode, { remoteVersion, extraEnv = {} } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "propagate-notice-"));
  try {
    const env = { ...process.env, PROPAGATE_STATE_DIR: dir, ...extraEnv };
    if (remoteVersion !== undefined) {
      const f = path.join(dir, "remote-version");
      writeFileSync(f, `${remoteVersion}\n`);
      env.PROPAGATE_REMOTE_VERSION_URL = `file://${f}`;
    }
    const r = spawnSync(process.execPath, [CLI, mode], { encoding: "utf8", env });
    return strip(`${r.stdout ?? ""}${r.stderr ?? ""}`);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

test("a newer remote version reaches the human running `status`", () => {
  const out = run("status", { remoteVersion: "9.9.9" });
  assert.match(out, /9\.9\.9/, `status must surface the available upgrade. Got:\n${out.slice(0, 400)}`);
  assert.match(out, /updateCheck: off/, "and must say how to silence it — a notice you cannot stop is one you route around");
});

test("`doctor` surfaces it too", () => {
  assert.match(run("doctor", { remoteVersion: "9.9.9" }), /9\.9\.9/);
});

test("NEGATIVE CONTROL: an up-to-date remote produces no notice", () => {
  // Without this, the tests above are satisfied by a banner that always prints — which
  // would be noise on every single invocation and the fastest route to being disabled.
  const current = readFileSync(path.join(REPO, "VERSION"), "utf8").trim();
  const out = run("status", { remoteVersion: current });
  assert.doesNotMatch(out, /available:/, `no notice when current. Got:\n${out.slice(0, 400)}`);
});

test("a broken check degrades to silence and never takes the CLI down", () => {
  // The hot path. `status` must still work when the update check cannot: unreachable
  // remote, and the check disabled outright. Both are normal states, not errors.
  const unreachable = run("status", { extraEnv: { PROPAGATE_REMOTE_VERSION_URL: "https://127.0.0.1:1/VERSION" } });
  assert.doesNotMatch(unreachable, /available:/, "offline must be silent");
  assert.match(unreachable, /workspace|no open|GitHub|ledger/i, "and status itself must still have run");

  const off = run("status", { remoteVersion: "9.9.9", extraEnv: { PROPAGATE_UPDATE_CHECK: "off" } });
  assert.doesNotMatch(off, /available:/, "disabled must be silent even when an upgrade exists");
});

test("the check script is present and executable — the wiring has something to call", () => {
  // The failure this whole file exists for: the notice code can be perfect while the
  // script it shells out to is missing, renamed, or not +x, and the only symptom is
  // silence — which is also what "up to date" looks like.
  const script = path.join(REPO, "bin", "propagate-update-check");
  assert.ok(existsSync(script), "bin/propagate-update-check must exist");
  const r = spawnSync(script, [], { encoding: "utf8", env: { ...process.env, PROPAGATE_UPDATE_CHECK: "off" } });
  assert.equal(r.status, 0, "must exit 0 even when disabled");
});
