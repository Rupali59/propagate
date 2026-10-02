/**
 * The `paths:` glob guard (plan budget-1-rules-headroom, R2/D4).
 *
 * A scoped rule whose glob can never match -- or whose only matches Claude is denied
 * from reading -- silently never loads. Each test below builds the specific input that
 * makes one failure mode fire, and asserts the VERDICT AND ITS REASON: a check that
 * fails for the wrong reason is as bad as one that cannot fail
 * (rule:discernment-checks §1).
 *
 * The rule files here deliberately have NO `id:` / `fingerprint:` -- a scoped companion
 * file has neither, and gating on loadRules' filter would skip exactly that file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkRulePaths, globToRegExp } from "../../lib/rules/paths-guard.mjs";

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "propagate-paths-guard-"));
  const rulesDir = path.join(dir, "rules");
  const tree = path.join(dir, "tree");
  mkdirSync(rulesDir, { recursive: true });
  mkdirSync(tree, { recursive: true });
  const settings = path.join(dir, "settings.json");
  return {
    dir, rulesDir, tree, settings,
    rule: (name, fm) => writeFileSync(path.join(rulesDir, name), `---\n${fm}\n---\n\nbody\n`),
    file: (rel) => {
      const p = path.join(tree, rel);
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, "x");
      return p;
    },
    filler: (n) => { for (let i = 0; i < n; i++) writeFileSync(path.join(tree, `filler-${i}.txt`), "x"); },
    deny: (patterns) => writeFileSync(settings, JSON.stringify({ permissions: { deny: patterns } })),
    run: (extra = {}) => checkRulePaths({ rulesDir, roots: [tree], settingsPaths: [settings], minFiles: 5, ...extra }),
    cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  };
}

test("a valid glob matching a readable file passes", () => {
  const f = fixture();
  try {
    f.filler(6);
    f.file("proj/package.json");
    f.rule("scoped.md", 'paths:\n  - "**/package.json"');
    const r = f.run();
    assert.equal(r.status, "pass", r.reason);
    assert.equal(r.entries[0].matched, 1);
  } finally { f.cleanup(); }
});

test("a typo glob that matches nothing FAILS and says it matches 0 files", () => {
  const f = fixture();
  try {
    f.filler(6);
    f.file("proj/a.test.ts");
    f.rule("scoped.md", 'paths:\n  - "**/*.tests.*"');
    const r = f.run();
    assert.equal(r.status, "fail");
    assert.match(r.findings[0].problem, /matches 0 files/);
    assert.equal(r.findings[0].entry, "**/*.tests.*");
  } finally { f.cleanup(); }
});

test("a glob whose only matches are Read-denied FAILS as a dead glob", () => {
  const f = fixture();
  try {
    f.filler(6);
    f.file("proj/.env.local");
    f.deny([`Read(${f.tree}/**/.env*)`]);
    f.rule("scoped.md", 'paths:\n  - "**/.env.local"');
    const r = f.run();
    assert.equal(r.status, "fail");
    assert.match(r.findings[0].problem, /permissions\.deny/);
    assert.equal(r.entries[0].matched, 1, "it DID match a file -- the failure is the deny, not absence");
    assert.equal(r.entries[0].readable, 0);
  } finally { f.cleanup(); }
});

test("a glob matching one denied and one readable file passes", () => {
  const f = fixture();
  try {
    f.filler(6);
    f.file("a/.env.local");
    f.file("b/.env.local");
    f.deny([`Read(${f.tree}/a/**)`]);
    f.rule("scoped.md", 'paths:\n  - "**/.env.local"');
    const r = f.run();
    assert.equal(r.status, "pass", r.reason);
    assert.equal(r.entries[0].readable, 1);
  } finally { f.cleanup(); }
});

test("an entry that does not start with **/ FAILS even though it would match a file", () => {
  const f = fixture();
  try {
    f.filler(6);
    f.file("src/index.ts");
    f.rule("scoped.md", 'paths:\n  - "src/**/*.ts"');
    const r = f.run();
    assert.equal(r.status, "fail");
    assert.match(r.findings[0].problem, /does not start with `\*\*\/`/);
  } finally { f.cleanup(); }
});

test("empty, non-array and non-string paths all FAIL on shape", () => {
  const cases = {
    "empty list": "paths: []",
    "a bare string": 'paths: "**/package.json"',
    "a list holding a number": "paths:\n  - 42",
    "a key with no value": "paths:",
  };
  for (const [why, fm] of Object.entries(cases)) {
    const f = fixture();
    try {
      f.filler(6);
      f.rule("scoped.md", fm);
      const r = f.run();
      assert.equal(r.status, "fail", why);
      assert.match(r.findings[0].problem, /non-empty array of non-empty strings/, why);
    } finally { f.cleanup(); }
  }
});

test("a scoped file with no id/fingerprint is still checked", () => {
  const f = fixture();
  try {
    f.filler(6);
    f.rule("companion.md", 'paths:\n  - "**/nowhere.xyz"');
    const r = f.run();
    assert.equal(r.scoped, 1);
    assert.equal(r.status, "fail");
    assert.equal(r.findings[0].file, "companion.md");
  } finally { f.cleanup(); }
});

test("a missing search root is UNKNOWN, never pass and never a per-glob verdict", () => {
  const f = fixture();
  try {
    f.rule("scoped.md", 'paths:\n  - "**/package.json"');
    const r = f.run({ roots: [path.join(f.dir, "no-such-root")] });
    assert.equal(r.status, "unknown");
    assert.match(r.reason, /missing/);
    assert.deepEqual(r.findings, []);
  } finally { f.cleanup(); }
});

test("a shape failure is still reported when the roots are missing", () => {
  const f = fixture();
  try {
    f.rule("scoped.md", 'paths:\n  - "src/**"');
    const r = f.run({ roots: [path.join(f.dir, "no-such-root")] });
    assert.equal(r.status, "fail");
    assert.match(r.reason, /reachability unchecked/);
  } finally { f.cleanup(); }
});

test("a blind walk (below the floor) is reported blind, not pass and not 'matches 0'", () => {
  const f = fixture();
  try {
    f.file("proj/package.json"); // the glob WOULD match, but the walk saw 1 file
    f.rule("scoped.md", 'paths:\n  - "**/package.json"');
    const r = checkRulePaths({ rulesDir: f.rulesDir, roots: [f.tree], settingsPaths: [f.settings] }); // default floor
    assert.equal(r.status, "blind");
    assert.match(r.reason, /gone blind/);
    assert.equal(r.findings.length, 0, "blind must not be dressed up as dead globs");
  } finally { f.cleanup(); }
});

test("skipped directories are not walked (node_modules cannot satisfy a glob)", () => {
  const f = fixture();
  try {
    f.filler(6);
    f.file("node_modules/dep/package.json");
    f.rule("scoped.md", 'paths:\n  - "**/package.json"');
    const r = f.run();
    assert.equal(r.status, "fail");
    assert.match(r.findings[0].problem, /matches 0 files/);
  } finally { f.cleanup(); }
});

test("a rules dir with no paths: key reports none, which is not pass", () => {
  const f = fixture();
  try {
    f.rule("plain.md", "id: plain\nfingerprint: x");
    const r = f.run();
    assert.equal(r.status, "none");
  } finally { f.cleanup(); }
});

test("an unreadable settings.json is noted, not silently treated as 'no deny'", () => {
  const f = fixture();
  try {
    f.filler(6);
    f.file("p/package.json");
    writeFileSync(f.settings, "{ not json");
    f.rule("scoped.md", 'paths:\n  - "**/package.json"');
    const r = f.run();
    assert.equal(r.status, "pass");
    assert.match(r.notes.join("\n"), /not readable JSON/);
  } finally { f.cleanup(); }
});

test("globToRegExp: ** spans directories, * does not, **/ matches zero directories", () => {
  assert.ok(globToRegExp("**/package.json").test("package.json"));
  assert.ok(globToRegExp("**/package.json").test("a/b/package.json"));
  assert.ok(!globToRegExp("**/package.json").test("a/b/xpackage.json"));
  assert.ok(globToRegExp("**/next.config.*").test("a/next.config.mjs"));
  assert.ok(!globToRegExp("*.md").test("a/b.md"));
  assert.ok(globToRegExp("**/tests/**").test("x/tests/y/z.js"));
});
