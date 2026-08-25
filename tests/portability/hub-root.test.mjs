/**
 * HUB_ROOT — one declared fact, everything hub-relative derived from it.
 *
 * WHY THIS EXISTS. The hub root was restated FOUR times in config.mjs, each
 * independently overridable, each defaulting to one author's layout:
 *
 *     SEARCH_ROOTS    ~/Documents/GitHub
 *     marketplaceDir  ~/Documents/GitHub/skills-marketplace
 *     portsFile       ~/Documents/GitHub/scripts/execution/ports.yml
 *     rulesDir        ~/.claude/rules            (a symlink into the hub)
 *
 * `portsFile` was fixed TWICE on 2026-08-23 — once because the registry had
 * moved into `execution/`, then again when `execution/` moved under `scripts/`.
 * That is not carelessness, it is the design: one fact restated four times means
 * a reorganisation must find all four, and the ones you miss fail SILENTLY,
 * because `pick()` returns null and null reads as "not configured" rather than
 * "configured wrong".
 *
 * THE SENTINEL IS THE POINT. An unconfigured machine used to get
 * `~/Documents/GitHub` — a plausible wrong answer, so discovery found zero
 * workspaces and everything reported healthy. That is the precise failure this
 * plugin exists to catch, living in its own config. Unconfigured must now be a
 * VALUE the readers can see (rule:discernment-checks §2).
 *
 * AND IT MUST NEVER THROW. STATE.md's known hazards: "A throw at config.mjs
 * module load bricks watcher, CLI and UI simultaneously." So `null` — never an
 * exception, and never a guess.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Read config values out of a child process with a controlled environment. */
function readConfig(env = {}) {
  const src = `
    import * as c from ${JSON.stringify(path.join(REPO, "lib/core/config.mjs"))};
    console.log(JSON.stringify({
      hubRoot: c.HUB_ROOT ?? null,
      diagnostic: c.HUB_ROOT_DIAGNOSTIC ?? null,
      searchRoots: c.SEARCH_ROOTS,
      marketplaceDir: c.INTEGRATIONS.marketplaceDir,
      portsFile: c.INTEGRATIONS.portsFile,
    }));
  `;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", src], {
    encoding: "utf8",
    env: { ...process.env, PROPAGATE_HUB_ROOT: "", PROPAGATE_SEARCH_ROOTS: "", ...env },
  });
  return JSON.parse(out.trim().split("\n").pop());
}

async function emptyState(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "hub-state-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return dir;
}

// ---------------------------------------------------------------------------
// Unconfigured
// ---------------------------------------------------------------------------

test("an unconfigured machine yields null — never a guessed hub", async (t) => {
  const state = await emptyState(t);
  const c = readConfig({ PROPAGATE_STATE_DIR: state });
  assert.equal(c.hubRoot, null, "no hub declared must be null, not ~/Documents/GitHub");
});

test("…and says WHY, so absence is attributable", async (t) => {
  const state = await emptyState(t);
  const c = readConfig({ PROPAGATE_STATE_DIR: state });
  assert.ok(c.diagnostic, "unconfigured must carry a diagnostic");
  assert.match(c.diagnostic, /setup/i, "the diagnostic must name the fix, not just the problem");
});

test("module load NEVER throws when unconfigured", async (t) => {
  // The hard constraint. A throw here bricks watcher, CLI and UI at once, so
  // "unconfigured" has to be survivable at import time.
  const state = await emptyState(t);
  assert.doesNotThrow(() => readConfig({ PROPAGATE_STATE_DIR: state }));
});

// ---------------------------------------------------------------------------
// Declared once, derived everywhere
// ---------------------------------------------------------------------------

test("declaring the hub derives marketplace, ports and search roots from it", async (t) => {
  // The whole point: one fact, not four. A hub that moves must not require
  // finding three other restatements of itself.
  const state = await emptyState(t);
  const hub = await mkdtemp(path.join(tmpdir(), "hub-"));
  t.after(() => rm(hub, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  // The fixture has to LOOK like a hub. `pick()` returns null for a path that
  // does not exist — deliberate, and documented on PORTS_YML_PATH as "null =>
  // the ports check skips". Asserting derived paths against an empty directory
  // tested the existence check, not the derivation.
  await mkdir(path.join(hub, "skills-marketplace"), { recursive: true });
  await mkdir(path.join(hub, "scripts", "execution"), { recursive: true });
  await writeFile(path.join(hub, "scripts", "execution", "ports.yml"), "ports: {}\n");

  const c = readConfig({ PROPAGATE_STATE_DIR: state, PROPAGATE_HUB_ROOT: hub });
  assert.equal(c.hubRoot, hub);
  assert.deepEqual(c.searchRoots, [hub], "search roots default to the hub");
  assert.equal(c.marketplaceDir, path.join(hub, "skills-marketplace"));
  assert.equal(c.portsFile, path.join(hub, "scripts", "execution", "ports.yml"));
});

test("the hub can be declared in config.yml, not only in the environment", async (t) => {
  const state = await emptyState(t);
  const hub = await mkdtemp(path.join(tmpdir(), "hub-file-"));
  t.after(() => rm(hub, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  await writeFile(path.join(state, "config.yml"), `hubRoot: ${hub}\n`);

  const c = readConfig({ PROPAGATE_STATE_DIR: state });
  assert.equal(c.hubRoot, hub);
  assert.deepEqual(c.searchRoots, [hub]);
});

test("env beats config.yml — the documented precedence must not invert", async (t) => {
  const state = await emptyState(t);
  const fromFile = await mkdtemp(path.join(tmpdir(), "hub-file-"));
  const fromEnv = await mkdtemp(path.join(tmpdir(), "hub-env-"));
  t.after(() => rm(fromFile, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  t.after(() => rm(fromEnv, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  await writeFile(path.join(state, "config.yml"), `hubRoot: ${fromFile}\n`);

  const c = readConfig({ PROPAGATE_STATE_DIR: state, PROPAGATE_HUB_ROOT: fromEnv });
  assert.equal(c.hubRoot, fromEnv, "env > file, in that order and no other");
});

// ---------------------------------------------------------------------------
// Backward compatibility — existing installs must not break
// ---------------------------------------------------------------------------

test("an existing searchRoots config still wins over the derived default", async (t) => {
  // Every machine already running this has a config.yml with searchRoots and no
  // hubRoot. Deriving search roots from the hub must not overrule what someone
  // already declared explicitly — that would be a migration wearing the costume
  // of a default.
  const state = await emptyState(t);
  const hub = await mkdtemp(path.join(tmpdir(), "hub-"));
  const explicit = await mkdtemp(path.join(tmpdir(), "explicit-roots-"));
  t.after(() => rm(hub, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  t.after(() => rm(explicit, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  await writeFile(path.join(state, "config.yml"), `hubRoot: ${hub}\nsearchRoots:\n  - ${explicit}\n`);

  const c = readConfig({ PROPAGATE_STATE_DIR: state });
  assert.deepEqual(c.searchRoots, [explicit], "an explicit searchRoots is not overridden by the hub");
});

test("a per-integration override still beats the hub-derived path", async (t) => {
  const state = await emptyState(t);
  const hub = await mkdtemp(path.join(tmpdir(), "hub-"));
  const ports = path.join(hub, "elsewhere.yml");
  t.after(() => rm(hub, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  await writeFile(ports, "ports: {}\n");

  const c = readConfig({ PROPAGATE_STATE_DIR: state, PROPAGATE_HUB_ROOT: hub, PROPAGATE_PORTS_FILE: ports });
  assert.equal(c.portsFile, ports, "an odd layout must remain expressible");
});

// ---------------------------------------------------------------------------
// The WRITE side — setup must persist what the read side then resolves
// ---------------------------------------------------------------------------

test("`setup --hub` persists hubRoot, and the reader resolves it back", async (t) => {
  // The read side above was green while `renderConfig({roots, scheduler})` silently
  // DROPPED the hub argument cli.mjs had started passing it. Eight passing tests and
  // a flag that wrote nothing — rule:enforcement-watches-itself in miniature. This is
  // the round trip: what setup writes is what config.mjs reads, asserted end to end
  // rather than on either half alone.
  const state = await emptyState(t);
  const hub = await mkdtemp(path.join(tmpdir(), "hub-setup-"));
  t.after(() => rm(hub, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  await mkdir(path.join(hub, "ws"), { recursive: true });
  await writeFile(path.join(hub, "ws", ".propagates.yml"), "workspace: true\n");

  execFileSync(process.execPath, [path.join(REPO, "cli.mjs"), "setup", "--roots", hub, "--hub", hub], {
    encoding: "utf8",
    env: { ...process.env, PROPAGATE_STATE_DIR: state, PROPAGATE_HUB_ROOT: "", PROPAGATE_SEARCH_ROOTS: "" },
  });

  const c = readConfig({ PROPAGATE_STATE_DIR: state });
  assert.equal(c.hubRoot, hub, "setup --hub must WRITE the hub, not just accept the flag");
});

test("setup refuses a hub that does not exist, rather than writing a config that cannot work", async (t) => {
  const state = await emptyState(t);
  const hub = await mkdtemp(path.join(tmpdir(), "hub-real-"));
  t.after(() => rm(hub, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const missing = path.join(hub, "definitely", "not", "here");

  assert.throws(
    () => execFileSync(process.execPath, [path.join(REPO, "cli.mjs"), "setup", "--roots", hub, "--hub", missing], {
      encoding: "utf8", stdio: "pipe",
      env: { ...process.env, PROPAGATE_STATE_DIR: state, PROPAGATE_HUB_ROOT: "", PROPAGATE_SEARCH_ROOTS: "" },
    }),
    (e) => e.status !== 0,
    "a nonexistent hub must be a non-zero refusal",
  );
  // And it must NOT have half-written a config naming the bad path.
  const c = readConfig({ PROPAGATE_STATE_DIR: state });
  assert.notEqual(c.hubRoot, missing, "a refused setup must not persist the hub it refused");
});

// ---------------------------------------------------------------------------
// The migration path — installs that predate `hubRoot`
// ---------------------------------------------------------------------------

test("a pre-hubRoot install infers the hub from its single declared searchRoot", async (t) => {
  // Measured on the author's machine when hubRoot landed: marketplaceDir and
  // portsFile both resolved before the change and both were null after, because
  // every existing config declares searchRoots and no hub. Silently losing two
  // integrations is the sentinel failing by a different door — null reading as
  // "not configured" when the truth was "configured, just not under this key".
  const state = await emptyState(t);
  const hub = await mkdtemp(path.join(tmpdir(), "hub-legacy-"));
  t.after(() => rm(hub, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  await mkdir(path.join(hub, "skills-marketplace"), { recursive: true });
  await writeFile(path.join(state, "config.yml"), `searchRoots:\n  - ${hub}\n`);

  const c = readConfig({ PROPAGATE_STATE_DIR: state });
  assert.equal(c.hubRoot, hub, "one declared root is a declaration, not a guess");
  assert.equal(c.marketplaceDir, path.join(hub, "skills-marketplace"));
  assert.match(c.diagnostic, /inferred/, "an inferred hub must SAY it was inferred");
});

test("two declared roots stay null — 'which is the hub' has no non-guessed answer", async (t) => {
  const state = await emptyState(t);
  const a = await mkdtemp(path.join(tmpdir(), "hub-a-"));
  const b = await mkdtemp(path.join(tmpdir(), "hub-b-"));
  t.after(() => rm(a, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  t.after(() => rm(b, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  await writeFile(path.join(state, "config.yml"), `searchRoots:\n  - ${a}\n  - ${b}\n`);

  const c = readConfig({ PROPAGATE_STATE_DIR: state });
  assert.equal(c.hubRoot, null, "ambiguous must stay null rather than pick one");
  assert.match(c.diagnostic, /setup/i, "and still name the fix");
});

test("an explicit hubRoot beats the inference — the inference is a fallback, not a co-equal", async (t) => {
  const state = await emptyState(t);
  const explicit = await mkdtemp(path.join(tmpdir(), "hub-explicit-"));
  const root = await mkdtemp(path.join(tmpdir(), "root-"));
  t.after(() => rm(explicit, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  await writeFile(path.join(state, "config.yml"), `hubRoot: ${explicit}\nsearchRoots:\n  - ${root}\n`);

  const c = readConfig({ PROPAGATE_STATE_DIR: state });
  assert.equal(c.hubRoot, explicit);
  assert.deepEqual(c.searchRoots, [root], "and searchRoots stays what was declared");
});
