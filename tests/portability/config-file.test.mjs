/**
 * `config.yml` — the install-time configuration this skill never had.
 *
 * Until 2026-08-19 every knob was an env var with a hardcoded fallback, so
 * configuring propagate on a new machine meant discovering `PROPAGATE_SEARCH_ROOTS`
 * by reading `lib/config.mjs`. docs/DECISIONS.md:356 deferred a "v2 bootstrap"
 * that would own this; this is that file's half of it.
 *
 * THE THREE PROPERTIES THAT MATTER, and why each is asserted rather than assumed:
 *
 * 1. PRECEDENCE is env > file > default. Anything else silently changes the
 *    behaviour of every existing invocation that already exports the env var.
 * 2. IT MUST NEVER THROW. STATE.md's known hazards: "A throw at config.mjs module
 *    load bricks watcher, CLI and UI simultaneously." A malformed config.yml is a
 *    typo, and a typo must not brick the tool — it degrades to defaults and says so.
 * 3. ABSENT MUST EQUAL TODAY. Every machine already running this skill has no
 *    config.yml, so "no file" has to reproduce current behaviour exactly. A config
 *    layer that changes defaults is a migration, not a feature.
 *
 * Sandboxed by construction: HOME and PROPAGATE_STATE_DIR are per-case temp dirs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LIB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "lib", "core", "config.mjs");

/**
 * Load config.mjs in a child process with a throwaway HOME and report what it
 * resolved. A child is required: config.mjs computes everything at module load,
 * so the same process cannot observe two different environments.
 */
function loadConfig({ configYml, env = {}, mkTree } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), "propagate-cfg-"));
  const stateDir = path.join(home, ".propagate");
  mkdirSync(stateDir, { recursive: true });
  if (configYml !== undefined) writeFileSync(path.join(stateDir, "config.yml"), configYml);
  if (mkTree) mkTree(home);

  const code = `import(${JSON.stringify(LIB)}).then((m) => {
    process.stdout.write(JSON.stringify({
      searchRoots: m.SEARCH_ROOTS,
      diagnostic: m.SEARCH_ROOTS_DIAGNOSTIC,
      workspaces: m.WORKSPACES.map((w) => w.name).sort(),
      config: m.CONFIG ?? null,
    }));
  })`;
  try {
    // spawnSync, not execFileSync: the latter returns ONLY stdout, so a run that
    // succeeds while warning on stderr looks silent. That cost a false failure on
    // the malformed-YAML case, which warns exactly as intended.
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      env: { ...process.env, HOME: home, PROPAGATE_STATE_DIR: stateDir, ...env },
      encoding: "utf8",
    });
    const stderr = r.stderr ?? "";
    if (r.status !== 0) return { ok: false, stderr, stdout: r.stdout ?? "", home };
    return { ok: true, ...JSON.parse(r.stdout), stderr, home };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** A workspace root the walker will actually find, at <home>/<rel>. */
const markedTree = (rel) => (home) => {
  const ws = path.join(home, rel);
  mkdirSync(ws, { recursive: true });
  writeFileSync(path.join(ws, ".propagates.yml"), "workspace: true\nsources: {}\n");
};

test("config.yml supplies searchRoots when the env var is unset", () => {
  const r = loadConfig({
    configYml: "searchRoots:\n  - ~/code\n",
    mkTree: markedTree("code/myrepo"),
  });
  assert.ok(r.ok, `config.mjs failed to load: ${r.stderr}`);
  assert.deepEqual(r.workspaces, ["myrepo"], "the workspace under the configured root must be found");
  assert.equal(r.diagnostic, "ok");
});

test("`~` in a configured path is expanded, not taken literally", () => {
  // A config file is hand-written, so `~/code` is what a person will type. Left
  // unexpanded it becomes a literal "./~/code" that exists nowhere, and the
  // failure would present as "root does not exist" — pointing the reader at the
  // value they correctly supplied.
  const r = loadConfig({
    configYml: "searchRoots: [~/code]\n",
    mkTree: markedTree("code/myrepo"),
  });
  assert.ok(r.ok, r.stderr);
  assert.deepEqual(r.workspaces, ["myrepo"]);
});

test("env beats file — existing invocations keep their behaviour", () => {
  const r = loadConfig({
    configYml: "searchRoots: [~/from-file]\n",
    env: {}, // set below, needs the home path
    mkTree: (home) => {
      markedTree("from-file/wrong")(home);
      markedTree("from-env/right")(home);
    },
  });
  // The child's HOME is internal to loadConfig, so assert precedence via a second
  // run that sets the env var to an absolute path inside that same home.
  assert.ok(r.ok, r.stderr);
  assert.deepEqual(r.workspaces, ["wrong"], "sanity: the file root is used when no env var is set");

  const home2 = mkdtempSync(path.join(tmpdir(), "propagate-cfg-"));
  try {
    const stateDir = path.join(home2, ".propagate");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path.join(stateDir, "config.yml"), "searchRoots: [~/from-file]\n");
    markedTree("from-file/wrong")(home2);
    markedTree("from-env/right")(home2);
    const code = `import(${JSON.stringify(LIB)}).then((m) =>
      process.stdout.write(JSON.stringify(m.WORKSPACES.map((w) => w.name))))`;
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", code], {
      env: {
        ...process.env,
        HOME: home2,
        PROPAGATE_STATE_DIR: stateDir,
        PROPAGATE_SEARCH_ROOTS: path.join(home2, "from-env"),
      },
      encoding: "utf8",
    });
    assert.deepEqual(JSON.parse(out), ["right"], "PROPAGATE_SEARCH_ROOTS must win over config.yml");
  } finally {
    rmSync(home2, { recursive: true, force: true });
  }
});

test("a malformed config.yml degrades to defaults and does NOT throw", () => {
  // STATE.md known hazards: a throw here bricks watcher, CLI and UI at once.
  const r = loadConfig({ configYml: "searchRoots: [unclosed\n  bad: : :\n" });
  assert.ok(r.ok, `module load threw on malformed YAML — this bricks every entry point:\n${r.stderr}`);
  assert.match(
    r.stderr,
    /config\.yml/i,
    "degrading silently is the other half of the bug — it must say the file was ignored",
  );
});

test("no config.yml reproduces today's behaviour exactly", () => {
  const withNone = loadConfig({ mkTree: markedTree("Documents/GitHub/myrepo") });
  assert.ok(withNone.ok, withNone.stderr);
  assert.deepEqual(
    withNone.workspaces,
    ["myrepo"],
    "the built-in ~/Documents/GitHub default must still apply when nothing is configured",
  );
});

test("maxDepth is configurable — a workspace deeper than the default is found", () => {
  // DEFAULT_MAX_DEPTH is 2 and was reachable only as a function argument, so any
  // tree that nests deeper than this author's was invisible with no way to say so.
  const deep = "code/team/group/myrepo"; // depth 4 under HOME, 3 under the root
  const shallow = loadConfig({ configYml: "searchRoots: [~/code]\n", mkTree: markedTree(deep) });
  assert.ok(shallow.ok, shallow.stderr);
  assert.deepEqual(shallow.workspaces, [], "sanity: default depth must NOT reach it");

  const deeper = loadConfig({
    configYml: "searchRoots: [~/code]\nmaxDepth: 4\n",
    mkTree: markedTree(deep),
  });
  assert.ok(deeper.ok, deeper.stderr);
  assert.deepEqual(deeper.workspaces, ["myrepo"], "maxDepth from config must widen the walk");
});
