/**
 * `propagate surface` — CLI-level coverage for PR-024: text mode must print
 * the `changed` summary that `--json` has always carried.
 *
 * Subprocess-based, isolated PROPAGATE_STATE_DIR per test, same discipline as
 * tests/cli/reminders.test.mjs. Runs against a fresh, empty state dir — no
 * workspaces, no snapshot, no reminders bridge — so the assertions are about
 * the RENDERING contract (the line exists, is positioned correctly, and a
 * null value reads as "could not derive"), not about this machine's live
 * doctor/queue/registers state.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI_PATH = fileURLToPath(new URL("../../cli.mjs", import.meta.url));

function runCli(argv, stateDir) {
  return spawnSync(process.execPath, [CLI_PATH, ...argv], {
    encoding: "utf8",
    env: {
      ...process.env,
      PROPAGATE_STATE_DIR: stateDir,
      PROPAGATE_SEARCH_ROOTS: stateDir, // no workspaces needed for this assertion
    },
  });
}

test("propagate surface (text mode) prints a changed line between the headline and the first group", async (t) => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "surface-state-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));

  const r = runCli(["surface"], stateDir);
  assert.equal(r.status, 0, r.stderr);

  const lines = r.stdout.split("\n");
  const headlineIdx = lines.findIndex((l) => /nothing scanned|of \d+ edges/.test(l));
  assert.ok(headlineIdx !== -1, `expected a headline line, got:\n${r.stdout}`);

  const changedIdx = lines.findIndex((l) => /changed/.test(l));
  assert.ok(changedIdx !== -1, "the changed line must be printed in text mode, not just --json");
  assert.ok(changedIdx > headlineIdx, "changed rides BESIDE the headline, after it");

  const firstGroupIdx = lines.findIndex((l) => l === "" ? false : /^[A-Z]+$/.test(l));
  if (firstGroupIdx !== -1) {
    assert.ok(changedIdx < firstGroupIdx, "changed must appear before the first group (EDGES/REGISTERS/HEALTH), not inside one");
  }
});

test("propagate surface: --json and text mode agree on the changed VALUE (not just presence)", async (t) => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "surface-state-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));

  const json = runCli(["surface", "--json"], stateDir);
  assert.equal(json.status, 0, json.stderr);
  const payload = JSON.parse(json.stdout.trim());

  const text = runCli(["surface"], stateDir);
  assert.equal(text.status, 0, text.stderr);

  if (payload.changed.value == null) {
    // A NULL must never render as "0" or as blank — could-not-derive and
    // nothing-changed are different facts (rule:discernment-checks §2).
    assert.doesNotMatch(text.stdout, /\b0 changed\b/, "a null changed value must not print as a real zero");
    assert.match(text.stdout, /could not derive/);
    assert.match(text.stdout, new RegExp(payload.changed.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } else {
    assert.match(text.stdout, new RegExp(`\\b${payload.changed.value} changed\\b`), "text mode must show the same number --json carries");
  }
});
