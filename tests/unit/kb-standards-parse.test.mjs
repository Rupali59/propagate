import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parsePage } from "../../lib/kb/standards/parse.mjs";
import { loadRegistry, loadStandards } from "../../lib/kb/standards/registry.mjs";

const PAGE = `---
id: acme-tool
kind: tool
authority:
  - {name: "Acme docs", url: https://docs.acme.example, scope: "behaviour of the SDK"}
version_probe: acme-tool
supersedes: []
---

# Acme tool

## Rows

### acme-tool-001 · Cap settle waits
**State:** adopted
**Source:** Acme API docs https://docs.acme.example/settle · **Version:** acme-tool 3.47.7 · **Checked:** 2026-11-14
**Apply:** cap settle waits in helpers
**Check:** test: **/support.dart contains settleBounded
**Fails when:** the cap is removed
**Broadcast:** no
**Superseded by:** —

### acme-tool-002 · Pin the lockfile
**State:** draft
**Source:** Acme guide
**Apply:** commit the lockfile
**Check:** review: reviewer confirms
**Broadcast:** yes
**Superseded by:** acme-tool-009
`;

test("a 2-row page parses both rows with every field", () => {
  const p = parsePage(PAGE, "acme-tool.md");
  assert.equal(p.id, "acme-tool");
  assert.equal(p.kind, "tool");
  assert.equal(p.versionProbe, "acme-tool");
  assert.deepEqual(p.authority, [{ name: "Acme docs", url: "https://docs.acme.example", scope: "behaviour of the SDK" }]);
  assert.deepEqual(p.supersedes, []);
  assert.deepEqual(p.problems, []);
  assert.equal(p.rows.length, 2);
  const [a, b] = p.rows;
  assert.equal(a.id, "acme-tool-001");
  assert.equal(a.title, "Cap settle waits");
  assert.equal(a.state, "adopted");
  assert.equal(a.source, "Acme API docs https://docs.acme.example/settle");
  assert.equal(a.version, "acme-tool 3.47.7");
  assert.equal(a.checked, "2026-11-14");
  assert.equal(a.apply, "cap settle waits in helpers");
  assert.deepEqual(a.check, { kind: "test", target: "**/support.dart contains settleBounded" });
  assert.equal(a.failsWhen, "the cap is removed");
  assert.equal(a.broadcast, false);
  assert.equal(a.supersededBy, null);
  assert.equal(a.line, 14);
  assert.equal(b.state, "draft");
  assert.equal(b.broadcast, true);
  assert.equal(b.supersededBy, "acme-tool-009");
  assert.equal(b.version, null);
  assert.equal(b.checked, null);
  assert.equal(b.check.kind, "review");
});

test("a duplicate row id is a problem, never silently last-wins", () => {
  const text = PAGE + `\n### acme-tool-001 · Same id again\n**State:** adopted\n**Check:** none\n`;
  const p = parsePage(text, "acme-tool.md");
  assert.ok(p.problems.includes("duplicate row id acme-tool-001 (lines 14, 31)"), p.problems.join("|"));
  assert.equal(p.rows.filter((r) => r.id === "acme-tool-001").length, 2);
});

test("a row missing Check gets kind none", () => {
  const text = PAGE.replace(/\*\*Check:\*\* review: reviewer confirms\n/, "");
  const p = parsePage(text, "acme-tool.md");
  assert.deepEqual(p.rows[1].check, { kind: "none", target: null });
  assert.deepEqual(p.problems, []);
});

test("an unknown check kind is a problem", () => {
  const text = PAGE.replace("**Check:** review: reviewer confirms", "**Check:** vibes: it feels fine");
  const p = parsePage(text, "acme-tool.md");
  assert.ok(p.problems.some((x) => x.includes("unknown check kind") && x.includes("vibes")), p.problems.join("|"));
});

test("an unknown state is a problem", () => {
  const p = parsePage(PAGE.replace("**State:** draft", "**State:** maybe"), "acme-tool.md");
  assert.ok(p.problems.some((x) => x.includes("unknown state") && x.includes("maybe")));
});

test("a page with no frontmatter reports a problem instead of parsing as empty", () => {
  const p = parsePage("### acme-tool-001 · x\n**State:** adopted\n", "x.md");
  assert.ok(p.problems.some((x) => x.includes("frontmatter")));
});

function fixture(registryYaml, pages = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "std-"));
  const file = path.join(dir, "standards.yml");
  if (registryYaml !== null) writeFileSync(file, registryYaml);
  const pdir = path.join(dir, "pages");
  mkdirSync(pdir, { recursive: true });
  for (const [n, t] of Object.entries(pages)) writeFileSync(path.join(pdir, n), t);
  return { dir, file, pdir };
}

const REG = `schema_version: 1
standards:
  acme-tool:
    kind: tool
    page: acme-tool.md
    authority: [Acme docs]
    detect: {files: [acme.yaml]}
    probe: acme-tool
    pointer_globs: ["**/AGENTS.md"]
`;

test("loadRegistry: null file is 'standards not configured'", () => {
  assert.deepEqual(loadRegistry(null), { ok: false, reason: "standards not configured" });
});

test("loadRegistry: a broken file is '<resolved path> unreadable: <err>', naming the file actually read", () => {
  const f = fixture("standards: [unclosed\n  : :");
  const r = loadRegistry(f.file);
  assert.equal(r.ok, false);
  assert.ok(r.reason.startsWith(`${f.file} unreadable: `), r.reason);
  const gone = path.join(f.dir, "kb-standards.yml");
  const missing = loadRegistry(gone);
  assert.ok(missing.reason.startsWith(`${gone} unreadable: not found`), missing.reason);
});

test("loadRegistry: a good file yields standards keyed by id", () => {
  const f = fixture(REG);
  const r = loadRegistry(f.file);
  assert.equal(r.ok, true);
  assert.equal(r.standards["acme-tool"].kind, "tool");
  assert.equal(r.standards["acme-tool"].page, "acme-tool.md");
  assert.deepEqual(r.standards["acme-tool"].pointer_globs, ["**/AGENTS.md"]);
});

test("loadRegistry: a registry with no standards mapping is not 'zero standards'", () => {
  const f = fixture("schema_version: 1\nstandards: {}\n");
  const r = loadRegistry(f.file);
  assert.equal(r.ok, false);
  assert.match(r.reason, /no `standards:` mapping/);
});

test("loadStandards: a page id that differs from the registry key is a problem", () => {
  const f = fixture(REG, { "acme-tool.md": PAGE.replace("id: acme-tool\n", "id: other-tool\n") });
  const r = loadStandards({ standardsFile: f.file, standardsDir: f.pdir });
  assert.equal(r.ok, true);
  assert.ok(r.problems.some((x) => x.includes("other-tool") && x.includes("acme-tool")), r.problems.join("|"));
});

test("loadStandards: joins registry entry and parsed page; page problems surface", () => {
  const f = fixture(REG, { "acme-tool.md": PAGE });
  const r = loadStandards({ standardsFile: f.file, standardsDir: f.pdir });
  assert.equal(r.ok, true);
  assert.deepEqual(r.problems, []);
  assert.equal(r.standards.length, 1);
  assert.equal(r.standards[0].page.rows.length, 2);
  assert.equal(r.standards[0].id, "acme-tool");
});

test("loadStandards: a missing page is a problem naming the file, other standards still load", () => {
  const f = fixture(REG);
  const r = loadStandards({ standardsFile: f.file, standardsDir: f.pdir });
  assert.equal(r.ok, true);
  assert.ok(r.problems.some((x) => x.includes("acme-tool.md")));
});

test("loadStandards: unconfigured propagates the reason", () => {
  assert.deepEqual(loadStandards({ standardsFile: null, standardsDir: null }), { ok: false, reason: "standards not configured", problems: [] });
});

test("a heading that looks like a row but is malformed is reported, not dropped", () => {
  for (const h of ["### acme-tool-003 - Wrong separator", "## acme-tool-003 · Wrong level", "### acme-tool-003 · "]) {
    const p = parsePage(PAGE + `\n${h}\n**State:** adopted\n`, "acme-tool.md");
    assert.ok(p.problems.some((x) => x.includes("looks like a row")), `${h} -> ${p.problems.join("|")}`);
  }
});

test("a field line outside any row is reported", () => {
  const p = parsePage("---\nid: a\nkind: tool\n---\n**State:** adopted\n", "a.md");
  assert.ok(p.problems.some((x) => x.includes('field "State" outside any row')));
});

test("an unknown field name is reported", () => {
  const p = parsePage(PAGE.replace("**Check:** test:", "**Chekc:** test:"), "acme-tool.md");
  assert.ok(p.problems.some((x) => x.includes('unknown field "Chekc"')), p.problems.join("|"));
});

test("a leading BOM does not hide the frontmatter", () => {
  const p = parsePage("\uFEFF" + PAGE, "acme-tool.md");
  assert.deepEqual(p.problems, []);
  assert.equal(p.id, "acme-tool");
});

test("CRLF pages parse the same", () => {
  const p = parsePage(PAGE.replace(/\n/g, "\r\n"), "acme-tool.md");
  assert.deepEqual(p.problems, []);
  assert.equal(p.rows.length, 2);
  assert.equal(p.rows[0].check.target, "**/support.dart contains settleBounded");
});

test("a command check keeps colons in its target", () => {
  const p = parsePage(PAGE.replace("**Check:** test: **/support.dart contains settleBounded", '**Check:** command: node -e "a:b"'), "acme-tool.md");
  assert.deepEqual(p.rows[0].check, { kind: "command", target: 'node -e "a:b"' });
});

test("a command or test check with no target is a problem", () => {
  const p = parsePage(PAGE.replace("**Check:** test: **/support.dart contains settleBounded", "**Check:** command"), "acme-tool.md");
  assert.ok(p.problems.includes('row acme-tool-001: check "command" has no target'), p.problems.join("|"));
});

test("loadStandards: with two standards, one missing page does not stop the other", () => {
  const reg = REG + `  beta-tool:\n    kind: tool\n    page: beta-tool.md\n`;
  const f = fixture(reg, { "acme-tool.md": PAGE });
  const r = loadStandards({ standardsFile: f.file, standardsDir: f.pdir });
  assert.equal(r.ok, true);
  assert.equal(r.standards.length, 2);
  assert.equal(r.standards.find((s) => s.id === "acme-tool").page.rows.length, 2);
  assert.equal(r.standards.find((s) => s.id === "beta-tool").page, null);
  assert.ok(r.problems.some((x) => x.includes("beta-tool") && x.includes("not found")));
});

// #290: a project page extends a standard and its rows cite which standard row they apply.
const PROJECT_PAGE = `---
id: acme-app
kind: project
extends: [std:acme-tool]
---

### acme-app-001 · Settle cap is 30 s here
**State:** adopted
**Source:** local decision
**Applies:** std:acme-tool-001
**Check:** review: reviewer confirms

### acme-app-002 · One bundle id until flavors
**State:** adopted
**Source:** local decision
**Applies:** local-1
**Check:** none
`;

test("#290: extends: and Applies: parse with 0 problems", () => {
  const p = parsePage(PROJECT_PAGE, "acme-app.md", { extendedRows: { "acme-tool": ["acme-tool-001", "acme-tool-002"] } });
  assert.deepEqual(p.problems, []);
  assert.deepEqual(p.extends, ["std:acme-tool"]);
  assert.equal(p.rows[0].applies, "std:acme-tool-001");
  assert.equal(p.rows[1].applies, "local-1");
});

test("#290: extends: as a single string is accepted", () => {
  const p = parsePage(PROJECT_PAGE.replace("extends: [std:acme-tool]", "extends: std:acme-tool"), "acme-app.md");
  assert.deepEqual(p.extends, ["std:acme-tool"]);
  assert.deepEqual(p.problems, []);
});

test("#290: Applies: naming a row the extended standard does not have is a reported problem", () => {
  const p = parsePage(PROJECT_PAGE.replace("std:acme-tool-001", "std:acme-tool-099"), "acme-app.md", { extendedRows: { "acme-tool": ["acme-tool-001"] } });
  assert.ok(p.problems.some((x) => x.includes("std:acme-tool-099") && /no such row/.test(x)), p.problems.join("|"));
});

test("#290: Applies: naming a standard the page does not extend, or a malformed id, is a reported problem", () => {
  const other = parsePage(PROJECT_PAGE.replace("std:acme-tool-001", "std:other-001"), "acme-app.md");
  assert.ok(other.problems.some((x) => /does not extend std:other/.test(x)), other.problems.join("|"));
  const bad = parsePage(PROJECT_PAGE.replace("std:acme-tool-001", "acme-tool-001"), "acme-app.md");
  assert.ok(bad.problems.some((x) => /not std:<id>-NNN or local-<n>/.test(x)), bad.problems.join("|"));
});

test("#290: an unknown field is still reported, unchanged", () => {
  const p = parsePage(PROJECT_PAGE.replace("**Applies:**", "**Aplies:**"), "acme-app.md");
  assert.ok(p.problems.some((x) => x.includes('unknown field "Aplies"')), p.problems.join("|"));
});

// #290 (decided 2026-11-17): a project-local row inherits or defaults its state; it carries no `State:` line.
const LOCAL_HEAD = "---\nid: acme-app\nkind: project\nextends: [std:acme-tool]\n---\n\n";

test("#290: an Applies: row with no State: inherits the hub state and is not a problem", () => {
  const p = parsePage(`${LOCAL_HEAD}### acme-app-001 · Cap\n**Applies:** std:acme-tool-001\n**Check:** none\n`, "acme-app.md");
  assert.deepEqual(p.problems, []);
  assert.equal(p.rows[0].state, null);
  assert.equal(p.rows[0].stateSource, "inherited");
});

test("#290: a local-<n> row with no State: defaults to adopted", () => {
  const p = parsePage(`${LOCAL_HEAD}### local-1 · One bundle id\n**Check:** none\n`, "acme-app.md");
  assert.deepEqual(p.problems, []);
  assert.equal(p.rows[0].state, "adopted");
  assert.equal(p.rows[0].stateSource, "default");
});

test("#290: State: retired on a local row needs a Reason, or it is a problem", () => {
  const bad = parsePage(`${LOCAL_HEAD}### local-2 · Old\n**State:** retired\n**Check:** none\n`, "acme-app.md");
  assert.ok(bad.problems.some((x) => x.includes("local-2") && x.includes("Reason")), bad.problems.join("|"));
  const ok = parsePage(`${LOCAL_HEAD}### local-2 · Old\n**State:** retired\n**Reason:** flavors landed\n**Check:** none\n`, "acme-app.md");
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.rows[0].reason, "flavors landed");
});

test("#290: a hub-page row with no State: is still a problem", () => {
  const p = parsePage("---\nid: acme-tool\nkind: tool\n---\n### acme-tool-001 · x\n**Check:** none\n", "acme-tool.md");
  assert.ok(p.problems.some((x) => x.includes("no State")), p.problems.join("|"));
});
