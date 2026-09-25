/**
 * Tests for lib/registers/insert.mjs — inserting a NEW line into a
 * hand-written register, the operation write.mjs deliberately does not do.
 *
 * `write.mjs`'s own "+1 line" / "every other line identical" assertions are
 * unreachable as written (`out = lines.slice(); out[i] = next` cannot
 * violate either), and would be exactly as unreachable for an insert
 * written with `splice`. So this file is entirely about the three
 * assertions that DO matter — A1 (content), A2 (boundary), A3 (parse) —
 * each proven with the negative control that makes it fail, per
 * `rule:safety-flag-needs-a-test`: every test measures the BYTES ON DISK,
 * never the return value alone.
 *
 * Run: `PROPAGATE_STATE_DIR="${TMPDIR:-/tmp}/propagate-test-state" node --test
 * tests/unit/registers-insert.test.mjs` (G56 — this file writes no events,
 * but the harness rule is blanket).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { applyInsert, isLegalBoundary, checkParseInvariant, simulateInsert } from "../../lib/registers/insert.mjs";
import { parseTodoLikeFile } from "../../lib/report/backlog.mjs";

const withFile = async (content, fn) => {
  const d = mkdtempSync(path.join(tmpdir(), "reg-insert-"));
  const file = path.join(d, "TODOS.md");
  writeFileSync(file, content);
  try {
    await fn(file, d);
  } finally {
    rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
};

// A fixture using the flat `### PR-0NN ·` / `## Finished` convention
// (propagate's own — the plan's worked example).
const BASIC = [
  "## Open",
  "",
  "### PR-002 · an existing open item",
  "",
  "### PR-003 · another entry",
  "",
  "## Finished",
  "",
  "### PR-000 · a closed item",
  "done 2026-01-01",
  "",
].join("\n");

function lineNo(text, needle) {
  const lines = text.split("\n");
  const i = lines.findIndex((l) => l === needle);
  if (i === -1) throw new Error(`fixture line not found: ${JSON.stringify(needle)}`);
  return i + 1; // 1-based
}

// ---------------------------------------------------------------------------
// A1 — content: no embedded newline
// ---------------------------------------------------------------------------

test("A1: refuses an insertText containing a newline, and the file is untouched", async () => {
  await withFile(BASIC, async (file) => {
    const anchorLine = lineNo(BASIC, ""); // the first blank line, a legal boundary
    const before = readFileSync(file, "utf8");
    const r = await applyInsert({
      file,
      anchorLine,
      anchorExpected: "",
      insertText: "### PR-099 · new\nnote: done for now",
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, "bad-content");
    assert.match(r.error, /newline/);
    assert.equal(readFileSync(file, "utf8"), before, "a refused insert must not touch the file");
  });
});

test("A1 positive: a single-line insertText with no newline is accepted by the A1 gate", () => {
  assert.doesNotMatch("### PR-099 · fine, one line", /\n/);
});

// ---------------------------------------------------------------------------
// A2 — boundary: blank line, or immediately before a heading at <= level;
// never inside a closed section.
// ---------------------------------------------------------------------------

test("A2 negative: anchor is a non-blank body line inside an existing entry -- illegal, file untouched", async () => {
  const text = ["### PR-002 · an existing open item", "first body line", "second body line", ""].join("\n");
  await withFile(text, async (file) => {
    const anchorLine = lineNo(text, "first body line");
    const before = readFileSync(file, "utf8");
    const r = await applyInsert({ file, anchorLine, anchorExpected: "first body line", insertText: "### PR-099 · new" });
    assert.equal(r.ok, false);
    assert.equal(r.code, "illegal-boundary");
    assert.match(r.error, /not a legal boundary/);
    assert.equal(readFileSync(file, "utf8"), before);
  });
});

test("A2 negative: anchor is a line under a closed section (## Finished) -- illegal, file untouched", async () => {
  await withFile(BASIC, async (file) => {
    const anchorLine = lineNo(BASIC, "done 2026-01-01");
    const before = readFileSync(file, "utf8");
    const r = await applyInsert({ file, anchorLine, anchorExpected: "done 2026-01-01", insertText: "### PR-099 · new" });
    assert.equal(r.ok, false);
    assert.equal(r.code, "illegal-boundary");
    assert.match(r.error, /closed section/);
    assert.equal(readFileSync(file, "utf8"), before);
  });
});

test("isLegalBoundary: blank line is always legal", () => {
  const lines = ["a", "", "b"];
  const r = isLegalBoundary({ lines, anchorLine: 2, insertText: "### PR-x · y", closedLines: new Set() });
  assert.equal(r.ok, true);
});

test("isLegalBoundary: immediately before a heading at or above the new entry's level is legal", () => {
  const lines = ["### PR-002 · item", "some prose", "## Next section"];
  // anchor on "some prose" (non-blank); next line is "## Next section" (level 2 <= 3)
  const r = isLegalBoundary({ lines, anchorLine: 2, insertText: "### PR-099 · new", closedLines: new Set() });
  assert.equal(r.ok, true);
});

test("isLegalBoundary: immediately before a DEEPER heading than the new entry is illegal", () => {
  const lines = ["## Section", "some prose", "#### deep subheading"];
  // insertText is level 2 (##); next heading is level 4, which is NOT <= 2.
  const r = isLegalBoundary({ lines, anchorLine: 2, insertText: "## PR-099 new section", closedLines: new Set() });
  assert.equal(r.ok, false);
});

// ---------------------------------------------------------------------------
// A2 positive control — a legal insert actually succeeds, file changes
// exactly as expected.
// ---------------------------------------------------------------------------

test("A2/A3 positive: a legal insert on a blank line lands the new line and leaves everything else untouched", async () => {
  await withFile(BASIC, async (file) => {
    const anchor = "";
    // The blank line right before "## Finished" -- inserting the new entry
    // into the still-open section, immediately before the closed boundary.
    const lines = BASIC.split("\n");
    const finishedIdx = lines.findIndex((l) => l === "## Finished");
    const anchorLine = finishedIdx; // 1-based line number of the blank line right before it
    assert.equal(lines[anchorLine - 1], "");

    const r = await applyInsert({ file, anchorLine, anchorExpected: "", insertText: "### PR-005 · a new staged item" });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.insertedAtLine, anchorLine + 1);

    const after = readFileSync(file, "utf8");
    assert.match(after, /### PR-005 · a new staged item/);

    // Every pre-existing item's {id, closed} survives, format unchanged.
    const before = parseTodoLikeFile(BASIC, file);
    const afterParsed = parseTodoLikeFile(after, file);
    assert.equal(afterParsed.format, before.format);
    assert.ok(afterParsed.items.some((i) => i.id === "PR-002"));
    assert.ok(afterParsed.items.some((i) => i.id === "PR-003"));
    assert.ok(afterParsed.items.some((i) => i.id === "PR-005"), "the new entry is present");
    assert.equal(afterParsed.closed, before.closed, "closed count unchanged by a legal insert");
  });
});

// ---------------------------------------------------------------------------
// The race check (write.mjs's guarantee 1, reused) — anchor moved since
// planning.
// ---------------------------------------------------------------------------

test("race check: a stale anchorExpected refuses rather than guessing, file untouched", async () => {
  await withFile(BASIC, async (file) => {
    const anchorLine = lineNo(BASIC, "");
    const before = readFileSync(file, "utf8");
    const r = await applyInsert({ file, anchorLine, anchorExpected: "THIS IS NOT WHAT IS THERE", insertText: "### PR-099 · new" });
    assert.equal(r.ok, false);
    assert.equal(r.code, "anchor-moved");
    assert.match(r.error, /not what was previewed/);
    assert.equal(readFileSync(file, "utf8"), before);
  });
});

// ---------------------------------------------------------------------------
// A3 — parse invariant: THE ONE THAT MATTERS. Simulated in memory via
// checkParseInvariant, and end-to-end via applyInsert.
// ---------------------------------------------------------------------------

test("A3 negative: inserting a checkbox line into an id-keyed file flips the format election", async () => {
  await withFile(BASIC, async (file) => {
    const anchorLine = lineNo(BASIC, "");
    const before = readFileSync(file, "utf8");
    const r = await applyInsert({ file, anchorLine, anchorExpected: "", insertText: "- [ ] a new checkbox item" });
    assert.equal(r.ok, false);
    assert.equal(r.code, "would-change-classification");
    assert.match(r.error, /format election/);
    assert.match(r.error, /id-keyed/);
    assert.match(r.error, /checkbox/);
    assert.equal(readFileSync(file, "utf8"), before, "a refused insert must not touch the file");
  });
});

test("A3 negative: insert text lands inside CLOSED_MARKERS_RE's lookahead of the PRECEDING entry and silently closes it", async () => {
  // PR-900's heading is immediately followed by the staging heading and one
  // blank line -- tight enough that anything inserted right there falls
  // inside backlog.mjs's 3-line lookahead for PR-900. The inserted text must
  // be NON-heading (backlog.mjs's lookahead filters heading lines OUT of
  // its scan), so a plain body line is what actually exercises the bleed --
  // an inserted `### PR-0NN · title` entry never can, which is worth
  // recording since sync.mjs only ever inserts headings: this exact hazard
  // is why insert.mjs's A3 check is generic rather than heading-only.
  const text = ["### PR-900 · an existing open item", "## From Reminders (unreviewed)", ""].join("\n");
  await withFile(text, async (file) => {
    // Confirm PR-900 is OPEN before the insert -- the positive half of the
    // control, so this test cannot pass by asserting a fact that was never
    // true to begin with.
    const before = parseTodoLikeFile(text, file);
    assert.ok(before.items.some((i) => i.id === "PR-900"), "PR-900 must be OPEN before the insert (sanity) -- parseTodoLikeFile's items are open-only");

    const beforeBytes = readFileSync(file, "utf8");
    const anchorLine = lineNo(text, ""); // the blank line under the staging heading
    const r = await applyInsert({
      file,
      anchorLine,
      anchorExpected: "",
      insertText: "note: done for now",
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, "would-change-classification");
    assert.match(r.error, /PR-900/);
    assert.match(r.error, /open to closed/);
    assert.equal(readFileSync(file, "utf8"), beforeBytes, "a refused insert must not touch the file");
  });
});

test("A3 positive control: a legal insert leaves format and every pre-existing {id, closed} unchanged (checkParseInvariant directly)", () => {
  const before = BASIC;
  const lines = before.split("\n");
  const anchorLine = lines.findIndex((l) => l === "## Finished"); // 1-based line of the blank line right before it
  const after = simulateInsert(lines, anchorLine, "### PR-005 · a new staged item");
  const result = checkParseInvariant({ beforeText: before, afterText: after, filePath: "TODOS.md" });
  assert.equal(result.ok, true, result.error);
});

test("checkParseInvariant is not vacuous: it actually distinguishes the bad case from the good one", () => {
  const good = checkParseInvariant({
    beforeText: BASIC,
    afterText: simulateInsert(BASIC.split("\n"), BASIC.split("\n").findIndex((l) => l === "## Finished"), "### PR-005 · fine"),
    filePath: "TODOS.md",
  });
  assert.equal(good.ok, true);

  const bad = checkParseInvariant({
    beforeText: BASIC,
    afterText: simulateInsert(BASIC.split("\n"), 1, "- [ ] a checkbox"),
    filePath: "TODOS.md",
  });
  assert.equal(bad.ok, false);
});

// ---------------------------------------------------------------------------
// Bad args
// ---------------------------------------------------------------------------

test("refuses missing file/anchorLine with a clear reason, never throws", async () => {
  const r = await applyInsert({ anchorLine: 1, anchorExpected: "", insertText: "x" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "bad-args");
});

test("refuses an anchorLine past the end of the file", async () => {
  await withFile(BASIC, async (file) => {
    const r = await applyInsert({ file, anchorLine: 9999, anchorExpected: "", insertText: "### PR-099 · new" });
    assert.equal(r.ok, false);
    assert.equal(r.code, "anchor-moved");
    assert.match(r.error, /past the end/);
  });
});
