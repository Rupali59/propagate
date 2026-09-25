/**
 * fullStateSnapshot() — every byte of every file under a state directory,
 * path-qualified so a rename is visible too, not just a content change.
 *
 * Extracted from tests/cli/reminders.test.mjs (L4) so a second lane's
 * dry-run tests can reuse the exact same shape rather than writing a second
 * copy — per rule:safety-flag-needs-a-test, the test that measures the
 * store is the load-bearing part, and two slightly-different
 * implementations of "the whole store" is exactly the kind of drift that
 * could make one of them wrong without anyone noticing.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/** @param {string} stateDir */
export function fullStateSnapshot(stateDir) {
  if (!existsSync(stateDir)) return "<absent>";
  const files = [];
  (function walk(d) {
    for (const name of readdirSync(d).sort()) {
      const p = path.join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else files.push(p);
    }
  })(stateDir);
  return files
    .sort()
    .map((p) => `${path.relative(stateDir, p)}\u0000${readFileSync(p, "utf8")}`)
    .join("\u0001");
}
