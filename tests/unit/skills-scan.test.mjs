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
  readFrontmatterFields,
  readSkillUsage,
  readSkillLock,
  scanSkills,
  summarize,
  probeTranscripts,
} from "../../lib/skills/skills-scan.mjs";

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

test("neverInvoked is the AND of both probes, not either alone", () => {
  // The reaper deletes on this flag, so a skill visible to EITHER probe must
  // survive. skillUsage is a file we do not control; transcripts only cover the
  // era since the Skill tool existed. Neither is trustworthy alone.
  const f = fixture();
  try {
    for (const n of ["both", "usage-only", "transcript-only", "neither"]) {
      writeSkill(path.join(f.skills, n), n);
    }
    const { skills } = scanSkills({
      skillsDir: f.skills,
      lock: {},
      usage: {
        both: { usageCount: 3, lastUsedAt: 1 },
        "usage-only": { usageCount: 2, lastUsedAt: 1 },
      },
      transcripts: {
        both: { count: 1, sessions: 1 },
        "transcript-only": { count: 1, sessions: 1 },
      },
    });
    const byId = Object.fromEntries(skills.map((s) => [s.id, s]));
    assert.equal(byId.both.neverInvoked, false);
    assert.equal(byId["usage-only"].neverInvoked, false);
    assert.equal(byId["transcript-only"].neverInvoked, false, "transcript evidence alone must protect a skill");
    assert.equal(byId.neither.neverInvoked, true);

    // The surprising direction is worth surfacing: present in transcripts but
    // absent from skillUsage would undermine skillUsage as the primary probe.
    assert.equal(summarize({ skills, orphanUsageKeys: [] }).transcriptOnly, 1);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("probeTranscripts attributes matches to skills and sessions", () => {
  const f = fixture();
  try {
    const proj = path.join(f.root, "projects", "-Users-x-repo");
    mkdirSync(proj, { recursive: true });
    // Two calls to one skill in one session, one call in a second session.
    writeFileSync(
      path.join(proj, "session-aaa.jsonl"),
      `{"type":"tool_use","name":"Skill","input":{"skill":"propagate"}}\n` +
      `{"type":"tool_use","name":"Skill","input":{"skill":"propagate"}}\n` +
      `{"type":"tool_use","name":"Skill","input":{"skill":"gstack-ship"}}\n`,
    );
    writeFileSync(
      path.join(proj, "session-bbb.jsonl"),
      `{"type":"tool_use","name":"Skill","input":{"skill":"propagate"}}\n`,
    );
    // A non-transcript file must be excluded by the glob.
    writeFileSync(path.join(proj, "notes.txt"), `{"skill":"should-not-count"}\n`);

    const { byName, scanned } = probeTranscripts({ projectsDir: path.join(f.root, "projects") });
    assert.equal(scanned, true);
    assert.equal(byName.propagate.count, 3);
    assert.equal(byName.propagate.sessions, 2);
    assert.equal(byName["gstack-ship"].count, 1);
    assert.equal(byName["should-not-count"], undefined);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("probeTranscripts returns empty-but-scanned when there are no matches", () => {
  // Both searchers exit 1 on "no matches". That is a real empty result and must
  // not be reported as a failed scan, or the digest would say "probe
  // unavailable" on a genuinely quiet tree.
  const f = fixture();
  try {
    const proj = path.join(f.root, "projects");
    mkdirSync(proj, { recursive: true });
    writeFileSync(path.join(proj, "empty.jsonl"), `{"type":"text"}\n`);
    const r = probeTranscripts({ projectsDir: proj });
    assert.equal(r.scanned, true);
    assert.deepEqual(r.byName, {});
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("probeTranscripts reports scanned:false when the tree is missing", () => {
  const r = probeTranscripts({ projectsDir: "/nonexistent-transcripts-xyz" });
  assert.equal(r.scanned, false);
  assert.deepEqual(r.byName, {});
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

// ─────────────────────────────────────────────────────────────────────────
// completeness — step 8 of the resilient-valiant plan.
//
// A fully synthetic marketplaceDir/settingsPath/searchRoots, injected the
// same way skillsDir/lock/usage/transcripts already are, so these never touch
// the real ~/.claude or ~/Documents/GitHub -- the thing predicate 7 exists to
// audit is exactly "is this directory reachable from a search root", so the
// fixture has to construct that relationship, not assume it.
// ─────────────────────────────────────────────────────────────────────────

function completenessFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "skills-completeness-"));
  const skills = path.join(root, "claude-skills");
  const searchRoot = path.join(root, "search-root");
  const marketplace = path.join(root, "marketplace");
  mkdirSync(skills, { recursive: true });
  mkdirSync(searchRoot, { recursive: true });
  mkdirSync(path.join(marketplace, "quarantine", "skills"), { recursive: true });
  mkdirSync(path.join(marketplace, "tathya", "skills"), { recursive: true });
  mkdirSync(path.join(marketplace, ".claude-plugin"), { recursive: true });
  writeFileSync(
    path.join(marketplace, ".claude-plugin", "marketplace.json"),
    JSON.stringify({
      name: "tathya",
      plugins: [
        { name: "quarantine", source: "./quarantine" },
        { name: "tathya", source: "./tathya" },
        { name: "url-plugin", source: { source: "url", url: "https://example.com/url-plugin.git" } },
      ],
    }),
  );
  const settingsPath = path.join(root, "settings.json");
  writeFileSync(
    settingsPath,
    JSON.stringify({
      enabledPlugins: {
        "tathya@tathya": true,
        "quarantine@tathya": false,
        "url-plugin@tathya": true,
      },
    }),
  );
  return { root, skills, searchRoot, marketplace, settingsPath };
}

function scanCompleteness(f, extra = {}) {
  const scan = scanSkills({
    skillsDir: f.skills,
    lock: {},
    usage: {},
    marketplaceDir: f.marketplace,
    settingsPath: f.settingsPath,
    searchRoots: [f.searchRoot],
    maxDepth: 2,
    ...extra,
  });
  return Object.fromEntries(scan.skills.map((s) => [s.id, s.completeness]));
}

test("completeness: a fully-shipped, fully-enabled, reachable skill is all-true", () => {
  const f = completenessFixture();
  try {
    mkdirSync(path.join(f.skills, "good"), { recursive: true });
    writeFileSync(
      path.join(f.skills, "good", "SKILL.md"),
      `---\nname: good\ndescription: Use when testing completeness end to end.\n---\n\nbody\n`,
    );
    writeFileSync(path.join(f.skills, "good", ".propagates.yml"), "edges: []\n");
    mkdirSync(path.join(f.marketplace, "tathya", "skills", "good"));
    // Reachable ONLY via a marked symlink from the search root -- this is the
    // real shape (~/.claude/skills/<x> reached via a ~/Documents/GitHub link),
    // not a coincidence of directory nesting.
    symlinkSync(path.join(f.skills, "good"), path.join(f.searchRoot, "good-link"));

    const c = scanCompleteness(f).good;
    assert.deepEqual(c, {
      skillMd: true,
      frontmatter: true,
      nameMatchesDir: true,
      descriptionStatesWhen: true,
      shipped: true,
      enabled: true,
      sidecarReachable: true,
      testsGreen: "n/a",
    });
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("completeness: no frontmatter at all fails structural predicates, never throws", () => {
  const f = completenessFixture();
  try {
    mkdirSync(path.join(f.skills, "no-frontmatter"), { recursive: true });
    writeFileSync(path.join(f.skills, "no-frontmatter", "SKILL.md"), `# /no-frontmatter\n\njust prose\n`);

    const c = scanCompleteness(f)["no-frontmatter"];
    assert.equal(c.skillMd, true, "SKILL.md exists even though it has no frontmatter");
    assert.equal(c.frontmatter, false);
    assert.equal(c.nameMatchesDir, "n/a", "no declared name to compare -- not a false failure");
    assert.equal(c.descriptionStatesWhen, false);
    assert.equal(c.shipped, false);
    assert.equal(c.enabled, "n/a", "cannot be enabled if not shipped");
    assert.equal(c.sidecarReachable, "n/a", "no .propagates.yml at all -- not a false failure");
    assert.equal(c.testsGreen, "n/a");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("completeness: description stating WHAT, not WHEN, fails descriptionStatesWhen", () => {
  const f = completenessFixture();
  try {
    mkdirSync(path.join(f.skills, "bad-desc"), { recursive: true });
    writeFileSync(
      path.join(f.skills, "bad-desc", "SKILL.md"),
      `---\nname: bad-desc\ndescription: Check Motherboard and plugin service status.\n---\n\nbody\n`,
    );
    const c = scanCompleteness(f)["bad-desc"];
    assert.equal(c.frontmatter, true, "well-formed frontmatter -- the defect is only in the wording");
    assert.equal(c.descriptionStatesWhen, false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("completeness: a YAML block-scalar description is still read, not literal '|'", () => {
  // gstack-design-layer's real shape: `description: |` then indented lines.
  // A single-line regex reads the value as the literal string "|" and would
  // report descriptionStatesWhen:false for every skill written this way.
  const f = completenessFixture();
  try {
    mkdirSync(path.join(f.skills, "block-desc"), { recursive: true });
    writeFileSync(
      path.join(f.skills, "block-desc", "SKILL.md"),
      [
        "---",
        "name: block-desc",
        "description: |",
        "  Multi-line intro that does not itself say when.",
        "  Use when the plan calls for exactly this shape.",
        "---",
        "",
        "body",
        "",
      ].join("\n"),
    );
    const fields = readFrontmatterFields(path.join(f.skills, "block-desc", "SKILL.md"));
    assert.equal(fields.present, true);
    assert.match(fields.description, /Use when the plan/);

    const c = scanCompleteness(f)["block-desc"];
    assert.equal(c.frontmatter, true);
    assert.equal(c.descriptionStatesWhen, true);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("completeness: a frontmatter name that disagrees with the directory is reported false, not corrected", () => {
  const f = completenessFixture();
  try {
    // Real shape: dir gstack-health, frontmatter name: health.
    writeSkill(path.join(f.skills, "gstack-mismatch"), "gstack-mismatch", "mismatch");
    const c = scanCompleteness(f)["gstack-mismatch"];
    assert.equal(c.nameMatchesDir, false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("completeness: shipped via marketplace.json plugins[] (Tier A), not just a vendored dir (Tier B)", () => {
  const f = completenessFixture();
  try {
    writeSkill(path.join(f.skills, "url-plugin"), "url-plugin");
    const c = scanCompleteness(f)["url-plugin"];
    assert.equal(c.shipped, true, "matched via marketplace.json's plugins[].name, not a skills/ dir listing");
    assert.equal(c.enabled, true, "url-plugin@tathya is true in the fixture settings.json");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("completeness: shipped but disabled reads false, never n/a", () => {
  const f = completenessFixture();
  try {
    mkdirSync(path.join(f.skills, "quarantined"), { recursive: true });
    writeFileSync(
      path.join(f.skills, "quarantined", "SKILL.md"),
      `---\nname: quarantined\ndescription: Use when this fixture needs a disabled-but-shipped case.\n---\n\nbody\n`,
    );
    mkdirSync(path.join(f.marketplace, "quarantine", "skills", "quarantined"));
    const c = scanCompleteness(f).quarantined;
    assert.equal(c.shipped, true);
    assert.equal(c.enabled, false, "quarantine@tathya is false in the fixture settings.json");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("completeness: a .propagates.yml outside every search root is reported unreachable, never n/a", () => {
  const f = completenessFixture();
  try {
    mkdirSync(path.join(f.skills, "orphan-sidecar"), { recursive: true });
    writeFileSync(
      path.join(f.skills, "orphan-sidecar", "SKILL.md"),
      `---\nname: orphan-sidecar\ndescription: Use when the sidecar is not reachable by any search root.\n---\n\nbody\n`,
    );
    writeFileSync(path.join(f.skills, "orphan-sidecar", ".propagates.yml"), "edges: []\n");
    // Deliberately NOT symlinked from f.searchRoot -- this is the curate-docs
    // defect the predicate exists to catch: an edge nothing can discover.
    const c = scanCompleteness(f)["orphan-sidecar"];
    assert.equal(c.sidecarReachable, false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("completeness: MUTATION -- moving the sidecar out of reach flips sidecarReachable true -> false, and back", () => {
  // rule:safety-flag-needs-a-test / rule:discernment-checks §1: a predicate
  // never observed to change is not a verified predicate.
  const f = completenessFixture();
  try {
    mkdirSync(path.join(f.skills, "mutant"), { recursive: true });
    writeFileSync(
      path.join(f.skills, "mutant", "SKILL.md"),
      `---\nname: mutant\ndescription: Use when verifying the mutation actually flips the predicate.\n---\n\nbody\n`,
    );
    writeFileSync(path.join(f.skills, "mutant", ".propagates.yml"), "edges: []\n");
    const linkPath = path.join(f.searchRoot, "mutant-link");
    symlinkSync(path.join(f.skills, "mutant"), linkPath);

    assert.equal(scanCompleteness(f).mutant.sidecarReachable, true, "reachable before the mutation");

    rmSync(linkPath); // sever the only path in from any search root
    assert.equal(scanCompleteness(f).mutant.sidecarReachable, false, "must flip once the link is gone");

    symlinkSync(path.join(f.skills, "mutant"), linkPath); // restore
    assert.equal(scanCompleteness(f).mutant.sidecarReachable, true, "must flip back once restored");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("completeness: testsGreen is n/a without a tests/ dir, not-run with one but no --with-tests, and a real result when opted in", () => {
  const f = completenessFixture();
  try {
    mkdirSync(path.join(f.skills, "no-tests-dir"), { recursive: true });
    writeSkill(path.join(f.skills, "no-tests-dir"), "no-tests-dir");

    mkdirSync(path.join(f.skills, "has-tests"), { recursive: true });
    writeSkill(path.join(f.skills, "has-tests"), "has-tests");
    mkdirSync(path.join(f.skills, "has-tests", "tests"));
    writeFileSync(
      path.join(f.skills, "has-tests", "package.json"),
      JSON.stringify({ name: "has-tests", scripts: { test: "node -e \"process.exit(0)\"" } }),
    );

    const withoutFlag = scanCompleteness(f);
    assert.equal(withoutFlag["no-tests-dir"].testsGreen, "n/a");
    assert.equal(withoutFlag["has-tests"].testsGreen, "not-run", "applicable but deliberately skipped this run");

    const withFlag = scanCompleteness(f, { withTests: true });
    assert.equal(withFlag["has-tests"].testsGreen, true);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("completeness: testsGreen reports no-test-script rather than crashing when package.json has none", () => {
  const f = completenessFixture();
  try {
    mkdirSync(path.join(f.skills, "no-script"), { recursive: true });
    writeSkill(path.join(f.skills, "no-script"), "no-script");
    mkdirSync(path.join(f.skills, "no-script", "tests"));
    const c = scanCompleteness(f, { withTests: true })["no-script"];
    assert.equal(c.testsGreen, "no-test-script");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("existing fields are untouched by adding completeness -- id/dangling/nameMismatch etc. keep their exact shape", () => {
  const f = completenessFixture();
  try {
    writeSkill(path.join(f.skills, "unchanged"), "unchanged");
    const scan = scanSkills({
      skillsDir: f.skills,
      lock: {},
      usage: {},
      marketplaceDir: f.marketplace,
      settingsPath: f.settingsPath,
      searchRoots: [f.searchRoot],
    });
    const s = scan.skills[0];
    assert.equal(s.id, "unchanged");
    assert.equal(s.dangling, false);
    assert.equal(s.nameMismatch, false);
    assert.equal(s.neverInvoked, true);
    assert.ok("completeness" in s);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
