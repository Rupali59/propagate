import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  appendRow,
  markStatus,
  readLedger,
  lastActivityAt,
  readLedgerWithStats,
} from "../lib/ledger.mjs";

test("lastActivityAt returns the last physical line's timestamp even when a status_change postdates every drift row", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ledactivity-"));
  const jsonl = path.join(dir, "cross.jsonl");
  // Mirrors the real cross-ledger shape: drift rows stamped early, then a
  // batch of status_change rows appended much later.
  const lines = [
    { type: "drift", id: "001", status: "open", timestamp: "2026-07-13T06:55:15.057Z" },
    { type: "drift", id: "002", status: "open", timestamp: "2026-07-13T06:55:15.058Z" },
    { type: "status_change", id: "001", status: "wontfix", timestamp: "2026-07-13T09:06:50.231Z" },
    { type: "status_change", id: "002", status: "done", timestamp: "2026-07-13T09:06:50.233Z" },
  ];
  await writeFile(jsonl, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

  const rows = await readLedger(jsonl);
  // readLedger sorts by drift timestamp and drops status_change rows from
  // its output — its "last" row is the oldest-looking thing, not the truth.
  assert.equal(rows[rows.length - 1].timestamp, "2026-07-13T06:55:15.058Z");

  const activity = await lastActivityAt(jsonl);
  assert.equal(activity, "2026-07-13T09:06:50.233Z");
  assert.notEqual(activity, rows[rows.length - 1].timestamp);
});

test("lastActivityAt returns null for a missing file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ledactivity-"));
  const jsonl = path.join(dir, "does-not-exist.jsonl");
  assert.equal(await lastActivityAt(jsonl), null);
});

test("lastActivityAt returns null for an empty file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ledactivity-"));
  const jsonl = path.join(dir, "empty.jsonl");
  await writeFile(jsonl, "");
  assert.equal(await lastActivityAt(jsonl), null);
});

test("lastActivityAt tolerates a trailing malformed line and returns the last good one", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ledactivity-"));
  const jsonl = path.join(dir, "trailing-bad.jsonl");
  const good = { type: "drift", id: "001", status: "open", timestamp: "2026-07-13T06:55:15.057Z" };
  const content = JSON.stringify(good) + "\n" + '{"type":"drift","id":"002",' + "\n";
  await writeFile(jsonl, content);
  assert.equal(await lastActivityAt(jsonl), "2026-07-13T06:55:15.057Z");
});

test("markStatus with notes persists them; readLedger output shape is unchanged", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ledactivity-"));
  const jsonl = path.join(dir, "notes.jsonl");
  await appendRow(jsonl, {
    type: "drift",
    id: "001",
    source: "docs/FOO.md",
    status: "open",
  });
  await markStatus(jsonl, "001", "wontfix", "deferred pending migration manifest");

  const raw = await readFile(jsonl, "utf8");
  const lastLine = raw.trim().split("\n").pop();
  const parsed = JSON.parse(lastLine);
  assert.equal(parsed.type, "status_change");
  assert.equal(parsed.status, "wontfix");
  assert.equal(parsed.notes, "deferred pending migration manifest");

  const rows = await readLedger(jsonl);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "wontfix");
  assert.equal(rows[0].notes, undefined, "readLedger never copies notes off status_change rows");
});

test("markStatus without notes still works (backward compat)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ledactivity-"));
  const jsonl = path.join(dir, "no-notes.jsonl");
  await appendRow(jsonl, {
    type: "drift",
    id: "001",
    source: "docs/BAR.md",
    status: "open",
  });
  await markStatus(jsonl, "001", "done");

  const raw = await readFile(jsonl, "utf8");
  const lastLine = raw.trim().split("\n").pop();
  const parsed = JSON.parse(lastLine);
  assert.equal(parsed.type, "status_change");
  assert.equal(parsed.status, "done");
  assert.ok(!("notes" in parsed), "no notes key written when notes is omitted");

  const rows = await readLedger(jsonl);
  assert.equal(rows[0].status, "done");
});

test("readLedgerWithStats counts malformed lines and unknown types", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ledactivity-"));
  const jsonl = path.join(dir, "mixed.jsonl");
  const lines = [
    JSON.stringify({ type: "drift", id: "001", status: "open", timestamp: "2026-01-01T00:00:00.000Z" }),
    JSON.stringify({ type: "manual", id: "256", source: "workspace-event", timestamp: "2026-01-02T00:00:00.000Z" }),
    JSON.stringify({ type: "wontfix-bulk", id: "999", timestamp: "2026-01-03T00:00:00.000Z" }),
    '{"type":"drift","id":"broken",', // malformed
    JSON.stringify({ type: "status_change", id: "001", status: "done", timestamp: "2026-01-04T00:00:00.000Z" }),
  ];
  await writeFile(jsonl, lines.join("\n") + "\n");

  const stats = await readLedgerWithStats(jsonl);
  assert.equal(stats.malformed, 1);
  assert.deepEqual(stats.unknownTypes, { manual: 1, "wontfix-bulk": 1 });
  assert.equal(stats.rows.length, 1);
  assert.equal(stats.rows[0].status, "done");
});

test("readLedgerWithStats on a healthy file reports zero malformed and no unknown types", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ledactivity-"));
  const jsonl = path.join(dir, "clean.jsonl");
  await appendRow(jsonl, { type: "drift", id: "001", source: "a.md", status: "open" });
  const stats = await readLedgerWithStats(jsonl);
  assert.equal(stats.malformed, 0);
  assert.deepEqual(stats.unknownTypes, {});
  assert.equal(stats.rows.length, 1);
});
