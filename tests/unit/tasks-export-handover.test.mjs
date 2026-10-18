/**
 * tasks-export-handover.test.mjs — the pure half of R3: `buildHandoverMarkers` and `verifyHandoverMarkers`.
 *
 * Every hostile `after` below is a literal written out by hand, handed to the verifier directly
 * (rule:mutate-behind-the-fixture-builder): `buildHandoverMarkers` inserts correctly, so it cannot
 * produce one. Each case names the guard it pins; mutating that guard in export.mjs turns exactly
 * that case red.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildHandoverMarkers, verifyHandoverMarkers } from "../../lib/tasks/export.mjs";

const FILE = "/x/HANDOVERS.md";
const DATE = "2026-10-18";
const U1 = "https://github.com/o/r/issues/1";
const U2 = "https://github.com/o/r/issues/2";

const BEFORE = [
  "# Handovers", "",
  "## 2026-10-01 · Alpha", "", "**Done when:** a works", "", "body a", "",
  "## 2026-10-02 · Beta", "", "**Done when:** b works", "", "body b", "",
  "## 2026-10-03 · Gamma", "", "just prose, no marker", "",
  "## 2026-10-04 · Delta", "", "**Resolved:** 2026-10-05 — done", "",
].join("\n");
const lineOf = (t) => BEFORE.split("\n").findIndex((l) => l.includes(t)) + 1;
const MARKS = [{ line: lineOf("Alpha"), url: U1 }, { line: lineOf("Beta"), url: U2 }];
const ARGS = { before: BEFORE, file: FILE, marks: MARKS, date: DATE };
const MARKER1 = `**Moved:** ${DATE} → ${U1}`;
const MARKER2 = `**Moved:** ${DATE} → ${U2}`;
const INSERTED = [MARKER1, "", MARKER2, ""];

/** Hand-written correct output: the markers directly under the headings. */
const GOOD = BEFORE
  .replace("## 2026-10-01 · Alpha\n", `## 2026-10-01 · Alpha\n${MARKER1}\n\n`)
  .replace("## 2026-10-02 · Beta\n", `## 2026-10-02 · Beta\n${MARKER2}\n\n`);

const refuses = (after, re, inserted = INSERTED, over = {}) => {
  const v = verifyHandoverMarkers({ ...ARGS, after, inserted, ...over });
  assert.equal(v.ok, false, "must refuse");
  assert.match(v.error, re);
};

test("CONTROL: build inserts the Moved line under each marked heading; unknown and closed are untouched", () => {
  const r = buildHandoverMarkers(BEFORE, MARKS, { file: FILE, date: DATE });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.text, GOOD, "the builder agrees with the hand-written output");
  assert.deepEqual(r.insertedLines, INSERTED);
  assert.deepEqual(verifyHandoverMarkers({ ...ARGS, after: GOOD, inserted: INSERTED }), { ok: true });
});

test("guard: a marker below the 3-line window leaves the section open -> refused naming the window", () => {
  const far = BEFORE.replace("## 2026-10-01 · Alpha\n\n**Done when:** a works\n\nbody a\n", `## 2026-10-01 · Alpha\n\n**Done when:** a works\n\nbody a\nl4\nl5\n${MARKER1}\n\n`);
  // section order/count intact, but the marker is out of window -> Alpha still reads open
  refuses(far, /not "moved" — the marker is outside the reader's window/, [MARKER1, "", "l4", "l5"], { marks: [MARKS[0]] });
});

test("guard: wrong URL in the marker -> refused", () => {
  const bad = GOOD.replace(U2, "https://github.com/o/r/issues/99");
  refuses(bad, /moved is .*not/);
});

test("guard: marking an UNKNOWN section (not open) is refused even though it would read moved", () => {
  const bad = GOOD.replace("## 2026-10-03 · Gamma\n", `## 2026-10-03 · Gamma\n**Moved:** ${DATE} → ${U1}\n\n`);
  refuses(bad, /was unknown, not open/, [...INSERTED, `**Moved:** ${DATE} → ${U1}`, ""], { marks: [...MARKS, { line: lineOf("Gamma"), url: U1 }] });
});

test("guard: a section silently dropped -> section count", () => {
  const bad = GOOD.replace("## 2026-10-03 · Gamma\n\njust prose, no marker\n\n", "");
  refuses(bad, /section count changed/);
});

test("guard: an UNMARKED section changes status (unknown -> open) -> refused", () => {
  const bad = GOOD.replace("just prose, no marker", "**Done when:** sneaked in");
  refuses(bad, /unmarked section "Gamma" changed/, INSERTED);
});

test("guard: an unmarked section is also marked moved (a marker on the wrong section) -> refused", () => {
  const bad = GOOD.replace("## 2026-10-03 · Gamma\n", `## 2026-10-03 · Gamma\n**Moved:** ${DATE} → ${U1}\n\n`);
  refuses(bad, /unmarked section "Gamma" changed/, [...INSERTED, `**Moved:** ${DATE} → ${U1}`, ""]);
});

test("guard: original text edited (a body line altered) -> original is not a subsequence", () => {
  const bad = GOOD.replace("body a", "body A");
  refuses(bad, /original lines were found, in order/);
});

test("guard: extra non-inserted line appears -> extras must equal the inserted", () => {
  const bad = GOOD.replace("body b", "body b\nsurprise");
  refuses(bad, /not original text, expected exactly the 4 inserted/);
});

test("guard: a fence opened at the end of the file (declared inserted, sections unchanged) -> fences unbalanced", () => {
  // Isolates the fence guard: section count, statuses and the subsequence/extras checks all pass.
  refuses(`${GOOD}\`\`\`\n`,/fence delimiters are no longer balanced/, [...INSERTED, "```"]);
});

test("build refuses a mark whose line is not a heading (file changed since planned)", () => {
  const r = buildHandoverMarkers(BEFORE, [{ line: 1 + lineOf("body a") - 1, url: U1 }], { file: FILE, date: DATE });
  assert.equal(r.ok, false);
  assert.match(r.error, /not a section heading/);
});

test("WINDOW: a section whose first lines are a long Done-when paragraph still reads moved after insert", () => {
  const long = ["# H", "", "## 2026-10-01 · Long", "", "**Done when:** line one of the condition", "continues here", "and here", "and there", "and further", "", "tail", ""].join("\n");
  const r = buildHandoverMarkers(long, [{ line: 3, url: U1 }], { file: FILE, date: DATE });
  assert.equal(r.ok, true, r.error);
  assert.match(r.text, /## 2026-10-01 · Long\n\*\*Moved:\*\* 2026-10-18 → /);
});

test("FENCE: a heading-looking line inside a fenced block is not a section and survives byte-identical", () => {
  const fenced = ["# H", "", "## 2026-10-01 · Real", "", "**Done when:** x", "", "```", "## 2026-01-01 · x", "```", "", "end", ""].join("\n");
  const r = buildHandoverMarkers(fenced, [{ line: 3, url: U1 }], { file: FILE, date: DATE });
  assert.equal(r.ok, true, r.error);
  assert.ok(r.text.includes("```\n## 2026-01-01 · x\n```"));
  // marking the fenced line is refused: it is not a section of the original
  const bad = buildHandoverMarkers(fenced, [{ line: 8, url: U1 }], { file: FILE, date: DATE });
  assert.equal(bad.ok, false);
});
