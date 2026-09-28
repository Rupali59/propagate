/**
 * backlog-delegated.test.mjs — a register whose work is deliberately elsewhere.
 *
 * A fourth format, added 2026-09-28. Two registers were rendering RED as "format
 * not recognised" while being perfectly clear to a human, and they were the whole
 * of doctor's `every register can be read and every handover can be closed`
 * failure: `2 file(s) hold work no count can see`.
 *
 * The distinction from its three neighbours is the point:
 *
 *   stub          - says nothing is open
 *   pointer-stub  - says the file MOVED, and names the new path
 *   unrecognised  - the parser could not read it; claims nothing about any state
 *   delegated     - the work EXISTS and is deliberately not here
 *
 * Calling a delegating file `unrecognised` reports the TOOL as broken when the
 * FILE is doing something deliberate. Calling it `stub` asserts nothing is open
 * when plenty is — just not countable from this file. Both are wrong in a
 * direction someone would act on.
 *
 * WHY A FORMAT AND NOT A SPECIAL CASE: this will recur. The hub moved its own
 * rules backlog to an issue tracker the same day, by the same reasoning, and any
 * register that survives a migration to GitHub issues ends up shaped like this.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseTodoLikeFile } from "../../lib/report/backlog.mjs";

test("a register that delegates to an issue tracker parses as delegated, not unrecognised", () => {
  const body = [
    "# TODOS",
    "",
    "**Open work lives in [GitHub issues](https://github.com/o/r/issues), not in this file.**",
    "",
    "This file was the ledger until 2026-09-18. It went stale silently: four of its",
    "twelve entries had already shipped and nothing marked them.",
    "",
    "## Where each entry went",
    "",
    "| was | now |",
    "|---|---|",
    "| Define the finding producer | done |",
  ].join("\n");

  const r = parseTodoLikeFile(body, "/tmp/delegated-TODOS.md");
  assert.equal(r.format, "delegated");
  assert.equal(r.open, 0, "ZERO, not null — the file was read and understood, and holds no open items");
  assert.equal(r.unparsed, null, "it must not be reported as a parser gap");
  assert.equal(
    r.delegatedTo,
    "https://github.com/o/r/issues",
    "the destination must be named, or this is indistinguishable from a stub",
  );
});

test("BOTH halves are required — mentioning a tracker is not delegating", () => {
  // The negative control, and it guards a mistake this file already paid for:
  // STUB_EXPLICIT_RE once matched "no open" at ANY depth and declared propagate's
  // own 43-entry ISSUES.md an empty stub. A register that merely cites its issue
  // tracker while holding real work must keep parsing as whatever it is.
  const body = [
    "# TODOS",
    "",
    "Items are mirrored to GitHub issues for visibility.",
    "",
    "### AB-001 · a real open item",
    "body prose that says nothing conclusive",
  ].join("\n");

  const r = parseTodoLikeFile(body, "/tmp/mentions-TODOS.md");
  assert.notEqual(r.format, "delegated", "a tracker mention without 'not in this file' must not delegate");
  assert.equal(r.open, 1, "and its real item must still be counted");
});

test("the delegation marker must be at the HEAD, not buried in prose", () => {
  const body = [
    "# TODOS",
    "",
    "### AB-002 · a real open item",
    ...Array(40).fill("prose line that says nothing conclusive"),
    "Historically, open work lived in GitHub issues, not in this file.",
  ].join("\n");

  const r = parseTodoLikeFile(body, "/tmp/buried-TODOS.md");
  assert.notEqual(r.format, "delegated", "a marker 40 lines deep is prose about the past, not a declaration");
  assert.equal(r.open, 1);
});

test("delegated is checked BEFORE stub, or a long delegating file falls through", () => {
  // Both real instances ended up `unrecognised` precisely because a delegating
  // file is usually long enough to pass the stub length test. This one also
  // contains a stub phrase, so ordering is the only thing that decides it.
  const body = [
    "# TODOS",
    "",
    "**Open work lives in [the tracker](https://example.test/issues), not in this file.**",
    "nothing open here anymore",
    "x".repeat(600),
  ].join("\n");

  const r = parseTodoLikeFile(body, "/tmp/long-TODOS.md");
  assert.equal(r.format, "delegated", "stub would otherwise claim this on its 'nothing open' phrase");
  assert.equal(r.delegatedTo, "https://example.test/issues");
});

test("a delegating file with no link still names a destination rather than null", () => {
  // `rule:discernment-checks` §2: the whole value of this format over `stub` is
  // that it says where the work went. If the destination were ever null, the two
  // formats would carry the same information and one of them would be redundant.
  const body = [
    "# TODOS",
    "",
    "Open work is tracked in the team's issue tracker, not in this file.",
    "Kept as a signpost so nobody re-opens this as a register.",
  ].join("\n");

  const r = parseTodoLikeFile(body, "/tmp/nolink-TODOS.md");
  assert.equal(r.format, "delegated");
  assert.ok(r.delegatedTo && r.delegatedTo.length > 0, "a delegated register must always name where");
});

test("the real instance parses as delegated — the file this format was built for", () => {
  // The tombstone `migrate --apply` moved into the v3 layout earlier the same day.
  // Its own text is the clearest statement of the format, so it is the fixture.
  const body = [
    "# TODOS",
    "",
    "**Open work lives in [GitHub issues](https://github.com/Rupali59/obsidian-vk-publish/issues), not in this file.**",
    "",
    "This file was the ledger until 2026-09-18. It went stale silently: four of its",
    "twelve entries had already shipped and nothing marked them, and three more",
    "carried references to code that no longer exists. A flat file has no close",
    "action — that is the whole reason for the move.",
  ].join("\n");

  const r = parseTodoLikeFile(body, "/tmp/real-TODOS.md");
  assert.equal(r.format, "delegated");
  assert.equal(r.open, 0);
  assert.match(r.delegatedTo, /obsidian-vk-publish\/issues$/);
});
