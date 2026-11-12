// agents/*.md (propagate#251): the population is derived from the directory, never listed, with a floor.
// Every agent: name equals its file, a "Use when" description (rule:description-standard), explicit tools and
// model. An agent with no write tool is read-only by declaration, so the guard MUST list it: otherwise the
// declaration is prose and its Bash is unguarded. Public-repo leaks are make-public --check's job (tracked files).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { READ_ONLY } from "../../hooks/agent-guard.mjs";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "agents");
const FLOOR = 1; // raised as agents land; #251 ships 3

function frontmatter(src) {
  const m = src.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return null;
  return Object.fromEntries(
    m[1].split("\n").map((l) => l.match(/^([a-zA-Z]+):\s*(.*)$/)).filter(Boolean).map((x) => [x[1], x[2].trim()]),
  );
}

const agents = readdirSync(DIR).filter((f) => f.endsWith(".md")).map((f) => ({ file: f, src: readFileSync(path.join(DIR, f), "utf8") }));

test(`agents/ holds at least ${FLOOR} agent (a blind scan is not an empty pass)`, () => {
  assert.ok(agents.length >= FLOOR, `only ${agents.length} agent files found in ${DIR}: the scan has gone blind`);
});

for (const { file, src } of agents) {
  test(`${file}: frontmatter is complete and the read-only declaration is enforced`, () => {
    const fm = frontmatter(src);
    assert.ok(fm, `${file} has no frontmatter block`);
    assert.equal(fm.name, file.replace(/\.md$/, ""), "name must equal the file name (it registers as propagate:<name>)");
    assert.match(fm.description ?? "", /^Use when /, "description says WHEN to use it (rule:description-standard)");
    assert.ok(fm.tools, "tools must be explicit: an omitted tools line inherits every tool");
    assert.ok(fm.model, "model must be explicit (rule:model-routing)");
    const tools = fm.tools.split(",").map((t) => t.trim());
    const writes = tools.some((t) => ["Write", "Edit", "NotebookEdit"].includes(t));
    if (!writes) assert.ok(READ_ONLY.includes(fm.name), `${fm.name} has no write tool but is not in agent-guard READ_ONLY, so its Bash is unguarded`);
    assert.match(src, /```json/, "the body must specify the JSON output its checker reads");
  });
}

test("every READ_ONLY name the guard protects is either a shipped agent or still to land (no stale names after #251)", () => {
  const shipped = new Set(agents.map((a) => a.file.replace(/\.md$/, "")));
  const pending = READ_ONLY.filter((n) => !shipped.has(n));
  // Until #251 step 4 lands, doc-curator and adversarial-reviewer are pending; after it, none may be.
  assert.ok(pending.every((n) => ["doc-curator", "adversarial-reviewer"].includes(n)), `stale READ_ONLY names: ${pending.join(", ")}`);
});
