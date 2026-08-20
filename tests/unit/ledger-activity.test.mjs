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
} from "../../lib/edges/ledger.mjs";

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

test("markStatus with notes persists them; the fold NOW carries notes onto the Event (inverted from prior lossy behaviour — see docs/DATA_MODEL.md §4-§6)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ledactivity-"));
  const jsonl = path.join(dir, "notes.jsonl");
  await appendRow(jsonl, {
    type: "drift",
    id: "001",
    source: "docs/FOO.md",
    status: "open",
  });
  await markStatus(jsonl, "001", "wontfix", {
    notes: "deferred pending migration manifest",
    closed_by: "wontfix",
    wontfix_reason: "blocked on migration manifest",
  });

  const raw = await readFile(jsonl, "utf8");
  const lastLine = raw.trim().split("\n").pop();
  const parsed = JSON.parse(lastLine);
  assert.equal(parsed.type, "status_change");
  assert.equal(parsed.status, "wontfix");
  assert.equal(parsed.notes, "deferred pending migration manifest");

  const rows = await readLedger(jsonl);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "wontfix");
  // Was: assert.equal(rows[0].notes, undefined, "readLedger never copies
  // notes off status_change rows"). That assertion documented a bug: the
  // fold dropped every Transition field but `status`. The fold now carries
  // `notes` (plus `closed_by`/`wontfix_reason`/`closed_at`) forward, so this
  // is the fix landing, not a regression.
  assert.equal(rows[0].notes, "deferred pending migration manifest");
  assert.equal(rows[0].closed_by, "wontfix");
  assert.equal(rows[0].wontfix_reason, "blocked on migration manifest");
});

test("markStatus without notes still works (backward compat) — terminal close requires closed_by", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ledactivity-"));
  const jsonl = path.join(dir, "no-notes.jsonl");
  await appendRow(jsonl, {
    type: "drift",
    id: "001",
    source: "docs/BAR.md",
    status: "open",
  });
  await markStatus(jsonl, "001", "done", { closed_by: "drain" });

  const raw = await readFile(jsonl, "utf8");
  const lastLine = raw.trim().split("\n").pop();
  const parsed = JSON.parse(lastLine);
  assert.equal(parsed.type, "status_change");
  assert.equal(parsed.status, "done");
  assert.ok(!("notes" in parsed), "no notes key written when notes is omitted");

  const rows = await readLedger(jsonl);
  assert.equal(rows[0].status, "done");
  assert.equal(rows[0].closed_by, "drain");
});

test("markStatus: wontfix without wontfix_reason throws, naming the row id", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ledactivity-"));
  const jsonl = path.join(dir, "wontfix-no-reason.jsonl");
  await appendRow(jsonl, { type: "drift", id: "001", source: "a.md", status: "open" });

  await assert.rejects(
    () => markStatus(jsonl, "001", "wontfix", { closed_by: "wontfix" }),
    (err) => {
      assert.match(err.message, /001/);
      assert.match(err.message, /wontfix_reason/);
      return true;
    },
  );

  // Legacy string form (means `notes`) must also throw — no wontfix_reason
  // route around the requirement.
  await assert.rejects(
    () => markStatus(jsonl, "001", "wontfix", "just a note, no reason"),
    /wontfix_reason/,
  );
});

test("markStatus: terminal close without closed_by throws; invalid closed_by throws", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ledactivity-"));
  const jsonl = path.join(dir, "no-closed-by.jsonl");
  await appendRow(jsonl, { type: "drift", id: "001", source: "a.md", status: "open" });

  await assert.rejects(
    () => markStatus(jsonl, "001", "done"),
    (err) => {
      assert.match(err.message, /001/);
      assert.match(err.message, /closed_by/);
      return true;
    },
  );

  await assert.rejects(
    () => markStatus(jsonl, "001", "wontfix", { wontfix_reason: "x", closed_by: "bogus" }),
    /closed_by/,
  );

  // partial and open require neither wontfix_reason nor closed_by.
  await markStatus(jsonl, "001", "partial");
  await markStatus(jsonl, "001", "open");
  const rows = await readLedger(jsonl);
  assert.equal(rows[0].status, "open");
});

test("markStatus: legacy string 4th arg still works for non-terminal statuses", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ledactivity-"));
  const jsonl = path.join(dir, "legacy-string.jsonl");
  await appendRow(jsonl, { type: "drift", id: "001", source: "a.md", status: "open" });
  await markStatus(jsonl, "001", "partial", "waiting on review");

  const rows = await readLedger(jsonl);
  assert.equal(rows[0].status, "partial");
  assert.equal(rows[0].notes, "waiting on review");
});

test("markStatus: unknown id throws, naming both the id and the ledger path (N4)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ledactivity-"));
  const jsonl = path.join(dir, "unknown-id.jsonl");
  await appendRow(jsonl, { type: "drift", id: "001", source: "a.md", status: "open" });

  await assert.rejects(
    () => markStatus(jsonl, "999", "done", { closed_by: "drain" }),
    (err) => {
      assert.match(err.message, /999/, "message names the unknown id");
      assert.match(err.message, new RegExp(jsonl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "message names the ledger path");
      return true;
    },
  );

  // No status_change was appended for the bad id — writer refused, not
  // silently no-op'd. The known row is untouched too.
  const rows = await readLedger(jsonl);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "001");
  assert.equal(rows[0].status, "open");
});

test("markStatus: known id still works after the N4 existence check (regression)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ledactivity-"));
  const jsonl = path.join(dir, "known-id.jsonl");
  await appendRow(jsonl, { type: "drift", id: "001", source: "a.md", status: "open" });

  await markStatus(jsonl, "001", "done", { closed_by: "drain" });

  const rows = await readLedger(jsonl);
  assert.equal(rows[0].status, "done");
});

test("fold carries closed_by, wontfix_reason, notes, and closed_at onto the Event", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fold-fixture-"));
  const jsonl = path.join(dir, "ledger.jsonl");
  const lines = [
    { type: "drift", id: "001", source: "a.md", status: "open", timestamp: "2026-08-01T00:00:00.000Z" },
    {
      type: "status_change",
      id: "001",
      status: "wontfix",
      timestamp: "2026-08-05T12:00:00.000Z",
      closed_by: "wontfix",
      wontfix_reason: "not applicable anymore",
      notes: "checked with owner first",
    },
  ];
  await writeFile(jsonl, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

  const rows = await readLedger(jsonl);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "wontfix");
  assert.equal(rows[0].closed_by, "wontfix");
  assert.equal(rows[0].wontfix_reason, "not applicable anymore");
  assert.equal(rows[0].notes, "checked with owner first");
  // closed_at is the Transition's timestamp, distinct from the Event's own
  // timestamp (when the drift fired).
  assert.equal(rows[0].closed_at, "2026-08-05T12:00:00.000Z");
  assert.equal(rows[0].timestamp, "2026-08-01T00:00:00.000Z");
  assert.notEqual(rows[0].closed_at, rows[0].timestamp);
});

test("fold: a Transition with both note (singular) and notes yields both, neither dropped", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fold-note-"));
  const jsonl = path.join(dir, "ledger.jsonl");
  const lines = [
    { type: "drift", id: "001", source: "a.md", status: "open", timestamp: "2026-08-01T00:00:00.000Z" },
    {
      type: "status_change",
      id: "001",
      status: "wontfix",
      timestamp: "2026-08-02T00:00:00.000Z",
      closed_by: "wontfix",
      wontfix_reason: "superseded",
      notes: "primary note",
      note: "legacy singular note",
    },
  ];
  await writeFile(jsonl, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

  const rows = await readLedger(jsonl);
  assert.match(rows[0].notes, /primary note/);
  assert.match(rows[0].notes, /legacy singular note/);
});

test("fold: a later transition wins over an earlier one for the same id", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fold-later-wins-"));
  const jsonl = path.join(dir, "ledger.jsonl");
  const lines = [
    { type: "drift", id: "001", source: "a.md", status: "open", timestamp: "2026-08-01T00:00:00.000Z" },
    {
      type: "status_change",
      id: "001",
      status: "partial",
      timestamp: "2026-08-02T00:00:00.000Z",
      notes: "first pass",
    },
    {
      type: "status_change",
      id: "001",
      status: "done",
      timestamp: "2026-08-03T00:00:00.000Z",
      closed_by: "drain",
      notes: "second pass, actually done",
    },
  ];
  await writeFile(jsonl, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

  const rows = await readLedger(jsonl);
  assert.equal(rows[0].status, "done");
  assert.equal(rows[0].closed_by, "drain");
  assert.equal(rows[0].notes, "second pass, actually done");
  assert.equal(rows[0].closed_at, "2026-08-03T00:00:00.000Z");
});

test("readLedgerWithStats counts malformed lines and unknown types", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ledactivity-"));
  const jsonl = path.join(dir, "mixed.jsonl");
  const lines = [
    JSON.stringify({ type: "drift", id: "001", status: "open", timestamp: "2026-01-01T00:00:00.000Z" }),
    JSON.stringify({ type: "not-a-real-type", id: "256", source: "workspace-event", timestamp: "2026-01-02T00:00:00.000Z" }),
    JSON.stringify({ type: "wontfix-bulk", id: "999", timestamp: "2026-01-03T00:00:00.000Z" }),
    '{"type":"drift","id":"broken",', // malformed
    JSON.stringify({ type: "status_change", id: "001", status: "done", timestamp: "2026-01-04T00:00:00.000Z" }),
  ];
  await writeFile(jsonl, lines.join("\n") + "\n");

  const stats = await readLedgerWithStats(jsonl);
  assert.equal(stats.malformed, 1);
  assert.deepEqual(stats.unknownTypes, { "not-a-real-type": 1, "wontfix-bulk": 1 });
  assert.equal(stats.rows.length, 1);
  assert.equal(stats.rows[0].status, "done");
});

test("a `manual` row is known, is NOT folded as drift, and is returned separately", async () => {
  // Regression for docs/ISSUES.md N1 + N2. `manual` is a terminal-only
  // hand-authored annotation. Two things must hold at once, and the second
  // is the one that is easy to get wrong:
  //
  //   1. It must NOT count as an unknown type (N1 — it was invisible to
  //      readLedger for two months, and doctor now fails on unknown types).
  //   2. It must NOT enter the drift fold. The real instance shares id "256"
  //      with a genuine `drift` row (N2), so admitting it would let the two
  //      overwrite each other by file order — turning an invisible row into
  //      a corrupted one. This fixture reproduces that exact id collision.
  // BOTH orders are exercised deliberately. With the manual row FIRST the
  // drift row overwrites it and the bug is invisible — that ordering alone
  // is a check that cannot fail (rule:discernment-checks §1), and the first
  // draft of this test made exactly that mistake. The manual-LAST ordering
  // is the one that silently destroys a real open drift row.
  const manualRow = { type: "manual", id: "256", source: "workspace-event", status: "wontfix", change: "renamed a project", timestamp: "2026-01-01T00:00:00.000Z" };
  const driftRow = { type: "drift", id: "256", source: "docs/MEASUREMENT.md", status: "open", timestamp: "2026-01-02T00:00:00.000Z" };

  for (const [label, lines] of [
    ["manual first", [manualRow, driftRow]],
    ["manual last", [driftRow, manualRow]],
  ]) {
    const dir = await mkdtemp(path.join(tmpdir(), "ledactivity-"));
    const jsonl = path.join(dir, "manual.jsonl");
    await writeFile(jsonl, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

    const stats = await readLedgerWithStats(jsonl);

    assert.deepEqual(stats.unknownTypes, {}, `${label}: \`manual\` must not count as unknown (N1)`);
    assert.equal(stats.manual.length, 1, `${label}: the manual row is returned separately`);
    assert.equal(stats.manual[0].source, "workspace-event", `${label}: manual row intact`);

    // The colliding drift row survives intact and is the only folded row,
    // regardless of which came first in the file.
    assert.equal(stats.rows.length, 1, `${label}: only the drift row folds`);
    assert.equal(stats.rows[0].source, "docs/MEASUREMENT.md", `${label}: the manual row did not overwrite the drift row (N2)`);
    assert.equal(stats.rows[0].status, "open", `${label}: the open drift row is still open`);
  }
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
