/**
 * staging-heading-coupling.test.mjs
 *
 * `lib/reminders/sync.mjs` WRITES `STAGING_HEADING`. `lib/report/backlog.mjs`
 * READS it, via a `PROPOSED_SECTION_RE` that lives in the other module and is
 * not exported. Two lanes built those on 2026-09-25 without coordinating, and
 * they agree — "## From Reminders (unreviewed)" happens to contain "unreview".
 *
 * Lane 1's own report called that luck and asked for it to be confirmed rather
 * than assumed. This is the confirmation, and it is deliberately BEHAVIOURAL
 * rather than a string comparison: the property that matters is not that two
 * regexes look alike, it is that the reader classifies what the writer writes.
 * A future rewording of either side that breaks the pairing fails here.
 *
 * `rule:adversarial-review-reads-the-ledger`: a promise in one file that
 * another file has to keep. Nothing else in the suite sees across this seam --
 * sync's tests use sync's constant, and backlog's tests use backlog's regex, so
 * both would stay green while the two drifted apart.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { STAGING_HEADING } from "../../lib/reminders/sync.mjs";
import { parseTodoLikeFile, proposedSectionLines } from "../../lib/report/backlog.mjs";

/** A register in propagate's own convention, with one open entry and one staged. */
function register(heading) {
  return [
    "# TODOS — fixture",
    "",
    "### PR-900 · a real open item",
    "body prose that says nothing conclusive",
    "",
    heading,
    "",
    "### PR-901 · a staged item from a reminder",
    "arrived from Reminders, nobody has reviewed it",
    "",
  ].join("\n");
}

test("the reader treats the heading the writer writes as a staging section", () => {
  const lines = register(STAGING_HEADING).split("\n");
  const proposed = proposedSectionLines(lines);

  const stagedIdx = lines.findIndex((l) => l.includes("PR-901"));
  const openIdx = lines.findIndex((l) => l.includes("PR-900"));
  assert.ok(stagedIdx > 0 && openIdx > 0, "fixture lost its entries — this check has gone blind");

  assert.ok(
    proposed.has(stagedIdx + 1),
    `backlog.mjs does not recognise sync.mjs's STAGING_HEADING (${JSON.stringify(STAGING_HEADING)}) ` +
      `as a staging section. The two modules have drifted apart: anything staged under that heading ` +
      `would be counted as ordinary OPEN work.`,
  );
  assert.ok(!proposed.has(openIdx + 1), "the entry above the heading must not be swept into it");
});

test("a staged entry parses as proposed — neither open nor closed", () => {
  const r = parseTodoLikeFile(register(STAGING_HEADING), "/tmp/fixture-TODOS.md");

  assert.equal(r.proposed, 1, `expected exactly one proposed entry, got ${r.proposed}`);
  assert.equal(r.open, 1, "the pre-existing entry must stay open and must not be counted twice");
  assert.equal(r.closed, 0, "a staged entry is not closed — proposed is a third fact");

  const ids = r.items.map((i) => i.id);
  assert.ok(ids.includes("PR-900"), "the open entry must still be reported");
  assert.ok(!ids.includes("PR-901"), "a proposed entry must not appear in the open item list");
});

test("the binding is real: an unrecognised heading is NOT treated as staging", () => {
  // The negative control. If this passed too, the first test would prove
  // nothing -- it would just mean everything is a staging section.
  const lines = register("## Some Other Section").split("\n");
  const proposed = proposedSectionLines(lines);
  const stagedIdx = lines.findIndex((l) => l.includes("PR-901"));

  assert.ok(
    !proposed.has(stagedIdx + 1),
    "an arbitrary heading was read as a staging section — the reader's match is too broad",
  );

  const r = parseTodoLikeFile(register("## Some Other Section"), "/tmp/fixture-TODOS.md");
  assert.equal(r.proposed, 0);
  assert.equal(r.open, 2, "under an ordinary heading both entries are ordinary open work");
});
