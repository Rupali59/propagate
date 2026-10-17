// @size medium — starts processes (the recorder fixture, affected.mjs); run when affected
/**
 * The test-impact tooling watches itself (rule:enforcement-watches-itself).
 *
 * tests/impact-map.json decides which tests a change may skip, so every way it can be
 * wrong has to fail HERE, loudly, rather than as a quiet "selected 12 of 246" that
 * missed a test:
 *  - a test file the map has never seen;
 *  - a recorder gone blind (the floors below; rule:derive-dont-curate);
 *  - an attribution path that no longer reaches spawned children (the live fixture run);
 *  - a missing, empty or stale map that does not fall back to the full suite.
 *
 * Run: `npm test` (G56).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { REPO, listTestFiles, readSize } from "../../scripts/test-impact/lib.mjs";
import { closure } from "../../scripts/test-impact/static.mjs";
import { selectTests } from "../../scripts/test-impact/affected.mjs";
import { readRecordings } from "../../scripts/test-impact/map.mjs";

const RECORDER = path.join(REPO, "scripts", "test-impact", "record.mjs");
const AFFECTED = path.join(REPO, "scripts", "test-impact", "affected.mjs");
const FIXTURE = "tests/helpers/impact-fixture.mjs";
const map = JSON.parse(readFileSync(path.join(REPO, "tests", "impact-map.json"), "utf8"));

const entry = (deps, extra = {}) => ({ deps, size: "small", ...extra });
const fixtureMap = () => ({
  header: { commit: "abc" },
  tests: {
    "tests/unit/a.test.mjs": entry(["tests/unit/a.test.mjs", "lib/a.mjs", "lib/shared.mjs"]),
    "tests/unit/b.test.mjs": entry(["tests/unit/b.test.mjs", "lib/shared.mjs", "commands/ui/css/"]),
    "tests/cli/c.test.mjs": entry(["tests/cli/c.test.mjs", "cli.mjs"], { size: "medium" }),
    "tests/cli/clean.test.mjs": entry(["tests/cli/clean.test.mjs"], { size: "medium", partial: true }),
    "tests/unit/tree.test.mjs": entry(["tests/unit/tree.test.mjs"], { tree: true }),
    "tests/cli/big.test.mjs": entry(["tests/cli/big.test.mjs", "lib/a.mjs"], { size: "large" }),
    "tests/unit/d.test.mjs": entry(["tests/unit/d.test.mjs", "lib/d.mjs"]),
    "tests/unit/e.test.mjs": entry(["tests/unit/e.test.mjs", "docs/**"]),
  },
});

// ---- the committed map -----------------------------------------------------------

test("every test file is in the map, and the map names no test that is gone", (t) => {
  const onDisk = listTestFiles();
  const inMap = Object.keys(map.tests);
  assert.deepEqual(
    onDisk.filter((f) => !map.tests[f]),
    [],
    "test file(s) missing from tests/impact-map.json — run `npm run test:record`. An unmapped test is one `test:affected` can never select.",
  );
  assert.deepEqual(inMap.filter((f) => !existsSync(path.join(REPO, f))), [], "map names test file(s) that no longer exist");
});

test("map entries are well formed and their sizes match the files' @size headers", () => {
  const bad = [];
  for (const [t, e] of Object.entries(map.tests)) {
    if (!Array.isArray(e.deps) || !e.deps.includes(t)) bad.push(`${t}: deps must list the test itself`);
    if (!["small", "medium", "large"].includes(e.size)) bad.push(`${t}: size ${e.size}`);
    if (readSize(t) !== e.size) bad.push(`${t}: map says ${e.size}, header says ${readSize(t)} — re-run \`npm run test:record\``);
  }
  assert.deepEqual(bad, []);
});

test("floors: the static graph and the recorded graph have not gone blind", (t) => {
  // Measured 2026-10-17: 188 of 246 files import repo code, and 84 start a process that
  // the recorder attributed to them. The plan expected >=200 and >=100 (it counted files
  // that MENTION cli.mjs, not files whose spawned process was recorded); these floors sit
  // below the measurement so a real regression trips them and a normal edit does not.
  const files = listTestFiles();
  const withStatic = files.filter((f) => closure(f).deps.length > 1).length;
  assert.ok(withStatic >= 150, `only ${withStatic} test files import repo code — the static scan has gone blind, it has not found independent tests`);

  // Derived from the committed map: a test whose deps go beyond its static closure got
  // them from the recorder (spawned processes and text reads).
  const withRecorded = files.filter((f) => {
    const staticDeps = new Set(closure(f).deps);
    return (map.tests[f]?.deps ?? []).some((d) => !staticDeps.has(d) && !d.endsWith("/") && !d.endsWith("**"));
  }).length;
  assert.ok(withRecorded >= 60, `only ${withRecorded} test files have recorded deps beyond their imports — the recorder has gone blind, it has not found independent tests`);

  const partial = files.filter((f) => map.tests[f]?.partial).length;
  t.diagnostic(`static ${withStatic}/${files.length}, recorded-beyond-static ${withRecorded}, partial ${partial}, unattributed processes at record time ${map.header.unattributedProcesses}`);
  assert.equal(map.header.unattributedProcesses, 0, "processes were recorded with no owner — attribution is broken (TESTIMPACT_OWNER not inherited)");
});

// ---- the recorder, live ----------------------------------------------------------

function recorded(nodeArgs, extraEnv = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "testimpact-selftest-"));
  const env = { ...process.env, ...extraEnv, TESTIMPACT_DIR: dir, NODE_OPTIONS: `--import ${RECORDER}` };
  // This test may itself be running under the recorder (map.mjs): those would make the
  // inner run look like a child of ours, and node:test would refuse to nest a runner.
  delete env.TESTIMPACT_OWNER;
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, nodeArgs, { cwd: REPO, env, encoding: "utf8" });
  const procs = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const lines = readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      return { head: lines[0], rows: lines.slice(1) };
    });
  return { r, procs, dir };
}

test("recorder attributes a spawned child to the test file, and flags a cleared env", () => {
  const { r, procs } = recorded(["--test", FIXTURE]);
  assert.equal(r.status, 0, `fixture run failed:\n${r.stdout}\n${r.stderr}`);
  const owned = procs.filter((p) => p.head.o === FIXTURE);
  assert.ok(owned.some((p) => p.head.test), "the test-file process did not record itself as the owner (TESTIMPACT_OWNER not set from the runner's entry file)");
  const child = owned.find((p) => !p.head.test && p.rows.some((x) => x.k === "r" && x.p === "VERSION"));
  assert.ok(child, "the spawned child's read of VERSION was not attributed to the test file — TESTIMPACT_OWNER is not inherited by children");
  assert.ok(owned.some((p) => p.rows.some((x) => x.k === "c")), "a spawn with a cleared env was not flagged — a test that clears env would be trusted silently");
  assert.equal(procs.filter((p) => !p.head.o).length, 0, "a process was recorded with no owner");
});

test("recorder: silent, writes only its own file, and is a no-op without TESTIMPACT_DIR", () => {
  const { r, procs, dir } = recorded(["-e", 'require("node:fs").readFileSync("VERSION")']);
  assert.equal(r.stdout, "", "recorder wrote to stdout");
  assert.equal(r.stderr, "", "recorder wrote to stderr");
  assert.equal(procs.length, 1);
  assert.deepEqual(readdirSync(dir).filter((f) => !f.endsWith(".jsonl")), [], "recorder wrote something other than <pid>.jsonl");

  // Off: no TESTIMPACT_DIR means nothing is created and nothing is printed.
  const probe = mkdtempSync(path.join(os.tmpdir(), "testimpact-off-"));
  const env = { ...process.env, NODE_OPTIONS: `--import ${RECORDER}` };
  delete env.TESTIMPACT_DIR;
  const off = spawnSync(process.execPath, ["-e", `require("node:fs").readFileSync(${JSON.stringify(path.join(REPO, "VERSION"))})`], { cwd: probe, env, encoding: "utf8" });
  assert.equal(off.status, 0);
  assert.equal(off.stdout + off.stderr, "");
  assert.deepEqual(readdirSync(probe), [], "recorder created files while disabled");
});

// ---- selection logic, on fixture maps ----------------------------------------------

test("affected: a missing, empty or unreadable map falls back to the full suite, with a reason", () => {
  for (const m of [null, undefined, {}, { tests: {} }, { tests: "x" }]) {
    const s = selectTests({ map: m, changed: ["lib/a.mjs"] });
    assert.equal(s.mode, "full");
    assert.match(s.reason, /map missing or empty/);
  }
});

test("affected: a map recorded on a non-ancestor commit falls back", () => {
  const s = selectTests({ map: fixtureMap(), changed: ["lib/a.mjs"], ancestor: false });
  assert.equal(s.mode, "full");
  assert.match(s.reason, /not an ancestor/);
});

test("affected: a changed file the map does not know falls back, naming the file", () => {
  const s = selectTests({ map: fixtureMap(), changed: ["lib/a.mjs", "lib/brand-new.mjs"] });
  assert.equal(s.mode, "full");
  assert.match(s.reason, /lib\/brand-new\.mjs is unknown to the map/);
});

test("affected: a changed test file that is not in the map falls back", () => {
  const s = selectTests({ map: fixtureMap(), changed: ["tests/unit/test-impact.test.mjs"] });
  assert.equal(s.mode, "full");
  assert.match(s.reason, /not in the map/);
});

test("affected: a known file selects exactly its dependents, each with the dep that pulled it in", () => {
  const s = selectTests({ map: fixtureMap(), changed: ["lib/shared.mjs"] });
  assert.equal(s.mode, "subset");
  const names = s.selected.map((x) => x.test);
  // a, b depend on it; tree is the always-run whole-tree check; clean is the partial
  // (cleared-env) test, selected because a source file changed.
  assert.deepEqual(names, ["tests/cli/clean.test.mjs", "tests/unit/a.test.mjs", "tests/unit/b.test.mjs", "tests/unit/tree.test.mjs"]);
  assert.match(s.selected.find((x) => x.test === "tests/unit/a.test.mjs").why, /^lib\/shared\.mjs \(dep\)/);
  assert.match(s.selected.find((x) => x.test === "tests/unit/tree.test.mjs").why, /whole-tree check/);
  assert.ok(!names.includes("tests/unit/d.test.mjs"), "an unrelated test was selected");
});

test("affected: directory listings and recursive trees match files beneath them", () => {
  const css = selectTests({ map: fixtureMap(), changed: ["commands/ui/css/new.css"] });
  assert.ok(css.selected.some((x) => x.test === "tests/unit/b.test.mjs" && /dir listing/.test(x.why)));
  const doc = selectTests({ map: fixtureMap(), changed: ["docs/anything/deep.md"] });
  assert.ok(doc.selected.some((x) => x.test === "tests/unit/e.test.mjs" && /tree docs\/\*\*/.test(x.why)));
});

test("affected: partial tests run on any source change; large tests are skipped visibly", () => {
  const s = selectTests({ map: fixtureMap(), changed: ["lib/a.mjs"] });
  assert.ok(s.selected.some((x) => x.test === "tests/cli/clean.test.mjs" && /cleared env/.test(x.why)));
  assert.deepEqual(s.skippedLarge.map((x) => x.test), ["tests/cli/big.test.mjs"]);
  assert.ok(!s.selected.some((x) => x.test === "tests/cli/big.test.mjs"));
  const withLarge = selectTests({ map: fixtureMap(), changed: ["lib/a.mjs"], includeLarge: true });
  assert.ok(withLarge.selected.some((x) => x.test === "tests/cli/big.test.mjs"));
});

test("affected: an exempt path no test reads is skipped, not a fallback; --all always falls back", () => {
  const s = selectTests({ map: fixtureMap(), changed: ["propagation/state/workspace/STATE.md", "lib/d.mjs"] });
  assert.equal(s.mode, "subset");
  assert.deepEqual(s.exempt, ["propagation/state/workspace/STATE.md"]);
  assert.equal(selectTests({ map: fixtureMap(), changed: ["lib/d.mjs"], all: true }).mode, "full");
});

test("affected: a file that most tests depend on is the full suite, not a 'subset'", () => {
  const m = fixtureMap();
  for (const e of Object.values(m.tests)) e.deps.push("package.json");
  const s = selectTests({ map: m, changed: ["package.json"] });
  assert.equal(s.mode, "full");
  assert.match(s.reason, /8 of 8 tests/);
});

test("affected CLI: an empty map file produces the full-suite message and runs nothing under --list", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "testimpact-map-"));
  const file = path.join(dir, "empty.json");
  writeFileSync(file, "{}");
  const r = spawnSync(process.execPath, [AFFECTED, "--files", "lib/core/config.mjs", "--list"], {
    cwd: REPO,
    env: { ...process.env, TEST_IMPACT_MAP: file },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^selected ALL · full suite · map missing or empty/);
  const missing = spawnSync(process.execPath, [AFFECTED, "--files", "lib/core/config.mjs", "--list"], {
    cwd: REPO,
    env: { ...process.env, TEST_IMPACT_MAP: path.join(dir, "nope.json") },
    encoding: "utf8",
  });
  assert.match(missing.stdout, /map missing or empty/);
});

// REGRESSION (2026-10-17 release gate): recordings were named by pid, a pid repeated within one run
// (a process that execs into node keeps it), the second process appended to the first one's file, and
// map.mjs read the second header as a row with no path and crashed, so the gate refreshed no map.
// Built as a literal on purpose: a fixture that went through record.mjs would no longer produce the
// merged file this test exists for.
test("readRecordings: two processes in one recording file are read as two processes, never a crash", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "impact-merged-"));
  writeFileSync(path.join(dir, "4242.jsonl"), [
    JSON.stringify({ o: "tests/unit/a.test.mjs", pid: 4242, test: true, ms: 10 }),
    JSON.stringify({ k: "m", p: "lib/a.mjs" }),
    JSON.stringify({ o: "tests/unit/b.test.mjs", pid: 4242, test: false }),
    JSON.stringify({ k: "r", p: "lib/b.mjs" }),
    JSON.stringify({ k: "r" }),
  ].join("\n") + "\n");
  const r = readRecordings(dir);
  assert.equal(r.processes, 2, "the second header must start a second process");
  assert.ok(r.owners.get("tests/unit/a.test.mjs").deps.has("lib/a.mjs"));
  assert.ok(!r.owners.get("tests/unit/a.test.mjs").deps.has("lib/b.mjs"), "the second process's reads leaked into the first owner");
  assert.ok(r.owners.get("tests/unit/b.test.mjs").deps.has("lib/b.mjs"));
  assert.equal(r.malformed, 1, "a row with no path is counted, not fatal");
});

// REGRESSION (2026-10-17): release --check runs `npm test`, whose npm processes read package.json and
// .npmrc with no owner. Recorded, they made the committed map carry 4 "unattributed" processes and the
// floors test above went red on main. An unowned npm is harness and must leave no record; the same npm
// started BY a test (owner inherited) must still be recorded, or a test that runs npm loses its deps.
test("recorder: an unowned npm process leaves no record, an owned one still does", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "impact-npm-"));
  const fakeNpm = path.join(dir, "npm-cli.js");
  writeFileSync(fakeNpm, `require("fs").readFileSync(${JSON.stringify(path.join(REPO, "package.json"))});\n`);
  const run = (out, owner) => {
    const env = { ...process.env, TESTIMPACT_DIR: out, NODE_OPTIONS: `--import ${path.join(REPO, "scripts", "test-impact", "record.mjs")}` };
    delete env.TESTIMPACT_OWNER;
    delete env.NODE_TEST_CONTEXT;
    if (owner) env.TESTIMPACT_OWNER = owner;
    const r = spawnSync(process.execPath, [fakeNpm], { env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return readdirSync(out).filter((n) => n.endsWith(".jsonl"));
  };
  const unowned = mkdtempSync(path.join(os.tmpdir(), "impact-npm-out-"));
  assert.deepEqual(run(unowned, null), [], "an unowned npm process was recorded, so it counts as unattributed");
  const owned = mkdtempSync(path.join(os.tmpdir(), "impact-npm-out-"));
  const files = run(owned, "tests/unit/some.test.mjs");
  assert.equal(files.length, 1, "an npm started by a test must still be recorded against that test");
  assert.match(readFileSync(path.join(owned, files[0]), "utf8"), /"o":"tests\/unit\/some\.test\.mjs"/);
});
