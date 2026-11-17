/**
 * glance.test.mjs — propagate#295 (glance PR2): signals, verdicts, the line, the glance.json contract, exit codes.
 *
 * Test ids follow the glance test plan (T-V, T-O). Every fixture is a LITERAL file written into a temp state dir:
 * never built through lib/glance (rule:mutate-behind-the-fixture-builder), and every name is synthetic (public repo).
 *
 * Run: PROPAGATE_STATE_DIR="$(mktemp -d)" node --test tests/unit/glance.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { dailyVerdict, utcDay, median } from "../../lib/glance/verdict.mjs";
import { SIGNALS, fillFix } from "../../lib/glance/signals.mjs";
import { computeGlance, runGlance, exitCodeOf } from "../../lib/glance/compute.mjs";
import { renderLines, MAX_LINE, shouldColor, sourceGroups } from "../../lib/glance/render.mjs";
import { readGlance, writeGlance, glancePath, SCHEMA_VERSION, readGlanceState } from "../../lib/glance/store.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const H = 3600000;
const D = 24 * H;
const NOW = Date.parse("2026-11-16T12:00:00Z");
const iso = (ms) => new Date(ms).toISOString();

const fresh = () => mkdtempSync(path.join(tmpdir(), "glance-"));
const put = (dir, rel, text) => {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), text);
};
const doctorJson = ({ at = NOW - H, sections } = {}) => ({
  generatedAt: iso(at),
  problems: 0,
  sections: sections ?? [{ name: "State", entries: [{ kind: "pass", label: "ledger readable", detail: "" }] }],
});
const monitorLine = (ms, extra = "") => `${iso(ms)} ran=1 rows=10 actionable=0 notified=0 suppressed=0 ms=50${extra}\n`;
/** A healthy vN-1 state dir: a doctor snapshot, a monitor log with runs on each of the last 8 days, metrics. */
function healthy(dir = fresh()) {
  put(dir, "doctor-snapshot.json", JSON.stringify(doctorJson()));
  let log = "";
  for (let d = 7; d >= 0; d--) log += monitorLine(NOW - d * D - 30 * 60000);
  put(dir, "monitor.log", log);
  let m = "";
  for (let d = 7; d >= 0; d--) m += JSON.stringify({ ts: iso(NOW - d * D - H), run_id: `r${d}`, metrics: { "doctor.problems": 0 } }) + "\n";
  put(dir, "metrics.jsonl", m);
  return dir;
}
const rows = (states) => states.map((state, i) => ({ edge_id: `e${i}`, state }));
const bySignal = (g, s) => g.items.filter((i) => i.signal === s);

// ── the verdict rule ────────────────────────────────────────────────────────

const series = (counts, today = "2026-11-16") => {
  const days = [];
  const map = new Map();
  counts.forEach((c, i) => {
    const day = utcDay(Date.parse(`${today}T00:00:00Z`) - (counts.length - 1 - i) * D);
    days.push(day);
    map.set(day, c);
  });
  return { counts: map, dataDays: days, today };
};

test("T-V5 median rule: seven zero days then 3 today is broken; then 2 today is working", () => {
  assert.equal(dailyVerdict(series([0, 0, 0, 0, 0, 0, 0, 3])).state, "broken");
  assert.equal(dailyVerdict(series([0, 0, 0, 0, 0, 0, 0, 2])).state, "working");
  // more than twice the median AND at least 3: median 2, today 4 is not more than twice
  assert.equal(dailyVerdict(series([2, 2, 2, 2, 0, 0, 0, 4]), { chronic: false }).state, "working");
  assert.equal(dailyVerdict(series([2, 2, 2, 2, 0, 0, 0, 5]), { chronic: false }).state, "broken");
  assert.equal(median([1, 3, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

test("T-V6 chronic rule: failures on 3 consecutive data days are broken whatever the median", () => {
  assert.equal(dailyVerdict(series([5, 5, 5, 5, 5, 5, 5, 5])).state, "broken");
  assert.equal(dailyVerdict(series([0, 0, 0, 0, 0, 5, 5, 5])).state, "broken");
  assert.equal(dailyVerdict(series([0, 0, 0, 0, 5, 5, 0, 1])).state, "working", "a gap breaks the run");
});

test("T-V4 learning: fewer than 3 prior days of history is learning, never broken, and says how far along", () => {
  const v = dailyVerdict(series([9, 9, 9]));
  assert.equal(v.state, "learning");
  assert.equal(v.have, 2);
  assert.equal(v.need, 3);
});

test("a day with no data is a no-data day, not 0: the median is over the days that exist", () => {
  // three data days, then today, with gaps between them that must not read as zeros
  const counts = new Map([["2026-11-01", 4], ["2026-11-05", 4], ["2026-11-10", 4], ["2026-11-16", 5]]);
  const v = dailyVerdict({ counts, dataDays: [...counts.keys()], today: "2026-11-16" }, { chronic: false });
  assert.equal(v.median, 4);
  assert.equal(v.state, "working");
});

test("days are UTC: a row at 23:59Z belongs to that UTC day", () => {
  assert.equal(utcDay(Date.parse("2026-11-30T23:59:00Z")), "2026-11-30");
});

// ── heartbeat staleness, event logs, unreadable sources ──────────────────────

test("T-V1 doctor snapshot staleness is 26 h: 25 h 59 m is fresh, 26 h 1 m is unknown; 24 h 10 m is not unknown", () => {
  for (const [ageMs, unknown] of [[26 * H - 60000, false], [26 * H + 60000, true], [24 * H + 10 * 60000, false]]) {
    const dir = healthy();
    put(dir, "doctor-snapshot.json", JSON.stringify(doctorJson({ at: NOW - ageMs })));
    const g = computeGlance({ dir, now: NOW }).glance;
    assert.equal(bySignal(g, "doctor")[0].flag === "unknown", unknown, `age ${ageMs / H} h`);
  }
});

test("T-V1 monitor.log staleness is 3 x 1800 s", () => {
  for (const [ageMs, unknown] of [[5400000 - 60000, false], [5400000 + 60000, true]]) {
    const dir = healthy();
    put(dir, "monitor.log", monitorLine(NOW - ageMs));
    const g = computeGlance({ dir, now: NOW }).glance;
    assert.equal(bySignal(g, "monitor")[0].flag === "unknown", unknown, `age ${ageMs / 60000} min`);
  }
});

test("T-V2 a missing or empty event log is 0 events: working, never unknown", () => {
  const dir = healthy();
  let g = computeGlance({ dir, now: NOW }).glance;
  for (const s of ["hooks", "guard"]) {
    const [it] = bySignal(g, s);
    assert.equal(it.verdict, "working", s);
    assert.equal(it.flag, null, s);
    assert.equal(it.looked_at, 0, s);
  }
  put(dir, "costs/errors.log", "");
  put(dir, `guard/${utcDay(NOW).slice(0, 7)}.jsonl`, "");
  g = computeGlance({ dir, now: NOW }).glance;
  assert.equal(bySignal(g, "hooks")[0].verdict, "working");
  assert.equal(bySignal(g, "guard")[0].verdict, "working");
});

test("T-V3 an unreadable source is unknown, never working: corrupt snapshot, error-object snapshot", () => {
  const dir = healthy();
  put(dir, "doctor-snapshot.json", "{not json");
  let [it] = bySignal(computeGlance({ dir, now: NOW }).glance, "doctor");
  assert.equal(it.flag, "unknown");
  assert.equal(it.verdict, "broken", "an unreadable source sits in Broken");
  assert.match(it.line, /^\? Unknown doctor: cannot read/);
  put(dir, "doctor-snapshot.json", JSON.stringify({ error: "spawn failed", generatedAt: iso(NOW - H), lastGoodAt: iso(NOW - 5 * H), sections: null }));
  [it] = bySignal(computeGlance({ dir, now: NOW }).glance, "doctor");
  assert.equal(it.flag, "unknown");
  assert.match(it.why, /last good 5h ago, latest failed: spawn failed/);
});

test("T-V7 hook errors: skipped trace lines are not failures; one real error line is one failure", () => {
  const dir = healthy();
  const t = iso(NOW - H);
  put(dir, "costs/errors.log", `${t} subagent-cost: internal agent a1 skipped: no agent_type, no transcript; no row written\n`.repeat(9));
  let [it] = bySignal(computeGlance({ dir, now: NOW }).glance, "hooks");
  assert.equal(it.failures_today, 0);
  put(dir, "costs/errors.log", `${t} subagent-cost: internal agent a1 skipped: no agent_type, no transcript; no row written\n${t} subagent-cost: unparseable stdin payload: x\n`);
  [it] = bySignal(computeGlance({ dir, now: NOW }).glance, "hooks");
  assert.equal(it.failures_today, 1);
});

test("one-day-old guard log is learning, not broken", () => {
  const dir = healthy();
  const deny = (ms, hash) => JSON.stringify({ ts: iso(ms), session: "s1", event: "deny", rule: "heavy", label: "npm test", program: "npm", command_hash: hash, timeout_ms: 120000 });
  // a fresh install: no monitor history, so the only data days are the guard log's own
  put(dir, "monitor.log", monitorLine(NOW - 60000));
  put(dir, `guard/${utcDay(NOW).slice(0, 7)}.jsonl`, [deny(NOW - H, "a"), deny(NOW - 2 * H, "b"), deny(NOW - 3 * H, "c")].join("\n") + "\n");
  const [it] = bySignal(computeGlance({ dir, now: NOW }).glance, "guard");
  assert.equal(it.flag, "learning");
  assert.equal(it.verdict, "working");
  assert.match(it.line, /learning, \d of 3 days/);
});

test("guard: a deny followed by an allow-bg of the same command is 'rule followed', not a failure", () => {
  const dir = healthy();
  const row = (ms, event, hash) => JSON.stringify({ ts: iso(ms), session: "s1", event, rule: "heavy", label: "npm test", program: "npm", command_hash: hash, timeout_ms: 120000 });
  const lines = [];
  for (let d = 7; d >= 1; d--) lines.push(row(NOW - d * D, "deny", `h${d}`), row(NOW - d * D + 60000, "allow-bg", `h${d}`));
  lines.push(row(NOW - 3 * H, "deny", "x"), row(NOW - 3 * H + 60000, "allow-bg", "x"));
  for (const m of new Set([utcDay(NOW - 7 * D).slice(0, 7), utcDay(NOW).slice(0, 7)])) put(dir, `guard/${m}.jsonl`, "");
  for (const l of lines) {
    const f = path.join(dir, "guard", `${JSON.parse(l).ts.slice(0, 7)}.jsonl`);
    writeFileSync(f, (existsSync(f) ? readFileSync(f, "utf8") : "") + l + "\n");
  }
  const [it] = bySignal(computeGlance({ dir, now: NOW }).glance, "guard");
  assert.equal(it.verdict, "working");
  assert.equal(it.failures_today, 0);
});

// ── edges, jobs, doctor markers, parked work ────────────────────────────────

test("T-V8 edges come from the caller's rows through actionOf: blocked/judge are working, broken states are broken; the population is named", () => {
  const dir = healthy();
  const g = computeGlance({ dir, now: NOW, rows: rows(["CLEAN", "DRIFTED", "DIVERGED", "UNMATCHED", "UNRESOLVABLE", "DEFERRED", "NEVER_VERIFIED"]) }).glance;
  const broken = bySignal(g, "edges").find((i) => i.verdict === "broken");
  assert.equal(broken.count, 2);
  assert.match(broken.line, /2 broken of 7 reconciled/);
  assert.ok(bySignal(g, "edges").some((i) => i.verdict === "working"));
  // only parked/never-judged: nothing broken, still a positive observation
  const g2 = computeGlance({ dir, now: NOW, rows: rows(["CLEAN", "DRIFTED"]) }).glance;
  assert.deepEqual(bySignal(g2, "edges").map((i) => i.verdict), ["working"]);
});

test("edges with no rows from the caller carry the previous glance's edges items, never re-reconcile", () => {
  const dir = healthy();
  const first = computeGlance({ dir, now: NOW, rows: rows(["UNMATCHED"]) }).glance;
  writeGlance(first, dir);
  const again = computeGlance({ dir, now: NOW + 60000, previous: readGlance(dir) }).glance;
  const e = bySignal(again, "edges")[0];
  assert.equal(e.verdict, "broken");
  assert.equal(e.carried, true);
  const none = computeGlance({ dir: healthy(), now: NOW }).glance;
  assert.equal(bySignal(none, "edges")[0].flag, "unknown");
});

test("T-V9 jobs: a warned job is broken, a clean scheduled-jobs section is working; a live pid is not a failure (scheduled-jobs.mjs)", () => {
  const dir = healthy();
  const jobsSection = (entries) => ({ name: "Scheduled jobs", entries });
  const info = { kind: "info", label: "scheduled jobs", detail: "2 job(s) run this tree's code, 1 warned" };
  const doc = doctorJson({ sections: [{ name: "State", entries: [{ kind: "pass", label: "ok", detail: "" }] }, jobsSection([
    { kind: "warn", label: "scheduled job needs attention", detail: "job.alpha: last exit code 1 (state not running)", check_id: "jobs.job.alpha" },
    { kind: "note", label: "job.beta: state running, pid 42, runs 3, last exit 1", detail: "" },
    info,
  ])] });
  const g = computeGlance({ dir, now: NOW, doctor: doc }).glance;
  const jobs = bySignal(g, "jobs");
  const bad = jobs.find((i) => i.verdict === "broken");
  assert.equal(bad.id, "job:job.alpha");
  assert.match(bad.line, /^x Broken job job\.alpha: /);
  assert.equal(jobs.filter((i) => i.verdict === "broken").length, 1, "the running job with a past non-zero exit is not broken");
  const clean = computeGlance({ dir, now: NOW, doctor: doctorJson({ sections: [jobsSection([info])] }) }).glance;
  assert.deepEqual(bySignal(clean, "jobs").map((i) => i.verdict), ["working"]);
  const src = readdirSync(path.join(ROOT, "lib", "glance")).map((f) => readFileSync(path.join(ROOT, "lib", "glance", f), "utf8")).join("\n");
  assert.doesNotMatch(src, /\b(com|dev|org)\.[a-z]+\.[a-z]/, "no launchd label is written in lib/glance");
});

test("T-D2 a doctor fail with the human marker is needs-you; a fail without it is broken", () => {
  const dir = healthy();
  const doc = doctorJson({ sections: [{ name: "Auth", entries: [
    { kind: "fail", label: "token expires in 3 days", detail: "", human: true, check_id: "auth.token" },
    { kind: "fail", label: "ledger has 4 malformed rows", detail: "" },
    { kind: "pass", label: "ok", detail: "" },
  ] }] });
  const g = computeGlance({ dir, now: NOW, doctor: doc }).glance;
  const human = g.items.find((i) => i.id === "doctor:auth:auth.token");
  assert.equal(human.verdict, "needs_you");
  assert.deepEqual(g.needs_you_ids, ["doctor:auth:auth.token"]);
  const plain = g.items.find((i) => i.signal === "doctor" && i.verdict === "broken");
  assert.equal(plain.id, "doctor:auth:ledger-has-n-malformed-rows", "an id never carries a number from the label");
});

test("#312 a doctor fail's `what` is its detail (a sentence) when it has one, its message next, its label only last", () => {
  const dir = healthy();
  const fail = (extra) => ({ kind: "fail", label: "instructions.over_ceiling == 0", ...extra });
  const doc = doctorJson({ sections: [{ name: "Metrics", entries: [
    fail({ check_id: "a", detail: "4 directories are over the instruction budget (largest +2,631)", message: "ignored when detail exists" }),
    fail({ check_id: "b", detail: "  ", message: "message wins over the label" }),
    fail({ check_id: "c" }),
  ] }] });
  const items = computeGlance({ dir, now: NOW, doctor: doc }).glance.items.filter((i) => i.signal === "doctor");
  const what = (id) => items.find((i) => i.id === `doctor:metrics:${id}`).what;
  assert.equal(what("a"), "4 directories are over the instruction budget (largest +2,631)");
  assert.equal(what("b"), "message wins over the label");
  assert.equal(what("c"), "instructions.over_ceiling == 0", "the label is the fallback only");
});

test("#312 doctorWhat keeps only the detail's first clause (before ' \u2014 '); a detail with no separator is kept whole", () => {
  const dir = healthy();
  const fail = (extra) => ({ kind: "fail", label: "docs.supersedes-unresolvable-n <= 0", ...extra });
  const doc = doctorJson({ sections: [{ name: "Metrics", entries: [
    fail({ check_id: "a", detail: "12 supersedes: target(s) do not resolve \u2014 observed 12 \u2014 A declared `supersedes:` naming a path" }),
    fail({ check_id: "b", detail: "no separator here, hyphen-ated - and dashes" }),
    fail({ check_id: "c", message: "msg first clause \u2014 rationale" }),
  ] }] });
  const items = computeGlance({ dir, now: NOW, doctor: doc }).glance.items.filter((i) => i.signal === "doctor");
  const what = (id) => items.find((i) => i.id === `doctor:metrics:${id}`).what;
  assert.equal(what("a"), "12 supersedes: target(s) do not resolve");
  assert.equal(what("b"), "no separator here, hyphen-ated - and dashes");
  assert.equal(what("c"), "msg first clause");
});

test("parked work is needs-you, from the work queue's parked state", async () => {
  const dir = healthy();
  const { enqueue, claim, release } = await import("../../lib/work/queue.mjs");
  const { item } = enqueue({ kind: "synthetic-kind", scope: "acme/x", dedupe_key: "k1", payload: {} }, { stateDirPath: dir });
  for (let i = 0; i < 2; i++) {
    const c = claim({ kind: "synthetic-kind", session: "s" }, { stateDirPath: dir });
    release(c.id, { session: "s", token: c.token, refusal: true }, { stateDirPath: dir });
  }
  const g = computeGlance({ dir, now: Date.now() }).glance;
  const parked = bySignal(g, "work").find((i) => i.verdict === "needs_you");
  assert.ok(parked, JSON.stringify(bySignal(g, "work")));
  assert.equal(parked.id, `work:${item.id}`);
  // no store at all: the signal is skipped with its reason, never a silent pass and never unknown
  const g2 = computeGlance({ dir: healthy(), now: NOW }).glance;
  assert.deepEqual(bySignal(g2, "work"), []);
  assert.ok(g2.skipped.some((s) => s.signal === "work" && /no store/.test(s.reason)));
});

// ── T-V10 inputs come from the caller ───────────────────────────────────────

test("T-V10 the compute never imports reconcile, doctor or gh, and never spawns a process", () => {
  const files = readdirSync(path.join(ROOT, "lib", "glance"));
  assert.ok(files.length >= 5, `only ${files.length} files in lib/glance: the scan has gone blind`);
  for (const f of files) {
    const src = readFileSync(path.join(ROOT, "lib", "glance", f), "utf8");
    for (const bad of [/reconcile/, /child_process/, /\bgh\b.*import|import.*\/gh\.mjs/, /core\/config\.mjs/, /doctor\/snapshot\.mjs/, /monitor\.mjs/]) {
      const hit = src.split("\n").filter((l) => /^\s*import|await import/.test(l)).find((l) => bad.test(l));
      assert.equal(hit, undefined, `${f} imports ${hit}`);
    }
  }
});

// ── T-V11 / T-V12 static fix text, no bare numbers ──────────────────────────

test("T-V11 every signal declares question, reader, failure and fix templates; fix text is never generated", () => {
  assert.ok(SIGNALS.length >= 9, `only ${SIGNALS.length} signals: the scan has gone blind`);
  for (const s of SIGNALS) {
    for (const k of ["name", "kind", "question", "reader", "failure", "fix"]) assert.ok(s[k], `${s.name} lacks ${k}`);
    assert.ok(["heartbeat", "event log"].includes(s.kind), s.name);
    for (const [key, f] of Object.entries(s.fix)) {
      assert.equal(typeof f.text, "string", `${s.name}.${key}`);
      assert.ok(f.text.length > 0 && f.text.length <= 36, `${s.name}.${key} fix text over 36 characters: ${f.text}`);
    }
  }
  assert.throws(() => fillFix("doctor", "working", {}), /slot/, "a missing slot throws, it is never invented");
});

test("T-V12 no bare numbers: every rendered line carries a verdict word, and every item a fix and a why", () => {
  const dir = healthy();
  put(dir, "costs/errors.log", Array.from({ length: 8 }, (_, d) => `${iso(NOW - d * D - H)} subagent-cost: unparseable stdin payload: x\n`).join(""));
  const g = computeGlance({ dir, now: NOW, rows: rows(["UNMATCHED", "CLEAN"]), doctor: doctorJson({ sections: [{ name: "A", entries: [{ kind: "fail", label: "x 3 rows", detail: "" }] }] }) }).glance;
  const lines = renderLines(g, { now: NOW });
  assert.ok(lines.length >= 2);
  const VERDICT = /\b(NEEDS YOU|BROKEN|UNKNOWN|LEARNING|OK|Needs you|Broken|Unknown|Working|learning|more)\b/;
  for (const l of lines) if (/\d/.test(l)) assert.match(l, VERDICT, `bare number: ${l}`);
  for (const it of g.items) {
    assert.ok(it.fix && it.fix.text, `${it.id} has no fix`);
    assert.ok(it.why, `${it.id} has no why`);
    assert.match(it.why, /because .*; next: /, `${it.id}: ${it.why}`);
  }
});

// ── the line: grammar, ordering, caps, all clear ────────────────────────────

test("line grammar: <icon> <subject>: <what> · <fix>, at most 80 characters, free text clipped", () => {
  const dir = healthy();
  const long = "a very long doctor label ".repeat(10);
  const g = computeGlance({ dir, now: NOW, doctor: doctorJson({ sections: [{ name: "S", entries: [{ kind: "fail", label: long, detail: "" }] }] }) }).glance;
  for (const it of g.items) {
    assert.ok(it.line.length <= MAX_LINE, `${it.line.length}: ${it.line}`);
    assert.match(it.line, /^(! Needs you|x Broken|\? Unknown|ok Working) [^:]+: .* · \S/);
  }
  for (const l of renderLines(g, { now: NOW })) assert.ok(l.length <= MAX_LINE, l);
});

/** A doctor JSON with `fails` failing checks and `jobs` warned scheduled jobs, written as literals. */
const doctorWith = ({ fails = 0, human = 0, jobs = 0 } = {}) => doctorJson({ sections: [
  { name: "Checks", entries: [
    ...Array.from({ length: fails }, (_, i) => ({ kind: "fail", label: ["rules can still load", "docs.supersedes == 0", "gotchas.untriaged <= 9", "decisions.with_tokens", "instructions.over == 0", "ledger rows readable"][i % 6] + ` ${i}`, detail: "" })),
    ...Array.from({ length: human }, (_, i) => ({ kind: "fail", label: `token expires ${i}`, detail: "", human: true, check_id: `auth.t${i}` })),
    { kind: "pass", label: "ok", detail: "" },
  ] },
  { name: "Scheduled jobs", entries: [
    ...Array.from({ length: jobs }, (_, i) => ({ kind: "warn", label: "scheduled job needs attention", detail: `job.n${i}: last exit code 1 (state not running)`, check_id: `jobs.job.n${i}` })),
    { kind: "info", label: "scheduled jobs", detail: `${jobs} job(s) run this tree's code` },
  ] },
] });

test("ONE LINE PER SOURCE: 6 doctor fails and 3 job fails render as 2 lines, and jobs are visible however many doctor fails", () => {
  const g = computeGlance({ dir: healthy(), now: NOW, rows: rows(["CLEAN"]), doctor: doctorWith({ fails: 6, jobs: 3 }) }).glance;
  assert.equal(g.items.filter((i) => i.verdict === "broken").length, 9, "the items array keeps the per-item detail");
  const lines = renderLines(g);
  const problems = lines.filter((l) => /^\[(NEEDS YOU|BROKEN|UNKNOWN)\]/.test(l));
  assert.equal(problems.length, 2, lines.join("\n"));
  assert.match(problems[0], /^\[BROKEN\] +jobs: 3 jobs failing \(last exit code 1\) · /, "jobs (user-impacting) come before doctor");
  assert.match(problems[1], /^\[BROKEN\] +doctor: 6 checks failing \(rules, docs[^)]*\) · propagate doctor --full$/);
  // many doctor fails never push jobs off the 5-line cap
  const many = computeGlance({ dir: healthy(), now: NOW, rows: rows(["CLEAN"]), doctor: doctorWith({ fails: 40, jobs: 3 }) }).glance;
  assert.ok(renderLines(many).some((l) => /^\[BROKEN\] +jobs: /.test(l)), renderLines(many).join("\n"));
});

test("ordering and caps: needs-you sources first; the cap counts sources; working is one OK line", () => {
  const dir = healthy();
  put(dir, "monitor.log", monitorLine(NOW - 60000, ' error="boom"'));
  const g = computeGlance({ dir, now: NOW, rows: rows(["UNMATCHED", "UNMATCHED", "UNMATCHED", "CLEAN"]), doctor: doctorWith({ fails: 6, human: 1, jobs: 2 }) }).glance;
  const lines = renderLines(g, { cap: 2 });
  assert.match(lines[0], /^\[NEEDS YOU\] doctor: 1 check needs you, 6 failing/, lines.join("\n"));
  assert.match(lines[1], /^\[BROKEN\] +jobs: /);
  assert.match(lines[2], /^\+2 more sources: propagate glance --json$/, "monitor and edges are counted as sources, not items");
  assert.equal(lines.filter((l) => /^\[OK\]/.test(l)).length, 1);
  assert.deepEqual(sourceGroups(g.items).map((x) => x.signal), ["doctor", "jobs", "monitor", "edges"]);
});

test("the 80-character rule holds with no mid-word cut, in the source lines and the item lines", () => {
  const words = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau";
  const doc = doctorJson({ sections: [{ name: "S", entries: [
    ...words.split(" ").map((w) => ({ kind: "fail", label: `${w}word.check ${words}`, detail: "" })),
  ] }] });
  const dir = healthy();
  put(dir, "monitor.log", monitorLine(NOW - 60000, ` error=${JSON.stringify(words + " " + words)}`));
  const g = computeGlance({ dir, now: NOW, rows: rows(["CLEAN"]), doctor: doc }).glance;
  // Every word left before a "…" must be a WHOLE word of the source text: a cut word would be a fragment of one.
  const vocab = new Set(g.items.flatMap((i) => `${i.what} ${i.subject} ${i.fix.text}`.split(/[^\w-]+/)).concat(words.split(" ")));
  for (const l of [...renderLines(g), ...g.items.map((i) => i.line)]) {
    assert.ok(l.length <= MAX_LINE, `${l.length}: ${l}`);
    for (const m of l.matchAll(/([\w-]+)…/g)) assert.ok(vocab.has(m[1]), `mid-word cut "${m[0]}" in: ${l}`);
  }
  assert.ok(renderLines(g).some((l) => /…\) · /.test(l)), "subjects that do not fit are dropped and marked …");
});

test("badges: colour gives escape codes; NO_COLOR, --no-color and a non-TTY give plain [BROKEN] with no escape byte", () => {
  const g = computeGlance({ dir: healthy(), now: NOW, rows: rows(["UNMATCHED", "CLEAN"]) }).glance;
  const colored = renderLines(g, { color: true }).join("\n");
  assert.match(colored, /\x1b\[/, "colour on: escape codes");
  assert.match(colored, /\x1b\[41m/, "BROKEN is on red");
  const plain = renderLines(g, { color: false }).join("\n");
  assert.doesNotMatch(plain, /\x1b/);
  assert.match(plain, /^\[BROKEN\] {4}edges: /m);
  const tty = { isTTY: true };
  assert.equal(shouldColor({ stream: tty, env: {} }), true);
  assert.equal(shouldColor({ stream: tty, env: { NO_COLOR: "1" } }), false);
  assert.equal(shouldColor({ stream: tty, env: {}, argv: ["--no-color"] }), false);
  assert.equal(shouldColor({ stream: { isTTY: false }, env: {} }), false, "piped output is never coloured");
  assert.equal(shouldColor({ stream: { isTTY: false }, env: { FORCE_COLOR: "1", NO_COLOR: "1" } }), false, "NO_COLOR wins over FORCE_COLOR");
  for (const l of renderLines(g)) assert.ok(l.length <= MAX_LINE, l);
});

test("glanceCmd: NO_COLOR on a TTY prints [BROKEN] with no escape byte; piped CLI output has none", async () => {
  const { glanceCmd } = await import("../../cli/glance.mjs");
  const dir = healthy();
  const out = [];
  const saved = { tty: process.stdout.isTTY, nc: process.env.NO_COLOR };
  try {
    process.stdout.isTTY = true;
    process.env.NO_COLOR = "1";
    await glanceCmd(["--no-write"], { stateDirPath: dir, now: NOW, out: (s) => out.push(s), err: () => {} });
  } finally {
    process.stdout.isTTY = saved.tty;
    if (saved.nc === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = saved.nc;
  }
  assert.doesNotMatch(out.join("\n"), /\x1b/);
  assert.match(out.join("\n"), /^\[UNKNOWN\] +edges: /m);
  const { spawnSync } = await import("node:child_process");
  const env = { ...process.env, PROPAGATE_STATE_DIR: healthy() };
  delete env.NO_COLOR;
  delete env.FORCE_COLOR;
  const r = spawnSync(process.execPath, [path.join(ROOT, "cli.mjs"), "glance", "--no-write"], { encoding: "utf8", env });
  assert.ok(r.stdout.length > 0, r.stderr);
  assert.doesNotMatch(r.stdout, /\x1b/, "piped output carries no escape byte");
});

test("all clear is never silent: one line naming how many signals were checked and when", () => {
  const dir = healthy();
  const g = computeGlance({ dir, now: NOW, rows: rows(["CLEAN"]) }).glance;
  assert.equal(g.verdict, "working");
  const lines = renderLines(g, { now: NOW });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[OK\] {8}all clear · \d+ signals checked · \d\d:\d\d$/);
});

test("a machine with no signal files prints one line, not N unknowns", () => {
  const g = computeGlance({ dir: fresh(), now: NOW }).glance;
  assert.equal(g.verdict, "blind");
  assert.deepEqual(renderLines(g, { now: NOW }), ["[UNKNOWN]   glance: nothing to read yet"]);
});

test("since carries over from the previous glance; a propagate-owned item broken past 6 monitor runs is promoted to needs-you", () => {
  const dir = healthy();
  put(dir, "monitor.log", monitorLine(NOW - 60000, " error=\"boom\""));
  const first = computeGlance({ dir, now: NOW }).glance;
  const m1 = bySignal(first, "monitor")[0];
  assert.equal(m1.verdict, "broken");
  assert.equal(m1.owner, "propagate");
  put(dir, "monitor.log", monitorLine(NOW + 4 * H - 60000, " error=\"boom\""));
  const later = computeGlance({ dir, now: NOW + 4 * H, previous: first }).glance;
  const m2 = bySignal(later, "monitor")[0];
  assert.equal(m2.since, m1.since);
  assert.equal(m2.verdict, "needs_you");
});

// ── the contract ────────────────────────────────────────────────────────────

test("contract: schema_version 1, verdict enum, generatedAt, stale_after_s, needs_you_ids, item shape", () => {
  const g = computeGlance({ dir: healthy(), now: NOW, rows: rows(["CLEAN"]) }).glance;
  assert.equal(g.schema_version, 1);
  assert.equal(SCHEMA_VERSION, 1);
  assert.ok(["working", "broken", "needs_you", "blind"].includes(g.verdict));
  assert.equal(g.generatedAt, iso(NOW));
  assert.equal(g.stale_after_s, 21600);
  assert.ok(Array.isArray(g.needs_you_ids));
  for (const it of g.items) {
    for (const k of ["id", "signal", "kind", "verdict", "flag", "owner", "line", "why", "fix", "since", "looked_at", "source"]) assert.ok(k in it, `${it.id} lacks ${k}`);
    assert.ok(["working", "broken", "needs_you"].includes(it.verdict));
    assert.ok([null, "unknown", "learning"].includes(it.flag));
    assert.ok(["propagate", "you"].includes(it.owner));
    assert.doesNotMatch(it.source, /\//, `source is a name, never a path: ${it.source}`);
  }
});

test("contract: written atomically (no temp file left), absent reads null, unparsable throws, newer schema is refused", () => {
  const dir = fresh();
  assert.equal(readGlance(dir), null);
  assert.equal(readGlanceState(dir, NOW).state, "absent");
  const g = computeGlance({ dir: healthy(), now: NOW }).glance;
  writeGlance(g, dir);
  assert.deepEqual(readdirSync(dir), ["glance.json"]);
  assert.deepEqual(readGlance(dir), g);
  writeFileSync(glancePath(dir), '{"schema_version":1,"items":[');
  assert.throws(() => readGlance(dir));
  assert.equal(readGlanceState(dir, NOW).state, "unavailable");
  writeFileSync(glancePath(dir), JSON.stringify({ ...g, schema_version: 2 }));
  assert.throws(() => readGlance(dir), /glance format newer than this reader/);
  assert.equal(readGlanceState(dir, NOW).state, "newer");
});

test("contract: a reader demotes everything to unknown (stale) past stale_after_s", () => {
  const dir = fresh();
  writeGlance(computeGlance({ dir: healthy(), now: NOW, rows: rows(["CLEAN"]) }).glance, dir);
  assert.equal(readGlanceState(dir, NOW + 5 * H).stale, false);
  assert.equal(readGlanceState(dir, NOW + 7 * H).stale, true);
});

test("one reader throwing makes that signal unknown: <reason>; the run continues", () => {
  const dir = healthy();
  mkdirSync(path.join(dir, "costs", "errors.log"), { recursive: true }); // EISDIR on read
  const g = computeGlance({ dir, now: NOW }).glance;
  const [h] = bySignal(g, "hooks");
  assert.equal(h.flag, "unknown");
  assert.ok(bySignal(g, "doctor").length > 0, "the other signals still ran");
});

// ── exit codes, the command, the prune ──────────────────────────────────────

test("exit codes: 0 working, 1 broken or needs-you, 2 could not read", () => {
  assert.equal(exitCodeOf(computeGlance({ dir: healthy(), now: NOW, rows: rows(["CLEAN"]) }).glance), 0);
  assert.equal(exitCodeOf(computeGlance({ dir: healthy(), now: NOW, rows: rows(["UNMATCHED"]) }).glance), 1);
  const human = doctorJson({ sections: [{ name: "A", entries: [{ kind: "fail", label: "x", detail: "", human: true }] }] });
  assert.equal(exitCodeOf(computeGlance({ dir: healthy(), now: NOW, rows: rows(["CLEAN"]), doctor: human }).glance), 1);
  assert.equal(exitCodeOf(computeGlance({ dir: fresh(), now: NOW }).glance), 2);
});

test("glanceCmd: --json prints exactly the glance.json object; --no-write writes nothing; unknown flag is refused", async () => {
  const { glanceCmd } = await import("../../cli/glance.mjs");
  const dir = healthy();
  const out = [];
  const code = await glanceCmd(["--json"], { stateDirPath: dir, now: NOW, out: (s) => out.push(s), err: () => {} });
  assert.equal(code, 1, "edges were not computed here, so they are unknown");
  assert.deepEqual(JSON.parse(out.join("\n")), JSON.parse(readFileSync(glancePath(dir), "utf8")));
  const dir2 = healthy();
  const before = readdirSync(dir2).sort();
  await glanceCmd(["--no-write"], { stateDirPath: dir2, now: NOW, out: () => {}, err: () => {} });
  assert.deepEqual(readdirSync(dir2).sort(), before);
  const errs = [];
  assert.equal(await glanceCmd(["--bogus"], { stateDirPath: dir2, out: () => {}, err: (s) => errs.push(s) }), 2);
  assert.match(errs.join("\n"), /unknown argument --bogus/);
});

test("glance prunes guard months that ended more than 90 days ago (moved from day open); --no-write prunes nothing", async () => {
  const dir = healthy();
  for (const f of ["2026-07.jsonl", "2026-10.jsonl", "notes.txt"]) put(dir, `guard/${f}`, "");
  const r = runGlance({ dir, now: NOW, write: false });
  assert.deepEqual(readdirSync(path.join(dir, "guard")).sort(), ["2026-07.jsonl", "2026-10.jsonl", "notes.txt"]);
  assert.deepEqual(r.pruned, []);
  const r2 = runGlance({ dir, now: NOW });
  assert.deepEqual(r2.pruned, ["2026-07.jsonl"]);
  assert.deepEqual(readdirSync(path.join(dir, "guard")).sort(), ["2026-10.jsonl", "notes.txt"]);
});

// ── the upgrade, vN-1 -> vN ────────────────────────────────────────────────

test("upgrade: an existing vN-1 state dir with neither glance.json nor guard/ gets a glance.json, exits 0, gains no guard/", async () => {
  const { glanceCmd } = await import("../../cli/glance.mjs");
  const dir = healthy();
  // a vN-1 glance-less install still carries its other state files untouched
  put(dir, "notified.jsonl", '{"k":"x"}\n');
  const before = Object.fromEntries(readdirSync(dir).filter((f) => !f.endsWith("/")).map((f) => [f, existsSync(path.join(dir, f)) && readFileSync(path.join(dir, f), "utf8")]));
  // the monitor is the caller that holds the rows; a vN-1 dir has none, so hand them in as the monitor would
  const r = runGlance({ dir, now: NOW, rows: rows(["CLEAN"]) });
  assert.equal(r.written, true);
  assert.equal(exitCodeOf(r.glance), 0);
  assert.ok(existsSync(glancePath(dir)));
  assert.ok(!existsSync(path.join(dir, "guard")), "a glance never creates guard/");
  for (const [f, text] of Object.entries(before)) assert.equal(readFileSync(path.join(dir, f), "utf8"), text, `${f} changed`);
  // and the standalone command on the same dir now carries the edges forward and exits 0
  const out = [];
  assert.equal(await glanceCmd([], { stateDirPath: dir, now: NOW + 60000, out: (s) => out.push(s), err: () => {} }), 0, out.join("\n"));
});

test("a downgrade leaves guard/ and glance.json harmlessly: no other reader trips on them", async () => {
  const dir = healthy();
  put(dir, "guard/2026-11.jsonl", "");
  writeGlance(computeGlance({ dir, now: NOW }).glance, dir);
  const { readIndex } = await import("../../lib/broadcast/index.mjs");
  assert.equal(readIndex(dir), null);
});
