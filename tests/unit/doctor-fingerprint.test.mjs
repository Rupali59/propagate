// #239 — the monitor runs doctor only when the tree changed.
// Fixture repos live in temp dirs; the hostile cases are built as literals, not derived from the module.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { computeFingerprint, decideDoctorRun, readFingerprint, writeFingerprint, fingerprintPath, DEFAULT_CEILING_MS } from "../../lib/report/doctor/fingerprint.mjs";
import { readSnapshot } from "../../lib/report/doctor/snapshot.mjs";
import { parseMonitorLine } from "../../lib/report/machinery.mjs";

const sh = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe" });

function makeRepo(root, name) {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  sh(dir, "init", "-q");
  writeFileSync(path.join(dir, "a.txt"), "a\n");
  sh(dir, "add", "a.txt");
  sh(dir, "commit", "-q", "-m", "init");
  return dir;
}

function world() {
  const root = mkdtempSync(path.join(tmpdir(), "propagate-fp-"));
  const repoA = makeRepo(root, "a");
  const repoB = makeRepo(root, "b");
  const cfg = path.join(root, "config.yml");
  const exc = path.join(root, "health-exceptions.yml");
  writeFileSync(cfg, "x: 1\n");
  writeFileSync(exc, "y: 1\n");
  const snapFile = path.join(root, "doctor-snapshot.json");
  return { root, repos: [repoA, repoB], extra: [cfg, exc], cfg, exc, repoA, snapFile };
}

const fp = (w) => computeFingerprint({ repos: w.repos, extraFiles: w.extra });

/** A good snapshot of age `ageMs`, with a stored fingerprint for `current`. */
async function settle(w, ageMs = 60_000) {
  const generatedAt = new Date(Date.now() - ageMs).toISOString();
  writeFileSync(w.snapFile, JSON.stringify({ generatedAt, sections: [], totals: {}, problems: 0 }));
  const cur = await fp(w);
  assert.ok(cur.ok);
  await writeFingerprint(w.snapFile, { fingerprint: cur.fingerprint, snapshotGeneratedAt: generatedAt });
}

async function decide(w, over = {}) {
  return decideDoctorRun({
    snapshot: await readSnapshot(w.snapFile),
    stored: await readFingerprint(w.snapFile),
    current: await fp(w),
    ...over,
  });
}

test("unchanged tree and fresh snapshot: doctor is skipped, with the since-timestamp", async () => {
  const w = world();
  await settle(w);
  const d = await decide(w);
  assert.equal(d.run, false);
  assert.match(d.since, /^\d{4}-\d\d-\d\dT/);
});

test("a HEAD change runs doctor", async () => {
  const w = world();
  await settle(w);
  writeFileSync(path.join(w.repoA, "b.txt"), "b\n");
  sh(w.repoA, "add", "b.txt");
  sh(w.repoA, "commit", "-q", "-m", "second");
  const d = await decide(w);
  assert.equal(d.run, true);
  assert.equal(d.reason, "fingerprint changed");
});

test("a dirty file runs doctor", async () => {
  const w = world();
  await settle(w);
  writeFileSync(path.join(w.repoA, "a.txt"), "edited\n");
  assert.equal((await decide(w)).run, true);
});

test("an untracked file runs doctor", async () => {
  const w = world();
  await settle(w);
  writeFileSync(path.join(w.repoA, "new.txt"), "n\n");
  assert.equal((await decide(w)).run, true);
});

test("a health-exceptions.yml change runs doctor", async () => {
  const w = world();
  await settle(w);
  const t = new Date(Date.now() + 5000);
  utimesSync(w.exc, t, t);
  assert.equal((await decide(w)).run, true);
});

test("a hub config change runs doctor", async () => {
  const w = world();
  await settle(w);
  const t = new Date(Date.now() + 5000);
  utimesSync(w.cfg, t, t);
  assert.equal((await decide(w)).run, true);
});

test("past the ceiling runs doctor even though the fingerprint is unchanged", async () => {
  const w = world();
  await settle(w, DEFAULT_CEILING_MS + 60_000);
  const d = await decide(w);
  assert.equal(d.run, true);
  assert.match(d.reason, /ceiling/);
});

test("just under the ceiling still skips", async () => {
  const w = world();
  await settle(w, DEFAULT_CEILING_MS - 60_000);
  assert.equal((await decide(w)).run, false);
});

test("an error snapshot runs doctor", async () => {
  const w = world();
  const cur = await fp(w);
  const generatedAt = new Date().toISOString();
  writeFileSync(w.snapFile, JSON.stringify({ error: "boom", generatedAt, lastGoodAt: generatedAt, sections: null }));
  await writeFingerprint(w.snapFile, { fingerprint: cur.fingerprint, snapshotGeneratedAt: generatedAt });
  assert.equal((await decide(w)).run, true);
});

test("a missing or corrupt snapshot runs doctor", async () => {
  const w = world();
  assert.equal((await decide(w)).run, true);
  writeFileSync(w.snapFile, "{not json");
  assert.equal((await decide(w)).run, true);
});

test("0 repos: cannot fingerprint, and doctor runs", async () => {
  const w = world();
  await settle(w);
  const bare = path.join(w.root, "not-a-repo");
  mkdirSync(bare);
  const empty = await computeFingerprint({ repos: [], extraFiles: w.extra });
  const noGit = await computeFingerprint({ repos: [bare], extraFiles: w.extra });
  for (const r of [empty, noGit]) {
    assert.equal(r.ok, false);
    assert.match(r.reason, /cannot fingerprint/);
    const d = decideDoctorRun({ snapshot: await readSnapshot(w.snapFile), stored: await readFingerprint(w.snapFile), current: r });
    assert.equal(d.run, true);
    assert.match(d.reason, /cannot fingerprint/);
  }
});

test("a repo whose git call fails is cannot-fingerprint, not silently omitted", async () => {
  const w = world();
  const broken = path.join(w.root, "broken");
  mkdirSync(path.join(broken, ".git"), { recursive: true }); // a .git dir that is not a repo
  const r = await computeFingerprint({ repos: [...w.repos, broken], extraFiles: w.extra });
  assert.equal(r.ok, false);
  assert.match(r.reason, /git failed in 1 repo/);
});

test("an old snapshot with no fingerprint file: read does not crash, doctor runs once", async () => {
  const w = world();
  // The pre-#239 shape: a snapshot and nothing beside it.
  writeFileSync(w.snapFile, JSON.stringify({ generatedAt: new Date().toISOString(), sections: [], totals: {}, problems: 0 }));
  assert.equal(await readFingerprint(w.snapFile), null);
  const d = await decide(w);
  assert.equal(d.run, true);
  assert.match(d.reason, /no stored fingerprint/);
});

test("a corrupt fingerprint file reads as null and runs doctor", async () => {
  const w = world();
  await settle(w);
  writeFileSync(fingerprintPath(w.snapFile), "{{{");
  assert.equal(await readFingerprint(w.snapFile), null);
  assert.equal((await decide(w)).run, true);
});

test("a fingerprint stored for a different snapshot does not authorise a skip", async () => {
  const w = world();
  await settle(w);
  const cur = await fp(w);
  await writeFingerprint(w.snapFile, { fingerprint: cur.fingerprint, snapshotGeneratedAt: "2000-01-01T00:00:00.000Z" });
  assert.equal((await decide(w)).run, true);
});

test("the fingerprint does not write under .git (read-only env, #102)", async () => {
  const w = world();
  const before = execFileSync("ls", ["-la", path.join(w.repoA, ".git")]).toString();
  await fp(w);
  const after = execFileSync("ls", ["-la", path.join(w.repoA, ".git")]).toString();
  assert.equal(after.includes("index.lock"), false);
  assert.equal(before.includes("index.lock"), false);
});

test("the monitor log line with a doctor note still parses", () => {
  const line = '2026-11-10T10:00:00.000Z ran=1 rows=5 actionable=0 notified=0 suppressed=0 ms=900 doctor="skipped (fingerprint unchanged since 2026-11-10T09:00:00.000Z)" run=abc';
  const row = parseMonitorLine(line);
  assert.ok(row);
  assert.match(row.doctor, /^skipped/);
  assert.equal(row.runId, "abc");
  // and the pre-#239 shape
  const old = parseMonitorLine("2026-11-10T10:00:00.000Z ran=1 rows=5 actionable=0 notified=0 suppressed=0 ms=900 run=abc");
  assert.equal(old.doctor, null);
});

test.after(() => {
  // temp dirs are per-test under tmpdir(); nothing shared to clean beyond the OS tmp reaper.
  void rmSync;
});
