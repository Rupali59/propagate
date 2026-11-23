import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { drawSample, recordAgreement, scoreAgreement } from "../../lib/kb/review/agree.mjs";

const mk = (sha, n = 30, excluded = 3) => ({
  protocol_sha: sha,
  screened: Array.from({ length: n }, (_, i) => ({
    url: `https://example.com/p${String(i).padStart(2, "0")}`,
    decision: i < excluded ? "excluded" : "included",
    reason: i < excluded ? "off topic" : "",
    lane: "L1",
  })),
  sources: [{ id: "S1", url: "https://example.com/p05", sha256: "a".repeat(64), secondary_review: false }],
  claims: Array.from({ length: 12 }, (_, i) => ({ id: `C${i}`, rq: "RQ1", text: `claim ${i}`, source_ids: ["S1"], quotes: [{ source_id: "S1", text: `quote ${i}` }] })),
});
const SHA = "1234abcd".padEnd(40, "0");

test("Review Focus 4: drawSample twice on one brief gives identical output", () => {
  assert.deepEqual(drawSample(mk(SHA)), drawSample(mk(SHA)));
});

test("changing protocol_sha changes the choice", () => {
  assert.notDeepEqual(drawSample(mk(SHA)), drawSample(mk("deadbeef".padEnd(40, "0"))));
});

test("the screening sample is every excluded entry plus 20% (rounded up) of the rest; support is 20% of claims", () => {
  const s = drawSample(mk(SHA));
  const urls = s.screening.map((x) => x.url);
  for (const u of ["p00", "p01", "p02"]) assert.ok(urls.includes(`https://example.com/${u}`), u);
  assert.equal(urls.length, 3 + Math.ceil(27 * 0.2));
  assert.equal(new Set(urls).size, urls.length);
  assert.equal(s.support.length, Math.ceil(12 * 0.2));
});

test("at least one of each is drawn from a tiny brief", () => {
  const s = drawSample(mk(SHA, 2, 0));
  assert.equal(s.screening.length, 1);
  assert.equal(drawSample(mk(SHA, 1, 1)).screening.length, 1);
});

test("the sample never carries the agent's decision", () => {
  const text = JSON.stringify(drawSample(mk(SHA)));
  assert.ok(!text.includes("decision"), "no decision field");
  assert.ok(!text.includes("excluded") && !text.includes("included"), "no decision value");
  assert.ok(!text.includes("off topic"), "no reason");
});

// n entries: first half agent include, second half exclude; the human flips the given indexes.
function scored(n, flips) {
  const brief = { screened: Array.from({ length: n }, (_, i) => ({ url: `u${i}`, decision: i < n / 2 ? "included" : "excluded", reason: "r", lane: "L" })), claims: [] };
  const screening = {};
  brief.screened.forEach((s, i) => {
    const agent = s.decision === "included" ? "include" : "exclude";
    screening[s.url] = flips.includes(i) ? (agent === "include" ? "exclude" : "include") : agent;
  });
  return scoreAgreement(brief, { screening, support: {} });
}

test("po 0.9, pe 0.5 gives kappa 0.8: reliable", () => {
  const r = scored(10, [0]);
  assert.ok(Math.abs(r.raw - 0.9) < 1e-9);
  assert.ok(Math.abs(r.kappa - 0.8) < 1e-9);
  assert.equal(r.kappa_defined, true);
  assert.equal(r.verdict, "reliable");
});

test("po 0.85, pe 0.5 gives kappa 0.7: unreliable", () => {
  const r = scored(20, [0, 1, 10]);
  assert.ok(Math.abs(r.raw - 0.85) < 1e-9);
  assert.ok(Math.abs(r.kappa - 0.7) < 1e-9);
  assert.equal(r.verdict, "unreliable");
});

test("all one class with full agreement: kappa undefined, reliable, and it says why", () => {
  const brief = { screened: [{ url: "a", decision: "excluded", reason: "r", lane: "L" }, { url: "b", decision: "excluded", reason: "r", lane: "L" }], claims: [] };
  const r = scoreAgreement(brief, { screening: { a: "exclude", b: "exclude" }, support: {} });
  assert.equal(r.kappa_defined, false);
  assert.equal(r.verdict, "reliable");
  assert.match(r.note, /κ undefined: every decision was the same class/);
  const r2 = scoreAgreement(brief, { screening: { a: "exclude", b: "include" }, support: {} });
  assert.equal(r2.verdict, "unreliable");
});

test("support failures are counted, never a verdict by themselves", () => {
  const brief = { screened: [{ url: "a", decision: "excluded", reason: "r", lane: "L" }], claims: [{ id: "C1" }, { id: "C2" }] };
  const r = scoreAgreement(brief, { screening: { a: "exclude" }, support: { C1: "does-not-support", C2: "supports" } });
  assert.equal(r.support_failures, 1);
  assert.equal(r.verdict, "reliable");
});

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "kb-agree-"));
const snap = (d) => readdirSync(d, { recursive: true }).sort().map((f) => `${f}\0${readFileSync(path.join(d, f), "utf8")}`).join("\n");
function answers(brief, flip = false) {
  const s = drawSample(brief);
  const agent = new Map(brief.screened.map((x) => [x.url, x.decision === "included" ? "include" : "exclude"]));
  return {
    screening: Object.fromEntries(s.screening.map((x) => [x.url, flip ? (agent.get(x.url) === "include" ? "exclude" : "include") : agent.get(x.url)])),
    support: Object.fromEntries(s.support.map((x) => [x.claim_id, "supports"])),
  };
}

test("recordAgreement without apply leaves the directory byte-identical", () => {
  const dir = tmp();
  const brief = mk(SHA);
  writeFileSync(path.join(dir, "brief.json"), JSON.stringify(brief));
  const before = snap(dir);
  const r = recordAgreement(dir, answers(brief), { apply: false });
  assert.equal(r.ok, true);
  assert.deepEqual(r.wrote, []);
  assert.equal(snap(dir), before);
  assert.equal(existsSync(path.join(dir, "agreement.json")), false);
});

test("recordAgreement with apply writes agreement.json, stamped with the protocol_sha", () => {
  const dir = tmp();
  const brief = mk(SHA);
  writeFileSync(path.join(dir, "brief.json"), JSON.stringify(brief));
  const r = recordAgreement(dir, answers(brief), { apply: true });
  assert.deepEqual(r.wrote, [path.join(dir, "agreement.json")]);
  assert.equal(JSON.parse(readFileSync(r.wrote[0], "utf8")).protocol_sha, SHA);
});

test("recordAgreement refuses an incomplete, foreign or malformed answer and writes nothing", () => {
  const dir = tmp();
  const brief = mk(SHA);
  writeFileSync(path.join(dir, "brief.json"), JSON.stringify(brief));
  const a = answers(brief);
  const [firstUrl] = Object.keys(a.screening);
  const cases = [
    { screening: { ...a.screening, "https://example.com/not-sampled": "include" }, support: a.support },
    { screening: Object.fromEntries(Object.entries(a.screening).slice(1)), support: a.support },
    { screening: { ...a.screening, [firstUrl]: "maybe" }, support: a.support },
    "nonsense",
  ];
  for (const c of cases) {
    const r = recordAgreement(dir, c, { apply: true });
    assert.equal(r.ok, false);
    assert.ok(r.problems.length);
  }
  assert.equal(existsSync(path.join(dir, "agreement.json")), false);
});
