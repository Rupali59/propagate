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
  assert.deepEqual(d.totals, { pass: 0, warn: 0, fail: 0, info: 0, note: 0, accepted: 0 });
});

// ── E5: an entry's `action` survives the text boundary ─────────────────────

test("an entry's action is rendered by the REAL renderer and parsed back into the snapshot (E5)", async () => {
  // The snapshot is parsed from stdout, so an `action` kept only on the Reporter
  // entry would be dropped at exactly the seam this module guards. Driven through
  // cli.mjs's renderDoctorEntries rather than a hand-written line: a test that
  // writes the marker itself proves the parser and not the pipeline.
  const { renderDoctorEntries } = await import("../../cli.mjs");
  const { Reporter } = await import("../../lib/report/doctor/reporter.mjs");
  const r = new Reporter();
  r.header("Rules");
  r.check("CLAUDE.md restates rule:x", false, "3 findings", { kind: "open", target: "/Users/u/Documents/GitHub/CLAUDE.md" });
  r.check("layout conforms", false, "", { kind: "link", target: "docs/REFERENCE.md#propagation-layout" });
  r.accepted("a.md restates rule:y", "since 2026-10-01 — reason with  two spaces", { kind: "command", target: "propagate rules check" });
  r.check("plain", true, "no action here");

  const out = [];
  const real = console.log;
  console.log = (...a) => { out.push(a.join(" ")); };
  try { renderDoctorEntries(r.drain()); } finally { console.log = real; }

  const [rules] = toSections(out);
  const byLabel = Object.fromEntries(rules.entries.map((e) => [e.label, e]));
  assert.deepEqual(byLabel["CLAUDE.md restates rule:x"].action, { kind: "open", target: "/Users/u/Documents/GitHub/CLAUDE.md" });
  assert.equal(byLabel["CLAUDE.md restates rule:x"].detail, "3 findings", "the action is not left glued to the detail");
  assert.deepEqual(byLabel["layout conforms"].action, { kind: "link", target: "docs/REFERENCE.md#propagation-layout" });
  assert.equal(byLabel["layout conforms"].detail, "", "an action with no detail must not become the detail");
  const acc = byLabel["a.md restates rule:y"];
  assert.equal(acc.kind, "accepted");
  assert.deepEqual(acc.action, { kind: "command", target: "propagate rules check" });
  assert.equal(acc.detail, "since 2026-10-01 — reason with  two spaces");
  assert.equal("action" in byLabel.plain, false, "an entry with no action must not grow the key");
  assert.match(out.join("\n"), /\u21d2 open: \/Users\/u\/Documents\/GitHub\/CLAUDE\.md/, "and the line stays human-readable");
});

test("a detail that merely contains an arrow is not read as an action", () => {
  const e = classifyLine("  ! heads up  see \u21d2 open: nowhere in the middle of a sentence");
  assert.equal("action" in e, false, "the marker is anchored at the end and needs one of the three kinds");
  assert.equal(classifyLine("  ! x  y  \u21d2 teleport: /a").action, undefined, "an unknown kind is not an action");
});

test("actionSuffix refuses a multi-line target instead of corrupting the next line", async () => {
  const { actionSuffix } = await import("../../lib/report/doctor/structure.mjs");
  assert.throws(() => actionSuffix({ kind: "command", target: "a\nb" }), /one line/);
  assert.equal(actionSuffix(undefined), "");
});
