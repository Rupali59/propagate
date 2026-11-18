/**
 * kb-rename.test.mjs — an existing install keeps working in both landing orders of the standards -> kb rename (#322).
 *
 *   old hub, new code   hub still has `standards/` and `scripts/execution/standards.yml`
 *   new hub, new code   hub has `kb/standards/` and `scripts/execution/kb-standards.yml`
 *   old config key      `standardsFile:` / `standardsDir:` in config.yml, no hub root at all
 *
 * Each case runs the real `cli.mjs kb standards --json` as a child process over a generic 12-project workspace
 * and compares it with tests/fixtures/kb-upgrade/golden-standards.json, the output of the 0.20.0 code (base
 * 071aebc, `cli.mjs standards --json`) on the old-layout hub. The golden is committed raw.
 *
 * The ONE normalisation: 0.20.0 printed the hint `(standards versions --refresh)` in a row's `reason`; the renamed
 * command prints `(kb standards versions --refresh)`. `asGolden` maps the new text back to the old before comparing,
 * and every case first asserts the raw output carries the NEW text, so the mapping cannot silently become a no-op.
 * Nothing else in the output varies by run or path (the report holds no timestamps and no absolute paths).
 */
// @size medium — starts processes (CLI or script); run when affected

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeKbUpgradeWorkspace } from "../helpers/kb-upgrade-workspace.mjs";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(REPO, "cli.mjs");
const CONFIG_MJS = pathToFileURL(path.join(REPO, "lib", "core", "config.mjs")).href;
const FIX = path.join(REPO, "tests", "fixtures", "kb-upgrade");
const HUB_OLD = path.join(FIX, "hub-old");
const HUB_NEW = path.join(FIX, "hub-new");
const GOLDEN = JSON.parse(readFileSync(path.join(FIX, "golden-standards.json"), "utf8"));

const OLD_HINT = "(standards versions --refresh)";
const NEW_HINT = "(kb standards versions --refresh)";

/** A sandbox: one workspace, one state dir (optionally with a config.yml). Only PATH is inherited. */
function sandbox({ hub = null, configYml = null, env = {} } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "kb-upgrade-"));
  const searchRoot = path.join(root, "root");
  const state = path.join(root, "state");
  mkdirSync(state, { recursive: true });
  makeKbUpgradeWorkspace(searchRoot);
  if (configYml) writeFileSync(path.join(state, "config.yml"), configYml);
  const childEnv = {
    PATH: process.env.PATH,
    HOME: root,
    PROPAGATE_STATE_DIR: state,
    PROPAGATE_SEARCH_ROOTS: searchRoot,
    ...(hub ? { PROPAGATE_HUB_ROOT: hub } : {}),
    ...env,
  };
  return { childEnv, run: (argv) => spawnSync(process.execPath, [CLI, ...argv], { encoding: "utf8", env: childEnv }) };
}

function legacyUsed(childEnv) {
  const code = `import(${JSON.stringify(CONFIG_MJS)}).then(m => console.log(JSON.stringify({ legacy: m.LEGACY_CONFIG_USED, file: m.INTEGRATIONS.kbStandardsFile, dir: m.INTEGRATIONS.kbStandardsDir })))`;
  const r = spawnSync(process.execPath, ["-e", code], { encoding: "utf8", env: childEnv });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split("\n").pop());
}

/** The new hint text back to 0.20.0's, so the output can be compared with the golden. See the header. */
function asGolden(raw) {
  assert.ok(raw.includes(NEW_HINT), `raw output must carry the new hint ${NEW_HINT}; the normalisation would be a no-op`);
  assert.ok(!raw.replaceAll(NEW_HINT, "").includes(OLD_HINT), "raw output still carries the old hint");
  return JSON.parse(raw.replaceAll(NEW_HINT, OLD_HINT));
}

function assertMatchesGolden(r) {
  assert.equal(r.status, 0, `kb standards --json exited ${r.status}: ${r.stderr}`);
  assert.equal(r.stderr, "", "kb standards writes nothing to stderr");
  const got = asGolden(r.stdout);
  assert.equal(got.standards.length, 1, "the fixture registry has exactly one standard");
  assert.deepEqual(got, GOLDEN);
}

test("old hub, new code: kb standards --json equals the 0.20.0 golden, and no legacy key is reported", () => {
  const s = sandbox({ hub: HUB_OLD });
  assertMatchesGolden(s.run(["kb", "standards", "--json"]));
  const c = legacyUsed(s.childEnv);
  // The old DEFAULT paths supplied the values; a default path is not a legacy config key.
  assert.equal(c.file, path.join(HUB_OLD, "scripts", "execution", "standards.yml"));
  assert.equal(c.dir, path.join(HUB_OLD, "standards"));
  assert.deepEqual(c.legacy, []);
});

test("new hub, new code: the same output, and no legacy key is reported", () => {
  const s = sandbox({ hub: HUB_NEW });
  assertMatchesGolden(s.run(["kb", "standards", "--json"]));
  const c = legacyUsed(s.childEnv);
  assert.equal(c.file, path.join(HUB_NEW, "scripts", "execution", "kb-standards.yml"));
  assert.equal(c.dir, path.join(HUB_NEW, "kb", "standards"));
  assert.deepEqual(c.legacy, []);
});

test("old config key: standardsFile/standardsDir in config.yml still resolve, are named as legacy, and give the golden", () => {
  const configYml = [
    "integrations:",
    `  standardsFile: ${path.join(HUB_OLD, "scripts", "execution", "standards.yml")}`,
    `  standardsDir: ${path.join(HUB_OLD, "standards")}`,
    "",
  ].join("\n");
  const s = sandbox({ hub: null, configYml });
  assertMatchesGolden(s.run(["kb", "standards", "--json"]));
  const c = legacyUsed(s.childEnv);
  assert.equal(c.file, path.join(HUB_OLD, "scripts", "execution", "standards.yml"));
  assert.deepEqual(c.legacy.map((l) => [l.key, l.via, l.replacement]), [
    ["standardsFile", "config", "kbStandardsFile"],
    ["standardsDir", "config", "kbStandardsDir"],
  ]);
});
