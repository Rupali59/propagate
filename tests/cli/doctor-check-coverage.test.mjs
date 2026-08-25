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
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(DIR, "..", "..");

// cli.mjs PLUS the extracted doctor sections. Widened 2026-08-25 with the first
// extraction (#31 T2): doctor's checks are moving into lib/report/doctor/, and a
// scan that still read only cli.mjs would see the corpus shrink check by check
// while reporting improving coverage — the precise failure this file exists to
// prevent, committed by this file, for the third time (see the two corrections
// below it about the tests root).
//
// Discovered by directory read, never a hardcoded module list: a list would go
// stale silently on the next extraction, and "found nothing new" would be
// indistinguishable from "looked at nothing" (GOTCHAS G17).
const DOCTOR_DIR = path.join(REPO, "lib", "report", "doctor");
const DOCTOR_MODULES = existsSync(DOCTOR_DIR)
  ? readdirSync(DOCTOR_DIR, { recursive: true }).filter((f) => String(f).endsWith(".mjs"))
  : [];
const CLI = [
  readFileSync(path.join(REPO, "cli.mjs"), "utf8"),
  ...DOCTOR_MODULES.map((f) => readFileSync(path.join(DOCTOR_DIR, f), "utf8")),
].join("\n");
// RECURSIVE. tests/ gained subdirectories on 2026-08-20, and a non-recursive read
// would find almost nothing while still producing a confident coverage verdict — a
// coverage test that parses nothing reports perfect coverage, which this file warns
// about twenty lines below and would then have done itself.
// The TESTS ROOT, not this file's directory. `DIR` was tests/ until 2026-08-20 and is
// now tests/cli/, so reading from it inspects a sixth of the suite and then reports a
// confident verdict about the other five sixths — the exact failure this file warns
// about below, committed by this file.
const TESTS_ROOT = path.join(DIR, "..");
const TEST_FILES = readdirSync(TESTS_ROOT, { recursive: true }).filter((f) => f.endsWith(".mjs"));
const TESTS = TEST_FILES.map((f) => readFileSync(path.join(TESTS_ROOT, f), "utf8")).join("\n");

/** Labels doctor asserts on. Parser mirrors the one in skill-doc.test.mjs. */
function checkLabels() {
  // Matches both the in-cli `check("...")` closure call and the extracted
  // `reporter.check("...")` method call. Without the optional prefix every
  // migrated label vanishes from the corpus.
  return [...new Set([...CLI.matchAll(/(?:reporter\.)?check\(\s*\n?\s*"([^"]{4,90})"/g)].map((m) => m[1]))];
}

/** A label is "covered" if some test file mentions its distinctive prefix. */
const covered = (label) => TESTS.includes(label.split("—")[0].trim().slice(0, 34));

// Recorded 2026-08-14. Each entry is a check nothing has ever proven can fail.
//
// The state.json trio was flagged here on 2026-08-14 as "may be removable rather than
// testable — verify before writing fixtures". VERIFIED 2026-08-19, by the Phase 6
// baseline: `state.json exists` was FAILING every fresh install for a file only the
// retired watcher ever wrote, while reading green here purely because a fossil dated
// the day of the retirement is still on disk. It is now `info`, not a check, and its
// entry is gone from the list below — the debt is paid, not deferred.
//
// The other two stay: `parseable` only runs when the file exists, so it cannot fail a
// fresh machine, and `.bak` already degrades to `!` with a reason.
const KNOWN_UNCOVERED = [
  // "Affects: tokens parse" — PAID 2026-08-25. tests/unit/doctor-decisions.test.mjs
  // makes DECISIONS.md a directory so existsSync passes and readFile throws EISDIR,
  // then asserts problems === 1. That was the one failure mode EXPECTATIONS cannot
  // see (a throw leaves entries=0/withTokens=0, satisfying "withTokens == entries"),
  // so it needed a fixture rather than a rule. Removed, not deferred.
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
  "state.json parseable",
  "state.json.bak exists",
];

test("the coverage scan sees the whole suite, not one subdirectory", () => {
  // A wrong base directory does not error — it silently shrinks the corpus and every
  // label then reads as uncovered. Assert the corpus size, not just that it is
  // non-empty: `readdirSync` on tests/cli/ returns ~20 files and looks perfectly fine.
  assert.ok(
    TEST_FILES.length > 60,
    `only ${TEST_FILES.length} test files scanned from ${TESTS_ROOT} — the base directory is wrong, ` +
      `and an under-count here produces confident false "uncovered" findings.`,
  );
});

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
