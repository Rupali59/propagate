/**
 * migrate-stub-target.test.mjs — a stub that points OUT of the repo is not dangling.
 *
 * Reported 2026-09-27 by the session working in `obsidian-vk-publish`, and
 * verified here before acting on it.
 *
 * `planMigration` asked one question of a pointer stub: does MY computed
 * destination exist? For a project inside a workspace that keeps state at
 * `<workspace>/propagation/state/<project>/`, the answer is no — the real file
 * is one level UP, outside the repo entirely — so a correct, deliberate stub
 * was reported as `dangling stub` and the migration refused.
 *
 * That is backwards for the layout `rule:state-and-decisions` now makes the
 * DEFAULT. Per-repo `STATE.md` is the deviation; the stub IS the intended end
 * state; and creating `propagation/state/workspace/` inside the plugin repo
 * would reintroduce the split the rule moved to remove.
 *
 * Measured on the real pair before the fix:
 *   obsidian-vk-publish/STATE.md      -> ../propagation/state/obsidian-vk-publish/STATE.md    EXISTS
 *   obsidian-vk-publish/docs/DECISIONS.md -> ../../propagation/…/DECISIONS.md                 EXISTS
 *
 * So the question to ask is the stub's OWN declared target, resolved relative
 * to the stub. `rule:discernment-checks` §2: "destination missing" and "I looked
 * in the wrong place" are different facts, and only one is a conflict.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { stubTarget, stubTargetResolves, stubPlacement, planMigration } from "../../lib/migrate/workspace.mjs";

const STUB = (rel) => [
  "# STATE.md — moved",
  "",
  `This file now lives at \`${rel}\` in the \`Vipin Kaushik\` workspace repo,`,
  "with `.sidecar.yml` beside it.",
  "",
].join("\n");

test("the declared target is read out of the stub text", () => {
  assert.equal(stubTarget(STUB("../propagation/state/p/STATE.md")), "../propagation/state/p/STATE.md");
  assert.equal(stubTarget(STUB("../../propagation/state/p/DECISIONS.md")), "../../propagation/state/p/DECISIONS.md");
});

test("prose with no declared target yields null, never a guess", () => {
  // A stub whose wording changed must read as "I could not tell", so the caller
  // falls back to the old behaviour rather than inventing a path.
  assert.equal(stubTarget("# STATE.md — moved\n\nSee the workspace.\n"), null);
  assert.equal(stubTarget(""), null);
  assert.equal(stubTarget(null), null);
});

test("a stub whose target EXISTS resolves — even when it points out of the repo", async () => {
  const ws = await mkdtemp(path.join(tmpdir(), "stub-ws-"));
  try {
    // The real layout: <workspace>/propagation/state/<project>/STATE.md, with
    // the stub one level down inside the project repo.
    await mkdir(path.join(ws, "propagation", "state", "proj"), { recursive: true });
    await writeFile(path.join(ws, "propagation", "state", "proj", "STATE.md"), "# real state\n");
    await mkdir(path.join(ws, "proj"), { recursive: true });
    const stubPath = path.join(ws, "proj", "STATE.md");
    await writeFile(stubPath, STUB("../propagation/state/proj/STATE.md"));

    assert.equal(stubTargetResolves(stubPath), true,
      "the declared target exists one level up — this stub is not dangling");
  } finally {
    await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("a stub pointing at nothing is STILL dangling — the negative control", async () => {
  // Without this the fix would call every stub conformant, which would move the
  // defect rather than fix it: a genuinely broken signpost must stay a conflict.
  const ws = await mkdtemp(path.join(tmpdir(), "stub-ws-"));
  try {
    await mkdir(path.join(ws, "proj"), { recursive: true });
    const stubPath = path.join(ws, "proj", "STATE.md");
    await writeFile(stubPath, STUB("../propagation/state/proj/STATE.md")); // target never created
    assert.equal(stubTargetResolves(stubPath), false, "a target that does not exist must stay dangling");
  } finally {
    await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("a stub with no declared target is not claimed to resolve", async () => {
  const ws = await mkdtemp(path.join(tmpdir(), "stub-ws-"));
  try {
    await mkdir(path.join(ws, "proj"), { recursive: true });
    const stubPath = path.join(ws, "proj", "STATE.md");
    await writeFile(stubPath, "# STATE.md — moved\n\nSee the workspace.\n");
    assert.equal(stubTargetResolves(stubPath), false,
      "unreadable target must not read as resolved — that would silence a real dangling stub");
  } finally {
    await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

/* ── the other half: resolving is not the same as being in the right place ── */

/**
 * Added later the same day, after Rupali settled the classification the fix
 * above had deliberately left open: `obsidian-vk-publish` IS a workspace.
 *
 * That makes the fix above correct and incomplete in the same breath.
 * `stubTargetResolves` asks "does the declared target exist?" and stops, so a
 * WORKSPACE whose state sits in its parent's project slot resolves, and read as
 * "already migrated, nothing to move" — while 133 KB of STATE, DECISIONS and
 * GOTCHAS sat in the wrong layout and its own `propagation/state/` did not
 * exist. `rule:discernment-checks` §6: the reader answered a narrower question
 * than the one asked, and answered it reassuringly.
 *
 * The pair below is the whole point. Same stub, same target, same everything
 * except one line in `.propagates.yml` — and the correct verdict inverts.
 */
async function fixture(markerBody) {
  const tmp = await mkdtemp(path.join(tmpdir(), "stub-kind-"));
  const root = path.join(tmp, "ws", "thing");
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, ".propagates.yml"), markerBody);
  // The real file, in the PARENT's project slot.
  await mkdir(path.join(tmp, "ws", "propagation", "state", "thing"), { recursive: true });
  await writeFile(path.join(tmp, "ws", "propagation", "state", "thing", "STATE.md"), "the real state");
  await writeFile(path.join(root, "STATE.md"), STUB("../propagation/state/thing/STATE.md"));
  return { tmp, root };
}

test("a PROJECT's outward stub still reads as already-migrated — the peer's case, unbroken", async () => {
  const { tmp, root } = await fixture("sources: {}\n");
  try {
    assert.equal(stubPlacement(path.join(root, "STATE.md"), root), "outside");

    const plan = planMigration(root);
    const names = (xs) => xs.map((x) => path.basename(x.from ?? x.path ?? ""));
    assert.ok(names(plan.alreadyMigrated).includes("STATE.md"),
      `a project's outward stub must stay already-migrated, got conflicts: ${JSON.stringify(plan.conflicts)}`);
    assert.ok(!names(plan.conflicts).includes("STATE.md"));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("the SAME stub in a declared workspace is a conflict — one line in the marker inverts it", async () => {
  const { tmp, root } = await fixture("workspace: true\nsources: {}\n");
  try {
    // Placement is unchanged: the file is in the same place as the case above.
    assert.equal(stubPlacement(path.join(root, "STATE.md"), root), "outside",
      "placement must be about location only — if it also read the marker, the two facts are fused again");

    const plan = planMigration(root);
    const conflict = plan.conflicts.find((c) => path.basename(c.from ?? "") === "STATE.md");
    assert.ok(conflict,
      "a workspace whose state sits in its parent's project slot must be a CONFLICT, not 'already migrated'");
    assert.match(conflict.reason, /declares this a workspace/);
    assert.match(conflict.reason, /propagation\/state\/workspace\//,
      "the message must name where a workspace's state actually belongs");

    // And it must NOT be silently relocated: the real file is large, live, and
    // in another repo. Naming it is the job; moving it is a person's call.
    const moved = plan.moves.map((m) => path.basename(m.from ?? ""));
    assert.ok(!moved.includes("STATE.md"),
      "a cross-repo relocation of live state must never be planned automatically");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("a typo'd marker is NOT a workspace here either — it agrees with discovery", async () => {
  // `classifyMarker` refuses to coerce `workspace: "true"`, so migrate must not
  // either. Two components answering this differently is how they drift.
  const { tmp, root } = await fixture('workspace: "true"\nsources: {}\n');
  try {
    const plan = planMigration(root);
    assert.ok(plan.alreadyMigrated.some((x) => path.basename(x.from ?? "") === "STATE.md"),
      "a non-boolean workspace key must not promote the root to workspace-hood");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

/* ── consolidation: an outward stub is not always a misplacement ─────────── */

/**
 * Added after Rupali settled the second half: the state does NOT move, and the
 * upward consolidation is the intended end state.
 *
 * Which makes the conflict above correct in shape and wrong in this instance.
 * `Vipin Kaushik` consolidated deliberately — `rule:state-and-decisions` records
 * the reason and the cost — so reporting it as a fault would make `migrate`
 * permanently red on a correct tree, the failure `doctor` already warns about at
 * `workspaces.mjs:340-343`.
 *
 * DERIVED rather than declared. The alternative on the table was a sidecar
 * opt-out key, which every consolidating workspace would have to remember and
 * the forgetful ones would read as faults (G70). These tests pin the derivation:
 * the parent must itself declare `workspace: true` AND own the slot for this
 * basename. Anything else outward is still a conflict, which is the only thing
 * keeping the check meaningful.
 */
async function consolidated({ parentDeclares, artifacts = ["STATE.md"] }) {
  const tmp = await mkdtemp(path.join(tmpdir(), "consol-"));
  const parent = path.join(tmp, "ws");
  const root = path.join(parent, "thing");
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, ".propagates.yml"), "workspace: true\nsources: {}\n");
  if (parentDeclares) await writeFile(path.join(parent, ".propagates.yml"), "workspace: true\nsources: {}\n");

  const slot = path.join(parent, "propagation", "state", "thing");
  await mkdir(slot, { recursive: true });
  for (const a of artifacts) await writeFile(path.join(slot, a), `real ${a}`);
  // Only STATE.md gets a signpost, mirroring the real tree.
  await writeFile(path.join(root, "STATE.md"), STUB("../propagation/state/thing/STATE.md"));
  return { tmp, root, slot };
}

test("an outward stub into the PARENT workspace's own slot is a layout, not a conflict", async () => {
  const { tmp, root } = await consolidated({ parentDeclares: true });
  try {
    const plan = planMigration(root);
    const name = (x) => path.basename(x.from ?? "");
    assert.ok(!plan.conflicts.some((c) => name(c) === "STATE.md"),
      `consolidation must not be a conflict, got: ${JSON.stringify(plan.conflicts.map((c) => c.reason))}`);
    const skip = plan.alreadyMigrated.find((a) => name(a) === "STATE.md");
    assert.ok(skip, "it must be reported, not omitted — silence is not a pass");
    assert.match(skip.reason, /PARENT workspace's slot/);
    assert.match(skip.reason, /deliberately/,
      "the row must say this is intended, or the next reader 'fixes' it");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("the parent must ITSELF declare workspace:true — an undeclared parent is still a conflict", async () => {
  // The negative control, and the load-bearing one. If consolidation were
  // inferred from the path shape alone, every outward stub would be excused and
  // the check would detect nothing.
  const { tmp, root } = await consolidated({ parentDeclares: false });
  try {
    const plan = planMigration(root);
    const c = plan.conflicts.find((x) => path.basename(x.from ?? "") === "STATE.md");
    assert.ok(c, "a parent that declares nothing is not a consolidating workspace — still a conflict");
    assert.match(c.reason, /declares this a workspace/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("a consolidated artifact with NO stub is NOTED, never silently dropped", async () => {
  // The GOTCHAS.md case: 53 KB in the parent's slot, correct placement, and
  // nothing in this repo points at it. Before this it produced zero rows, which
  // read identically to "no such file" (rule:discernment-checks §2).
  const { tmp, root } = await consolidated({
    parentDeclares: true,
    artifacts: ["STATE.md", "GOTCHAS.md"],
  });
  try {
    const plan = planMigration(root);
    const note = (plan.notes ?? []).find((n) => path.basename(n.from ?? "") === "GOTCHAS.md");
    assert.ok(note, "an unsignposted consolidated artifact must appear somewhere in the plan");
    assert.match(note.reason, /NO stub/);
    assert.match(note.reason, /\d+ bytes/, "name its size, so the reader knows whether it matters");

    // And it is a NOTE, not a conflict: the file is where it belongs.
    assert.ok(!plan.conflicts.some((c) => path.basename(c.from ?? "") === "GOTCHAS.md"),
      "correct placement must not be reported as a fault");
    // The signposted one must not be double-reported through the derived path.
    assert.equal((plan.notes ?? []).filter((n) => path.basename(n.from ?? "") === "STATE.md").length, 0,
      "an artifact already reported via its stub must not appear twice");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
