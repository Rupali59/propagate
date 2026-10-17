/**
 * `release --check` records its per-gate result (lib/core/release-record.mjs). Where it is written, what is written, and
 * what must NOT cause a write. The property that matters most is the side effect, so every case snapshots the artifact
 * (rule:safety-flag-needs-a-test), and the real ~/.propagate is never touched: each CLI run gets its own HOME and
 * PROPAGATE_STATE_DIR (GOTCHAS G56).
 *
 * The CLI cases run the REAL `release --check` with a stub `npm` first on PATH, so the suite gate answers in
 * milliseconds instead of re-running this suite inside itself; the other three gates are the real ones.
 */
// @size medium — starts processes (CLI); run when affected
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildReleaseRecord, persistReleaseCheck, recordReleaseCheck, readReleaseChecks, RELEASE_CHECKS_FILE } from "../../lib/core/release-record.mjs";

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(SKILL_DIR, "cli.mjs");
const mk = (p) => mkdtempSync(path.join(tmpdir(), p));
const rm = (d) => rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });

function sandbox() {
  const root = mk("propagate-release-record-");
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "npm"), `#!/bin/sh\necho "ℹ tests 1"\necho "ℹ pass 1"\necho "ℹ fail 0"\n`);
  chmodSync(path.join(bin, "npm"), 0o755);
  const home = path.join(root, "home");
  const state = path.join(root, "state");
  mkdirSync(home); mkdirSync(state);
  const run = (args, over = {}) => {
    const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, HOME: home, PROPAGATE_STATE_DIR: state, ...over };
    delete env.NODE_TEST_CONTEXT;
    return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env, timeout: 120000 });
  };
  return { root, home, state, run, file: path.join(state, RELEASE_CHECKS_FILE) };
}

const lines = (f) => readFileSync(f, "utf8").split("\n").filter(Boolean);

test("release --check appends exactly one line with the four gates, matching what it printed (--json), and a second run appends a second", () => {
  const sb = sandbox();
  try {
    assert.equal(existsSync(sb.file), false, "nothing recorded before the run");
    const r = sb.run(["release", "--check", "--json"]);
    const printed = JSON.parse(r.stdout);
    assert.equal(lines(sb.file).length, 1);
    const rec = JSON.parse(lines(sb.file)[0]);
    assert.deepEqual(Object.keys(rec), ["ts", "version", "overall", "exitCode", "gates"]);
    assert.equal(rec.ts, printed.generatedAt);
    assert.equal(rec.overall, printed.overall);
    assert.equal(rec.exitCode, printed.exitCode);
    assert.equal(r.status, printed.exitCode, "the exit code is the verdict's, record or no record");
    assert.equal(rec.version, JSON.parse(readFileSync(path.join(SKILL_DIR, "package.json"), "utf8")).version);
    assert.deepEqual(rec.gates.map((g) => g.name), ["version-manifests", "suite", "make-public-check", "stranger-install"]);
    assert.deepEqual(rec.gates.map((g) => g.status), printed.gates.map((g) => g.status));
    for (const g of rec.gates) assert.ok(typeof (g.detail ?? g.reason) === "string" && (g.detail ?? g.reason).length > 0, `${g.name} carries its detail or reason`);
    assert.equal("raw" in rec.gates[0], false, "gate output is not stored");
    // human mode records too, and appends.
    const h = sb.run(["release", "--check"]);
    assert.equal(h.status, r.status);
    assert.equal(lines(sb.file).length, 2, "append-only: one line per run");
  } finally { rm(sb.root); }
});

test("a usage error (no --check) writes nothing to the state dir", () => {
  const sb = sandbox();
  try {
    const before = readdirSync(sb.state).sort();
    for (const args of [["release"], ["release", "--json"], ["release", "--bogus"]]) {
      const r = sb.run(args);
      assert.equal(r.status, 2);
      assert.equal(existsSync(sb.file), false, `${args.join(" ")} must not record a release check`);
    }
    assert.deepEqual(readdirSync(sb.state).filter((f) => f === RELEASE_CHECKS_FILE), []);
    assert.ok(before.every((f) => f !== RELEASE_CHECKS_FILE));
  } finally { rm(sb.root); }
});

test("a failed write warns and changes neither the exit code nor the printed verdict", () => {
  const ok = sandbox();
  const bad = sandbox();
  try {
    const control = ok.run(["release", "--check", "--json"]);
    // PROPAGATE_STATE_DIR names a regular file, so `<it>/release-checks.jsonl` cannot be created (ENOTDIR).
    writeFileSync(path.join(bad.root, "afile"), "x");
    const r = bad.run(["release", "--check", "--json"], { PROPAGATE_STATE_DIR: path.join(bad.root, "afile") });
    assert.equal(r.status, control.status, "exit code unchanged by a failed write");
    const a = JSON.parse(control.stdout), b = JSON.parse(r.stdout);
    assert.equal(b.overall, a.overall);
    assert.deepEqual(b.gates.map((g) => g.status), a.gates.map((g) => g.status), "same gates, same statuses");
    assert.match(r.stderr, /warning: could not record this release check in .*release-checks\.jsonl: /);
    assert.equal(existsSync(path.join(bad.root, "afile", RELEASE_CHECKS_FILE)), false);
  } finally { rm(ok.root); rm(bad.root); }
});

test("persistReleaseCheck: an unwritable dir is a warning and { ok:false }, never a throw; detail strings are stored whole", () => {
  const root = mk("propagate-release-persist-");
  try {
    const result = { generatedAt: "2026-10-17T10:00:00.000Z", overall: "blocked", exitCode: 1,
      gates: [{ name: "suite", status: "failed", detail: "x".repeat(5000), raw: "child output that must not be stored" }, { name: "make-public-check", status: "could-not-run", reason: "no identity map" }] };
    const warnings = [];
    writeFileSync(path.join(root, "afile"), "x");
    const f = persistReleaseCheck(result, { stateDir: path.join(root, "afile"), warn: (m) => warnings.push(m) });
    assert.equal(f.ok, false);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /^warning: could not record this release check/);
    // a throwing warner must not escape either
    assert.equal(persistReleaseCheck(result, { stateDir: path.join(root, "afile"), warn: () => { throw new Error("boom"); } }).ok, false);

    const good = persistReleaseCheck(result, { stateDir: path.join(root, "fresh", "nested"), version: "1.2.3", warn: () => assert.fail("no warning on success") });
    assert.equal(good.ok, true);
    const back = readReleaseChecks({ stateDir: path.join(root, "fresh", "nested") });
    assert.equal(back.checks.length, 1);
    assert.equal(back.checks[0].gates[0].detail.length, 5000, "stored whole");
    assert.equal("raw" in back.checks[0].gates[0], false);
    assert.equal(back.checks[0].gates[1].reason, "no identity map");
    assert.deepEqual(buildReleaseRecord(result, { version: "1.2.3" }), back.checks[0]);
    assert.throws(() => recordReleaseCheck(result, { stateDir: path.join(root, "afile") }), "recordReleaseCheck itself throws; only the wrapper swallows");
  } finally { rm(root); }
});

test("readReleaseChecks: a missing file is exists:false; a corrupt or misshapen line is reported with its line number, never skipped; an unreadable file throws", () => {
  const root = mk("propagate-release-read-");
  try {
    assert.deepEqual(readReleaseChecks({ stateDir: root }), { checks: [], bad: [], exists: false });
    const good = (ts) => JSON.stringify({ ts, version: "1", overall: "ready", exitCode: 0, gates: [{ name: "g", status: "passed", detail: "d" }] });
    writeFileSync(path.join(root, RELEASE_CHECKS_FILE), [good("2026-10-17T10:00:00.000Z"), "{not json", JSON.stringify({ ts: "nope", overall: "ready", gates: [] }), "", good("2026-10-16T10:00:00.000Z")].join("\n") + "\n");
    const r = readReleaseChecks({ stateDir: root });
    assert.deepEqual(r.checks.map((c) => c.ts), ["2026-10-16T10:00:00.000Z", "2026-10-17T10:00:00.000Z"], "oldest first");
    assert.deepEqual(r.bad.map((b) => b.line), [2, 3]);
    assert.match(r.bad[0].reason, /not JSON/);
    assert.match(r.bad[1].reason, /not a release record/);
    writeFileSync(path.join(root, "afile"), "x");
    assert.throws(() => readReleaseChecks({ stateDir: path.join(root, "afile") }), "ENOTDIR is not 'nothing recorded'");
  } finally { rm(root); }
});

test("cli.mjs records after runReleaseCheck and before it prints or exits; the recorder lives in the command layer", () => {
  const src = readFileSync(CLI, "utf8");
  const body = src.slice(src.indexOf("async function releaseCmd"));
  const i = body.indexOf("runReleaseCheck()"), j = body.indexOf("persistReleaseCheck("), k = body.indexOf("if (asJson)");
  assert.ok(i > 0 && j > i && k > j, "runReleaseCheck, then persist, then print/exit");
  assert.ok(body.slice(0, i).includes('argv.includes("--check")'), "the usage-error exit comes before the run, so it can never record");
});
