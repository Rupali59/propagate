import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import Ajv from "ajv";
import yaml from "yaml";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { loadCrossRepoSync } from "../lib/cross-repo.mjs";

const SKILL = path.join(os.homedir(), ".claude", "skills", "propagate");

test("cross schema + allowlist files exist and are valid", () => {
  const schemaPath = path.join(SKILL, "propagates-cross.schema.json");
  const allowPath = path.join(SKILL, "cross-allow.yml");
  assert.ok(existsSync(schemaPath), "schema file exists");
  assert.ok(existsSync(allowPath), "allowlist file exists");
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(schema);
  // a well-formed cross file validates
  assert.equal(
    validate({ platform_contracts: [{ source: "a.json", kind: "contract", affects: [{ path: "../X/b", why: "because reasons" }] }] }),
    true,
  );
  // unknown top-level key rejected
  assert.equal(validate({ nope: [] }), false);
  const allow = yaml.parse(readFileSync(allowPath, "utf8"));
  assert.ok(Array.isArray(allow.partner_roots) && allow.partner_roots.length === 2);
  assert.ok(Array.isArray(allow.contract_files) && allow.contract_files.length > 0);
});

test("loadCrossRepoSync splits push and pull edges", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "xrepo-"));
  writeFileSync(path.join(root, ".propagates-cross.yml"), `
platform_contracts:
  - source: mb.json
    kind: contract
    affects:
      - path: ../Motherboard/consumer.yml
        why: clientId ports endpoints
  - watch: ../Motherboard/sdk/iface.ts
    kind: contract
    why: sdk interface my server implements
    for: server/impl.ts
shared_conventions:
  - watch: ../Tathya/playbook.md
    why: design derives from playbook
    for: DESIGN.md
`);
  const { pushEdges, pullEdges } = loadCrossRepoSync(root);
  assert.equal(pushEdges.length, 1);
  assert.equal(pushEdges[0].source, "mb.json");
  assert.equal(pushEdges[0].affects[0].path, "../Motherboard/consumer.yml");
  assert.equal(pullEdges.length, 2);
  assert.equal(pullEdges.find((e) => e.flow === "shared_convention").watch, "../Tathya/playbook.md");
  assert.equal(pullEdges.find((e) => e.flow === "platform_contract").watch, "../Motherboard/sdk/iface.ts");
});

test("loadCrossRepoSync returns empty for missing file", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "xrepo-empty-"));
  assert.deepEqual(loadCrossRepoSync(root), { pushEdges: [], pullEdges: [] });
});
