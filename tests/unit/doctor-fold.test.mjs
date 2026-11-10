/**
 * foldDoctorLines — doctor's default view (#107).
 *
 * Fixtures are LITERAL line arrays, written the way the renderer emits them,
 * not built through a helper that knows the valid shape (rule:mutate-behind-
 * the-fixture-builder): a helper that "always produces a well-formed warn" is a
 * helper that cannot produce the malformed line the fold must keep.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { foldDoctorLines } from "../../lib/report/doctor/fold.mjs";

const body = (folded) => folded.slice(1); // drop the "showing folded view" notice

test("a fail line is kept verbatim, never folded or counted away", () => {
  const lines = [
    "\n# Delivery",
    "  ✗ propagate/propagate  serving 0.15.28, source is 0.19.0",
    "  ✗ second failure  with its own detail",
    "  ✓ something fine",
  ];
  const out = body(foldDoctorLines(lines));
  assert.ok(out.includes("  ✗ propagate/propagate  serving 0.15.28, source is 0.19.0"));
  assert.ok(out.includes("  ✗ second failure  with its own detail"));
});

test("inconclusive (?) and unknown-kind (?!) lines are kept verbatim", () => {
  const lines = [
    "# Discovery",
    "  ? census conforms  the census is empty, nothing was examined",
    '  ?! mystery  (unrendered entry kind "x")',
    "  ✓ fine",
  ];
  const out = body(foldDoctorLines(lines));
  assert.ok(out.includes("  ? census conforms  the census is empty, nothing was examined"));
  assert.ok(out.includes('  ?! mystery  (unrendered entry kind "x")'));
});

test("three warnings with one label fold to one line with x3 and the first detail", () => {
  const lines = [
    "# Refs",
    "  ! ref registry finding  alpha.md is stale",
    "  ! ref registry finding  beta.md is stale",
    "  ! ref registry finding  gamma.md is stale",
  ];
  const out = body(foldDoctorLines(lines));
  const warnLines = out.filter((l) => l.includes("ref registry finding"));
  assert.equal(warnLines.length, 1);
  assert.equal(warnLines[0], "  ! ref registry finding ×3  alpha.md is stale  (+2 more: doctor --full)");
  assert.ok(!out.join("\n").includes("beta.md"));
});

test("a lone warning stays verbatim", () => {
  const lines = ["# State", "  ! state.json.bak exists  no .bak yet"];
  const out = body(foldDoctorLines(lines));
  assert.deepEqual(out, ["# State", "  ! state.json.bak exists  no .bak yet"]);
});

test("different warning labels in one section stay separate groups", () => {
  const lines = [
    "# Mixed",
    "  ! a label  one",
    "  ! b label  two",
    "  ! a label  three",
  ];
  const out = body(foldDoctorLines(lines));
  assert.deepEqual(out, [
    "# Mixed",
    "  ! a label ×2  one  (+1 more: doctor --full)",
    "  ! b label  two",
  ]);
});

test("pass, info and note lines become one count line under the header", () => {
  const lines = [
    "# Backlog",
    "  ✓ one",
    "  ✓ two",
    "  · three  detail",
    "  a marker-less note",
  ];
  const out = body(foldDoctorLines(lines));
  assert.deepEqual(out, ["# Backlog", "  · 2 ok · 2 info (doctor --full)"]);
});

test("a count of zero is omitted from the count line", () => {
  const out = body(foldDoctorLines(["# S", "  ✓ only ok"]));
  assert.deepEqual(out, ["# S", "  · 1 ok (doctor --full)"]);
});

test("a line the classifier cannot place is kept", () => {
  const lines = ["# S", "  ✓ fine", "stray unindented output from somewhere"];
  const out = body(foldDoctorLines(lines));
  assert.ok(out.includes("stray unindented output from somewhere"));
});

test("the verdict line passes through untouched", () => {
  const lines = ["# S", "  ✓ fine", "", "doctor: 2 problems found"];
  const out = foldDoctorLines(lines);
  assert.equal(out[out.length - 1], "doctor: 2 problems found");
});

test("the notice line states the folded and full counts, both derived", () => {
  const lines = [
    "\n# S",
    "  ! w  a",
    "  ! w  b",
    "  ! w  c",
    "  ✓ x",
    "",
    "doctor: all green",
  ];
  const out = foldDoctorLines(lines);
  // 7 physical lines in (the first entry splits on its newline into 2 + 5 = 7... counted below)
  const full = lines.flatMap((l) => l.split("\n")).length;
  assert.equal(full, 8);
  assert.equal(out[0], `showing folded view: ${out.length} lines of 8 (doctor --full for all)`);
});

test("sections are kept in order and every header survives", () => {
  const lines = ["# A", "  ✓ a", "\n# B", "  ✓ b", "\n# C", "  ✓ c"];
  const out = foldDoctorLines(lines).filter((l) => l.startsWith("# "));
  assert.deepEqual(out, ["# A", "# B", "# C"]);
});
