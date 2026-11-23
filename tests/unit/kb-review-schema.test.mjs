import { test } from "node:test";
import assert from "node:assert/strict";
import { validateBrief, BRIEF_SCHEMA_VERSION } from "../../lib/kb/review/schema.mjs";

const sha = "a".repeat(40);
const brief = () => ({
  schema_version: 1,
  review: "llm-screening",
  protocol_sha: sha,
  ai_use: { models: [{ lane: "L1", model: "m", version: "1" }], prompt_sha: "b".repeat(16), run_date: "2026-11-23T10:00:00Z", decided: ["screening"] },
  searches: [{ lane: "L1", engine: "openalex", query: "q", date: "2026-11-23", hits: 3 }],
  lanes: [{ id: "L1", model: "m" }],
  screened: [
    { url: "https://example.com/a", decision: "included", reason: "", lane: "L1" },
    { url: "https://example.com/b", decision: "excluded", reason: "off topic", lane: "L1" },
  ],
  sources: [{ id: "S1", url: "https://example.com/a", sha256: "c".repeat(64), secondary_review: false }],
  claims: [{ id: "C1", rq: "RQ1", text: "a claim", source_ids: ["S1"], quotes: [{ source_id: "S1", text: "six words of a verbatim quote here" }] }],
  disagreements: { RQ1: "none found" },
  proposals: [{ target: "reference", claim_ids: ["C1"], ref_id: "site-1", text: "adopt" }],
});

test("BRIEF_SCHEMA_VERSION is 1", () => assert.equal(BRIEF_SCHEMA_VERSION, 1));

test("a valid brief is ok with no problems", () => {
  const r = validateBrief(brief());
  assert.deepEqual(r.problems, []);
  assert.equal(r.ok, true);
});

test("an excluded entry with an empty reason is a problem at screened[i].reason", () => {
  const b = brief();
  b.screened[1].reason = "";
  const r = validateBrief(b);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.includes("screened[1].reason")), r.problems.join("|"));
});

test("a claim with no quotes is a problem at claims[i].quotes", () => {
  const b = brief();
  b.claims[0].quotes = [];
  assert.ok(validateBrief(b).problems.some((p) => p.includes("claims[0].quotes")));
});

test("a missing disagreements key for an RQ a claim uses is a problem", () => {
  const b = brief();
  b.claims.push({ id: "C2", rq: "RQ2", text: "t", source_ids: ["S1"], quotes: [{ source_id: "S1", text: "q" }] });
  const r = validateBrief(b);
  assert.ok(r.problems.some((p) => p.includes("disagreements.RQ2")), r.problems.join("|"));
});

test("schema_version 2 is a problem naming the version", () => {
  const b = brief();
  b.schema_version = 2;
  assert.ok(validateBrief(b).problems.some((p) => p.includes("schema_version") && p.includes("2")));
});

test("a JSON array is 'not a brief' with no field problems", () => {
  const r = validateBrief([]);
  assert.equal(r.ok, false);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /not a brief/);
});

test("null, a string and a number are also 'not a brief'", () => {
  for (const v of [null, "x", 3, undefined]) {
    const r = validateBrief(v);
    assert.equal(r.ok, false);
    assert.match(r.problems[0], /not a brief/);
  }
});

test("a screened decision outside the enum is a problem", () => {
  const b = brief();
  b.screened[0].decision = "maybe";
  assert.ok(validateBrief(b).problems.some((p) => p.includes("screened[0].decision")));
});

test("protocol_sha that is not 40 hex is a problem", () => {
  const b = brief();
  b.protocol_sha = "xyz";
  assert.ok(validateBrief(b).problems.some((p) => p.includes("protocol_sha")));
});

test("a missing top-level field is a problem naming it", () => {
  const b = brief();
  delete b.ai_use;
  assert.ok(validateBrief(b).problems.some((p) => p.includes("ai_use")));
});

test("a proposal with a bad target is a problem", () => {
  const b = brief();
  b.proposals[0].target = "other";
  assert.ok(validateBrief(b).problems.some((p) => p.includes("proposals[0].target")));
});
