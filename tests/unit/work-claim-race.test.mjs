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

const QUEUE_URL = new URL("../../lib/work/queue.mjs", import.meta.url).href;
const DB_URL = new URL("../../lib/work/db.mjs", import.meta.url).href;

const CHILD = `
const [dir, session, startAt] = process.argv.slice(1);
const { openDb } = await import(${JSON.stringify(DB_URL)});
const { claim } = await import(${JSON.stringify(QUEUE_URL)});
const { db } = openDb(dir);
// SQLite's own busy handler backs off up to 100 ms, so the loser of one lock sleeps while the winner drains its whole
// loop and the two never overlap. No busy wait here: retry at once in a spin, so both children really contend.
db.exec("PRAGMA busy_timeout = 0");
const claimSpin = () => {
  for (;;) {
    try { return claim({ kind: "evaluate", session }, { db }); } catch (e) { if (!/locked|busy/i.test(String(e.message))) throw e; }
  }
};
while (Date.now() < Number(startAt)) { /* the shared barrier */ }
const ids = [];
for (let i = 0; i < 50; i++) {
  const it = claimSpin();
  if (it) ids.push(it.id);
}
db.close();
process.stdout.write(JSON.stringify(ids));
`;

function run(dir, session, startAt) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ["--input-type=module", "-e", CHILD, dir, session, String(startAt)], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`child ${session} exited ${code}: ${err}`))));
  });
}

/** One round: 60 items, two children released together. Returns the claimed ids and the session sequence in work_events. */
async function round() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "work-race-"));
  const { db } = openDb(dir);
  db.exec("BEGIN IMMEDIATE");
  for (let i = 0; i < 60; i++) {
    enqueueInTx(db, { kind: "evaluate", scope: "acme/hub", dedupe_key: `evaluate:k${i}`, payload: {}, ttlMs: 3_600_000 }, { now: () => Date.now() + i });
  }
  db.exec("COMMIT");
  db.close();

  const startAt = Date.now() + 600;
  const [a, b] = await Promise.all([run(dir, "A", startAt), run(dir, "B", startAt)]);
  const check = openDb(dir);
  try {
    const seq = check.db.prepare("SELECT session FROM work_events WHERE op = 'claim' ORDER BY seq").all().map((r) => r.session);
    return { a, b, seq, switches: seq.filter((s, i) => i > 0 && s !== seq[i - 1]).length };
  } finally { check.db.close(); }
}

test("two processes claim 60 items 50 times each: 60 distinct ids, none twice, and the sessions interleave", async () => {
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
