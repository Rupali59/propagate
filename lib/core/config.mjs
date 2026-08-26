/**
 * Skill config + paths. Single place to know where things live.
 *
 * V2: workspaces auto-discovered from .propagates.yml markers under
 * SEARCH_ROOTS (instead of hardcoded). Backwards-compatible: callers
 * still import { WORKSPACES } and get the same array shape.
 */

import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { existsSync, statSync, mkdirSync, readFileSync } from "node:fs";

import { parse as parseYaml } from "yaml";

import { discoverWorkspacesSync } from "./discovery.mjs";

const HOME = os.homedir();

/** `~/x` is what a person hand-writing a config file types. Taken literally it
 *  resolves to `./~/x`, which exists nowhere — and the failure would present as
 *  "root does not exist", pointing the reader at the value they got right. */
function expandHome(p) {
  if (typeof p !== "string") return p;
  if (p === "~") return HOME;
  return p.startsWith("~/") ? path.join(HOME, p.slice(2)) : p;
}

/**
 * Install-time configuration: `$PROPAGATE_STATE_DIR/config.yml`, else
 * `~/.propagate/config.yml`.
 *
 * Precedence is **env > file > built-in default**, in that order and no other.
 * Every machine already running this skill has no config.yml and some have the
 * env vars exported, so any other ordering silently changes behaviour that
 * already works — a config layer that moves defaults is a migration, not a feature.
 *
 * MUST NOT THROW. STATE.md's known hazards: "A throw at config.mjs module load
 * bricks watcher, CLI and UI simultaneously." A config file is hand-written, so
 * a malformed one is a typo — it degrades to defaults and SAYS SO on stderr.
 * Degrading silently would be the other half of the bug: the tool would run with
 * defaults while the operator believed their file was in force.
 *
 * Deliberately NOT the plugin directory: a marketplace update destroys that
 * (N13/N14), and configuration must outlive an update.
 */
const CONFIG_ROOT = process.env.PROPAGATE_STATE_DIR || path.join(HOME, ".propagate");
export const CONFIG_PATH = path.join(CONFIG_ROOT, "config.yml");

export const CONFIG = (() => {
  try {
    if (!existsSync(CONFIG_PATH)) return {};
    const parsed = parseYaml(readFileSync(CONFIG_PATH, "utf8"));
    if (parsed === null || parsed === undefined) return {};
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      console.error(`propagate: ${CONFIG_PATH} is not a mapping — ignoring it, using defaults`);
      return {};
    }
    return parsed;
  } catch (err) {
    console.error(
      `propagate: could not read ${CONFIG_PATH} (${err?.message ?? err}) — ignoring it, using defaults`,
    );
    return {};
  }
})();

/**
 * Where this skill actually lives, derived from this file's own location.
 *
 * Was hardcoded to ~/.claude/skills/propagate, which meant the skill could not
 * find itself anywhere else -- installed as a marketplace plugin, cloned for
 * development, or run from a worktree, every path built from it pointed at a
 * directory that did not exist. `import.meta.url` is the only self-location
 * that survives being moved.
 */
export const SKILL_DIR = (() => {
  // WALK UP TO A MARKER, do not count "..".
  //
  // This was `path.resolve(import.meta.url, "..", "..")` — correct while this file was
  // lib/config.mjs, and wrong by exactly one level the moment it became
  // lib/core/config.mjs (2026-08-20). Seventeen tests went red with
  // `ENOENT .../lib/cross-allow.yml`: every path built on SKILL_DIR silently gained a
  // `lib/` segment. A hardcoded depth encodes this file's position in the tree, which
  // is the one thing a reorganisation changes.
  //
  // Walking to `package.json` self-heals under any future regrouping. The counted form
  // remains as the fallback because config.mjs MUST NOT THROW at module load
  // (STATE.md known hazards: a throw here bricks watcher, CLI and UI at once), and a
  // missing marker is a broken install, not a reason to take the process down.
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(path.join(dir, "package.json")) && existsSync(path.join(dir, "SKILL.md"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return path.resolve(fileURLToPath(import.meta.url), "..", "..");
})();

/**
 * THE HUB ROOT — one declared fact, everything hub-relative derived from it.
 *
 * WHY THIS EXISTS. The hub was restated FOUR times in this file: `searchRoots`,
 * `marketplaceDir`, `portsFile` and the rules symlink, each independently
 * overridable and each defaulting to one author's `~/Documents/GitHub`.
 * `portsFile` was fixed TWICE on 2026-08-23 — once when the registry moved into
 * `execution/`, again when `execution/` moved under `scripts/`. One fact restated
 * four times means a reorganisation has to find all four, and the ones you miss
 * fail SILENTLY: `pick()` returns null, and null reads as "not configured"
 * rather than "configured wrong".
 *
 * NULL WHEN UNDECLARED, NEVER A GUESS. The old built-in default handed a fresh
 * machine `~/Documents/GitHub` — plausible, wrong, and silent: discovery found
 * zero workspaces and everything reported healthy. That is the exact failure
 * this tool exists to catch, and it was living in its own config.
 *
 * NEVER THROWS. STATE.md's known hazards: "A throw at config.mjs module load
 * bricks watcher, CLI and UI simultaneously." Unconfigured is a VALUE the
 * readers inspect (rule:discernment-checks §2), which is why the companion
 * diagnostic below names the fix and not merely the problem.
 */
const _hub = (() => {
  const fromEnv = process.env.PROPAGATE_HUB_ROOT;
  if (typeof fromEnv === "string" && fromEnv.trim()) {
    return { root: expandHome(fromEnv.trim()), source: "PROPAGATE_HUB_ROOT" };
  }
  const fromFile = typeof CONFIG.hubRoot === "string" && CONFIG.hubRoot.trim() ? CONFIG.hubRoot.trim() : null;
  if (fromFile) return { root: expandHome(fromFile), source: `${CONFIG_PATH} hubRoot` };

  // MIGRATION PATH, and the distinction is the whole point. Every install that
  // predates `hubRoot` has an explicit `searchRoots:` and no hub, so a strict
  // null would silently drop marketplaceDir and portsFile to null on all of
  // them — measured on this machine: both resolved before, both null after.
  // Null reads as "not configured" rather than "configured wrong", which is the
  // exact failure the sentinel exists to prevent, arriving by a different door.
  //
  // Inferring from ONE explicitly declared root is not the guess this design
  // rejects: the operator WROTE that path. The rejected guess was a built-in
  // default nobody declared. Two or more roots stay null, because "which of
  // these is the hub" has no answer that is not a guess.
  const declared = Array.isArray(CONFIG.searchRoots) ? CONFIG.searchRoots.filter((r) => typeof r === "string" && r.trim()) : [];
  if (declared.length === 1) {
    return { root: expandHome(declared[0].trim()), source: `${CONFIG_PATH} searchRoots (inferred — declare hubRoot to be explicit)` };
  }
  return { root: null, source: null };
})();

export const HUB_ROOT = _hub.root;

/**
 * Why HUB_ROOT is what it is. `null` root carries the fix, not just the fact —
 * a diagnostic that says "not configured" without saying what to run is a dead
 * end on a fresh machine.
 */
export const HUB_ROOT_DIAGNOSTIC = _hub.root
  ? `hub root ${_hub.root} (from ${_hub.source})${existsSync(_hub.root) ? "" : " — DECLARED BUT MISSING ON DISK"}`
  : `hub root is not configured — tried PROPAGATE_HUB_ROOT and ${CONFIG_PATH} hubRoot. ` +
    `Fix: propagate setup --hub <path>`;

/** A path under the declared hub, or null when no hub is declared. */
function underHub(...segments) {
  return HUB_ROOT ? path.join(HUB_ROOT, ...segments) : null;
}

/**
 * Roots under which workspace discovery walks looking for `.propagates.yml`
 * markers. Each root is walked to a configurable max depth (see discovery.mjs).
 *
 * `~/Documents/GitHub` is this author's layout, not a law. Override with
 * PROPAGATE_SEARCH_ROOTS (colon-separated, like PATH) on any machine that keeps
 * code elsewhere -- without it, discovery on another machine silently finds
 * zero workspaces and the watcher reports healthy forever, which is precisely
 * the "abandoned automation reports itself healthy" failure this skill exists
 * to catch.
 *
 * Nonexistent roots are dropped rather than carried, so a stale entry in the
 * env var cannot make every later walk fail.
 */
const _roots = (() => {
  // Precedence: env > config.yml > built-in default. See CONFIG above for why
  // this order is the only safe one.
  const raw = process.env.PROPAGATE_SEARCH_ROOTS;
  const fromFile = Array.isArray(CONFIG.searchRoots)
    ? CONFIG.searchRoots.map(expandHome).filter((v) => typeof v === "string" && v.length)
    : [];
  const configured = Boolean(raw) || fromFile.length > 0;
  const candidates = raw
    ? raw.split(":").map((s) => s.trim()).filter(Boolean).map(expandHome)
    : fromFile.length
      ? fromFile
      : HUB_ROOT
        ? [HUB_ROOT]
        : []; // no hub declared -> no roots. HUB_ROOT_DIAGNOSTIC says why.
  const usable = candidates.filter((p) => existsSync(p));
  return { roots: usable.length ? usable : candidates, candidates, usable, configured };
})();

export const SEARCH_ROOTS = _roots.roots;

/**
 * WHY the configured roots yielded nothing — the distinction the message above
 * did not make, and the reason a fresh machine was unactionable.
 *
 * "Zero workspaces" has two causes with two different fixes, and until
 * 2026-08-19 both printed the identical line:
 *   roots-missing — the configured path does not exist. A CONFIG error; fix by
 *                   setting PROPAGATE_SEARCH_ROOTS (or running `init`).
 *   no-markers    — the path exists and contains no `.propagates.yml` flagged
 *                   `workspace: true`. An ONBOARDING step; fix by adding a marker.
 * Telling someone to add a marker to a directory that does not exist is worse
 * than saying nothing, which is why this is a distinction and not a nicety.
 *
 * `unconfigured` is called out separately because the default is this author's
 * layout (~/Documents/GitHub), not a law — on any other machine its absence is
 * expected, not a fault, and the message should say so.
 *
 * Computed here rather than at each call site so `status`, `doctor` and the
 * metrics layer cannot drift into describing the same state three ways. Pure
 * string derivation over already-collected data: adds no I/O and cannot throw,
 * which STATE.md's "discovery must never throw" invariant requires.
 * @type {"ok"|"roots-missing"|"no-markers"|"unconfigured"}
 */
const _rootsDiagnostic =
  _roots.usable.length === 0 ? (_roots.configured ? "roots-missing" : "unconfigured") : "ok";

/**
 * How scheduled work runs, if at all: `launchd` | `systemd` | `none`.
 *
 * The default follows the PLATFORM, because declaring launchd on a machine that has no
 * launchd is a declaration that can never come true — and a component that can never run
 * must not read as a component that is merely down.
 *
 * `none` is first-class, not degraded. The v1 watcher is retired, `reconcile` derives
 * drift from content in ~1.2s, and `rule:delegation-criteria` §2 prefers derive-on-demand.
 * A machine with no scheduler loses proactive notification and nothing else.
 *
 * `systemd` is declarable but unimplemented on purpose: naming it makes the gap visible in
 * `doctor` instead of leaving Linux users to infer it from a launchctl error.
 *
 * Unknown values fall back to `none` rather than throwing — a typo in a hand-written config
 * must not brick every entry point (STATE.md known hazards).
 * @type {"launchd"|"systemd"|"none"}
 */
export const SCHEDULERS = Object.freeze(["launchd", "systemd", "none"]);
export const SCHEDULER = (() => {
  const raw = process.env.PROPAGATE_SCHEDULER ?? CONFIG.scheduler;
  if (typeof raw === "string" && SCHEDULERS.includes(raw.trim())) return raw.trim();
  if (typeof raw === "string" && raw.trim()) {
    console.error(
      `propagate: unknown scheduler ${JSON.stringify(raw)} in ${CONFIG_PATH} — using "none". ` +
        `Valid: ${SCHEDULERS.join(", ")}`,
    );
    return "none";
  }
  return process.platform === "darwin" ? "launchd" : "none";
})();

/** True when launchd is both selected and actually available. */
export const LAUNCHD_ACTIVE = SCHEDULER === "launchd" && process.platform === "darwin";

/**
 * Optional integrations with things outside this skill.
 *
 * Every one of these was a hardcoded path to something only this author has —
 * a private marketplace repo, a ports registry, a Homebrew binary. Absent is the
 * normal case on any other machine, so absent must mean "skip this feature",
 * never "error". The codebase already had the right template for that in
 * `auditSkill`'s `{ran:false}` result; these follow it.
 *
 * Env var per integration so a machine can override without a config file at all.
 */
export const INTEGRATIONS = (() => {
  const i = (CONFIG.integrations && typeof CONFIG.integrations === "object") ? CONFIG.integrations : {};
  //
  // `legacy` is a COMPATIBILITY SHIM, not a default. It is the path this value was
  // hardcoded to before 2026-08-19, and it is used only when nothing is configured
  // AND it actually exists on disk — so the machine that has always worked keeps
  // working, and every other machine gets null (feature skips) instead of a
  // confident path into a directory that was never there.
  //
  // Remove each `legacy` once `init` has written the value into config.yml. Until
  // then, deleting them would be a silent regression for the author, and keeping
  // them unconditional would be the portability bug this phase exists to fix.
  const pick = (envName, key, legacy = null) => {
    const v = process.env[envName] ?? i[key];
    if (typeof v === "string" && v.length) return expandHome(v);
    return legacy && existsSync(legacy) ? legacy : null;
  };
  return {
    marketplaceDir: pick(
      "PROPAGATE_MARKETPLACE_DIR",
      "marketplaceDir",
      underHub("skills-marketplace"),
    ),
    // `execution/ports.yml`, not the repo root. The registry moved into
    // `execution/` and this default was left behind, so `pick()` found nothing at
    // the legacy path and resolved to null — which reads as "no ports integration
    // configured" rather than "the default is stale". The failure was quiet in
    // exactly the way a wrong default always is: nothing errored, the ports check
    // simply stopped running and the null leaked into STANDALONE_SEEDS.
    portsFile: pick(
      "PROPAGATE_PORTS_FILE",
      "portsFile",
      underHub("scripts", "execution", "ports.yml"),
    ),
    // Siblings of portsFile, and resolved the same way for the same reason: all
    // three registries live in `scripts/execution/` and key on
    // `<Workspace>/<unit-path>` — the identity `propagate manifest` joins on.
    // A null here must read as "not configured" at the point of use, never as a
    // unit that happens to have no Doppler binding (G24: the sentinel failure
    // arriving by the opposite door).
    deployFile: pick(
      "PROPAGATE_DEPLOY_FILE",
      "deployFile",
      underHub("scripts", "execution", "deploy.yml"),
    ),
    mongoFile: pick(
      "PROPAGATE_MONGO_FILE",
      "mongoFile",
      underHub("scripts", "execution", "mongo.yml"),
    ),
    telegramDir: pick("PROPAGATE_TELEGRAM_DIR", "telegramDir", path.join(HOME, ".claude", "skills", "telegram")),
    notifier: pick("PROPAGATE_NOTIFIER", "notifier"),
  };
})();

/**
 * Workspaces watched for propagation. Discovered at module-load time
 * (sync) by walking SEARCH_ROOTS for .propagates.yml markers flagged
 * `workspace: true`. To onboard a new workspace, drop a .propagates.yml at
 * its root with `workspace: true` (or use the CLI: `node cli.mjs init
 * <dir>`) and reload the watcher.
 *
 * Each record: { name, root, ledgerJsonl, ledgerMd, scanDirs }
 */
/**
 * How deep discovery walks below each root. Was reachable only as a function
 * argument defaulted to 2, so a tree nesting deeper than this author's was
 * invisible with no way to say otherwise. Env > file > the discovery default.
 */
export const MAX_DEPTH = (() => {
  const raw = process.env.PROPAGATE_MAX_DEPTH ?? CONFIG.maxDepth;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
})();

const _discovery = discoverWorkspacesSync(SEARCH_ROOTS, MAX_DEPTH);
export const WORKSPACES = _discovery.workspaces;

export const SEARCH_ROOTS_DIAGNOSTIC =
  _rootsDiagnostic !== "ok" ? _rootsDiagnostic : WORKSPACES.length === 0 ? "no-markers" : "ok";

/**
 * One sentence naming the state AND the action, so no caller has to invent
 * either. Callers render it; they do not re-derive it.
 */
export function searchRootsExplain(diag = SEARCH_ROOTS_DIAGNOSTIC) {
  const roots = SEARCH_ROOTS.join(", ");
  switch (diag) {
    case "roots-missing":
      return `configured search root does not exist: [${roots}] — set PROPAGATE_SEARCH_ROOTS, or run \`init\``;
    case "unconfigured":
      // Two DIFFERENT facts, and conflating them is what this branch exists to
      // avoid. No hub declared at all is a setup problem with a one-command fix;
      // a hub declared but empty is a wrong-path problem. Rendering both as
      // "the default [] does not exist" names neither.
      return HUB_ROOT
        ? `hub root ${HUB_ROOT} contains no workspace — check the path, or set PROPAGATE_SEARCH_ROOTS`
        : HUB_ROOT_DIAGNOSTIC;
    case "no-markers":
      return `search root exists but contains no workspace: [${roots}] — add a \`.propagates.yml\` with \`workspace: true\`, or run \`init <dir>\``;
    default:
      return `${WORKSPACES.length} workspace(s) discovered under [${roots}]`;
  }
}

/**
 * True when `.propagates.yml` markers exist on disk but none opted into
 * `workspace: true` — the exact failure mode of the 2026-08-10 discovery
 * bug (schema rejecting the field before markers used it, or every marker
 * un-flagged). Surfaced so `doctor`/`status` can warn instead of silently
 * reporting zero workspaces as if that were healthy.
 */
export const DISCOVERY_DEGRADED = _discovery.degraded;

/**
 * Partial-loss signal, distinct from DISCOVERY_DEGRADED (which only trips on
 * total collapse — markers seen but zero workspaces found). This is non-empty
 * when ONE marker among several is broken — corrupted YAML, a `workspace` key
 * present but not a strict boolean (e.g. `workspace: "true"`), or an
 * exception while building its workspace record — while the rest of
 * discovery still succeeds. Array of `{path, reason}`. `doctor()` and
 * `status --all --json` must both surface this as a real problem, not a log
 * line — see docs/DECISIONS.md 2026-08-10 "workspace roots become explicit."
 */
export const SUSPICIOUS_MARKERS = _discovery.suspiciousMarkers;

/**
 * Resolve $PROPAGATE_STATE_DIR into a usable absolute directory, or `null` to
 * mean "use the defaults" (SKILL_DIR for state/lock/heartbeat/log, and
 * ~/Library/LaunchAgents for the plist -- see lib/plist.mjs).
 *
 * N13/N14 (docs/ISSUES.md): PROPAGATE_SEARCH_ROOTS scopes discovery but used
 * to leave STATE_PATH/LOCK_PATH/HEARTBEAT_PATH/WATCHER_LOG and PLIST_PATH
 * fixed to production locations, so "point it at a temp tree" -- the
 * documented way to try the watcher safely -- silently corrupted the real
 * mtime baseline (N13) and, via `init`, the real plist's WatchPaths (N14).
 * PROPAGATE_STATE_DIR is the other half of that override: testing the
 * watcher requires setting BOTH PROPAGATE_SEARCH_ROOTS (what it looks at)
 * and PROPAGATE_STATE_DIR (where it remembers what it saw). Setting only one
 * is exactly how both incidents happened.
 *
 * MUST NOT throw. STATE.md's "known hazards" section records that a throw
 * here bricks the watcher, CLI and UI simultaneously -- so a bad value
 * (unwritable, or a path that is a file rather than a directory) degrades to
 * a logged warning and the `null` (default-location) fallback, never a crash.
 */
function resolveStateDir() {
  const raw = process.env.PROPAGATE_STATE_DIR;
  // The DEFAULT, not null. Until 2026-08-20 this returned null and eight call sites
  // below fell back to SKILL_DIR — so state.json, the heartbeat and a 2.9 MB
  // watcher.log lived beside the code, in the one directory a marketplace update
  // replaces wholesale (N13/N14, which this file already warns about). Meanwhile
  // ~/.propagate ALREADY held the v2 state: events/, graph-index.db, monitor.log,
  // notified.jsonl. State was split across two homes with no rule saying which.
  //
  // GOTCHAS G12 ("a default that moves loses state silently") does not forbid this —
  // it requires the move not to lose anything. lib/setup.mjs migrateLegacyState() is
  // how that is discharged; the harm G12 names specifically, the live watcher losing
  // its mtime baseline, ended when the watcher was retired 2026-08-14.
  if (!raw) return path.join(HOME, ".propagate");
  try {
    const abs = path.resolve(raw);
    if (existsSync(abs)) {
      if (!statSync(abs).isDirectory()) {
        console.error(
          `propagate: PROPAGATE_STATE_DIR=${raw} exists and is not a directory -- falling back to default state location`,
        );
        return path.join(HOME, ".propagate");
      }
    } else {
      mkdirSync(abs, { recursive: true });
    }
    return abs;
  } catch (err) {
    console.error(
      `propagate: PROPAGATE_STATE_DIR=${raw} is unusable (${err.message}) -- falling back to default state location`,
    );
    return path.join(HOME, ".propagate");
  }
}

/**
 * `null` means "use the default locations". Non-null relocates state, lock,
 * heartbeat, watcher log, AND the plist (lib/plist.mjs) together -- see the
 * comment on resolveStateDir above. When this is `null`, every path below
 * must resolve byte-identically to what it resolved to before
 * PROPAGATE_STATE_DIR existed -- that is the regression guard against a
 * fifth incident (tests/config-state-dir.test.mjs).
 */
/**
 * Was PROPAGATE_STATE_DIR set by the caller, as opposed to defaulted?
 *
 * Needed because two different things keyed off `STATE_DIR !== null` and only one of
 * them meant "state". lib/plist.mjs put the plist in STATE_DIR when set, so a scoped
 * or test run could not disarm the real launchd job (N14). Once STATE_DIR gained a
 * real default that test became always-true, and the plist would have moved out of
 * ~/Library/LaunchAgents — where launchd actually looks — into ~/.propagate, where
 * nothing would ever load it. Caught by tests/config-state-dir.test.mjs, which is the
 * assertion that exists for precisely this.
 *
 * "Has a default" and "was overridden" are different questions. This is the second.
 */
export const STATE_DIR = resolveStateDir();

export const STATE_DIR_EXPLICIT = (() => {
  const raw = process.env.PROPAGATE_STATE_DIR;
  if (!raw) return false;
  // SET is not the same fact as RESOLVED. An override that is a file, or a path that
  // cannot be created, degrades to the default — and a degraded override must not keep
  // redirecting the plist, or a typo in the env var would quietly move the launchd job
  // out of ~/Library/LaunchAgents.
  try {
    const abs = path.resolve(raw);
    return existsSync(abs) ? statSync(abs).isDirectory() : STATE_DIR === abs;
  } catch {
    return false;
  }
})();

/** State / lock / heartbeat paths (per-skill, not per-workspace). */
export const STATE_PATH = STATE_DIR ? path.join(STATE_DIR, "state.json") : path.join(SKILL_DIR, "state.json");
export const LOCK_PATH = STATE_DIR ? path.join(STATE_DIR, ".lock-target") : path.join(SKILL_DIR, ".lock-target");
export const HEARTBEAT_PATH = STATE_DIR ? path.join(STATE_DIR, "heartbeat") : path.join(SKILL_DIR, "heartbeat");
export const WATCHER_LOG = STATE_DIR ? path.join(STATE_DIR, "watcher.log") : path.join(SKILL_DIR, "watcher.log");
/**
 * `doctor`'s cache for the `claude mcp list` graph-integration probe
 * (docs/ISSUES.md N16). That shell-out measured at 17.8s of a ~19s doctor
 * run to report a WARNING that is known and deferred (TM-064) -- caching it
 * here, alongside the rest of doctor's per-run state, respects
 * PROPAGATE_STATE_DIR the same way STATE_PATH/HEARTBEAT_PATH do so a scoped
 * test run never reads or writes the production cache.
 */
export const GRAPH_MCP_CACHE_PATH = STATE_DIR
  ? path.join(STATE_DIR, "graph-mcp-cache.json")
  : path.join(SKILL_DIR, "graph-mcp-cache.json");

/** Race-guard window — re-read mtime after this delay to avoid mid-edit reads. */
export const MTIME_REVERIFY_DELAY_MS = 3000;

/**
 * Parent-level cross-repo ledger (federated cross edges write here, not
 * per-workspace) — moving to `<hub>/propagation/` alongside every other
 * ledger, per docs/DECISIONS.md "a propagation/ folder in every workspace,
 * including the hub". Basenames unchanged (PROPAGATION_CROSS_LEDGER.*,
 * already matched by `isLedger`).
 *
 * SAME CASCADE DISCIPLINE AS WORKSPACE LEDGERS (lib/core/discovery.mjs
 * makeWorkspaceRecord): prefer `<hub>/propagation/PROPAGATION_CROSS_LEDGER.jsonl`
 * ONLY IF that file already exists; otherwise fall back to the current root
 * path. A first version of this constant pointed unconditionally at
 * `propagation/` before any file existed there — that is not a relocation,
 * it is amnesia: the real file stays at the root path, `readLedger` treats
 * the new (nonexistent) location as empty rather than erroring, so `status
 * --cross` silently reported "0 open" for 8 real live rows instead of saying
 * it could not find the ledger (rule:discernment-checks §2 — "no result" and
 * "no result BECAUSE the file is missing" are different facts). Keying on
 * file existence — exactly the same rule the workspace cascade uses — means
 * this constant is inert until someone actually relocates the file, and
 * follows it automatically the moment they do. `existsSync` cannot throw, so
 * this cannot brick module load (STATE.md's standing hazard for this file).
 */
// NULL-SAFE, because these run at MODULE SCOPE. The comment above says
// "`existsSync` cannot throw, so this cannot brick module load" — true of
// existsSync, and false of the `path.join` on the same line. With no hub
// declared SEARCH_ROOTS is empty, `SEARCH_ROOTS[0]` is undefined, and
// path.join(undefined) throws ERR_INVALID_ARG_TYPE at import time: the exact
// standing hazard this file documents, reached through the one call the comment
// did not consider. Found by the unconfigured-machine test, not in production.
const _crossRoot = SEARCH_ROOTS[0] ?? null;
const _joinRoot = (...seg) => (_crossRoot ? path.join(_crossRoot, ...seg) : null);
const CROSS_LEDGER_ROOT_JSONL = _joinRoot("PROPAGATION_CROSS_LEDGER.jsonl");
const CROSS_LEDGER_ROOT_MD = _joinRoot("PROPAGATION_CROSS_LEDGER.md");
const CROSS_LEDGER_PROPAGATION_JSONL = _joinRoot("propagation", "PROPAGATION_CROSS_LEDGER.jsonl");
const CROSS_LEDGER_PROPAGATION_MD = _joinRoot("propagation", "PROPAGATION_CROSS_LEDGER.md");
const crossLedgerRelocated = Boolean(CROSS_LEDGER_PROPAGATION_JSONL) && existsSync(CROSS_LEDGER_PROPAGATION_JSONL);
export const CROSS_LEDGER_JSONL = crossLedgerRelocated ? CROSS_LEDGER_PROPAGATION_JSONL : CROSS_LEDGER_ROOT_JSONL;
export const CROSS_LEDGER_MD = crossLedgerRelocated ? CROSS_LEDGER_PROPAGATION_MD : CROSS_LEDGER_ROOT_MD;
/** Two-allowlist config + schema, kept in the skill dir (NOT a SEARCH_ROOT) to avoid discovery/feedback. */
/**
 * Cross-repo allowlist. User copy first, shipped copy as the seed.
 *
 * Lived only in SKILL_DIR, which has two problems: a marketplace update destroys
 * it (N13/N14), taking any local edit with it; and the shipped file carries this
 * author's three repo paths, so every other install inherits an allowlist naming
 * directories it does not have. STATE_DIR is the durable place for the edited
 * copy; `init` seeds it from the shipped one.
 */
/**
 * Where canonical rule files live (Phase 5).
 *
 * Defaults to `~/.claude/rules`, which on this machine is a symlink into
 * `~/Documents/GitHub/rules`. That symlink is deliberately NOT resolved or migrated:
 * absorbing the checker is additive and reversible, and moving 16 live rule files to
 * prove a point would be neither.
 */
export const RULES_DIR = (() => {
  const raw = process.env.PROPAGATE_RULES_DIR ?? CONFIG.rulesDir;
  if (typeof raw === "string" && raw.trim()) return expandHome(raw.trim());
  return path.join(HOME, ".claude", "rules");
})();

export const CROSS_ALLOW_PATH = (() => {
  const userCopy = path.join(CONFIG_ROOT, "cross-allow.yml");
  return existsSync(userCopy) ? userCopy : path.join(SKILL_DIR, "cross-allow.yml");
})();
export const CROSS_ALLOW_SHIPPED = path.join(SKILL_DIR, "cross-allow.yml");
export const CROSS_SCHEMA_PATH = path.join(SKILL_DIR, "propagates-cross.schema.json");
/**
 * Decision-trigger bootstrap cutoff (§4b/G6): DECISIONS.md entries dated BEFORE this
 * are seeded-as-processed silently on first run; entries on/after FIRE once. Matches the
 * decisions-check Affects-tag cutoff so we fire exactly the recent partner decisions.
 */
export const CROSS_TRIGGER_EPOCH = "2026-06-09";

/**
 * Code paths whose values are canonical-with a constitution-doc section.
 *
 * V2: this hardcoded list is deprecated. Per-workspace entries live in
 * `<workspace-root>/.code-canonical.yml` (loaded by lib/code-canonical.mjs).
 * The watcher merges per-workspace entries at scan time.
 *
 * Kept as an empty array for backwards-compat with any callers that
 * import CODE_CANONICAL. New entries should NOT be added here.
 */
export const CODE_CANONICAL = [];

// ─── moved from cli.mjs 2026-08-25 (#31 T2) — see the git log for why ───

export function shortPath(p) {
  if (!p) return "(none)";
  const root = SEARCH_ROOTS[0];
  return root && p.startsWith(root + "/") ? p.slice(root.length + 1) : p;
}

/**
 * The workspace whose root contains the current working directory, or null if
 * cwd is outside every known workspace. Lets `status` default to "this project"
 * instead of relaying every workspace's queue.
 */
export function currentWorkspace() {
  const cwd = process.cwd();
  // Nearest ancestor, not first match. A repo registered as its own workspace
  // also sits under a broader one (e.g. Keerti-portfolio inside the GitHub hub),
  // and `.find()` returned whichever was discovered first — so `status` run from
  // inside the repo relayed the hub's queue instead of the repo's. Longest
  // matching root wins, matching `findAllSidecarsRecursive`'s scoping.
  const matches = WORKSPACES.filter(
    (ws) => cwd === ws.root || cwd.startsWith(ws.root + path.sep),
  );
  if (matches.length === 0) return null;
  return matches.reduce((best, ws) => (ws.root.length > best.root.length ? ws : best));
}
