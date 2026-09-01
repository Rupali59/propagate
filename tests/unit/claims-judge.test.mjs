/**
 * `judgeStatus` — the four-way partition, and the boundary widened to cover it.
 *
 * THE BOUNDARY MOVED, AND THAT IS THE POINT. The Phase 2 plan called
 * `lib/claims/judge.mjs` "the only place a model belongs". Checked before
 * building: propagate's entire dependency list is ajv, proper-lockfile and yaml,
 * and no file under `lib/` makes a network call. Adding an SDK to classify prose
 * would make every deterministic guarantee here conditional on a remote service.
 *
 * So the line is not "inside vs outside `check.mjs`" — it is inside vs outside
 * THE TOOL. propagate poses the questions and stores the answers; the judge is
 * the caller. Which means the boundary assertion written for `check.mjs` applies
 * to `judge.mjs` verbatim, and this file asserts it rather than exempting the
 * module that was originally planned as the exception.
 *
 * THE FOURTH OUTCOME IS THE ONE A SIMPLER DESIGN DROPS. `orphaned` — verdicts
 * whose block no longer exists in the file — is neither judged nor pending. It is
 * the store's decay mode, and reporting it is what keeps "judged 140 of 151"
 * honest when nine of those verdicts describe paragraphs rewritten last month.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { judgeStatus, asQuestions } from "../../lib/claims/judge.mjs";
import { blockSha } from "../../lib/claims/blocks.mjs";

const JUDGE_SRC = readFileSync(fileURLToPath(new URL("../../lib/claims/judge.mjs", import.meta.url)), "utf8");

// Comments legitimately NAME the forbidden things in order to forbid them, so
// strip them before asserting — otherwise the test fails on its own rationale,
// which is how a guard gets deleted rather than fixed.
const CODE_ONLY = JUDGE_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("lib/claims/judge.mjs imports no model/SDK client", () => {
  for (const forbidden of ["@anthropic-ai", "openai", "anthropic", "langchain"]) {
    assert.equal(
      CODE_ONLY.includes(forbidden),
      false,
      `judge.mjs must not import ${forbidden} — the judge is the CALLER, not this module`,
    );
  }
});

test("lib/claims/judge.mjs makes no network call", () => {
  for (const forbidden of ["fetch(", "node:http", "node:https", "undici"]) {
    assert.equal(CODE_ONLY.includes(forbidden), false, `judge.mjs must not use ${forbidden}`);
  }
});

// ── the partition ───────────────────────────────────────────────────────────

const DOC = ["# Heading", "", "A prose claim.", "", "- a list claim", "", "```", "code();", "```", ""].join("\n");

test("judgeable blocks with no verdict are unjudged; structure is never pending work", async () => {
  const s = await judgeStatus("/fake/doc.md", { readFile: () => DOC });
  assert.equal(s.error, null);
  assert.equal(s.unjudged.length, 2, "one prose + one list item");
  assert.equal(s.judged.length, 0);
  // A heading and a code fence are not claims. Counting them as pending would
  // make every document look like more outstanding work than it holds.
  assert.equal(s.structure.length, 2);
  assert.equal(s.orphaned.length, 0);
});

test("asQuestions carries the FULL block text and the sha to key a verdict to", async () => {
  const s = await judgeStatus("/fake/doc.md", { readFile: () => DOC });
  const qs = asQuestions(s);
  assert.equal(qs.length, 2);
  for (const q of qs) {
    assert.equal(q.sha, blockSha(q.text), "the sha must be the hash of the text handed over");
    assert.ok(q.text.length > 0, "a judge deciding fact-vs-impression needs the sentence, not a summary");
    assert.equal(typeof q.startLine, "number");
  }
});

test("an unreadable file is could-not-run, never 'nothing to judge'", async () => {
  const s = await judgeStatus("/fake/missing.md", { readFile: () => { throw new Error("ENOENT"); } });
  assert.match(s.error, /unreadable/);
  assert.deepEqual(s.unjudged, [], "and it must not present as a clean, empty document");
});

test("a reader returning null is unreadable, not an empty document", async () => {
  const s = await judgeStatus("/fake/x.md", { readFile: () => null });
  assert.match(s.error, /unreadable/, "read-failed and read-and-empty are different facts");
});

test("an empty document is judgeable-with-nothing-in-it, and says so without error", async () => {
  const s = await judgeStatus("/fake/empty.md", { readFile: () => "" });
  assert.equal(s.error, null, "an empty file read successfully is not an error");
  assert.equal(s.unjudged.length, 0);
});

test("editing a block re-opens exactly that block — identity needs no bookkeeping", async () => {
  const before = await judgeStatus("/fake/d.md", { readFile: () => "First claim.\n\nSecond claim.\n" });
  const after = await judgeStatus("/fake/d.md", { readFile: () => "First claim.\n\nSecond claim, amended.\n" });
  const b = before.unjudged.map((x) => x.sha);
  const a = after.unjudged.map((x) => x.sha);
  assert.equal(a[0], b[0], "the untouched block keeps its identity, so its verdict would survive");
  assert.notEqual(a[1], b[1], "the edited block gets a new identity, so it re-opens");
});

test("reflowing a block does NOT re-open it", async () => {
  const before = await judgeStatus("/fake/d.md", { readFile: () => "One claim that is\nwrapped here.\n" });
  const after = await judgeStatus("/fake/d.md", { readFile: () => "One claim\nthat is wrapped here.\n" });
  assert.equal(
    after.unjudged[0].sha,
    before.unjudged[0].sha,
    "a line-width change must not discard a verdict — that is how people stop recording them",
  );
});
