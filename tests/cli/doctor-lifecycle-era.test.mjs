/**
 * doctor's lifecycle-era census must be able to FAIL.
 *
 * `refs/lifecycle.jsonl` is append-only and already holds two eras: this
 * plugin's `schema: 2` events, and 21 events from the retired
 * `hygiene/branch-registry` in the bare `{type:"branch_lifecycle"}` shape.
 * `readLifecycle` classifies every line as current / v1 / refused, and doctor
 * FAILS on `refused` — a line declaring neither era is a shape nobody can
 * account for.
 *
 * Failing on `refused` and NOT on the presence of v1 is the whole design: v1 is
 * frozen history and legitimately sits there forever. A check that went red for
 * v1 would demand rewriting an append-only file, which is the one thing that
 * must never happen to it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "cli.mjs");

function runDoctor(root) {
  return spawnSync(process.execPath, [CLI_PATH, "doctor"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PROPAGATE_SEARCH_ROOTS: root, PROPAGATE_STATE_DIR: root },
  });
}

/** A workspace with a lifecycle log containing exactly `lines`. */
async function workspaceWithLifecycle(t, lines) {
  const root = await mkdtemp(path.join(tmpdir(), "doctor-life-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const ws = path.join(root, "ws");
  await mkdir(path.join(ws, "propagation", "refs"), { recursive: true });
  await writeFile(path.join(ws, ".propagates.yml"), "workspace: true\nsources: {}\n", "utf8");
  await writeFile(path.join(ws, "propagation", "refs", "lifecycle.jsonl"), lines.join("\n") + "\n", "utf8");
  return root;
}

test("doctor FAILS on a lifecycle line that declares no era, and names the reason", async (t) => {
  const root = await workspaceWithLifecycle(t, [
    JSON.stringify({ schema: 2, type: "created", ref: "feat", kind: "branch" }),
    JSON.stringify({ some: "shape", nobody: "declared" }),
  ]);

  const r = runDoctor(root);
  const out = r.stdout + r.stderr;

  assert.match(out, /lifecycle lines are all accountable/, "the check must appear at all");
  assert.match(
    out,
    /declare no schema|declares neither/,
    `the failure must say WHY the line is unaccountable, not just that a count is nonzero:\n${out}`,
  );
  assert.notEqual(r.status, 0, "an unaccountable line must fail doctor, not warn");
});

test("doctor PASSES on frozen v1 history — that file must never be rewritten", async (t) => {
  // The other half of the gate. Asserting only the failure would let a check
  // ship that fails on everything, which is as useless as one that never fails.
  const root = await workspaceWithLifecycle(t, [
    JSON.stringify({ type: "branch_lifecycle", event: "baseline", project: "p", ref_count: 3 }),
    JSON.stringify({ type: "branch_lifecycle", event: "created", project: "p", ref: "main" }),
  ]);

  const out = (({ stdout, stderr }) => stdout + stderr)(runDoctor(root));
  assert.match(out, /lifecycle lines are all accountable/);
  assert.doesNotMatch(
    out,
    /✗.*lifecycle lines are all accountable/,
    `v1 history is legitimate and must not fail the check:\n${out}`,
  );
  assert.match(out, /2 frozen v1/, "and the census must report them as frozen v1, not as current");
});

test("a workspace with no lifecycle log reads as NOT SCANNED, never as clean", async (t) => {
  // Three states, not two. "No workspace has one yet" and "all lines are fine"
  // are different facts (rule:discernment-checks §2).
  const root = await mkdtemp(path.join(tmpdir(), "doctor-life-none-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const ws = path.join(root, "ws");
  await mkdir(ws, { recursive: true });
  await writeFile(path.join(ws, ".propagates.yml"), "workspace: true\nsources: {}\n", "utf8");

  const out = (({ stdout, stderr }) => stdout + stderr)(runDoctor(root));
  assert.match(out, /not scanned, not zero/, `absence must be attributable:\n${out}`);
});
