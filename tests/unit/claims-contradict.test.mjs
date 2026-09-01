/**
 * Holding an authored claim against a derived fact.
 *
 * This is the pairing the whole two-file split was for. `NORTH_STAR.md` says what
 * we are building toward; `ECOSYSTEM.md` says what exists; prose has no compiler,
 * so without this the two contradict each other indefinitely and both read as
 * true. The judgment itself is the caller's — propagate runs no model — so what is
 * asserted here is the mechanical half: fact derivation, pairing, and the identity
 * that makes a verdict survive.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { deriveFacts, pairClaims, factSha } from "../../lib/claims/contradict.mjs";
import { splitBlocks } from "../../lib/claims/blocks.mjs";

const ROLLUP = {
  perOwner: [
    {
      owner: "propagate", display: "propagate",
      layout: { conforms: false, missing: ["README.md", "INDEX.md"] },
      items: [{}, {}], built: [{}], crossFiled: [{}],
    },
    {
      owner: "Keerti", display: "Keerti",
      layout: { conforms: true, missing: [] },
      items: [], built: [], crossFiled: [], hasNoRegister: true,
    },
  ],
};

test("facts are ATOMS with their own hashes, not whole sections", () => {
  const facts = deriveFacts(ROLLUP);
  assert.ok(facts.length >= 6, "layout + open + built per owner, at minimum");
  for (const f of facts) {
    assert.match(f.sha, /^[0-9a-f]{64}$/);
    assert.ok(f.text.includes(f.owner), "a fact must name whose it is");
  }
  // Distinct statements must have distinct identities, or judging one silently
  // judges another.
  assert.equal(new Set(facts.map((f) => f.sha)).size, facts.length);
});

test("a non-conformant layout says WHAT is missing, not merely that it failed", () => {
  const layout = deriveFacts(ROLLUP).find((f) => f.owner === "propagate" && f.kind === "layout");
  assert.match(layout.text, /NON-CONFORMANT/);
  assert.match(layout.text, /README\.md/, "a reader must be able to act without re-running anything");
});

test("hasNoRegister is its own fact — 'no register' is not 'zero open items'", () => {
  const facts = deriveFacts(ROLLUP).filter((f) => f.owner === "Keerti");
  assert.ok(facts.some((f) => f.kind === "no-register"), "looked-at-nothing must be sayable");
  assert.ok(facts.some((f) => f.kind === "open"), "and found-nothing separately");
});

test("a claim pairs only with facts about a workspace it NAMES", () => {
  const doc = "propagate must stay conformant with its own layout.\n\nSomething about nothing.\n";
  const { pairs, unpaired } = pairClaims(splitBlocks(doc), deriveFacts(ROLLUP));
  assert.ok(pairs.length > 0);
  assert.ok(pairs.every((p) => p.fact.owner === "propagate"), "must not pair with Keerti facts");
  assert.equal(unpaired.length, 1, "the claim naming no workspace is UNPAIRED, not dropped");
});

test("unpaired is reported, because 'cannot be checked' is a finding not an omission", () => {
  const doc = "We derive on demand and we do not restate.\n";
  const { pairs, unpaired } = pairClaims(splitBlocks(doc), deriveFacts(ROLLUP));
  assert.equal(pairs.length, 0);
  assert.equal(unpaired.length, 1);
});

test("a bare word match is enough here — deliberately looser than crossFiled", () => {
  // crossFiledByOwner requires a PATH because its count lands in a generated file
  // nobody vets. Here every pair becomes a question somebody answers, so a false
  // pair costs one `unrelated` verdict while a missed pair loses a real
  // contradiction. The asymmetry runs the other way, so the threshold does too.
  const doc = "Keerti runs two practices on one site.\n";
  const { pairs } = pairClaims(splitBlocks(doc), deriveFacts(ROLLUP));
  assert.ok(pairs.length > 0, "prose naming a workspace must pair without needing a path");
});

test("a substring of a longer word does not count as naming it", () => {
  const doc = "The propagateXYZ subsystem is unrelated.\n";
  const { pairs } = pairClaims(splitBlocks(doc), deriveFacts(ROLLUP));
  assert.equal(pairs.length, 0, "word-boundary, or every compound word becomes a false pair");
});

test("pair identity is both hashes, so editing EITHER side re-opens only that pair", () => {
  const facts = deriveFacts(ROLLUP);
  const a = pairClaims(splitBlocks("propagate must stay conformant.\n"), facts);
  const b = pairClaims(splitBlocks("propagate must stay conformant, always.\n"), facts);
  assert.notEqual(a.pairs[0].pairSha, b.pairs[0].pairSha, "an edited claim re-opens its pairs");

  // And the reverse: same claim, changed fact.
  const movedFacts = deriveFacts({
    perOwner: [{ ...ROLLUP.perOwner[0], items: [{}, {}, {}] }],
  });
  const c = pairClaims(splitBlocks("propagate must stay conformant.\n"), movedFacts);
  const changed = c.pairs.some((p) => !a.pairs.find((q) => q.pairSha === p.pairSha));
  assert.ok(changed, "a moved fact re-opens the pairs that were about it");
});

test("structure blocks are never paired — a heading is not a claim", () => {
  const doc = "# propagate\n\nreal claim about propagate.\n";
  const { pairs } = pairClaims(splitBlocks(doc), deriveFacts(ROLLUP));
  assert.ok(pairs.every((p) => p.claim.judgeable));
});

test("factSha normalises whitespace, matching block identity's rule", () => {
  assert.equal(factSha("a  b\nc"), factSha("a b c"));
});
