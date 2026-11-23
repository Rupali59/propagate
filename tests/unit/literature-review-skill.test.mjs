/**
 * The literature-review coordinator skill (propagate#327): discoverable, every command it names exists, every section
 * it links exists, both approval stops are present, and it never tells the coordinator to search the web.
 *
 * The population of `kb review` subcommands is DERIVED from the command table (rule:derive-dont-curate), with a floor:
 * a table that parsed to no subcommands is a blind scan. The skill must name every one of them, so a subcommand added
 * later without a step in the loop fails here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { COMMANDS } from "../../lib/core/commands.mjs";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const DIR = path.join(ROOT, "skills", "literature-review");
const SKILL = readFileSync(path.join(DIR, "SKILL.md"), "utf8");
const SECTIONS = existsSync(path.join(DIR, "sections")) ? readdirSync(path.join(DIR, "sections")).filter((f) => f.endsWith(".md")) : [];
const WHOLE = [SKILL, ...SECTIONS.map((f) => readFileSync(path.join(DIR, "sections", f), "utf8"))].join("\n");
const front = /^---\n([\s\S]*?)\n---\n/.exec(SKILL);

test("frontmatter: name, a 'Use when' description that names the knowledge base and the three triggers", () => {
  assert.ok(front, "no frontmatter");
  assert.match(front[1], /^name: literature-review$/m);
  const d = /^description:\s*(.+)$/m.exec(front[1]);
  assert.ok(d, "no description");
  assert.match(d[1], /^Use when a question needs a literature review whose findings may reach the knowledge base/);
  for (const t of ["literature review", "research X for the kb", "what does the literature say about"]) assert.ok(d[1].includes(t), `description lacks the trigger "${t}"`);
});

test("every kb review subcommand in the command table is named in the loop, and every one named exists", () => {
  const subs = Object.keys(COMMANDS).filter((k) => k.startsWith("kb review ")).map((k) => k.slice("kb review ".length));
  assert.ok(subs.length >= 5, `only ${subs.length} kb review subcommands derived from the table: the scan has gone blind`);
  const named = new Set([...SKILL.matchAll(/\bkb review (\w+)/g)].map((m) => m[1]));
  for (const s of subs) assert.ok(named.has(s), `SKILL.md never names kb review ${s}: the loop skips a step`);
  for (const s of [...WHOLE.matchAll(/\bkb review (\w+)/g)].map((m) => m[1])) assert.ok(subs.includes(s), `the skill names kb review ${s}, which is not in the command table`);
  for (const c of ["kb search", "kb discover", "kb fetch"]) {
    assert.ok(COMMANDS[c], `${c} is not in the command table`);
    assert.ok(SKILL.includes(c), `SKILL.md never names ${c}`);
  }
});

test("the loop runs commands through the plugin root, never a bare `propagate` (not on PATH in another workspace, #253)", () => {
  assert.match(SKILL, /node \$\{CLAUDE_PLUGIN_ROOT\}\/cli\.mjs/);
  assert.doesNotMatch(WHOLE, /(^|[\s`])propagate kb /m);
});

test("every section file the body links exists, and there is at least one", () => {
  const links = [...SKILL.matchAll(/sections\/([a-z-]+\.md)/g)].map((m) => m[1]);
  assert.ok(links.length >= 4, `only ${links.length} section links found: the scan has gone blind`);
  for (const l of new Set(links)) assert.ok(existsSync(path.join(DIR, "sections", l)), `SKILL.md links sections/${l}, which does not exist`);
  for (const f of SECTIONS) assert.ok(SKILL.includes(`sections/${f}`), `sections/${f} is not linked from SKILL.md (an orphan)`);
});

test("the two approval stops are present, and the gate's own sample is not skipped", () => {
  assert.equal((SKILL.match(/\bStop for the maintainer/g) ?? []).length, 2, "SKILL.md needs exactly two 'Stop for the maintainer' points: the protocol, and the sample decisions");
  assert.match(SKILL, /Stop for the maintainer's approval of `?protocol\.md/);
  assert.match(SKILL, /Stop for the maintainer's decisions on the sample/);
});

test("the body never instructs WebSearch (or WebFetch) for sources: every mention is a prohibition", () => {
  const lines = WHOLE.split("\n").filter((l) => /WebSearch|WebFetch/.test(l));
  assert.ok(lines.length >= 1, "the skill should state the prohibition, not stay silent about it");
  for (const l of lines) assert.match(l, /\b(never|no|not|denied)\b/i, `a line names WebSearch/WebFetch without a prohibition: ${l}`);
});

test("the hard rules and budgets are stated", () => {
  for (const [re, what] of [
    [/never screens? or quotes?/i, "the coordinator never screens or quotes"],
    [/never edits? `?brief\.json/i, "never edits brief.json"],
    [/writes? no knowledge-base file|never writes? (a |any )?knowledge-base file/i, "writes no knowledge-base file"],
    [/3-5 (researcher )?lanes/i, "3-5 lanes"],
    [/10-15 tool calls/i, "10-15 tool calls per lane"],
    [/exactly one snowball round|one snowball round/i, "one snowball round"],
    [/foreground/i, "researchers run in the foreground"],
    [/propagate:literature-researcher/, "the dispatched agent type"],
    [/`?included`? sources/i, "snowball only from included sources"],
  ]) assert.match(WHOLE, re, `the skill does not state: ${what}`);
  assert.ok(existsSync(path.join(ROOT, "agents", "literature-researcher.md")), "the agent the skill dispatches is missing");
});

test("sections carry no frontmatter and say when they apply", () => {
  for (const f of SECTIONS) {
    const t = readFileSync(path.join(DIR, "sections", f), "utf8");
    assert.ok(!/^---\n/.test(t), `${f} has frontmatter, so it would be discovered as a skill`);
    assert.match(t, /When this applies:/, `${f} states no "When this applies:" line`);
  }
});
