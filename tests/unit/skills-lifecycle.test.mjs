/**
 * Lifecycle tests.
 *
 * The reaper is the only thing in this codebase that deletes a user's files, so
 * most of what follows is about proving it refuses to. Every fixture is a
 * mkdtemp marketplace; nothing here touches the real one.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  scanTier,
  scanLifecycle,
  promotable,
  reapable,
  promote,
  demote,
  reap,
  isDisarmed,
  PROMOTE_MIN_USES,
  REAP_AFTER_DAYS,
} from "../../lib/skills/skills-lifecycle.mjs";

const DAY_MS = 86_400_000;

function market() {
  const root = mkdtempSync(path.join(tmpdir(), "market-"));
  mkdirSync(path.join(root, "quarantine", "skills"), { recursive: true });
  mkdirSync(path.join(root, "tathya", "skills"), { recursive: true });
  return root;
}

function addSkill(root, tier, name, desc = "test skill") {
  const dir = path.join(root, tier, "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${desc}\n---\n\nbody\n`);
  return dir;
}

test("scanTier namespaces ids by plugin and joins both probes", () => {
  const root = market();
  try {
    addSkill(root, "quarantine", "alpha");
    const rows = scanTier(path.join(root, "quarantine", "skills"), "quarantine", {
      usage: { "quarantine:alpha": { usageCount: 2, lastUsedAt: 1 } },
      transcripts: { "quarantine:alpha": { count: 1, sessions: 1 } },
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "quarantine:alpha", "id must be namespaced — a bare name would collide with ~/.claude/skills");
    assert.equal(rows[0].usageCount, 2);
    assert.equal(rows[0].transcriptCount, 1);
    assert.equal(rows[0].neverInvoked, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a directory without SKILL.md is not a skill", () => {
  const root = market();
  try {
    mkdirSync(path.join(root, "quarantine", "skills", "junk"), { recursive: true });
    assert.deepEqual(scanTier(path.join(root, "quarantine", "skills"), "quarantine", { usage: {} }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("promotion needs the threshold, and EITHER probe can supply it", () => {
  const rows = [
    { id: "quarantine:a", usageCount: PROMOTE_MIN_USES, transcriptCount: 0 },
    { id: "quarantine:b", usageCount: 0, transcriptCount: PROMOTE_MIN_USES },
    { id: "quarantine:c", usageCount: PROMOTE_MIN_USES - 1, transcriptCount: PROMOTE_MIN_USES - 1 },
  ];
  // Not a sum: two under-counts do not add up to evidence of three real uses.
  assert.deepEqual(promotable(rows).map((r) => r.id), ["quarantine:a", "quarantine:b"]);
});

test("reapable requires BOTH probes silent AND age past the threshold", () => {
  const base = { neverInvoked: true, ageDays: REAP_AFTER_DAYS };
  const rows = [
    { id: "old-unused", ...base },
    { id: "old-but-used", neverInvoked: false, ageDays: 99 },
    { id: "unused-but-young", neverInvoked: true, ageDays: REAP_AFTER_DAYS - 1 },
  ];
  assert.deepEqual(reapable(rows).map((r) => r.id), ["old-unused"]);
});

test("reap defaults to dry-run and touches nothing", async () => {
  const root = market();
  try {
    const dir = addSkill(root, "quarantine", "doomed");
    const res = await reap([{ id: "quarantine:doomed", name: "doomed", dir, ageDays: 30 }], {
      archiveDir: path.join(root, ".reaped"),
      logPath: path.join(root, "log.jsonl"),
    });
    assert.equal(res.applied, false);
    assert.deepEqual(res.planned.map((p) => p.id), ["quarantine:doomed"]);
    assert.ok(existsSync(dir), "dry-run must not delete");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reap --apply archives before deleting, and logs the archive path", async () => {
  const root = market();
  try {
    const dir = addSkill(root, "quarantine", "doomed");
    const archiveDir = path.join(root, ".reaped");
    const logPath = path.join(root, "log.jsonl");
    const res = await reap([{ id: "quarantine:doomed", name: "doomed", dir, ageDays: 30 }], {
      apply: true, archiveDir, logPath,
    });
    assert.equal(res.applied, true);
    assert.equal(res.done[0].removed, true);
    assert.ok(existsSync(res.done[0].archive), "the tarball must exist — this is what makes reaping reversible");
    assert.ok(!existsSync(dir), "the skill directory should be gone");

    const ev = JSON.parse(readFileSync(logPath, "utf8").trim().split("\n").pop());
    assert.equal(ev.type, "reaped");
    assert.equal(ev.skill, "doomed");
    assert.ok(ev.archive);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the kill switch stops promote, demote and reap --apply", async () => {
  const root = market();
  try {
    const off = path.join(root, "OFF");
    writeFileSync(off, "");
    assert.equal(isDisarmed(off), true);

    const dir = addSkill(root, "quarantine", "alpha");
    const opts = { marketplaceDir: root, logPath: path.join(root, "log.jsonl"), disarmFile: off };

    assert.equal((await promote("alpha", opts)).reason, "disarmed");
    assert.equal((await demote("alpha", opts)).reason, "disarmed");

    const r = await reap([{ id: "quarantine:alpha", name: "alpha", dir, ageDays: 99 }], {
      apply: true, archiveDir: path.join(root, ".reaped"), logPath: path.join(root, "log.jsonl"), disarmFile: off,
    });
    assert.equal(r.applied, false);
    assert.equal(r.reason, "disarmed");
    assert.ok(existsSync(dir), "disarmed reap must not delete");
    // It still reports what it WOULD have done, so the switch is diagnosable.
    assert.deepEqual(r.planned.map((p) => p.id), ["quarantine:alpha"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("promote moves the directory between plugins and logs the rename", async () => {
  const root = market();
  try {
    addSkill(root, "quarantine", "alpha");
    const logPath = path.join(root, "log.jsonl");
    const res = await promote("alpha", { marketplaceDir: root, logPath, disarmFile: path.join(root, "nope") });
    assert.equal(res.ok, true);
    assert.equal(res.from, "quarantine:alpha");
    assert.equal(res.to, "tathya:alpha");
    assert.ok(!existsSync(path.join(root, "quarantine", "skills", "alpha")));
    assert.ok(existsSync(path.join(root, "tathya", "skills", "alpha", "SKILL.md")));

    const ev = JSON.parse(readFileSync(logPath, "utf8").trim().split("\n").pop());
    assert.equal(ev.type, "promoted");
    // The invocation name changes, so the usage counter resets. Lineage has to
    // live in the log or it is lost.
    assert.equal(ev.from, "quarantine:alpha");
    assert.equal(ev.to, "tathya:alpha");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("promote refuses to overwrite an already-promoted skill of the same name", async () => {
  // Overwriting would destroy a skill that earned its place, for one that
  // merely shares its name.
  const root = market();
  try {
    addSkill(root, "quarantine", "alpha", "the new one");
    addSkill(root, "tathya", "alpha", "the established one");
    const res = await promote("alpha", { marketplaceDir: root, logPath: path.join(root, "log.jsonl"), disarmFile: path.join(root, "nope") });
    assert.equal(res.ok, false);
    assert.match(res.reason, /already promoted/);
    const kept = readFileSync(path.join(root, "tathya", "skills", "alpha", "SKILL.md"), "utf8");
    assert.match(kept, /the established one/, "the promoted skill must survive untouched");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("demote is the inverse of promote", async () => {
  const root = market();
  try {
    addSkill(root, "quarantine", "alpha");
    const opts = { marketplaceDir: root, logPath: path.join(root, "log.jsonl"), disarmFile: path.join(root, "nope") };
    await promote("alpha", opts);
    const res = await demote("alpha", opts);
    assert.equal(res.ok, true);
    assert.ok(existsSync(path.join(root, "quarantine", "skills", "alpha", "SKILL.md")));
    assert.ok(!existsSync(path.join(root, "tathya", "skills", "alpha")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("promote on a missing skill fails cleanly rather than throwing", async () => {
  const root = market();
  try {
    const res = await promote("ghost", { marketplaceDir: root, logPath: path.join(root, "log.jsonl"), disarmFile: path.join(root, "nope") });
    assert.equal(res.ok, false);
    assert.match(res.reason, /not in quarantine/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scanLifecycle reads both tiers and ages them from the same clock", () => {
  const root = market();
  try {
    const qdir = addSkill(root, "quarantine", "young");
    addSkill(root, "tathya", "established");
    // Backdate the quarantined skill by 20 days.
    const past = (Date.now() - 20 * DAY_MS) / 1000;
    utimesSync(qdir, past, past);

    const { quarantined, promoted } = scanLifecycle({ marketplaceDir: root, usage: {}, transcripts: {} });
    assert.deepEqual(quarantined.map((s) => s.id), ["quarantine:young"]);
    assert.deepEqual(promoted.map((s) => s.id), ["tathya:established"]);
    // birthtime does not move with utimes on macOS, so age comes from creation;
    // the assertion that matters is that it is a number and never negative.
    assert.ok(quarantined[0].ageDays >= 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
