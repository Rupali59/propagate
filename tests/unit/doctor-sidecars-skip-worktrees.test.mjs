/**
 * #129: doctor validated `.propagates.yml` files inside git worktrees (about 50 of
 * its 52 failures on 2026-11-10). A worktree is a second checkout of a repo that is
 * already scanned, on another branch (GOTCHAS G87), and its sidecar's `source:`
 * keys resolve against a tree they were not written for.
 *
 * The cause was a private `findSidecars` walk in cli.mjs that had drifted from
 * `findAllSidecarsRecursive`, which `status`/`check`/`reconcile` use and which
 * skips worktrees. doctor now delegates, so the two cannot disagree.
 */
// @size small — pure fs fixture, no subprocess

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { findSidecars } from "../../cli.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "doctor-wt-sidecars-"));
  const put = async (rel) => {
    const f = path.join(root, rel, ".propagates.yml");
    await mkdir(path.dirname(f), { recursive: true });
    await writeFile(f, "sources: {}\n", "utf8");
    return f;
  };
  return {
    root,
    canonical: [await put("proj"), await put("proj/sub")],
    worktrees: [
      await put(".worktrees/feat"),
      await put("proj/.worktrees/feat"),
      await put(".claude/worktrees/agent-1"),
      await put("proj/.claude/worktrees/agent-2/skills/x"),
    ],
  };
}

test("findSidecars returns the canonical sidecars and none inside a worktree", async () => {
  const { root, canonical, worktrees } = await fixture();
  try {
    const found = (await findSidecars(root)).sort();
    // floor: a blind scan must not read as "no worktree sidecars found"
    assert.equal(found.length, canonical.length, `scan went blind or wide: ${found.join(", ")}`);
    assert.deepEqual(found, [...canonical].sort());
    for (const w of worktrees) assert.ok(!found.includes(w), `worktree sidecar leaked: ${w}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
