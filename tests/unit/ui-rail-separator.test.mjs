/**
 * ui-rail-separator.test.mjs — PR-025.
 *
 * The rail's group separator was `i === 4`: a position standing in for a rule.
 * It rendered correctly and nothing asserted where it landed, so inserting any
 * division above index 4 would have moved the "reference" label onto the wrong
 * group silently. The CHANGED division was inserted at index 5 on 2026-09-25
 * and missed it by one.
 *
 * Deliberately its own file rather than an addition to ui-client.test.mjs,
 * which PR-008 records as intermittently failing across six test names — a new
 * assertion in there would inherit a flake it has nothing to do with.
 *
 * Source-text, because the rail has no headless renderer here. That makes the
 * blind-check below load-bearing: a regex that stops matching would otherwise
 * report a clean sweep of nothing (rule:enforcement-watches-itself §4).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = readFileSync(path.join(REPO, "commands", "ui.client.js"), "utf8");

/** The DIVISIONS literal, as the shipped file declares it. */
function divisions() {
  const m = src.match(/const DIVISIONS\s*=\s*\[([\s\S]*?)\];/);
  assert.ok(m, "DIVISIONS not found in ui.client.js — this check has gone blind");
  const rows = [...m[1].matchAll(/\{[^}]*key:\s*"([^"]+)"[^}]*\}/g)]
    .map((x) => ({ key: x[1], act: /act:\s*true/.test(x[0]) }));
  assert.ok(rows.length >= 6, `only ${rows.length} divisions parsed — the extraction has gone blind`);
  return rows;
}

test("the rail separator is derived from actionability, never from a position", () => {
  // The literal is what PR-025 removed. If it comes back, so does the defect.
  assert.doesNotMatch(
    src,
    /\$\{i === \d+ \?/,
    "the rail separator compares i against a number again — derive it from the data instead",
  );
  assert.match(src, /const FIRST_REFERENCE = DIVISIONS\.findIndex\(/);
  assert.match(src, /\$\{i === FIRST_REFERENCE \?/);
});

test("the derived boundary still lands where the hardcoded 4 did", () => {
  const d = divisions();
  const first = d.findIndex((x) => !x.act);
  assert.equal(first, 4, `expected the first non-actionable division at 4, got ${first} (${d[first]?.key})`);
  assert.equal(d[first].key, "analytics");
  // Everything before it is actionable; that is what the separator divides.
  assert.deepEqual(d.slice(0, first).map((x) => x.act), [true, true, true, true]);
});

test("inserting a division above the boundary MOVES it — which a literal 4 could not do", () => {
  const d = divisions();
  const before = d.findIndex((x) => !x.act);

  // The exact edit that would have broken the old code: a non-actionable
  // division added above the existing boundary.
  const mutated = [...d.slice(0, 2), { key: "injected", act: false }, ...d.slice(2)];
  const after = mutated.findIndex((x) => !x.act);

  assert.equal(after, 2, "the derived boundary must follow the data");
  assert.notEqual(after, before, "if it did not move, this test proves nothing");
  // And the label would still precede the first reference-side division,
  // which under `i === 4` it would not have.
  assert.equal(mutated[after].key, "injected");
});
