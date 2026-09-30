/**
 * `doctor --since <t>` — OBSERVABILITY §6 step 4, TODOS PR-028.
 *
 * §6 step 1 records its own limitation: doctor is point-in-time, so a metric that
 * regresses between invocations is invisible. Step 4 closes that, and §6 describes
 * the work honestly — "a thin CLI layer over data that already exists".
 *
 * THE TWO PROPERTIES THAT MATTER ARE BOTH ABOUT REFUSAL, not about the summary:
 *
 *   1. An empty window must be ATTRIBUTABLE. "No runs in that window" and "every
 *      metric held steady" are different facts and only one is reassuring
 *      (rule:discernment-checks §2).
 *   2. A bad `--since` must REFUSE, never widen. A tolerated bad spec becomes a
 *      silently-wide window, and an empty wide window reads as "nothing wrong" —
 *      the same collapse, arrived at through the front door.
 *
 * And a third, specific to the command's name: the output must say it ran no
 * checks. A metrics summary printed under the word `doctor` otherwise reads as
 * "doctor ran and is happy", which is N87's failure in a new command.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseSince, summariseSince, UNCALIBRATED } from "../../lib/report/metrics.mjs";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(REPO, "cli.mjs");
const NOW = Date.parse("2026-09-30T12:00:00.000Z");

const rec = (iso, metrics) => ({ ts: iso, run_id: iso, metrics });

// ── parseSince ──────────────────────────────────────────────────────────────

test("parseSince accepts spans and dates", () => {
  assert.equal(parseSince("7d", NOW).at, NOW - 7 * 86_400_000);
  assert.equal(parseSince("24h", NOW).at, NOW - 24 * 3_600_000);
  assert.equal(parseSince("30m", NOW).at, NOW - 30 * 60_000);
  assert.equal(parseSince("2w", NOW).at, NOW - 2 * 604_800_000);
  assert.equal(parseSince("2026-09-01", NOW).at, Date.parse("2026-09-01"));
});

test("parseSince REFUSES rather than widening — a tolerated bad spec becomes a silent wide window", () => {
  // The load-bearing test. Defaulting on a bad spec turns "no records" into
  // "nothing wrong", which is the whole failure this command exists to avoid.
  for (const bad of ["banana", "", "   ", "7", "d", "7x", "-3d", undefined, null, 7]) {
    assert.throws(() => parseSince(bad, NOW), /--since/, `${JSON.stringify(bad)} must be refused`);
  }
});

test("parseSince names the accepted forms in its refusal, not just 'invalid'", () => {
  // rule:discernment-checks §2 — a refusal that does not say what would work sends
  // the reader guessing, and the guess is usually a wider window.
  assert.throws(() => parseSince("banana", NOW), (e) => {
    assert.match(e.message, /span/i);
    assert.match(e.message, /30m|24h|7d|2w/);
    assert.match(e.message, /2026-09-30|date/i);
    return true;
  });
});

test("parseSince refuses a FUTURE date and a zero-width window", () => {
  assert.throws(() => parseSince("2099-01-01", NOW), /future/);
  assert.throws(() => parseSince("0d", NOW), /zero-width/);
});

// ── summariseSince ──────────────────────────────────────────────────────────

test("an empty window is ATTRIBUTABLE, and distinguishes 'no runs' from 'no records at all'", () => {
  // Two different facts. "metrics.jsonl is empty" is a broken collector; "records
  // exist but all older" is a quiet week. Folding them loses the one that matters.
  const none = summariseSince([], NOW - 86_400_000, { label: "the last 1d" });
  assert.equal(none.runs, 0);
  assert.match(none.reason, /no records at all/, "an empty store must say so");

  const older = summariseSince([rec("2026-01-01T00:00:00.000Z", { a: 1 })], NOW - 86_400_000, { label: "the last 1d" });
  assert.equal(older.runs, 0);
  assert.match(older.reason, /no doctor runs in the last 1d/);
  assert.match(older.reason, /1 record\(s\) exist, all older/, "it must name the total, or absence is unattributable");
  assert.notEqual(older.reason, none.reason, "the two causes must not render identically");
});

test("a populated window reports first, last, delta, min and max — and reason is null", () => {
  const recs = [
    rec("2026-09-29T00:00:00.000Z", { "doctor.problems": 8, "rows.open": 3 }),
    rec("2026-09-29T12:00:00.000Z", { "doctor.problems": 12, "rows.open": 3 }),
    rec("2026-09-30T00:00:00.000Z", { "doctor.problems": 6, "rows.open": 3 }),
  ];
  const s = summariseSince(recs, Date.parse("2026-09-28T00:00:00.000Z"), { label: "w" });
  assert.equal(s.reason, null, "a populated window must not carry a reason");
  assert.equal(s.runs, 3);
  const p = s.metrics.find((m) => m.key === "doctor.problems");
  assert.deepEqual(
    { first: p.first, last: p.last, delta: p.delta, min: p.min, max: p.max },
    { first: 8, last: 6, delta: -2, min: 6, max: 12 },
  );
  // The spike is the point: first and last are both below the max, so a
  // first/last-only report would hide the 12 entirely.
  assert.ok(p.max > p.first && p.max > p.last, "min/max exist because endpoints hide spikes");
});

test("a key that STOPPED being recorded is not a key that went to zero", () => {
  // detectVanishedKeys exists for the adjacent-run case; the same distinction has
  // to hold across a window, or a broken collector reads as a healthy zero.
  const recs = [
    rec("2026-09-29T00:00:00.000Z", { kept: 1, going: 5 }),
    rec("2026-09-30T00:00:00.000Z", { kept: 1, arrived: 2 }),
  ];
  const s = summariseSince(recs, Date.parse("2026-09-28T00:00:00.000Z"), { label: "w" });
  const going = s.metrics.find((m) => m.key === "going");
  const arrived = s.metrics.find((m) => m.key === "arrived");
  assert.equal(going.vanished, true, "present at the start, absent at the end");
  assert.equal(going.last, undefined, "and its last value is absent, not 0");
  assert.equal(arrived.appeared, true);
  assert.equal(s.metrics.find((m) => m.key === "kept").vanished, false);
});

test("records with an unparseable ts are excluded rather than crashing the summary", () => {
  const s = summariseSince(
    [rec("not-a-date", { a: 1 }), rec("2026-09-30T00:00:00.000Z", { a: 2 })],
    Date.parse("2026-09-01T00:00:00.000Z"),
    { label: "w" },
  );
  assert.equal(s.runs, 1, "the junk record must not be counted as in-window");
});

test("UNCALIBRATED is an array of OBJECTS, so a key lookup cannot use includes()", () => {
  // Pinning the shape, because the first version of the renderer did
  // `UNCALIBRATED?.includes?.(key)` — a string compared against objects — and
  // optional chaining turned the type mismatch into a silent false rather than a
  // throw. The annotation simply never appeared.
  assert.ok(Array.isArray(UNCALIBRATED));
  assert.equal(typeof UNCALIBRATED[0], "object");
  assert.ok("key" in UNCALIBRATED[0] && "reason" in UNCALIBRATED[0]);
  assert.equal(UNCALIBRATED.includes("rows.open"), false, "includes() on a string can never match");
  // `rows.open` rather than `doctor.duration_ms`: the latter was CALIBRATED on 2026-09-30
  // (PR-029) and left this list, which this test noticed when the suite went red.
  assert.ok(UNCALIBRATED.some((u) => u.key === "rows.open"), "a keyed lookup does");
});

// ── the CLI layer ───────────────────────────────────────────────────────────

function runSince(arg, stateDir) {
  const r = spawnSync(process.execPath, [CLI, "doctor", "--since", arg], {
    encoding: "utf8",
    env: { ...process.env, PROPAGATE_STATE_DIR: stateDir },
  });
  return { out: r.stdout + r.stderr, code: r.status };
}

/** A scoped state dir holding exactly the metrics records given. */
function withMetrics(records) {
  const dir = mkdtempSync(path.join(tmpdir(), "since-state-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "metrics.jsonl"), records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  return dir;
}

test("the CLI exits 2 on a bad --since, and says what would work", () => {
  const dir = withMetrics([]);
  try {
    const { out, code } = runSince("banana", dir);
    assert.equal(code, 2, `a bad spec must be a refusal, not a wide window:\n${out}`);
    assert.match(out, /not a span or a date/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the CLI says it RAN NO CHECKS — on both the populated and the empty path", () => {
  // The command is spelled `doctor`. Without this line a metrics summary reads as
  // "doctor ran and is happy", which is N87's defect in a new place.
  const dir = withMetrics([rec(new Date().toISOString(), { "doctor.problems": 1 })]);
  try {
    assert.match(runSince("7d", dir).out, /RAN NO CHECKS/, "the populated path must disclaim");
    assert.match(runSince("1m", dir).out, /RAN NO CHECKS/i, "the empty path must disclaim too");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the CLI renders an empty window as 'no data' with a reason, never as a clean run", () => {
  const dir = withMetrics([rec("2026-01-01T00:00:00.000Z", { a: 1 })]);
  try {
    const { out } = runSince("1m", dir);
    assert.match(out, /no data/);
    assert.match(out, /1 record\(s\) exist, all older/);
    assert.doesNotMatch(out, /all green|held steady/, "an empty window must not read as a pass");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the CLI never runs the checks — proven by it completing far faster than a doctor run", () => {
  // Behavioural rather than a source assertion: doctor takes minutes in this tree
  // (N91 records spikes past 18 minutes). A query over one file cannot.
  const dir = withMetrics([rec(new Date().toISOString(), { a: 1 })]);
  try {
    const t = Date.now();
    const { code } = runSince("7d", dir);
    const ms = Date.now() - t;
    assert.equal(code ?? 0, 0);
    assert.ok(ms < 15_000, `--since took ${ms}ms; it must be a query over metrics.jsonl, not a doctor run`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
