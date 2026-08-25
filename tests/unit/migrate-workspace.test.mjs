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
  t.after(() => rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
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
  // CHANGED 2026-08-24. The old path is no longer EMPTY — it holds a pointer
  // stub, which `rule:state-and-decisions` requires and the manual 2026-08-21
  // migration always wrote. Asserting absence here was asserting the defect.
  // What must be true is that the CONTENT moved and what remains is a signpost.
  const leftBehind = path.join(ws, "alpha", "STATE.md");
  assert.ok(existsSync(leftBehind), "a stub stays, so every referrer keeps resolving");
  assert.equal(isPointerStub(leftBehind), true, "…and it is a stub, not the state");
  assert.doesNotMatch(readFileSync(leftBehind, "utf8"), /^## Now/m, "the content is gone from the old path");
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

/**
 * FOURTH WAY THIS COMMAND COULD DESTROY STATE: an UNDECLARED workspace.
 *
 * `isWorkspaceRoot` detects a workspace by two markers — a `propagation/`
 * folder, or `workspace: true`. Both are things a workspace acquires WHEN IT
 * MIGRATES. A workspace that has not begun has neither, so "is a project" and
 * "is a workspace nobody has migrated yet" are the same input, and the guard
 * that calls this "the most destructive thing this module could get wrong"
 * protects only the workspaces that already started.
 *
 * Measured on the real hub 2026-08-24: `Tushar/` (4 artifacts, 3 nested repos)
 * and `Tathya/` (1 artifact, 3 nested repos) were both planned for hoisting
 * into `GitHub/propagation/state/`, cross-repo, history left behind.
 *
 * THE SIGNAL IS CONTAINMENT: a directory that CONTAINS git repos is a
 * workspace, not a project. Verified against all 12 unmarked hub children —
 * zero misclassifications among those carrying artifacts.
 *
 * It is a SEPARATE predicate from `isWorkspaceRoot` on purpose. Declared and
 * inferred are different facts: the declared one is authoritative and silent,
 * the inferred one is a refusal that asks a human to declare. Merging them
 * would make an inference indistinguishable from a decision.
 */

/** A hub containing: a declared workspace, an UNdeclared one, and a plain project. */
async function hubFixture(t, { undeclaredHasArtifact = true } = {}) {
  const hub = await mkdtemp(path.join(tmpdir(), "hub-"));
  t.after(() => rm(hub, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  execFileSync("git", ["init", "-q", hub]);
  const g = (...a) => execFileSync("git", ["-C", hub, ...a], { stdio: ["ignore", "pipe", "pipe"] });
  g("config", "user.email", "t@e.st");
  g("config", "user.name", "t");

  // (a) DECLARED workspace — the existing marker path must keep skipping it.
  await mkdir(path.join(hub, "declared", "propagation"), { recursive: true });
  await writeFile(path.join(hub, "declared", "STATE.md"), "# declared state\n");

  // (c) PLAIN project — an artifact, no nested repos. Must still migrate.
  await mkdir(path.join(hub, "plainproj"), { recursive: true });
  await writeFile(path.join(hub, "plainproj", "STATE.md"), "# plain\n");

  // (b) UNDECLARED workspace — no marker, but it contains a git repo.
  await mkdir(path.join(hub, "undeclared"), { recursive: true });
  if (undeclaredHasArtifact) await writeFile(path.join(hub, "undeclared", "STATE.md"), "# real work\n");

  // Commit the hub BEFORE the nested repo exists. `git add -A` refuses to index
  // a nested repository that has no commit checked out ("does not have a commit
  // checked out"), and committing one that does turns it into a gitlink — which
  // is a different tree shape from the real hub, where the nested repos are
  // simply untracked. Ordering it this way keeps the fixture matching reality:
  // the hub's artifacts are tracked, the nested repo is not.
  g("add", "-A");
  g("commit", "-qm", "seed");

  const nested = path.join(hub, "undeclared", "nested-proj");
  await mkdir(nested, { recursive: true });
  execFileSync("git", ["init", "-q", nested]);
  return hub;
}

test("planMigration RECORDS an undeclared workspace and does not flag a plain project", async (t) => {
  const hub = await hubFixture(t);
  const plan = planMigration(hub);

  const names = (plan.undeclaredWorkspaces ?? []).map((u) => u.project);
  assert.deepEqual(names, ["undeclared"], `expected only "undeclared", got ${JSON.stringify(names)}`);

  // The planner is documented pure — it must still plan the legitimate move, or
  // the dry run cannot show the operator what is at stake.
  assert.ok(
    plan.moves.some((m) => m.project === "plainproj"),
    "a plain project must still be planned for migration",
  );
});

test("--apply REFUSES on an undeclared workspace, and the tree is byte-identical", async (t) => {
  const hub = await hubFixture(t);
  const before = treeSnapshot(hub);

  await assert.rejects(
    () => migrateWorkspace({ workspace: hub, apply: true, now: "2026-08-24T00:00:00Z" }),
    /undeclared/i,
    "the refusal must name the offending directory",
  );

  // ASSERTED ON THE TREE, never on the message. rule:safety-flag-needs-a-test:
  // a guard that trusts the tool's own description of itself is the failure it
  // exists to catch.
  assert.equal(treeSnapshot(hub), before, "a refused migration must write NOTHING");
});

test("--force proceeds, so the guard is provably a guard and not a dead branch", async (t) => {
  // Without this the refusal test passes on a command that can never migrate at
  // all — rule:discernment-checks §1, a check that cannot fail reports success.
  const hub = await hubFixture(t);
  const before = treeSnapshot(hub);

  await migrateWorkspace({ workspace: hub, apply: true, force: true, now: "2026-08-24T00:00:00Z" });

  assert.notEqual(treeSnapshot(hub), before, "--force wrote nothing — the refusal test proves nothing");
  assert.ok(
    existsSync(path.join(hub, "propagation", "state", "undeclared", "STATE.md")),
    "--force must actually hoist the undeclared workspace it was asked to hoist",
  );
});

test("an undeclared workspace with NO artifacts does not block the migration", async (t) => {
  // `Rupali/` and `Anushka/` contain nested repos and zero state artifacts.
  // Refusing there would make the hub permanently unmigratable over a directory
  // that has nothing to lose — an alarm nobody can clear is an alarm nobody reads.
  const hub = await hubFixture(t, { undeclaredHasArtifact: false });
  const plan = planMigration(hub);
  assert.deepEqual(plan.undeclaredWorkspaces ?? [], [], "nothing at stake, nothing to refuse");

  await migrateWorkspace({ workspace: hub, apply: true, now: "2026-08-24T00:00:00Z" });
  assert.ok(existsSync(path.join(hub, "propagation", "state", "plainproj", "STATE.md")));
});

test("a DECLARED workspace is still skipped silently, by the marker and not the inference", async (t) => {
  const hub = await hubFixture(t);
  const plan = planMigration(hub);
  assert.ok(!plan.moves.some((m) => m.project === "declared"), "declared workspaces are not projects");
  assert.ok(
    !(plan.undeclaredWorkspaces ?? []).some((u) => u.project === "declared"),
    "and a declared workspace must never be reported as undeclared — declared beats inferred",
  );
});

/**
 * THE SCAFFOLDED REGISTRY MUST CARRY ITS BASELINE.
 *
 * `migrate` writes `refs/snapshot.json` and `refs/lifecycle.jsonl` as a pair,
 * and passed `[]` for the events — so the log was created EMPTY. `migrate-refs`
 * afterwards then sees a non-null previous snapshot and correctly emits
 * nothing, so the baseline never lands by either route.
 *
 * A `baseline` event is not decoration. It is the record that says *ref
 * existence before this moment is unknown* (G27's first instance). Without it
 * the log has a hole exactly at its origin, and nothing distinguishes "this
 * registry began here" from "nothing has ever happened".
 *
 * Measured on the real hub 2026-08-24: snapshot.json held 10 projects and 63
 * refs while lifecycle.jsonl was 0 bytes. Vipin Kaushik, which was migrated by
 * `migrate-refs` instead, carries one baseline per project.
 */
test("the scaffolded refs registry records a baseline, not an empty log", async (t) => {
  const hub = await hubFixture(t, { undeclaredHasArtifact: false });
  await migrateWorkspace({ workspace: hub, apply: true, now: "2026-08-24T00:00:00Z" });

  const lifePath = path.join(hub, "propagation", "refs", "lifecycle.jsonl");
  assert.ok(existsSync(lifePath), "the pair must exist");

  const events = readFileSync(lifePath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(events.length > 0, "an empty log at origin cannot say when observation began");
  // `type`, NOT `event`. The two lifecycle schemas name the same thing
  // differently and the first version of this test read the v1 field against a
  // v2 log, so it failed with `[null]` on a file that was already correct:
  //   v1 (frozen history)  { type: "branch_lifecycle", event: "baseline", … }
  //   v2 (written now)     { type: "baseline", … }
  // C1c froze v1 as readable history rather than rewriting it, so BOTH shapes
  // exist on disk and a reader that knows only one reports a confident wrong
  // answer — rule:discernment-checks §6.
  assert.ok(
    events.every((e) => e.type === "baseline"),
    `a first capture is ALL baseline — never 'created', which would assert these refs came into ` +
      `existence now. Got: ${JSON.stringify(events.map((e) => e.type))}`,
  );
  assert.ok(events.every((e) => e.schema), "every event carries its declared schema");
});

/**
 * A STUB THAT DOES NOT SAY "moved" IN ITS HEADING IS STILL A STUB.
 *
 * `isPointerStub` matched `now lives at`, `— moved`, or `moved` in the H1. That
 * catches `# DECISIONS — moved` and misses this, which is Motherboard's real
 * `STATE.md` verbatim:
 *
 *     # Motherboard — State
 *     > **Moved 2026-08-21 to [`propagation/state/motherboard/STATE.md`](…).**
 *     > This is a pointer stub, not the state. …
 *
 * The heading is `— State`, not `— moved`; the body says "lives one directory
 * over", not "now lives at". So a file that declares itself a pointer stub in
 * those words was classified as REAL, and `migrate` planned to MOVE it — copying
 * a 17-line signpost on top of the 143-line file it points at.
 *
 * That is the exact failure this suite's header records as already caught once
 * ("a naive scan planned 15 moves and would have copied each stub OVER the real
 * file it points at"), returning in a new shape because the destination
 * directory name differed. Found 2026-08-24 by dry-running the real Motherboard,
 * where the SAME migration produced `conflict` for one stub and `move` for the
 * other — two stubs, two verdicts, which is what made it visible at all.
 */
test("a self-declared pointer stub is detected even when its heading does not say `moved`", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "stub-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  const motherboardStyle = path.join(dir, "STATE.md");
  await writeFile(
    motherboardStyle,
    "# Motherboard — State\n\n" +
      "> **Moved 2026-08-21 to [`propagation/state/motherboard/STATE.md`](propagation/state/motherboard/STATE.md).**\n" +
      ">\n" +
      "> This is a pointer stub, not the state. A fresh clone gets this file; the content\n" +
      "> lives one directory over.\n",
  );
  assert.equal(isPointerStub(motherboardStyle), true, "it says `pointer stub` in so many words");

  // The heading form must keep working — this is a widening, not a replacement.
  const headingStyle = path.join(dir, "DECISIONS.md");
  await writeFile(headingStyle, "# DECISIONS — moved\n\n> **Moved to elsewhere.**\n");
  assert.equal(isPointerStub(headingStyle), true, "the original form still matches");

  // And a REAL state file must not be swept up. A detector that calls everything
  // a stub deletes real state, which is worse than the bug it fixes.
  const real = path.join(dir, "REAL.md");
  await writeFile(real, "# Motherboard — State\n\n## Now\n- T1: something in flight\n- T2: moved the API to a new port\n");
  assert.equal(isPointerStub(real), false, "prose that merely uses the word `moved` is not a stub");
});

/**
 * A MOVE MUST LEAVE A POINTER STUB. The rule says so; the tool did not.
 *
 * `rule:state-and-decisions` states the trade in as many words: "a fresh clone
 * of a project repo gets a pointer stub rather than its state. The stub names
 * the workspace path and the pre-move SHA." The 2026-08-21 manual migration of
 * `Vipin Kaushik` and `Motherboard` left exactly those — which is why
 * `isPointerStub` exists at all, to recognise them on a later pass.
 *
 * `migrate` wrote the `.sidecar.yml` at the DESTINATION and nothing at the
 * source. So every link, gate and doc pointing at the old path broke silently.
 *
 * Measured 2026-08-24, after applying it to ten workspaces before noticing:
 * PanditPawanKaushik's own `check-doc-links` gate blocked the commit with 17
 * broken relative links, every one of them at a path this migration had just
 * emptied. The other nine carry the same latent breakage; PPK is simply the one
 * with a gate that reads links.
 *
 * The stub is not politeness. It is what makes the move non-destructive to
 * everything that referenced the file, and the rule already promised it.
 */
test("every moved artifact leaves a pointer stub naming its new home", async (t) => {
  const hub = await hubFixture(t, { undeclaredHasArtifact: false });
  await migrateWorkspace({ workspace: hub, apply: true, now: "2026-08-24T00:00:00Z" });

  const old = path.join(hub, "plainproj", "STATE.md");
  assert.ok(existsSync(old), "the old path must still resolve, or every referrer breaks");
  assert.equal(isPointerStub(old), true, "and it must be recognisable as a stub, not mistaken for state");

  const body = readFileSync(old, "utf8");
  assert.match(body, /propagation\/state\/plainproj\/STATE\.md/, "it must name the target");
  assert.match(body, /git log --follow/, "and how to reach the history that did not travel");

  // The real file is at the destination, and the stub is NOT it.
  const moved = readFileSync(path.join(hub, "propagation", "state", "plainproj", "STATE.md"), "utf8");
  assert.match(moved, /# plain/, "the destination holds the real content");
  assert.notEqual(body, moved, "the stub is a signpost, not a copy");
});

/**
 * N49 — an UNTRACKED artifact must be refused up front, never halfway through.
 *
 * `git mv` requires a tracked file. On Tushar (v3 Phase E, 2026-08-24) the run
 * died on the third artifact:
 *
 *     refused: Command failed: git mv Tushar/docs/GOTCHAS.md …
 *
 * By then TWO artifacts had already moved and the scaffold files had not been
 * written — the half-migrated state migrate's own conformance message calls
 * "the state that loses data". Nothing was lost, verified by checksum, and
 * `git add` plus a re-run finished it. The defect is the ORDER.
 *
 * `migrateWorkspace` already refuses up front for two whole-run preconditions,
 * precisely so a doomed run writes nothing. Untracked sources are knowable the
 * same way, before the first `git mv`.
 *
 * AND IT MUST NAME EVERY OFFENDER. Unlike "not a git repository", this is
 * per-file: stopping at the first turns one re-run into N re-runs, each
 * discovering the next one.
 *
 * NOT a conflict. A conflict is two real files where one must win; this is one
 * real file the repo has never been told about, and the fix is `git add`.
 */
test("N49: an untracked artifact is refused BEFORE anything moves, naming every one", async (t) => {
  const hub = await mkdtemp(path.join(tmpdir(), "untracked-"));
  t.after(() => rm(hub, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  execFileSync("git", ["init", "-q", hub]);
  const g = (...a) => execFileSync("git", ["-C", hub, ...a], { stdio: ["ignore", "pipe", "pipe"] });
  g("config", "user.email", "t@e.st");
  g("config", "user.name", "t");

  // One TRACKED artifact and TWO untracked ones, so the message can be checked
  // for completeness rather than just for firing.
  await mkdir(path.join(hub, "tracked"), { recursive: true });
  await writeFile(path.join(hub, "tracked", "STATE.md"), "# tracked\n");
  g("add", "-A");
  g("commit", "-qm", "seed");
  for (const p of ["loose-a", "loose-b"]) {
    await mkdir(path.join(hub, p), { recursive: true });
    await writeFile(path.join(hub, p, "STATE.md"), `# ${p}\n`);
  }

  const before = treeSnapshot(hub);
  await assert.rejects(
    () => migrateWorkspace({ workspace: hub, apply: true, now: "2026-08-24T00:00:00Z" }),
    (err) => {
      assert.match(err.message, /untracked/i, "must say what is wrong");
      assert.match(err.message, /loose-a/, "must name the first offender");
      assert.match(err.message, /loose-b/, "and the second — stopping at the first means N re-runs");
      assert.match(err.message, /git add/, "and the fix, because it is not a conflict");
      return true;
    },
  );
  assert.equal(treeSnapshot(hub), before, "a refused run must write NOTHING — asserted on the tree");
});

test("N49: a fully tracked workspace still migrates — the preflight must not block the good case", async (t) => {
  const hub = await hubFixture(t, { undeclaredHasArtifact: false });
  await migrateWorkspace({ workspace: hub, apply: true, now: "2026-08-24T00:00:00Z" });
  assert.ok(existsSync(path.join(hub, "propagation", "state", "plainproj", "STATE.md")));
});
