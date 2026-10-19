/**
 * lib/core/hub-state.mjs — finding propagate's moved working state in the private hub.
 *
 * The failure these guard: a reader that finds NO hub and says nothing (a silent pass), and a reader
 * that finds the WRONG directory (a sibling that merely shares the name). Both are built as fixtures
 * here rather than inferred from the live tree, which exists only on one machine.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { hubAbsentReason, hubDocsDir, hubStateDir, hubStateFile } from "../../lib/core/hub-state.mjs";

async function tree({ sidecar = "repo_root: propagate\n", docs = false, files = ["DECISIONS.md"] } = {}) {
  const hub = await mkdtemp(path.join(tmpdir(), "hub-state-"));
  const repo = path.join(hub, "propagate");
  await mkdir(repo, { recursive: true });
  const dir = path.join(hub, "propagation", "state", "propagate");
  await mkdir(dir, { recursive: true });
  if (sidecar !== null) await writeFile(path.join(dir, ".sidecar.yml"), `schema_version: 1\nproject: propagate\n${sidecar}`);
  for (const f of files) await writeFile(path.join(dir, f), "# x\n");
  if (docs) await mkdir(path.join(hub, "propagation", "docs", "propagate"), { recursive: true });
  return { hub, repo, dir };
}

test("a hub whose sidecar names this repo is found, and a moved file resolves inside it", async (t) => {
  const { hub, repo, dir } = await tree({ docs: true });
  t.after(() => rm(hub, { recursive: true, force: true }));
  assert.equal(hubStateDir(repo), dir);
  assert.equal(hubStateFile(repo, "DECISIONS.md"), path.join(dir, "DECISIONS.md"));
  assert.equal(hubDocsDir(repo), path.join(hub, "propagation", "docs", "propagate"));
});

test("a file the hub does not hold is null, not a path that does not exist", async (t) => {
  const { hub, repo } = await tree();
  t.after(() => rm(hub, { recursive: true, force: true }));
  assert.equal(hubStateFile(repo, "STATE.md"), null);
});

test("no hub beside the checkout: every reader gets null (so the caller can skip WITH a reason)", async (t) => {
  const lone = await mkdtemp(path.join(tmpdir(), "hub-state-lone-"));
  t.after(() => rm(lone, { recursive: true, force: true }));
  const repo = path.join(lone, "propagate");
  await mkdir(repo, { recursive: true });
  assert.equal(hubStateDir(repo), null);
  assert.equal(hubStateFile(repo, "DECISIONS.md"), null);
  assert.equal(hubDocsDir(repo), null);
  assert.match(hubAbsentReason("propagation/state/propagate/X.md"), /skipped here, not passed/);
});

test("a same-named directory whose sidecar names ANOTHER repo is not mistaken for ours", async (t) => {
  const { hub, repo } = await tree({ sidecar: "repo_root: somewhere/else\n" });
  t.after(() => rm(hub, { recursive: true, force: true }));
  assert.equal(hubStateDir(repo), null);
});

test("a state directory with no sidecar at all is not a hub copy", async (t) => {
  const { hub, repo } = await tree({ sidecar: null });
  t.after(() => rm(hub, { recursive: true, force: true }));
  assert.equal(hubStateDir(repo), null);
});

test("docs are reported only when the state directory is ours too", async (t) => {
  const { hub, repo } = await tree({ sidecar: "repo_root: other\n", docs: true });
  t.after(() => rm(hub, { recursive: true, force: true }));
  assert.equal(hubDocsDir(repo), null);
});
