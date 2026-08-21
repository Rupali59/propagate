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

import { readFileSync, readdirSync, lstatSync, statSync, existsSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { resolveBin } from "../core/which.mjs";
import { SEARCH_ROOTS, MAX_DEPTH, INTEGRATIONS } from "../core/config.mjs";
import { isSkippedDir } from "../core/discovery.mjs";

const HOME = os.homedir();

export const SKILLS_DIR = path.join(HOME, ".claude", "skills");
export const SKILL_LOCK = path.join(HOME, ".agents", ".skill-lock.json");
export const CLAUDE_JSON = path.join(HOME, ".claude.json");
export const PROJECTS_DIR = path.join(HOME, ".claude", "projects");
/** Same path lib/report/inventory.mjs uses (SETTINGS_PATH). Not imported from
 *  there: inventory.mjs imports THIS module, so importing back would cycle. */
export const SETTINGS_PATH = path.join(HOME, ".claude", "settings.json");
/** Marker discovery.mjs's walk requires on a symlinked directory before it will
 *  follow it. Duplicated as a literal rather than imported -- discovery.mjs
 *  does not export it, and it is unlikely to ever change independently of the
 *  schema it names. */
const PROPAGATES_MARKER = ".propagates.yml";

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
 * Corroborating liveness probe: explicit `Skill` tool calls in session
 * transcripts. Returns {name: {count, sessions}}.
 *
 * This is the second half of the reaper's AND-rule. skillUsage alone is a
 * superset (it includes autonomous activation) and is authoritative for "was
 * this used"; transcripts add *attribution* -- which session, how spread out --
 * and act as an independent check on a single counter we do not control.
 *
 * NO CACHE, DELIBERATELY. The plan called for an mtime-incremental scan over
 * ~861 MB / 3023 files. Measured, the full scan is cheap enough that a cache
 * would buy nothing while introducing exactly the thing this codebase keeps
 * getting bitten by -- a stored view that can disagree with reality. A full
 * scan is derived and cannot drift.
 *
 * ON THE SEARCHER. An early benchmark of "0.54s" was wrong: the interactive
 * shell aliases `grep` to a function that shims to Claude Code's bundled
 * ugrep, so it measured a different program than this code runs. The real
 * numbers over this tree:
 *
 *     /usr/bin/grep (BSD)  6.45s
 *     ripgrep              0.13s
 *
 * So ripgrep is preferred and grep is the fallback. Their flags differ in a way
 * that bites: `-I` means --no-filename in rg and --binary-files=without-match
 * in grep, and rg honours .gitignore unless told not to. Filenames are required
 * here for session attribution, hence the explicit -H plus --no-ignore/--hidden.
 *
 * One process for the whole tree, never one per file; 3023 spawns would cost
 * far more than the scan.
 */
/**
 * Which whole-tree search tool to use, resolved on PATH.
 *
 * Was `const RG = "/opt/homebrew/bin/rg"` with `/usr/bin/grep` as the fallback —
 * Apple-Silicon Homebrew and a GNU/BSD layout, both pinned absolutely. On an Intel
 * Mac, under a version manager, or on Linux the first does not exist and the second
 * is not guaranteed, so this did not degrade: it spawned a path that was not there.
 *
 * Returns null when NEITHER exists, so the caller reports "could not look" instead of
 * rendering an empty scan as "nothing found" — rule:discernment-checks §2. Exported
 * so a test can assert the choice without spawning anything.
 *
 * @returns {{bin: string, kind: "rg"|"grep"}|null}
 */
export function resolveScanner() {
  const rg = resolveBin("rg");
  if (rg) return { bin: rg, kind: "rg" };
  const grep = resolveBin("grep");
  if (grep) return { bin: grep, kind: "grep" };
  return null;
}

export function probeTranscripts({ projectsDir = PROJECTS_DIR } = {}) {
  const PATTERN = '"skill":"[^"]*"';
  const scanner = resolveScanner();
  if (!scanner) {
    // Attributable absence: no search tool on PATH is not the same fact as no
    // skills used, and must never render as it.
    return { scanned: false, reason: "no-search-tool", skills: new Map() };
  }
  const [bin, args] =
    scanner.kind === "rg"
      ? [scanner.bin, ["--no-heading", "-H", "-o", "-N", "--no-ignore", "--hidden", "-g", "*.jsonl", PATTERN, projectsDir]]
      : [scanner.bin, ["-rHo", PATTERN, projectsDir, "--include=*.jsonl"]];

  let out = "";
  try {
    out = execFileSync(bin, args, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (err) {
    // Both tools exit 1 on "no matches", which is a legitimate empty result,
    // not a failure. Any other status degrades to scanned:false so callers can
    // say so rather than silently reporting zero -- this runs inside the
    // launchd digest, where a wrong zero would read as "nothing is used".
    if (err && err.status === 1 && typeof err.stdout === "string") out = err.stdout;
    else return { byName: {}, scanned: false, searcher: bin };
  }

  const byName = {};
  for (const line of out.split("\n")) {
    if (!line) continue;
    // `<path>:"skill":"<name>"` — split on the first `:"skill":"` so paths
    // containing colons stay intact.
    const at = line.indexOf(':"skill":"');
    if (at === -1) continue;
    const file = line.slice(0, at);
    const name = line.slice(at + 10, -1);
    if (!name) continue;
    const rec = (byName[name] ??= { count: 0, sessions: new Set() });
    rec.count += 1;
    rec.sessions.add(path.basename(file, ".jsonl"));
  }
  // Sets are not JSON-serialisable and this feeds --json.
  for (const [k, v] of Object.entries(byName)) {
    byName[k] = { count: v.count, sessions: v.sessions.size };
  }
  return { byName, scanned: true, searcher: bin };
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
 * COMPLETENESS -- eight predicates over a single skill, added to each record
 * scanSkills() already emits. See docs/plans (step 8, "extend, don't write
 * new"): this reuses classifyInstaller/readFrontmatterName's frontmatter
 * block, config.mjs's SEARCH_ROOTS/MAX_DEPTH, and discovery.mjs's
 * isSkippedDir -- no new script, no new config surface.
 *
 * Each predicate is `true` / `false` / one of a small set of named strings for
 * "not applicable" or "applicable but not run". Never a silent `null` --
 * rule:discernment-checks §2: absence must be attributable. `"n/a"` means the
 * precondition for the check does not hold (no tests/ dir, no name field to
 * compare, skill not shipped so "enabled" is moot). `"not-run"` /
 * `"no-test-script"` are for testsGreen specifically, where the precondition
 * DOES hold but the check was skipped or could not execute -- collapsing that
 * into `"n/a"` would make an opt-out indistinguishable from "there was nothing
 * to check".
 */

/**
 * Parse `name:` and `description:` out of SKILL.md frontmatter, same
 * delimiter rules as readFrontmatterName but returning both fields.
 *
 * Not a real YAML parse (see readFrontmatterName's comment for why one isn't
 * pulled in here). The one YAML shape this file's regex-only sibling would
 * get wrong is a block scalar (`description: |` followed by indented lines,
 * used by gstack-design-layer and others) -- handled below by collecting the
 * indented continuation lines, because a naive single-line match would read
 * the description as the literal string "|" and fail descriptionStatesWhen
 * for every skill that wraps its description onto multiple lines.
 */
export function readFrontmatterFields(skillMdPath) {
  const empty = { present: false, name: null, description: null };
  if (!skillMdPath) return empty;
  let text;
  try {
    text = readFileSync(skillMdPath, "utf8").slice(0, 8192);
  } catch {
    return empty;
  }
  if (!text.startsWith("---")) return empty;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return empty;
  const block = text.slice(0, end);
  const lines = block.split("\n");

  function extract(field) {
    const re = new RegExp(`^${field}:[ \\t]*(.*)$`);
    const idx = lines.findIndex((l) => re.test(l));
    if (idx === -1) return null;
    const inline = lines[idx].match(re)[1].trim();
    const isBlockScalar = inline === "|" || inline === "|-" || inline === ">" || inline === ">-";
    if (!isBlockScalar) {
      return inline.replace(/^["']|["']$/g, "") || null;
    }
    // Gather subsequent indented lines as the block body.
    const body = [];
    for (let i = idx + 1; i < lines.length; i++) {
      if (lines[i] === "") { body.push(""); continue; }
      if (/^[ \t]/.test(lines[i])) { body.push(lines[i].replace(/^[ \t]+/, "")); continue; }
      break;
    }
    const joiner = inline.startsWith(">") ? " " : "\n";
    const joined = body.join(joiner).trim();
    return joined || null;
  }

  return { present: true, name: extract("name"), description: extract("description") };
}

/** `rule:description-standard`: a description says WHEN, not what. */
const DESCRIBES_WHEN_RE = /\bUse (when|whenever|for|before)\b|\bTriggers on\b/i;

/**
 * Every directory discovery's walk (lib/core/discovery.mjs) would visit, as
 * realpaths, up to maxDepth below each root. Mirrors that walk's rules --
 * dotfiles and isSkippedDir() names pruned; a symlinked directory is followed
 * ONLY when it carries its own .propagates.yml marker -- without importing
 * its unexported listDirs()/walk(): this only needs "which directories are
 * reachable", not workspace records or ledger resolution.
 *
 * Kept deliberately uncached, same rationale probeTranscripts states: a
 * stored view of a filesystem walk is exactly the kind of thing that drifts
 * from reality in this codebase, and the walk itself (bounded by maxDepth) is
 * cheap.
 */
export function reachableRealpaths(searchRoots = SEARCH_ROOTS, maxDepth = MAX_DEPTH) {
  const out = new Set();
  const walked = new Set();

  function walk(dir, depth) {
    if (depth > maxDepth) return;
    let real;
    try {
      real = realpathSync(dir);
    } catch {
      return;
    }
    if (walked.has(real)) return;
    walked.add(real);
    out.add(real);
    if (depth === maxDepth) return;

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || isSkippedDir(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(p, depth + 1);
        continue;
      }
      if (!e.isSymbolicLink()) continue;
      try {
        if (!statSync(p).isDirectory()) continue;
        if (!existsSync(path.join(p, PROPAGATES_MARKER))) continue;
        walk(p, depth + 1);
      } catch {
        /* dangling or unreadable link -- skip, same as discovery.mjs */
      }
    }
  }

  for (const root of searchRoots) {
    if (existsSync(root)) walk(root, 0);
  }
  return out;
}

/**
 * Is `<skillDir>/.propagates.yml` reachable by propagate's own discovery?
 * "n/a" when the skill declares no sidecar at all -- the predicate only means
 * something once a sidecar exists to be unreachable. This generalises the
 * curate-docs defect the plan names: an edge declared in a sidecar that sits
 * outside every SEARCH_ROOTS walk is invisible to `propagate status`, which
 * then reports "no open drift" for a tree it never looked at.
 */
export function sidecarReachable(entryPath, reachableSet) {
  const sidecar = path.join(entryPath, PROPAGATES_MARKER);
  if (!existsSync(sidecar)) return "n/a";
  let real;
  try {
    real = realpathSync(entryPath);
  } catch {
    return false;
  }
  return reachableSet.has(real);
}

/**
 * Has this skill reached the marketplace -- either vendored as a directory
 * under `<marketplaceDir>/<tier>/skills/<name>/` (Tier B), or declared as a
 * plugin entry in marketplace.json (Tier A, e.g. propagate/curate-docs, which
 * ship from their own repo via a `source: {source: url}` entry rather than a
 * vendored directory)?
 *
 * Returns the matching tier/plugin name alongside the bool because predicate
 * 6 (enabled) needs to know WHICH `<plugin>@tathya` key to look up -- a skill
 * vendored under `quarantine/skills/` is gated by `quarantine@tathya`, one
 * under `tathya/skills/` by `tathya@tathya`, and a Tier-A plugin by its own
 * marketplace.json name.
 */
export function findShipment(name, marketplaceDir = INTEGRATIONS.marketplaceDir) {
  if (!marketplaceDir || !existsSync(marketplaceDir)) return { shipped: false, plugin: null };

  let tiers = [];
  try {
    tiers = readdirSync(marketplaceDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name);
  } catch {
    tiers = [];
  }
  for (const tier of tiers) {
    const skillsPath = path.join(marketplaceDir, tier, "skills");
    try {
      if (existsSync(skillsPath) && readdirSync(skillsPath).includes(name)) {
        return { shipped: true, plugin: tier };
      }
    } catch {
      /* unreadable tier dir -- try the next one rather than failing the scan */
    }
  }

  const mp = readJsonSafe(path.join(marketplaceDir, ".claude-plugin", "marketplace.json"), null);
  if (mp && Array.isArray(mp.plugins)) {
    const hit = mp.plugins.find((p) => p && p.name === name);
    if (hit) return { shipped: true, plugin: hit.name };
  }
  return { shipped: false, plugin: null };
}

/**
 * Is `<plugin>@tathya` `true` in ~/.claude/settings.json's `enabledPlugins`?
 * `null` when settings.json itself could not be read -- collapsed to `false`
 * by the caller for predicate 6's boolean/"n/a" contract, but kept distinct
 * here so a test can tell "key absent/false" from "couldn't check" if it ever
 * needs to.
 */
export function isPluginEnabled(plugin, settingsPath = SETTINGS_PATH) {
  if (!plugin) return null;
  const settings = readJsonSafe(settingsPath, null);
  const enabled =
    settings && typeof settings === "object" && settings.enabledPlugins && typeof settings.enabledPlugins === "object"
      ? settings.enabledPlugins
      : null;
  if (!enabled) return null;
  return enabled[`${plugin}@tathya`] === true;
}

/**
 * Predicate 8. Never invoked unless withTests is explicitly true -- shelling
 * to `npm test` on every scan would be slow and has side effects (exactly what
 * the brief this was written against forbids). "n/a" when there is no tests/
 * dir at all; "not-run" when one exists but withTests was not passed this
 * call, so a skipped check never reads the same as "nothing to check".
 */
export function runSkillTests(entryPath, { withTests = false, timeoutMs = 120_000 } = {}) {
  const testsDir = path.join(entryPath, "tests");
  if (!existsSync(testsDir)) return "n/a";
  if (!withTests) return "not-run";

  const pkg = readJsonSafe(path.join(entryPath, "package.json"), null);
  const hasTestScript = Boolean(pkg && pkg.scripts && typeof pkg.scripts.test === "string" && pkg.scripts.test.trim());
  if (!hasTestScript) return "no-test-script";

  try {
    execFileSync("npm", ["test", "--silent"], {
      cwd: entryPath,
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
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
  transcripts = null,
  marketplaceDir = INTEGRATIONS.marketplaceDir,
  settingsPath = SETTINGS_PATH,
  searchRoots = SEARCH_ROOTS,
  maxDepth = MAX_DEPTH,
  withTests = false,
} = {}) {
  const provenance = lock ?? readSkillLock();
  const usageMap = usage ?? readSkillUsage();
  const tx = transcripts ?? {};
  // Computed once per scan, not per skill -- one bounded walk, reused for
  // every skill's sidecarReachable predicate.
  const reachable = reachableRealpaths(searchRoots, maxDepth);

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
    const t = tx[name] ?? null;
    const usageCount = use ? use.usageCount : 0;
    const transcriptCount = t ? t.count : 0;

    const fields = readFrontmatterFields(skillMd);
    const shipment = findShipment(name, marketplaceDir);
    const enabledRaw = shipment.shipped ? isPluginEnabled(shipment.plugin, settingsPath) : null;

    skills.push({
      id: name,                       // the invocation key
      dir: entryPath,
      installer,
      declaredName,
      nameMismatch: Boolean(declaredName && declaredName !== name),
      resolvedSkillMd: skillMd,
      dangling: skillMd === null,
      provenance: provenance[name] ?? null,
      usageCount,
      lastUsedAt: use ? use.lastUsedAt : null,
      transcriptCount,
      transcriptSessions: t ? t.sessions : 0,
      // The reaper's AND-rule: a skill counts as untouched only when BOTH
      // independent probes say so. Either one alone has a failure mode --
      // skillUsage is a file we do not control, transcripts only cover the era
      // since the Skill tool existed.
      neverInvoked: usageCount === 0 && transcriptCount === 0,
      // Eight predicates, added without touching any field above. See the
      // block comment above readFrontmatterFields() for the true/false/"n/a"
      // contract each one follows.
      completeness: {
        skillMd: skillMd !== null,
        frontmatter: Boolean(fields.present && fields.name && fields.description),
        nameMatchesDir: declaredName == null ? "n/a" : declaredName === name,
        descriptionStatesWhen: fields.description ? DESCRIBES_WHEN_RE.test(fields.description) : false,
        shipped: shipment.shipped,
        // shipped:false -> "n/a" (nothing to be enabled); shipped:true but
        // settings.json unreadable -> false, per isPluginEnabled's contract.
        enabled: shipment.shipped ? enabledRaw === true : "n/a",
        sidecarReachable: sidecarReachable(entryPath, reachable),
        testsGreen: runSkillTests(entryPath, { withTests }),
      },
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
    // Disagreement between the two probes. Non-zero is expected and healthy
    // (skillUsage counts autonomous activation); a skill appearing in
    // transcripts but NOT in skillUsage would be the surprising direction and
    // is worth seeing, because it would undermine skillUsage as primary.
    transcriptOnly: skills.filter((s) => s.usageCount === 0 && s.transcriptCount > 0).length,
    noProvenance: skills.filter((s) => !s.provenance && s.installer === INSTALLER.HANDMADE).length,
    nameMismatches: skills.filter((s) => s.nameMismatch).length,
    dangling: skills.filter((s) => s.dangling).length,
    orphanUsageKeys: orphanUsageKeys.length,
  };
}
