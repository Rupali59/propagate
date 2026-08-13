/**
 * --dry-run must not delete anything.
 *
 * digest.mjs's header promises "--dry-run — print, write NO state". Until
 * 2026-08-14 that was false: `dryRun` existed only inside runDigest(), where it
 * gated state-writing and delivery, while buildSnapshot() -> lifecycleSweep()
 * called `lc.reap(candidates, { apply: true })` unconditionally. A "preview"
 * ran an armed skill deletion. Nothing was lost only because zero skills were
 * reapable at the time (docs/GOTCHAS.md G22).
 *
 * These are source-level assertions, and that is a deliberate, stated
 * limitation rather than an oversight: exercising the real path means running
 * lifecycle discovery against the live ~/.claude/skills tree, and a test whose
 * failure mode is "deleted one of Rupali's skills" is not a test worth having.
 * The bug was pure wiring — a parameter that did not reach its call site — so a
 * wiring assertion catches exactly the regression that occurred. The behaviour
 * of reap() itself (archives first, refuses when disarmed) is covered by
 * skills-lifecycle's own tests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DIGEST = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "digest.mjs"),
  "utf8",
);

test("digest never calls reap with a hardcoded apply:true", () => {
  const armed = DIGEST.match(/reap\([^)]*\{\s*apply:\s*true\s*\}/);
  assert.equal(
    armed,
    null,
    "reap() is hardcoded armed — a --dry-run digest would delete. Gate it on !dryRun.",
  );
});

test("reap is gated on the dryRun flag", () => {
  assert.match(
    DIGEST,
    /lc\.reap\(candidates,\s*\{\s*apply:\s*!dryRun\s*\}\)/,
    "reap must be applied only when this is not a dry run",
  );
});

test("dryRun reaches lifecycleSweep from the CLI entry point", () => {
  // The three links in the chain that was broken. Each is asserted separately
  // so a failure names which link came apart, rather than just "wiring".
  assert.match(DIGEST, /async function buildSnapshot\([^)]*dryRun/, "buildSnapshot must accept dryRun");
  assert.match(DIGEST, /buildSnapshot\(indexDb,\s*\{\s*dryRun\s*\}\)/, "runDigest must pass dryRun to buildSnapshot");
  assert.match(DIGEST, /lifecycleSweep\(dryRun\)/, "buildSnapshot must pass dryRun to lifecycleSweep");
  assert.match(DIGEST, /async function lifecycleSweep\(dryRun/, "lifecycleSweep must accept dryRun");
});

test("a preview-skipped reap is distinguishable from a disarmed one", () => {
  // Two different reasons for the same absence must not collapse into one
  // field, or a preview reads as the kill switch firing (G2).
  assert.match(DIGEST, /reapPreviewOnly/, "preview-skipped reaps need their own field");
  assert.match(DIGEST, /reapBlocked/, "disarm-blocked reaps keep theirs");
});
