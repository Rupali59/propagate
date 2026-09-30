/**
 * `run_id` on the monitor's two outputs — OBSERVABILITY §6 step 2, TODOS PR-031.
 *
 * The design scoped step 2 to `watcher.log`, which was last written 2026-08-21 and
 * whose producer was DELETED in `2f1612b`. Re-pointed at the producer that actually
 * runs 48 times a day.
 *
 * WHAT IT UNLOCKS, and it is one specific join. `monitor.log` says `notified=6`;
 * `notified.jsonl` says WHICH edges. Before this the only link was timestamp
 * proximity — the reconstruction PR-020's analysis had to do by hand to establish
 * that 76% of notifications were an edge already notified, re-fired because its bytes
 * changed. So these tests assert the JOIN, not the presence of a field.
 *
 * AND THEY ASSERT WHAT MUST NOT CHANGE, which is the larger half: `notified.jsonl` has
 * three other readers and `monitor.log` is parsed by doctor with a regex and truncated
 * to 80 characters for display. A field added at the cost of either is a field that
 * made the tool worse.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { logRun, recordNotified, readNotified } from "../../lib/report/monitor.mjs";
import { mintRunId } from "../../lib/core/runs.mjs";

const row = (edge_id, state) => ({ edge_id, state, source: "a.md", downstream: "b.md" });

async function withDir(fn) {
  const d = mkdtempSync(path.join(tmpdir(), "monitor-runid-"));
  try {
    return await fn(d);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

test("a notification joins EXACTLY to the run that produced it", async () => {
  await withDir(async (d) => {
    const id = mintRunId();
    const logF = path.join(d, "monitor.log");
    const notF = path.join(d, "notified.jsonl");

    const line = await logRun({ rows: 1157, actionable: 100, notified: 2, suppressed: 98, ms: 3214, runId: id }, logF);
    await recordNotified([row("abc123", "DRIFTED"), row("def456", "DIVERGED")], notF, new Date(), id);

    assert.ok(line.includes(`run=${id}`), "the summary line must carry the id");
    const rows = readFileSync(notF, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(rows.length, 2);
    for (const r of rows) assert.equal(r.run_id, id, "every row must carry the SAME id as the line");
  });
});

test("`run=` goes LAST, so doctor's 80-character display still shows every stat", async () => {
  // lib/report/doctor/environment.mjs:218 renders `last.slice(0, 80)`. A 36-character
  // id placed after the timestamp would push rows/actionable/notified/ms out of the
  // window — the field would be added and the line would become less useful. This is
  // the assertion that stops someone "tidying" the id to the front.
  await withDir(async (d) => {
    const id = mintRunId();
    const line = await logRun(
      { rows: 1157, actionable: 100, notified: 6, suppressed: 94, ms: 3214, runId: id },
      path.join(d, "monitor.log"),
    );
    const shown = line.slice(0, 80);
    for (const stat of ["ran=1", "rows=1157", "actionable=100", "notified=6", "suppressed=94"]) {
      assert.ok(shown.includes(stat), `${stat} must survive slice(0, 80); got ${JSON.stringify(shown)}`);
    }
    assert.ok(!shown.includes("run="), "the id itself is outside the displayed window, by design");
  });
});

test("doctor's `/notified=[1-9]/` test on the line is unaffected", async () => {
  // Three states that must stay distinguishable in environment.mjs: ran-and-notified,
  // ran-and-found-nothing, could-not-look.
  await withDir(async (d) => {
    const f = path.join(d, "monitor.log");
    const notified = await logRun({ rows: 9, actionable: 3, notified: 3, suppressed: 0, ms: 12, runId: mintRunId() }, f);
    const quiet = await logRun({ rows: 9, actionable: 0, notified: 0, suppressed: 0, ms: 12, runId: mintRunId() }, f);
    const blind = await logRun({ rows: 0, actionable: 0, notified: 0, suppressed: 0, ms: 12, error: "boom", runId: mintRunId() }, f);
    assert.ok(/notified=[1-9]/.test(notified), "a run that notified must still match");
    assert.ok(!/notified=[1-9]/.test(quiet), "a quiet run must still not match");
    assert.match(blind, /error=/, "could-not-look stays its own outcome");
    assert.ok(blind.includes("run="), "and the failure path is attributable to a run too");
  });
});

test("a row WITHOUT a run id stays valid, and readNotified is unaffected either way", async () => {
  // `notified.jsonl` is append-only and already holds ~2,240 rows written before this
  // field existed. Absent is a fact about the row, never a reason to drop it —
  // `readNotified` reads only `r.key`, and the fail-open direction is "tell them
  // again", never "stay quiet".
  await withDir(async (d) => {
    const f = path.join(d, "notified.jsonl");
    await recordNotified([row("with", "DRIFTED")], f, new Date(), mintRunId());
    await recordNotified([row("without", "DRIFTED")], f);          // no id passed
    const lines = readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok("run_id" in lines[0]);
    assert.ok(!("run_id" in lines[1]), "no id must mean the key is ABSENT, not null");
    const keys = await readNotified(f);
    assert.equal(keys.size, 2, "both rows must still suppress a repeat notification");
  });
});

test("the monitor mints ONE id per run and reuses mintRunId rather than a fourth generator", () => {
  // N96 is the entry about three components computing the same thing independently and
  // agreeing by coincidence. A fourth `crypto.randomUUID()` call here would be that
  // shape; `lib/core/runs.mjs` already documents why a run id is random rather than
  // content-addressed.
  const cli = readFileSync(new URL("../../cli.mjs", import.meta.url), "utf8");
  assert.match(cli, /mintRunId\(\)/, "the monitor must reuse the existing minter");
  const block = cli.slice(cli.indexOf("const monitorRunId"), cli.indexOf("const monitorRunId") + 4000);
  assert.ok(!/randomUUID/.test(block), "and must not mint its own");
  // One mint, threaded — not one per call site, which would break the join silently.
  assert.equal((cli.match(/const monitorRunId = /g) || []).length, 1, "exactly one mint per run");
  for (const site of ["recordNotified(toNotify, undefined, new Date(), monitorRunId)",
                      "recordNotified(defectPick.toNotify, undefined, new Date(), monitorRunId)"]) {
    assert.ok(cli.includes(site), `${site} must receive the same id`);
  }
});
