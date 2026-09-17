/**
 * doctor --json — the structure derived from doctor's own output.
 *
 * WHY THE JSON IS PARSED FROM THE TEXT rather than accumulated in `Reporter`.
 * Measured before building: doctor prints 561 marked lines and 31 headers, and
 * the doctor region of `cli.mjs` holds 31 direct `console.log` calls that never
 * touch a Reporter. A reporter-only payload would be silently INCOMPLETE — whole
 * sections missing from something that looks whole, which is the defect N87 filed
 * against doctor itself. Deriving from the rendered lines means the JSON and the
 * text cannot disagree, because one is a function of the other.
 *
 * THE TEST THAT MATTERS MOST is the embedded-newline one. The first version of
 * this module passed a hand-run against doctor's output saved to a FILE, and then
 * produced ONE section for a 31-section run in production. A file arrives already
 * split on newlines; a captured `console.log` argument does not — the renderer
 * emits a header as `"\n# State"` in a single call. The passing test and the
 * broken behaviour differed only in how the input had been split.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyLine, toSections, buildDoctorJson, stripAnsi } from "../../lib/report/doctor/structure.mjs";

// ── classification: one line, one kind ─────────────────────────────────────

test("every marker maps to its kind, and label/detail split on the double space", () => {
  assert.deepEqual(classifyLine("  ✓ all good  42 checked"), { kind: "pass", label: "all good", detail: "42 checked" });
  assert.deepEqual(classifyLine("  ✗ it broke  because reasons"), { kind: "fail", label: "it broke", detail: "because reasons" });
  assert.deepEqual(classifyLine("  ! heads up  detail"), { kind: "warn", label: "heads up", detail: "detail" });
  assert.deepEqual(classifyLine("  · a tally  3 things"), { kind: "info", label: "a tally", detail: "3 things" });
  assert.deepEqual(classifyLine("# State"), { kind: "header", label: "State", detail: "" });
});

test("a marker-less indented line is a NOTE, not an info", () => {
  // doctor prints both shapes and the difference is not decorative: `info` is a
  // tally about checks that ran, `note` is context about a check that could not.
  assert.equal(classifyLine("  (no DECISIONS.md — tried 3 paths)").kind, "note");
});

test("ANSI is stripped before classification — the markers are the contract", () => {
  assert.equal(classifyLine("  \x1b[32m✓\x1b[0m green  \x1b[2mdetail\x1b[0m").kind, "pass");
  assert.equal(stripAnsi("\x1b[1m# State\x1b[0m"), "# State");
});

test("blank lines and the trailing summary carry no entry", () => {
  assert.equal(classifyLine(""), null);
  assert.equal(classifyLine("   "), null);
  assert.equal(classifyLine("doctor: 1 problem found"), null, "unindented prose is not an entry");
});

// ── the bug that a file-based test cannot see ──────────────────────────────

test("a captured console.log arg containing \\n is split before classifying", () => {
  // The renderer emits `"\n# State"` in ONE call. Without the split, every header
  // is missed and a 31-section run collapses to 1 — which is exactly what
  // happened in production while the file-based hand-check passed.
  const captured = ["\n\x1b[1m# State\x1b[0m", "  ✓ a  b", "\n\x1b[1m# Delivery\x1b[0m", "  ! c  d"];
  const secs = toSections(captured);
  assert.equal(secs.length, 2, "two headers arrived inside two captured args");
  assert.deepEqual(secs.map((s) => s.name), ["State", "Delivery"]);
  assert.equal(secs[0].pass, 1);
  assert.equal(secs[1].warn, 1);
});

// ── sections ───────────────────────────────────────────────────────────────

test("entries are attributed to the header above them, and counted per kind", () => {
  const secs = toSections(["# A", "  ✓ p  x", "  ! w  y", "# B", "  ✗ f  z"]);
  assert.deepEqual(secs.map((s) => s.name), ["A", "B"]);
  assert.deepEqual([secs[0].pass, secs[0].warn, secs[0].fail], [1, 1, 0]);
  assert.deepEqual([secs[1].pass, secs[1].warn, secs[1].fail], [0, 0, 1]);
  assert.equal(secs[1].entries[0].label, "f");
});

test("entries printed BEFORE any header are kept, not dropped", () => {
  // "printed outside any section" is a fact worth keeping; discarding it is how
  // a reader loses a line nobody knew existed.
  const secs = toSections(["  · orphan  detail", "# Later", "  ✓ x  y"]);
  assert.equal(secs.length, 2);
  assert.equal(secs[0].name, "");
  assert.equal(secs[0].info, 1);
});

// ── the payload ────────────────────────────────────────────────────────────

test("problems comes from the CALLER's tally, never recounted from fail entries", () => {
  // doctor's own module doc warns a summarised defect is counted once by its
  // check and again by a tally. Recounting here would reintroduce that
  // double-vote in a second place.
  const d = buildDoctorJson(["# A", "  ✗ one  x", "  ✗ two  y"], { problems: 1, generatedAt: "T" });
  assert.equal(d.problems, 1, "two fail LINES, one reported problem — the caller decides");
  assert.equal(d.totals.fail, 2, "...while the line count stays honest");
});

test("totals sum every section, and sectionCount matches", () => {
  const d = buildDoctorJson(["# A", "  ✓ a  b", "# B", "  ✓ c  d", "  ! e  f"], { problems: 0, generatedAt: "T" });
  assert.equal(d.sectionCount, 2);
  assert.equal(d.totals.pass, 2);
  assert.equal(d.totals.warn, 1);
});

test("empty input yields zero sections, never a throw", () => {
  const d = buildDoctorJson([], { problems: 0, generatedAt: "T" });
  assert.equal(d.sectionCount, 0);
  assert.deepEqual(d.totals, { pass: 0, warn: 0, fail: 0, info: 0, note: 0 });
});
