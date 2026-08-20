import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendRowWithId, readLedger } from "../../lib/edges/ledger.mjs";

test("appendRowWithId mints unique sequential ids under concurrency", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ledatomic-"));
  const jsonl = path.join(dir, "cross.jsonl");
  const ids = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      appendRowWithId(jsonl, { type: "drift", source: `s${i}`, status: "open" }),
    ),
  );
  const unique = new Set(ids);
  assert.equal(unique.size, 10, "all ids unique — no check-then-act collision");
  const rows = await readLedger(jsonl);
  assert.equal(rows.length, 10);
});
