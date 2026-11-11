/**
 * The design-workflow skill (propagate#242): discoverable, matrix-complete, issue-linked.
 *
 * The stack list is DERIVED from the matrix header in SKILL.md, never kept here (rule:derive-dont-curate),
 * and the derivation has a floor: a matrix that parsed to no stacks is a blind scan, not a pass.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const SKILL_DIR = path.join(ROOT, "skills", "design-workflow");
const SKILL = readFileSync(path.join(SKILL_DIR, "SKILL.md"), "utf8");

/** Every markdown file of the skill: the router and each section. The matrix is FOUND in whichever
 *  one holds it (it moved out of SKILL.md to keep the router under the word budget), never assumed. */
const SECTION_FILES = readdirSync(path.join(SKILL_DIR, "sections")).filter((f) => f.endsWith(".md"));
const WHOLE = [SKILL, ...SECTION_FILES.map((f) => readFileSync(path.join(SKILL_DIR, "sections", f), "utf8"))].join("\n");

/** The matrix: the table whose header row starts `| Step |` and has a `flutter` column. */
function matrix() {
  const lines = WHOLE.split("\n");
  const start = lines.findIndex((l) => /^\|\s*Step\s*\|\s*flutter\s*\|/.test(l));
  assert.ok(start >= 0, "matrix header (| Step | flutter | ...) not found in the skill — the scan has gone blind");
  const cells = (l) => l.split("|").slice(1, -1).map((c) => c.trim());
  const header = cells(lines[start]);
  const rows = [];
  for (let i = start + 2; i < lines.length && lines[i].startsWith("|"); i++) rows.push(cells(lines[i]));
  return { header, rows };
}

test("frontmatter has the name and a when-to-use description", () => {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(SKILL);
  assert.ok(m, "no frontmatter");
  assert.match(m[1], /^name: design-workflow$/m);
  const d = /^description:\s*(.+)$/m.exec(m[1]);
  assert.ok(d, "no description");
  assert.match(d[1], /^Use when /, "a description says WHEN to use it (rule:description-standard)");
  for (const w of ["UI", "components", "design tokens", "motion", "DESIGN.md"]) assert.ok(d[1].includes(w), `description names ${w}`);
});

test("a sections/<stack>.md exists for each stack column, derived from the matrix", () => {
  const { header } = matrix();
  const stacks = header.slice(1).filter((c) => c.toLowerCase() !== "other");
  assert.ok(stacks.length >= 2, `only ${stacks.length} stack columns derived from the matrix — the scan has gone blind`);
  for (const s of stacks) {
    assert.ok(existsSync(path.join(SKILL_DIR, "sections", `${s}.md`)), `matrix column "${s}" has no sections/${s}.md`);
  }
  // and no stack section exists that the matrix does not name (`workflow` is the shared section, not a stack)
  const files = SECTION_FILES.map((f) => f.replace(/\.md$/, "")).filter((f) => f !== "workflow");
  assert.deepEqual(files.sort(), [...stacks].sort(), "a section file with no matrix column");
});

test("every custom cell names an issue number, in the matrix and in each section", () => {
  const { rows } = matrix();
  const sources = [
    ["the matrix", rows.flat()],
    ...readdirSync(path.join(SKILL_DIR, "sections")).map((f) => [
      `sections/${f}`, readFileSync(path.join(SKILL_DIR, "sections", f), "utf8").split("\n").filter((l) => l.startsWith("|")),
    ]),
  ];
  let customCells = 0;
  for (const [where, cells] of sources) {
    for (const c of cells) {
      if (!/\*\*custom/i.test(c)) continue;
      customCells++;
      // a section row holds several cells; every custom marker must be followed by its issue in the same row
      assert.match(c, /#\d+/, `${where}: a custom cell with no issue number: ${c.slice(0, 80)}`);
    }
  }
  assert.ok(customCells >= 8, `only ${customCells} custom cells found — the scan has gone blind`);
});

test("sections carry no frontmatter, so they stay sections and not skills", () => {
  for (const f of readdirSync(path.join(SKILL_DIR, "sections"))) {
    assert.ok(!readFileSync(path.join(SKILL_DIR, "sections", f), "utf8").startsWith("---"), `${f} has frontmatter`);
  }
});

test("the ten steps and the definition of done are present", () => {
  const wf = readFileSync(path.join(SKILL_DIR, "sections", "workflow.md"), "utf8");
  for (let n = 1; n <= 10; n++) assert.match(wf, new RegExp(`^\\| ${n} \\|`, "m"), `step ${n}`);
  assert.match(wf, /Definition of done/);
  assert.match(wf, /Design-first for anything users see/);
  assert.match(wf, /only as `draft`, never as `stable`/);
  // the router names every step too, one line each
  for (let n = 1; n <= 10; n++) assert.match(SKILL, new RegExp(`^${n}\\. `, "m"), `router step ${n}`);
});

test("the router points at the skill, and the public repo carries no personal names", () => {
  assert.match(readFileSync(path.join(ROOT, "skills", "propagate", "sections", "routing.md"), "utf8"), /design-workflow/);
  const all = WHOLE;
  assert.doesNotMatch(all, /Rupali|Kirti|Sindhu|@[a-z0-9.-]+\.(com|in)\b/);
});
