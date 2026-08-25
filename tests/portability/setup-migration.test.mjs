/**
 * Moving a default must not orphan what was already written.
 *
 * This is the test GOTCHAS G12 asks for. G12 ("a default that moves loses state
 * silently") was recorded when PROPAGATE_STATE_DIR was added, to stop someone
 * relocating a default and losing the artifacts already sitting at the old one. On
 * 2026-08-20 the default DID move — from SKILL_DIR to ~/.propagate — so G12 stopped
 * being hypothetical and this is the discharge.
 *
 * It does not forbid the move. It requires the move not to lose anything.
 *
 * WHY `live` AND `retired` ARE SEPARATE LISTS. `metrics.jsonl` and `index.db` are read
 * by doctor and the skills index; losing them loses history that cannot be recomputed.
 * `state.json`, `heartbeat` and the watcher logs belong to the v1 watcher, retired
 * 2026-08-14, and nothing reads them. migrateLegacyState moves the first set and leaves
 * the second for a human — relocating state is not the same decision as deciding what
 * to throw away, and a function that quietly did both would be the wrong shape.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { migrateLegacyState, LEGACY_STATE } from "../../lib/core/setup.mjs";

function sandbox() {
  const root = mkdtempSync(path.join(tmpdir(), "propagate-migrate-"));
  const from = path.join(root, "skill");
  const to = path.join(root, "state");
  mkdirSync(from, { recursive: true });
  return { root, from, to, cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) };
}

test("every live artifact is moved, with its contents intact", () => {
  const s = sandbox();
  try {
    for (const name of LEGACY_STATE.live) writeFileSync(path.join(s.from, name), `payload:${name}`);
    const r = migrateLegacyState(s.from, s.to);

    assert.deepEqual(r.moved.sort(), [...LEGACY_STATE.live].sort(), "all live artifacts moved");
    assert.deepEqual(r.conflicts, [], "no conflicts");
    for (const name of LEGACY_STATE.live) {
      assert.ok(!existsSync(path.join(s.from, name)), `${name} left behind at the old location`);
      // Moved, not merely created: the CONTENT has to survive. A migration that
      // produced empty files at the new path would satisfy an existence check and
      // still have lost everything.
      assert.equal(readFileSync(path.join(s.to, name), "utf8"), `payload:${name}`);
    }
  } finally {
    s.cleanup();
  }
});

test("an existing destination file is never clobbered", () => {
  // Two files with one name is a decision a human makes. Silently picking one is the
  // incident G12 describes, in a new place.
  const s = sandbox();
  try {
    const name = LEGACY_STATE.live[0];
    writeFileSync(path.join(s.from, name), "old");
    mkdirSync(s.to, { recursive: true });
    writeFileSync(path.join(s.to, name), "new");

    const r = migrateLegacyState(s.from, s.to);
    assert.deepEqual(r.conflicts, [name], "reported as a conflict");
    assert.deepEqual(r.moved, [], "and not moved");
    assert.equal(readFileSync(path.join(s.to, name), "utf8"), "new", "destination untouched");
    assert.equal(readFileSync(path.join(s.from, name), "utf8"), "old", "source left for the human");
  } finally {
    s.cleanup();
  }
});

test("retired v1 artifacts are left alone by default", () => {
  const s = sandbox();
  try {
    for (const name of LEGACY_STATE.retired) writeFileSync(path.join(s.from, name), "fossil");
    const r = migrateLegacyState(s.from, s.to);
    assert.deepEqual(r.moved, [], "nothing moved");
    for (const name of LEGACY_STATE.retired) {
      assert.ok(existsSync(path.join(s.from, name)), `${name} must not be silently relocated`);
    }
  } finally {
    s.cleanup();
  }
});

test("migrating onto itself is a no-op, not a self-destructive rename", () => {
  const s = sandbox();
  try {
    const name = LEGACY_STATE.live[0];
    writeFileSync(path.join(s.from, name), "x");
    const r = migrateLegacyState(s.from, s.from);
    assert.deepEqual(r.moved, []);
    assert.equal(readFileSync(path.join(s.from, name), "utf8"), "x");
  } finally {
    s.cleanup();
  }
});

test("absent artifacts are reported as skipped, not as moved", () => {
  // Attributable absence (rule:discernment-checks §2): "there was nothing to move" and
  // "it moved" are different facts and must not share a return shape.
  const s = sandbox();
  try {
    const r = migrateLegacyState(s.from, s.to);
    assert.deepEqual(r.moved, []);
    assert.deepEqual(r.skipped.sort(), [...LEGACY_STATE.live].sort());
  } finally {
    s.cleanup();
  }
});
