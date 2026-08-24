import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { existsSync } from "node:fs";
import { parseDecisions, normalizeAffectsToken, zeroTokenEntries } from "../../lib/report/decisions.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The plugin's own artifacts moved to propagation/state/workspace/ on 2026-08-23.
// Both are tried so an older checkout still resolves and a genuine absence stays
// distinguishable from a relocation.
const DECISIONS_PATH = [
  path.join(__dirname, "..", "..", "propagation", "state", "workspace", "DECISIONS.md"),
  path.join(__dirname, "..", "..", "docs", "DECISIONS.md"),
].find((c) => existsSync(c));

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

// N12 regression: the real DECISIONS.md writes **Affects:** in markdown bold. The
// synthetic fixtures above all use the bare form and could not have caught this —
// this test reads the actual live file. Before the fix in lib/decisions.mjs (bare-only
// regex), every entry here had tokens.length === 0 despite 8 non-empty Affects: lines.
test("parses the REAL docs/DECISIONS.md — every entry has non-empty tokens (N12)", () => {
  const text = readFileSync(DECISIONS_PATH, "utf8");
  const entries = parseDecisions(text);
  assert.ok(entries.length > 0, "DECISIONS.md must yield at least one entry");
  for (const e of entries) {
    assert.ok(
      e.tokens && e.tokens.length > 0,
      `entry "${e.date} ${e.title}" has affectsRaw=${JSON.stringify(e.affectsRaw)} but zero tokens`
    );
  }
});

test("bold Affects form captures the value without a trailing ** — N12", () => {
  const text = `## 2026-08-13: Bold form\n**Affects:** propagate, Motherboard\n`;
  const e = parseDecisions(text);
  assert.equal(e.length, 1);
  assert.equal(e[0].affectsRaw, "propagate, Motherboard");
  assert.ok(!e[0].affectsRaw.includes("*"), "affectsRaw must not contain stray asterisks");
  assert.deepEqual(e[0].tokens, ["propagate", "motherboard"]);
});

test("bare and bold Affects forms produce identical tokens for the same content — N12", () => {
  const bare = parseDecisions("## 2026-08-13: Bare\nAffects: propagate, Motherboard\n");
  const bold = parseDecisions("## 2026-08-13: Bold\n**Affects:** propagate, Motherboard\n");
  assert.deepEqual(bare[0].tokens, bold[0].tokens);
  assert.equal(bare[0].affectsRaw, bold[0].affectsRaw);
});

test("zeroTokenEntries flags entries with an empty or unparseable Affects field", () => {
  const text = `
## 2026-08-13: Has affects
**Affects:** propagate

## 2026-08-13: No affects line at all
Some body with no Affects field.

## 2026-08-13: Placeholder only
**Affects:** <project list>
`;
  const entries = parseDecisions(text);
  const zero = zeroTokenEntries(entries);
  assert.equal(zero.length, 2, "the missing-field and placeholder-only entries should be flagged");
  assert.ok(zero.some((e) => e.title === "No affects line at all"));
  assert.ok(zero.some((e) => e.title === "Placeholder only"));
  assert.ok(!zero.some((e) => e.title === "Has affects"));
});

test("emphasis on the VALUE normalizes away, not just on the label — N12 follow-up", () => {
  // N12 fixed `**Affects:**` vs `Affects:`. This is the same miss one level
  // down: if a target is emphasized, `**propagate**` never matches `propagate`
  // and the entry silently affects nothing while the gate still passes.
  assert.equal(normalizeAffectsToken("**propagate**"), "propagate");
  assert.equal(normalizeAffectsToken("*propagate*"), "propagate");
  assert.equal(normalizeAffectsToken("`propagate`"), "propagate");
  assert.equal(normalizeAffectsToken("_propagate_"), "propagate");

  // and end to end, through the parser
  const tokens = parseDecisions("## 2026-01-01: x\n**Affects:** **foo**, `bar`, baz\n")[0].tokens;
  assert.deepEqual(tokens, ["foo", "bar", "baz"]);
});
