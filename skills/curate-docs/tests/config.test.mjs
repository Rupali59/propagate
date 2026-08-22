import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, DEFAULTS } from "../lib/config.mjs";

const tmp = () => mkdtempSync(path.join(tmpdir(), "cd-cfg-"));

test("with no config anywhere, the shipped defaults are in force and say so", () => {
  const c = loadConfig(tmp(), { home: tmp() });
  assert.equal(c.source, "defaults");
  assert.ok(c.skipDirs.includes("node_modules"));
  assert.deepEqual(c.archiveDirs, ["archive", "_archive"]);
});

test("skipDirs MERGES with the defaults — one added entry must not drop node_modules", () => {
  const repo = tmp();
  writeFileSync(path.join(repo, ".curate-docs.yml"), "skipDirs: [my-scratch]\n");
  const c = loadConfig(repo, { home: tmp() });
  assert.ok(c.skipDirs.includes("my-scratch"));
  assert.ok(c.skipDirs.includes("node_modules"),
    "a config that REPLACED the defaults would put 24,525 files back in scope");
  assert.ok(c.skipDirs.includes(".worktrees"));
});

test("skipDirsReplace: true is the explicit opt-out, and it really replaces", () => {
  const repo = tmp();
  writeFileSync(path.join(repo, ".curate-docs.yml"), "skipDirsReplace: true\nskipDirs: [only-this]\n");
  const c = loadConfig(repo, { home: tmp() });
  assert.deepEqual(c.skipDirs, ["only-this"]);
});

test("repo config beats user config beats defaults", () => {
  const home = tmp(), repo = tmp();
  writeFileSync(path.join(home, ".curate-docs.yml"), "staleDays: {default: 90}\nhubSeeds: none\n");
  writeFileSync(path.join(repo, ".curate-docs.yml"), "staleDays: {default: 7}\n");
  const c = loadConfig(repo, { home });
  assert.equal(c.staleDays.default, 7, "repo wins");
  assert.equal(c.hubSeeds, "none", "user layer still applies where repo is silent");
});

test("a malformed config degrades to defaults, says so on stderr, and does NOT throw", () => {
  const repo = tmp();
  writeFileSync(path.join(repo, ".curate-docs.yml"), "skipDirs: [unclosed\n  : : :\n");
  const warnings = [];
  const c = loadConfig(repo, { home: tmp(), warn: (m) => warnings.push(m) });
  assert.ok(c.skipDirs.includes("node_modules"), "must fall back to defaults");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /could not read|not a mapping/);
  assert.match(warnings[0], /using defaults/);
  assert.ok(c.degraded, "degradation must be a reported value, not a silence");
});

test("a config that is not a mapping is rejected loudly, not coerced", () => {
  const repo = tmp();
  writeFileSync(path.join(repo, ".curate-docs.yml"), "- just\n- a\n- list\n");
  const warnings = [];
  const c = loadConfig(repo, { home: tmp(), warn: (m) => warnings.push(m) });
  assert.match(warnings[0], /not a mapping/);
  assert.ok(c.skipDirs.includes("node_modules"));
});

test("~ in a config path is expanded — it is what a person hand-writing one types", () => {
  const home = tmp(), repo = tmp();
  mkdirSync(path.join(home, "ws"));
  writeFileSync(path.join(repo, ".curate-docs.yml"), "extraRoots: ['~/ws']\n");
  const c = loadConfig(repo, { home });
  assert.deepEqual(c.extraRoots, [path.join(home, "ws")]);
});

test("CLI flags beat every file layer", () => {
  const repo = tmp();
  writeFileSync(path.join(repo, ".curate-docs.yml"), "staleDays: {default: 7}\n");
  const c = loadConfig(repo, { home: tmp(), flags: { staleDays: 1 } });
  assert.equal(c.staleDays.default, 1);
});

test("defaults gained the dirs the survey found, including the .venv glob", () => {
  for (const d of [".worktrees", ".claude", ".gemini", ".github", ".cursor", ".disabled", ".obsidian"]) {
    assert.ok(DEFAULTS.skipDirs.includes(d), `${d} missing from shipped defaults`);
  }
  assert.ok(DEFAULTS.skipGlobs.some((g) => g.startsWith(".venv")), ".venv* must be a glob");
  assert.ok(!DEFAULTS.skipDirs.includes("references"), "references/ is 360 files of real docs");
  assert.ok(!DEFAULTS.skipDirs.includes("archive"),
    "archive is graded-exempt, NOT skipped — skipping it is the F1 cascade");
});
