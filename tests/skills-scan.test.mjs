/**
 * Tests for the skill inventory.
 *
 * These build a synthetic ~/.claude/skills out of mkdtemp rather than reading
 * the real one, because the real directory is the thing the registry is meant
 * to observe -- asserting against it would make the tests restate whatever is
 * currently on disk instead of pinning behaviour.
 *
 * The classification cases are the load-bearing ones. Three installers are
 * distinguished ONLY by symlink shape, and the npx case must be tested before
 * the gstack case, because an npx skill's SKILL.md is also reached through a
 * symlink; a classifier that checked SKILL.md first would silently label every
 * npx skill as gstack and the provenance join would then find nothing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  INSTALLER,
  classifyInstaller,
  readFrontmatterName,
  readSkillUsage,
  readSkillLock,
  scanSkills,
  summarize,
} from "../lib/skills-scan.mjs";

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "skills-scan-"));
  const skills = path.join(root, "skills");
  const agents = path.join(root, "agents-skills");
  const gstack = path.join(root, "gstack");
  mkdirSync(skills, { recursive: true });
  mkdirSync(agents, { recursive: true });
  mkdirSync(gstack, { recursive: true });
  return { root, skills, agents, gstack };
}

function writeSkill(dir, name, frontmatterName) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${frontmatterName ?? name}\ndescription: test\n---\n\nbody\n`,
  );
}

test("classifies the three installers by symlink shape", () => {
  const f = fixture();
  try {
    // 1. npx skills: the DIRECTORY is a symlink.
    writeSkill(path.join(f.agents, "azure-thing"), "azure-thing");
    symlinkSync(path.join(f.agents, "azure-thing"), path.join(f.skills, "azure-thing"));

    // 2. gstack-relink: real dir, SKILL.md is a symlink into the checkout.
    writeSkill(path.join(f.gstack, "health"), "health");
    mkdirSync(path.join(f.skills, "gstack-health"));
    symlinkSync(
      path.join(f.gstack, "health", "SKILL.md"),
      path.join(f.skills, "gstack-health", "SKILL.md"),
    );

    // 3. handmade: real dir, real file.
    writeSkill(path.join(f.skills, "propagate"), "propagate");

    assert.equal(classifyInstaller(path.join(f.skills, "azure-thing")), INSTALLER.NPX_SKILLS);
    assert.equal(classifyInstaller(path.join(f.skills, "gstack-health")), INSTALLER.GSTACK);
    assert.equal(classifyInstaller(path.join(f.skills, "propagate")), INSTALLER.HANDMADE);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a directory with no SKILL.md is not a skill", () => {
  const f = fixture();
  try {
    mkdirSync(path.join(f.skills, "not-a-skill"));
    assert.equal(classifyInstaller(path.join(f.skills, "not-a-skill")), INSTALLER.UNKNOWN);
    const { skills } = scanSkills({ skillsDir: f.skills, lock: {}, usage: {} });
    assert.deepEqual(skills.map((s) => s.id), []);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("id is the directory name; a frontmatter mismatch is reported, not corrected", () => {
  // This is the real gstack shape: dir gstack-health, frontmatter `name: health`.
  // Claude Code resolves by directory, so id must follow the directory.
  const f = fixture();
  try {
    writeSkill(path.join(f.skills, "gstack-health"), "gstack-health", "health");
    const { skills } = scanSkills({ skillsDir: f.skills, lock: {}, usage: {} });
    assert.equal(skills[0].id, "gstack-health");
    assert.equal(skills[0].declaredName, "health");
    assert.equal(skills[0].nameMismatch, true);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a dangling SKILL.md symlink is flagged rather than dropped", () => {
  const f = fixture();
  try {
    mkdirSync(path.join(f.skills, "gstack-checkpoint"));
    symlinkSync(
      path.join(f.gstack, "gone", "SKILL.md"),
      path.join(f.skills, "gstack-checkpoint", "SKILL.md"),
    );
    const { skills } = scanSkills({ skillsDir: f.skills, lock: {}, usage: {} });
    assert.equal(skills.length, 1);
    assert.equal(skills[0].dangling, true);
    assert.equal(skills[0].declaredName, null);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("usage joins by directory name; absent key means never invoked", () => {
  const f = fixture();
  try {
    writeSkill(path.join(f.skills, "used"), "used");
    writeSkill(path.join(f.skills, "unused"), "unused");
    const { skills } = scanSkills({
      skillsDir: f.skills,
      lock: {},
      usage: { used: { usageCount: 70, lastUsedAt: 123 } },
    });
    const byId = Object.fromEntries(skills.map((s) => [s.id, s]));
    assert.equal(byId.used.usageCount, 70);
    assert.equal(byId.used.neverInvoked, false);
    assert.equal(byId.unused.usageCount, 0);
    assert.equal(byId.unused.neverInvoked, true);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("usage keys with no directory are reported as orphans, not silently dropped", () => {
  // The counter is never pruned on delete. Surfacing these is what makes
  // "absent key == never invoked" a safe inference rather than a guess.
  const f = fixture();
  try {
    writeSkill(path.join(f.skills, "here"), "here");
    const { orphanUsageKeys } = scanSkills({
      skillsDir: f.skills,
      lock: {},
      usage: {
        here: { usageCount: 1, lastUsedAt: 1 },
        deleted: { usageCount: 9, lastUsedAt: 2 },
        "plugin:thing": { usageCount: 3, lastUsedAt: 3 }, // namespaced -> not ours
      },
    });
    assert.deepEqual(orphanUsageKeys, ["deleted"]);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("provenance attaches from the lock; handmade skills stay null, never guessed", () => {
  const f = fixture();
  try {
    writeSkill(path.join(f.agents, "azure-thing"), "azure-thing");
    symlinkSync(path.join(f.agents, "azure-thing"), path.join(f.skills, "azure-thing"));
    writeSkill(path.join(f.skills, "propagate"), "propagate");

    const { skills } = scanSkills({
      skillsDir: f.skills,
      usage: {},
      lock: { "azure-thing": { source: "microsoft/x", sourceUrl: "https://e.com", skillPath: null, skillFolderHash: null, installedAt: "2026-02-26T10:37:27.971Z" } },
    });
    const byId = Object.fromEntries(skills.map((s) => [s.id, s]));
    assert.equal(byId["azure-thing"].provenance.source, "microsoft/x");
    assert.equal(byId.propagate.provenance, null);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("malformed inputs degrade to empty rather than throwing", () => {
  // Both readers run inside the launchd digest, where a throw is a silent outage.
  const f = fixture();
  try {
    const bad = path.join(f.root, "bad.json");
    writeFileSync(bad, "{ not json");
    assert.deepEqual(readSkillUsage(bad), {});
    assert.deepEqual(readSkillLock(bad), {});
    assert.deepEqual(readSkillUsage(path.join(f.root, "missing.json")), {});
    assert.deepEqual(readSkillLock(path.join(f.root, "missing.json")), {});
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("readFrontmatterName tolerates quotes and missing frontmatter", () => {
  const f = fixture();
  try {
    const a = path.join(f.root, "a.md");
    writeFileSync(a, `---\nname: "quoted-name"\n---\nbody\n`);
    assert.equal(readFrontmatterName(a), "quoted-name");

    const b = path.join(f.root, "b.md");
    writeFileSync(b, `no frontmatter here\n`);
    assert.equal(readFrontmatterName(b), null);

    assert.equal(readFrontmatterName(null), null);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("summarize counts installers, never-invoked and orphans", () => {
  const f = fixture();
  try {
    writeSkill(path.join(f.skills, "a"), "a");
    writeSkill(path.join(f.skills, "b"), "b");
    const scan = scanSkills({
      skillsDir: f.skills,
      lock: {},
      usage: { a: { usageCount: 2, lastUsedAt: 1 }, ghost: { usageCount: 1, lastUsedAt: 1 } },
    });
    const s = summarize(scan);
    assert.equal(s.total, 2);
    assert.equal(s.byInstaller[INSTALLER.HANDMADE], 2);
    assert.equal(s.neverInvoked, 1);
    assert.equal(s.orphanUsageKeys, 1);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
