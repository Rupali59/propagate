import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDecisions, normalizeAffectsToken } from "../lib/decisions.mjs";

test("parses BOTH heading forms (colon + em-dash) — G1", () => {
  const text = `
## 2026-06-14 — GA4 IaC owned by Motherboard; ...
Affects: workspace, VipinKaushik, VipinKaushik-mb, Motherboard, Campaigner

Some body.

## 2026-07-13: Cross-repo propagation
Affects: workspace, Motherboard, Tathya
`;
  const e = parseDecisions(text);
  assert.equal(e.length, 2);
  assert.equal(e[0].date, "2026-06-14");
  assert.ok(e[0].tokens.includes("motherboard"), "em-dash entry's Affects parsed");
  assert.equal(e[1].date, "2026-07-13");
  assert.ok(e[1].tokens.includes("tathya"));
});

test("normalizeAffectsToken strips parenthetical/note suffixes and placeholders — G2", () => {
  assert.equal(normalizeAffectsToken(" VipinKaushik (consumer)"), "vipinkaushik");
  assert.equal(normalizeAffectsToken("Astroclarity (shared IA — Knowledge Hub)"), "astroclarity");
  assert.equal(normalizeAffectsToken("<project list>"), "");
  assert.equal(normalizeAffectsToken("Motherboard"), "motherboard");
});

test("identity key is date + affects-hash, title-independent (G4)", () => {
  const a = parseDecisions("## 2026-06-14: Title A\nAffects: Motherboard\n");
  const b = parseDecisions("## 2026-06-14 — Totally Different Title\nAffects: Motherboard\n");
  assert.equal(a[0].key, b[0].key, "same date+affects → same key regardless of title/heading form");
});

test("collision guard: identical date+affects entries both fire with distinct keys", () => {
  const text = `
## 2026-06-14: First
Affects: Motherboard
## 2026-06-14: Second
Affects: Motherboard
`;
  const e = parseDecisions(text);
  assert.equal(e.length, 2);
  assert.notEqual(e[0].key, e[1].key, "collision disambiguated");
  assert.equal(e[1].collision, true);
  assert.match(e[1].key, /#1$/);
});
