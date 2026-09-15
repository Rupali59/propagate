/**
 * Every `claims` subcommand the CODE dispatches must be discoverable.
 *
 * WHY THIS IS A TEST AND NOT A DOC FIX. The Phase 1/2a lane added `answer`,
 * `restate` and `verdict` across two PRs and documented none of them. Measured
 * when this file was written: `commands/claims.mjs` dispatched six subcommands
 * plus `check`, while `cli.mjs`'s usage string named two, `docs/REFERENCE.md`
 * named one, and `sections/routing.md` — the doc whose entire job is "which
 * cli.mjs command answers what" — mentioned `claims` zero times. Worst of the
 * four: `verdict` was missing from the command's OWN usage text, and it is the
 * only subcommand that writes.
 *
 * A one-time edit fixes that until the next subcommand lands, which is the
 * same drift the whole repo exists to catch — `rule:enforcement-watches-itself`:
 * a check pointed at everything except its own toolchain. So the list is
 * DERIVED FROM THE SOURCE rather than restated here. Add a dispatch arm and
 * this test fails until every surface names it; there is no list to update.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

/**
 * The subcommands `claimsCmd` actually routes, read out of its dispatch arms.
 * `check` is the fallthrough default (`argv[0] === "check" ? ...`), so it is
 * added explicitly — it has no `sub === "check"` arm to find.
 */
function dispatchedSubcommands() {
  const src = read("commands/claims.mjs");
  const found = [...src.matchAll(/sub === "([a-z]+)"/gu)].map((m) => m[1]);
  return [...new Set([...found, "check"])].sort();
}

test("the source dispatches the subcommands this test thinks it does", () => {
  // Guards the DERIVATION itself. If the dispatch idiom is refactored away,
  // `dispatchedSubcommands()` silently returns ["check"] and every assertion
  // below passes vacuously — a check that cannot fail
  // (`rule:discernment-checks` §1).
  const subs = dispatchedSubcommands();
  assert.ok(subs.length >= 6, `expected >=6 dispatched subcommands, parsed ${subs.length}: ${subs.join(", ")} — has the dispatch idiom changed?`);
  for (const expected of ["judge", "restate", "verdict", "answer"]) {
    assert.ok(subs.includes(expected), `"${expected}" must be parsed out of the dispatch arms`);
  }
});

for (const surface of [
  "cli.mjs",
  "docs/REFERENCE.md",
  "skills/propagate/sections/routing.md",
]) {
  test(`every dispatched claims subcommand is named in ${surface}`, () => {
    const text = read(surface);
    const missing = dispatchedSubcommands().filter((s) => !text.includes(`claims ${s}`));
    assert.deepEqual(
      missing,
      [],
      `${surface} does not name: ${missing.map((s) => `claims ${s}`).join(", ")}. ` +
        `A subcommand no surface documents is one nobody can find.`,
    );
  });
}

test("the command's OWN usage text names every subcommand it dispatches", () => {
  // The sharpest case: `verdict` is the only claims subcommand that WRITES,
  // and it was absent from the usage block printed on an unknown subcommand —
  // so the write path was undiscoverable from the tool itself.
  const src = read("commands/claims.mjs");
  // BOUNDED TO THE HELP BLOCK, and that bound is load-bearing. Slicing to
  // end-of-file swept in `verdictSub`s own usage string 600 lines later, so
  // this test passed while the help block genuinely omitted `verdict` — green
  // for the wrong reason (`rule:discernment-checks` §4).
  const start = src.indexOf("unknown claims subcommand");
  assert.notEqual(start, -1, "the usage block anchor moved — this test is no longer reading it");
  const usage = src.slice(start, src.indexOf("return 2;", start));
  const missing = dispatchedSubcommands().filter((s) => !usage.includes(`claims ${s}`));
  assert.deepEqual(missing, [], `the usage block omits: ${missing.map((s) => `claims ${s}`).join(", ")}`);
});
