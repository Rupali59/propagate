/**
 * Router bodies are budgeted at <500 words (frontmatter excluded). The budget
 * yields before any rule in Contract/Important Rules gets cut; this test only
 * proves the count, not that nothing load-bearing was removed to hit it.
 *
 * REVISED 2026-08-22. It used to budget three files — `SKILL.md`,
 * `skills/routing/SKILL.md`, `skills/reconcile/SKILL.md`. The latter two are now
 * `skills/propagate/sections/{routing,reconcile}.md`: sections the parent Reads on
 * demand rather than separately discoverable skills. As skills they declared the
 * BARE names `routing` and `reconcile`, squatting generic global names, and
 * `curate-docs`'s two did the same with `design` and `eng`.
 *
 * WHAT IS BUDGETED, AND WHAT DELIBERATELY IS NOT. The two ROUTERS are budgeted,
 * because a router is read on every invocation and its whole job is to point
 * elsewhere quickly. The SECTIONS are not: they are where the detail went, and
 * they currently run 527-762 words. Budgeting them at 500 would fail on the day
 * this landed and would fight the decomposition that moving them achieved.
 *
 * The budget is TIGHT by construction — `SKILL.md` measured 499/500 before this
 * change, so any addition must pay for itself. That is the intended pressure.
 *
 * Sections get a different guard instead, because their real regression is not
 * length: if one regrows YAML frontmatter it becomes a discoverable skill again
 * and re-squats the bare name this change freed. That is silent and would only
 * surface as a namespace collision, so it is asserted here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");

/** The discoverable skills. `SKILL.md` is the same file as
 *  `skills/propagate/SKILL.md`, which is a symlink to it — budgeting the target
 *  covers both, and editing either writes through. */
const ROUTERS = [
  { name: "propagate", file: path.join(ROOT, "SKILL.md") },
  { name: "curate-docs", file: path.join(ROOT, "skills", "curate-docs", "SKILL.md") },
];

const SECTIONS = [
  path.join(ROOT, "skills", "propagate", "sections", "routing.md"),
  path.join(ROOT, "skills", "propagate", "sections", "reconcile.md"),
  path.join(ROOT, "skills", "curate-docs", "sections", "design.md"),
  path.join(ROOT, "skills", "curate-docs", "sections", "eng.md"),
];

/** Word count of everything after the closing `---` of YAML frontmatter. */
function bodyWordCount(file) {
  const text = readFileSync(file, "utf8");
  const m = text.match(/^---\n[\s\S]*?\n---\n/);
  assert.ok(m, `${file} has no YAML frontmatter block`);
  return text.slice(m[0].length).split(/\s+/).filter(Boolean).length;
}

for (const { name, file } of ROUTERS) {
  test(`${name}/SKILL.md body is under 500 words`, () => {
    const words = bodyWordCount(file);
    assert.ok(
      words < 500,
      `${name}/SKILL.md body is ${words} words, over the 500-word budget. ` +
        `Per the plan, compress prose around a rule -- never cut the rule itself. ` +
        `Moving detail into sections/ is the other lever.`,
    );
  });
}

test("every section the routers cite exists", () => {
  for (const f of SECTIONS) {
    assert.ok(existsSync(f), `${path.relative(ROOT, f)} is cited by a router but missing`);
  }
});

test("no section carries frontmatter — it would become a discoverable skill again", () => {
  for (const f of SECTIONS) {
    const text = readFileSync(f, "utf8");
    assert.ok(
      !/^---\n/.test(text),
      `${path.relative(ROOT, f)} has regrown YAML frontmatter. It would be discovered as a ` +
        `skill under its BARE name, re-squatting the generic global name this change freed. ` +
        `Sections state their trigger in a "When this applies:" line instead.`,
    );
  }
});
