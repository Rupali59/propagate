/**
 * DESK digest section: deskSnapshot() runs the Granth desk check and deskLines()
 * renders it. Stubs only: no network, no Neon. The property under test: a quiet
 * day prints nothing, and every way the check can fail to RUN prints a
 * "could not run" line (never silence).
 */
// @size medium — starts processes (bash stubs); run when affected
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { deskSnapshotForTest, deskLinesForTest, computeDiff, formatDigest } from "../../digest.mjs";

const dir = mkdtempSync(path.join(tmpdir(), "digest-desk-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

function stub(name, body) {
  const p = path.join(dir, name);
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
  return p;
}

async function run(script, timeoutMs, dryRun = true) {
  const prev = process.env.PROPAGATE_DESK_CHECK;
  process.env.PROPAGATE_DESK_CHECK = script;
  try {
    const snap = await deskSnapshotForTest(dryRun, timeoutMs);
    return { snap, lines: deskLinesForTest(snap) };
  } finally {
    if (prev === undefined) delete process.env.PROPAGATE_DESK_CHECK;
    else process.env.PROPAGATE_DESK_CHECK = prev;
  }
}

const EMPTY = { awaiting_accept: [], needs_verdict: [], accepted_open: [], dev_on_desk: [], overdue: [], could_not_run: null };

test("quiet day: exit 0, all lists empty, zero lines", async () => {
  const { lines } = await run(stub("ok.sh", `echo '${JSON.stringify(EMPTY)}'`));
  assert.deepEqual(lines, []);
});

test("each finding category renders a count and up to 3 oldest titles, no body", async () => {
  const items = [1, 2, 3, 4].map((n) => ({ id: n, title: `T${n}`, age_days: n, body: "PRIVATE-NOTE" }));
  const j = JSON.stringify({ ...EMPTY, awaiting_accept: items, needs_verdict: [items[0]], accepted_open: [items[1]], dev_on_desk: [items[2]], overdue: [items[3]] });
  const { lines } = await run(stub("bad.sh", `echo '${j}'; exit 1`));
  assert.equal(lines.length, 5);
  assert.match(lines[0], /^4 answers awaiting acceptance: #4 T4 \(4d\); #3 T3 \(3d\); #2 T2 \(2d\)$/);
  assert.match(lines[1], /needing an interpretive verdict/);
  assert.match(lines[2], /accepted but still open on GitHub/);
  assert.match(lines[3], /dev items on the desk/);
  assert.match(lines[4], /overdue/);
  assert.ok(!lines.join("\n").includes("PRIVATE-NOTE"));
});

for (const kind of ["credentials", "store_suspended", "schema_mismatch", "timeout", "other"]) {
  test(`could_not_run kind ${kind} renders a distinct could-not-run line`, async () => {
    const j = JSON.stringify({ ...EMPTY, could_not_run: { kind, detail: `detail-${kind}` } });
    const { lines } = await run(stub(`cnr-${kind}.sh`, `echo '${j}'; exit 2`));
    assert.equal(lines.length, 1);
    assert.match(lines[0], new RegExp(`^could not run — .*detail-${kind}$`));
    if (kind !== "other") assert.match(lines[0], new RegExp(kind.replace("_", " ")));
  });
}

test("exit 2 with no JSON yields could-not-run with the first message line", async () => {
  const { lines } = await run(stub("err.sh", `echo "doppler: no token" >&2; exit 2`));
  assert.deepEqual(lines, ["could not run — doppler: no token"]);
});

test("missing script: desk check not installed", async () => {
  const p = path.join(dir, "nope.sh");
  const { lines } = await run(p);
  assert.deepEqual(lines, [`could not run — desk check not installed (${p})`]);
});

test("timeout yields could-not-run, not silence", async () => {
  const { lines } = await run(stub("slow.sh", `sleep 5`), 300);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^could not run — timeout: timed out/);
});

test("unreadable JSON yields could-not-run, not an empty desk", async () => {
  const { lines } = await run(stub("junk.sh", `echo not-json`));
  assert.deepEqual(lines, ["could not run — unreadable output"]);
});

test("exit and payload disagreeing is a broken check, not a result", async () => {
  const one = JSON.stringify({ ...EMPTY, overdue: [{ id: 1, title: "x", age_days: 1 }] });
  assert.match((await run(stub("d1.sh", `echo '${one}'`))).lines[0], /exit 0 but findings/);
  assert.match((await run(stub("d2.sh", `echo '${JSON.stringify(EMPTY)}'; exit 1`))).lines[0], /exit 1 but no findings/);
});

test("--dry-run and a real run produce identical output (read-only)", async () => {
  const j = JSON.stringify({ ...EMPTY, overdue: [{ id: 9, title: "late", age_days: 5 }] });
  const s = stub("same.sh", `echo '${j}'; exit 1`);
  assert.deepEqual((await run(s, undefined, true)).lines, (await run(s, undefined, false)).lines);
});

function snapshotWith(desk) {
  return {
    generatedAt: "2026-11-15T09:00:00.000Z",
    degraded: false,
    suspiciousMarkers: [],
    watcher: { heartbeatMs: Date.now(), ageSeconds: 10, state: "alive" },
    workspaces: [],
    cross: { name: "cross", root: "/fake", counts: { total: 0, open: 0, done: 0, wontfix: 0 }, malformed: 0, quietDays: 0, openRows: [] },
    duplicateOpenAcrossLedgers: { count: 0, examples: [] },
    plist: { checked: true, mismatched: false },
    desk,
  };
}

test("end to end: DESK section prints only when non-empty", () => {
  const sick = formatDigest(computeDiff(snapshotWith({ error: "boom" }), null));
  assert.match(sick, /DESK:\n {2}could not run — boom/);
  const quiet = formatDigest(computeDiff(snapshotWith({ ...EMPTY, could_not_run: undefined }), null));
  assert.doesNotMatch(quiet, /DESK:/);
});
