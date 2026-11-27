// agents/*.md (propagate#251): the population is derived from the directory, never listed, with a floor.
// Every agent: name equals its file, a "Use when" description (rule:description-standard), explicit tools and
// model. An agent with no write tool is read-only by declaration, so the guard MUST list it: otherwise the
// declaration is prose and its Bash is unguarded. Public-repo leaks are make-public --check's job (tracked files).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { READ_ONLY, RESEARCH_READ_ONLY } from "../../hooks/agent-guard.mjs";
import { COMMANDS } from "../../lib/core/commands.mjs";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "agents");
const FLOOR = 3; // #251 shipped edge-settler, doc-curator, adversarial-reviewer

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
    // literature-researcher (#327) is guarded by the second policy, RESEARCH_READ_ONLY: Read only, and only of the store.
    if (!writes) assert.ok(READ_ONLY.includes(fm.name) || RESEARCH_READ_ONLY.includes(fm.name), `${fm.name} has no write tool but is in neither agent-guard READ_ONLY nor RESEARCH_READ_ONLY, so its tools are unguarded`);
    assert.match(src, /```json/, "the body must specify the JSON output its checker reads");
  });
}

// Rupali, 2026-11-12: "if we are replacing a functionality, it better have a deterministic check at the end".
// Derived from each agent body, not a list: the body must name its gate, and the gate must exist. A gate is either
// a propagate subcommand run as `node ${CLAUDE_PLUGIN_ROOT}/cli.mjs <gate>` (#253: a repo-relative script path cannot
// be found from another workspace, and `propagate` is not on PATH): `check-curator`, `check-review`, or `settle … --check`.
for (const { file, src } of agents) {
  test(`${file}: names a deterministic gate that exists`, () => {
    const ROOT = path.join(DIR, "..");
    assert.doesNotMatch(src, /(?<!\/)scripts\/check-|`propagate (settle|graph|check)/, `${file} names a gate by a repo-relative path or a bare \`propagate\`, which a session in another workspace cannot run (#253)`);
    const gates = [...src.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/cli\.mjs (check-curator|check-review|settle <file> --check|kb review (?:assemble|check|agree))/g)].map((m) => m[1]);
    assert.ok(gates.length, `${file} names no gate: an agent without a deterministic check is not shipped`);
    const cli = readFileSync(path.join(ROOT, "cli.mjs"), "utf8");
    for (const g of gates) {
      if (g.startsWith("kb review ")) assert.ok(COMMANDS[g], `${file} names ${g}, which is not in the command table`);
      else if (g.startsWith("settle")) assert.match(readFileSync(path.join(ROOT, "cli", "settle.mjs"), "utf8"), /"--check"/, "settle has no --check");
      else assert.match(cli, new RegExp(`mode === "${g}"`), `${file} names ${g}, which cli.mjs does not dispatch`);
    }
  });
}

test("every READ_ONLY name the guard protects is either a shipped agent or still to land (no stale names after #251)", () => {
  const shipped = new Set(agents.map((a) => a.file.replace(/\.md$/, "")));
  const pending = [...READ_ONLY, ...RESEARCH_READ_ONLY].filter((n) => !shipped.has(n));
  assert.deepEqual(pending, [], `READ_ONLY names with no agent file (stale guard entries): ${pending.join(", ")}`);
});

// literature-researcher (#327): one tool, Read; the guard confines it (tests/hooks/agent-guard-research.test.mjs).
const researcher = agents.find((a) => a.file === "literature-researcher.md");
test("literature-researcher: exists, one tool (Read), sonnet, 'Use when', and states the contract the gate checks", () => {
  assert.ok(researcher, "agents/literature-researcher.md is missing");
  const fm = frontmatter(researcher.src);
  assert.match(fm.description, /^Use when a literature-review coordinator hands one lane a research question and a list of saved source files to screen and quote from/);
  assert.equal(fm.tools, "Read", "the researcher's only tool is Read: anything more is an exfiltration path");
  assert.equal(fm.model, "sonnet");
  assert.match(researcher.src, /6-15 words/, "the body must state the 6-15 word quote rule");
  assert.match(researcher.src, /injected-instruction/, "the body must name the injected-instruction tag");
  assert.match(researcher.src, /exactly one JSON object/i);
  // #368: a file is identified from its own text, never from the order of parallel reads.
  assert.match(researcher.src, /identified_as/, "the body must require identified_as per screened source");
  assert.match(researcher.src, /never[^.]*from the order/i, "the body must forbid mapping files to papers from the order of reads");
  assert.ok(RESEARCH_READ_ONLY.includes("literature-researcher"), "the guard must list the researcher");
});

// literature-rater (#412): the model second rater. One tool, Read, opus, and it never sees the lanes' decisions.
const rater = agents.find((a) => a.file === "literature-rater.md");
test("literature-rater: exists, one tool (Read), opus, 'Use when', per-criterion quotes, and no access to the lanes' decisions", () => {
  assert.ok(rater, "agents/literature-rater.md is missing");
  const fm = frontmatter(rater.src);
  assert.match(fm.description, /^Use when /);
  assert.equal(fm.tools, "Read", "the rater's only tool is Read: anything more is an exfiltration path");
  assert.equal(fm.model, "opus");
  assert.match(rater.src, /6-15 words/, "the body must state the 6-15 word quote rule");
  assert.match(rater.src, /each criterion separately|EVERY criterion/i, "the body must require an answer per criterion");
  assert.match(rater.src, /never[^.]*first reviewer's decision/i, "the body must forbid using the first reviewer's decision");
  assert.ok(RESEARCH_READ_ONLY.includes("literature-rater"), "the guard must list the rater");
  assert.doesNotMatch(rater.src, /Rupali/, "the repo is public: say the maintainer");
});
