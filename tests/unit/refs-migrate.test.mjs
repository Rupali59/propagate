/**
 * `migrateRefs` — adopt a v1 branch registry without an inconsistent window.
 *
 * ORDER IS THE WHOLE DESIGN (plan amendment A1):
 *
 *     read v1 -> convert IN MEMORY -> diff vs fresh -> append events -> THEN write
 *
 * Never build -> write -> diff. The previous snapshot is the ONLY record of the
 * prior state, so overwriting it before diffing loses every change since the
 * last capture. On Vipin Kaushik that is currently 12 real prunes.
 *
 * Dry-run by default, mirroring `relocateLedger` and `migrate` rather than
 * inventing a third preview mechanism.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, utimes } from "node:fs/promises";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { migrateRefs } from "../../lib/refs/migrate-refs.mjs";

/** Every byte under a tree, so a dry run can be proven inert. */
function treeSnapshot(root) {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === ".git") continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else out.push(`${path.relative(root, abs)}::${readFileSync(abs, "utf8")}`);
    }
  };
  walk(root);
  return out.join("\n");
}

/** A workspace repo with a v1 snapshot naming `branches`, some of which are gone. */
async function fixture(t, { v1Branches = ["main", "gone-feat"], realBranches = ["main"] } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "mrefs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);
  const git = (...a) => execFileSync("git", ["-C", root, ...a], { stdio: ["ignore", "pipe", "pipe"] });
  git("config", "user.email", "t@e.st");
  git("config", "user.name", "t");
  await writeFile(path.join(root, "f.txt"), "x\n");
  git("add", "-A");
  git("commit", "-qm", "seed");
  const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  for (const b of realBranches) if (b !== "main") git("branch", b);

  const refs = {};
  for (const b of v1Branches) {
    refs[b] = {
      head: head.slice(0, 7),
      is_active_line: b === "main",
      last_commit_iso: "2026-08-01T00:00:00Z",
      merge_state: b === "main" ? "same" : "unmerged",
      upstream: null,
      upstream_track: "",
      worktrees: b === "main" ? [root] : [],
    };
  }
  await mkdir(path.join(root, "propagation", "refs"), { recursive: true });
  await writeFile(
    path.join(root, "propagation", "refs", "snapshot.json"),
    JSON.stringify({ schema_version: 1, captured_at: "2026-08-24T00:00:00Z", captured_by: "hygiene/branch-registry",
                     projects: { workspace: { base_ref: "origin/main", refs } } }, null, 2) + "\n",
  );
  await writeFile(path.join(root, "propagation", "refs", "lifecycle.jsonl"),
    JSON.stringify({ type: "branch_lifecycle", event: "baseline", project: "workspace", ref_count: v1Branches.length }) + "\n");
  return root;
}

test("dry run writes NOTHING — asserted on the tree, not on the return value", async (t) => {
  const root = await fixture(t);
  const before = treeSnapshot(root);
  const r = await migrateRefs({ workspace: root, now: "2026-08-24T07:00:00Z" });
  assert.equal(r.applied, false);
  assert.deepEqual(treeSnapshot(root), before, "a preview that writes is not a preview");
});

test("the dry run SHOWS the prunes, before anything is written", async (t) => {
  // The 12 real prunes on Vipin Kaushik are the reason this order exists. They
  // must be visible for a person to read BEFORE the write, not discoverable
  // afterwards in a log.
  const root = await fixture(t);
  const r = await migrateRefs({ workspace: root, now: "2026-08-24T07:00:00Z" });
  const pruned = r.events.filter((e) => e.type === "pruned");
  assert.equal(pruned.length, 1, `gone-feat must be pruned, got ${JSON.stringify(r.events.map((e) => e.type))}`);
  assert.equal(pruned[0].ref, "gone-feat");
  assert.ok(pruned[0].work, "with its work verdict");
  assert.equal(pruned[0].window_seconds, 7 * 3600, "and the window it could have happened in");
});

test("--apply writes the v2 snapshot AND appends the events, in that order", async (t) => {
  const root = await fixture(t);
  const r = await migrateRefs({ workspace: root, apply: true, now: "2026-08-24T07:00:00Z" });
  assert.equal(r.applied, true);

  const snap = JSON.parse(readFileSync(path.join(root, "propagation", "refs", "snapshot.json"), "utf8"));
  assert.equal(snap.schema_version, 2);
  assert.equal(snap.captured_by, "propagate/refs");

  const log = readFileSync(path.join(root, "propagation", "refs", "lifecycle.jsonl"), "utf8")
    .split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(log.length, 2, "the v1 baseline stays, the new prune is appended");
  assert.equal(log[0].type, "branch_lifecycle", "frozen v1 history is never rewritten");
  assert.equal(log[1].schema, 2);
  assert.equal(log[1].type, "pruned");
});

test("is_active_line SURVIVES the conversion", async (t) => {
  // E1: the flag comes from config, not git. A conversion that drops it produces
  // a file that passes conformance and is worse than the one it replaced.
  const root = await fixture(t);
  await mkdir(path.join(root, "docs", "conventions"), { recursive: true });
  await writeFile(path.join(root, "docs", "conventions", "CONTEXT-BUDGET.md"),
    '# B\n\n```toml\n[active_lines]\nworkspace = "main"\n```\n');

  await migrateRefs({ workspace: root, apply: true, now: "2026-08-24T07:00:00Z" });
  const snap = JSON.parse(readFileSync(path.join(root, "propagation", "refs", "snapshot.json"), "utf8"));
  assert.equal(snap.projects.workspace.refs.main.is_active_line, true, "the declared active line must still be flagged");
});

test("a workspace with NO snapshot is a first run, not an error", async (t) => {
  // E4: the other six workspaces have no file at all.
  const root = await mkdtemp(path.join(tmpdir(), "mrefs-none-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "user.email", "t@e.st"]);
  execFileSync("git", ["-C", root, "config", "user.name", "t"]);
  await writeFile(path.join(root, "f.txt"), "x\n");
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "commit", "-qm", "seed"]);

  const r = await migrateRefs({ workspace: root, now: "2026-08-24T07:00:00Z" });
  assert.equal(r.previous, "absent", "absence is a named state, not a failure");
  assert.deepEqual(r.events.map((e) => e.type), ["baseline"], "everything is a baseline, nothing is `created`");
});

test("re-running on an ALREADY-v2 workspace is idempotent", async (t) => {
  // E4: a second run must append nothing and leave the snapshot byte-identical.
  const root = await fixture(t);
  await migrateRefs({ workspace: root, apply: true, now: "2026-08-24T07:00:00Z" });
  const after1 = treeSnapshot(root);

  const r2 = await migrateRefs({ workspace: root, apply: true, now: "2026-08-24T08:00:00Z" });
  assert.deepEqual(r2.events, [], `a second run must find nothing, got ${JSON.stringify(r2.events)}`);
  assert.deepEqual(treeSnapshot(root), after1, "and must not rewrite a byte");
});

test("a snapshot that changed under us ABORTS the write", async (t) => {
  // E5: `run_lib` removal stops future collect runs, but one already in flight
  // still writes. Same before/after discipline relocateLedger uses, pointed at a
  // concurrent writer instead of at our own dry run.
  const root = await fixture(t);
  const snapPath = path.join(root, "propagation", "refs", "snapshot.json");
  await assert.rejects(
    () => migrateRefs({
      workspace: root, apply: true, now: "2026-08-24T07:00:00Z",
      // Fires after the read, before the write — exactly the race being guarded.
      _afterRead: async () => {
        const t2 = new Date(Date.now() + 60_000);
        await utimes(snapPath, t2, t2);
      },
    }),
    /changed while|concurrent|abort/i,
    "a writer racing us must abort the run, not silently win or lose",
  );
});
