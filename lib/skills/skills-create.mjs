/**
 * Skill creation pipeline: draft -> audit -> quarantine.
 *
 * WHY THERE IS NO FREQUENCY DETECTOR HERE.
 *
 * The plan called for a background detector that spots a repeated multi-step
 * procedure in session transcripts and codifies it. That was measured against
 * the actual data on 2026-08-11 and the premise does not hold:
 *
 *   - 400-session sample: only 5% have >=5 Bash calls at all.
 *   - Single commands recurring across >=4 distinct sessions: ZERO.
 *     Lowering to >=3 yields only generic primitives -- `ls -la` (51),
 *     `cd` (13), `git status` (4), `mkdir -p` (4).
 *   - 500-session sample of 3-command sequences: every sequence recurring
 *     across >=2 sessions is degenerate -- `cd | cd | cd`,
 *     `ls -la | ls -la | ls -la`, `echo | echo | echo`.
 *   - Recurrent words in 9026 user prompts are conversational filler
 *     ("okay", "need", "have", "what").
 *
 * A frequency detector on this data would auto-create a skill for "run cd",
 * polluting exactly the namespace the registry exists to protect -- and it
 * would do so unattended. So creation is deliberately EXPLICIT: the pipeline
 * below runs on demand, and the reaper (which is genuinely safe and genuinely
 * useful) is what runs unattended.
 *
 * If a real repeated procedure ever emerges, the detector becomes a function
 * that returns candidates and feeds createSkill(); nothing else changes. The
 * measurement above is the gate for building it, and it should be re-run rather
 * than assumed.
 *
 * WHAT THIS DOES REUSE. Nothing here re-implements authoring or auditing:
 *   drafting -> the installed skill-creator plugin, via `claude -p`
 *   auditing -> `gbrain skillify check`, the 10-item completeness contract
 * This module is the glue plus the safety rails: name-collision refusal, the
 * rate limit, the kill switch, and landing the result in quarantine rather
 * than in the live skills directory.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";

import { readSkillUsage, scanSkills } from "./skills-scan.mjs";
import { QUARANTINE_SKILLS, PROMOTED_SKILLS, LIFECYCLE_LOG, DISARM_FILE, isDisarmed } from "./skills-lifecycle.mjs";
import { appendRowWithId } from "../edges/ledger.mjs";

const HOME = os.homedir();

/** At most this many skills may be created per calendar day. A runaway loop
 *  writing skills unattended is the failure this bounds. */
export const MAX_CREATES_PER_DAY = 1;
/** Hard ceiling on the quarantine tier, regardless of age or rate. */
export const MAX_QUARANTINED = 3;

/**
 * Every name a new skill must not collide with: the live skills directory, both
 * marketplace tiers, and every key skillUsage has ever seen (which includes
 * deleted skills, since it is never pruned -- reusing one of those names would
 * silently inherit its usage count and corrupt the promotion decision).
 */
export function takenNames({ usage = null, skills = null, quarantineDir = QUARANTINE_SKILLS, promotedDir = PROMOTED_SKILLS } = {}) {
  const taken = new Set();
  const scan = skills ?? scanSkills();
  for (const s of scan.skills) taken.add(s.id);
  // Injectable rather than module constants: with the real paths hardcoded, a
  // test fixture would collide with whatever happens to be in the live
  // marketplace -- the same non-hermeticity that made the index sweep opt-in.
  for (const dir of [quarantineDir, promotedDir]) {
    if (!dir || !existsSync(dir)) continue;
    for (const n of readdirSync(dir)) if (!n.startsWith(".")) taken.add(n);
  }
  for (const k of Object.keys(usage ?? readSkillUsage())) {
    taken.add(k.includes(":") ? k.split(":").pop() : k);
  }
  return taken;
}

/**
 * How many skills were created today, per the lifecycle log.
 *
 * Parses raw lines rather than using readLedger(). readLedger is built for
 * DRIFT ledgers and silently drops any row whose type is not drift/code_drift/
 * status_change -- so it returns [] for this log, and an early version of this
 * function therefore reported 0 creations no matter what, silently defeating
 * the rate limit it exists to enforce. A test pins this.
 *
 * Unparseable lines are skipped but never cause an early return: under-counting
 * is the dangerous direction here, so a corrupt log still yields every valid
 * `created` row around it.
 */
export async function createdToday(logPath = LIFECYCLE_LOG, today = new Date().toISOString().slice(0, 10)) {
  if (!existsSync(logPath)) return 0;
  let text;
  try {
    text = readFileSync(logPath, "utf8");
  } catch {
    // Unreadable log -> assume the limit is already spent. Refusing to create
    // is always the safe failure here.
    return Number.MAX_SAFE_INTEGER;
  }
  let n = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row && row.type === "created" && String(row.timestamp || "").startsWith(today)) n += 1;
  }
  return n;
}

/**
 * Gate every creation. Returns {ok} or {ok:false, reason} -- callers report the
 * reason rather than silently doing nothing, so a blocked pipeline is visible.
 */
export async function creationAllowed({ name, logPath = LIFECYCLE_LOG, disarmFile = DISARM_FILE, quarantineDir = QUARANTINE_SKILLS, promotedDir = PROMOTED_SKILLS, usage = null, skills = null } = {}) {
  if (isDisarmed(disarmFile)) return { ok: false, reason: "disarmed" };
  if (!/^[a-z][a-z0-9-]{2,40}$/.test(name || "")) {
    return { ok: false, reason: "name must be kebab-case, 3-41 chars, starting with a letter" };
  }
  if (takenNames({ usage, skills, quarantineDir, promotedDir }).has(name)) {
    return { ok: false, reason: `name collision: "${name}" is already taken by a skill, a marketplace tier, or a historical skillUsage key` };
  }
  const live = existsSync(quarantineDir) ? readdirSync(quarantineDir).filter((n) => !n.startsWith(".")).length : 0;
  if (live >= MAX_QUARANTINED) return { ok: false, reason: `quarantine full (${live}/${MAX_QUARANTINED}) — promote or reap first` };
  const today = await createdToday(logPath);
  if (today >= MAX_CREATES_PER_DAY) return { ok: false, reason: `rate limit (${today}/${MAX_CREATES_PER_DAY} created today)` };
  return { ok: true };
}

/** The generic SKILL.md validator shipped with the installed skill-creator
 *  plugin: checks the file exists, has `---` frontmatter, that the YAML parses,
 *  and that name/description are present and well-formed. */
export const VALIDATOR = path.join(
  HOME, ".claude", "plugins", "cache", "claude-plugins-official",
  "skill-creator", "unknown", "skills", "skill-creator", "scripts", "quick_validate.py",
);

/**
 * Validate a drafted skill.
 *
 * NOT `gbrain skillify check`, which the plan named. That was tried and is the
 * wrong tool: gbrain's audit resolves paths against ITS OWN repo layout
 * (skills/<name>/scripts/<name>.mjs plus tests and a RESOLVER.md entry), so on
 * a standalone marketplace SKILL.md it scored 3/10 with "✗ SKILL.md exists"
 * pointing at a path that was never passed to it. A false negative from a
 * mis-aimed auditor is worse than no auditor, because it trains you to ignore
 * the result.
 *
 * `ran:false, passed:null` when the validator is missing -- a missing auditor
 * must never be recorded as a pass.
 */
export function auditSkill(skillDir, { validator = VALIDATOR } = {}) {
  if (!existsSync(validator)) return { ran: false, passed: null, reason: "quick_validate.py not installed" };
  try {
    const out = execFileSync("python3", [validator, skillDir], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ran: true, passed: true, output: out.trim().slice(0, 2000) };
  } catch (err) {
    return { ran: true, passed: false, output: String(err.stdout || err.message).trim().slice(0, 2000) };
  }
}

/**
 * Create a skill in quarantine from an already-drafted SKILL.md body.
 *
 * Splitting drafting from landing is what makes this testable without invoking
 * a model: draftSkillMd() produces the text, this writes it. The pipeline in
 * createSkill() composes the two.
 */
export async function landInQuarantine(name, skillMd, { quarantineDir = QUARANTINE_SKILLS, logPath = LIFECYCLE_LOG, evidence = [], createdBy = "manual" } = {}) {
  const dir = path.join(quarantineDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), skillMd.endsWith("\n") ? skillMd : skillMd + "\n");

  const audit = auditSkill(dir);
  mkdirSync(path.dirname(logPath), { recursive: true });
  await appendRowWithId(logPath, {
    timestamp: new Date().toISOString(),
    type: "created",
    skill: name,
    id_name: `quarantine:${name}`,
    dir,
    createdBy,
    evidence,
    audit: { ran: audit.ran, passed: audit.passed, reason: audit.reason ?? null },
  });
  return { ok: true, dir, id: `quarantine:${name}`, audit };
}

/**
 * Draft a SKILL.md by delegating to the installed skill-creator plugin.
 *
 * Spawns `claude -p`, which is slow (tens of seconds) and must never be called
 * from inside the launchd digest -- that job has a time budget and a single
 * reporting channel to protect. Explicit invocation only.
 */
export function draftSkillMd(name, intent, { timeoutMs = 240_000 } = {}) {
  const prompt = [
    `Use the skill-creator skill to draft a single SKILL.md for a new Claude Code skill.`,
    ``,
    `Name: ${name}`,
    `Purpose: ${intent}`,
    ``,
    `Output ONLY the SKILL.md file content, starting with the YAML frontmatter`,
    `delimiter --- and nothing before it. No commentary, no code fences.`,
    `The frontmatter must contain exactly: name: ${name}, and a description that`,
    `states concretely WHEN to use the skill, phrased so it can be matched`,
    `against a user request.`,
    `The body must be actionable instructions, not a description of a tool.`,
    `Do not assert arbitrary constants or facts the model cannot verify.`,
  ].join("\n");

  const out = execFileSync("claude", ["-p", prompt], {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const start = out.indexOf("---");
  if (start === -1) throw new Error("draft did not contain YAML frontmatter");
  return out.slice(start).trim();
}

/** Full pipeline: gate -> draft -> audit -> land in quarantine. */
export async function createSkill(name, intent, opts = {}) {
  const gate = await creationAllowed({ name, ...opts });
  if (!gate.ok) return gate;
  let skillMd;
  try {
    skillMd = draftSkillMd(name, intent, opts);
  } catch (err) {
    return { ok: false, reason: `draft failed: ${err.message}` };
  }
  return landInQuarantine(name, skillMd, { ...opts, createdBy: opts.createdBy ?? "skill-creator", evidence: opts.evidence ?? [{ intent }] });
}
