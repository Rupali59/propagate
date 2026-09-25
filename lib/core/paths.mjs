/**
 * lib/core/paths.mjs — every path this plugin knows, joined once.
 *
 * PURE ONLY. Zero filesystem I/O, zero side effects at module load. No
 * mkdirSync, no discoverWorkspacesSync, no readdirSync. Anything needing
 * discovery, a hub, config.yml, or a write stays in lib/core/config.mjs
 * (STATE_DIR's mkdirSync, HUB_ROOT, SEARCH_ROOTS, WORKSPACES, INTEGRATIONS,
 * CROSS_LEDGER_*) — see the plan this file implements,
 * `~/.claude/plans/i-saw-it-what-starry-sparkle.md` §1-2, for why the seam
 * falls here rather than somewhere else.
 *
 * WHY THIS EXISTS. config.mjs measured 100-470ms to import because a pure
 * string join (RULES_DIR, :599-603 as of 2026-09-25) paid for a filesystem
 * walk (discoverWorkspacesSync) declared ~220 lines earlier in the same
 * file. hooks/*.mjs spawn a fresh Node process per tool call, so there is no
 * caching to amortise that cost — it is paid again on every single Edit and
 * Write (measured 410-740ms for hooks/doc-authority.mjs, which already pays
 * it deliberately; the other three hooks hand-rolled their own literals
 * specifically to avoid it — see N96). Importing THIS file instead costs
 * roughly what importing "node:path" costs.
 *
 * ADD A ROW to PATHS. Never a path.join at a call site — that is how three
 * components (the rules loader, the rule-guard hook, and doctor's own
 * checker) ended up computing ~/.claude/rules independently, agreeing today
 * only by coincidence (N96). If one of them drifts, rules load from one
 * directory while the checker reads another, and both report success.
 */
import path from "node:path";
import os from "node:os";

export const HOME = os.homedir();
export const CLAUDE_HOME = path.join(HOME, ".claude");
export const AGENTS_HOME = path.join(HOME, ".agents");

/**
 * `~/x` is what a person hand-writing a config file types. Taken literally it
 * resolves to `./~/x`, which exists nowhere -- and the failure would present
 * as "root does not exist", pointing the reader at the value they got right.
 *
 * Moved here from lib/core/config.mjs, which declared its own unexported copy
 * (config.mjs:23-27). It is a pure string transform with no I/O, so it
 * belongs on the cheap side of the seam; config.mjs now imports this one
 * instead of keeping a second copy that could drift from it.
 */
export function expandHome(p) {
  if (typeof p !== "string") return p;
  if (p === "~") return HOME;
  return p.startsWith("~/") ? path.join(HOME, p.slice(2)) : p;
}

function underClaude(...segments) {
  return path.join(CLAUDE_HOME, ...segments);
}
function underAgents(...segments) {
  return path.join(AGENTS_HOME, ...segments);
}

/**
 * Every path this plugin knows that is a PURE JOIN under HOME, CLAUDE_HOME or
 * AGENTS_HOME -- no discovery, no hub, no config.yml lookup, no existsSync.
 *
 * The first fourteen entries are N96's own count (2026-09-25): literals
 * computed independently 2-10 times each across `lib/report/doctor/
 * discovery.mjs`, `hooks/load-rules.mjs`, `hooks/rule-guard.mjs`,
 * `lib/gotchas/parse.mjs`, `lib/skills/skills-scan.mjs`,
 * `lib/skills/skills-lifecycle.mjs`, `lib/report/doctor/delivery.mjs` and
 * `lib/report/inventory.mjs`.
 *
 * `claude.userConfig` (~/.claude.json) was found during this migration and is
 * NOT one of N96's fourteen -- that session's table only counted the five
 * literal patterns it happened to grep for, and `.claude.json` was not one of
 * them. It is duplicated verbatim between `lib/skills/skills-scan.mjs:49`
 * (`CLAUDE_JSON`) and `cli.mjs:530`, which is exactly N96's shape one level
 * down: two places independently computing the same path, agreeing today by
 * coincidence. Flagged in the Lane A report rather than silently added to
 * N96's own count, which is someone else's file to correct.
 */
export const PATHS = {
  "claude.rules": underClaude("rules"),
  "claude.gotchasGlobal": underClaude("gotchas-global.md"),
  "claude.gotchaGuardLog": underClaude("gotcha-guard.log"),
  "claude.ruleGuardLog": underClaude("rule-guard.log"),
  "claude.settings": underClaude("settings.json"),
  "claude.globalClaudeMd": underClaude("CLAUDE.md"),
  "claude.dailyMd": underClaude("DAILY.md"),
  "claude.skills": underClaude("skills"),
  "claude.projects": underClaude("projects"),
  "claude.pluginCache": underClaude("plugins", "cache"),
  "claude.installedPlugins": underClaude("plugins", "installed_plugins.json"),
  "claude.skillsRegistryOff": underClaude("skills-registry.off"),
  "claude.userConfig": path.join(HOME, ".claude.json"),
  "agents.skillLock": underAgents(".skill-lock.json"),
  "agents.skills": underAgents("skills"),

  // The state dir's PURE default, separate from stateDir() which is env-aware.
  // Both are needed: ensureStateDir()'s fallback fires precisely WHEN
  // PROPAGATE_STATE_DIR is set but unusable, so it cannot call stateDir() again
  // and get a different answer. Without this entry config.mjs was structurally
  // forced to hand-roll the literal twice -- found by the Lane E guard, which
  // had to carve an exception for exactly that. The entry removes the exception.
  "propagate.stateDirDefault": path.join(HOME, ".propagate"),
};

/**
 * Named exports, generated from the table above -- ES modules require static
 * export names, so "generated" means each one is a direct read of its PATHS
 * entry rather than a second, independently-typed path.join. This is what
 * lets RULES_DIR (lib/core/config.mjs) and future callers keep their existing
 * names: config.mjs's RULES_DIR now composes its env/config.yml precedence on
 * top of CLAUDE_RULES instead of repeating the literal, and any hook that
 * wants the bare default (no config.yml layer -- see the note on RULES_DIR
 * below) can import CLAUDE_RULES directly with no string-keyed lookup.
 *
 * These are the PURE DEFAULT, not the fully-resolved value. `claude.rules`
 * historically also honours PROPAGATE_RULES_DIR and config.yml's `rulesDir:`
 * (config.mjs:599-603) -- that three-level precedence needs CONFIG, which
 * does real file I/O at module load, so it stays a config.mjs concern.
 * `claude.gotchasGlobal` and `claude.gotchaGuardLog` are likewise defaults:
 * `lib/gotchas/parse.mjs` overrides them with GOTCHA_GUARD_GLOBAL /
 * GOTCHA_GUARD_LOG, and keeps doing so on top of these constants rather than
 * losing that override.
 */
export const CLAUDE_RULES = PATHS["claude.rules"];
export const CLAUDE_GOTCHAS_GLOBAL = PATHS["claude.gotchasGlobal"];
export const CLAUDE_GOTCHA_GUARD_LOG = PATHS["claude.gotchaGuardLog"];
export const CLAUDE_RULE_GUARD_LOG = PATHS["claude.ruleGuardLog"];
export const CLAUDE_SETTINGS = PATHS["claude.settings"];
export const CLAUDE_GLOBAL_CLAUDE_MD = PATHS["claude.globalClaudeMd"];
export const CLAUDE_DAILY_MD = PATHS["claude.dailyMd"];
export const CLAUDE_SKILLS = PATHS["claude.skills"];
export const CLAUDE_PROJECTS = PATHS["claude.projects"];
export const CLAUDE_PLUGIN_CACHE = PATHS["claude.pluginCache"];
export const CLAUDE_INSTALLED_PLUGINS = PATHS["claude.installedPlugins"];
export const CLAUDE_SKILLS_REGISTRY_OFF = PATHS["claude.skillsRegistryOff"];
export const CLAUDE_USER_CONFIG = PATHS["claude.userConfig"];
export const AGENTS_SKILL_LOCK = PATHS["agents.skillLock"];
export const AGENTS_SKILLS = PATHS["agents.skills"];
export const STATE_DIR_DEFAULT = PATHS["propagate.stateDirDefault"];

/**
 * One diagnostic string per PATHS key, HUB_ROOT_DIAGNOSTIC's shape
 * (config.mjs:156-159) generalised: a string naming the fix, not just the
 * problem (rule:discernment-checks §2 -- "no result" and "no result BECAUSE"
 * are different facts).
 *
 * Every PATHS entry above always resolves -- HOME comes from os.homedir(),
 * which does not fail on a normal machine -- so today every diagnostic reads
 * "ok: <path>". That is deliberate rather than vacuous: it gives the NEXT
 * nullable entry (a hub-relative path, following HUB_ROOT's four-state
 * resolution) the same mechanism from day one, instead of repeating the gap
 * this plan closes for INTEGRATIONS (N95/PR-016: a null reached an unguarded
 * existsSync with no diagnostic naming the fix anywhere).
 */
export const PATHS_DIAGNOSTIC = Object.fromEntries(
  Object.entries(PATHS).map(([name, value]) => [
    name,
    typeof value === "string" && value.length ? `ok: ${value}` : `${name} could not be resolved`,
  ]),
);

/**
 * Returns PATHS[name], or THROWS naming the fix -- a null must never reach an
 * unguarded existsSync silently (G24, N95, PR-016 in one line).
 *
 * Every entry in PATHS is a pure HOME join and therefore always resolves, so
 * this only throws today for a caller's typo (a name not in PATHS) or a
 * future entry that can legitimately be unconfigured. It is the same shape
 * `lib/core/config.mjs` uses for `INTEGRATIONS` (`requireIntegration()`,
 * added in this same change) — one throwing accessor per registry, not two
 * unrelated ones.
 */
export function requirePath(name) {
  const value = PATHS[name];
  if (typeof value === "string" && value.length) return value;
  throw new Error(
    `propagate: requirePath(${JSON.stringify(name)}) -- ` +
      `${PATHS_DIAGNOSTIC[name] ?? `unknown path name (not declared in PATHS): ${name}`}`,
  );
}

/**
 * PURE resolver for where state lives -- the env override, resolved, or the
 * default. No existsSync, no statSync, no mkdirSync: those are the impure
 * half (`ensureStateDir()` in lib/core/config.mjs), which needs to know
 * whether the directory can actually be created/used and falls back to the
 * default when it cannot. `config.mjs`'s `STATE_DIR` is
 * `ensureStateDir(stateDir())` -- this function supplies the CANDIDATE, not
 * the final value; the two can differ when PROPAGATE_STATE_DIR names a file,
 * an uncreatable path, or is otherwise unusable, in which case the impure
 * half falls back to the same default this function would have returned had
 * the env var never been set.
 */
export function stateDir() {
  const raw = process.env.PROPAGATE_STATE_DIR;
  return raw ? path.resolve(raw) : STATE_DIR_DEFAULT;
}
