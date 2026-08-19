/**
 * Skill lifecycle: quarantine -> promoted, and the reaper.
 *
 * THE SHAPE, and why it is this shape.
 *
 * Auto-created skills land in the `quarantine` plugin of the Tathya
 * marketplace, NOT in ~/.claude/skills. Claude Code discovers top-level skills
 * by directory presence there, so anything written into it is immediately live
 * under a bare name and can shadow an established skill. A marketplace plugin
 * instead registers as `quarantine:<name>` -- namespaced, collision-proof
 * against every existing skill, and visibly provisional at the call site.
 *
 * Verified 2026-08-11 before any of this was built: a skill under
 * quarantine/skills/ registers namespaced, is selected AUTONOMOUSLY by
 * description without being named, and increments its own
 * `quarantine:<name>` key in ~/.claude.json's skillUsage. That last property is
 * what makes promotion evidence free instead of something this module has to
 * track by hand.
 *
 * PROMOTION MOVES THE DIRECTORY between plugins, so the invocation name changes
 * `quarantine:x` -> `tathya:x`. The usage counter does NOT carry over, because
 * it is keyed by invocation name. That is deliberate rather than a defect: the
 * question after promotion is "is this earning its place now", and a fresh
 * counter answers it. Lineage lives in the event log instead.
 *
 * THE REAPER only ever touches quarantine. Promoted skills demote; they are
 * never deleted by machine. Deletion is the one irreversible act here, so it is
 * gated on: quarantined tier, zero usage on BOTH probes, and age past the
 * threshold -- and even then the directory is archived before removal.
 */

import { readdirSync, existsSync, statSync, mkdirSync, renameSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";

import { readSkillUsage, readFrontmatterName, probeTranscripts } from "./skills-scan.mjs";
import { appendRowWithId } from "./ledger.mjs";
import { INTEGRATIONS, STATE_DIR, SKILL_DIR } from "./config.mjs";

const HOME = os.homedir();

// null when unconfigured and the legacy path is absent — this whole module is
// then inert rather than pointing at a private repo the machine does not have.
export const MARKETPLACE_DIR = INTEGRATIONS.marketplaceDir;
export const QUARANTINE_SKILLS = path.join(MARKETPLACE_DIR, "quarantine", "skills");
export const PROMOTED_SKILLS = path.join(MARKETPLACE_DIR, "tathya", "skills");
export const REAPED_ARCHIVE = path.join(MARKETPLACE_DIR, "quarantine", ".reaped");

/** Append-only lifecycle log. The projection in index.db is rebuilt from the
 *  filesystem; this is where transitions live, since a transition leaves no
 *  trace on disk once it has happened. */
// Was path.join(HOME, ".claude", "skills", "propagate", ...) — the skill's own
// install path, hardcoded, which defeats SKILL_DIR's whole purpose and was
// already wrong under a marketplace install or a worktree. STATE_DIR first so
// the log survives a plugin update (N13/N14); SKILL_DIR only as the fallback.
export const LIFECYCLE_LOG = path.join(STATE_DIR || SKILL_DIR, "SKILLS_LIFECYCLE.jsonl");

/** Promotion requires this many recorded invocations while quarantined. */
export const PROMOTE_MIN_USES = 3;
/** A quarantined skill nobody invoked within this many days is reaped. */
export const REAP_AFTER_DAYS = 14;

const DAY_MS = 86_400_000;

/** Kill switch. Presence stops every mutating action in this module.
 *  A file rather than a config key so it can be set and checked in one second,
 *  and so it cannot be lost in a settings merge. */
export const DISARM_FILE = path.join(HOME, ".claude", "skills-registry.off");

export function isDisarmed(disarmFile = DISARM_FILE) {
  return existsSync(disarmFile);
}

/**
 * Inventory one tier of the marketplace.
 * @param {string} skillsDir - quarantine/skills or tathya/skills
 * @param {string} pluginName - "quarantine" | "tathya"; becomes the id prefix
 */
export function scanTier(skillsDir, pluginName, { usage = null, transcripts = null, now = Date.now() } = {}) {
  const usageMap = usage ?? readSkillUsage();
  const tx = transcripts ?? {};
  if (!existsSync(skillsDir)) return [];

  const out = [];
  for (const name of readdirSync(skillsDir).sort()) {
    if (name.startsWith(".")) continue;
    const dir = path.join(skillsDir, name);
    const skillMd = path.join(dir, "SKILL.md");
    if (!existsSync(skillMd)) continue;

    const id = `${pluginName}:${name}`;
    const use = usageMap[id] ?? null;
    const t = tx[id] ?? null;
    const usageCount = use ? use.usageCount : 0;
    const transcriptCount = t ? t.count : 0;

    // Age from directory birthtime. The lifecycle log is authoritative once a
    // `created` event exists, but birthtime is the only signal for a skill
    // placed by hand, and being wrong here only ever delays a reap.
    let ageDays = 0;
    try {
      const st = statSync(dir);
      const born = st.birthtimeMs || st.ctimeMs;
      ageDays = Math.floor((now - born) / DAY_MS);
    } catch { /* unreadable -> age 0, never reaped */ }

    out.push({
      id,
      name,
      tier: pluginName,
      dir,
      declaredName: readFrontmatterName(skillMd),
      usageCount,
      transcriptCount,
      neverInvoked: usageCount === 0 && transcriptCount === 0,
      ageDays,
    });
  }
  return out;
}

/** Both tiers at once, with a single usage read and transcript probe. */
export function scanLifecycle({ marketplaceDir = MARKETPLACE_DIR, usage = null, transcripts = null, now = Date.now() } = {}) {
  const usageMap = usage ?? readSkillUsage();
  const tx = transcripts ?? probeTranscripts().byName;
  const opts = { usage: usageMap, transcripts: tx, now };
  return {
    quarantined: scanTier(path.join(marketplaceDir, "quarantine", "skills"), "quarantine", opts),
    promoted: scanTier(path.join(marketplaceDir, "tathya", "skills"), "tathya", opts),
  };
}

/**
 * Which quarantined skills have earned promotion.
 * EITHER probe reaching the threshold counts, because both under-report in
 * different ways -- unlike reaping, where both must agree.
 */
export function promotable(quarantined, { minUses = PROMOTE_MIN_USES } = {}) {
  return quarantined.filter((s) => Math.max(s.usageCount, s.transcriptCount) >= minUses);
}

/**
 * Which quarantined skills are reap candidates.
 *
 * Both conditions required. `neverInvoked` is already the AND of both probes,
 * so a skill that either counter has ever seen is safe. Promoted skills are
 * never considered -- this function is only ever passed quarantine.
 */
export function reapable(quarantined, { afterDays = REAP_AFTER_DAYS } = {}) {
  return quarantined.filter((s) => s.neverInvoked && s.ageDays >= afterDays);
}

/** Append a lifecycle event. Mints its id under the ledger lock. */
async function logEvent(event, { logPath = LIFECYCLE_LOG } = {}) {
  mkdirSync(path.dirname(logPath), { recursive: true });
  return appendRowWithId(logPath, { timestamp: new Date().toISOString(), ...event });
}

/**
 * Promote a quarantined skill: move the directory into the tathya plugin.
 *
 * Refuses rather than overwrites when the destination exists. A silent
 * overwrite here would destroy a promoted skill that had already earned its
 * place, to make room for one that merely shares its name.
 */
export async function promote(name, { marketplaceDir = MARKETPLACE_DIR, logPath = LIFECYCLE_LOG, disarmFile = DISARM_FILE } = {}) {
  if (isDisarmed(disarmFile)) return { ok: false, reason: "disarmed" };
  const from = path.join(marketplaceDir, "quarantine", "skills", name);
  const to = path.join(marketplaceDir, "tathya", "skills", name);
  if (!existsSync(from)) return { ok: false, reason: "not in quarantine" };
  if (existsSync(to)) return { ok: false, reason: "already promoted (destination exists)" };

  mkdirSync(path.dirname(to), { recursive: true });
  renameSync(from, to);
  await logEvent({ type: "promoted", skill: name, from: `quarantine:${name}`, to: `tathya:${name}`, dir: to }, { logPath });
  return { ok: true, from: `quarantine:${name}`, to: `tathya:${name}`, dir: to };
}

/** Demote a promoted skill back to quarantine. The counterpart to promote(),
 *  and the ONLY thing that ever happens to a promoted skill automatically --
 *  the reaper never deletes one. */
export async function demote(name, { marketplaceDir = MARKETPLACE_DIR, logPath = LIFECYCLE_LOG, disarmFile = DISARM_FILE } = {}) {
  if (isDisarmed(disarmFile)) return { ok: false, reason: "disarmed" };
  const from = path.join(marketplaceDir, "tathya", "skills", name);
  const to = path.join(marketplaceDir, "quarantine", "skills", name);
  if (!existsSync(from)) return { ok: false, reason: "not promoted" };
  if (existsSync(to)) return { ok: false, reason: "quarantine slot occupied" };

  mkdirSync(path.dirname(to), { recursive: true });
  renameSync(from, to);
  await logEvent({ type: "demoted", skill: name, from: `tathya:${name}`, to: `quarantine:${name}`, dir: to }, { logPath });
  return { ok: true, from: `tathya:${name}`, to: `quarantine:${name}` };
}

/**
 * Reap quarantined skills. ARCHIVE FIRST, then remove -- which is what keeps
 * this reversible-with-effort (class B) rather than one-way (class C).
 *
 * `apply` defaults to false. A reaper whose default is to delete is one
 * mis-called function away from clearing the tier.
 */
export async function reap(candidates, { apply = false, archiveDir = REAPED_ARCHIVE, logPath = LIFECYCLE_LOG, disarmFile = DISARM_FILE } = {}) {
  const planned = candidates.map((c) => ({ id: c.id, name: c.name, dir: c.dir, ageDays: c.ageDays }));
  if (apply && isDisarmed(disarmFile)) return { applied: false, reason: "disarmed", planned };
  if (!apply) return { applied: false, planned };

  const done = [];
  mkdirSync(archiveDir, { recursive: true });
  for (const c of candidates) {
    const stamp = new Date().toISOString().slice(0, 10);
    const tarball = path.join(archiveDir, `${c.name}-${stamp}.tar.gz`);
    try {
      execFileSync("tar", ["-czf", tarball, "-C", path.dirname(c.dir), c.name], { stdio: "ignore" });
    } catch (err) {
      // Could not archive -> do not delete. Leaving it for the next run is
      // strictly better than losing it silently.
      done.push({ id: c.id, removed: false, reason: `archive failed: ${err.message}` });
      continue;
    }
    execFileSync("/bin/rm", ["-rf", c.dir], { stdio: "ignore" });
    await logEvent({ type: "reaped", skill: c.name, id: c.id, ageDays: c.ageDays, archive: tarball }, { logPath });
    done.push({ id: c.id, removed: true, archive: tarball });
  }
  return { applied: true, planned, done };
}
