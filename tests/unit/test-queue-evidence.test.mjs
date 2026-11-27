/**
 * test-queue-evidence.test.mjs — propagate reads the machine-wide test queue's files and nothing else (#428).
 * Hermetic: every queue directory is a temp dir, every run record a literal fixture, the git repo a temp repo with
 * two commits. The test-queue tool itself is never imported or run here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { checkRunEvidence, glanceLine, noEvidenceRows, queueRows, readRuns, readStatus } from "../../lib/report/test-queue.mjs";
import { collectWaiting, readGate, writeGatePass } from "../../lib/report/waiting.mjs";
import { waitingCmd } from "../../cli/waiting.mjs";
import { glanceCmd } from "../../cli/glance.mjs";
import { isUnread } from "../../lib/core/unread.mjs";

const NOW = Date.UTC(2026, 10, 27, 12, 0, 0);
const tmp = () => mkdtempSync(path.join(tmpdir(), "tq-evidence-"));
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, "-c", "user.email=t@example.test", "-c", "user.name=t", ...a], { encoding: "utf8" }).trim();

/** A temp repo with two commits: returns {dir, first, second}. */
function repo() {
  const dir = tmp();
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(path.join(dir, "a.txt"), "1");
  git(dir, "add", "."); git(dir, "commit", "-q", "-m", "one");
  const first = git(dir, "rev-parse", "HEAD");
  writeFileSync(path.join(dir, "a.txt"), "2");
  git(dir, "commit", "-q", "-am", "two");
  return { dir, first, second: git(dir, "rev-parse", "HEAD") };
}

/** A schema-1 run record as the tool writes it, with overrides. */
const run = (over = {}) => ({
  schema: 1, id: "r1", project: "widgets", head: "f".repeat(40), tree: "e".repeat(40), dirty: false, profile: "gate",
  started_at: NOW - 3600000, exit: 0, signal: null, waited_s: 0, run_s: 120,
  cpu_busy: { start: 10, peak: 40, mean: 34, end: 20 }, load1: { start: 1, peak: 2, mean: 1.5, end: 1 },
  suspect: false, ran_anyway: false, timed_out: false, ...over,
});
function queue({ runs = [], tickets = [], intent = null } = {}) {
  const dir = tmp();
  mkdirSync(path.join(dir, "test-runs"), { recursive: true });
  mkdirSync(path.join(dir, "tickets"), { recursive: true });
  for (const r of runs) writeFileSync(path.join(dir, "test-runs", `${r.id}.json`), JSON.stringify(r, null, 2));
  for (const t of tickets) writeFileSync(path.join(dir, "tickets", String(t.seq)), JSON.stringify(t).padEnd(300, " "));
  if (intent) writeFileSync(path.join(dir, "intent"), JSON.stringify(intent));
  return dir;
}
const snapshot = (dir) => {
  const out = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(`${p}\n${readFileSync(p, "utf8")}`); } };
  walk(dir);
  return out.sort().join("\n--\n");
};
const sink = () => { const o = []; const e = []; return { o, e, out: (s) => o.push(s), err: (s) => e.push(s) }; };
const gate = async (args, inject) => { const s = sink(); const code = await waitingCmd(["gate-pass", ...args], { out: s.out, err: s.err, ...inject }); return { code, text: s.o.join("\n"), errText: s.e.join("\n") }; };

// ── the evidence check ──────────────────────────────────────────────────────

test("evidence: a clean passing run whose head contains the PR head is accepted, even one recorded under load", () => {
  const g = repo();
  for (const peak of [40, 97]) {
    const q = queue({ runs: [run({ id: "ok", head: g.second, cpu_busy: { start: 10, peak, mean: peak, end: 20 } })] });
    const c = checkRunEvidence({ dir: q, runId: "ok", sha: g.first, repoDir: g.dir });
    assert.deepEqual(c.reasons, [], `peak ${peak}`);
    assert.equal(c.ok, true);
  }
});

test("evidence: a failed run is refused", () => {
  const g = repo();
  const q = queue({ runs: [run({ id: "bad", head: g.second, exit: 1 })] });
  const c = checkRunEvidence({ dir: q, runId: "bad", sha: g.first, repoDir: g.dir });
  assert.equal(c.ok, false);
  assert.match(c.reasons.join("\n"), /did not pass \(exit 1\)/);
});

test("evidence: a dirty tree is refused, and so is one that does not say", () => {
  const g = repo();
  const q = queue({ runs: [run({ id: "d", head: g.second, dirty: true }), run({ id: "n", head: g.second, dirty: null })] });
  assert.match(checkRunEvidence({ dir: q, runId: "d", sha: g.first, repoDir: g.dir }).reasons.join("\n"), /dirty/);
  assert.match(checkRunEvidence({ dir: q, runId: "n", sha: g.first, repoDir: g.dir }).reasons.join("\n"), /does not say whether/);
});

test("evidence: a PR head that is NOT an ancestor of the run's head is refused (temp repo, two commits)", () => {
  const g = repo();
  // the run tested the FIRST commit; the PR head is the SECOND, which the run's head does not contain
  const q = queue({ runs: [run({ id: "old", head: g.first })] });
  const c = checkRunEvidence({ dir: q, runId: "old", sha: g.second, repoDir: g.dir });
  assert.equal(c.ok, false);
  assert.match(c.reasons.join("\n"), /not an ancestor of the run's head/);
});

test("evidence: a refused (75) run is refused even if it recorded exit 0 fields", () => {
  const g = repo();
  const q = queue({ runs: [run({ id: "ref", head: g.second, refused: true, exit: 75 })] });
  assert.match(checkRunEvidence({ dir: q, runId: "ref", sha: g.first, repoDir: g.dir }).reasons.join("\n"), /was refused/);
});

test("evidence: an unknown run, a path-shaped id and an unreadable record are refused with a reason", () => {
  const g = repo();
  const q = queue();
  writeFileSync(path.join(q, "test-runs", "junk.json"), "not json {");
  assert.match(checkRunEvidence({ dir: q, runId: "nope", sha: g.first, repoDir: g.dir }).reasons[0], /no run record/);
  assert.match(checkRunEvidence({ dir: q, runId: "../x", sha: g.first, repoDir: g.dir }).reasons[0], /not a run id/);
  assert.match(checkRunEvidence({ dir: q, runId: "junk", sha: g.first, repoDir: g.dir }).reasons[0], /not readable/);
});

// ── the gate-pass command ───────────────────────────────────────────────────

test("gate-pass without --run and without --no-run-evidence exits 1 naming both flags, and writes nothing", async () => {
  const dir = tmp();
  const before = snapshot(dir);
  for (const apply of [[], ["--apply"]]) {
    const r = await gate(["a".repeat(40), "--suite", "s", ...apply], { stateDirPath: dir });
    assert.equal(r.code, 1);
    assert.match(r.errText, /--run/);
    assert.match(r.errText, /--no-run-evidence/);
  }
  assert.equal(snapshot(dir), before);
});

test("gate-pass --no-run-evidence records the reason and still reads as a schema 1 gate; an old record still reads", async () => {
  const dir = tmp();
  const sha = "a".repeat(40);
  const r = await gate([sha, "--suite", "unit 9/9", "--no-run-evidence", "docs only", "--apply"], { stateDirPath: dir, now: NOW });
  assert.equal(r.code, 0);
  assert.deepEqual(readGate(dir, sha).gate, { schema_version: 1, sha, suite: "unit 9/9", passed_at: new Date(NOW).toISOString(), no_run_evidence: "docs only" });
  // a record written before this change: no evidence fields at all
  const old = "b".repeat(40);
  mkdirSync(path.join(dir, "gates"), { recursive: true });
  writeFileSync(path.join(dir, "gates", `${old}.json`), JSON.stringify({ schema_version: 1, sha: old, suite: "old", passed_at: "2026-11-01T00:00:00.000Z" }));
  assert.equal(readGate(dir, old).gate.suite, "old");
});

test("gate-pass --run on a good run records run_id, run_tree and cpu_peak", async () => {
  const g = repo();
  const q = queue({ runs: [run({ id: "ok", head: g.second })] });
  const dir = tmp();
  const r = await gate([g.first, "--suite", "gate", "--run", "ok", "--repo-dir", g.dir, "--apply"], { stateDirPath: dir, queueDir: q, now: NOW });
  assert.equal(r.code, 0, r.errText);
  assert.deepEqual(readGate(dir, g.first).gate, { schema_version: 1, sha: g.first, suite: "gate", passed_at: new Date(NOW).toISOString(), run_id: "ok", run_tree: "e".repeat(40), cpu_peak: 40 });
});

test("gate-pass --run refuses a failed run, a dirty run and a non-ancestor head, each leaving the state dir untouched (snapshot)", async () => {
  const g = repo();
  const q = queue({ runs: [run({ id: "f", head: g.second, exit: 2 }), run({ id: "d", head: g.second, dirty: true }), run({ id: "o", head: g.first })] });
  const dir = tmp();
  writeFileSync(path.join(dir, "keep.txt"), "x");
  const before = snapshot(dir);
  for (const [id, sha] of [["f", g.first], ["d", g.first], ["o", g.second]]) {
    for (const apply of [[], ["--apply"]]) {
      const r = await gate([sha, "--suite", "gate", "--run", id, "--repo-dir", g.dir, ...apply], { stateDirPath: dir, queueDir: q });
      assert.equal(r.code, 1, `${id} ${apply.join("")}`);
      assert.match(r.errText, /does not back a pass/);
    }
  }
  assert.equal(snapshot(dir), before, "a refused pass must not write");
});

test("gate-pass WITHOUT --apply writes nothing even when the evidence is good", async () => {
  const g = repo();
  const q = queue({ runs: [run({ id: "ok", head: g.second })] });
  const dir = tmp();
  const before = snapshot(dir);
  for (const extra of [[], ["--json"]]) {
    const r = await gate([g.first, "--suite", "gate", "--run", "ok", "--repo-dir", g.dir, ...extra], { stateDirPath: dir, queueDir: q });
    assert.equal(r.code, 0);
    assert.match(r.text, /dry run|"applied":false/);
  }
  assert.equal(snapshot(dir), before);
});

// ── the readers ─────────────────────────────────────────────────────────────

test("a missing queue directory is stated, never an empty result", () => {
  const nowhere = path.join(tmp(), "absent");
  const r = readRuns({ dir: nowhere });
  assert.equal(r.present, false);
  assert.match(r.note, /not used on this machine/);
  assert.equal(readStatus({ dir: nowhere }).present, false);
  assert.equal(glanceLine(readStatus({ dir: nowhere })), "test-queue: not used on this machine");
});

test("an unparseable or non-schema-1 record is UNREAD next to the ones that parsed, never dropped or zero", () => {
  const q = queue({ runs: [run({ id: "good" })] });
  writeFileSync(path.join(q, "test-runs", "bad.json"), "not json {");
  writeFileSync(path.join(q, "test-runs", "v2.json"), JSON.stringify({ schema: 2, id: "v2" }));
  const r = readRuns({ dir: q, now: NOW });
  assert.equal(isUnread(r), true);
  assert.equal(r.unreadCount, 2);
  assert.deepEqual(r.runs.map((x) => x.id), ["good"]);
});

test("readRuns keeps only the last N days", () => {
  const q = queue({ runs: [run({ id: "new" }), run({ id: "old", started_at: NOW - 40 * 86400000 })] });
  assert.deepEqual(readRuns({ dir: q, days: 7, now: NOW }).runs.map((x) => x.id), ["new"]);
});

test("glance line: running, queued-not-lock-checked, idle, and unread", () => {
  const t = (seq, state, over = {}) => ({ seq, profile: "gate", project: "widgets", state, created_at: "2026-11-27T11:00:00.000Z", ...over });
  const lines = (tickets, runs = [run({ id: "l" })]) => glanceLine(readStatus({ dir: queue({ tickets, runs }), now: NOW }), NOW);
  assert.equal(lines([t(1, "running", { started_at: new Date(NOW - 12 * 60000).toISOString() }), t(2, "queued"), t(3, "queued"), t(4, "queued")]), "test-queue: gate running 12m (widgets); 3 waiting; last cpu 34%");
  assert.equal(lines([t(1, "queued"), t(2, "queued")]), "test-queue: 2 queued or running (not lock-checked); last cpu 34%");
  assert.equal(lines([], []), "test-queue: idle");
  assert.equal(lines([]), "test-queue: idle; last cpu 34%");
  const q = queue();
  writeFileSync(path.join(q, "tickets", "9"), "not json {");
  assert.match(glanceLine(readStatus({ dir: q, now: NOW }), NOW), /could not read part of the queue/);
});

test("glance prints the test-queue line as its last line, and reads none when a state dir is injected without a queue", async () => {
  const q = queue({ tickets: [{ seq: 1, profile: "gate", project: "widgets", state: "running", started_at: new Date(NOW - 5 * 60000).toISOString() }] });
  const withQ = sink();
  await glanceCmd(["--no-write"], { stateDirPath: tmp(), now: NOW, queueDir: q, out: withQ.out, err: withQ.err, color: false });
  assert.equal(withQ.o.at(-1), "test-queue: gate running 5m (widgets); 0 waiting");
  const without = sink();
  await glanceCmd(["--no-write"], { stateDirPath: tmp(), now: NOW, out: without.out, err: without.err, color: false });
  assert.ok(!without.o.some((l) => l.startsWith("test-queue:")));
});

// ── the waiting rows ────────────────────────────────────────────────────────

const noGh = () => ({ status: 0, stdout: "[]", stderr: "" });
const ghFake = (args) => (args[0] === "repo" ? { status: 0, stdout: JSON.stringify({ defaultBranchRef: { name: "main" } }), stderr: "" } : noGh());

test("waiting rows: a suspect failure answers lane, a refused run answers defer, a pass under load and a pass with no evidence are not suspect, no-evidence gates answer approve", () => {
  const q = queue({ runs: [
    run({ id: "s", exit: 1, suspect: true, cpu_busy: { start: 50, peak: 91, mean: 80, end: 70 } }),
    run({ id: "r", exit: 75, refused: true }),
    run({ id: "p", cpu_busy: { start: 50, peak: 99, mean: 95, end: 70 } }),
    run({ id: "oldfail", exit: 1, suspect: true, started_at: NOW - 20 * 86400000 }),
  ] });
  const dir = tmp();
  writeGatePass(dir, "c".repeat(40), "gate", NOW, { no_run_evidence: "docs only" });
  writeGatePass(dir, "d".repeat(40), "gate", NOW, { run_id: "p", run_tree: "e".repeat(40), cpu_peak: 99 });
  const r = collectWaiting({ gh: ghFake, repos: ["acme/widgets"], reviewsRoot: null, stateDirPath: dir, queueDirPath: q, now: NOW });
  assert.deepEqual(r.errors, []);
  const byWhat = (re) => r.rows.filter((x) => re.test(x.what));
  assert.equal(byWhat(/suspect failure/).length, 1, "the 20-day-old failure is outside the 7-day window");
  assert.equal(byWhat(/suspect failure/)[0].answer, "lane");
  assert.match(byWhat(/suspect failure/)[0].recommendation, /re-run it quietly/);
  assert.equal(byWhat(/refused run/).length, 1);
  assert.equal(byWhat(/refused run/)[0].answer, "defer");
  const g = r.rows.filter((x) => x.kind === "gate-pass");
  assert.equal(g.length, 1, "only the pass with no run evidence");
  assert.equal(g[0].answer, "approve");
  assert.match(g[0].what, /docs only/);
  assert.equal(r.rows.length, 3, "a passing run under load adds no row");
  assert.deepEqual(queueRows(readRuns({ dir: q, days: 7, now: NOW })).map((x) => x.answer).sort(), ["defer", "lane"]);
  assert.equal(noEvidenceRows(dir, { now: NOW }).rows.length, 1);
});

test("waiting: an unreadable run record is an error (exit 2 path), not an empty section; a missing queue is a named source", () => {
  const q = queue({ runs: [run({ id: "good" })] });
  writeFileSync(path.join(q, "test-runs", "bad.json"), "not json {");
  const bad = collectWaiting({ gh: ghFake, repos: ["acme/widgets"], reviewsRoot: null, stateDirPath: tmp(), queueDirPath: q, now: NOW });
  assert.match(bad.errors.join("\n"), /test-queue: .*did not parse/);
  const none = collectWaiting({ gh: ghFake, repos: ["acme/widgets"], reviewsRoot: null, stateDirPath: tmp(), queueDirPath: path.join(tmp(), "absent"), now: NOW });
  assert.deepEqual(none.errors, []);
  assert.ok(none.sources.some((s) => /test-queue \(test-queue not used on this machine\)/.test(s)));
});

test("waiting reads the queue only when asked: collectWaiting without queueDirPath reads none", () => {
  const r = collectWaiting({ gh: ghFake, repos: ["acme/widgets"], reviewsRoot: null, stateDirPath: tmp() });
  assert.ok(!r.sources.some((s) => /test-queue/.test(s)));
});

// ── outcome: exit 0 is not a pass when the run recorded failures (#428 E7) ─────────────────────────────────────

test("evidence: a masked run (exit 0, outcome fail, exit_masked) is refused, and the reason names the cause", () => {
  const g = repo();
  const q = queue({ runs: [run({ id: "m", head: g.second, exit: 0, outcome: "fail", exit_masked: true, failures: [{ name: "a" }, { name: "b" }] })] });
  const c = checkRunEvidence({ dir: q, runId: "m", sha: g.first, repoDir: g.dir });
  assert.equal(c.ok, false);
  assert.match(c.reasons.join("\n"), /exit 0 is masked: 2 failures recorded/);
});

test("evidence: a recorded failure with exit 0 is refused even without outcome or exit_masked", () => {
  const g = repo();
  const q = queue({ runs: [run({ id: "f", head: g.second, exit: 0, failures: [{ name: "a" }] })] });
  assert.match(checkRunEvidence({ dir: q, runId: "f", sha: g.first, repoDir: g.dir }).reasons.join("\n"), /masked: 1 failure recorded/);
});

test("evidence: outcome fail alone, and exit_masked alone, are each refused", () => {
  const g = repo();
  const q = queue({ runs: [run({ id: "o", head: g.second, outcome: "fail" }), run({ id: "x", head: g.second, exit_masked: true })] });
  assert.match(checkRunEvidence({ dir: q, runId: "o", sha: g.first, repoDir: g.dir }).reasons.join("\n"), /masked: outcome "fail"/);
  assert.match(checkRunEvidence({ dir: q, runId: "x", sha: g.first, repoDir: g.dir }).reasons.join("\n"), /flagged its exit code as masked/);
});

test("evidence: an old record without outcome passes on exit 0; outcome pass with empty failures passes", () => {
  const g = repo();
  const q = queue({ runs: [run({ id: "old", head: g.second }), run({ id: "new", head: g.second, outcome: "pass", exit_masked: false, failures: [] })] });
  for (const id of ["old", "new"]) assert.equal(checkRunEvidence({ dir: q, runId: id, sha: g.first, repoDir: g.dir }).ok, true, id);
});

// ── load-sensitive.json rows ────────────────────────────────────────────────────────────────────────────────────

const lsEntry = (project, daysAgo) => ({ project, file: "t.test.mjs", name: "waits", first_seen: NOW - 30 * 86400000, last_seen: NOW - daysAgo * 86400000, count: 3, loads: [90], line: 4, runs: ["r1"] });
const lsRows = (q) => collectWaiting({ gh: ghFake, repos: ["acme/widgets"], reviewsRoot: null, stateDirPath: tmp(), queueDirPath: q, now: NOW });

test("load-sensitive: a project with recent entries gets one lane row with the count", () => {
  const q = queue();
  writeFileSync(path.join(q, "load-sensitive.json"), JSON.stringify({ entries: [lsEntry("widgets", 1), lsEntry("widgets", 13), lsEntry("gadgets", 2)] }));
  const r = lsRows(q);
  const rows = r.rows.filter((x) => /load-sensitive/.test(x.what));
  assert.deepEqual(rows.map((x) => x.what), [
    "gadgets: 1 load-sensitive test; tag them in the project's test vocabulary and file one fix issue (usually a wall-clock wait)",
    "widgets: 2 load-sensitive tests; tag them in the project's test vocabulary and file one fix issue (usually a wall-clock wait)",
  ]);
  assert.ok(rows.every((x) => x.answer === "lane"));
  assert.deepEqual(r.errors, []);
});

test("load-sensitive: an entry last seen more than 14 days ago gives no row; a missing file gives none", () => {
  const q = queue();
  writeFileSync(path.join(q, "load-sensitive.json"), JSON.stringify({ entries: [lsEntry("widgets", 15)] }));
  assert.deepEqual(lsRows(q).rows.filter((x) => /load-sensitive/.test(x.what)), []);
  assert.deepEqual(lsRows(queue()).rows, []);
});

test("load-sensitive: an unreadable file is an unread row naming the file, never silence", () => {
  const q = queue();
  writeFileSync(path.join(q, "load-sensitive.json"), "not json {");
  const rows = lsRows(q).rows.filter((x) => /load-sensitive/.test(x.what));
  assert.equal(rows.length, 1);
  assert.match(rows[0].what, /unread/);
  assert.ok(rows[0].what.includes(path.join(q, "load-sensitive.json")));
});
