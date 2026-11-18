import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadReferences } from "../../lib/kb/references.mjs";
import { readVersions, writeVersions } from "../../lib/kb/standards/versions.mjs";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "kb-ref-"));
const entry = (n) => `  site-${n}:
    kind: doc
    url: https://example.com/${n}
    what: a thing
    why: a reason
    applies_to: [node]
    verdict: adopt
    checked: 2026-11-01
    added: 2026-11-01
`;

test("loadReferences: two entries load, ids taken from the keys", () => {
  const f = path.join(tmp(), "kb-references.yml");
  writeFileSync(f, `schema_version: 1\nreferences:\n${entry(1)}${entry(2)}`);
  const r = loadReferences(f);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.references.map((x) => x.id), ["site-1", "site-2"]);
  assert.equal(r.references[0].url, "https://example.com/1");
  assert.equal(r.references[0].verdict, "adopt");
});

test("loadReferences: an unsupported schema_version is a problem, not a result", () => {
  const f = path.join(tmp(), "kb-references.yml");
  writeFileSync(f, `schema_version: 2\nreferences:\n${entry(1)}`);
  const r = loadReferences(f);
  assert.deepEqual(r.references, []);
  assert.deepEqual(r.problems, ["unsupported schema_version 2"]);
});

test("loadReferences: null is 'not configured', never zero references", () => {
  assert.deepEqual(loadReferences(null), { references: [], problems: ["references not configured"] });
});

test("loadReferences: an unreadable file gives one problem naming it, and never throws", () => {
  const f = path.join(tmp(), "missing.yml");
  const r = loadReferences(f);
  assert.deepEqual(r.references, []);
  assert.equal(r.problems.length, 1);
  assert.ok(r.problems[0].includes(f));
});

test("versions: a cache written only under standards/ is still read", () => {
  const s = tmp();
  mkdirSync(path.join(s, "standards"));
  writeFileSync(path.join(s, "standards", "versions.json"), JSON.stringify({ at: "t", tools: { x: { version: "1.2.3", at: "t" } } }));
  assert.equal(readVersions(s).tools.x.version, "1.2.3");
});

test("versions: writeVersions writes under kb/ only, and kb/ wins over the old path", () => {
  const s = tmp();
  writeVersions(s, { at: "t", tools: {} });
  assert.ok(existsSync(path.join(s, "kb", "versions.json")));
  assert.ok(!existsSync(path.join(s, "standards")));
  mkdirSync(path.join(s, "standards"));
  writeFileSync(path.join(s, "standards", "versions.json"), JSON.stringify({ at: "old", tools: {} }));
  assert.equal(readVersions(s).at, "t");
});
