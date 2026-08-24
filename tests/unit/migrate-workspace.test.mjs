/**
 * lib/migrate/workspace.mjs — the v3 layout producer.
 *
 * WHAT THE DRY RUN CAUGHT, before a single byte moved. Every one of these tests
 * exists because planning against the real tree surfaced a way this command
 * could destroy state:
 *
 * 1. POINTER STUBS. `Vipin Kaushik` migrated on 2026-08-21 and left a stub at
 *    each old path saying "this file now lives at ...". A naive scan planned 15
 *    moves and would have copied each stub OVER the real file it points at —
 *    the workspace's entire state replaced by signposts to itself.
 * 2. `docs/` IS NOT A PROJECT. A workspace-level `docs/DECISIONS.md` was routed
 *    to `state/docs/` instead of `state/workspace/`.
 * 3. A NESTED WORKSPACE IS NOT A PROJECT. Planning the hub proposed moving
 *    `Keerti/STATE.md` into `GitHub/propagation/state/Keerti/`, hoisting six
 *    workspaces' state into their parent.
 *
 * THREE STATES, NEVER TWO. `move` / `already-migrated` / `conflict`. Collapsing
 * the second into the first is failure 1; collapsing the third into either is
 * how a real divergence gets resolved by whichever write landed last.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  planMigration,
  migrateWorkspace,
  isPointerStub,
  isWorkspaceRoot,
  orphanedByMigration,
} from "../../lib/migrate/workspace.mjs";

/** Recursive snapshot of every file path + content under `root`. */
function treeSnapshot(root) {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else out.push(`${path.relative(root, abs)}::${readFileSync(abs, "utf8")}`);
    }
  };
  if (existsSync(root) && statSync(root).isDirectory()) walk(root);
  return out.join("\n");
}

async function workspace(t, { projects = {}, own = {} } = {}) {
  const ws = await mkdtemp(path.join(tmpdir(), "mig-ws-"));
  t.after(() => rm(ws, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(own)) {
    await mkdir(path.dirname(path.join(ws, name)), { recursive: true });
    await writeFile(path.join(ws, name), content);
  }
  for (const [proj, files] of Object.entries(projects)) {
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(ws, proj, rel);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content);
    }
  }
  return ws;
}

const REAL_STATE = `# STATE — a real one\n${"line\n".repeat(60)}`;
const STUB = "# STATE.md — moved\n\nThis file now lives at `../propagation/state/p/STATE.md`.\n";

// ---------------------------------------------------------------------------
// The safety gate — rule:safety-flag-needs-a-test
// ---------------------------------------------------------------------------

test("dry run writes NOTHING — asserted on the tree, not on the return value", async (t) => {
  // Three `--dry-run` flags in this tree wrote anyway, each believed because the
  // function SAID so. This byte-compares the directory.
  const ws = await workspace(t, { projects: { alpha: { "STATE.md": REAL_STATE } } });
  const before = treeSnapshot(ws);

  const r = migrateWorkspace({ workspace: ws });

  assert.equal(r.applied, false);
  assert.ok(r.moves.length > 0, "the fixture must actually have work to do, or this proves nothing");
  assert.equal(treeSnapshot(ws), before, "a dry run must leave the tree byte-identical");
});

test("a non-repo workspace refuses BEFORE writing, rather than failing partway", async (t) => {
  // `git mv` throws on a non-repo, and it would throw on move N of M — some
  // artifacts relocated, the rest at project level, neither location
  // authoritative. Preconditions are checked before the first write.
  const ws = await workspace(t, {
    projects: { alpha: { "STATE.md": REAL_STATE }, beta: { "STATE.md": REAL_STATE } },
  });
  const before = treeSnapshot(ws);
  assert.throws(
    () => migrateWorkspace({ workspace: ws, apply: true }),
    /not inside a git repository[\s\S]*Nothing was written/,
  );
  assert.equal(treeSnapshot(ws), before, "a refused migration must leave the tree untouched");
});

test("an unresolved conflict refuses the whole migration, writing nothing", async (t) => {
  const ws = await workspace(t, {
    projects: { p: { "STATE.md": REAL_STATE } },
    own: { "propagation/state/p/STATE.md": "# a different real file\n" },
  });
  const before = treeSnapshot(ws);
  assert.throws(() => migrateWorkspace({ workspace: ws, apply: true }), /conflict[\s\S]*Nothing was written/);
  assert.equal(treeSnapshot(ws), before);
});

test("--apply moves the artifact and creates state/workspace/", async (t) => {
  const ws = await workspace(t, { projects: { alpha: { "STATE.md": REAL_STATE } } });
  execFileSync("git", ["init", "-q", ws]);
  execFileSync("git", ["-C", ws, "config", "user.email", "t@e.st"]);
  execFileSync("git", ["-C", ws, "config", "user.name", "t"]);
  execFileSync("git", ["-C", ws, "add", "-A"]);
  execFileSync("git", ["-C", ws, "commit", "-qm", "seed"]);
  const r = migrateWorkspace({ workspace: ws, apply: true });
  assert.equal(r.applied, true);
  assert.ok(existsSync(path.join(ws, "propagation", "state", "workspace")), "state/workspace/ is always created");
  assert.ok(existsSync(path.join(ws, "propagation", "state", "alpha", "STATE.md")), "the artifact landed");
  assert.equal(existsSync(path.join(ws, "alpha", "STATE.md")), false, "…and left project level");
});

// ---------------------------------------------------------------------------
// Pointer stubs — the data-loss case
// ---------------------------------------------------------------------------

test("a stub whose destination exists is `already-migrated`, never moved", async (t) => {
  // The exact Vipin Kaushik shape. Moving this would overwrite the real file.
  const ws = await workspace(t, {
    projects: { p: { "STATE.md": STUB } },
    own: { "propagation/state/p/STATE.md": REAL_STATE },
  });
  const plan = planMigration(ws);
  assert.equal(plan.moves.length, 0, "a stub must never be planned as a move");
  assert.equal(plan.alreadyMigrated.length, 1);
  assert.match(plan.alreadyMigrated[0].reason, /stub/);
});

test("a REAL file whose destination exists is a conflict, not an overwrite", async (t) => {
  const ws = await workspace(t, {
    projects: { p: { "STATE.md": REAL_STATE } },
    own: { "propagation/state/p/STATE.md": "# a different real file\n" },
  });
  const plan = planMigration(ws);
  assert.equal(plan.moves.length, 0, "two real files must never be silently reconciled");
  assert.equal(plan.conflicts.length, 1);
  assert.match(plan.conflicts[0].reason, /NOT a stub/);
});

test("a stub pointing nowhere is a dangling stub, reported not relocated", async (t) => {
  const ws = await workspace(t, { projects: { p: { "STATE.md": STUB } } });
  const plan = planMigration(ws);
  assert.equal(plan.moves.length, 0);
  assert.equal(plan.conflicts.length, 1);
  assert.match(plan.conflicts[0].reason, /dangling/);
});

test("isPointerStub is conservative — a long file saying `moved` is not a stub", () => {
  // Guards the heuristic against eating a real document that happens to discuss
  // a move. A stub is SHORT and self-describing; a decision log is neither.
  const ws = path.join(tmpdir(), `stub-probe-${process.pid}.md`);
  return (async () => {
    await writeFile(ws, `# DECISIONS\n\nThe ledger now lives at propagation/.\n${"detail\n".repeat(80)}`);
    assert.equal(isPointerStub(ws), false, "80 lines is a document, not a signpost");
    await rm(ws, { force: true });
  })();
});

// ---------------------------------------------------------------------------
// What counts as a project
// ---------------------------------------------------------------------------

test("a nested workspace is skipped — the parent must not absorb its state", async (t) => {
  // Planning the hub proposed hoisting six workspaces' state into itself.
  const ws = await workspace(t, {
    projects: {
      "child-ws/propagation/state/workspace": { ".keep": "" },
      "child-ws": { "STATE.md": REAL_STATE },
      realproject: { "STATE.md": REAL_STATE },
    },
  });
  assert.equal(isWorkspaceRoot(path.join(ws, "child-ws")), true, "a propagation/ folder marks a workspace");
  const plan = planMigration(ws);
  const projects = plan.moves.map((m) => m.project);
  assert.ok(!projects.includes("child-ws"), `nested workspace absorbed: ${JSON.stringify(projects)}`);
  assert.ok(projects.includes("realproject"), "a genuine project must still be planned");
});

test("workspace-level artifacts route to state/workspace/, not state/docs/", async (t) => {
  const ws = await workspace(t, { own: { "docs/DECISIONS.md": REAL_STATE } });
  const plan = planMigration(ws);
  assert.equal(plan.moves.length, 1);
  assert.equal(plan.moves[0].project, "workspace", "`docs/` is not a project");
  assert.match(plan.moves[0].to, /state[/\\]workspace[/\\]DECISIONS\.md$/);
});

test("a workspace with nothing to move still plans state/workspace/ and invents no content", async (t) => {
  // Rupali/Obsidian: onboarded, 2 live edges, zero state files. Scaffolding
  // ~56 empty files across the tree would make doctor report a conforming tree
  // in which every new file is a lie.
  const ws = await workspace(t, { projects: { empty: { "README.md": "nothing here\n" } } });
  const plan = planMigration(ws);
  assert.deepEqual(plan.moves, [], "nothing to move");
  assert.ok(
    plan.creates.some((c) => c.endsWith(path.join("state", "workspace"))),
    "state/workspace/ is still created so conformance can be satisfied",
  );
});

// ---------------------------------------------------------------------------
// The accepted loss must be enumerable BEFORE it happens
// ---------------------------------------------------------------------------

test("orphanedByMigration names the edges that lose verification, and only those", async (t) => {
  const ws = await workspace(t, { projects: { alpha: { "STATE.md": REAL_STATE } } });
  const plan = planMigration(ws);
  const moving = plan.moves[0].from;
  const rows = [
    { edge_id: "aaa", state: "CLEAN", source: { path: moving }, downstream: { path: "/elsewhere/x.md" } },
    { edge_id: "bbb", state: "NEVER_VERIFIED", source: { path: moving }, downstream: { path: "/elsewhere/y.md" } },
    { edge_id: "ccc", state: "CLEAN", source: { path: "/untouched/z.md" }, downstream: { path: "/elsewhere/w.md" } },
  ];
  const orphans = orphanedByMigration(rows, plan);
  assert.equal(orphans.length, 2, "both edges touching the moved file are affected");
  const losing = orphans.filter((o) => o.losesVerification);
  assert.equal(losing.length, 1, "only the CLEAN one loses a verification");
  assert.equal(losing[0].edge_id, "aaa");
});
