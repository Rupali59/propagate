/**
 * Skill inventory + provenance + liveness.
 *
 * Answers "what skills exist, where did each come from, and is it used" for a
 * ~/.claude/skills directory assembled by three uncoordinated installers:
 *
 *   1. `npx skills`   -> directory SYMLINK into ~/.agents/skills.
 *                        Provenance is recorded in ~/.agents/.skill-lock.json.
 *   2. `gstack-relink`-> real directory whose SKILL.md is a SYMLINK into the
 *                        gstack checkout. Provenance is that checkout.
 *   3. by hand        -> real directory, real SKILL.md, no provenance anywhere.
 *
 * The three are distinguishable purely by symlink shape, which is why
 * classifyInstaller() keys on that and never on file contents or mtime.
 * (mtime was tried elsewhere in this ecosystem and produced a bulk-touch date
 * for nearly every directory, so it carries no information.)
 *
 * LIVENESS. Claude Code maintains ~/.claude.json -> skillUsage as
 * {usageCount, lastUsedAt} per invocation key. That file is written by the
 * harness, not by the skill, which is what makes it a legitimate probe --
 * the observer is not the observed. Two properties matter and are easy to get
 * wrong:
 *
 *   - It is NOT pruned when a skill is deleted, so a key with no directory
 *     means "gone", and a directory with no key honestly means "never
 *     invoked" rather than "we lost the record".
 *   - It counts more than explicit invocation. Measured 2026-08-11:
 *     `propagate` reads 70 here against 33 explicit Skill tool calls in
 *     transcripts, so autonomous/description-matched activation is included.
 *     Anything that reaps on "unused" must therefore treat this as the
 *     authoritative upper bound, never the transcript count.
 *
 * This module NEVER writes to ~/.claude.json. Corrupting it breaks Claude Code
 * globally.
 */

import { readFileSync, readdirSync, lstatSync, existsSync, realpathSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const HOME = os.homedir();

export const SKILLS_DIR = path.join(HOME, ".claude", "skills");
export const SKILL_LOCK = path.join(HOME, ".agents", ".skill-lock.json");
export const CLAUDE_JSON = path.join(HOME, ".claude.json");

/** Installer classes. `unknown` is reserved for "we could not tell", which is
 *  distinct from `handmade` = "we determined nobody recorded provenance". */
export const INSTALLER = {
  NPX_SKILLS: "npx-skills",
  GSTACK: "gstack-relink",
  HANDMADE: "handmade",
  UNKNOWN: "unknown",
};

/** Read a JSON file, returning `fallback` on any failure.
 *  Total by construction: this runs during CLI startup and during the launchd
 *  digest, and a throw in either is a silent outage. */
function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * Provenance for skills installed by `npx skills`, keyed by skill name.
 * Lock format is v3: {version, skills: {<name>: {source, sourceUrl, ...}}}.
 */
export function readSkillLock(lockPath = SKILL_LOCK) {
  const raw = readJsonSafe(lockPath, null);
  if (!raw || typeof raw !== "object") return {};
  const skills = raw.skills && typeof raw.skills === "object" ? raw.skills : {};
  const out = {};
  for (const [name, v] of Object.entries(skills)) {
    if (!v || typeof v !== "object") continue;
    out[name] = {
      source: v.source ?? null,
      sourceUrl: v.sourceUrl ?? null,
      skillPath: v.skillPath ?? null,
      skillFolderHash: v.skillFolderHash ?? null,
      installedAt: v.installedAt ?? null,
    };
  }
  return out;
}

/**
 * The harness-maintained invocation counter. Read-only, always.
 * Returns {} rather than throwing if the file is missing or malformed.
 */
export function readSkillUsage(claudeJsonPath = CLAUDE_JSON) {
  const raw = readJsonSafe(claudeJsonPath, null);
  const su = raw && typeof raw === "object" ? raw.skillUsage : null;
  if (!su || typeof su !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(su)) {
    if (!v || typeof v !== "object") continue;
    const count = Number(v.usageCount);
    out[k] = {
      usageCount: Number.isFinite(count) ? count : 0,
      lastUsedAt: Number(v.lastUsedAt) || null,
    };
  }
  return out;
}

/**
 * Determine which installer produced a skill directory, from symlink shape.
 *
 * Order matters: a dir-symlink is checked before the SKILL.md symlink, because
 * an npx-installed skill's SKILL.md is also (transitively) not a real file
 * here, and testing it second would misattribute every one of them to gstack.
 */
export function classifyInstaller(entryPath) {
  let st;
  try {
    st = lstatSync(entryPath);
  } catch {
    return INSTALLER.UNKNOWN;
  }
  if (st.isSymbolicLink()) return INSTALLER.NPX_SKILLS;
  if (!st.isDirectory()) return INSTALLER.UNKNOWN;

  const skillMd = path.join(entryPath, "SKILL.md");
  try {
    if (lstatSync(skillMd).isSymbolicLink()) return INSTALLER.GSTACK;
  } catch {
    return INSTALLER.UNKNOWN; // no SKILL.md at all -> not a skill
  }
  return INSTALLER.HANDMADE;
}

/** Absolute resolution of a skill's SKILL.md, or null if it dangles. */
function resolveSkillMd(entryPath) {
  const p = path.join(entryPath, "SKILL.md");
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/** Parse only the `name:` line out of YAML frontmatter.
 *  Deliberately not a YAML parse: we need one scalar, and pulling in a parser
 *  here would add a dependency to a module the launchd digest imports. */
export function readFrontmatterName(skillMdPath) {
  if (!skillMdPath) return null;
  let text;
  try {
    text = readFileSync(skillMdPath, "utf8").slice(0, 4096);
  } catch {
    return null;
  }
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  const block = end === -1 ? text : text.slice(0, end);
  const m = block.match(/^name:[ \t]*(.+)$/m);
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
}

/**
 * Inventory every skill directory.
 *
 * NOTE ON THE INVOCATION KEY. Claude Code registers a skill by its DIRECTORY
 * NAME, not by the frontmatter `name:`. Verified empirically 2026-08-11: 53 of
 * 55 gstack skills declare an un-prefixed `name:` (e.g. `health`) while living
 * in `gstack-health/`, and `gstack-health` is what resolves. So `id` is the
 * directory name and `declaredName` is recorded separately -- a mismatch is
 * reported, never corrected, because correcting it would rename live skills.
 */
export function scanSkills({
  skillsDir = SKILLS_DIR,
  lock = null,
  usage = null,
} = {}) {
  const provenance = lock ?? readSkillLock();
  const usageMap = usage ?? readSkillUsage();

  let entries = [];
  try {
    entries = readdirSync(skillsDir).sort();
  } catch {
    return { skills: [], orphanUsageKeys: [], skillsDir, error: "unreadable" };
  }

  const skills = [];
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const entryPath = path.join(skillsDir, name);
    const installer = classifyInstaller(entryPath);
    if (installer === INSTALLER.UNKNOWN && !existsSync(path.join(entryPath, "SKILL.md"))) {
      continue; // not a skill directory
    }

    const skillMd = resolveSkillMd(entryPath);
    const declaredName = readFrontmatterName(skillMd);
    const use = usageMap[name] ?? null;

    skills.push({
      id: name,                       // the invocation key
      dir: entryPath,
      installer,
      declaredName,
      nameMismatch: Boolean(declaredName && declaredName !== name),
      resolvedSkillMd: skillMd,
      dangling: skillMd === null,
      provenance: provenance[name] ?? null,
      usageCount: use ? use.usageCount : 0,
      lastUsedAt: use ? use.lastUsedAt : null,
      neverInvoked: !use || use.usageCount === 0,
    });
  }

  // Usage keys with no directory. The counter is never pruned, so these are
  // deleted skills -- evidence of past churn, and the reason a missing key is
  // safe to read as "never invoked".
  const present = new Set(skills.map((s) => s.id));
  const orphanUsageKeys = Object.keys(usageMap)
    .filter((k) => !k.includes(":") && !present.has(k))
    .sort();

  return { skills, orphanUsageKeys, skillsDir, error: null };
}

/** Aggregate counts for the digest and `skills status`. */
export function summarize({ skills, orphanUsageKeys }) {
  const byInstaller = {};
  for (const s of skills) byInstaller[s.installer] = (byInstaller[s.installer] ?? 0) + 1;
  return {
    total: skills.length,
    byInstaller,
    neverInvoked: skills.filter((s) => s.neverInvoked).length,
    noProvenance: skills.filter((s) => !s.provenance && s.installer === INSTALLER.HANDMADE).length,
    nameMismatches: skills.filter((s) => s.nameMismatch).length,
    dangling: skills.filter((s) => s.dangling).length,
    orphanUsageKeys: orphanUsageKeys.length,
  };
}
