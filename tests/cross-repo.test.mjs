import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import Ajv from "ajv";
import yaml from "yaml";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, realpathSync } from "node:fs";
import { loadCrossRepoSync, resolveTarget, resolvePartner, __setPartnerRootsForTest, discoverCrossReposSync, crossCorrelationId } from "../lib/cross-repo.mjs";

import { fileURLToPath } from "node:url";
// Derived from this file's own location, not from ~/.claude/skills/propagate.
// The hardcoded form defeated SKILL_DIR and made the suite unrunnable from a
// worktree, a clone, or a marketplace install — the exact portability bug the
// code it tests had already been fixed for.
const SKILL = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

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
  // `partner_roots` must be a LIST, and may be empty. It used to assert `>= 2`, which
  // is not a property of the shipped file — it was asserting that the author's three
  // repo roots were still checked in. An empty allowlist is the correct default: it
  // permits no cross-repo edge, so a fresh install cannot fire one it was never
  // configured for. The real list lives in $PROPAGATE_STATE_DIR/cross-allow.yml,
  // which lib/config.mjs prefers (covered in tests/portability-literals.test.mjs).
  assert.ok(Array.isArray(allow.partner_roots), "partner_roots is a list");
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

test("resolveTarget rejects a symlink escaping the partner tree", () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), "xparent-"));
  const mb = path.join(parent, "Motherboard"); mkdirSync(mb, { recursive: true });
  const outside = path.join(parent, "Youvan"); mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(outside, "secret.ts"), "x");
  symlinkSync(path.join(outside, "secret.ts"), path.join(mb, "leak.ts"));
  writeFileSync(path.join(mb, "motherboard.json"), "{}");
  __setPartnerRootsForTest([realpathSync(mb)]);

  const vk = path.join(parent, "Vipin Kaushik"); mkdirSync(vk, { recursive: true });
  assert.equal(resolveTarget(vk, "../Motherboard/motherboard.json").ok, true);
  const escaped = resolveTarget(vk, "../Motherboard/leak.ts");
  assert.equal(escaped.ok, false);
  assert.equal(escaped.reason, "outside-partner");
  assert.equal(resolveTarget(vk, "../Motherboard/nope.json").reason, "missing");
});

test("resolvePartner maps paths and Affects tokens to canonical partner", () => {
  assert.equal(resolvePartner("../Motherboard/motherboard.json"), "Motherboard");
  assert.equal(resolvePartner("VipinKaushik-mb/server/impl.ts"), "Motherboard");
  assert.equal(resolvePartner("../Tathya/tathya-strategy/x.md"), "Tathya");
  assert.equal(resolvePartner("../Youvan/secret.ts"), null);
});

test("discoverCrossReposSync finds repos with a cross file only", () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), "xdisc-"));
  const a = path.join(parent, "RepoA"); mkdirSync(a, { recursive: true });
  writeFileSync(path.join(a, ".propagates-cross.yml"), "platform_contracts: []\n");
  const b = path.join(parent, "RepoB"); mkdirSync(b, { recursive: true });
  writeFileSync(path.join(b, ".propagates.yml"), "sources: {}\n");
  const found = discoverCrossReposSync([parent]);
  assert.deepEqual(found.map((r) => r.name), ["RepoA"]);
});

test("crossCorrelationId is order-independent", () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), "xcorr-"));
  const f1 = path.join(parent, "a.ts"); writeFileSync(f1, "1");
  const f2 = path.join(parent, "b.ts"); writeFileSync(f2, "2");
  assert.equal(crossCorrelationId(f1, f2), crossCorrelationId(f2, f1));
});
