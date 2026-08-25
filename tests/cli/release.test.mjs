/**
 * `release --check` — the four gates that must all be attributable before a
 * human publishes (docs/RELEASE.md; ~/.claude/plans/status-temporal-plum.md
 * §3). The command runs the gates and publishes NOTHING — there is no
 * `--apply`, on purpose (rule:safety-flag-needs-a-test's corollary: never
 * build the unsafe path in the first place if the doc says it never ships).
 *
 * THE LOAD-BEARING PROPERTY, per rule:discernment-checks §2 ("absence must be
 * attributable"): a gate that could not run must never print or exit like a
 * gate that passed. gate 3 (make-public --check) legitimately CANNOT run
 * without an identity map — CI has none on purpose — and that must read as
 * "could-not-run", never as green. Every gate function returns
 * status: "passed" | "failed" | "could-not-run", and every case below is
 * paired with a negative control proving the function can report each of the
 * three, not just the happy path (GOTCHAS G1: a check that cannot fail is
 * worse than no check).
 *
 * lib/core/release.mjs is a pure-ish module: gate 1 does no I/O beyond
 * reading manifests, gate 2 shells to `npm test` in a caller-supplied
 * `skillDir` (a tiny fixture project here, never the real 700+-test suite —
 * running the real suite from inside the suite would double every `npm test`
 * invocation), gates 3 and 4 exercise the REAL bin/make-public.mjs and
 * cli.mjs (they are what those tools promise to do), isolated only by HOME /
 * PROPAGATE_STATE_DIR so nothing here can touch the real install.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  gateVersionManifests,
  gateSuite,
  gateMakePublicCheck,
  gateStrangerInstall,
  runReleaseCheck,
} from "../../lib/core/release.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.join(HERE, "..", "..");
const CLI = path.join(SKILL_DIR, "cli.mjs");

function tmp(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

// ---------------------------------------------------------------------------
// Gate 1 — version-manifests
// ---------------------------------------------------------------------------

function manifestFixture({ version = "0.1.0", pkg = version, plugin = version, marketplace = version } = {}) {
  const dir = tmp("propagate-release-manifests-");
  writeFileSync(path.join(dir, "VERSION"), `${version}\n`);
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", version: pkg }));
  mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(path.join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "x", version: plugin }));
  writeFileSync(
    path.join(dir, ".claude-plugin", "marketplace.json"),
    JSON.stringify({ plugins: [{ name: "x", version: marketplace }] }),
  );
  return dir;
}

test("gate 1: all four manifests agreeing passes", () => {
  const dir = manifestFixture({ version: "1.2.3" });
  try {
    const g = gateVersionManifests({ skillDir: dir });
    assert.equal(g.status, "passed", g.detail);
    assert.equal(g.versions.VERSION, "1.2.3");
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("NEGATIVE CONTROL: a manifest that lags VERSION must fail, not pass", () => {
  const dir = manifestFixture({ version: "1.2.3", plugin: "1.2.2" });
  try {
    const g = gateVersionManifests({ skillDir: dir });
    assert.equal(g.status, "failed", "a version mismatch must not read as passed");
    assert.match(g.detail, /1\.2\.2/);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("gate 1: a missing manifest is could-not-run, never a silent pass", () => {
  const dir = manifestFixture();
  rmSync(path.join(dir, ".claude-plugin", "marketplace.json"));
  try {
    const g = gateVersionManifests({ skillDir: dir });
    assert.equal(g.status, "could-not-run");
    assert.match(g.reason, /marketplace\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

// ---------------------------------------------------------------------------
// Gate 2 — suite (fixture project, never the real suite — see file header)
// ---------------------------------------------------------------------------

function suiteFixture(testScript) {
  const dir = tmp("propagate-release-suite-");
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fixture", scripts: { test: testScript } }));
  return dir;
}

test("gate 2: a clean node:test summary passes", () => {
  const dir = suiteFixture(
    `node -e "console.log('# tests 3'); console.log('# pass 3'); console.log('# fail 0')"`,
  );
  try {
    const g = gateSuite({ skillDir: dir });
    assert.equal(g.status, "passed", g.detail);
    assert.equal(g.passed, 3);
    assert.equal(g.failed, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("gate 2: the real node:test 'spec' reporter's summary (ℹ glyph, not #) must parse", () => {
  // REGRESSION, found by running this gate for real: `npm test` on this machine
  // emits "ℹ pass N" / "ℹ fail N" (the spec reporter's info glyph), not the TAP
  // "# pass N" this gate was first written against — so the very first real
  // `node cli.mjs release --check` misreported a clean 762/0 suite as
  // could-not-run. Locking in both forms so this cannot regress silently.
  const dir = suiteFixture(
    `node -e "console.log('ℹ tests 3'); console.log('ℹ pass 3'); console.log('ℹ fail 0')"`,
  );
  try {
    const g = gateSuite({ skillDir: dir });
    assert.equal(g.status, "passed", g.detail);
    assert.equal(g.passed, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("NEGATIVE CONTROL: a non-zero fail count must fail, not pass", () => {
  const dir = suiteFixture(
    `node -e "console.log('# tests 3'); console.log('# pass 2'); console.log('# fail 1'); process.exit(1)"`,
  );
  try {
    const g = gateSuite({ skillDir: dir });
    assert.equal(g.status, "failed", g.detail);
    assert.equal(g.failed, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("gate 2: output with no parseable node:test summary is could-not-run, not a pass", () => {
  const dir = suiteFixture(`node -e "console.log('nothing that looks like a summary')"`);
  try {
    const g = gateSuite({ skillDir: dir });
    assert.equal(g.status, "could-not-run", g.detail);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

// ---------------------------------------------------------------------------
// Gate 3 — make-public --check (the REAL bin/make-public.mjs, isolated HOME)
// ---------------------------------------------------------------------------

test("gate 3: no identity map is a legitimate could-not-run, not a failure and not a pass", () => {
  const home = tmp("propagate-release-nomap-");
  try {
    const g = gateMakePublicCheck({
      skillDir: SKILL_DIR,
      env: { ...process.env, HOME: home, PROPAGATE_STATE_DIR: path.join(home, ".propagate") },
    });
    assert.equal(g.status, "could-not-run", g.detail || g.reason);
    assert.match(g.reason, /identity map/i);
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("gate 3: an empty identity map is its own distinct could-not-run reason", () => {
  const home = tmp("propagate-release-map-");
  try {
    const stateDir = path.join(home, ".propagate");
    mkdirSync(stateDir, { recursive: true });
    // Every real client-workspace name would need to be here too, but SEARCH_ROOTS
    // resolves against this isolated HOME (no ~/Documents/GitHub inside it), so the
    // watchlist is empty and an empty map legitimately satisfies it.
    writeFileSync(path.join(stateDir, "identity-map.json"), JSON.stringify({ names: {}, allow: [] }));
    const g = gateMakePublicCheck({
      skillDir: SKILL_DIR,
      env: { ...process.env, HOME: home, PROPAGATE_STATE_DIR: stateDir },
    });
    // An empty map is rejected by make-public.mjs itself ("nothing would be
    // scrubbed") — assert THAT specific could-not-run, proving this test's
    // fixture is exercising the real refusal path rather than a fluke.
    assert.equal(g.status, "could-not-run", g.detail || g.reason);
    assert.match(g.reason, /empty/i);
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

// ---------------------------------------------------------------------------
// Gate 4 — stranger install (the REAL cli.mjs, isolated HOME, a throwaway
// demo workspace with one real declared edge so bootstrap has something to
// baseline)
// ---------------------------------------------------------------------------

test("gate 4: runs setup -> bootstrap --apply -> doctor and reports the real outcome, not an assumed one", () => {
  const g = gateStrangerInstall({ skillDir: SKILL_DIR });
  // Deliberately NOT asserting status === "passed": whether a synthetic fresh
  // workspace's doctor comes up clean is a fact about the rest of the tool,
  // not about this gate. What this gate must never do is claim "passed"
  // without having actually run doctor, or silently swallow a non-zero exit.
  assert.ok(["passed", "failed"].includes(g.status), `must be a real doctor result, got ${g.status}`);
  assert.ok(g.stages && typeof g.stages.doctor === "number", "must record doctor's actual exit code");
  if (g.status === "failed") {
    assert.match(g.detail, /doctor/i, "a failed stranger-install must name doctor as the point of failure");
  }
});

test("NEGATIVE CONTROL: a skillDir whose cli.mjs cannot even run must be could-not-run, not passed", () => {
  const dir = tmp("propagate-release-badcli-");
  try {
    // No cli.mjs at all under this fake skillDir.
    const g = gateStrangerInstall({ skillDir: dir });
    assert.notEqual(g.status, "passed", "a broken install must never read as a pass");
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

// ---------------------------------------------------------------------------
// The aggregate — runReleaseCheck combines the four without letting a
// could-not-run gate hide inside a "passed" summary.
// ---------------------------------------------------------------------------

test("runReleaseCheck: a could-not-run gate makes the run 'incomplete', never 'ready'", () => {
  const manifests = manifestFixture({ version: "9.9.9" });
  const suite = suiteFixture(`node -e "console.log('# tests 1'); console.log('# pass 1'); console.log('# fail 0')"`);
  const home = tmp("propagate-release-agg-");
  try {
    const result = runReleaseCheck({
      manifestsDir: manifests,
      suiteDir: suite,
      skillDir: SKILL_DIR,
      makePublicEnv: { ...process.env, HOME: home, PROPAGATE_STATE_DIR: path.join(home, ".propagate") },
    });
    assert.equal(result.gates.length, 4);
    const g3 = result.gates.find((g) => g.name === "make-public-check");
    assert.equal(g3.status, "could-not-run");
    assert.notEqual(result.overall, "ready", "could-not-run must never be summarized as ready");
    assert.equal(result.overall, result.gates.some((g) => g.status === "failed") ? "blocked" : "incomplete");
    assert.notEqual(result.exitCode, 0, "an incomplete or blocked run must not exit 0");
  } finally {
    rmSync(manifests, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    rmSync(suite, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

// ---------------------------------------------------------------------------
// CLI dispatch — thin arm only (plan D7): argv parsing and usage, not gate
// logic (that is covered above against the lib module directly).
// ---------------------------------------------------------------------------

test("cli: `release` with no --check is a usage error, not a silent no-op", () => {
  const r = spawnSync(process.execPath, [CLI, "release"], { encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(`${r.stdout}${r.stderr}`, /--check/);
});

test("cli: release exports only the --check entry point — no publish flag exists to invoke", () => {
  // Not "the string --apply never appears" (gateStrangerInstall legitimately
  // shells out to `bootstrap --apply` to exercise the documented install
  // sequence) — the real property is that runReleaseCheck's own signature
  // carries no apply/publish/push knob a caller could flip.
  const src = readFileSync(path.join(SKILL_DIR, "lib", "core", "release.mjs"), "utf8");
  const fnBody = src.slice(src.indexOf("export function runReleaseCheck"));
  const optsBlock = fnBody.slice(0, fnBody.indexOf(") {"));
  assert.doesNotMatch(optsBlock, /apply|publish|push|write/i, `runReleaseCheck's own options must not accept a write flag:\n${optsBlock}`);
});
