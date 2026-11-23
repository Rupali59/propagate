// day-close-auto (propagate#339): the catch-up decision, the lock, the failure classes and the guide line.
// Pure and temp-dir only: no GitHub, no real state dir.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  classifyFailure, lastCloseRecord, writeLastClose, readLastClose, guideLine, autoEnabled, catchUpDecision,
  acquireLock, setLockPid, releaseLock, lockPath, lastClosePath, RETRY_COOLDOWN_MS,
} from "../../lib/report/day-close-auto.mjs";

const NOW = new Date(2026, 10, 19, 9, 0, 0).getTime();
const YESTERDAY = "2026-11-18";
const TODAY = "2026-11-19";
const tmp = () => mkdtempSync(path.join(tmpdir(), "dca-"));
const put = (dir, rec) => {
  mkdirSync(path.join(dir, "day"), { recursive: true });
  writeFileSync(lastClosePath(dir), JSON.stringify(rec));
};

// ── the three failure classes the coordinator named, one fixture each, plus the non-transient case ──────────────

test("classifyFailure: a burst refusal is rate-limited", () => {
  for (const m of ["You have exceeded a secondary rate limit", "API rate limit exceeded for user", "gh: HTTP 429", "GraphQL remaining 50 is below 100; refusing to start (nothing fetched)"]) {
    assert.deepEqual(classifyFailure(m), { kind: "rate-limited", label: "rate-limited" }, m);
  }
});
test("classifyFailure: a 5xx names the actual status", () => {
  assert.deepEqual(classifyFailure("board item fetch failed: gh: HTTP 504"), { kind: "unavailable", label: "github unavailable (HTTP 504)" });
  assert.equal(classifyFailure("gh: HTTP 502 Bad Gateway").label, "github unavailable (HTTP 502)");
});
test("classifyFailure: a timeout or reset names the code", () => {
  assert.deepEqual(classifyFailure("--apply failed after 100 of 131 write(s): gh: ETIMEDOUT"), { kind: "unavailable", label: "github unavailable (ETIMEDOUT)" });
  assert.equal(classifyFailure("gh: ECONNRESET").label, "github unavailable (ECONNRESET)");
});
test("classifyFailure: anything else is not transient (null), and non-strings do not throw", () => {
  assert.equal(classifyFailure("board listing failed: Could not resolve to a User"), null);
  assert.equal(classifyFailure("gh: HTTP 404"), null);
  assert.equal(classifyFailure(undefined), null);
});

// ── the record and the guide line ───────────────────────────────────────────────────────────────────────────────

const okResult = { exit: 0, promote: [1, 2], closeFix: [1, 2, 3], inProgress: [1], applied: true, reason: "applied 9 write(s)" };

test("record + line: a clean apply shows counts and the output file", () => {
  const rec = lastCloseRecord(okResult, { apply: true, now: NOW, prev: null });
  assert.equal(rec.date, TODAY);
  assert.equal(rec.status, "ok");
  assert.equal(rec.caughtUpDate, TODAY);
  assert.equal(guideLine(rec), `day close ${TODAY}: 2 promoted, 3 closed → Done, 1 In progress to look at (close-${TODAY}.txt)`);
});
test("record + line: a dry run says nothing was written and does not count as caught up", () => {
  const rec = lastCloseRecord(okResult, { apply: false, now: NOW, prev: { caughtUpDate: YESTERDAY } });
  assert.equal(rec.mode, "dry-run");
  assert.equal(rec.caughtUpDate, YESTERDAY);
  assert.match(guideLine(rec), /\(dry run, nothing written\)/);
});
test("record + line: rate-limited reads 'will retry next session'", () => {
  const rec = lastCloseRecord({ exit: 2, reason: "x", failure: { kind: "rate-limited", label: "rate-limited" } }, { apply: true, now: NOW, prev: null });
  assert.equal(rec.status, "rate-limited");
  assert.equal(rec.caughtUpDate ?? null, null);
  assert.match(guideLine(rec), /rate-limited, will retry next session/);
});
test("record + line: a 5xx and a timeout name their status and retry next session", () => {
  for (const label of ["github unavailable (HTTP 504)", "github unavailable (ETIMEDOUT)"]) {
    const rec = lastCloseRecord({ exit: 2, reason: "x", failure: { kind: "unavailable", label } }, { apply: true, now: NOW, prev: null });
    assert.equal(rec.status, "unavailable");
    assert.ok(guideLine(rec).includes(`${label}, will retry next session`), guideLine(rec));
  }
});
test("record + line: a partial write says how many of how many", () => {
  const rec = lastCloseRecord({ exit: 2, reason: "x", partial: { written: 100, total: 131 }, failure: { kind: "unavailable", label: "github unavailable (ETIMEDOUT)" } }, { apply: true, now: NOW, prev: null });
  assert.equal(rec.status, "partial");
  assert.match(guideLine(rec), /partial: 100 of 131 written/);
});
test("record + line: any other failure shows failed (exit N), never silence", () => {
  const rec = lastCloseRecord({ exit: 2, reason: "board listing failed: nope" }, { apply: true, now: NOW, prev: null });
  assert.equal(rec.status, "failed");
  assert.match(guideLine(rec), /^day close 2026-11-19: failed \(exit 2\)/);
  assert.match(guideLine({ ...rec, exit: 1, reason: "read-back mismatch" }), /failed \(exit 1\)/);
});
test("guideLine: a record that cannot be understood says so", () => {
  assert.match(guideLine({ nonsense: true }), /last-close\.json unreadable/);
});
test("guideLine stays within 160 characters whatever the reason", () => {
  const rec = lastCloseRecord({ exit: 2, reason: "x".repeat(900) }, { apply: true, now: NOW, prev: null });
  assert.ok(guideLine(rec).length <= 160, String(guideLine(rec).length));
});
test("writeLastClose / readLastClose round-trip, and absent is null, malformed throws", () => {
  const d = tmp();
  assert.equal(readLastClose(d), null);
  const rec = lastCloseRecord(okResult, { apply: true, now: NOW, prev: null });
  writeLastClose(d, rec);
  assert.deepEqual(readLastClose(d), rec);
  writeFileSync(lastClosePath(d), "{nope");
  assert.throws(() => readLastClose(d));
});

// ── the off switch ─────────────────────────────────────────────────────────────────────────────────────────────

test("autoEnabled: on by default; PROPAGATE_DAY_CLOSE_AUTO=0 and the config key turn it off", () => {
  assert.equal(autoEnabled({ env: {}, configText: "" }).on, true);
  assert.equal(autoEnabled({ env: { PROPAGATE_DAY_CLOSE_AUTO: "0" }, configText: "" }).on, false);
  assert.equal(autoEnabled({ env: { PROPAGATE_DAY_CLOSE_AUTO: "1" }, configText: "dayCloseAuto: false\n" }).on, true, "the env var wins over the config key");
  for (const cfg of ["dayCloseAuto: false\n", "hubRoot: /x\ndayCloseAuto: off # why\n", "dayCloseAuto: \"0\"\n"]) {
    assert.equal(autoEnabled({ env: {}, configText: cfg }).on, false, cfg);
  }
  assert.equal(autoEnabled({ env: {}, configText: "dayCloseAuto: true\n" }).on, true);
  assert.match(autoEnabled({ env: { PROPAGATE_DAY_CLOSE_AUTO: "0" }, configText: "" }).why, /PROPAGATE_DAY_CLOSE_AUTO=0/);
});

// ── the decision ───────────────────────────────────────────────────────────────────────────────────────────────

const decide = (rec, over = {}) => {
  const d = tmp();
  if (rec) put(d, rec);
  return catchUpDecision({ dir: d, now: NOW, env: {}, configText: "", ...over });
};
const base = { mode: "apply", promoted: 0, closedToDone: 0, inProgress: 0, exit: 0 };

test("decision: no record starts a run", () => assert.equal(decide(null).action, "start"));
test("decision: dated yesterday starts one; dated today does not", () => {
  assert.equal(decide({ ...base, date: YESTERDAY }).action, "start");
  const t = decide({ ...base, date: TODAY });
  assert.equal(t.action, "skip");
  assert.match(t.why, /already ran today/);
});
test("decision: a dry run today does not count as the close", () => {
  assert.equal(decide({ ...base, mode: "dry-run", date: TODAY, caughtUpDate: YESTERDAY }).action, "start");
});
test("decision: a transient failure today retries after the cooldown, not before", () => {
  const rec = (finishedAt) => ({ ...base, date: TODAY, exit: 2, status: "rate-limited", finishedAt: new Date(finishedAt).toISOString() });
  assert.equal(decide(rec(NOW - 60 * 1000)).action, "skip");
  assert.equal(decide(rec(NOW - RETRY_COOLDOWN_MS - 1000)).action, "start");
});
test("decision: a non-transient failure today waits for tomorrow", () => {
  const r = decide({ ...base, date: TODAY, exit: 2, status: "failed", finishedAt: new Date(NOW - 3600e3).toISOString() });
  assert.equal(r.action, "skip");
  assert.match(r.why, /tomorrow/);
});
test("decision: the off switch beats every other answer", () => {
  assert.equal(decide({ ...base, date: YESTERDAY }, { env: { PROPAGATE_DAY_CLOSE_AUTO: "0" } }).action, "off");
  assert.equal(decide({ ...base, date: YESTERDAY }, { configText: "dayCloseAuto: false\n" }).action, "off");
});
test("decision: an unreadable record is not a reason to stay silent: it starts a run", () => {
  const d = tmp();
  mkdirSync(path.join(d, "day"), { recursive: true });
  writeFileSync(lastClosePath(d), "{nope");
  assert.equal(catchUpDecision({ dir: d, now: NOW, env: {}, configText: "" }).action, "start");
});

// ── the lock ───────────────────────────────────────────────────────────────────────────────────────────────────

test("lock: the second acquire fails while the first holder is alive", () => {
  const d = tmp();
  assert.equal(acquireLock(d, { now: NOW, pid: process.pid }), true);
  assert.equal(acquireLock(d, { now: NOW, pid: process.pid }), false);
});
test("lock: a dead holder's lock is taken over; a too-old one too", () => {
  const d = tmp();
  mkdirSync(path.join(d, "day"), { recursive: true });
  writeFileSync(lockPath(d), JSON.stringify({ pid: 2 ** 22 + 12345, ts: NOW }));
  assert.equal(acquireLock(d, { now: NOW, pid: process.pid }), true, "dead pid");
  writeFileSync(lockPath(d), JSON.stringify({ pid: process.pid, ts: NOW - 3 * 3600e3 }));
  assert.equal(acquireLock(d, { now: NOW, pid: process.pid }), true, "older than the limit");
});
test("lock: release removes only the holder's own lock", () => {
  const d = tmp();
  acquireLock(d, { now: NOW, pid: 111 });
  setLockPid(d, process.pid, NOW);
  releaseLock(d, 111);
  assert.ok(existsSync(lockPath(d)), "another pid's release leaves it");
  releaseLock(d, process.pid);
  assert.ok(!existsSync(lockPath(d)));
});
