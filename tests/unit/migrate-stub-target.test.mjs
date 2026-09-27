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

import { stubTarget, stubTargetResolves } from "../../lib/migrate/workspace.mjs";

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
