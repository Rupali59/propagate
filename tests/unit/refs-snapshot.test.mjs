/**
 * lib/refs/snapshot.mjs — the branch registry.
 *
 * WHAT THESE TESTS ARE FOR. `refs/snapshot.json` and `refs/lifecycle.jsonl` are
 * two of the five items v3 conformance demands, and until now NOTHING in the
 * codebase produced them — `lib/core/v3-layout.mjs` had exactly one caller
 * (`doctor`) and it only reported. So these assert a producer that did not
 * exist, against a check that already fails on 6 of 7 workspaces.
 *
 * THE THREE THINGS MOST WORTH GETTING WRONG, and therefore most tested:
 *
 * 1. `merge_state` is TRI-state. There is no `for-each-ref` atom for it
 *    (`%(merged)` and `%(merge_state)` are both `fatal: unknown field name`),
 *    so it is bought with a separate spawn and is UNKNOWN when no base ref was
 *    given. `null` must never collapse to `false` — "nobody asked" and
 *    "checked, not merged" are different facts.
 * 2. `is_active_line` is config-derived, not a git fact. With no active line
 *    declared it is `null`, never `false`.
 * 3. `writeRegistry` is dry-run by default. Three prior `--dry-run` flags in
 *    this tree wrote anyway, so this asserts the DIRECTORY is untouched rather
 *    than trusting the return value.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  SNAPSHOT_SCHEMA_VERSION,
  buildSnapshot,
  diffSnapshots,
  classifyPruned,
  readLifecycle,
  WORKSPACE_SNAPSHOT_SCHEMA,
  writeRegistry,
  refsDir,
} from "../../lib/refs/snapshot.mjs";

/** A repo with `main`, plus an optional merged and unmerged branch. */
async function repo(t, { branches = [] } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "snap-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const git = (...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", stdio: "pipe" });
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  git("config", "user.email", "t@e.st");
  git("config", "user.name", "t");
  await writeFile(path.join(dir, "a.txt"), "a\n");
  git("add", "-A");
  git("commit", "-qm", "one");
  for (const b of branches) {
    git("checkout", "-q", "-b", b);
    if (b.startsWith("un")) {
      await writeFile(path.join(dir, `${b}.txt`), "x\n");
      git("add", "-A");
      git("commit", "-qm", b);
    }
    git("checkout", "-q", "main");
  }
  return { dir, git };
}

// ---------------------------------------------------------------------------
// buildSnapshot
// ---------------------------------------------------------------------------

test("a snapshot carries a schema_version and the refs it found", async (t) => {
  const { dir } = await repo(t);
  const snap = await buildSnapshot(dir, { now: "2026-08-23T00:00:00Z" });
  assert.equal(snap.schema_version, SNAPSHOT_SCHEMA_VERSION);
  assert.equal(snap.error, null);
  assert.ok(snap.refs.length > 0, "a repo with one branch must yield at least one ref");
  assert.equal(snap.generated_at, "2026-08-23T00:00:00Z", "the timestamp is injected, never stamped internally");
});

test("merge_state is null when no base ref was given — never false", async (t) => {
  // The load-bearing tri-state. `false` would assert "checked, not merged" about
  // a question nobody asked.
  const { dir } = await repo(t, { branches: ["unmerged-work"] });
  const snap = await buildSnapshot(dir, { now: "t" });
  for (const r of snap.refs) {
    assert.equal(r.merge_state, null, `${r.ref} must be unknown without a base, got ${r.merge_state}`);
  }
});

test("merge_state distinguishes merged from unmerged once a base is given", async (t) => {
  const { dir, git } = await repo(t, { branches: ["unmerged-work"] });
  git("branch", "already-merged", "main"); // points at main, so trivially merged
  const snap = await buildSnapshot(dir, { baseRef: "main", now: "t" });
  const by = Object.fromEntries(snap.refs.filter((r) => r.kind === "branch").map((r) => [r.ref, r.merge_state]));
  assert.equal(by["already-merged"], "merged");
  assert.equal(by["unmerged-work"], "unmerged", `expected unmerged, got ${by["unmerged-work"]}`);
});

test("is_active_line is null when nobody declared one, and boolean when they did", async (t) => {
  const { dir } = await repo(t, { branches: ["unmerged-work"] });
  const none = await buildSnapshot(dir, { now: "t" });
  assert.ok(none.refs.every((r) => r.is_active_line === null), "no declared active line means unknown, not false");

  const declared = await buildSnapshot(dir, { activeLine: "main", now: "t" });
  const main = declared.refs.find((r) => r.kind === "branch" && r.ref === "main");
  const other = declared.refs.find((r) => r.kind === "branch" && r.ref === "unmerged-work");
  assert.equal(main.is_active_line, true);
  assert.equal(other.is_active_line, false);
});

test("a repo git cannot read is an attributable error, not an empty registry", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "snap-nonrepo-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const snap = await buildSnapshot(path.join(dir, "does-not-exist"), { now: "t" });
  assert.ok(snap.error, "a missing path must report WHY, not return 0 refs silently");
  assert.deepEqual(snap.refs, []);
});

// ---------------------------------------------------------------------------
// diffSnapshots — the lifecycle transitions
// ---------------------------------------------------------------------------

const snapOf = (refs, extra = {}) => ({
  project: "p",
  base_ref: "main",
  generated_at: "2026-08-23T00:00:00Z",
  refs,
  ...extra,
});






// ---------------------------------------------------------------------------
// writeRegistry — the safety gate
// ---------------------------------------------------------------------------

test("dry run writes NOTHING — asserted on the directory, not the return value", async (t) => {
  // rule:safety-flag-needs-a-test. Three flags in this tree promised a preview
  // and wrote anyway; each was believed because the function SAID so. This
  // checks the filesystem.
  const ws = await mkdtemp(path.join(tmpdir(), "snap-ws-"));
  t.after(() => rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const before = readdirSync(ws).sort();

  const plan = writeRegistry(ws, snapOf([{ ref: "main", kind: "branch", head: "aaa" }]), [{ type: "created" }]);

  assert.equal(plan.applied, false);
  assert.deepEqual(readdirSync(ws).sort(), before, "dry run must not create propagation/");
  assert.equal(existsSync(refsDir(ws)), false, "refs/ must not exist after a dry run");
});

test("--apply writes both files, and lifecycle.jsonl exists even with nothing to append", async (t) => {
  // An empty append-only log is a real state — "registered, nothing has changed
  // yet". A MISSING one means "never registered". Conformance requires the file,
  // so the empty case must still create it.
  const ws = await mkdtemp(path.join(tmpdir(), "snap-ws2-"));
  t.after(() => rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  const plan = writeRegistry(ws, snapOf([{ ref: "main", kind: "branch", head: "aaa" }]), [], { apply: true });
  assert.equal(plan.applied, true);
  assert.ok(existsSync(plan.snapshot), "snapshot.json must exist");
  assert.ok(existsSync(plan.lifecycle), "lifecycle.jsonl must exist even when empty");
  assert.equal(readFileSync(plan.lifecycle, "utf8"), "", "…and be genuinely empty, not seeded");
  assert.equal(JSON.parse(readFileSync(plan.snapshot, "utf8")).refs.length, 1);
});

test("appending twice does not rewrite the lifecycle log", async (t) => {
  const ws = await mkdtemp(path.join(tmpdir(), "snap-ws3-"));
  t.after(() => rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const s = snapOf([{ ref: "main", kind: "branch", head: "aaa" }]);
  writeRegistry(ws, s, [{ type: "created", ref: "a" }], { apply: true });
  writeRegistry(ws, s, [{ type: "created", ref: "b" }], { apply: true });
  const lines = readFileSync(path.join(refsDir(ws), "lifecycle.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 2, "append-only means the first record survives the second write");
  assert.equal(JSON.parse(lines[0]).ref, "a");
});

// ---------------------------------------------------------------------------
// A row's identity is (kind, ref) — not ref alone
// ---------------------------------------------------------------------------



test("worktree rows say null for branch-only atoms — never \"\", which claims a question was asked", async (t) => {
  // lib/edges/refs.mjs: `""` is ASKED-AND-NONE, absent is NEVER-ASKED, and
  // upstream_track / last_commit_iso are branch-only. Coercing worktree rows to
  // `""` made every one of them assert a question that was never put to git.
  const dir = await mkdtemp(path.join(tmpdir(), "snap-null-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@e.st"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
  await writeFile(path.join(dir, "f.txt"), "x\n");
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-qm", "seed"]);

  const snap = await buildSnapshot(dir, { now: "2026-08-24T00:00:00Z" });
  const wt = snap.refs.find((r) => r.kind === "worktree");
  assert.ok(wt, "a checked-out repo must yield a worktree row");
  assert.equal(wt.upstream_track, null, "worktree rows never carry an upstream — null, not \"\"");
  assert.equal(wt.last_commit_iso, null, "…same for last_commit_iso");

  // And the branch row keeps `""` where git genuinely answered "no upstream",
  // which is what makes the two states distinguishable at all.
  const br = snap.refs.find((r) => r.kind === "branch");
  assert.ok(br, "a repo with a commit must yield a branch row");
  assert.notEqual(br.upstream_track, undefined, "branch rows must carry the field, even when empty");
});


// ---------------------------------------------------------------------------
// A first run is a BASELINE, not a mass creation
// ---------------------------------------------------------------------------



// ---------------------------------------------------------------------------
// Lost-work classification, ported from hygiene/branch-registry.sh
// ---------------------------------------------------------------------------

/**
 * Reshaped 2026-08-24 for the per-project snapshot `docs/REFERENCE.md` specifies.
 * `classifyPruned` itself is UNCHANGED — it reads a ref's own fields, not the
 * container — so every assertion below still tests exactly what it did before.
 * Only the fixture's shape moved.
 */
const v2 = (projects, at = "2026-08-24T00:00:00Z") => ({
  schema_version: WORKSPACE_SNAPSHOT_SCHEMA,
  captured_at: at,
  captured_by: "test",
  workspace_root: "/ws",
  projects,
  skipped: [],
});
const pruneFrom = (prevRow) => {
  const { ref = "feat", kind = "branch", path: wtPath, ...rest } = prevRow;
  // A worktree row has no home in a ref map; it is a detached entry or an
  // attribute. The kind:"worktree" case below asserts that distinction directly.
  const before =
    kind === "worktree"
      ? { repo_root: "/ws/p", base_ref: null, error: null, refs: {}, detached_worktrees: [{ path: wtPath ?? "/wt", head: rest.head }] }
      : { repo_root: "/ws/p", base_ref: "origin/main", error: null, refs: { [ref]: rest }, detached_worktrees: [] };
  const after = { repo_root: "/ws/p", base_ref: "origin/main", error: null, refs: {}, detached_worktrees: [] };
  return diffSnapshots(v2({ p: before }), v2({ p: after })).find(
    (e) => e.type === "pruned" || e.type === "worktree-removed",
  );
};

test("a pruned ref with unmerged commits and no upstream is LOST", () => {
  // The capability this whole port exists for. Commits unique to the ref, and
  // the ref is gone: they survive nowhere.
  const e = pruneFrom({ ref: "feat", kind: "branch", head: "aaa", merge_state: "unmerged", upstream_track: "" });
  assert.equal(e.work, "lost");
  assert.match(e.evidence, /nowhere else/i, `evidence must say what was lost: ${e.evidence}`);
});

test("…and LOST too when it was pushed but carried unpushed commits (`ahead`)", () => {
  // `upstream` MUST be set here. Without it the no-upstream rule produces
  // `lost` on its own and this test passes while saying nothing about `ahead` —
  // it did exactly that until a mutation removing the ahead check stayed green
  // (rule:discernment-checks §4: a check that passes for the wrong reason is as
  // bad as one that cannot fail).
  const e = pruneFrom({
    ref: "feat", kind: "branch", head: "aaa",
    merge_state: "unmerged", upstream: "origin/feat", upstream_track: "[ahead 2]",
  });
  assert.equal(e.work, "lost", "ahead means the remote does not have those commits either");
  assert.match(e.evidence, /ahead/, "and the evidence must name the unpushed commits");
});

test("pruned, unmerged, pushed and not ahead is RECOVERABLE — named, not silently fine", () => {
  const e = pruneFrom({
    ref: "feat", kind: "branch", head: "aaa", merge_state: "unmerged", upstream_track: "", upstream: "origin/feat",
  });
  assert.equal(e.work, "recoverable");
  assert.match(e.evidence, /origin\/feat/, "evidence must name where it can be recovered from");
});

test("pruned after being merged is SAFE — the commits are in the base ref", () => {
  const e = pruneFrom({ ref: "feat", kind: "branch", head: "aaa", merge_state: "merged", upstream_track: "" });
  assert.equal(e.work, "safe");
});

test("UNMEASURED merge_state is treated as unsafe, never as fine", () => {
  // Ported deliberately, with the shell's reasoning: "we could not establish
  // either. Absence must be attributable, so it is unsafe, not silently fine."
  // A null merge_state with no upstream must NOT be waved through.
  const e = pruneFrom({ ref: "feat", kind: "branch", head: "aaa", merge_state: null, upstream_track: "" });
  assert.equal(e.work, "lost", "unmeasured + no upstream is unsafe, not unknown-and-ignored");
  assert.match(e.evidence, /unmeasured|unknown/i, "and it must SAY the merge state was never established");
});

test("a worktree that disappears is not a work-loss question at all", () => {
  // Removing a worktree removes a checkout, not commits. Classifying it would be
  // a category error. In the spec's shape this surfaces as `worktree-removed`
  // rather than `pruned`, which makes the distinction structural instead of a
  // field somebody has to remember to read.
  const e = pruneFrom({ ref: "main", kind: "worktree", head: "aaa", path: "/tmp/wt" });
  assert.equal(e.type, "worktree-removed", "a checkout going away is not a prune");
  assert.equal(e.work ?? null, null, "and it carries no work-loss verdict");
  assert.equal(e.ref, null, "a detached worktree has no ref, and inventing one would be a lie");
});

// ---------------------------------------------------------------------------
// The lifecycle log: one live producer, one frozen history
// ---------------------------------------------------------------------------

test("every event this module writes declares `schema: 2`", async (t) => {
  // The stamp is applied at the WRITE — the single choke point for what reaches
  // the log — so an event built anywhere cannot arrive undeclared and be read as
  // v1 history by the reader below.
  const dir = await mkdtemp(path.join(tmpdir(), "life-schema-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  const snapshot = v2({
    p: { repo_root: "/ws/p", base_ref: "origin/main", error: null, refs: { main: { head: "aaa", worktrees: [] } }, detached_worktrees: [] },
  });
  const events = diffSnapshots(null, snapshot);
  assert.equal(events.length, 1, "a first run is one baseline");
  writeRegistry(dir, snapshot, events, { apply: true });

  const lines = readFileSync(path.join(dir, "propagation", "refs", "lifecycle.jsonl"), "utf8")
    .split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].schema, 2, "an undeclared event is indistinguishable from the v1 shape");
});

test("readLifecycle separates CURRENT from frozen v1 history, and refuses the undeclared", async (t) => {
  // Vipin Kaushik's log holds 21 events in the shell shape
  // ({type:"branch_lifecycle", event:"created"}). That file is APPEND-ONLY, so
  // it cannot be rewritten — the only honest move is a reader that says which
  // era each line belongs to.
  //
  // This is NOT the "teach the reader both formats" G26 forbids. That rule is
  // about two live PRODUCERS. Here there is one producer going forward and one
  // frozen history, which is the freeze-v1 pattern already chosen for the ledger.
  const dir = await mkdtemp(path.join(tmpdir(), "life-read-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const refs = path.join(dir, "propagation", "refs");
  await mkdir(refs, { recursive: true });
  await writeFile(
    path.join(refs, "lifecycle.jsonl"),
    [
      JSON.stringify({ type: "branch_lifecycle", event: "baseline", project: "Astroclarity", ref_count: 3 }),
      JSON.stringify({ type: "branch_lifecycle", event: "created", project: "Astroclarity", ref: "main" }),
      JSON.stringify({ schema: 2, type: "created", ref: "feat", kind: "branch", project: "p" }),
      JSON.stringify({ some: "shape", nobody: "declared" }),
      "{ not json at all",
    ].join("\n") + "\n",
  );

  const r = readLifecycle(dir);
  assert.equal(r.current.length, 1, "only the schema:2 event is current");
  assert.equal(r.v1.length, 2, "the shell events are readable history");
  assert.equal(r.refused.length, 2, "an undeclared shape and a malformed line are BOTH refused");
  for (const x of r.refused) {
    assert.ok(x.reason, `a refusal must carry its reason, got ${JSON.stringify(x)}`);
  }
  assert.equal(r.total, 5, "every line is accounted for — none silently dropped");
});

test("the real Vipin Kaushik log reads as 21 v1 events and zero current", () => {
  // The live case this contract exists for. If this ever reports `current > 0`
  // without a migration having run, two producers are writing again.
  const vk = "/Users/rupali.b/Documents/GitHub/Vipin Kaushik";
  if (!existsSync(path.join(vk, "propagation", "refs", "lifecycle.jsonl"))) return; // not this machine
  const r = readLifecycle(vk);
  assert.equal(r.refused.length, 0, `the live log must be fully classified, refused: ${JSON.stringify(r.refused)}`);
  assert.equal(r.current.length, 0, "nothing has written schema:2 to VK yet");
  assert.ok(r.v1.length >= 21, `expected at least 21 v1 events, got ${r.v1.length}`);
});

// ---------------------------------------------------------------------------
// MOVED 2026-08-24 — diff behaviour now lives with the shape it tests
// ---------------------------------------------------------------------------
//
// Ten tests left this file for tests/unit/refs-workspace-snapshot.test.mjs when
// `diffSnapshots` adopted the per-project shape `docs/REFERENCE.md:106-110`
// specifies. NOT deleted: every property they asserted has an equivalent there,
// against the real shape rather than the flat one this module briefly wrote —
//
//   created / pruned / merged / unknown->merged  -> the diff section
//   baseline, and empty-prev != null-prev        -> "a project that appears is a
//                                                   baseline for THAT project"
//   worktree vs branch sharing a name (F7)       -> "adding a worktree ... fires
//                                                   worktree-added, not a creation"
//   detached worktree not diffed as a branch     -> "a DETACHED worktree is
//                                                   tracked by path"
//   foreign shape refused                        -> assertKnownShape now keys on
//                                                   schema_version, tested there
//
// What stays HERE is the single-repo primitive: buildSnapshot, writeRegistry,
// readLifecycle, and classifyPruned — none of which changed shape.
