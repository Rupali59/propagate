// N2 — watcher.mjs's two primary drift paths used to do nextId() (read,
// unlocked) then appendRow() (lock, append) as two separate steps, leaving a
// check-then-act gap. Concurrent watcher invocations (WatchPaths fire +
// StartInterval timer fire, per docs/ISSUES.md N2) could both read the same
// max and mint the same id — this produced the real duplicate id 256 in the
// Vipin Kaushik ledger. The fix switches both drift paths to
// appendRowWithId, which computes max+1 INSIDE the lock. This test proves
// the atomic path is race-free under real concurrency, and (best-effort)
// demonstrates the old two-step pattern actually collides.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendRowWithId, appendRow, nextId, readLedger } from "../../lib/edges/ledger.mjs";

test("appendRowWithId: N concurrent writers against a seeded ledger mint N distinct ids, no collisions", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "watcher-race-"));
  const jsonl = path.join(dir, "PROPAGATION_LEDGER.jsonl");

  // Seed a few rows first, like a real ledger with prior history.
  await appendFile(
    jsonl,
    ["001", "002", "003"]
      .map((id) => JSON.stringify({ type: "drift", id, source: `seed-${id}`, status: "open" }) + "\n")
      .join(""),
  );

  const N = 20;
  const ids = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      appendRowWithId(jsonl, { type: "drift", source: `concurrent-${i}`, status: "open" }),
    ),
  );

  const unique = new Set(ids);
  assert.equal(unique.size, N, "all minted ids must be distinct — a collision means the race reopened");

  const rows = await readLedger(jsonl);
  // 3 seed rows + N concurrent rows, all landed.
  assert.equal(rows.length, 3 + N, "every concurrent append must land — none silently dropped");

  // Minted ids must continue on from the seeded max (003), not restart.
  for (const id of ids) {
    assert.ok(parseInt(id, 10) > 3, `minted id ${id} must be greater than seeded max 003`);
  }
});

test("old pattern (nextId then appendRow, two separate steps) can collide under concurrency", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "watcher-race-old-"));
  const jsonl = path.join(dir, "PROPAGATION_LEDGER.jsonl");

  const N = 20;
  const results = await Promise.allSettled(
    Array.from({ length: N }, async (_, i) => {
      const id = await nextId(jsonl); // read, unlocked — the check-then-act gap
      await appendRow(jsonl, { type: "drift", id, source: `concurrent-${i}`, status: "open" });
      return id;
    }),
  );

  const ids = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
  const unique = new Set(ids);

  // This is the bug: with the racy two-step pattern, N concurrent writers do
  // NOT reliably mint N distinct ids. If this assertion ever fails (i.e. the
  // old pattern stops colliding), that's not a regression in the fix — it
  // just means this demonstration got lucky on timing. The real fix is
  // covered by the appendRowWithId test above regardless of what this one
  // shows.
  assert.ok(
    unique.size < N,
    "expected the old nextId()+appendRow() pattern to collide under concurrency (demonstrating the bug this fix closes); " +
      "if this fails, the demonstration was timing-lucky, not proof the race is gone — see the appendRowWithId test above for the actual regression guard",
  );
});
