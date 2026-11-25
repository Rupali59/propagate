import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { findAllSidecarsRecursive } from "../../lib/edges/edges.mjs";

/**
 * Direct coverage for findAllSidecarsRecursive's nested-workspace stop-set
 * (lib/edges.mjs:70 in the pre-fix review). The real nested pairs on disk
 * today are `PanditPawanKaushik` > `PanditPawanKaushik/SSJK-mb` and
 * `ManavDaehi` > `ManavDaehi/Manav-portfolio` — production always calls
 * findAllSidecarsRecursive(root) with the real WORKSPACES default, so these
 * tests pass an explicit `workspaceRoots` second argument (a test-only seam
 * added alongside this file) to exercise the scoping logic against
 * synthetic fixture trees instead of depending on the machine's real,
 * ever-changing workspace set.
 *
 * Rule under test: a parent workspace's sidecar sweep must STOP at a nested
 * workspace root and not claim that child's sidecars — the nested
 * workspace's own sweep is the only one that sees them.
 */

async function makeSidecar(dir, name = ".propagates.yml", body = "sources: {}\n") {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, name), body, "utf8");
}

test("parent sweep excludes a nested workspace's sidecars", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "edges-parent-"));
  await makeSidecar(parent); // parent's own root sidecar

  const child = path.join(parent, "child-mb");
  await makeSidecar(child); // nested workspace's root sidecar
  await makeSidecar(path.join(child, "server")); // deep inside the nested workspace

  const found = await findAllSidecarsRecursive(parent, [parent, child]);
  const rel = found.map((f) => path.relative(parent, f)).sort();

  assert.deepEqual(rel, [".propagates.yml"], "only the parent's own sidecar is claimed");
});

test("the nested workspace's own sweep includes its sidecars", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "edges-parent-"));
  await makeSidecar(parent);

  const child = path.join(parent, "child-mb");
  await makeSidecar(child);
  await makeSidecar(path.join(child, "server"));

  const found = await findAllSidecarsRecursive(child, [parent, child]);
  const rel = found.map((f) => path.relative(child, f)).sort();

  assert.deepEqual(
    rel,
    [".propagates.yml", path.join("server", ".propagates.yml")].sort(),
    "the nested workspace's sweep, rooted at its own root, sees all of its own sidecars",
  );
});

test("a non-workspace subdirectory's sidecars ARE claimed by the parent", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "edges-parent-"));
  await makeSidecar(parent);

  // `docs/` here is a plain edge-declaration sidecar, not a workspace root —
  // it must not appear in the workspaceRoots stop-set.
  const docsDir = path.join(parent, "docs");
  await makeSidecar(docsDir);

  const found = await findAllSidecarsRecursive(parent, [parent]);
  const rel = found.map((f) => path.relative(parent, f)).sort();

  assert.deepEqual(
    rel,
    [".propagates.yml", path.join("docs", ".propagates.yml")].sort(),
    "docs/ is not a workspace root, so its sidecar is claimed by the parent sweep",
  );
});

test("three-level nest: each sidecar is attributed to its NEAREST ancestor workspace", async () => {
  const grandparent = await mkdtemp(path.join(tmpdir(), "edges-gp-"));
  await makeSidecar(grandparent);

  const parent = path.join(grandparent, "parent-ws");
  await makeSidecar(parent);

  const child = path.join(parent, "child-ws");
  await makeSidecar(child);

  const allRoots = [grandparent, parent, child];

  const gpFound = await findAllSidecarsRecursive(grandparent, allRoots);
  assert.deepEqual(
    gpFound.map((f) => path.relative(grandparent, f)).sort(),
    [".propagates.yml"],
    "grandparent sweep stops at parent-ws, never reaches child-ws",
  );

  const parentFound = await findAllSidecarsRecursive(parent, allRoots);
  assert.deepEqual(
    parentFound.map((f) => path.relative(parent, f)).sort(),
    [".propagates.yml"],
    "parent sweep claims its own sidecar but stops at child-ws",
  );

  const childFound = await findAllSidecarsRecursive(child, allRoots);
  assert.deepEqual(
    childFound.map((f) => path.relative(child, f)).sort(),
    [".propagates.yml"],
    "child sweep, rooted at itself, claims its own sidecar",
  );
});

// #373: a git submodule's working tree is another repo vendored at a pin. Its sidecar belongs to that repo's own
// sweep; read from the parent, its relative paths resolve against the wrong root. Mutation (2026-11-23): removing
// the isSubmoduleWorkingTree check in findAllSidecarsRecursive makes the first test fail with core's sidecar claimed.
test("a submodule's working tree is not swept; its sidecar belongs to the submodule's own repo (#373)", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "edges-submodule-"));
  await makeSidecar(parent);
  const core = path.join(parent, "core");
  await makeSidecar(core);
  await writeFile(path.join(core, ".git"), "gitdir: ../.git/modules/core\n", "utf8");

  const found = await findAllSidecarsRecursive(parent, [parent]);
  const rel = found.map((f) => path.relative(parent, f)).sort();
  assert.deepEqual(rel, [".propagates.yml"], "core's sidecar is not claimed by the parent");
});

test("an ordinary nested repo (a .git directory) and a linked worktree's .git file are still swept (#373 controls)", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "edges-submodule-"));
  await makeSidecar(parent);
  const repo = path.join(parent, "nested-repo");
  await makeSidecar(repo);
  await mkdir(path.join(repo, ".git"), { recursive: true });
  const linked = path.join(parent, "linked");
  await makeSidecar(linked);
  await writeFile(path.join(linked, ".git"), "gitdir: /x/repo/.git/worktrees/linked\n", "utf8");

  const found = await findAllSidecarsRecursive(parent, [parent]);
  const rel = found.map((f) => path.relative(parent, f)).sort();
  assert.deepEqual(
    rel,
    [".propagates.yml", path.join("linked", ".propagates.yml"), path.join("nested-repo", ".propagates.yml")].sort(),
  );
});
