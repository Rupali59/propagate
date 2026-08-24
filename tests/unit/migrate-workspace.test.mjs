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
  sidecarsNamingMoves,
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

const SIDECAR = "sources:\n  STATE.md:\n    propagates_to:\n      - path: README.md\n        why: the summary must not diverge from state\n        kind: prose\n";
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

  const r = await migrateWorkspace({ workspace: ws });

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
  await assert.rejects(
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
  await assert.rejects(() => migrateWorkspace({ workspace: ws, apply: true }), /conflict[\s\S]*Nothing was written/);
  assert.equal(treeSnapshot(ws), before);
});

test("--apply moves the artifact and creates state/workspace/", async (t) => {
  const ws = await workspace(t, { projects: { alpha: { "STATE.md": REAL_STATE } } });
  execFileSync("git", ["init", "-q", ws]);
  execFileSync("git", ["-C", ws, "config", "user.email", "t@e.st"]);
  execFileSync("git", ["-C", ws, "config", "user.name", "t"]);
  execFileSync("git", ["-C", ws, "add", "-A"]);
  execFileSync("git", ["-C", ws, "commit", "-qm", "seed"]);
  const r = await migrateWorkspace({ workspace: ws, apply: true });
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

// ---------------------------------------------------------------------------
// --apply must PRODUCE what the dry run PREVIEWED
// ---------------------------------------------------------------------------

test("--apply creates every item it previewed, and conformance actually flips", async (t) => {
  // Review 2026-08-23: planMigration put all four missing V3_REQUIRED items in
  // plan.creates, and --apply mkdirSync'd only state/workspace. So migrate
  // previewed four artifacts it never wrote, conformanceAfter still reported
  // them missing, and the command could NEVER satisfy the ratchet it exists to
  // satisfy. Root cause one level down: writeRegistry, the only producer of the
  // refs pair, had zero production callers — correct, tested, unreachable.
  // A real artifact, so `git commit` has something to commit — an empty fixture
  // fails with "nothing to commit" and the test dies in setup rather than on
  // the property under test.
  const ws = await workspace(t, { projects: { alpha: { "STATE.md": REAL_STATE } } });
  execFileSync("git", ["init", "-q", ws]);
  execFileSync("git", ["-C", ws, "config", "user.email", "t@e.st"]);
  execFileSync("git", ["-C", ws, "config", "user.name", "t"]);
  execFileSync("git", ["-C", ws, "add", "-A"]);
  execFileSync("git", ["-C", ws, "commit", "-qm", "seed"]);

  const preview = await migrateWorkspace({ workspace: ws });
  assert.equal(preview.applied ?? false, false, "sanity: the preview must not apply");
  assert.ok(preview.creates.length >= 5, `expected the four V3 items plus state/workspace, got ${preview.creates.length}`);

  const r = await migrateWorkspace({ workspace: ws, apply: true });

  // EVERY previewed path exists. Asserting the set, not a sample: the bug was
  // that four of five silently did not happen while one did.
  for (const c of preview.creates) {
    assert.ok(existsSync(c), `previewed create was never written: ${c}`);
  }
  assert.equal(r.conformanceAfter.conforms, true, `conformance did not flip: still missing ${r.conformanceAfter.missing?.join(", ")}`);

  // CONTENT, not just presence. A required file that exists and is empty
  // satisfies V3_REQUIRED while delivering nothing — which is exactly what
  // happened when buildSnapshot was called without await and
  // JSON.stringify(Promise) wrote `{}`. Presence is easy; content is the part
  // conformance cannot check for itself.
  // RESHAPED 2026-08-24 to the per-project shape docs/REFERENCE.md:106-110
  // specifies. The property is unchanged and is the one that matters: a required
  // file that EXISTS but holds nothing satisfies conformance while delivering
  // nothing, which is what happened when buildSnapshot was called without await
  // and JSON.stringify(Promise) wrote `{}`.
  const snap = JSON.parse(readFileSync(path.join(ws, "propagation", "refs", "snapshot.json"), "utf8"));
  assert.equal(snap.schema_version, 2, "snapshot must carry its schema version");
  assert.ok(snap.projects && typeof snap.projects === "object", "the spec keys refs PER PROJECT");
  const totalRefs = Object.values(snap.projects).reduce((n, pr) => n + Object.keys(pr.refs ?? {}).length, 0);
  assert.ok(totalRefs > 0, `a repo with a branch must yield at least one ref, got ${JSON.stringify(Object.keys(snap.projects))}`);
  assert.ok(existsSync(path.join(ws, "propagation", "refs", "lifecycle.jsonl")), "the lifecycle log must exist even when empty");
});

test("two sources claiming ONE destination is a conflict, not two moves", async (t) => {
  // ARTIFACT_LOCATIONS is ["", "docs"], so <project>/STATE.md and
  // <project>/docs/STATE.md compute the same destination. Every existence check
  // in planMigration runs against the PRE-migration tree, so before this guard
  // both looked free and both landed in `moves`.
  //
  // Measured 2026-08-23: --apply moved the first, `git mv` refused the second
  // with "destination exists", and the command exited 1 HAVING ALREADY MUTATED
  // the tree. A half-migrated workspace is exactly what the precondition block
  // exists to prevent, and it could not, because the hazard is invisible in any
  // single artifact — it only exists between two of them.
  //
  // Asserts the TREE, not the message: an exception that arrives after the
  // damage is not a refusal (rule:safety-flag-needs-a-test).
  const ws = await workspace(t, {
    projects: { alpha: { "STATE.md": REAL_STATE, "docs/STATE.md": REAL_STATE.replace("Now", "Now (docs copy)") } },
  });

  const plan = await migrateWorkspace({ workspace: ws });
  assert.equal(plan.moves.length, 0, "neither source may be planned as a move");
  assert.equal(plan.conflicts.length, 2, "both sources must be reported, so the person sees the pair");
  for (const c of plan.conflicts) {
    assert.match(c.reason, /2 sources claim one destination/, `conflict must name the cause: ${c.reason}`);
  }

  const before = treeSnapshot(ws);
  await assert.rejects(() => migrateWorkspace({ workspace: ws, apply: true }), /unresolved conflict/);
  assert.deepEqual(treeSnapshot(ws), before, "a refused migration must leave the tree byte-identical");
});

test("sidecarsNamingMoves matches the RELATIVE path, not the bare basename", async (t) => {
  // Two defects in one function, and it had zero callers so neither could be
  // observed (review 2026-08-23, F10):
  //   - it matched `text.includes(basename)`, and `STATE.md` appears in most of
  //     the ~29 sidecars in this tree, so unrelated ones were flagged;
  //   - the inner loop pushed one hit PER MOVE, so a single sidecar repeated.
  // Both matter because the output is a to-do list a person works through.
  const ws = await workspace(t, {
    projects: {
      alpha: { "STATE.md": REAL_STATE, ".propagates.yml": SIDECAR },
      beta: { "STATE.md": REAL_STATE, ".propagates.yml": SIDECAR },
    },
  });

  const plan = await migrateWorkspace({ workspace: ws });
  assert.equal(plan.moves.length, 2, "sanity: both STATE.md files move");

  const hits = sidecarsNamingMoves(plan, [ws]);
  assert.equal(hits.length, 2, `each sidecar must be named ONCE, for its own file — got ${hits.length}`);

  // The pairing is the point: alpha's sidecar must be tied to alpha's file.
  for (const h of hits) {
    const sidecarProject = path.basename(path.dirname(h.sidecar));
    const movedProject = path.basename(path.dirname(h.names));
    assert.equal(sidecarProject, movedProject, `${sidecarProject}'s sidecar was matched to ${movedProject}'s file`);
    assert.ok(h.suggested, "each hit must carry the replacement path, or it is not actionable");
  }
});
