import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { applyReview } from "../../lib/kb/review/apply.mjs";
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

test("a review that supersedes another also flips the old protocol's status, and lists it in wrote", () => {
  const fx = buildReview({ agreement: "reliable", tweakProtocol: (t) => t.replace("supersedes: null", "supersedes: 2026-01-01-old") });
  const oldDir = addSiblingReview(fx, "2026-01-01-old", renderProtocolTemplate({ slug: "old", date: "2026-01-01" }));
  const r = apply(fx);
  assert.equal(r.ok, true, JSON.stringify(r.refusals));
  const oldFile = path.join(oldDir, "protocol.md");
  assert.deepEqual(r.wrote.at(-1), oldFile);
  assert.match(readFileSync(oldFile, "utf8"), /^status: superseded/m);
  assert.doesNotMatch(readFileSync(oldFile, "utf8"), /^status: current/m);
});

test("a references file that cannot be appended to is refused before ANY write", () => {
  const fx = buildReview({ agreement: "reliable", referencesYaml: "references: {}\nschema_version: 1\n" });
  const before = [snapshot(fx.reviews), readFileSync(fx.refs, "utf8")];
  const r = apply(fx);
  assert.equal(r.ok, false);
  assert.equal(r.refusals[0].code, "REFERENCES_UNWRITABLE");
  assert.deepEqual([snapshot(fx.reviews), readFileSync(fx.refs, "utf8")], before);
});
