/**
 * The two doc-structure expectations, and the input that makes each one fail.
 *
 * A check that cannot fail reports success forever (GOTCHAS G1). Both of these pass on
 * the tree today, so without a constructed failing input neither would be known to work.
 *
 * The prose-only one is a RATCHET rather than an equality on purpose. 107 docs claim
 * supersession in prose right now; asserting 0 would print 107 findings on day one, and
 * a wall of expected failures is where a real one hides (G23). Failing only on GROWTH
 * keeps it honest and keeps it able to fail.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EXPECTATIONS } from "../../lib/report/metrics.mjs";

const byKey = (k) => {
  const e = EXPECTATIONS.find((x) => x.key === k);
  assert.ok(e, `expectation ${k} must exist — if it was renamed, this test is the alarm`);
  return e;
};

test("prose-only supersession ratchet holds at baseline, and FAILS when it grows", () => {
  const e = byKey("docs.supersession_prose_only");
  // Baseline lowered 107 -> 105 on 2026-08-18 after lib/doc-kind.mjs stopped counting
  // the archival FILENAME mandated by STATE_MANAGEMENT.md §88-93, then 105 -> 103 on
  // 2026-08-19 after five docs gained a real `supersedes:` frontmatter declaration.
  // Lowering is explicitly sanctioned by the expectation's own rule; raising is not.
  //
  // This test is the coupling alarm for that value, and it worked: the 105 -> 103 change
  // landed in lib/metrics.mjs without touching this file and turned the suite red on the
  // next run. Move both together, always.
  assert.equal(e.assert({ "docs.supersession_prose_only": 101 }), true, "baseline must hold");
  assert.equal(
    e.assert({ "docs.supersession_prose_only": 102 }),
    false,
    "one more prose-only supersession must fail the run — this is the whole point of a ratchet",
  );
  assert.equal(
    e.assert({ "docs.supersession_prose_only": 103 }),
    false,
    "the OLD baseline must now fail — otherwise lowering the ratchet did nothing",
  );
  assert.equal(e.assert({ "docs.supersession_prose_only": 90 }), true, "shrinking must hold");
  assert.match(e.detail({ "docs.supersession_prose_only": 102 }), /GREW/);
});

test("unresolvable supersedes target fails — a declaration that lies is worse than prose", () => {
  const e = byKey("docs.supersedes_unresolvable");
  assert.equal(e.assert({ "docs.supersedes_unresolvable": 0 }), true);
  assert.equal(
    e.assert({ "docs.supersedes_unresolvable": 3 }),
    false,
    "a `supersedes:` naming a path that does not exist looks machine-checked and is not",
  );
  assert.match(e.detail({ "docs.supersedes_unresolvable": 3 }), /do not resolve/);
});

test("a missing metric is treated as 0, not as a crash", () => {
  // doctor's collection is wrapped in try/catch; if it never ran, the key is absent.
  // The expectations must degrade to "no finding" rather than throwing mid-run.
  for (const k of ["docs.supersession_prose_only", "docs.supersedes_unresolvable"]) {
    assert.doesNotThrow(() => byKey(k).assert({}));
    assert.equal(byKey(k).assert({}), true);
  }
});

test("every expectation carries a basis naming a real incident (G16)", () => {
  // "a threshold with no basis is a guess wearing a check's clothes".
  // The incident may be named by DATE or by an ISSUES.md id — the id is the stronger
  // form, since it points at a full record rather than a day. An earlier version of this
  // test demanded a date and failed three entries that cite N1, N9 and N12; the test was
  // over-specified, not the entries under-specified.
  const NAMES_INCIDENT = /20\d\d-\d\d-\d\d|\b[NABG]\d{1,2}\b/;
  for (const e of EXPECTATIONS) {
    assert.ok(e.basis && e.basis.length > 40, `${e.key} needs a basis, not a bare number`);
    assert.match(e.basis, NAMES_INCIDENT, `${e.key}'s basis must name a dated incident or an ISSUES.md id`);
  }
});
