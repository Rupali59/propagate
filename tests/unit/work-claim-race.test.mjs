/**
 * R5 / Review Focus 1: two PROCESSES claim at once. DatabaseSync is synchronous, so an in-process Promise.all cannot
 * interleave; two children, released at one shared start time, each claim 50 times against 60 items. Together they must
 * hold 60 distinct ids, and the two sessions' claim events must interleave in work_events.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { openDb } from "../../lib/work/db.mjs";
import { enqueueInTx } from "../../lib/work/queue.mjs";

// I4: any entry point that falls back to the real state dir fails loudly (ENOTDIR) instead of touching it.
process.env.PROPAGATE_STATE_DIR = "/dev/null/work-tests-pass-a-dir";

const QUEUE_URL = new URL("../../lib/work/queue.mjs", import.meta.url).href;
const DB_URL = new URL("../../lib/work/db.mjs", import.meta.url).href;

const CHILD = `
const [dir, session, startAt, mode] = process.argv.slice(1);
const { openDb } = await import(${JSON.stringify(DB_URL)});
const { claim } = await import(${JSON.stringify(QUEUE_URL)});
const { db } = openDb(dir);
// SQLite's own busy handler backs off up to 100 ms, so the loser of one lock sleeps while the winner drains its whole
// loop and the two never overlap. No busy wait here: retry at once in a spin, so both children really contend.
const SPIN = mode === "spin" || mode === "hold";
if (SPIN) db.exec("PRAGMA busy_timeout = 0");
// A lock leak must turn the test red, not hang CI: the spin gives up after 10 s.
const claimSpin = () => {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try { return claim({ kind: "evaluate", session }, { db }); } catch (e) {
      if (!/locked|busy/i.test(String(e.message))) throw e;
      if (Date.now() >= deadline) throw new Error("still locked after 10s");
    }
  }
};
// "plain" is production's path: the default busy timeout, no spin and no retry; a locked error must reach here.
const claimOnce = () => claim({ kind: "evaluate", session }, { db });
const fs = await import("node:fs");
// Every mode uses a ready/go handshake, never a clock: a child that starts late under load must not miss the start. The
// parent releases both only once both have opened (their open migrates under a lock too), and in "hold" mode it takes
// its write lock first.
fs.writeFileSync(dir + "/ready-" + session, "");
while (!fs.existsSync(dir + "/go")) { /* wait for the parent */ }
const ids = [];
for (let i = 0; i < 50; i++) {
  const it = SPIN ? claimSpin() : claimOnce();
  if (it) ids.push(it.id);
}
db.close();
process.stdout.write(JSON.stringify(ids));
`;

function run(dir, session, startAt, mode = "spin") {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ["--input-type=module", "-e", CHILD, dir, session, String(startAt), mode], { stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, killSignal: "SIGKILL" });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`child ${session} exited ${code}: ${err}`))));
  });
}

/** One round: 60 items, two children released together. Returns the claimed ids and the session sequence in work_events. */
async function round(mode = "spin", hold) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "work-race-"));
  const { db } = openDb(dir);
  db.exec("BEGIN IMMEDIATE");
  for (let i = 0; i < 60; i++) {
    enqueueInTx(db, { kind: "evaluate", scope: "acme/hub", dedupe_key: `evaluate:k${i}`, payload: {}, ttlMs: 3_600_000 }, { now: () => Date.now() + i });
  }
  db.exec("COMMIT");
  db.close();
  const startAt = 0; // unused by the children: the barrier is the ready/go handshake below
  const holder = hold ? openDb(dir).db : null;
  const release = async () => {
    const until = Date.now() + 30_000;
    while (!(fs.existsSync(path.join(dir, "ready-A")) && fs.existsSync(path.join(dir, "ready-B")))) {
      if (Date.now() > until) throw new Error("children never became ready");
      await new Promise((r) => setTimeout(r, 5));
    }
    if (holder) holder.exec("BEGIN IMMEDIATE"); // a leaked lock: held from the moment both children are ready until they give up
    fs.writeFileSync(path.join(dir, "go"), "");
  };
  const locked = release();
  const [a, b] = await Promise.all([run(dir, "A", startAt, mode), run(dir, "B", startAt, mode)]).finally(() => holder?.close());
  await locked;
  const check = openDb(dir);
  try {
    const seq = check.db.prepare("SELECT session FROM work_events WHERE op = 'claim' ORDER BY seq").all().map((r) => r.session);
    return { a, b, seq, switches: seq.filter((s, i) => i > 0 && s !== seq[i - 1]).length };
  } finally { check.db.close(); }
}

test("two processes claim 60 items 50 times each: 60 distinct ids, none twice, and the sessions interleave", { timeout: 120_000 }, async () => {
  // Correctness is asserted on EVERY round. Interleaving is a property of the scheduler: under a loaded machine (the full
  // suite) one child can be descheduled for its whole turn, so up to 3 rounds are allowed to produce an interleaved one.
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    last = await round();
    const all = [...last.a, ...last.b];
    const dupes = all.filter((id, i) => all.indexOf(id) !== i);
    assert.deepEqual(dupes, [], `duplicate ids claimed by both sessions: ${dupes.join(", ")}`);
    assert.equal(new Set(all).size, 60, `expected 60 distinct ids, got ${new Set(all).size} (${last.a.length} + ${last.b.length})`);
    assert.equal(last.seq.length, 60);
    if (last.switches >= 2) return;
  }
  assert.fail(`the two sessions did not interleave in 3 rounds (${last.switches} switches); the test is not racing`);
});

test("production busy path: two children on plain openDb (default busy timeout), no spin, no retry: 60 distinct ids and no locked error", { timeout: 120_000 }, async () => {
  const r = await round("plain"); // a child that saw "database is locked" exits non-zero and rejects the round
  const all = [...r.a, ...r.b];
  assert.equal(new Set(all).size, 60, `expected 60 distinct ids, got ${new Set(all).size} (${r.a.length} + ${r.b.length})`);
  assert.equal(all.length, 60, "an id was claimed twice");
});

test("a leaked write lock turns the race red with `still locked after 10s`, it does not hang", { timeout: 120_000 }, async () => {
  await assert.rejects(() => round("hold", true), /still locked after 10s/);
});
