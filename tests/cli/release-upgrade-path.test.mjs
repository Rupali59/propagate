/**
 * The `upgrade-path` gate (#236): an EXISTING install moving from the previous release must work, not only a fresh one.
 *
 * The fixture is a tiny git repo standing in for propagate, with a fake `cli.mjs` per release:
 *   v1 `setup` writes `$PROPAGATE_STATE_DIR/state.json` as {"schema":1}.
 *   v2 `doctor` REJECTS a state file whose schema is not 2 (it renamed the key and shipped no migration), but is happy
 *   with NO state file, which is exactly why a fresh-machine gate (stranger-install) cannot see it.
 * So the property under test: the gate goes red because it ran v1 FIRST and then v2 over what v1 wrote. Mutation (done by hand,
 * recorded in the commit): skip the old-cli stage, and the "v2 rejects v1's state" case must go green, i.e. the test goes red.
 *
 * The real repo's tags are never read here; the gate is pointed at the fixture by `skillDir`.
 */
// @size medium — starts processes (git, node); run when affected
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { gateUpgradePath, buildStrangerFixture } from "../../lib/core/release.mjs";

const rm = (d) => rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
const g = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const cliV1 = `
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
const [cmd] = process.argv.slice(2);
const dir = process.env.PROPAGATE_STATE_DIR;
if (cmd === "setup") { mkdirSync(dir, { recursive: true }); writeFileSync(path.join(dir, "state.json"), JSON.stringify({ schema: 1 })); }
process.exit(0);
`;
/** v1 whose doctor rejects any state file that is not schema 1: so after v2 migrates, the DOWNGRADE breaks. */
const cliV1Strict = `
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const [cmd] = process.argv.slice(2);
const dir = process.env.PROPAGATE_STATE_DIR;
const f = path.join(dir, "state.json");
if (cmd === "setup") { mkdirSync(dir, { recursive: true }); writeFileSync(f, JSON.stringify({ schema: 1 })); }
if (cmd === "doctor" && existsSync(f) && JSON.parse(readFileSync(f, "utf8")).schema !== 1) { console.log("doctor: unknown state"); process.exit(1); }
process.exit(0);
`;
/** v2 reads the state with `schema` renamed to `shape`; migrate=true is the control that handles v1's key. */
const cliV2 = (migrate) => `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const [cmd] = process.argv.slice(2);
const f = path.join(process.env.PROPAGATE_STATE_DIR ?? "", "state.json");
if (cmd === "setup") { process.exit(0); }
if (cmd === "doctor" || cmd === "status") {
  if (existsSync(f)) {
    const s = JSON.parse(readFileSync(f, "utf8"));
    if (s.schema === 1 && ${migrate ? "true" : "false"}) { writeFileSync(f, JSON.stringify({ shape: 2 })); process.exit(0); }
    if (s.shape !== 2) { console.log("doctor: state.json has no 'shape'; cannot read what the previous release wrote"); process.exit(1); }
  }
}
process.exit(0);
`;

/** tags: which release tags to put on the v1 commit (list of names, lightweight). */
function releaseRepo({ migrate = false, v1Tags = ["v1.0.0"], tagV2 = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "propagate-upgrade-fixture-"));
  g(dir, "init", "-q", "-b", "main");
  g(dir, "config", "user.email", "t@example.com");
  g(dir, "config", "user.name", "t");
  mkdirSync(path.join(dir, "node_modules"));
  writeFileSync(path.join(dir, "node_modules", ".keep"), "");
  writeFileSync(path.join(dir, "package.json"), '{"type":"module"}\n');
  writeFileSync(path.join(dir, "cli.mjs"), cliV1);
  g(dir, "add", "-A");
  g(dir, "commit", "-q", "-m", "v1");
  for (const t of v1Tags) g(dir, "tag", t);
  writeFileSync(path.join(dir, "cli.mjs"), cliV2(migrate));
  g(dir, "add", "-A");
  g(dir, "commit", "-q", "-m", "v2");
  if (tagV2) g(dir, "tag", "v2.0.0");
  return dir;
}

test("a release that rejects the previous release's state FAILS the gate, naming the previous tag and doctor", () => {
  const dir = releaseRepo();
  try {
    const r = gateUpgradePath({ skillDir: dir, env: {} });
    assert.equal(r.status, "failed", r.detail ?? r.reason);
    assert.match(r.detail, /cannot work over the state v1\.0\.0 wrote/);
    assert.match(r.detail, /doctor exited 1/);
    assert.equal(r.stages.oldSetup, 0);
    assert.equal(r.stages.newDoctor, 1);
    assert.equal(r.stages.oldDoctor, 0, "the previous release was healthy before the upgrade, so the failure is the upgrade's");
  } finally { rm(dir); }
});

test("the control: the same fixture with a migration PASSES, and the pass states its blind spot and the downgrade result", () => {
  const dir = releaseRepo({ migrate: true });
  try {
    const r = gateUpgradePath({ skillDir: dir, env: {} });
    assert.equal(r.status, "passed", r.detail ?? r.reason);
    assert.match(r.detail, /Blind spot: only the fixture's one workspace is upgraded/);
    assert.match(r.detail, /persisted-shape diff is deferred \(#236\)/);
    assert.match(r.detail, /downgrade \(v1\.0\.0 doctor after this version\): still clean/);
    assert.match(r.detail, /the tag's own committed node_modules/);
  } finally { rm(dir); }
});

test("a downgrade that breaks is REPORTED and does not block (v1's doctor is fine here, so force it by tagging a v1 that reads shape)", () => {
  // v1' reads state the way v2 writes it only when schema is 1; after v2 migrates to {shape:2}, v1's doctor
  // rejects it. Built by giving v1 a doctor that exits 1 on a state file without schema 1.
  const dir = mkdtempSync(path.join(tmpdir(), "propagate-upgrade-fixture-"));
  try {
    g(dir, "init", "-q", "-b", "main");
    g(dir, "config", "user.email", "t@example.com");
    g(dir, "config", "user.name", "t");
    mkdirSync(path.join(dir, "node_modules"));
    writeFileSync(path.join(dir, "node_modules", ".keep"), "");
    writeFileSync(path.join(dir, "package.json"), '{"type":"module"}\n');
    writeFileSync(path.join(dir, "cli.mjs"), cliV1Strict);
    g(dir, "add", "-A");
    g(dir, "commit", "-q", "-m", "v1");
    g(dir, "tag", "v1.0.0");
    writeFileSync(path.join(dir, "cli.mjs"), cliV2(true));
    g(dir, "add", "-A");
    g(dir, "commit", "-q", "-m", "v2");
    const r = gateUpgradePath({ skillDir: dir, env: {} });
    assert.equal(r.status, "passed", `${r.detail ?? r.reason}`);
    assert.equal(r.stages.downgradeDoctor, 1);
    assert.match(r.detail, /downgrade \(v1\.0\.0 doctor after this version\): exit 1; reported, not blocking/);
  } finally { rm(dir); }
});

test("no previous tag: the gate is SKIPPED with the reason stated, never passed", () => {
  const dir = releaseRepo({ v1Tags: [] });
  try {
    const r = gateUpgradePath({ skillDir: dir, env: {} });
    assert.equal(r.status, "skipped");
    assert.match(r.reason, /no previous release tag reachable from HEAD/);
    assert.match(r.reason, /no install to upgrade from/);
  } finally { rm(dir); }
});

test("the only tag is on HEAD: there is no PREVIOUS release, so it is skipped (not run against itself)", () => {
  const dir = releaseRepo({ v1Tags: [], tagV2: true });
  try {
    const r = gateUpgradePath({ skillDir: dir, env: {} });
    assert.equal(r.status, "skipped");
    assert.match(r.reason, /v2\.0\.0 is on HEAD and no version tag precedes it/);
  } finally { rm(dir); }
});

test("a propagate-v* previous tag is found too (the first release after the rename)", () => {
  const dir = releaseRepo({ v1Tags: ["propagate-v1.0.0"] });
  try {
    const r = gateUpgradePath({ skillDir: dir, env: {} });
    assert.equal(r.status, "failed", r.detail ?? r.reason);
    assert.match(r.detail, /state propagate-v1\.0\.0 wrote/);
  } finally { rm(dir); }
});

test("PROPAGATE_UPGRADE_PATH_SKIP skips knowingly, prints the reason, and leaves the release INCOMPLETE, never READY", () => {
  const dir = releaseRepo();
  try {
    const r = gateUpgradePath({ skillDir: dir, env: { PROPAGATE_UPGRADE_PATH_SKIP: "docs-only release" } });
    // could-not-run, not skipped: runReleaseCheck treats "skipped" as non-blocking, so a knowing skip reported as
    // "skipped" would let release --check print READY with the upgrade never tested.
    assert.equal(r.status, "could-not-run");
    assert.match(r.reason, /not READY until this gate runs/);
    assert.match(r.reason, /PROPAGATE_UPGRADE_PATH_SKIP=docs-only release/);
  } finally { rm(dir); }
});

test("a previous tag whose own setup fails is could-not-run (the previous release's problem), not a failure of this one", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "propagate-upgrade-fixture-"));
  try {
    g(dir, "init", "-q", "-b", "main");
    g(dir, "config", "user.email", "t@example.com");
    g(dir, "config", "user.name", "t");
    mkdirSync(path.join(dir, "node_modules"));
    writeFileSync(path.join(dir, "node_modules", ".keep"), "");
    writeFileSync(path.join(dir, "package.json"), '{"type":"module"}\n');
    writeFileSync(path.join(dir, "cli.mjs"), "process.exit(3);\n");
    g(dir, "add", "-A");
    g(dir, "commit", "-q", "-m", "v1");
    g(dir, "tag", "v1.0.0");
    writeFileSync(path.join(dir, "cli.mjs"), cliV2(true));
    g(dir, "add", "-A");
    g(dir, "commit", "-q", "-m", "v2");
    const r = gateUpgradePath({ skillDir: dir, env: {} });
    assert.equal(r.status, "could-not-run");
    assert.match(r.reason, /v1\.0\.0's own setup did not complete/);
  } finally { rm(dir); }
});

test("an archived tree with no node_modules gets the current one symlinked, and the detail names that blind spot", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "propagate-upgrade-fixture-"));
  try {
    g(dir, "init", "-q", "-b", "main");
    g(dir, "config", "user.email", "t@example.com");
    g(dir, "config", "user.name", "t");
    writeFileSync(path.join(dir, "package.json"), '{"type":"module"}\n');
    writeFileSync(path.join(dir, "cli.mjs"), cliV1);
    writeFileSync(path.join(dir, ".gitignore"), "node_modules\n");
    g(dir, "add", "-A");
    g(dir, "commit", "-q", "-m", "v1");
    g(dir, "tag", "v1.0.0");
    mkdirSync(path.join(dir, "node_modules"));
    writeFileSync(path.join(dir, "cli.mjs"), cliV2(true));
    g(dir, "add", "-A");
    g(dir, "commit", "-q", "-m", "v2");
    const r = gateUpgradePath({ skillDir: dir, env: {} });
    assert.equal(r.status, "passed", r.detail ?? r.reason);
    assert.match(r.detail, /CURRENT node_modules symlinked in/);
  } finally { rm(dir); }
});

test("the stranger fixture is shared: buildStrangerFixture hands back an isolated HOME with a git workspace, and cleans up", () => {
  const fx = buildStrangerFixture();
  assert.equal(fx.ok, true);
  try {
    assert.equal(fx.env.HOME, fx.home);
    assert.ok(fx.env.PROPAGATE_STATE_DIR.startsWith(fx.home));
    assert.equal(g(fx.demo, "rev-parse", "--is-inside-work-tree"), "true");
  } finally { fx.cleanup(); }
  assert.throws(() => execFileSync("test", ["-d", fx.home]));
});
