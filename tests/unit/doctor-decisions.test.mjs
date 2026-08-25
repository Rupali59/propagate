/**
 * Tests for lib/report/doctor/decisions.mjs — the first extracted doctor
 * section (#31 T2, the pilot).
 *
 * WHAT THESE COVER that nothing did before: the module's RETURNED counts. D4's
 * whole premise is that sections return `{counts, details}` and the
 * orchestrator merges them, so a dropped key surfaces as a missing property
 * rather than a silent zero in `# Metrics`. That only holds if something
 * asserts the returned values — before this file, doctor's 17 accumulators had
 * zero coverage of any kind.
 *
 * Run: `npm test` (G56).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Reporter } from "../../lib/report/doctor/reporter.mjs";
import { checkDecisions } from "../../lib/report/doctor/decisions.mjs";

async function skillDirWith(decisionsText, { legacy = false } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "doctor-decisions-"));
  if (decisionsText !== null) {
    const rel = legacy ? ["docs"] : ["propagation", "state", "workspace"];
    await mkdir(path.join(dir, ...rel), { recursive: true });
    await writeFile(path.join(dir, ...rel, "DECISIONS.md"), decisionsText);
  }
  return dir;
}

const TWO_GOOD = `# Decisions

## 2026-08-01: first
**What:** a thing
**Why:** a reason
**Affects:** propagate

## 2026-08-02: second
**What:** another
**Why:** another reason
**Affects:** propagate, hub
`;

test("returns the counts the orchestrator merges, and does not vote", async () => {
  const dir = await skillDirWith(TWO_GOOD);
  try {
    const reporter = new Reporter();
    const { counts, details } = await checkDecisions({ skillDir: dir, reporter });

    assert.equal(counts.decisionsEntries, 2, "both entries parsed");
    assert.equal(counts.decisionsWithTokens, 2, "both carry Affects: tokens");
    assert.deepEqual(details.decisionsZeroEntries, []);
    assert.match(details.decisionsPath, /propagation\/state\/workspace\/DECISIONS\.md$/);

    // The equality verdict is owned by EXPECTATIONS (GOTCHAS G20), not here —
    // one mechanism, so two cannot disagree.
    assert.equal(reporter.problems, 0);
    assert.deepEqual(reporter.entries.map((e) => e.kind), ["info"]);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("a zero-token entry is REPORTED by date/title, not silently counted away", async () => {
  // N12: the partial case. `withTokens < entries` is what EXPECTATIONS asserts
  // on, so the count must be right; the named subset is what makes it fixable.
  const dir = await skillDirWith(TWO_GOOD + `
## 2026-08-03: third
**What:** no attribution
**Why:** none
`);
  try {
    const reporter = new Reporter();
    const { counts, details } = await checkDecisions({ skillDir: dir, reporter });

    assert.equal(counts.decisionsEntries, 3);
    assert.equal(counts.decisionsWithTokens, 2, "the un-attributed entry must not count as attributed");
    assert.equal(details.decisionsZeroEntries.length, 1);
    assert.match(details.decisionsZeroEntries[0], /2026-08-03/);
    assert.match(details.decisionsZeroEntries[0], /third/);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("falls back to the legacy docs/ path, so an older checkout still resolves", async () => {
  const dir = await skillDirWith(TWO_GOOD, { legacy: true });
  try {
    const reporter = new Reporter();
    const { counts, details } = await checkDecisions({ skillDir: dir, reporter });
    assert.match(details.decisionsPath, /docs\/DECISIONS\.md$/);
    assert.equal(counts.decisionsEntries, 2);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("an absent DECISIONS.md is a NOTE naming both paths tried — not a failure, not silence", async () => {
  // rule:discernment-checks §2: absence must be attributable. "not found" and
  // "found and healthy" must never render the same, and neither may fail a run
  // for a file a fresh checkout legitimately lacks.
  const dir = await skillDirWith(null);
  try {
    const reporter = new Reporter();
    const { counts, details } = await checkDecisions({ skillDir: dir, reporter });

    assert.equal(reporter.problems, 0, "absence is not a defect");
    assert.equal(reporter.entries.length, 1);
    assert.equal(reporter.entries[0].kind, "note");
    assert.match(reporter.entries[0].label, /no DECISIONS\.md/);
    assert.match(reporter.entries[0].label, /propagation\/state\/workspace/, "names the new path");
    assert.match(reporter.entries[0].label, /docs\/DECISIONS\.md/, "and the legacy one");

    assert.equal(counts.decisionsEntries, 0, "counts are still returned, so # Metrics has a value");
    assert.equal(counts.decisionsWithTokens, 0);
    assert.ok(details.decisionsPath, "the path tried is still reported");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("a THROWN read fails the run — it must not read as a satisfied 0 == 0", async () => {
  // The one failure mode EXPECTATIONS cannot see, and the reason the catch is a
  // check() rather than a warn(). entries=0/withTokens=0 satisfies
  // "withTokens == entries" perfectly, so a throw would otherwise produce a
  // green run from a check that never executed.
  //
  // Forced by making DECISIONS.md a DIRECTORY: existsSync() is true, so the
  // absent-file branch is skipped, and readFile() then throws EISDIR. An
  // earlier version of this test pointed skillDir at a file, which made
  // existsSync false and quietly took the note branch — it passed while
  // testing nothing it claimed to (rule:discernment-checks §1).
  const dir = await mkdtemp(path.join(tmpdir(), "doctor-decisions-throw-"));
  try {
    await mkdir(path.join(dir, "propagation", "state", "workspace", "DECISIONS.md"), {
      recursive: true,
    });

    const reporter = new Reporter();
    const { counts } = await checkDecisions({ skillDir: dir, reporter });

    assert.equal(reporter.problems, 1, "a read that throws must FAIL the run, not fall through");
    const fails = reporter.entriesOfKind("fail");
    assert.equal(fails.length, 1);
    assert.equal(fails[0].label, "Affects: tokens parse");
    assert.ok(fails[0].detail, "the error message must reach the reader, not be swallowed");
    assert.equal(reporter.entriesOfKind("note").length, 0, "this is a failure, not an absence");

    // And the counts are still well-formed, so # Metrics gets numbers rather
    // than undefined — the zeros here are honest, because the check failed loudly.
    assert.equal(counts.decisionsEntries, 0);
    assert.equal(counts.decisionsWithTokens, 0);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
