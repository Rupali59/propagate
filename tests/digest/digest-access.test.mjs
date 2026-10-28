/**
 * ACCESS digest section: accessSnapshot() runs the hub's access-check.sh and
 * accessLines() renders it. Stubs only — the real script is never touched.
 * The property under test: a healthy day prints nothing, and every way the
 * check can fail to RUN prints a "could not run" line (never silence).
 */
// @size medium — starts processes (bash stubs); run when affected
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { accessSnapshotForTest, accessLinesForTest, computeDiff, formatDigest } from "../../digest.mjs";

const dir = mkdtempSync(path.join(tmpdir(), "digest-access-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

function stub(name, body) {
  const p = path.join(dir, name);
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
  return p;
}

async function run(script, timeoutMs) {
  const prev = process.env.PROPAGATE_ACCESS_CHECK;
  process.env.PROPAGATE_ACCESS_CHECK = script;
  try {
    const snap = await accessSnapshotForTest(true, timeoutMs);
    return { snap, lines: accessLinesForTest(snap) };
  } finally {
    if (prev === undefined) delete process.env.PROPAGATE_ACCESS_CHECK;
    else process.env.PROPAGATE_ACCESS_CHECK = prev;
  }
}

test("healthy: exit 0 with no findings yields zero lines", async () => {
  const { snap, lines } = await run(stub("ok.sh", `echo '{"findings":[],"checked":7}'`));
  assert.deepEqual(snap, { findings: [], checked: 7 });
  assert.deepEqual(lines, []);
});

test("exit 1 with two findings yields two lines naming each check", async () => {
  const body = `echo '{"findings":[{"check":"stale-grant","robot":"bot-a","detail":"no use 90d"},{"check":"unknown-property","property":"G-123"}]}'; exit 1`;
  const { lines } = await run(stub("bad.sh", body));
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^stale-grant\b.*bot-a/);
  assert.match(lines[1], /^unknown-property\b.*G-123/);
});

test("exit 2 yields one could-not-run line carrying the first message line", async () => {
  const { lines } = await run(stub("err.sh", `echo "ga credentials expired" >&2; echo more >&2; exit 2`));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^could not run — ga credentials expired$/);
});

test("timeout yields could-not-run, not silence", async () => {
  const { lines } = await run(stub("slow.sh", `sleep 5`), 300);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^could not run — timed out/);
});

test("missing script yields could-not-run", async () => {
  const { lines } = await run(path.join(dir, "nope.sh"));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^could not run — access-check\.sh not found at /);
});

test("unparseable output yields could-not-run", async () => {
  const { lines } = await run(stub("junk.sh", `echo not-json`));
  assert.deepEqual(lines, ["could not run — unreadable output"]);
});

test("long findings are truncated to 140 chars", () => {
  const [l] = accessLinesForTest({ findings: [{ check: "x", detail: "y".repeat(500) }] });
  assert.equal(l.length, 140);
});

function snapshotWith(access) {
  return {
    generatedAt: "2026-10-28T09:00:00.000Z",
    degraded: false,
    suspiciousMarkers: [],
    watcher: { heartbeatMs: Date.now(), ageSeconds: 10, state: "alive" },
    workspaces: [],
    cross: { name: "cross", root: "/fake", counts: { total: 0, open: 0, done: 0, wontfix: 0 }, malformed: 0, quietDays: 0, openRows: [] },
    duplicateOpenAcrossLedgers: { count: 0, examples: [] },
    plist: { checked: true, mismatched: false },
    access,
  };
}

test("end to end: snapshot -> computeDiff -> formatDigest prints ACCESS only when non-empty", () => {
  const sick = formatDigest(computeDiff(snapshotWith({ error: "boom" }), null));
  assert.match(sick, /ACCESS:\n {2}could not run — boom/);
  const healthy = formatDigest(computeDiff(snapshotWith({ findings: [] }), null));
  assert.doesNotMatch(healthy, /ACCESS:/);
});
