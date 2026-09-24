/**
 * index-view.test.mjs — PR-003 §3d.
 *
 * The cross-workspace view that currently needs a bespoke reader per question:
 * open work by workspace, registers by shape, and what could NOT be read.
 *
 * PURE BY CONSTRUCTION. It takes already-read data and returns an answer, so it
 * cannot cache, cannot go stale, and cannot miss a change that happened while it
 * was not looking — `rule:delegation-criteria` §2, which replaced a watcher that
 * ran 4,420 times and found nothing in 4,384 of them. T2 of this plan's
 * measurement contract says that if this ever acquires a cache or a staleness
 * check, a database was the right answer after all.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { indexView } from "../../lib/report/index-view.mjs";

const reg = (o) => ({ kind: "issues", file: "/w/A/ISSUES.md", entries: 0, live: 0, finished: 0, lines: 0, ...o });

test("groups registers by workspace, derived from the path", () => {
  const v = indexView({
    registers: [
      reg({ file: "/hub/A/ISSUES.md", live: 3 }),
      reg({ file: "/hub/A/TODOS.md", kind: "todos", live: 2 }),
      reg({ file: "/hub/B/ISSUES.md", live: 7 }),
    ],
    roots: ["/hub"],
  });
  assert.deepEqual(Object.keys(v.byWorkspace).sort(), ["A", "B"]);
  assert.equal(v.byWorkspace.A.live, 5);
  assert.equal(v.byWorkspace.B.live, 7);
});

test("a register that could NOT be read is UNKNOWN, never zero", () => {
  // rule:discernment-checks §2 and §6. 3 of this tree's 105 register files parse
  // to an unknown shape today; folding them in as 0 is the reader inventing an
  // answer about work it never saw.
  const v = indexView({
    registers: [
      reg({ file: "/hub/A/ISSUES.md", live: 4 }),
      reg({ file: "/hub/A/WEIRD.md", unread: true, reason: "format not recognised", live: 0 }),
    ],
    roots: ["/hub"],
  });
  assert.equal(v.byWorkspace.A.live, 4, "an unreadable register contributes NO count");
  assert.equal(v.byWorkspace.A.unread, 1);
  assert.equal(v.unreadable.length, 1);
  assert.match(v.unreadable[0].reason, /format not recognised/);
});

test("the report states its own corpus — how many files, how many unreadable", () => {
  const v = indexView({ registers: [reg({}), reg({ file: "/hub/A/x.md", unread: true, reason: "nope" })], roots: ["/hub"] });
  assert.equal(v.corpus.files, 2);
  assert.equal(v.corpus.unreadable, 1);
  assert.equal(v.corpus.read, 1);
});

test("an EMPTY corpus is a refusal, not a clean bill of health", () => {
  // The G68 lesson applied to this reader before it can repeat it: zero files and
  // zero findings must not render alike.
  const v = indexView({ registers: [], roots: ["/hub"] });
  assert.equal(v.corpus.files, 0);
  assert.match(v.reason, /no registers/i, "an empty corpus says why, rather than reporting 0 open");
  assert.deepEqual(v.byWorkspace, {});
});

test("by kind, so 'which registers exist at all' needs no new reader", () => {
  const v = indexView({
    registers: [reg({ kind: "issues" }), reg({ kind: "gotchas" }), reg({ kind: "gotchas" })],
    roots: ["/hub"],
  });
  assert.equal(v.byKind.gotchas.files, 2);
  assert.equal(v.byKind.issues.files, 1);
});

test("it holds no state — calling twice on the same input gives the same answer", () => {
  const input = { registers: [reg({ live: 2 })], roots: ["/hub"] };
  assert.deepEqual(indexView(input), indexView(input));
});

test("T2 TRIPWIRE: this module imports NOTHING — no fs, no cache, no state", async () => {
  // The measurement contract's decisive tripwire, made mechanical instead of a
  // promise. T2 says: if the index acquires a cache, a state file or a staleness
  // check, the derive-on-demand premise failed and a database was the right answer
  // after all. That is checkable by reading the imports, so it is checked here
  // rather than left to someone noticing.
  //
  // If a future change genuinely needs persistence, this test going red IS the
  // finding — do not delete it to make room, record it against T2 and reopen
  // PR-003.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../lib/report/index-view.mjs", import.meta.url), "utf8");
  const imports = [...src.matchAll(/^\s*import\s.+$/gm)].map((m) => m[0].trim());
  assert.deepEqual(imports, [], `index-view.mjs must stay pure; it imports:\n  ${imports.join("\n  ")}`);
  for (const forbidden of ["readFileSync", "writeFileSync", "existsSync", "cache", "staleness"]) {
    assert.ok(!new RegExp("\\b" + forbidden + "\\s*\\(").test(src), `index-view.mjs must not call ${forbidden}()`);
  }
});
