import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import Ajv from "ajv";
import yaml from "yaml";

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
