import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { kbCmd } from "../../cli/kb.mjs";

// Fixtures are literals (rule:mutate-behind-the-fixture-builder): nothing here is read from a real hub.
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "kb-search-"));

const STD_REGISTRY = `schema_version: 1
standards:
  docs-site:
    kind: tool
    page: docs-site.md
`;
const STD_PAGE = `---
id: docs-site
kind: tool
---

### docs-site-001 · Publish with Quartz
**State:** adopted
**Source:** s · **Version:** quartz 4 · **Checked:** 2026-11-10
**Check:** none
**Fails when:** the site is built by hand

### docs-site-002 · Keep pages small
**State:** adopted
**Source:** s · **Checked:** 2026-11-01
**Check:** none
`;
const REFS = `schema_version: 1
references:
  quartz:
    kind: repo
    repo: example/quartz
    what: a static site generator for notes
    why: the docs site renders with it
    checked: 2026-11-12
  gizmo:
    kind: repo
    repo: example/gizmo
    what: unrelated
    checked: 2026-11-02
`;
const REG = `### reg-001 · Notes publisher
**Checked:** 2026-11-05
Uses quartz under the hood.
`;

function hub({ std = true, refs = true, regs = true } = {}) {
  const d = tmp();
  const integrations = { kbStandardsFile: null, kbStandardsDir: null, kbReferencesFile: null, registersDir: null };
  if (std) {
    writeFileSync(path.join(d, "kb-standards.yml"), STD_REGISTRY);
    writeFileSync(path.join(d, "docs-site.md"), STD_PAGE);
    integrations.kbStandardsFile = path.join(d, "kb-standards.yml");
    integrations.kbStandardsDir = d;
  }
  if (refs) {
    writeFileSync(path.join(d, "kb-references.yml"), REFS);
    integrations.kbReferencesFile = path.join(d, "kb-references.yml");
  }
  if (regs) {
    mkdirSync(path.join(d, "registers"));
    writeFileSync(path.join(d, "registers", "notes.md"), REG);
    integrations.registersDir = path.join(d, "registers");
  }
  return { d, integrations };
}

async function run(argv, integrations) {
  const out = [];
  const err = [];
  const io = { log: (s) => out.push(String(s)), error: (s) => err.push(String(s)) };
  const code = await kbCmd(["search", ...argv], { io, integrations, workspaces: [] });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

test("kb search quartz returns the std: row, the ref: entry and the register entry, each with path:line and checked", async () => {
  const h = hub();
  const r = await run(["quartz", "--json"], h.integrations);
  assert.equal(r.code, 0);
  const j = JSON.parse(r.out);
  const ids = j.hits.map((x) => x.id);
  assert.ok(ids.includes("std:docs-site-001"), ids.join());
  assert.ok(ids.includes("ref:quartz"), ids.join());
  assert.ok(ids.includes("reg:reg-001"), ids.join());
  assert.ok(!ids.includes("ref:gizmo"));
  assert.ok(!ids.includes("std:docs-site-002"));
  const s = j.hits.find((x) => x.id === "std:docs-site-001");
  assert.equal(s.path, path.join(h.d, "docs-site.md"));
  assert.equal(s.line, 6);
  assert.equal(s.checked, "2026-11-10");
  const f = j.hits.find((x) => x.id === "ref:quartz");
  assert.equal(f.path, path.join(h.d, "kb-references.yml"));
  assert.equal(f.line, 3);
  assert.equal(f.checked, "2026-11-12");
});

test("kb search ranks an id or title hit above a body-only hit", async () => {
  const h = hub();
  const j = JSON.parse((await run(["quartz", "--json"], h.integrations)).out);
  const rank = (id) => j.hits.findIndex((x) => x.id === id);
  assert.ok(rank("ref:quartz") < rank("reg:reg-001"), "id match outranks a body mention");
  assert.ok(rank("std:docs-site-001") < rank("reg:reg-001"), "title match outranks a body mention");
});

test("kb search --kind standard and --kind reference narrow the population", async () => {
  const h = hub();
  const s = JSON.parse((await run(["quartz", "--kind", "standard", "--json"], h.integrations)).out);
  assert.deepEqual(s.hits.map((x) => x.id), ["std:docs-site-001"]);
  const r = JSON.parse((await run(["quartz", "--kind", "reference", "--json"], h.integrations)).out);
  assert.deepEqual(r.hits.map((x) => x.id), ["ref:quartz"]);
});

test("kb search text output prefixes ids and shows path:line and the checked date", async () => {
  const h = hub();
  const r = await run(["quartz"], h.integrations);
  assert.equal(r.code, 0);
  assert.match(r.out, /std:docs-site-001/);
  assert.match(r.out, /ref:quartz/);
  assert.ok(r.out.includes(`${path.join(h.d, "kb-references.yml")}:3`));
  assert.match(r.out, /checked 2026-11-12/);
});

test("kb search with no match is exit 0 and says so (a result, not a blind scan)", async () => {
  const r = await run(["zzzznothing", "--json"], hub().integrations);
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.out).hits, []);
});

test("kb search floor: 0 entries parsed is exit 2 KB_BLIND 'the scan has gone blind', never an empty result", async () => {
  const r = await run(["quartz", "--json"], hub({ std: false, refs: false, regs: false }).integrations);
  assert.equal(r.code, 2);
  const j = JSON.parse(r.out);
  assert.equal(j.code, "KB_BLIND");
  assert.match(j.what, /the scan has gone blind/);
});

test("kb search: with references and registers unreadable, standards alone still answer", async () => {
  const h = hub({ refs: false, regs: false });
  const r = await run(["quartz", "--json"], h.integrations);
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.out).hits.map((x) => x.id), ["std:docs-site-001"]);
});

test("kb search: no terms, a bad --kind and a bad flag are exit 2 KB_USAGE", async () => {
  const h = hub();
  for (const argv of [[], ["--json"], ["quartz", "--kind", "bogus"], ["quartz", "--nope"]]) {
    const r = await run(argv, h.integrations);
    assert.equal(r.code, 2, JSON.stringify(argv));
  }
  assert.equal(JSON.parse((await run(["--json"], h.integrations)).out).code, "KB_USAGE");
});
