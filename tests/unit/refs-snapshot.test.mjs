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
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  SNAPSHOT_SCHEMA_VERSION,
  buildSnapshot,
  diffSnapshots,
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
