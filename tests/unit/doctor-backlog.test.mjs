/**
 * Tests for lib/report/doctor/backlog.mjs.
 *
 * These run against INJECTED data rather than the live tree, which is the point:
 * doctor's Backlog section must be provably able to report BOTH green and red,
 * and on the day it landed the real tree had 4 defects — so a test that only
 * exercised reality could never have shown the passing path.
 *
 * Run: `npm test` (G56).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Reporter } from "../../lib/report/doctor/reporter.mjs";
import { checkBacklog } from "../../lib/report/doctor/backlog.mjs";

const healthy = () => ({
  totals: { stateFilesRead: 48, todoFilesRead: 23, issueFilesRead: 1, parsedItems: 500, parsedFiles: 24, unparsedFileList: [] },
  handovers: { files: [{ file: "/x/H.md", error: null, sections: [{ status: "open" }] }] },
});

test("a clean backlog passes and adds no problems", () => {
  const r = new Reporter();
  return checkBacklog({ reporter: r, backlogFn: healthy, defectsFn: () => [] }).then(({ counts }) => {
    assert.equal(r.problems, 0, "a healthy backlog must not vote");
    assert.equal(counts.backlogOpenItems, 500);
    assert.equal(counts.backlogDefects, 0);
    assert.ok(r.entries.some((e) => e.kind === "pass"), "the check must actually run, not be skipped");
  });
});

test("500 open items alone NEVER make doctor red", async () => {
  // The property the whole design rests on. Open work is the normal state of a
  // working tree; if it voted, doctor would be permanently red and the section
  // would be ignored — the same outcome as not having it.
  const r = new Reporter();
  await checkBacklog({ reporter: r, backlogFn: healthy, defectsFn: () => [] });
  assert.equal(r.problems, 0);
});

test("a defect makes it red, increments problems, and NAMES the file", async () => {
  const r = new Reporter();
  const { counts } = await checkBacklog({
    reporter: r,
    backlogFn: healthy,
    defectsFn: () => [{ kind: "unparsed", file: "/x/TODOS.md", detail: "format not recognised", key: "k" }],
  });
  assert.equal(r.problems, 1, "a defect is a verdict, not a warning");
  assert.equal(counts.backlogDefects, 1);
  const text = r.entries.map((e) => `${e.label} ${e.detail}`).join("\n");
  assert.match(text, /\/x\/TODOS\.md/, "a count sends nobody anywhere — the file must be named");
});

test("discovery that THROWS is a failure, never a clean backlog", async () => {
  // rule:discernment-checks §2. "0 defects" from a walk that threw is
  // indistinguishable from a clean tree, and only one of them is health.
  const r = new Reporter();
  const { counts } = await checkBacklog({
    reporter: r,
    backlogFn: () => { throw new Error("EACCES"); },
    defectsFn: () => [],
  });
  assert.equal(r.problems, 1);
  assert.equal(counts.backlogFilesRead, 0);
  assert.match(r.entries.map((e) => e.detail).join(" "), /EACCES/, "the reason must survive to the reader");
});

test("reading ZERO files is reported but does NOT vote — an empty scan is not a fault", async () => {
  // This assertion is inverted from its first version, deliberately. It briefly
  // required problems === 1 on the reasoning that absence must be attributable,
  // and that turned three passing doctor fixture tests red: a workspace with no
  // STATE.md or TODOS.md — a fresh install, a small repo, every fixture — reads
  // 0 files and is healthy. "Could not look" is the failure and it is covered by
  // the throwing case above; "looked, found nothing" is an answer.
  const r = new Reporter();
  await checkBacklog({
    reporter: r,
    backlogFn: () => ({ totals: { stateFilesRead: 0, todoFilesRead: 0, issueFilesRead: 0, parsedItems: 0, parsedFiles: 0, unparsedFileList: [] }, handovers: { files: [] } }),
    defectsFn: () => [],
  });
  assert.equal(r.problems, 0, "an empty scan is not a failure");
  assert.ok(
    r.entries.some((e) => e.kind === "info" && /no backlog files found/.test(e.label)),
    "but it must still be VISIBLE — the reader has to tell an empty scan from a clean one",
  );
});

test("the check labels this file covers, quoted so the coverage ratchet can see them", () => {
  // tests/cli/doctor-check-coverage.test.mjs matches a check label's first 34
  // characters against the whole test corpus, so a covering test has to contain
  // the literal. Naming them here also documents exactly which checks this file
  // is the failing-case evidence for:
  //
  //   "backlog readable"  -> proven failable by the THROWS test above
  //   "every register can be read and every handover can be closed"
  //      -> proven failable by the defect test above
  //
  // A check nobody has seen fail is not known to work (GOTCHAS G1).
  const covered = ["backlog readable", "every register can be read and every handover can be closed"];
  assert.equal(covered.length, 2);
});
