/**
 * `buildWorkspaceSnapshot` — the shape `docs/REFERENCE.md:106-110` specifies.
 *
 * THE SPEC PREDATES BOTH IMPLEMENTATIONS:
 *
 *   snapshot.json  derived — branch registry: PER PROJECT a base_ref, and PER REF
 *                            its head, merge_state, upstream, upstream_track,
 *                            last_commit_iso, worktrees, is_active_line.
 *
 * `hygiene/branch-registry.sh` matches it field for field. `buildSnapshot` did not:
 * it describes ONE repo (2 refs of 36 on Vipin Kaushik) and models a worktree as a
 * peer row rather than an attribute of a ref. These tests pin the spec, so the
 * implementation cannot drift from it again without going red.
 *
 * `detached_worktrees` is the one ADDITION to the spec, because a detached worktree
 * has no branch and therefore no key in a ref map — and one is live in Motherboard.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildWorkspaceSnapshot, WORKSPACE_SNAPSHOT_SCHEMA } from "../../lib/refs/snapshot.mjs";

/** The seven fields the spec names, as a set. */
const SPEC_REF_FIELDS = ["head", "merge_state", "upstream", "upstream_track", "last_commit_iso", "worktrees", "is_active_line"];

function git(cwd, ...args) {
  execFileSync("git", ["-C", cwd, ...args], { stdio: ["ignore", "pipe", "pipe"] });
}

/** A workspace repo plus `projects` sibling repos inside it. */
async function workspace(t, { projects = [], detachedIn = null } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "wss-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const init = async (dir) => {
    await mkdir(dir, { recursive: true });
    execFileSync("git", ["init", "-q", dir]);
    git(dir, "config", "user.email", "t@e.st");
    git(dir, "config", "user.name", "t");
    await writeFile(path.join(dir, "f.txt"), "x\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "seed");
  };
  await init(root);
  await writeFile(path.join(root, ".propagates.yml"), "workspace: true\nsources: {}\n");
  for (const p of projects) await init(path.join(root, p));
  if (detachedIn) {
    const repo = path.join(root, detachedIn);
    const sha = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    git(repo, "worktree", "add", "--detach", path.join(repo, ".worktrees", "det"), sha);
  }
  return root;
}

test("the snapshot is keyed PER PROJECT, with the workspace repo under `workspace`", async (t) => {
  // The defect this pins: buildSnapshot described one repo, so on a workspace with
  // 6 project repos it reported 2 refs of 36 and every test passed because the
  // fixture had a single repo.
  const root = await workspace(t, { projects: ["alpha", "beta"] });
  const snap = await buildWorkspaceSnapshot(root, { now: "2026-08-24T00:00:00Z" });

  assert.equal(snap.schema_version, WORKSPACE_SNAPSHOT_SCHEMA);
  assert.deepEqual(
    Object.keys(snap.projects).sort(),
    ["alpha", "beta", "workspace"],
    "the workspace repo is a project too, under the key `workspace`",
  );
  for (const [name, p] of Object.entries(snap.projects)) {
    assert.ok(p.repo_root, `${name} must name its repo root`);
    assert.ok("base_ref" in p, `${name} must carry base_ref, per the spec`);
    assert.ok("error" in p, `${name} must carry error explicitly — omission is the silent zero`);
  }
});

test("every ref carries exactly the seven fields the spec names", async (t) => {
  const root = await workspace(t, { projects: ["alpha"] });
  const snap = await buildWorkspaceSnapshot(root, { now: "2026-08-24T00:00:00Z" });

  const refs = snap.projects.alpha.refs;
  const names = Object.keys(refs);
  assert.ok(names.length > 0, "a seeded repo must yield at least one branch");
  for (const n of names) {
    for (const f of SPEC_REF_FIELDS) {
      assert.ok(f in refs[n], `ref ${n} is missing the spec field ${f}`);
    }
    assert.ok(Array.isArray(refs[n].worktrees), "worktrees is an ATTRIBUTE of a ref, an array of paths");
  }
});

test("a checked-out branch names its worktree path, rather than becoming a second row", async (t) => {
  // F7's defect (a worktree row masked by its branch row) cannot occur in this
  // shape at all. The OUTCOME F7 protected still must hold: the worktree is visible.
  const root = await workspace(t, { projects: ["alpha"] });
  const snap = await buildWorkspaceSnapshot(root, { now: "2026-08-24T00:00:00Z" });

  const refs = snap.projects.alpha.refs;
  const checkedOut = Object.entries(refs).filter(([, r]) => r.worktrees.length > 0);
  assert.equal(checkedOut.length, 1, `exactly one branch is checked out, got ${JSON.stringify(Object.keys(refs))}`);
  assert.match(checkedOut[0][1].worktrees[0], /alpha$/, "and it names the checkout path");
});

test("a DETACHED worktree appears in detached_worktrees — it has no ref to hide behind", async (t) => {
  // Live case: Motherboard has one. `ref` is null for a detached worktree, and the
  // old diff filtered rows on `r.ref` being truthy, so it was invisible everywhere.
  const root = await workspace(t, { projects: ["alpha"], detachedIn: "alpha" });
  const snap = await buildWorkspaceSnapshot(root, { now: "2026-08-24T00:00:00Z" });

  const det = snap.projects.alpha.detached_worktrees;
  assert.ok(Array.isArray(det), "detached_worktrees must always be present, even empty");
  assert.equal(det.length, 1, `the detached worktree must be recorded, got ${JSON.stringify(det)}`);
  assert.ok(det[0].path && det[0].head, "with a path and a head, or it is not actionable");
});

test("a project whose repo cannot be read appears WITH ITS ERROR, never as a missing key", async (t) => {
  const root = await workspace(t, { projects: ["alpha"] });
  // A plain directory, not a repo — reachable, but git cannot answer for it.
  await mkdir(path.join(root, "notarepo", "sub"), { recursive: true });
  const snap = await buildWorkspaceSnapshot(root, { now: "2026-08-24T00:00:00Z" });

  // It is either absent-because-not-a-repo (a defensible choice) or present with an
  // error — but never present-and-silently-empty, which reads as "no branches".
  const p = snap.projects.notarepo;
  if (p) {
    assert.ok(p.error, "a project that is present must say why it has no refs");
    assert.deepEqual(p.refs, {}, "and carry no invented refs");
  }
  assert.ok(Array.isArray(snap.skipped), "non-repo children must be reported as skipped, with reasons");
  assert.ok(
    snap.skipped.some((s) => s.name === "notarepo" && s.reason),
    `notarepo must be named in skipped with a reason: ${JSON.stringify(snap.skipped)}`,
  );
});

test("a SYMLINKED child is skipped with a reason, not followed", async (t) => {
  // The hub contains skills-marketplace/propagate -> ../propagate. Following a
  // symlink would register the plugin as a hub project and duplicate its own
  // workspace (G31, G58, G4 — nested scopes multiply every finding).
  const { symlink } = await import("node:fs/promises");
  const root = await workspace(t, { projects: ["alpha"] });
  await symlink(path.join(root, "alpha"), path.join(root, "alpha-link"));

  const snap = await buildWorkspaceSnapshot(root, { now: "2026-08-24T00:00:00Z" });
  assert.ok(!snap.projects["alpha-link"], "a symlinked child must not become a project");
  assert.ok(
    snap.skipped.some((s) => s.name === "alpha-link" && /symlink/i.test(s.reason)),
    `and must be reported as skipped for that reason: ${JSON.stringify(snap.skipped)}`,
  );
});

// ---------------------------------------------------------------------------
// diffSnapshots over the spec shape
// ---------------------------------------------------------------------------

/** A minimal v2 workspace snapshot. */
const snap = (projects, at = "2026-08-24T00:00:00Z") => ({
  schema_version: WORKSPACE_SNAPSHOT_SCHEMA,
  captured_at: at,
  captured_by: "propagate/refs",
  workspace_root: "/ws",
  projects,
  skipped: [],
});
/** A ref row carrying the spec's seven fields. */
const ref = (o = {}) => ({
  head: "aaa", merge_state: "unmerged", upstream: null, upstream_track: "",
  last_commit_iso: "2026-08-01T00:00:00Z", is_active_line: false, worktrees: [], ...o,
});
const proj = (refs, detached = []) => ({
  repo_root: "/ws/p", base_ref: "origin/main", error: null, refs, detached_worktrees: detached,
});

test("identity is (project, ref) — the same branch name in two projects is two things", async () => {
  const { diffSnapshots } = await import("../../lib/refs/snapshot.mjs");
  // Both projects have `main`. Removing it from ONE must fire exactly one prune,
  // naming which project. Keying on ref alone would collapse them.
  const prev = snap({ alpha: proj({ main: ref() }), beta: proj({ main: ref() }) });
  const next = snap({ alpha: proj({ main: ref() }), beta: proj({}) });

  const pruned = diffSnapshots(prev, next).filter((e) => e.type === "pruned");
  assert.equal(pruned.length, 1, `one prune, got ${JSON.stringify(pruned)}`);
  assert.equal(pruned[0].project, "beta", "the event must name WHICH project lost it");
  assert.equal(pruned[0].ref, "main");
});

test("adding a worktree to an existing branch fires worktree-added, not a creation", async () => {
  const { diffSnapshots } = await import("../../lib/refs/snapshot.mjs");
  // F7's outcome, preserved through the reshape. The branch already existed; only
  // its checkout is new, and calling that `created` would be the false claim C1a fixed.
  const prev = snap({ alpha: proj({ main: ref({ worktrees: [] }) }) });
  const next = snap({ alpha: proj({ main: ref({ worktrees: ["/ws/alpha"] }) }) });

  const ev = diffSnapshots(prev, next);
  assert.deepEqual(ev.map((e) => e.type), ["worktree-added"]);
  assert.equal(ev[0].path, "/ws/alpha", "and it must say WHICH checkout appeared");
  assert.equal(ev[0].project, "alpha");
});

test("removing a worktree while the branch stays fires worktree-removed only", async () => {
  const { diffSnapshots } = await import("../../lib/refs/snapshot.mjs");
  const prev = snap({ alpha: proj({ main: ref({ worktrees: ["/ws/alpha", "/ws/alpha/.worktrees/x"] }) }) });
  const next = snap({ alpha: proj({ main: ref({ worktrees: ["/ws/alpha"] }) }) });

  const ev = diffSnapshots(prev, next);
  assert.deepEqual(ev.map((e) => e.type), ["worktree-removed"]);
  assert.equal(ev[0].path, "/ws/alpha/.worktrees/x");
});

test("a DETACHED worktree is tracked by path — it has no ref to key on", async () => {
  const { diffSnapshots } = await import("../../lib/refs/snapshot.mjs");
  // The rows that `.filter(r => r.ref)` used to drop entirely. One is live in Motherboard.
  const prev = snap({ alpha: proj({}, [{ path: "/ws/alpha/.worktrees/det", head: "bbb" }]) });
  const next = snap({ alpha: proj({}, []) });

  const ev = diffSnapshots(prev, next);
  assert.deepEqual(ev.map((e) => e.type), ["worktree-removed"]);
  assert.equal(ev[0].path, "/ws/alpha/.worktrees/det");
  assert.equal(ev[0].ref, null, "a detached worktree has no ref, and inventing one would be a lie");
});

test("a project that appears is a baseline for THAT project, not N creations", async () => {
  const { diffSnapshots } = await import("../../lib/refs/snapshot.mjs");
  // C1a's rule, per project: we have no prior observation of `beta`, so its refs
  // were not created — we merely started looking at that repo.
  const prev = snap({ alpha: proj({ main: ref() }) });
  const next = snap({ alpha: proj({ main: ref() }), beta: proj({ main: ref(), dev: ref() }) });

  const ev = diffSnapshots(prev, next);
  assert.deepEqual(ev.map((e) => e.type), ["baseline"]);
  assert.equal(ev[0].project, "beta");
  assert.equal(ev[0].ref_count, 2);
  assert.match(ev[0].evidence, /unknown/i);
});

test("pruned events still carry the work verdict through the reshape", async () => {
  const { diffSnapshots } = await import("../../lib/refs/snapshot.mjs");
  const prev = snap({ alpha: proj({ feat: ref({ merge_state: "unmerged", upstream: null }) }) });
  const next = snap({ alpha: proj({}) });

  const [e] = diffSnapshots(prev, next).filter((x) => x.type === "pruned");
  assert.equal(e.work, "lost", "C1b's classification must survive C1d's reshape");
  assert.match(e.evidence, /nowhere else/i);
});

test("a previous snapshot that never RECORDED detached worktrees claims no transition", async () => {
  const { diffSnapshots } = await import("../../lib/refs/snapshot.mjs");
  // A converted v1 snapshot has no `detached_worktrees` key — the shell never
  // wrote one. `null` therefore means NOT RECORDED, and `[]` means looked-and-none.
  // Conflating them reports every pre-existing detached worktree as newly added
  // on the first propagate run. Motherboard has one; VK has none, so VK alone
  // would not have exposed this.
  const before = { repo_root: "/ws/p", base_ref: "origin/main", error: null, refs: {}, detached_worktrees: null };
  const after = { repo_root: "/ws/p", base_ref: "origin/main", error: null, refs: {},
                  detached_worktrees: [{ path: "/ws/p/.worktrees/det", head: "bbb" }] };

  const ev = diffSnapshots(snap({ p: before }), snap({ p: after }));
  assert.deepEqual(ev, [], `nothing is knowable, so nothing is claimed — got ${JSON.stringify(ev)}`);

  // And with a REAL empty list, the same input IS an addition.
  const ev2 = diffSnapshots(snap({ p: { ...before, detached_worktrees: [] } }), snap({ p: after }));
  assert.deepEqual(ev2.map((e) => e.type), ["worktree-added"], "looked-and-none is a real observation");
});

test("a pruned event carries the fields its verdict was derived FROM, not just prose", async () => {
  const { diffSnapshots, classifyPruned } = await import("../../lib/refs/snapshot.mjs");
  // The retired shell registry recorded merge_state_at_last_sighting,
  // upstream_at_last_sighting and upstream_track_at_last_sighting as FIELDS, and
  // branch-registry.sh:207-225 queries them with jq. Keeping the values only
  // inside `evidence` prose means a consumer cannot re-derive `lost` vs
  // `recoverable`, and this module's own header says an entry that cannot be
  // re-checked is "an assertion nobody can re-check later".
  const was = ref({ merge_state: "unmerged", upstream: "origin/feat", upstream_track: "[ahead 2]", head: "aaa" });
  const prev = snap({ alpha: proj({ feat: was }) }, "2026-08-24T00:00:00Z");
  const next = snap({ alpha: proj({}) }, "2026-08-24T07:00:00Z");

  const [e] = diffSnapshots(prev, next).filter((x) => x.type === "pruned");
  assert.equal(e.merge_state_at_last_sighting, "unmerged");
  assert.equal(e.upstream_at_last_sighting, "origin/feat");
  assert.equal(e.upstream_track_at_last_sighting, "[ahead 2]");

  // The verdict must be re-derivable from those fields ALONE.
  const recheck = classifyPruned({
    kind: "branch", ref: e.ref,
    merge_state: e.merge_state_at_last_sighting,
    upstream: e.upstream_at_last_sighting,
    upstream_track: e.upstream_track_at_last_sighting,
  });
  assert.equal(recheck.work, e.work, "the recorded fields must reproduce the recorded verdict");
});

test("`window_seconds` states WHEN it could have happened, instead of claiming `now`", async () => {
  const { diffSnapshots } = await import("../../lib/refs/snapshot.mjs");
  // A prune found by comparing two snapshots happened somewhere BETWEEN them.
  // Stamping `at` alone asserts it happened at the later moment, which is false
  // precision in an append-only record. The shell recorded window_seconds; so
  // does this.
  const prev = snap({ alpha: proj({ feat: ref() }) }, "2026-08-24T00:00:00Z");
  const next = snap({ alpha: proj({}) }, "2026-08-24T07:00:00Z");

  const [e] = diffSnapshots(prev, next).filter((x) => x.type === "pruned");
  assert.equal(e.window_seconds, 7 * 3600, "the gap between the two captures");
  assert.equal(e.at, "2026-08-24T07:00:00Z", "and `at` remains when it was DETECTED");
});

test("an unknown window is null, never 0 — 0 would claim instantaneous", async () => {
  const { diffSnapshots } = await import("../../lib/refs/snapshot.mjs");
  const prev = { ...snap({ alpha: proj({ feat: ref() }) }), captured_at: null };
  const next = snap({ alpha: proj({}) }, "2026-08-24T07:00:00Z");

  const [e] = diffSnapshots(prev, next).filter((x) => x.type === "pruned");
  assert.equal(e.window_seconds, null, "no previous timestamp means the window is UNKNOWN");
});
