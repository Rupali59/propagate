/**
 * digest-notify-nonblocking.test.mjs — propagate#462: a notifier that never exits must not hold the digest, and a
 * digest run that started and never finished reads as stuck on the glance.
 *
 * MUTATION RECORDED: in lib/report/notify.mjs await the child's exit again (resolve on "close" rather than "spawn")
 * -> the never-exits test goes red (notify() is still pending at 1 s). Run by hand; restored.
 *
 * Run: PROPAGATE_STATE_DIR="$(mktemp -d)" node --test tests/unit/digest-notify-nonblocking.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { notify } from "../../lib/report/notify.mjs";
import { computeGlance } from "../../lib/glance/compute.mjs";
import { digestRunRow, recordDigestStart, recordDigestFinish } from "../../lib/glance/digest-run.mjs";

const NOW = Date.parse("2026-11-28T12:00:00Z");
const H = 3600000;
const tmp = () => mkdtempSync(path.join(tmpdir(), "dn-"));

function stub(body) {
  const f = path.join(tmp(), "notifier.sh");
  writeFileSync(f, `#!/bin/sh\n${body}\n`);
  chmodSync(f, 0o755);
  return f;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("a notifier that never exits leaves notify() resolved in under 1 s, and the notifier keeps running detached", async () => {
  const d = tmp();
  const pidFile = path.join(d, "pid");
  const bin = stub(`echo $$ > ${JSON.stringify(pidFile)}\nexec sleep 600`);
  const t0 = Date.now();
  await notify("t", "b", { notifier: bin });
  const took = Date.now() - t0;
  assert.ok(took < 1000, `notify() took ${took} ms with a notifier that never exits`);
  for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(existsSync(pidFile), "the stub never started");
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  assert.ok(alive(pid), "the stub should still be running (detached), not waited on or killed");
  process.kill(pid, "SIGKILL");
});

test("a notifier that cannot be spawned still resolves (falls to osascript path, never throws)", async () => {
  const f = path.join(tmp(), "not-executable");
  writeFileSync(f, "x"); // exists but mode 0644: spawn fails with EACCES
  const t0 = Date.now();
  await notify("t", "b", { notifier: f });
  assert.ok(Date.now() - t0 < 15000);
});

const runFile = (rec) => { const d = tmp(); if (rec !== undefined) writeFileSync(path.join(d, "digest-run.json"), typeof rec === "string" ? rec : JSON.stringify(rec)); return d; };
const iso = (ms) => new Date(ms).toISOString();
const glanceRow = (dir) => {
  const { glance } = computeGlance({ dir, now: NOW });
  return { items: glance.items.filter((i) => i.signal === "digest"), skipped: glance.skipped.filter((s) => s.signal === "digest") };
};

test("a start record with no finish, older than 24 h, is a stuck row on the glance", () => {
  const { items } = glanceRow(runFile({ started: iso(NOW - 30 * H), finished: null, pid: 1 }));
  assert.equal(items.length, 1);
  assert.equal(items[0].verdict, "broken");
  assert.match(items[0].what, /^digest stuck: started 30h ago, never finished/);
});

test("a start with no finish inside 24 h is running, not stuck; a finish after the start is working", () => {
  assert.equal(glanceRow(runFile({ started: iso(NOW - 2 * H), finished: null })).items[0].verdict, "working");
  const fin = glanceRow(runFile({ started: iso(NOW - 40 * H), finished: iso(NOW - 39 * H) })).items[0];
  assert.equal(fin.verdict, "working");
});

test("a missing record reads as never ran, skipped, not stuck; an unreadable one is unknown", () => {
  const miss = glanceRow(runFile());
  assert.equal(miss.items.length, 0);
  assert.match(JSON.stringify(miss.skipped), /digest never ran/);
  assert.equal(digestRunRow({ dir: runFile("{not json"), now: NOW }).unknown.what, "digest run record unreadable");
});

test("recordDigestStart then recordDigestFinish round-trips, and another pid's record is never finished", () => {
  const d = tmp();
  recordDigestStart(d, NOW);
  assert.equal(digestRunRow({ dir: d, now: NOW + 30 * H }).broken !== undefined, true);
  recordDigestFinish(d, NOW + H);
  assert.ok(digestRunRow({ dir: d, now: NOW + 30 * H }).working);
  writeFileSync(path.join(d, "digest-run.json"), JSON.stringify({ started: iso(NOW), finished: null, pid: -5 }));
  recordDigestFinish(d, NOW + H);
  assert.ok(digestRunRow({ dir: d, now: NOW + 30 * H }).broken, "a record owned by another pid was finished");
});
