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
  writeRegistry,
  refsDir,
} from "../../lib/refs/snapshot.mjs";

/** A repo with `main`, plus an optional merged and unmerged branch. */
async function repo(t, { branches = [] } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "snap-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
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
  t.after(() => rm(dir, { recursive: true, force: true }));
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

test("a branch appearing is `created`, and carries detected_by plus evidence", () => {
  const ev = diffSnapshots(snapOf([]), snapOf([{ ref: "feat", kind: "branch", head: "aaa", merge_state: null }]));
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, "created");
  assert.equal(ev[0].ref, "feat");
  assert.ok(ev[0].detected_by, "a record without detected_by cannot be re-checked later");
  assert.match(ev[0].evidence, /aaa/, "evidence must name what was observed");
});

test("a branch vanishing is `pruned`", () => {
  const ev = diffSnapshots(snapOf([{ ref: "feat", kind: "branch", head: "aaa", merge_state: null }]), snapOf([]));
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, "pruned");
  assert.match(ev[0].evidence, /absent now/);
});

test("unmerged -> merged is a `merged` transition", () => {
  const ev = diffSnapshots(
    snapOf([{ ref: "feat", kind: "branch", head: "aaa", merge_state: "unmerged" }]),
    snapOf([{ ref: "feat", kind: "branch", head: "aaa", merge_state: "merged" }]),
  );
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, "merged");
});

test("unknown -> merged is NOT a merge event", () => {
  // The subtle one. The first run with a base ref flips every branch from null
  // to merged/unmerged. Treating that as a transition would write a merge record
  // for every already-merged branch in the repo, dated the day the registry was
  // switched on — history invented by a change in observation.
  const ev = diffSnapshots(
    snapOf([{ ref: "feat", kind: "branch", head: "aaa", merge_state: null }]),
    snapOf([{ ref: "feat", kind: "branch", head: "aaa", merge_state: "merged" }]),
  );
  assert.deepEqual(ev, [], "first-time observation is not a state change");
});

test("a detached worktree (ref null) is not diffed as a branch", () => {
  const ev = diffSnapshots(
    snapOf([{ ref: null, kind: "worktree", head: "aaa", merge_state: null }]),
    snapOf([]),
  );
  assert.deepEqual(ev, [], "a null ref has no identity to track across snapshots");
});

// ---------------------------------------------------------------------------
// writeRegistry — the safety gate
// ---------------------------------------------------------------------------

test("dry run writes NOTHING — asserted on the directory, not the return value", async (t) => {
  // rule:safety-flag-needs-a-test. Three flags in this tree promised a preview
  // and wrote anyway; each was believed because the function SAID so. This
  // checks the filesystem.
  const ws = await mkdtemp(path.join(tmpdir(), "snap-ws-"));
  t.after(() => rm(ws, { recursive: true, force: true }));
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
  t.after(() => rm(ws, { recursive: true, force: true }));

  const plan = writeRegistry(ws, snapOf([{ ref: "main", kind: "branch", head: "aaa" }]), [], { apply: true });
  assert.equal(plan.applied, true);
  assert.ok(existsSync(plan.snapshot), "snapshot.json must exist");
  assert.ok(existsSync(plan.lifecycle), "lifecycle.jsonl must exist even when empty");
  assert.equal(readFileSync(plan.lifecycle, "utf8"), "", "…and be genuinely empty, not seeded");
  assert.equal(JSON.parse(readFileSync(plan.snapshot, "utf8")).refs.length, 1);
});

test("appending twice does not rewrite the lifecycle log", async (t) => {
  const ws = await mkdtemp(path.join(tmpdir(), "snap-ws3-"));
  t.after(() => rm(ws, { recursive: true, force: true }));
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

test("a worktree and a branch sharing a ref name are TWO rows, not one", () => {
  // enumerateRefs yields both a `worktree` row and a `branch` row for any
  // checked-out branch, so `new Map(refs.map(r => [r.ref, r]))` silently kept
  // whichever came last. Review 2026-08-23; visible in real output, where a
  // fixture repo on `main` produced refs: [worktree main, branch feature-x,
  // branch main] — two rows keyed `main`.
  //
  // Consequence: adding or removing a WORKTREE for a branch that already exists
  // produces no lifecycle event at all, because the branch row masks it. The
  // registry then reports "nothing changed" for a change it was built to record.
  const prev = {
    generated_at: "2026-08-23T00:00:00Z",
    project: "p",
    refs: [{ ref: "main", kind: "branch", head: "aaa" }],
  };
  const next = {
    generated_at: "2026-08-24T00:00:00Z",
    project: "p",
    refs: [
      { ref: "main", kind: "branch", head: "aaa" },
      { ref: "main", kind: "worktree", head: "aaa", path: "/tmp/wt" },
    ],
  };

  const events = diffSnapshots(prev, next);
  const created = events.filter((e) => e.type === "created");
  assert.equal(created.length, 1, `adding a worktree for an existing branch must fire one event, got ${JSON.stringify(events)}`);
  assert.equal(created[0].kind, "worktree", "the event must say WHICH kind appeared, or it is unactionable");
  assert.equal(created[0].ref, "main");
});

test("removing a worktree while the branch stays fires a prune for the worktree only", () => {
  const prev = {
    generated_at: "2026-08-23T00:00:00Z",
    project: "p",
    refs: [
      { ref: "main", kind: "branch", head: "aaa" },
      { ref: "main", kind: "worktree", head: "aaa", path: "/tmp/wt" },
    ],
  };
  const next = {
    generated_at: "2026-08-24T00:00:00Z",
    project: "p",
    refs: [{ ref: "main", kind: "branch", head: "aaa" }],
  };

  const events = diffSnapshots(prev, next);
  const pruned = events.filter((e) => e.type === "pruned");
  assert.equal(pruned.length, 1, `pruning a worktree must fire exactly one event, got ${JSON.stringify(events)}`);
  assert.equal(pruned[0].kind, "worktree", "the branch survived — only the worktree went");
});

test("worktree rows say null for branch-only atoms — never \"\", which claims a question was asked", async (t) => {
  // lib/edges/refs.mjs: `""` is ASKED-AND-NONE, absent is NEVER-ASKED, and
  // upstream_track / last_commit_iso are branch-only. Coercing worktree rows to
  // `""` made every one of them assert a question that was never put to git.
  const dir = await mkdtemp(path.join(tmpdir(), "snap-null-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
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

test("a foreign snapshot shape is REFUSED, never read as an empty ref set", () => {
  // Two incompatible formats both declare schema_version 1. This module writes
  // { schema_version, project, repo_root, refs: [...] }; the pre-existing
  // hygiene/branch-registry writes { captured_at, captured_by, projects: {
  // <name>: { refs: { <branch>: {...} } } } } — and one is LIVE at
  // "Vipin Kaushik/propagation/refs/snapshot.json" carrying 36 refs.
  //
  // Measured 2026-08-24 before the guard: diffSnapshots(shipped, mine) returned
  // 4 `created` and ZERO `pruned`, because `prev?.refs ?? []` turned 36 existing
  // refs into "there was nothing here". Those events append to a log that is
  // append-only by design — the exact damage N27 and N44 already cost twice.
  const foreign = {
    schema_version: 1,
    captured_at: "2026-08-24T03:54:16Z",
    captured_by: "hygiene/branch-registry",
    projects: { alpha: { base_ref: "origin/main", refs: { main: { head: "aaa" } } } },
  };
  const mine = { schema_version: 1, project: "p", generated_at: "2026-08-24T00:00:00Z", refs: [] };

  assert.throws(
    () => diffSnapshots(foreign, mine),
    /refusing to diff|branch-registry/,
    "a foreign shape must refuse loudly, not silently report every ref as created",
  );

  // A genuinely ABSENT previous snapshot is a different fact and stays legal:
  // the first run has nothing to compare against, and everything is `created`.
  assert.doesNotThrow(() => diffSnapshots(null, mine), "null prev is first-run, not corruption");
});

// ---------------------------------------------------------------------------
// A first run is a BASELINE, not a mass creation
// ---------------------------------------------------------------------------

test("with no previous snapshot, one `baseline` event — never `created` per ref", () => {
  // THE FALSE CLAIM THIS FIXES. `created` asserts a ref came into existence
  // between two observations. On a first run there is no previous observation,
  // so every ref got that label and none of it was true — the refs predated us;
  // we merely started looking.
  //
  // The shell registry this module replaces got it right and its wording is
  // adopted verbatim: "no prior snapshot; ref existence before this moment is
  // unknown". 7 such events sit in Vipin Kaushik's lifecycle log today.
  //
  // rule:discernment-checks §2 — absence must be attributable. "I have no
  // prior data" and "these are new" are different facts, and only one of them
  // was being recorded.
  const next = {
    schema_version: 1,
    project: "p",
    generated_at: "2026-08-24T00:00:00Z",
    refs: [
      { ref: "main", kind: "branch", head: "aaa" },
      { ref: "main", kind: "worktree", head: "aaa", path: "/tmp/wt" },
      { ref: "feature", kind: "branch", head: "bbb" },
    ],
  };

  const events = diffSnapshots(null, next);
  assert.equal(events.length, 1, `a first run must emit exactly one event, got ${JSON.stringify(events)}`);

  const [e] = events;
  assert.equal(e.type, "baseline", "the first run is a baseline, not a creation");
  assert.equal(e.ref_count, 3, "the baseline must carry how many refs it saw");
  assert.equal(e.ref, null, "a baseline is about the whole snapshot, not one ref");
  assert.match(
    e.evidence,
    /unknown/i,
    "the baseline must state that existence before this moment is UNKNOWN — that is the whole point",
  );
  assert.equal(e.detected_by, "snapshot-diff");
});

test("an EMPTY previous snapshot is not the same as no previous snapshot", () => {
  // `{refs: []}` means "we looked and there was nothing" — a real observation.
  // `null` means "we never looked". Collapsing them would reintroduce the same
  // defect one level along: a ref appearing after a genuinely empty snapshot IS
  // created, and must not be relabelled a baseline.
  const next = { project: "p", generated_at: "2026-08-24T00:00:00Z", refs: [{ ref: "main", kind: "branch", head: "aaa" }] };

  const fromEmpty = diffSnapshots({ project: "p", refs: [] }, next);
  assert.deepEqual(
    fromEmpty.map((e) => e.type),
    ["created"],
    "a ref appearing after an empty-but-real snapshot is genuinely created",
  );
});

// ---------------------------------------------------------------------------
// Lost-work classification, ported from hygiene/branch-registry.sh
// ---------------------------------------------------------------------------

const pruneFrom = (prevRow) =>
  diffSnapshots(
    { project: "p", refs: [prevRow] },
    { project: "p", generated_at: "2026-08-24T00:00:00Z", refs: [] },
  ).find((e) => e.type === "pruned");

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

test("a worktree row that disappears is not a work-loss question at all", () => {
  // Removing a worktree removes a checkout, not commits. Classifying it would
  // be a category error, and `null` here is a real answer rather than a gap.
  const e = pruneFrom({ ref: "main", kind: "worktree", head: "aaa", path: "/tmp/wt" });
  assert.equal(e.work, null, "worktree removal carries no work-loss verdict");
});

// ---------------------------------------------------------------------------
// The lifecycle log: one live producer, one frozen history
// ---------------------------------------------------------------------------

test("every event this module writes declares `schema: 2`", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "life-schema-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const snap = { schema_version: 1, project: "p", generated_at: "2026-08-24T00:00:00Z", refs: [] };
  const events = diffSnapshots(null, { ...snap, refs: [{ ref: "main", kind: "branch", head: "aaa" }] });
  writeRegistry(dir, snap, events, { apply: true });

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
  t.after(() => rm(dir, { recursive: true, force: true }));
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
