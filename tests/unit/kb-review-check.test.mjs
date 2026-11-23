import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { checkReview, ReviewCannotRun, normalizeUrl } from "../../lib/kb/review/check.mjs";
import { renderProtocolTemplate } from "../../lib/kb/review/protocol.mjs";
import { buildReview, addSiblingReview, snapshot } from "../fixtures/kb-review/build.mjs";

const run = (fx, extra = {}) => checkReview(fx.dir, { stateDirPath: fx.state, integrations: fx.integrations, ...extra });
const codes = (r) => r.refusals.map((x) => x.code);

test("the valid fixture passes, with hand-counted PRISMA numbers and a basis for every source", () => {
  const fx = buildReview();
  const r = run(fx);
  assert.deepEqual(r.refusals, []);
  assert.equal(r.ok, true);
  assert.deepEqual(r.counts, { identified: 5, duplicates: 1, screened: 4, excluded: 1, not_retrieved: 1, included: 2 });
  assert.deepEqual(r.derived.tiers, { S1: { tier: 2, basis: "tier table" }, S2: { tier: 1, basis: "official docs" } });
  assert.deepEqual(r.warnings.map((w) => w.code), ["SCREENING_UNSAMPLED"], "a missing sample is a warning in check");
});

test("with a reliable agreement.json the sample warning goes and the score is derived", () => {
  const fx = buildReview({ agreement: "reliable" });
  const r = run(fx);
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.derived.screening.verdict, "reliable");
});

const REFUSALS = {
  PROTOCOL_UNAPPROVED: { approved: false },
  PROTOCOL_SHA_MISMATCH: { editProtocolAfter: true },
  PROTOCOL_UNCOMMITTED: { leaveUncommitted: true, loose: true },
  PROTOCOL_AFTER_SEARCH: { searchDate: "2026-11-19" },
  SUPERSEDES_INVALID: { tweakProtocol: (t) => t.replace("supersedes: null", "supersedes: 2026-01-01-gone") },
  BRIEF_INVALID: { tweakBrief: (b) => { b.claims[0].quotes = []; } },
  SEARCH_UNLOGGED: { tweakBrief: (b) => { b.searches[0].query = "an invented search"; } },
  SOURCE_NOT_FETCHED: { tweakFetched: (rs) => { rs[0].classification = "not_retrieved"; return rs; } },
  QUOTE_NOT_FOUND: { tweakBrief: (b) => { b.claims[0].quotes[0].text = "a quote that never appears in the saved page body"; } },
  CITATION_MISMATCH: { tweakBrief: (b) => { b.screened[0] = { ...b.screened[0], decision: "excluded", reason: "changed mind" }; b.screened.pop(); } },
  STANDARD_ROW_TIER: { tiersYaml: "schema_version: 1\ndomains:\n  example.com: 2\n" },
  DUPLICATE_REFERENCE: { referencesYaml: "schema_version: 1\nreferences:\n  old-a:\n    kind: doc\n    url: http://www.example.com/a/\n    what: w\n    why: y\n    applies_to: []\n    verdict: adopt\n    checked: 2026-11-01\n    added: 2026-11-01\n" },
  SCREENING_UNRELIABLE: { agreement: "unreliable" },
};

for (const [code, opts] of Object.entries(REFUSALS)) {
  test(`${code}: its fixture refuses with that code`, () => {
    const { loose, ...o } = opts;
    const r = run(buildReview(o));
    assert.equal(r.ok, false);
    if (loose) assert.ok(codes(r).includes(code), codes(r).join());
    else assert.deepEqual([...new Set(codes(r))], [code], r.refusals.map((x) => x.what).join(" | "));
    assert.ok(r.refusals.every((x) => x.what && x.code), "each refusal says what");
  });
}

test("a quote outside 6-15 words is QUOTE_NOT_FOUND carrying findQuote's reason", () => {
  const r = run(buildReview({ tweakBrief: (b) => { b.claims[0].quotes[0].text = "quick brown fox"; } }));
  assert.deepEqual(codes(r), ["QUOTE_NOT_FOUND"]);
  assert.match(r.refusals[0].what, /6-15 are required/);
});

test("SUPERSEDES_INVALID: a target already superseded by another review refuses", () => {
  const fx = buildReview({ tweakProtocol: (t) => t.replace("supersedes: null", "supersedes: 2026-01-01-old") });
  const plain = renderProtocolTemplate({ slug: "old", date: "2026-01-01", decision: "d", decider: "x" });
  addSiblingReview(fx, "2026-01-01-old", plain);
  assert.deepEqual(run(fx).refusals, [], "a clean supersedes passes");
  addSiblingReview(fx, "2026-11-22-other", plain.replace("supersedes: null", "supersedes: 2026-01-01-old"));
  assert.deepEqual(codes(run(fx)), ["SUPERSEDES_INVALID"]);
});

test("Review Focus 1: five URL forms of one source count once, duplicates 4", () => {
  const forms = ["https://example.com/a", "http://example.com/a", "https://www.example.com/a/", "https://example.com/a?utm_source=x", "https://example.com/a#frag"];
  const fx = buildReview({ tweakBrief: (b) => { b.screened = [...forms.map((url) => ({ url, decision: "included", reason: "", lane: "L1" })), b.screened[1]]; } });
  const r = run(fx);
  assert.equal(r.counts.duplicates, 4);
  assert.deepEqual(r.counts, { identified: 6, duplicates: 4, screened: 2, excluded: 0, not_retrieved: 0, included: 2 });
  assert.equal(r.ok, true, r.refusals.map((x) => x.what).join());
  for (const f of forms) assert.equal(normalizeUrl(f), "https://example.com/a");
});

test("Review Focus 2: a whitespace-only edit to an approved protocol is PROTOCOL_SHA_MISMATCH, naming both hashes", () => {
  const r = run(buildReview({ editProtocolAfter: true }));
  assert.deepEqual(codes(r), ["PROTOCOL_SHA_MISMATCH"]);
  assert.match(r.refusals[0].what, /[0-9a-f]{40}.*[0-9a-f]{40}/);
});

test("Review Focus 3: a cited source whose fetch is not_retrieved is SOURCE_NOT_FETCHED", () => {
  const r = run(buildReview({ tweakFetched: (rs) => { rs[0] = { ...rs[0], classification: "not_retrieved" }; return rs; } }));
  assert.deepEqual(codes(r), ["SOURCE_NOT_FETCHED"]);
  assert.match(r.refusals[0].what, /not_retrieved/);
});

test("a body missing from the store is SOURCE_NOT_FETCHED too", () => {
  const r = run(buildReview({ omitBody: true }));
  assert.deepEqual([...new Set(codes(r))], ["SOURCE_NOT_FETCHED"]);
});

test("Review Focus 5: a missing supersedes target is SUPERSEDES_INVALID", () => {
  const r = run(buildReview({ tweakProtocol: (t) => t.replace("supersedes: null", "supersedes: 2026-01-01-gone") }));
  assert.deepEqual(codes(r), ["SUPERSEDES_INVALID"]);
});

test("every refusal is collected in one run, not just the first", () => {
  const r = run(buildReview({ approved: false, tweakBrief: (b) => { b.searches[0].query = "invented"; b.claims[0].quotes[0].text = "nothing like the saved page body at all here"; } }));
  assert.deepEqual([...new Set(codes(r))].sort(), ["PROTOCOL_UNAPPROVED", "QUOTE_NOT_FOUND", "SEARCH_UNLOGGED"]);
});

test("Purity: check writes nothing, to the review dir or the state dir, for the valid fixture and three refusals", () => {
  const fxs = [buildReview({ agreement: "reliable" }), buildReview({ approved: false }), buildReview({ tweakFetched: (rs) => { rs[1].classification = "stale"; return rs; } }), buildReview({ tweakBrief: (b) => { b.claims[0].quotes[0].text = "a quote that never appears in the saved page body"; } })];
  for (const fx of fxs) {
    const before = [snapshot(fx.dir), snapshot(fx.state), readFileSync(fx.refs, "utf8")];
    run(fx);
    assert.deepEqual([snapshot(fx.dir), snapshot(fx.state), readFileSync(fx.refs, "utf8")], before);
  }
});

test("a missing tier table is ReviewCannotRun KB_TIERS_NOT_CONFIGURED, not a default tier 3", () => {
  const fx = buildReview();
  assert.throws(() => run(fx, { integrations: { ...fx.integrations, kbTiersFile: path.join(fx.root, "nope.yml") } }), (e) => e instanceof ReviewCannotRun && e.code === "KB_TIERS_NOT_CONFIGURED");
});

test("git that cannot run is ReviewCannotRun KB_REVIEW_NO_GIT", () => {
  const fx = buildReview();
  assert.throws(() => run(fx, { run: () => ({ status: 127, stdout: "", stderr: "" }) }), (e) => e.code === "KB_REVIEW_NO_GIT");
});

test("a directory that is not a review reads as refusals, never as ok", () => {
  const fx = buildReview();
  const r = checkReview(path.join(fx.root, "empty"), { stateDirPath: fx.state, integrations: fx.integrations, run: (a) => ({ status: a[0] === "--version" ? 0 : 128, stdout: "", stderr: "x" }) });
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes("PROTOCOL_INVALID") && codes(r).includes("BRIEF_INVALID"));
});
