/**
 * The direction quote — does a goal still test the direction it cites?
 *
 * WHY THESE TESTS ARE SHAPED AROUND THE NORMALISATIONS. The check itself is a
 * string comparison; nothing interesting can go wrong there. What can go wrong
 * — and did, on the first hand-run against real data — is comparing the wrong
 * strings. Two normalisations stand between a useful check and one that cries
 * wolf on every entry:
 *
 *   PROVENANCE — NORTH_STAR.md tags inferred claims `⟨inferred from: …⟩`. That
 *     is metadata about a claim's origin, not the claim. Left in, the one real
 *     pair in the tree mismatches at char 240 of 240, on the tag alone.
 *   WRAPPING — the goal quotes as a `> ` blockquote, NORTH_STAR writes a `- `
 *     list item with hanging indent. Same words, different line breaks.
 *
 * So the load-bearing tests below are the two that FAIL WITHOUT each
 * normalisation, not the happy path. A test suite that only checked
 * identical-in, identical-out would pass on a build that had neither.
 *
 * The fourth state, `unquoted`, is the one a simpler design drops. It is also
 * the honest majority case: eight of nine workspaces have no GOALS.md at all,
 * and a file citing no direction cannot be checked — which must never render as
 * agreement (`rule:discernment-checks` §2).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PROVENANCE_RE,
  normaliseDirection,
  quotedDirection,
  directionByLabel,
  checkDirectionQuote,
} from "../../lib/report/goals.mjs";

const NORTH_STAR = [
  "# North star",
  "",
  "## What we are building toward",
  "",
  "- **This hub** — stay infrastructure for the other eight and nothing more:",
  "  one propagation standard, one set of registries. ⟨inferred from: `propagation/state/workspace/STATE.md`⟩",
  "- **Another** — something entirely different.",
  "",
].join("\n");

const goalsWith = (quote) => `# Goal states\n\nOnly the hub's line is covered:\n\n${quote}\n\nProse after.\n`;

// ── the two normalisations, each proven to be doing work ───────────────────

test("PROVENANCE is stripped — without it the real pair mismatches on the tag alone", () => {
  const tagged = "a claim ⟨inferred from: `some/path.md`⟩";
  assert.equal(normaliseDirection(tagged), "a claim");
  // ...and prove the regex is what does it, so a future edit cannot quietly
  // neuter the strip while this test still passes on whitespace collapse.
  assert.match(tagged, PROVENANCE_RE);
});

test("WRAPPING is normalised — a blockquote and a hanging-indent list item compare equal", () => {
  const asQuote = "> **This hub** — stay infrastructure for the other eight and nothing more:\n> one propagation standard, one set of registries.";
  const asListItem = "- **This hub** — stay infrastructure for the other eight and nothing more:\n  one propagation standard, one set of registries.";
  assert.equal(quotedDirection(asQuote), directionByLabel(asListItem, "**This hub**"));
});

test("a quote matching the live direction reports `matches`", () => {
  const v = checkDirectionQuote({
    goalsText: goalsWith("> **This hub** — stay infrastructure for the other eight and nothing more:\n> one propagation standard, one set of registries."),
    northStarText: NORTH_STAR,
  });
  assert.equal(v.state, "matches", v.why);
});

// ── the state that makes the check worth having ────────────────────────────

test("a quote whose direction has been REWRITTEN reports `diverged`", () => {
  // The whole point: the goal still says one thing, the direction now says
  // another, and nothing else in the tree can see it.
  const v = checkDirectionQuote({
    goalsText: goalsWith("> **This hub** — stay infrastructure and ALSO ship product features."),
    northStarText: NORTH_STAR,
  });
  assert.equal(v.state, "diverged");
  assert.match(v.why, /This hub/, "the label must be named — a reader should not have to go find which goal");
});

test("matching is on the LABEL, not the body — otherwise the check is tautological", () => {
  // If the direction were located by matching its full text, it could only ever
  // find a direction that had NOT changed, and `diverged` would be unreachable.
  // This asserts the lookup still succeeds when the body differs.
  assert.notEqual(directionByLabel(NORTH_STAR, "**This hub**"), null);
});

// ── the three-state discipline ─────────────────────────────────────────────

test("a GOALS.md quoting nothing is `unquoted`, never `matches`", () => {
  const v = checkDirectionQuote({ goalsText: "# Goals\n\nNo quote here.\n", northStarText: NORTH_STAR });
  assert.equal(v.state, "unquoted");
  assert.notEqual(v.state, "matches", "nothing to compare must never read as agreement");
  assert.match(v.why, /not agreement|nothing to compare/);
});

test("a quote citing a direction that no longer exists is `absent`, not `diverged`", () => {
  // Deleted and rewritten are different facts. Only one of them means someone
  // changed their mind about the wording.
  const v = checkDirectionQuote({
    goalsText: goalsWith("> **Retired workspace** — something nobody is building any more."),
    northStarText: NORTH_STAR,
  });
  assert.equal(v.state, "absent");
  assert.match(v.why, /gone|no direction labelled/);
});

test("a quote with no bold label is `unquoted` — it cannot be located, and says so", () => {
  const v = checkDirectionQuote({
    goalsText: goalsWith("> just some prose with no label at all"),
    northStarText: NORTH_STAR,
  });
  assert.equal(v.state, "unquoted");
  assert.match(v.why, /bold label/);
});

test("empty and missing inputs degrade to `unquoted`, never throw", () => {
  for (const [g, n] of [["", ""], [null, null], [undefined, NORTH_STAR]]) {
    const v = checkDirectionQuote({ goalsText: g, northStarText: n });
    assert.equal(v.state, "unquoted");
  }
});
