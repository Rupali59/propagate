/**
 * `merge_state` — derived with `git cherry`, never `git branch --merged`.
 *
 * WHY THIS FILE EXISTS. The v2 conversion wrote `merge_state: null` for all 35
 * refs where the shell registry had real values, because
 * `buildWorkspaceSnapshot` never passed a base. Fixing that by passing a base
 * was not enough: `mergedInto` used `git branch --merged`, and these repos
 * SQUASH-MERGE.
 *
 * Measured across all 35 live refs before writing this:
 *   git cherry          35 agree with the shell, 0 disagree
 *   git branch --merged differs on 7, every one saying `unmerged` where the
 *                       truth is `merged`
 *
 * Squash-merged commits are not ancestors of the base, so ancestry reports them
 * as unique work. `git cherry` compares patch-ids and gets it right.
 * ref-resolver.sh:21 recorded this before the port re-derived it wrong:
 * "These repos squash-merge, so `git branch --merged` and `origin/main..<ref>`
 * both lie."
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mergedInto } from "../../lib/refs/snapshot.mjs";

const g = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });

/** A repo whose `feature` branch was SQUASH-merged into main — the real shape here. */
async function squashMergedRepo(t) {
  const root = await mkdtemp(path.join(tmpdir(), "squash-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  g(root, "config", "user.email", "t@e.st");
  g(root, "config", "user.name", "t");
  await writeFile(path.join(root, "base.txt"), "base\n");
  g(root, "add", "-A");
  g(root, "commit", "-qm", "base");

  g(root, "checkout", "-qb", "feature");
  await writeFile(path.join(root, "feat.txt"), "work\n");
  g(root, "add", "-A");
  g(root, "commit", "-qm", "feature work");

  // SQUASH merge: the content lands on main, but as a NEW commit whose parent
  // is main — so `feature` is not an ancestor and `--merged` will not see it.
  g(root, "checkout", "-q", "main");
  g(root, "merge", "--squash", "feature");
  g(root, "commit", "-qm", "squashed feature");
  return root;
}

test("a SQUASH-merged branch reads `merged` — the case --merged gets wrong", async (t) => {
  const root = await squashMergedRepo(t);

  // Prove the fixture really is the hard case: ancestry does NOT see it.
  const ancestry = g(root, "branch", "--merged", "main", "--format=%(refname:short)")
    .split("\n").map((s) => s.trim()).filter(Boolean);
  assert.ok(!ancestry.includes("feature"), `fixture is wrong — --merged already sees it: ${ancestry}`);

  const { merged, error } = await mergedInto(root, "main");
  assert.equal(error, null, `mergedInto errored: ${error}`);
  assert.ok(merged.has("feature"), "git cherry compares patch-ids and must see the squashed work");
});

test("a genuinely unmerged branch still reads unmerged", async (t) => {
  // The other half of the gate: a check that calls everything merged is as
  // useless as one that calls nothing merged.
  const root = await squashMergedRepo(t);
  g(root, "checkout", "-qb", "untouched");
  await writeFile(path.join(root, "other.txt"), "unique\n");
  g(root, "add", "-A");
  g(root, "commit", "-qm", "unique work");
  g(root, "checkout", "-q", "main");

  const { merged } = await mergedInto(root, "main");
  assert.ok(!merged.has("untouched"), "a branch with unique commits is NOT merged");
  assert.ok(merged.has("feature"), "…while the squashed one still is");
});

test("an absent base is UNMEASURED, and says so — never 'not merged'", async (t) => {
  const root = await squashMergedRepo(t);
  const r = await mergedInto(root, "origin/does-not-exist");
  assert.ok(r.error, `an unresolvable base must carry a reason, got ${JSON.stringify(r)}`);
  assert.equal(r.merged.size, 0, "and claim nothing");
});

test("a ref further than MAX_CHERRY from base is UNMEASURED, not silently green", async (t) => {
  // ref-resolver.sh caps this deliberately: "a ref more than MAX_CHERRY commits
  // from base reports `unmeasured` rather than costing a minute — attributed,
  // never silently green." Reporting `merged` because we gave up looking is the
  // failure mode that deletes work.
  const root = await squashMergedRepo(t);
  g(root, "checkout", "-qb", "long");
  for (let i = 0; i < 6; i++) {
    await writeFile(path.join(root, `n${i}.txt`), `${i}\n`);
    g(root, "add", "-A");
    g(root, "commit", "-qm", `c${i}`);
  }
  g(root, "checkout", "-q", "main");

  const r = await mergedInto(root, "main", { maxCherry: 3 });
  assert.ok(!r.merged.has("long"), "a capped ref must not be reported merged");
  assert.ok(
    (r.unmeasured ?? []).includes("long"),
    `it must be named as unmeasured, got ${JSON.stringify({ unmeasured: r.unmeasured })}`,
  );
});
