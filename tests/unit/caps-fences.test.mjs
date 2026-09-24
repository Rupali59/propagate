/**
 * caps-fences.test.mjs — PR-003 §3b.
 *
 * `countEntries` strips fenced blocks before counting `### ` headings, and its
 * own comment says why: "propagate's own N51 was this bug one file over:
 * `parseHandovers` read fenced EXAMPLES as real sections."
 *
 * It strips them with `replace(/^```[\s\S]*?^```/gm, "")`, which is weaker than
 * the rule it is defending in TWO ways — both of which reintroduce N51 in the
 * file that cites it:
 *
 *   1. only ``` is handled. A `~~~` fence is not a fence to this regex.
 *   2. it requires a CLOSING fence. An unterminated one strips nothing, so every
 *      heading after it counts.
 *
 * `lib/docs/tokens.mjs` handles both, because `handovers.mjs` paid for them.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { countEntries } from "../../lib/report/caps.mjs";

const doc = (...l) => l.join("\n");

test("a ``` fenced heading is not counted — the case that already worked", () => {
  assert.equal(countEntries(doc("### Real", "```", "### Example", "```")), 1);
});

test("a ~~~ fenced heading must not be counted either", () => {
  assert.equal(
    countEntries(doc("### Real", "~~~", "### Example inside a tilde fence", "~~~")),
    1,
    "~~~ is a markdown fence; a counter that only knows ``` reintroduces N51",
  );
});

test("an UNTERMINATED fence must not leak every heading after it", () => {
  assert.equal(
    countEntries(doc("### Real", "```", "### Example", "### Another example")),
    1,
    "an unterminated fence swallows the rest of the document; stripping nothing counts illustrations as entries",
  );
});

test("ordinary counting still works", () => {
  assert.equal(countEntries(doc("### One", "body", "### Two", "### Three")), 3);
  assert.equal(countEntries(""), 0);
});
