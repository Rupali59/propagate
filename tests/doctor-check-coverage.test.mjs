/**
 * Every doctor check must be provably able to fail — a ratchet, not a wish.
 *
 * `_check.mjs --selftest` proves each rule fingerprint can fire. This is the same
 * idea for `doctor`: a check that cannot be made to fail reports success forever,
 * which is worse than no check at all (docs/GOTCHAS.md G1).
 *
 * Measured 2026-08-14: 23 check() labels, 15 with no failing-case test. Writing 15
 * fixtures at once is the kind of bulk chore this codebase reliably does not finish
 * (149 ledger rows, 74-item sweeps), so instead the current debt is recorded below
 * and this test fails if it GROWS. New checks must arrive with a test.
 *
 * KNOWN_UNCOVERED is a debt list, not an allowlist. Shrinking it is the point.
 * If it is still this length in a month, that is itself the finding.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CLI = readFileSync(path.join(DIR, "..", "cli.mjs"), "utf8");
const TESTS = readdirSync(DIR)
  .filter((f) => f.endsWith(".mjs"))
  .map((f) => readFileSync(path.join(DIR, f), "utf8"))
  .join("\n");

/** Labels doctor asserts on. Parser mirrors the one in skill-doc.test.mjs. */
function checkLabels() {
  return [...new Set([...CLI.matchAll(/check\(\s*\n?\s*"([^"]{4,90})"/g)].map((m) => m[1]))];
}

/** A label is "covered" if some test file mentions its distinctive prefix. */
const covered = (label) => TESTS.includes(label.split("—")[0].trim().slice(0, 34));

// Recorded 2026-08-14. Each entry is a check nothing has ever proven can fail.
// Three of these — the state.json trio — assert artifacts of the watcher that was
// RETIRED 2026-08-14, so they may be removable rather than testable. Verify before
// writing fixtures for them.
const KNOWN_UNCOVERED = [
  "Affects: tokens parse",
  "cross rows carry partner",
  "cross-repo check ran",
  "cross-repo edges resolve",
  "discovery not degraded",
  "event store lines all parseable",
  "ledger JSONL exists",
  "ledger JSONL parseable",
  "ledger MD exists",
  "no source open in more than one ledger",
  "no suspicious workspace markers",
  "no unreachable workspace markers",
  "state.json exists",
  "state.json parseable",
  "state.json.bak exists",
];

test("the parser still finds doctor's checks (guards against a silent zero)", () => {
  const labels = checkLabels();
  assert.ok(
    labels.length >= 20,
    `only ${labels.length} check() labels parsed — if doctor's shape changed, this file's ` +
      `regex must change too. A coverage test that parses nothing reports perfect coverage.`,
  );
});

test("no NEW doctor check lacks a failing-case test", () => {
  const uncovered = checkLabels().filter((l) => !covered(l));
  const fresh = uncovered.filter((l) => !KNOWN_UNCOVERED.includes(l));
  assert.deepEqual(
    fresh,
    [],
    `these doctor checks have no test that makes them fail:\n  ${fresh.join("\n  ")}\n` +
      `Add one, or add the label to KNOWN_UNCOVERED with a reason. A check nobody has ` +
      `seen fail is not known to work (GOTCHAS.md G1).`,
  );
});

test("the debt list does not silently rot", () => {
  // A label that leaves cli.mjs should leave the debt list too, or the list slowly
  // fills with entries for checks that no longer exist and stops meaning anything.
  const labels = checkLabels();
  const stale = KNOWN_UNCOVERED.filter((l) => !labels.includes(l));
  assert.deepEqual(
    stale,
    [],
    `KNOWN_UNCOVERED names checks that cli.mjs no longer has:\n  ${stale.join("\n  ")}\n` +
      `Remove them — the debt is paid.`,
  );
});

test("debt is shrinking or held, never growing", () => {
  const uncovered = checkLabels().filter((l) => !covered(l));
  assert.ok(
    uncovered.length <= KNOWN_UNCOVERED.length,
    `uncovered doctor checks grew from ${KNOWN_UNCOVERED.length} to ${uncovered.length}`,
  );
});
