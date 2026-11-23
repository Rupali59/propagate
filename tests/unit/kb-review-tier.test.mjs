import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { deriveTier, loadTierTable } from "../../lib/kb/review/tier.mjs";

const table = { domains: { "arxiv.org": 2, "example.com": 2 }, official_docs: ["docs.example.org"] };
const sha = "a".repeat(64);
const fetched = (final_url) => [{ url: final_url, final_url, sha256: sha, type: "html", status: 200, classification: "ok" }];
const src = (url) => ({ id: "S1", url, sha256: sha });

test("rule 1: a peer-reviewed record with a venue is tier 1, and beats the arXiv host", () => {
  const discovered = [{ engine: "openalex", id: "W1", doi: "10.1000/x", venue: "Journal of Examples", is_peer_reviewed_hint: true, oa_url: "https://arxiv.org/pdf/2401.00001" }];
  const r = deriveTier(src("https://arxiv.org/abs/2401.00001"), { discovered, fetched: fetched("https://arxiv.org/pdf/2401.00001"), table });
  assert.deepEqual(r, { tier: 1, basis: "peer-reviewed venue Journal of Examples" });
});

test("rule 1: a DOI whose record has a venue is tier 1 even without the hint", () => {
  const discovered = [{ engine: "crossref", id: "10.1000/y", doi: "10.1000/y", venue: "Conf of Examples", is_peer_reviewed_hint: false, oa_url: null }];
  const r = deriveTier(src("https://doi.org/10.1000/y"), { discovered, fetched: fetched("https://example.com/p"), table });
  assert.equal(r.tier, 1);
});

test("rule 2: an official docs host is tier 1", () => {
  const r = deriveTier(src("https://docs.example.org/guide"), { fetched: fetched("https://docs.example.org/guide"), table });
  assert.deepEqual(r, { tier: 1, basis: "official docs" });
});

test("rule 3: an arXiv source with no venue record is tier 2 (an arXiv survey is never tier 1)", () => {
  const discovered = [{ engine: "arxiv", id: "2401.00002", doi: null, venue: "arXiv", is_peer_reviewed_hint: false, oa_url: "https://arxiv.org/pdf/2401.00002" }];
  const r = deriveTier(src("https://arxiv.org/abs/2401.00002"), { discovered, fetched: fetched("https://arxiv.org/pdf/2401.00002"), table });
  assert.deepEqual(r, { tier: 2, basis: "preprint (no venue record)" });
});

// Regression: ISSUE-001 — an OpenAlex arXiv record (venue "arXiv (Cornell University)", an arXiv DataCite DOI,
// hint false) was tier 1 "peer-reviewed venue", so a preprint could back a standard-row proposal.
// Found by /qa on 2026-11-23. Inputs are literals copied from a live OpenAlex response: do not move them onto a builder.
test("rule 3: an OpenAlex arXiv record (preprint venue, arXiv DOI, hint false) is tier 2, never tier 1", () => {
  const discovered = [{ engine: "openalex", id: "W4410000001", doi: "10.48550/arxiv.2505.04680", venue: "arXiv (Cornell University)", is_peer_reviewed_hint: false, oa_url: "https://arxiv.org/pdf/2505.04680" }];
  const r = deriveTier(src("https://arxiv.org/pdf/2505.04680"), { discovered, fetched: fetched("https://arxiv.org/pdf/2505.04680"), table });
  assert.deepEqual(r, { tier: 2, basis: "preprint (no venue record)" });
});

test("rule 1: a preprint server is not a venue, and an arXiv DOI is not a peer-review record, wherever the source lives", () => {
  // Each row is caught by ONE guard: the bioRxiv/SSRN rows carry ordinary-looking DOIs, so only the venue rule
  // stops them; the last row has a real-looking venue and only its arXiv DOI says preprint.
  for (const [venue, doi] of [["bioRxiv (Cold Spring Harbor Laboratory)", "10.1101/2024.01.01.573000"], ["medRxiv", "10.1101/2024.02.02.24300000"], ["SSRN Electronic Journal", "10.2139/ssrn.4700000"], ["Journal of Examples", "10.48550/arxiv.2401.00009"]]) {
    const discovered = [{ engine: "openalex", id: "W2", doi, venue, is_peer_reviewed_hint: false, oa_url: "https://example.com/p.pdf" }];
    const r = deriveTier(src("https://example.com/p.pdf"), { discovered, fetched: fetched("https://example.com/p.pdf"), table });
    assert.notEqual(r.tier, 1, `${venue} must not read as a peer-reviewed venue`);
  }
});

test("rule 1: a real venue still wins for a paper also on arXiv (the published version is tier 1)", () => {
  const discovered = [{ engine: "openalex", id: "W3", doi: "10.18653/v1/2025.findings-naacl.157", venue: "Findings of the Association for Computational Linguistics: NAACL", is_peer_reviewed_hint: true, oa_url: "https://aclanthology.org/2025.findings-naacl.157.pdf" }];
  const r = deriveTier(src("https://aclanthology.org/2025.findings-naacl.157.pdf"), { discovered, fetched: fetched("https://aclanthology.org/2025.findings-naacl.157.pdf"), table });
  assert.equal(r.tier, 1);
});

test("rule 4: a host in the table takes the table's tier", () => {
  const r = deriveTier(src("https://www.example.com/a"), { fetched: fetched("https://www.example.com/a"), table });
  assert.deepEqual(r, { tier: 2, basis: "tier table" });
});

test("rule 5: a host in no table is tier 3, basis default", () => {
  const r = deriveTier(src("https://paperswithcode.com/x"), { fetched: fetched("https://paperswithcode.com/x"), table });
  assert.deepEqual(r, { tier: 3, basis: "default" });
});

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "kb-tier-"));

test("loadTierTable: absent, null and unreadable files are KB_TIERS_NOT_CONFIGURED, never an empty table", () => {
  for (const f of [null, path.join(tmp(), "nope.yml")]) {
    const r = loadTierTable(f);
    assert.equal(r.ok, false);
    assert.equal(r.code, "KB_TIERS_NOT_CONFIGURED");
  }
  const bad = path.join(tmp(), "t.yml");
  writeFileSync(bad, "- just\n- a list\n");
  assert.equal(loadTierTable(bad).code, "KB_TIERS_NOT_CONFIGURED");
  writeFileSync(bad, "schema_version: 1\ndomains: {a.com: 9}\n");
  assert.equal(loadTierTable(bad).code, "KB_TIERS_NOT_CONFIGURED");
});

test("loadTierTable: a good table loads, hosts lower-cased", () => {
  const f = path.join(tmp(), "t.yml");
  writeFileSync(f, "schema_version: 1\ndomains: {ArXiv.org: 2}\nofficial_docs: [docs.example.org]\n");
  const r = loadTierTable(f);
  assert.equal(r.ok, true);
  assert.deepEqual(r.table, { domains: { "arxiv.org": 2 }, official_docs: ["docs.example.org"] });
});
