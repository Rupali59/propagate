/**
 * Lane A of `~/.claude/plans/i-saw-it-what-starry-sparkle.md` — the split of
 * lib/core/config.mjs into a pure `lib/core/paths.mjs` registry plus the
 * discovery/write-coupled remainder that stays in config.mjs.
 *
 * THIS IS THE PROOF G24 DEMANDS. The last centralisation in this repo
 * (`hubRoot`) silently nulled two integrations and nothing compared before
 * against after — GOTCHAS G24: "caught in-session by reading the derived
 * values, not by any test." This file is that test: every one of
 * config.mjs's 36 existing exports is asserted BYTE-IDENTICAL to what a
 * fresh subprocess produced before lib/core/paths.mjs existed, captured by
 * hand at $TMPDIR/laneA-before/exports.json during implementation and
 * reproduced here as literal expected values so the comparison survives
 * after that scratch file is gone.
 *
 * Run via `npm test` (G56 — never bare `node --test`, that writes to the
 * production event ledger).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Run a script in a child process with a controlled environment. A child is
 * required — config.mjs (and now paths.mjs) compute everything at module
 * load, so the same process cannot observe two different environments
 * (same reasoning as tests/portability/config-file.test.mjs's loadConfig).
 */
function evalIn(code, env = {}) {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: REPO,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: r.status, stdout: (r.stdout ?? "").trim(), stderr: r.stderr ?? "" };
}

/** A throwaway HOME + empty search root + isolated state dir, so discovery at
 *  import time has nothing real to walk and nothing here depends on this
 *  machine's actual ~/.claude or ~/Documents/GitHub. */
function freshEnv() {
  const home = mkdtempSync(path.join(tmpdir(), "paths-migration-home-"));
  const state = mkdtempSync(path.join(tmpdir(), "paths-migration-state-"));
  const search = mkdtempSync(path.join(tmpdir(), "paths-migration-search-"));
  return {
    home,
    state,
    search,
    env: { HOME: home, PROPAGATE_STATE_DIR: state, PROPAGATE_SEARCH_ROOTS: search },
    cleanup() {
      for (const d of [home, state, search]) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

// "__undefined__" sentinel, not a bare `undefined` value: JSON.stringify DROPS
// object keys whose value is undefined entirely (MAX_DEPTH is legitimately
// undefined by default), which would silently vanish from `out` and make the
// key-set comparison below report it as a missing export rather than an
// unchanged one — caught by actually running this test (rule:discernment-checks §4).
const DUMP_ALL_EXPORTS = `
import * as m from "./lib/core/config.mjs";
const out = {};
for (const k of Object.keys(m).sort()) {
  const v = m[k];
  out[k] = v === undefined ? "__undefined__" : (typeof v === "function" ? \`[function \${v.name}]\` : v);
}
out["searchRootsExplain()"] = m.searchRootsExplain();
console.log(JSON.stringify(out));
`;

test("migration equality — all 36 pre-existing config.mjs exports are byte-identical after the paths.mjs split", () => {
  const fx = freshEnv();
  try {
    const r = evalIn(DUMP_ALL_EXPORTS, fx.env);
    assert.equal(r.status, 0, `helper subprocess failed: ${r.stderr}`);
    assert.equal(r.stderr, "", `module load must be silent on a fresh, unconfigured machine: ${r.stderr}`);
    const after = JSON.parse(r.stdout);

    // Captured BEFORE any edit in this lane, from the unmodified tree, with the
    // identical env shape (throwaway HOME/PROPAGATE_STATE_DIR/PROPAGATE_SEARCH_ROOTS)
    // — see the report for the literal command. Reproduced here as data rather than
    // kept only in a scratch file, so this test remains the proof after the scratch
    // file is gone. Values are structural (paths under fx.home/fx.state/fx.search),
    // asserted by RE-DERIVING the same structure from the fresh dirs rather than by
    // pinning literal paths, which would only be valid for the single run that
    // captured them.
    assert.equal(after.SKILL_DIR, REPO);
    assert.equal(after.HUB_ROOT, null);
    assert.match(after.HUB_ROOT_DIAGNOSTIC, /hub root is not configured/);
    assert.deepEqual(after.SEARCH_ROOTS, [fx.search]);
    assert.equal(after.SEARCH_ROOTS_DIAGNOSTIC, "no-markers");
    assert.equal(after.MAX_DEPTH, "__undefined__", "unset by default — sentinel, see DUMP_ALL_EXPORTS' comment");
    assert.deepEqual(after.WORKSPACES, []);
    assert.equal(after.DISCOVERY_DEGRADED, false);
    assert.deepEqual(after.SUSPICIOUS_MARKERS, []);
    assert.deepEqual(after.CONFIG, {});
    assert.equal(after.CONFIG_PATH, path.join(fx.state, "config.yml"));
    assert.equal(after.STATE_DIR, fx.state);
    assert.equal(after.STATE_DIR_EXPLICIT, true);
    assert.equal(after.STATE_PATH, path.join(fx.state, "state.json"));
    assert.equal(after.LOCK_PATH, path.join(fx.state, ".lock-target"));
    assert.equal(after.HEARTBEAT_PATH, path.join(fx.state, "heartbeat"));
    assert.equal(after.WATCHER_LOG, path.join(fx.state, "watcher.log"));
    assert.equal(after.GRAPH_MCP_CACHE_PATH, path.join(fx.state, "graph-mcp-cache.json"));
    assert.equal(after.RULES_DIR, path.join(fx.home, ".claude", "rules"));
    assert.equal(after.CROSS_ALLOW_PATH, path.join(REPO, "cross-allow.yml"));
    assert.equal(after.CROSS_ALLOW_SHIPPED, path.join(REPO, "cross-allow.yml"));
    assert.equal(after.CROSS_SCHEMA_PATH, path.join(REPO, "propagates-cross.schema.json"));
    assert.equal(after.CROSS_LEDGER_JSONL, path.join(fx.search, "PROPAGATION_CROSS_LEDGER.jsonl"));
    assert.equal(after.CROSS_LEDGER_MD, path.join(fx.search, "PROPAGATION_CROSS_LEDGER.md"));
    assert.equal(after.CROSS_TRIGGER_EPOCH, "2026-06-09");
    assert.deepEqual(after.CODE_CANONICAL, []);
    assert.equal(after.MTIME_REVERIFY_DELAY_MS, 3000);
    assert.equal(after.DELIVERY_MAX_COMMITS, 10);
    assert.equal(after.DELIVERY_MAX_DAYS, 7);
    assert.deepEqual(after.SCHEDULERS, ["launchd", "systemd", "none"]);
    assert.equal(after.SCHEDULER, process.platform === "darwin" ? "launchd" : "none");
    assert.equal(after.LAUNCHD_ACTIVE, process.platform === "darwin");
    assert.deepEqual(after.INTEGRATIONS, {
      marketplaceDir: null,
      portsFile: null,
      deployFile: null,
      mongoFile: null,
      telegramDir: null,
      notifier: null,
    });
    assert.equal(
      after["searchRootsExplain()"],
      `search root exists but contains no workspace: [${fx.search}] — add a \`.propagates.yml\` with \`workspace: true\`, or run \`init <dir>\``,
    );
    assert.equal(after.currentWorkspace, "[function currentWorkspace]");
    assert.equal(after.shortPath, "[function shortPath]");

    // Sanity: this asserts the FULL set, not a subset — an export silently added or
    // dropped outside {PATHS, PATHS_DIAGNOSTIC, requirePath, INTEGRATIONS_DIAGNOSTIC,
    // requireIntegration} would otherwise pass unnoticed.
    const PREEXISTING = new Set([
      "CODE_CANONICAL", "CONFIG", "CONFIG_PATH", "CROSS_ALLOW_PATH", "CROSS_ALLOW_SHIPPED",
      "CROSS_LEDGER_JSONL", "CROSS_LEDGER_MD", "CROSS_SCHEMA_PATH", "CROSS_TRIGGER_EPOCH",
      "DELIVERY_MAX_COMMITS", "DELIVERY_MAX_DAYS", "DISCOVERY_DEGRADED", "GRAPH_MCP_CACHE_PATH",
      "HEARTBEAT_PATH", "HUB_ROOT", "HUB_ROOT_DIAGNOSTIC", "INTEGRATIONS", "LAUNCHD_ACTIVE",
      "LOCK_PATH", "MAX_DEPTH", "MTIME_REVERIFY_DELAY_MS", "RULES_DIR", "SCHEDULER", "SCHEDULERS",
      "SEARCH_ROOTS", "SEARCH_ROOTS_DIAGNOSTIC", "SKILL_DIR", "STATE_DIR", "STATE_DIR_EXPLICIT",
      "STATE_PATH", "SUSPICIOUS_MARKERS", "WATCHER_LOG", "WORKSPACES", "currentWorkspace",
      "searchRootsExplain", "shortPath",
    ]);
    const NEW = new Set(["PATHS", "PATHS_DIAGNOSTIC", "requirePath", "INTEGRATIONS_DIAGNOSTIC", "requireIntegration"]);
    const actualKeys = new Set(Object.keys(after).filter((k) => k !== "searchRootsExplain()"));
    const unexpected = [...actualKeys].filter((k) => !PREEXISTING.has(k) && !NEW.has(k));
    const missing = [...PREEXISTING].filter((k) => !actualKeys.has(k));
    assert.deepEqual(unexpected, [], `unexpected new export(s) not accounted for: ${unexpected}`);
    assert.deepEqual(missing, [], `pre-existing export(s) went missing: ${missing}`);
  } finally {
    fx.cleanup();
  }
});

test("paths.mjs alone resolves every registry default under a controlled HOME, and the entry count is pinned", () => {
  const fx = freshEnv();
  try {
    const r = evalIn(
      `import * as p from "./lib/core/paths.mjs";
       console.log(JSON.stringify({
         HOME: p.HOME, CLAUDE_HOME: p.CLAUDE_HOME, AGENTS_HOME: p.AGENTS_HOME,
         PATHS: p.PATHS,
         CLAUDE_RULES: p.CLAUDE_RULES,
       }));`,
      { HOME: fx.home },
    );
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.HOME, fx.home);
    assert.equal(out.CLAUDE_HOME, path.join(fx.home, ".claude"));
    assert.equal(out.AGENTS_HOME, path.join(fx.home, ".agents"));
    assert.equal(out.PATHS["claude.rules"], path.join(fx.home, ".claude", "rules"));
    assert.equal(out.PATHS["claude.gotchasGlobal"], path.join(fx.home, ".claude", "gotchas-global.md"));
    assert.equal(out.PATHS["claude.gotchaGuardLog"], path.join(fx.home, ".claude", "gotcha-guard.log"));
    assert.equal(out.PATHS["claude.ruleGuardLog"], path.join(fx.home, ".claude", "rule-guard.log"));
    assert.equal(out.PATHS["claude.settings"], path.join(fx.home, ".claude", "settings.json"));
    assert.equal(out.PATHS["claude.globalClaudeMd"], path.join(fx.home, ".claude", "CLAUDE.md"));
    assert.equal(out.PATHS["claude.dailyMd"], path.join(fx.home, ".claude", "DAILY.md"));
    assert.equal(out.PATHS["claude.skills"], path.join(fx.home, ".claude", "skills"));
    assert.equal(out.PATHS["claude.projects"], path.join(fx.home, ".claude", "projects"));
    assert.equal(out.PATHS["claude.pluginCache"], path.join(fx.home, ".claude", "plugins", "cache"));
    assert.equal(out.PATHS["claude.installedPlugins"], path.join(fx.home, ".claude", "plugins", "installed_plugins.json"));
    assert.equal(out.PATHS["claude.skillsRegistryOff"], path.join(fx.home, ".claude", "skills-registry.off"));
    assert.equal(out.PATHS["claude.userConfig"], path.join(fx.home, ".claude.json"));
    assert.equal(out.PATHS["agents.skillLock"], path.join(fx.home, ".agents", ".skill-lock.json"));
    assert.equal(out.PATHS["agents.skills"], path.join(fx.home, ".agents", "skills"));
    assert.equal(out.PATHS["propagate.stateDirDefault"], path.join(fx.home, ".propagate"));
    assert.equal(
      Object.keys(out.PATHS).length,
      16,
      "exactly sixteen entries — fourteen from the plan, plus claude.userConfig (found during migration) and "
        + "propagate.stateDirDefault (added when the Lane E guard showed config.mjs was STRUCTURALLY forced to "
        + "hand-roll it: no pure .propagate default existed to import). This pin is deliberate — a registry "
        + "that grows silently is the thing it replaced.",
    );
    assert.equal(out.CLAUDE_RULES, out.PATHS["claude.rules"], "the named export must be the SAME value as the table entry, not a second computation");
  } finally {
    fx.cleanup();
  }
});

test("paths.mjs has zero filesystem I/O and zero side effects at module load", () => {
  // Import it pointed at a HOME that does not exist at all -- a pure module must
  // not care, because it never touches the filesystem to produce PATHS.
  const r = evalIn(
    `import { PATHS, HOME } from "./lib/core/paths.mjs";
     console.log(JSON.stringify({ PATHS, HOME }));`,
    { HOME: "/definitely/does/not/exist/on/this/machine" },
  );
  assert.equal(r.status, 0, `paths.mjs must load even under a nonexistent HOME: ${r.stderr}`);
  assert.equal(r.stderr, "", "a pure module must never warn at import time");
  const out = JSON.parse(r.stdout);
  assert.equal(out.HOME, "/definitely/does/not/exist/on/this/machine");
  assert.equal(out.PATHS["claude.rules"], "/definitely/does/not/exist/on/this/machine/.claude/rules");
});

// ─── requirePath() / PATHS_DIAGNOSTIC — G24/N95/PR-016: a null must never
// reach an unguarded existsSync silently ───────────────────────────────────

test("requirePath() returns a known PATHS entry and PATHS_DIAGNOSTIC names it as resolved", () => {
  const r = evalIn(
    `import { requirePath, PATHS, PATHS_DIAGNOSTIC } from "./lib/core/paths.mjs";
     console.log(JSON.stringify({
       value: requirePath("claude.rules"),
       diagnostic: PATHS_DIAGNOSTIC["claude.rules"],
       expected: PATHS["claude.rules"],
     }));`,
  );
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.value, out.expected);
  assert.match(out.diagnostic, /^ok: /);
});

test("requirePath() throws naming the fix for an unknown name, rather than returning null or undefined", () => {
  const r = evalIn(
    `import { requirePath } from "./lib/core/paths.mjs";
     try {
       requirePath("claude.doesNotExist");
       console.log("NO_THROW");
     } catch (err) {
       console.log("THREW:" + err.message);
     }`,
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^THREW:/, "requirePath must throw for an unknown name, not silently return null");
  assert.match(r.stdout, /unknown path name/, "the thrown message must name the actual problem");
});

test("config.mjs re-exports PATHS/PATHS_DIAGNOSTIC/requirePath from paths.mjs — same values, not a second copy", () => {
  const r = evalIn(
    `import * as cfg from "./lib/core/config.mjs";
     import * as paths from "./lib/core/paths.mjs";
     console.log(JSON.stringify({
       samePaths: cfg.PATHS === paths.PATHS,
       samePathsDiagnostic: cfg.PATHS_DIAGNOSTIC === paths.PATHS_DIAGNOSTIC,
       sameRequirePath: cfg.requirePath === paths.requirePath,
     }));`,
  );
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.samePaths, true, "config.mjs must re-export the SAME object, not rebuild it");
  assert.equal(out.samePathsDiagnostic, true);
  assert.equal(out.sameRequirePath, true);
});

// ─── INTEGRATIONS_DIAGNOSTIC / requireIntegration() — the concrete N95/PR-016
// gap: INTEGRATIONS never had a diagnostic naming the fix ───────────────────

test("unconfigured stays loud: requireIntegration('marketplaceDir') throws naming the fix on a fresh machine", () => {
  const fx = freshEnv();
  try {
    const r = evalIn(
      `import { requireIntegration, INTEGRATIONS, INTEGRATIONS_DIAGNOSTIC } from "./lib/core/config.mjs";
       console.log(JSON.stringify({ marketplaceDir: INTEGRATIONS.marketplaceDir, diagnostic: INTEGRATIONS_DIAGNOSTIC.marketplaceDir }));
       try {
         requireIntegration("marketplaceDir");
         console.log("NO_THROW");
       } catch (err) {
         console.log("THREW:" + err.message);
       }`,
      fx.env,
    );
    assert.equal(r.status, 0, r.stderr);
    const [jsonLine, throwLine] = r.stdout.split("\n");
    const parsed = JSON.parse(jsonLine);
    assert.equal(parsed.marketplaceDir, null, "sanity: unconfigured must actually be null");
    assert.match(parsed.diagnostic, /not configured/, "PATHS_DIAGNOSTIC-shaped: names the problem");
    assert.match(parsed.diagnostic, /PROPAGATE_MARKETPLACE_DIR/, "and the env var that would fix it");
    assert.match(parsed.diagnostic, /propagate setup --hub/, "and the command that would fix it");
    assert.match(throwLine, /^THREW:/, "requireIntegration must throw rather than hand back null");
  } finally {
    fx.cleanup();
  }
});

test("a configured (but nonexistent-on-disk) marketplaceDir is still reported, not silently swapped for a hidden default", () => {
  // Per tests/portability/config-file.test.mjs:147-165 — "the built-in default was
  // the hazard, not the feature." Planting a PLAUSIBLE WRONG value must not make the
  // diagnostic quietly fall back to some other path; it must report exactly what was
  // configured, existent or not, so a wrong path is visible as itself rather than
  // laundered into "not configured".
  const fx = freshEnv();
  const plausibleWrong = path.join(fx.home, "not-actually-there", "skills-marketplace");
  try {
    const r = evalIn(
      `import { requireIntegration, INTEGRATIONS_DIAGNOSTIC } from "./lib/core/config.mjs";
       console.log(JSON.stringify({
         value: requireIntegration("marketplaceDir"),
         diagnostic: INTEGRATIONS_DIAGNOSTIC.marketplaceDir,
       }));`,
      { ...fx.env, PROPAGATE_MARKETPLACE_DIR: plausibleWrong },
    );
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.value, plausibleWrong, "requireIntegration must not throw or substitute once a value IS configured");
    assert.equal(out.diagnostic, `ok: ${plausibleWrong}`, "the diagnostic must name the actual configured value, right or wrong");
  } finally {
    fx.cleanup();
  }
});

// ─── config.yml unknown-key warning (§4 of the plan) ───────────────────────

test("a typo'd config.yml key (huRoot) is named on stderr, listing the recognised set", () => {
  const fx = freshEnv();
  try {
    writeFileSync(path.join(fx.state, "config.yml"), "huRoot: /some/path\n");
    const r = evalIn(`import("./lib/core/config.mjs");`, fx.env);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /unrecognised key/i);
    assert.match(r.stderr, /huRoot/);
    assert.match(r.stderr, /hubRoot/, "the recognised-set listing must include the key the typo was of");
  } finally {
    fx.cleanup();
  }
});

test("a recognised config.yml key (hubRoot) does not warn", () => {
  const fx = freshEnv();
  try {
    mkdirSync(path.join(fx.home, "code", "myrepo"), { recursive: true });
    writeFileSync(path.join(fx.home, "code", "myrepo", ".propagates.yml"), "workspace: true\nsources: {}\n");
    writeFileSync(path.join(fx.state, "config.yml"), `hubRoot: ${path.join(fx.home, "code")}\n`);
    const r = evalIn(`import("./lib/core/config.mjs");`, { HOME: fx.home, PROPAGATE_STATE_DIR: fx.state });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, "", `a fully-recognised config.yml must not warn: ${r.stderr}`);
  } finally {
    fx.cleanup();
  }
});

test("every recognised top-level key used elsewhere in config.mjs is actually in the recognised set (mutation can fail for the stated reason)", () => {
  // rule:discernment-checks §1/§4 — confirm the check CAN fail, in both directions,
  // rather than trusting it because it currently passes. Removing a real key from the
  // recognised set must turn a currently-silent config.yml into a warning.
  //
  // The mutant is written ALONGSIDE the real config.mjs (as a sibling file in
  // lib/core/, cleaned up in `finally`) rather than copied to an external scratch
  // dir: config.mjs has a bare `import ... from "yaml"`, and Node resolves a bare
  // specifier by walking up node_modules from the IMPORTING FILE's own directory —
  // a copy outside this repo would never find it and fail with MODULE_NOT_FOUND for
  // an unrelated reason, which is exactly the kind of false read this rule warns
  // against (rule:discernment-checks §4).
  const fx = freshEnv();
  const mutantPath = path.join(REPO, "lib", "core", "__paths_migration_mutant__.mjs");
  try {
    writeFileSync(path.join(fx.state, "config.yml"), "scheduler: none\n");
    const before = evalIn(`import("./lib/core/config.mjs");`, fx.env);
    assert.equal(before.stderr, "", `sanity: scheduler: none must not warn before mutation: ${before.stderr}`);

    const src = readFileSync(path.join(REPO, "lib", "core", "config.mjs"), "utf8");
    const mutated = src.replace('"scheduler",\n', "");
    assert.notEqual(mutated, src, "the mutation must actually remove the line — a sed/replace that matches nothing has silently no-op'd this check before");
    assert.ok(!mutated.includes('"scheduler",\n'), "the mutated source must no longer contain the removed line");

    writeFileSync(mutantPath, mutated);
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", `import(${JSON.stringify(mutantPath)});`], {
      cwd: REPO,
      encoding: "utf8",
      env: fx.env,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /unrecognised key/i, "removing `scheduler` from the recognised set must turn scheduler: none into a warning");
    assert.match(r.stderr, /scheduler/);
  } finally {
    rmSync(mutantPath, { force: true });
    fx.cleanup();
  }
});

// ─── STATE_DIR pure/impure split ────────────────────────────────────────────

test("paths.mjs's pure stateDir() matches config.mjs's STATE_DIR when PROPAGATE_STATE_DIR is unset", () => {
  const fx = freshEnv();
  const home = fx.home;
  try {
    const r = evalIn(
      `import { stateDir } from "./lib/core/paths.mjs";
       import { STATE_DIR } from "./lib/core/config.mjs";
       console.log(JSON.stringify({ pure: stateDir(), impure: STATE_DIR }));`,
      { HOME: home, PROPAGATE_SEARCH_ROOTS: fx.search, PROPAGATE_STATE_DIR: undefined },
    );
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.pure, path.join(home, ".propagate"));
    assert.equal(out.impure, out.pure, "unset case: pure candidate and impure STATE_DIR must be identical");
  } finally {
    fx.cleanup();
  }
});

test("an unusable PROPAGATE_STATE_DIR (a file) diverges: pure stateDir() reports the candidate, impure STATE_DIR falls back", () => {
  const fx = freshEnv();
  try {
    const notADir = path.join(fx.home, "im-a-file");
    writeFileSync(notADir, "not a directory\n");
    const r = evalIn(
      `import { stateDir } from "./lib/core/paths.mjs";
       import { STATE_DIR } from "./lib/core/config.mjs";
       console.log(JSON.stringify({ pure: stateDir(), impure: STATE_DIR }));`,
      { HOME: fx.home, PROPAGATE_SEARCH_ROOTS: fx.search, PROPAGATE_STATE_DIR: notADir },
    );
    assert.equal(r.status, 0, `module load must not throw/crash: ${r.stderr}`);
    assert.match(r.stderr, /PROPAGATE_STATE_DIR/);
    assert.match(r.stderr, /falling back/i);
    const out = JSON.parse(r.stdout);
    assert.equal(out.pure, notADir, "the PURE resolver reports the candidate as-is -- it does no existsSync/statSync");
    assert.equal(out.impure, path.join(fx.home, ".propagate"), "the IMPURE resolver degrades to the default");
    assert.notEqual(out.pure, out.impure, "this is the one case the two are meant to diverge on");
  } finally {
    fx.cleanup();
  }
});

// ─── latency — measured, not assumed (plan §5 / verification bullet 5) ─────

test("importing paths.mjs alone is close to the cost of importing node:path, not config.mjs's cost", () => {
  // Per rule:gotchas G25 ("a wall-clock assertion cannot tell a broken bound from a
  // busy machine"): use a wide, load-tolerant margin and compare RELATIVE cost
  // (paths.mjs vs config.mjs, measured back-to-back in the same run) rather than a
  // tight absolute millisecond bound.
  function timeImport(spec, env) {
    // process.stdout.write(String(...)), NOT console.log(number) -- this
    // environment runs with FORCE_COLOR=3, and console.log ANSI-colorizes a
    // bare (non-string) numeric argument even with no TTY attached, which
    // corrupted the captured stdout into "\x1b[33m0.47...\x1b[39m" and made
    // every measurement parse as NaN. Caught by actually running this test,
    // not assumed — rule:discernment-checks §4.
    const code = `
      const t0 = process.hrtime.bigint();
      import(${JSON.stringify(spec)}).then(() => {
        process.stdout.write(String(Number(process.hrtime.bigint() - t0) / 1e6));
      });
    `;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      cwd: REPO,
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    assert.equal(r.status, 0, r.stderr);
    return Number(r.stdout.trim());
  }

  const N = 3;
  const controlTimes = [];
  const pathsTimes = [];
  const configTimes = [];
  for (let i = 0; i < N; i++) {
    controlTimes.push(timeImport("node:path"));
    pathsTimes.push(timeImport("./lib/core/paths.mjs"));
    configTimes.push(timeImport("./lib/core/config.mjs"));
  }
  const median = (arr) => arr.slice().sort((a, b) => a - b)[Math.floor(arr.length / 2)];
  const control = median(controlTimes);
  const pathsMs = median(pathsTimes);
  const configMs = median(configTimes);

  // Reported for the record (visible in `npm test` output, not just pass/fail):
  console.log(`[paths-migration latency] control=${control}ms paths.mjs=${pathsMs}ms config.mjs=${configMs}ms`);

  // Generous, relative bound: paths.mjs must be a small multiple of control, and
  // meaningfully cheaper than config.mjs -- not a fixed millisecond ceiling, which
  // G25 already burned this repo on twice.
  assert.ok(pathsMs < control * 25 + 20, `paths.mjs import (${pathsMs}ms) is not close to control (${control}ms)`);
  assert.ok(pathsMs < configMs, `paths.mjs (${pathsMs}ms) must be cheaper than config.mjs (${configMs}ms)`);
});
