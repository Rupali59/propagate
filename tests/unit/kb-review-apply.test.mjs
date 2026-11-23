import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { applyReview } from "../../lib/kb/review/apply.mjs";
import { checkReview } from "../../lib/kb/review/check.mjs";
import { loadReferences } from "../../lib/kb/references.mjs";
import { renderProtocolTemplate } from "../../lib/kb/review/protocol.mjs";
import { buildReview, addSiblingReview, snapshot } from "../fixtures/kb-review/build.mjs";

const now = () => Date.parse("2026-11-23T12:00:00Z");
const apply = (fx) => applyReview(fx.dir, { stateDirPath: fx.state, integrations: fx.integrations, now });

test("Refusal snapshot: QUOTE_NOT_FOUND writes nothing to the review, the references file, the siblings or the state", () => {
  const fx = buildReview({ agreement: "reliable", tweakBrief: (b) => { b.claims[0].quotes[0].text = "a quote that never appears in the saved page body"; } });
  addSiblingReview(fx, "2026-01-01-sibling", renderProtocolTemplate({ slug: "sibling", date: "2026-01-01" }));
  const before = [snapshot(fx.reviews), snapshot(fx.state), readFileSync(fx.refs, "utf8")];
  const r = apply(fx);
  assert.equal(r.ok, false);
  assert.deepEqual(r.wrote, []);
  assert.ok(r.refusals.some((x) => x.code === "QUOTE_NOT_FOUND"));
  assert.deepEqual([snapshot(fx.reviews), snapshot(fx.state), readFileSync(fx.refs, "utf8")], before);
});

test("no agreement.json refuses with SCREENING_UNSAMPLED, and writes nothing", () => {
  const fx = buildReview();
  const before = [snapshot(fx.reviews), readFileSync(fx.refs, "utf8")];
  const r = apply(fx);
  assert.equal(r.ok, false);
  assert.deepEqual(r.refusals.map((x) => x.code), ["SCREENING_UNSAMPLED"]);
  assert.deepEqual([snapshot(fx.reviews), readFileSync(fx.refs, "utf8")], before);
});

test("an unreliable agreement refuses with SCREENING_UNRELIABLE", () => {
  const r = apply(buildReview({ agreement: "unreliable" }));
  assert.deepEqual(r.refusals.map((x) => x.code), ["SCREENING_UNRELIABLE"]);
});

test("the valid fixture with a reliable agreement writes exactly brief.md, kb-references.yml and candidates.md", () => {
  const fx = buildReview({ agreement: "reliable" });
  const before = readFileSync(fx.refs, "utf8");
  const r = apply(fx);
  assert.equal(r.ok, true, JSON.stringify(r.refusals));
  assert.deepEqual(r.wrote, [path.join(fx.dir, "brief.md"), fx.refs, path.join(fx.dir, "candidates.md")]);
  assert.deepEqual(readdirSync(fx.dir).sort(), ["agreement.json", "brief.json", "brief.md", "candidates.md", "discovered.json", "fetched.json", "protocol.md", "searches.json"]);
  const after = readFileSync(fx.refs, "utf8");
  assert.ok(after.startsWith(before), "a pre-existing entry's bytes are unchanged");
  const refs = loadReferences(fx.refs);
  assert.deepEqual(refs.problems, []);
  const mine = refs.references.find((x) => x.id === "example-a");
  assert.equal(mine.verdict, "evaluate");
  assert.equal(mine.url, "https://example.com/a");
  assert.equal(mine.checked.toISOString?.().slice(0, 10) ?? mine.checked, "2026-11-23");
  assert.equal(mine.added.by, "kb review apply");
  assert.equal(mine.added.ask, "llm-screening");
  assert.equal(refs.references.find((x) => x.id === "site-1").verdict, "adopt");
});

test("superseding: A's protocol.md is never edited, its status.json says superseded by B, and check A still passes with a warning", () => {
  // A proposes no reference, so B's new entry cannot make A a duplicate: the test is about status, not references.
  const A = buildReview({ slug: "review-a", agreement: "reliable", tweakBrief: (b) => { b.proposals = b.proposals.filter((p) => p.target !== "reference"); } });
  const nameA = path.basename(A.dir);
  const sup = (t) => t.replace("supersedes: null", `supersedes: ${nameA}`);
  const B = buildReview({ into: A, slug: "review-b", tweakProtocol: sup, agreement: "reliable" });
  const C = buildReview({ into: A, slug: "review-c", tweakProtocol: sup, agreement: "reliable" });
  const protoBefore = readFileSync(path.join(A.dir, "protocol.md"));
  const checkA = () => checkReview(A.dir, { stateDirPath: A.state, integrations: A.integrations });
  assert.deepEqual(checkA().warnings.map((w) => w.code), [], "A is current before");

  const r = apply(B);
  assert.equal(r.ok, true, JSON.stringify(r.refusals));
  assert.equal(r.wrote.at(-1), path.join(A.dir, "status.json"));
  assert.ok(readFileSync(path.join(A.dir, "protocol.md")).equals(protoBefore), "A's protocol.md bytes are unchanged");
  const st = JSON.parse(readFileSync(path.join(A.dir, "status.json"), "utf8"));
  assert.deepEqual(st, { schema_version: 1, status: "superseded", by: path.basename(B.dir), date: "2026-11-23" });

  const a = checkA();
  assert.equal(a.ok, true, JSON.stringify(a.refusals));
  assert.deepEqual(a.refusals, []);
  assert.deepEqual(a.warnings.map((w) => w.code), ["REVIEW_NOT_CURRENT"]);
  assert.match(a.warnings[0].what, /superseded, replaced by 2026-11-20-review-b/);

  const c = checkReview(C.dir, { stateDirPath: C.state, integrations: C.integrations });
  assert.ok(c.refusals.some((x) => x.code === "SUPERSEDES_INVALID" && /already superseded by 2026-11-20-review-b/.test(x.what)), JSON.stringify(c.refusals));
  const rc = apply(C);
  assert.equal(rc.ok, false);
  assert.ok(rc.refusals.some((x) => x.code === "SUPERSEDES_INVALID"));
  assert.deepEqual(JSON.parse(readFileSync(path.join(A.dir, "status.json"), "utf8")).by, path.basename(B.dir), "a refused apply leaves A's status alone");
});

test("a retried apply of the same review rewrites the same status and is not self-refused", () => {
  const A = buildReview({ slug: "review-a" });
  const B = buildReview({ into: A, slug: "review-b", tweakProtocol: (t) => t.replace("supersedes: null", `supersedes: ${path.basename(A.dir)}`), agreement: "reliable" });
  assert.equal(apply(B).ok, true);
  const again = checkReview(B.dir, { stateDirPath: B.state, integrations: B.integrations });
  assert.ok(!again.refusals.some((x) => x.code === "SUPERSEDES_INVALID"), JSON.stringify(again.refusals));
});

test("a references file that cannot be appended to is refused before ANY write", () => {
  const fx = buildReview({ agreement: "reliable", referencesYaml: "references: {}\nschema_version: 1\n" });
  const before = [snapshot(fx.reviews), readFileSync(fx.refs, "utf8")];
  const r = apply(fx);
  assert.equal(r.ok, false);
  assert.equal(r.refusals[0].code, "REFERENCES_UNWRITABLE");
  assert.deepEqual([snapshot(fx.reviews), readFileSync(fx.refs, "utf8")], before);
});
