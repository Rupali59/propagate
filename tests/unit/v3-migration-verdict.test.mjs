/**
 * v3-migration-verdict.test.mjs — PR-001, decided 2026-09-24.
 *
 * A workspace that never began the v3 migration FAILS the gate. It used to be an
 * `info` line, so three never-begun workspaces produced one neutral row between
 * them and nothing about doctor's exit code changed.
 *
 * THE CARVE-OUT IS THE INTERESTING HALF, and it is why this file exists rather
 * than a one-line change. `tests/cli/doctor.test.mjs`'s negative control records
 * that requiring the full v3 tree UNCONDITIONALLY "makes every fresh install fail
 * by definition until the migration completes", and
 * `tests/cli/stranger-install.test.mjs` asserts a stranger reaches doctor-clean —
 * an invariant whose `|| true` escape was deliberately removed after it hid
 * exactly this bug. So the predicate is adoption ASYMMETRY, not absence.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { migrationVerdict, MIGRATION_BEGUN_LABEL } from "../../lib/core/v3-layout.mjs";

const rep = ({ conforming = 0, total = 0, offenders = [], notStarted = [] }) => ({
  conforming,
  total,
  offenders,
  notStarted,
});
const ws = (name) => ({ name, missing: [] });

test("the label is exactly the one doctor emits", () => {
  // Written as a literal, not via the constant, on purpose: this is the string
  // tests/cli/doctor-check-coverage.test.mjs matches to decide whether the check
  // has a failing-case test at all, and it matches test SOURCE.
  assert.equal(MIGRATION_BEGUN_LABEL, "v3 migration begun in every workspace");
});

test("FAILS when some workspaces conform and others never began — the asymmetric gap", () => {
  const v = migrationVerdict(rep({ conforming: 17, total: 20, notStarted: [ws("Grid"), ws("Motion-Graphics"), ws("firstmate")] }));
  assert.equal(v.kind, "fail", "asymmetric adoption is a gap someone chose not to close");
  assert.equal(v.label, "v3 migration begun in every workspace");
  assert.match(v.detail, /3 not begun/);
  assert.match(v.detail, /Grid, Motion-Graphics, firstmate/, "the detail must NAME them, not just count them");
});

test("does NOT fail when nothing has begun anywhere — a fresh install is a starting point", () => {
  const v = migrationVerdict(rep({ conforming: 0, total: 2, notStarted: [ws("a"), ws("b")] }));
  assert.equal(v.kind, "info", "failing here fails someone for work they have just started");
  assert.match(v.detail, /starting point, not a gap/);
});

test("PASSES when every workspace has begun", () => {
  const v = migrationVerdict(rep({ conforming: 5, total: 5 }));
  assert.equal(v.kind, "pass");
  assert.equal(v.detail, "5/5 begun");
});

test("says NOTHING on an empty population — the inconclusive entry owns that case", () => {
  // Two voices on one condition would double-count it, which is the G20
  // double-voting failure the Reporter's own docstring warns about.
  assert.equal(migrationVerdict(rep({ total: 0 })).kind, "none");
  assert.equal(migrationVerdict(null).kind, "none");
});

test("one never-begun among many is still a failure — the boundary, not just the bulk case", () => {
  const v = migrationVerdict(rep({ conforming: 99, total: 100, notStarted: [ws("lonely")] }));
  assert.equal(v.kind, "fail", "99 of 100 adopted makes the hundredth a gap, not a starting point");
});
