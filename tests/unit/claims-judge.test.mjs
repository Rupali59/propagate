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

import { judgeStatus, asQuestions, classifyUnjudged } from "../../lib/claims/judge.mjs";
import { blockSha, splitBlocks } from "../../lib/claims/blocks.mjs";
import { appendClaim } from "../../lib/claims/store.mjs";

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

// ── honest degradation: unanswerable vs unjudged (Phase 1) ─────────────────
//
// `judgeStatus` takes an injectable `readRuns` for the same reason `readFile`
// is injectable — these tests never touch the real run-log store, and never
// call the real gbrain-adjacent anything, because there is no such thing to
// call (Premise 1).

function withRuns(records) {
  return async ({ file }) => ({ runs: records.filter((r) => r.file === file) });
}

test("no answering run ever recorded: stays unjudged, runs.count is 0 (THE failing-input case)", async () => {
  const s = await judgeStatus("/fake/never-answered.md", {
    readFile: () => DOC,
    readRuns: withRuns([]),
  });
  assert.equal(s.unanswerable.length, 0);
  assert.equal(s.unjudged.length, 2);
  assert.equal(s.runs.status, "never");
  assert.equal(s.runs.count, 0);
});

test("a run that started and never ended (crashed) turns unjudged blocks unanswerable", async () => {
  const s = await judgeStatus("/fake/crashed.md", {
    readFile: () => DOC,
    readRuns: withRuns([{ file: "/fake/crashed.md", run_id: "R1", phase: "start", ts: "2026-09-14T00:00:00.000Z" }]),
  });
  assert.equal(s.runs.status, "crashed");
  assert.equal(s.unjudged.length, 0, "nothing should still read as plain unjudged");
  assert.equal(s.unanswerable.length, 2, "both judgeable blocks move to unanswerable");
});

for (const outcome of ["no-brain", "error"]) {
  test(`a completed run reporting "${outcome}" turns unjudged blocks unanswerable`, async () => {
    const file = `/fake/completed-${outcome}.md`;
    const s = await judgeStatus(file, {
      readFile: () => DOC,
      readRuns: withRuns([
        { file, run_id: "R1", phase: "start", ts: "2026-09-14T00:00:00.000Z" },
        { file, run_id: "R1", phase: "end", outcome, ts: "2026-09-14T00:00:01.000Z" },
      ]),
    });
    assert.equal(s.runs.status, "completed");
    assert.equal(s.runs.outcome, outcome);
    assert.equal(s.unjudged.length, 0);
    assert.equal(s.unanswerable.length, 2);
  });
}

test('a completed run reporting "ok" leaves remaining gaps as unjudged, NOT unanswerable', async () => {
  // A successful run is not a promise that every block was reached — it is a
  // COVERAGE fact, not an ANSWERABILITY fact. Only a failed/crashed latest run
  // should ever turn "no verdict" into "could not be answered".
  const file = "/fake/completed-ok.md";
  const s = await judgeStatus(file, {
    readFile: () => DOC,
    readRuns: withRuns([
      { file, run_id: "R1", phase: "start", ts: "2026-09-14T00:00:00.000Z" },
      { file, run_id: "R1", phase: "end", outcome: "ok", ts: "2026-09-14T00:00:01.000Z" },
    ]),
  });
  assert.equal(s.runs.status, "completed");
  assert.equal(s.runs.outcome, "ok");
  assert.equal(s.unanswerable.length, 0);
  assert.equal(s.unjudged.length, 2);
});

test("classifyUnjudged treats a missing run summary as unjudged, not unanswerable", () => {
  // judgeStatus never actually calls classifyUnjudged(null) — summarizeRunsForFile
  // always returns an object — but the function is exported and its own guard
  // clause (`!runSummary`) is a real branch a caller could hit directly.
  assert.equal(classifyUnjudged(null), "unjudged");
  assert.equal(classifyUnjudged(undefined), "unjudged");
});

test("a block that already has a verdict stays judged even when the file's latest run crashed", async () => {
  const file = "/fake/verdict-plus-crashed-run.md";
  const blocks = splitBlocks(DOC).filter((b) => b.judgeable);
  await appendClaim({ file, block_sha: blocks[0].sha, kind: "fact", by_kind: "agent" });

  const s = await judgeStatus(file, {
    readFile: () => DOC,
    readRuns: withRuns([{ file, run_id: "R1", phase: "start", ts: "2026-09-14T00:00:00.000Z" }]),
  });
  assert.equal(s.runs.status, "crashed");
  assert.equal(s.judged.length, 1, "a recorded verdict must win over the crashed-run reclassification");
  assert.equal(s.unanswerable.length, 1, "only the block with no verdict is swept into unanswerable");
  assert.equal(s.unjudged.length, 0);
});

test("asQuestions lists unjudged before unanswerable when a status carries both, each keeping its own prior_attempt", () => {
  const status = {
    file: "/fake/mixed.md",
    unjudged: [{ sha: "shaA", kind: "prose", startLine: 1, text: "unjudged one" }],
    unanswerable: [{ sha: "shaB", kind: "prose", startLine: 2, text: "unanswerable one" }],
  };
  const qs = asQuestions(status);
  assert.equal(qs.length, 2);
  assert.equal(qs[0].sha, "shaA");
  assert.equal(qs[0].prior_attempt, false);
  assert.equal(qs[1].sha, "shaB");
  assert.equal(qs[1].prior_attempt, true);
});

test("asQuestions includes unanswerable blocks too, flagged with prior_attempt", async () => {
  const file = "/fake/questions-unanswerable.md";
  const s = await judgeStatus(file, {
    readFile: () => DOC,
    readRuns: withRuns([{ file, run_id: "R1", phase: "start", ts: "2026-09-14T00:00:00.000Z" }]),
  });
  const qs = asQuestions(s);
  assert.equal(qs.length, 2, "still a question, not dropped");
  assert.ok(qs.every((q) => q.prior_attempt === true));
});

test("an unreadable file with a run in flight is NOT reported as never-attempted", async () => {
  // THE COLLAPSE THIS PINS. judgeStatus used to read the document first and
  // return early on failure with a hardcoded `runs: {status: "never"}`, so a
  // file deleted WHILE a run was in flight reported byte-identically to a file
  // nobody ever attempted. That is two states wearing one face
  // (`rule:discernment-checks` §2) inside the module built to prevent it.
  // Found by the ship red-team pass. Runs are now read before the document.
  const inFlight = await judgeStatus("/fake/deleted.md", {
    readFile: () => { throw new Error("ENOENT"); },
    readRuns: async () => ({
      runs: [{ file: "/fake/deleted.md", run_id: "01AAA", phase: "start", ts: new Date().toISOString() }],
    }),
  });
  const neverRun = await judgeStatus("/fake/other.md", {
    readFile: () => { throw new Error("ENOENT"); },
    readRuns: async () => ({ runs: [] }),
  });

  assert.match(inFlight.error ?? "", /unreadable/, "the document is still reported unreadable");
  assert.notEqual(
    inFlight.runs.status,
    "never",
    "a run that started and never ended must not read as 'never attempted' just because the file is gone",
  );
  assert.equal(inFlight.runs.status, "crashed");
  assert.equal(neverRun.runs.status, "never");
  assert.notEqual(
    inFlight.runs.status,
    neverRun.runs.status,
    "attempted-and-crashed must stay distinguishable from never-attempted",
  );
});

test("a failing run-store read degrades to never, it does not take the document down with it", async () => {
  // A failed RUN read is not a failed DOCUMENT read. The document must still
  // be judged; only the run state is unknown.
  const s = await judgeStatus("/fake/doc.md", {
    readFile: () => "# Doc\n\nA judgeable claim.\n",
    readRuns: async () => { throw new Error("run store exploded"); },
  });
  assert.equal(s.error, null, "a broken run store must not fail the whole judgement");
  assert.equal(s.runs.status, "never");
});
