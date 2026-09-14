/**
 * `claimsCounts` — the tree-wide fold doctor renders.
 *
 * WHAT THIS PINS, and why it is not the happy path. The whole reason this
 * module exists is that reading the claim store per file is O(files x
 * store-size) — measured at 754ms across 499 declared sources against 0ms for
 * one whole-store read. So it reads once and hands each file a slice. Two
 * things can go wrong with that shape and both are silent:
 *
 *   1. The per-file slice loses information the whole-store read had. It did:
 *      the injected reader hardcoded `malformed: 0` and the accumulator had no
 *      field for it, so corrupt lines were counted at the store layer and
 *      binned here. `store.mjs`'s stated premise is "corrupt lines COUNTED as
 *      read, never silently skipped"; upholding that at one layer and dropping
 *      it at the next is the same silence one floor up. Found by the ship
 *      red-team pass.
 *   2. A store-wide number gets counted per file and multiplied by the file
 *      count. `malformed` is taken ONCE, outside the loop, for that reason —
 *      and the multi-file test below is what would catch a regression to
 *      per-file accumulation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { claimsCounts } from "../../lib/report/claims.mjs";

/** Readers that never touch disk, so these assertions are about the fold only. */
const readers = (claims = [], runs = [], { claimsMalformed = 0, runsMalformed = 0 } = {}) => ({
  readClaims: async () => ({ claims, malformed: claimsMalformed, storeExists: true }),
  readRuns: async () => ({ runs, malformed: runsMalformed }),
});

test("corrupt lines survive the fold — counted at the store, still counted here", async () => {
  const out = await claimsCounts(["/fake/a.md"], readers([], [], { claimsMalformed: 3, runsMalformed: 2 }));
  assert.equal(out.malformed, 5, "3 malformed claims + 2 malformed runs must both reach the caller");
});

test("malformed is store-wide, counted once — never multiplied by the file count", async () => {
  // The regression this guards: moving the malformed read inside the per-file
  // loop. With 4 files and 3 corrupt lines that would report 12.
  const out = await claimsCounts(
    ["/fake/a.md", "/fake/b.md", "/fake/c.md", "/fake/d.md"],
    readers([], [], { claimsMalformed: 3 }),
  );
  assert.equal(out.files, 4);
  assert.equal(out.malformed, 3, "one store-wide count, not one per file");
});

test("an empty corpus returns the full shape, not a bare zero", async () => {
  // "Nothing declared" must be answerable with the same keys as any other
  // result, so a caller never has to distinguish undefined from 0.
  const out = await claimsCounts([]);
  for (const k of ["files", "judged", "unjudged", "unanswerable", "runs", "unreadable", "malformed"]) {
    assert.ok(Object.prototype.hasOwnProperty.call(out, k), `empty result must carry '${k}'`);
  }
  assert.equal(out.files, 0);
});

test("a file whose document cannot be read counts as unreadable, never as judged", async () => {
  // `unreadable` is its own bucket: a reader that failed is not an empty file.
  const out = await claimsCounts(["/definitely/not/a/real/path.md"], readers());
  assert.equal(out.unreadable, 1);
  assert.equal(out.judged, 0);
  assert.equal(out.unjudged, 0);
});

test("non-string file fields are dropped from grouping, not crashed on", async () => {
  // groupByFile skips records with no usable `file`. The property under test is
  // that a malformed record cannot take the whole census down.
  const out = await claimsCounts(
    ["/fake/a.md"],
    readers([{ file: null, block_sha: "x" }, { file: 42, block_sha: "y" }], []),
  );
  assert.equal(out.files, 1, "the census still completes");
});
