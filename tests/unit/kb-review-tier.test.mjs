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
