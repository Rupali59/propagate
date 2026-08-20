/**
 * Each of the three decomposed skills (propagate, routing, reconcile) is
 * budgeted at <500 words of BODY text (frontmatter excluded) — see
 * docs/plans/2026-08-19-... (Lane A) and the standard-check note in
 * docs/plans this work was scoped from. The budget yields before any rule
 * in Contract/Important Rules gets cut; this test only proves the count,
 * not that nothing load-bearing was removed to hit it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");

const SKILLS = [
  { name: "propagate", file: path.join(ROOT, "SKILL.md") },
  { name: "routing", file: path.join(ROOT, "skills", "routing", "SKILL.md") },
  { name: "reconcile", file: path.join(ROOT, "skills", "reconcile", "SKILL.md") },
];

/** Word count of everything after the closing `---` of YAML frontmatter. */
function bodyWordCount(file) {
  const text = readFileSync(file, "utf8");
  const m = text.match(/^---\n[\s\S]*?\n---\n/);
  assert.ok(m, `${file} has no YAML frontmatter block`);
  const body = text.slice(m[0].length);
  return body.split(/\s+/).filter(Boolean).length;
}

for (const { name, file } of SKILLS) {
  test(`${name}/SKILL.md body is under 500 words`, () => {
    const words = bodyWordCount(file);
    assert.ok(
      words < 500,
      `${name}/SKILL.md body is ${words} words, over the 500-word budget. ` +
        `Per the plan, compress prose around a rule -- never cut the rule itself.`,
    );
  });
}
