import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendRow, markStatus, hasOpenDuplicateDrift } from "../lib/ledger.mjs";

test("hasOpenDuplicateDrift — detects an identical OPEN drift row", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "dedup-"));
  const jsonl = path.join(dir, "ledger.jsonl");
  await appendRow(jsonl, {
    type: "drift",
    id: "001",
    source: "docs/CONTENT_SPEC.md",
    downstream: [{ path: "ia/PAGE_HIERARCHY.md", why: "x", kind: "prose" }],
    status: "open",
  });

  // same source + same downstream set → duplicate
  assert.equal(
    await hasOpenDuplicateDrift(jsonl, "docs/CONTENT_SPEC.md", ["ia/PAGE_HIERARCHY.md"]),
    true,
  );
  // different downstream set → not a duplicate
  assert.equal(
    await hasOpenDuplicateDrift(jsonl, "docs/CONTENT_SPEC.md", ["other.md"]),
    false,
  );
  // different source → not a duplicate
  assert.equal(
    await hasOpenDuplicateDrift(jsonl, "docs/OTHER.md", ["ia/PAGE_HIERARCHY.md"]),
    false,
  );
});

test("hasOpenDuplicateDrift — a done row is not a duplicate (re-fire allowed)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "dedup2-"));
  const jsonl = path.join(dir, "ledger.jsonl");
  await appendRow(jsonl, {
    type: "drift",
    id: "001",
    source: "s.md",
    downstream: [{ path: "d.md", why: "x", kind: "prose" }],
    status: "open",
  });
  await markStatus(jsonl, "001", "done", { closed_by: "drain" });
  assert.equal(await hasOpenDuplicateDrift(jsonl, "s.md", ["d.md"]), false);
});

test("hasOpenDuplicateDrift — order-independent downstream comparison", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "dedup3-"));
  const jsonl = path.join(dir, "ledger.jsonl");
  await appendRow(jsonl, {
    type: "drift",
    id: "001",
    source: "s.md",
    downstream: [
      { path: "a.md", why: "x", kind: "prose" },
      { path: "b.md", why: "y", kind: "prose" },
    ],
    status: "open",
  });
  assert.equal(await hasOpenDuplicateDrift(jsonl, "s.md", ["b.md", "a.md"]), true);
});

test("hasOpenDuplicateDrift — missing ledger file returns false", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "dedup4-"));
  assert.equal(
    await hasOpenDuplicateDrift(path.join(dir, "nope.jsonl"), "s.md", ["d.md"]),
    false,
  );
});
