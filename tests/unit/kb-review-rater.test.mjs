// The model second rater (#412): the label code derives from per-criterion answers, the pure rater brief, the
// disagreement list with its derived tolerable count, the bounded re-runs, and adjudication that never edits the brief.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { drawSample, readAgreement, recordAgreement, RATER_KINDS, SCREEN_VALUES, scoreAgreement } from "../../lib/kb/review/agree.mjs";
import { applyAdjudication } from "../../lib/kb/review/adjudicated.mjs";
import { compareRaters, tolerableCount } from "../../lib/kb/review/disagree.mjs";
import { renderProtocolTemplate, requiresHumanSecondReviewer } from "../../lib/kb/review/protocol.mjs";
import { criteriaOf, deriveLabel } from "../../lib/kb/review/rater.mjs";
import { reviewCmd } from "../../lib/kb/review/cmd.mjs";
import { applyReview } from "../../lib/kb/review/apply.mjs";
import { checkReview } from "../../lib/kb/review/check.mjs";
import { buildReview, snapshot } from "../fixtures/kb-review/build.mjs";

const NOW = Date.parse("2026-11-27T10:00:00Z");
const QUOTE = "The studied system screens records with a language model";
const sha256 = (t) => createHash("sha256").update(t).digest("hex");

/** A review dir with real bodies: nExcl lane-excluded rows and nIncl lane-included rows, and criteria in the protocol. */
function mk({ nExcl = 25, nIncl = 20 } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "kb-rater-"));
  const dir = path.join(root, "review");
  const state = path.join(root, "state");
  mkdirSync(path.join(dir), { recursive: true });
  mkdirSync(path.join(state, "kb", "fetched"), { recursive: true });
  const proto = renderProtocolTemplate({ slug: "s", date: "2026-11-27", decision: "d", decider: "the decider" })
    .replace("inclusion: []", 'inclusion: ["I1: an evaluation of LLM screening", "I2: guidance on LLM screening"]')
    .replace("exclusion: []", 'exclusion: ["E1: no human reference standard", "E2: a duplicate"]');
  writeFileSync(path.join(dir, "protocol.md"), proto);
  const records = [];
  const screened = [];
  const add = (i, decision) => {
    const url = `https://example.com/${decision[0]}${String(i).padStart(2, "0")}`;
    const body = `Item ${url}. ${QUOTE}. It has no human reference standard at all here.`;
    const sha = sha256(body);
    writeFileSync(path.join(state, "kb", "fetched", sha), body);
    records.push({ url, final_url: url, status: 200, type: "html", sha256: sha, date: "2026-11-21", classification: "ok" });
    screened.push({ url, decision, reason: `lane secret reason ${i}`, lane: "L7" });
  };
  for (let i = 0; i < nExcl; i++) add(i, "excluded");
  for (let i = 0; i < nIncl; i++) add(i, "included");
  writeFileSync(path.join(dir, "fetched.json"), JSON.stringify({ schema_version: 1, records }));
  const brief = { schema_version: 1, review: "s", protocol_sha: "ab12cd34".padEnd(40, "0"), screened, sources: [], claims: [], proposals: [], disagreements: {} };
  writeFileSync(path.join(dir, "brief.json"), JSON.stringify(brief));
  return { root, dir, state, brief, records };
}

/** The rater's answers: agree with the lane everywhere except the urls in `flip` (and `blank` urls, which get no quote). */
function raterFile(fx, { flip = [], blank = [], model = "test-model", widen = false } = {}) {
  const sample = drawSample(fx.brief, { widen });
  const lane = new Map(fx.brief.screened.map((s) => [s.url, s.decision]));
  const screening = {};
  for (const { url } of sample.screening) {
    let call = lane.get(url) === "included" ? "include" : "exclude";
    if (flip.includes(url)) call = call === "include" ? "exclude" : "include";
    const quote = blank.includes(url) ? "words that are nowhere in this saved text at all today" : QUOTE;
    screening[url] = {
      criteria: [
        { id: "I1", met: call === "include", quote: call === "include" ? quote : "", reason: "i1" },
        { id: "I2", met: false },
        { id: "E1", met: call === "exclude", quote: call === "exclude" ? quote : "", reason: "e1" },
        { id: "E2", met: false },
      ],
      reason: `rater reason for ${url}`,
    };
  }
  return { model, screening, support: {} };
}

const run = async (fx, args, file) => {
  const out = [];
  const err = [];
  const io = { log: (...a) => out.push(a.join(" ")), error: (...a) => err.push(a.join(" ")) };
  const argv = [...args];
  if (file) {
    const f = path.join(fx.root, `in-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(f, JSON.stringify(file));
    argv.push(file.__flag, f);
  }
  const code = await reviewCmd(["agree", fx.dir, ...argv], { io, integrations: {}, inject: { stateDirPath: fx.state, now: () => NOW } });
  return { code, out: out.join("\n"), err: err.join("\n") };
};
const record = (fx, file, extra = []) => run(fx, ["--record", writeIn(fx, file), "--rater", "m", "--rater-kind", "model-referenced", "--apply", ...extra]);
const writeIn = (fx, obj) => {
  const f = path.join(fx.root, `rec-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(f, JSON.stringify(obj));
  return f;
};

test("model-referenced is a rater kind and cannot-rate a screening value", () => {
  assert.ok(RATER_KINDS.includes("model-referenced"));
  assert.ok(SCREEN_VALUES.includes("cannot-rate"));
});

test("new protocols say second reviewer: model, so a model rater needs no override; an old one that names a person still does", () => {
  const t = renderProtocolTemplate({ slug: "s", date: "2026-11-27" });
  assert.match(t, /second reviewer: model/);
  assert.equal(requiresHumanSecondReviewer(t), false);
  assert.equal(requiresHumanSecondReviewer(t.replace(/second reviewer: model[^\n]*/, "The second reviewer: a person.")), true);
});

// ---- derive from criteria ----------------------------------------------------------------------------------------
const crit = criteriaOf({ inclusion: ["I1: a", "I2: b"], exclusion: ["E1: c", "E2: d"] });
const BODY = `Intro. ${QUOTE}. Outro text here.`;
test("derive: an I-criterion met with a quote found is include; an E-criterion met with a quote found is exclude", () => {
  assert.equal(deriveLabel(crit, [{ id: "I1", met: true, quote: QUOTE }, { id: "I2", met: false }, { id: "E1", met: false }, { id: "E2", met: false }], BODY).label, "include");
  assert.equal(deriveLabel(crit, [{ id: "I1", met: false }, { id: "I2", met: false }, { id: "E1", met: true, quote: QUOTE }, { id: "E2", met: false }], BODY).label, "exclude");
});
test("derive: a quote the body does not hold is cannot-rate, never include or exclude", () => {
  const nope = "words that are nowhere in this saved text at all today";
  assert.equal(deriveLabel(crit, [{ id: "I1", met: true, quote: nope }, { id: "E1", met: false }], BODY).label, "cannot-rate");
  assert.equal(deriveLabel(crit, [{ id: "I1", met: false }, { id: "E1", met: true, quote: nope }], BODY).label, "cannot-rate");
  assert.equal(deriveLabel(crit, [{ id: "I1", met: true, quote: "too short" }], BODY).label, "cannot-rate", "a quote outside 6-15 words is not found");
  assert.equal(deriveLabel(crit, [{ id: "I1", met: false }, { id: "E1", met: false }], BODY).label, "cannot-rate", "nothing met");
  assert.equal(deriveLabel(crit, [{ id: "I1", met: true, quote: QUOTE }], null).label, "cannot-rate", "no saved body");
});
test("derive: an included-looking item with an E-criterion met but unquoted is cannot-rate", () => {
  assert.equal(deriveLabel(crit, [{ id: "I1", met: true, quote: QUOTE }, { id: "E1", met: true, quote: "x" }], BODY).label, "cannot-rate");
});

test("kappa is scored over include/exclude only and cannot-rate is counted", () => {
  const fx = mk({ nExcl: 4, nIncl: 4 });
  const sample = drawSample(fx.brief);
  const lane = new Map(fx.brief.screened.map((s) => [s.url, s.decision === "included" ? "include" : "exclude"]));
  const screening = Object.fromEntries(sample.screening.map((s, i) => [s.url, i === 0 ? "cannot-rate" : lane.get(s.url)]));
  const sc = scoreAgreement(fx.brief, { screening, support: {} });
  assert.equal(sc.cannot_rate, 1);
  assert.equal(sc.n, sample.screening.length - 1);
});

// ---- the rater brief ----------------------------------------------------------------------------------------------
test("--rater-brief is pure and carries only url, body path and the criteria: no decision, reason, lane or Quality text", async () => {
  const fx = mk({ nExcl: 6, nIncl: 6 });
  const before = snapshot(fx.root);
  const r = await run(fx, ["--rater-brief"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(snapshot(fx.root), before, "--rater-brief wrote");
  const j = JSON.parse(r.out);
  assert.deepEqual(Object.keys(j).sort(), ["criteria", "items"]);
  assert.ok(j.items.length > 0);
  for (const it of j.items) {
    assert.deepEqual(Object.keys(it).sort(), ["body_path", "url"]);
    assert.ok(existsSync(it.body_path));
  }
  assert.deepEqual(j.criteria.inclusion.map((c) => c.id), ["I1", "I2"]);
  assert.match(j.criteria.exclusion[0].text, /^E1: no human reference standard/);
  for (const banned of ["decision", "reason", "lane", "L7", "included", "excluded", "Quality", "second reviewer", "lane secret"]) {
    assert.ok(!r.out.includes(banned), `the rater brief leaks "${banned}"`);
  }
});

// ---- the tolerable count ------------------------------------------------------------------------------------------
test("tolerable count: 25 exclusions and 4 inclusions absorb exactly 1 disagreement (hand-worked)", () => {
  assert.equal(tolerableCount(25, 4), 1);
  // by hand, n = 29: one missed include a=1: rater incl 5, po 28/29, pe (25*24+4*5)/841, kappa 0.869; one wrong include b=1: kappa 0.838;
  // two disagreements in any split fall below 0.8 (a=2: 0.760, a=1 b=1: 0.710, b=2: 0.633).
  assert.equal(tolerableCount(25, 4, 0.87), 0, "the threshold is the parameter, not a constant of the loop");
});
test("tolerable count grows with the sample and is 0 when a class is empty", () => {
  assert.ok(tolerableCount(100, 20) > tolerableCount(25, 4));
  assert.equal(tolerableCount(10, 0), 0);
});

// ---- record, disagreements ----------------------------------------------------------------------------------------
test("recording a model-referenced rater writes rater.json with answers, quotes, reasons, model id and the agent sha", async () => {
  const fx = mk();
  const r = await record(fx, raterFile(fx, { model: "model-x" }));
  assert.equal(r.code, 0, r.err || r.out);
  const rj = JSON.parse(readFileSync(path.join(fx.dir, "rater.json"), "utf8"));
  assert.equal(rj.model, "model-x");
  assert.match(rj.agent_sha256, /^[0-9a-f]{64}$/);
  const first = Object.values(rj.items)[0];
  assert.ok(first.criteria.some((c) => c.quote === QUOTE && c.quote_found), "the answers, quotes and verdict are recorded");
  assert.match(first.reason, /^rater reason/);
  const ag = readAgreement(fx.dir).agreement;
  assert.equal(ag.rater_kind, "model-referenced");
  assert.ok(Object.values(ag.screening).every((v) => ["include", "exclude", "cannot-rate"].includes(v)), "agreement.json holds derived labels, not the rater's own call");
});

test("a model-referenced record answers screening alone: the rater brief carries no claims, so no support answers are required", async () => {
  const fx = mk({ nExcl: 6, nIncl: 6 });
  const f = raterFile(fx);
  delete f.support;
  assert.equal((await record(fx, f)).code, 0);
  assert.equal(readAgreement(fx.dir).agreement.rater_kind, "model-referenced");
  assert.equal((await run(fx, ["--disagreements"])).code, 0, "the record is a complete answer to the sample");
});

test("--record without --apply writes nothing; a criterion left unanswered refuses", async () => {
  const fx = mk({ nExcl: 6, nIncl: 6 });
  const f = raterFile(fx);
  const dry = await run(fx, ["--record", writeIn(fx, f), "--rater", "m", "--rater-kind", "model-referenced"]);
  assert.equal(dry.code, 0, dry.err);
  assert.ok(!existsSync(path.join(fx.dir, "rater.json")) && !existsSync(path.join(fx.dir, "agreement.json")));
  const url = Object.keys(f.screening)[0];
  f.screening[url].criteria.pop();
  const bad = await run(fx, ["--record", writeIn(fx, f), "--rater", "m", "--rater-kind", "model-referenced", "--apply"]);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /leaves criteria unanswered: E2/);
});

test("--disagreements: no disagreements exits 0 and is pure", async () => {
  const fx = mk();
  await record(fx, raterFile(fx));
  const before = snapshot(fx.root);
  const r = await run(fx, ["--disagreements"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /tolerable count 1/);
  assert.match(r.out, /no disagreements: kb review apply/);
  assert.equal(snapshot(fx.root), before, "--disagreements wrote");
});

test("--disagreements: one disagreement is within the tolerable count and prints title, both calls, criterion and both reasons", async () => {
  const fx = mk();
  const miss = drawSample(fx.brief).screening.find((s) => s.url.includes("/e"));
  await record(fx, raterFile(fx, { flip: [miss.url] }));
  const before = snapshot(fx.root);
  const r = await run(fx, ["--disagreements"]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, new RegExp(`MISSED-INCLUDE ${miss.url.replace(/[.]/g, "\\.")}[^\\n]*lane: exclude \\(lane secret reason[^\\n]*rater: include \\(I1 met, quote found\\)[^\\n]*rater reason: rater reason for`));
  assert.match(r.out, /within the tolerable count \(1 <= 1\)/);
  assert.equal(snapshot(fx.root), before, "--disagreements wrote");
});

test("--disagreements: over the tolerable count exits 1 and says to widen the sample with a changed brief", async () => {
  const fx = mk();
  const [a, b] = drawSample(fx.brief).screening.filter((s) => s.url.includes("/e"));
  await record(fx, raterFile(fx, { flip: [a.url, b.url] }));
  const r = await run(fx, ["--disagreements"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /over the tolerable count \(2 > 1\): re-run with a widened sample \(T7\) and a changed brief/);
});

test("re-runs are bounded: the same brief is not a re-run, a changed one widens and counts, and after 2 the answer is stuck", async () => {
  const fx = mk();
  // five missed includes: over the narrow sample's count (1) and still over the widened sample's (4)
  const flip = drawSample(fx.brief).screening.filter((s) => s.url.includes("/e")).slice(0, 5).map((s) => s.url);
  assert.equal((await record(fx, raterFile(fx, { flip }))).code, 0);
  assert.equal(readAgreement(fx.dir).agreement.over_tolerance, true);
  assert.equal(readAgreement(fx.dir).agreement.reruns, 0);

  const same = await record(fx, raterFile(fx, { flip }));
  assert.equal(same.code, 1);
  assert.match(same.err, /not a re-run \(T7\); change the brief first/);

  const change = (n) => {
    fx.brief = { ...fx.brief, ai_use: { note: `changed ${n}` } };
    writeFileSync(path.join(fx.dir, "brief.json"), JSON.stringify(fx.brief));
  };
  // re-run 1: the sample widens to every included row, so the old (narrow) answers no longer cover it
  change(1);
  assert.equal((await record(fx, raterFile(fx, { flip }))).code, 1, "a record for the narrow sample does not answer the widened one");
  assert.equal((await record(fx, raterFile(fx, { flip, widen: true }))).code, 0);
  let ag = readAgreement(fx.dir).agreement;
  assert.equal(ag.reruns, 1);
  assert.equal(ag.widened, true);
  assert.equal(Object.keys(ag.screening).length, drawSample(fx.brief, { widen: true }).screening.length);
  assert.match((await run(fx, ["--disagreements"])).out, /re-run 2 of 2/);

  // re-run 2, still over: the third answer is stuck
  change(2);
  assert.equal((await record(fx, raterFile(fx, { flip, widen: true }))).code, 0);
  ag = readAgreement(fx.dir).agreement;
  assert.equal(ag.reruns, 2);
  const stuck = await run(fx, ["--disagreements"]);
  assert.equal(stuck.code, 1);
  assert.match(stuck.out, /stuck after 2 re-runs[^\n]*waiting digest/);
  assert.doesNotMatch(stuck.out, /re-run with a widened sample/);
});

test("kappa null (a sample with no inclusions) has its own message and is never the kappa < 0.8 path", async () => {
  const fx = mk({ nExcl: 5, nIncl: 0 });
  await record(fx, raterFile(fx));
  const r = await run(fx, ["--disagreements"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /sample has no inclusions to compare/);
  assert.doesNotMatch(r.out, /over the tolerable count|re-run/);
});

// ---- adjudication -------------------------------------------------------------------------------------------------
test("--adjudicate without --apply writes nothing; with --apply writes adjudication.json only; brief.json is never edited", async () => {
  const fx = mk();
  const miss = drawSample(fx.brief).screening.find((s) => s.url.includes("/e"));
  await record(fx, raterFile(fx, { flip: [miss.url] }));
  const answers = writeIn(fx, { [miss.url]: "rater" });
  const briefBefore = readFileSync(path.join(fx.dir, "brief.json"), "utf8");
  const before = snapshot(fx.root);
  const dry = await run(fx, ["--adjudicate", answers]);
  assert.equal(dry.code, 0, dry.err);
  assert.equal(snapshot(fx.root), before, "--adjudicate without --apply wrote");
  const wet = await run(fx, ["--adjudicate", answers, "--apply"]);
  assert.equal(wet.code, 0, wet.err);
  const adj = JSON.parse(readFileSync(path.join(fx.dir, "adjudication.json"), "utf8"));
  assert.equal(adj.answers[miss.url].answer, "rater");
  assert.equal(readFileSync(path.join(fx.dir, "brief.json"), "utf8"), briefBefore, "brief.json was edited");
});

test("--adjudicate refuses an answer for an item that is not a listed disagreement, and a value that is not lane or rater", async () => {
  const fx = mk();
  const miss = drawSample(fx.brief).screening.find((s) => s.url.includes("/e"));
  await record(fx, raterFile(fx, { flip: [miss.url] }));
  const other = drawSample(fx.brief).screening.find((s) => s.url !== miss.url);
  const r1 = await run(fx, ["--adjudicate", writeIn(fx, { [other.url]: "lane" }), "--apply"]);
  assert.equal(r1.code, 1);
  assert.match(r1.err, /is not a listed disagreement/);
  const r2 = await run(fx, ["--adjudicate", writeIn(fx, { [miss.url]: "maybe" }), "--apply"]);
  assert.equal(r2.code, 1);
  assert.ok(!existsSync(path.join(fx.dir, "adjudication.json")));
});

test("applyAdjudication: `rater` flips the rendered decision, `lane` and no answer keep the lane's; the input brief is untouched", () => {
  const brief = {
    screened: [{ url: "u1", decision: "excluded", reason: "r", lane: "L" }, { url: "u2", decision: "included", reason: "r", lane: "L" }],
    sources: [{ id: "S1", url: "u2", sha256: "a".repeat(64) }],
    claims: [{ id: "C1", rq: "RQ1", text: "t", source_ids: ["S1"], quotes: [] }],
    proposals: [{ target: "reference", claim_ids: ["C1"], text: "p" }],
  };
  const copy = JSON.stringify(brief);
  const dir = mkdtempSync(path.join(os.tmpdir(), "kb-adj-"));
  writeFileSync(path.join(dir, "agreement.json"), JSON.stringify({ schema_version: 2, screening: { u1: "include", u2: "exclude" }, support: {} }));
  writeFileSync(path.join(dir, "adjudication.json"), JSON.stringify({ answers: { u1: { answer: "rater" }, u2: { answer: "lane" } } }));
  const a = applyAdjudication(brief, dir);
  assert.equal(a.brief.screened[0].decision, "included");
  assert.equal(a.brief.screened[1].decision, "included", "lane answered: the lane's decision stands");
  assert.equal(a.brief.claims.length, 1);
  writeFileSync(path.join(dir, "adjudication.json"), JSON.stringify({ answers: { u2: { answer: "rater" } } }));
  const b = applyAdjudication(brief, dir);
  assert.equal(b.brief.screened[1].decision, "excluded");
  assert.deepEqual(b.brief.claims, [], "claims resting only on a source the maintainer excluded are withheld");
  assert.deepEqual(b.brief.proposals, []);
  assert.equal(JSON.stringify(brief), copy, "applyAdjudication mutated its input");
});

// ---- check + apply on the full review fixture ---------------------------------------------------------------------
const HUMAN = (t) => t.replace(/second reviewer: model[^\n]*/, "The second reviewer is a person.");
test("check: a model rater where the protocol names a person refuses; with a recorded override it warns SCREENING_RATER_MODEL_OVERRIDE; a protocol that says model accepts", () => {
  const go = (opts, edit) => {
    const fx = buildReview({ agreement: "reliable", raterKind: "model-referenced", ...opts });
    if (edit) edit(path.join(fx.dir, "agreement.json"));
    return checkReview(fx.dir, { stateDirPath: fx.state, integrations: fx.integrations });
  };
  const refused = go({ tweakProtocol: HUMAN });
  assert.deepEqual([...new Set(refused.refusals.map((x) => x.code))], ["SCREENING_RATER_NOT_HUMAN"]);
  const warned = go({ tweakProtocol: HUMAN }, (f) => {
    const j = JSON.parse(readFileSync(f, "utf8"));
    j.override = { by: "the maintainer", decision: "2026-11-27 model rater", why: "w", date: "2026-11-27" };
    writeFileSync(f, JSON.stringify(j));
  });
  assert.equal(warned.ok, true, warned.refusals.map((x) => x.what).join("|"));
  assert.ok(warned.warnings.some((w) => w.code === "SCREENING_RATER_MODEL_OVERRIDE" && /2026-11-27 model rater/.test(w.what)));
  const accepted = go({});
  assert.equal(accepted.ok, true, accepted.refusals.map((x) => x.what).join("|"));
  assert.ok(!accepted.warnings.some((w) => w.code === "SCREENING_RATER_MODEL_OVERRIDE"), "no override is needed, so none is reported");
  const empty = go({ tweakProtocol: HUMAN }, (f) => {
    const j = JSON.parse(readFileSync(f, "utf8"));
    j.override = { by: "x", decision: "  " };
    writeFileSync(f, JSON.stringify(j));
  });
  assert.equal(empty.ok, false, "an override with no decision id is not an override");
});

test("--override writes override into agreement.json; old schema-2 records with no override still read", async () => {
  const fx = mk();
  const r = await record(fx, raterFile(fx), ["--override", "2026-11-27 model second rater"]);
  assert.equal(r.code, 0, r.err);
  const ag = readAgreement(fx.dir).agreement;
  assert.deepEqual(Object.keys(ag.override).sort(), ["by", "date", "decision", "why"]);
  assert.equal(ag.override.decision, "2026-11-27 model second rater");
  assert.equal(ag.override.by, "the decider");
  const human = recordAgreement(fx.dir, { screening: {}, support: {} }, { rater: "x", raterKind: "human", override: "d" });
  assert.equal(human.ok, false);
  assert.match(human.problems.join(), /only a model rater needs one/);
  writeFileSync(path.join(fx.dir, "agreement.json"), JSON.stringify({ schema_version: 2, protocol_sha: fx.brief.protocol_sha, rater: "old", rater_kind: "human", screening: {}, support: {} }));
  assert.equal(readAgreement(fx.dir).ok, true);
});

/** buildReview with 20 included sources (4 in the sample) and 25 excluded rows (all in it): a sample that can absorb one disagreement. */
function big() {
  const extras = [];
  const fx = buildReview({
    tweakFetched: (rs) => {
      for (let i = 0; i < 17; i++) {
        const body = `Extra ${i}. ${QUOTE}. End.`;
        extras.push({ i, sha: sha256(body), body });
        rs.push({ url: `https://example.com/x${i}`, final_url: `https://example.com/x${i}`, status: 200, type: "html", sha256: sha256(body), date: "2026-11-21", classification: "ok" });
      }
      return rs;
    },
    tweakBrief: (b) => {
      for (const e of extras) {
        b.screened.push({ url: `https://example.com/x${e.i}`, decision: "included", reason: "", lane: "L1" });
        b.sources.push({ id: `S${3 + e.i}`, url: `https://example.com/x${e.i}`, sha256: e.sha, secondary_review: false });
        b.claims.push({ id: `C${3 + e.i}`, rq: "RQ1", text: `claim ${e.i}`, source_ids: [`S${3 + e.i}`], quotes: [{ source_id: `S${3 + e.i}`, text: QUOTE }] });
      }
      for (let i = 0; i < 24; i++) b.screened.push({ url: `https://example.com/e${i}`, decision: "excluded", reason: "off topic", lane: "L1" });
      b.claims = b.claims.filter((c) => c.id !== "C0");
    },
  });
  for (const e of extras) writeFileSync(path.join(fx.state, "kb", "fetched", e.sha), e.body);
  return fx;
}

test("apply uses the lane decision unless an adjudication says rater; kappa and brief.json stay as scored", () => {
  const fx = big();
  const sample = drawSample(fx.brief);
  const lane = new Map(fx.brief.screened.map((s) => [s.url, s.decision === "included" ? "include" : "exclude"]));
  const flipUrl = sample.screening.find((s) => lane.get(s.url) === "exclude").url;
  const screening = Object.fromEntries(sample.screening.map((s) => [s.url, s.url === flipUrl ? "include" : lane.get(s.url)]));
  writeFileSync(path.join(fx.dir, "agreement.json"), JSON.stringify({ schema_version: 2, protocol_sha: fx.brief.protocol_sha, rater: "m", rater_kind: "model-referenced", screening, support: Object.fromEntries(sample.support.map((s) => [s.claim_id, "supports"])) }));
  const deps = { stateDirPath: fx.state, integrations: fx.integrations, now: () => NOW };
  const briefBefore = readFileSync(path.join(fx.dir, "brief.json"), "utf8");
  const c = checkReview(fx.dir, deps);
  assert.equal(c.ok, true, c.refusals.map((x) => x.what).join("|"));
  const kappa = c.derived.screening.kappa;
  const countsBefore = c.counts;
  const plain = applyReview(fx.dir, deps);
  assert.equal(plain.ok, true, JSON.stringify(plain.refusals));
  const mdPlain = readFileSync(path.join(fx.dir, "brief.md"), "utf8");
  assert.match(mdPlain, new RegExp(`- Included: ${countsBefore.included}\\n`), "no adjudication: the lane's counts");
  assert.doesNotMatch(mdPlain, /Adjudicated screening/);
  writeFileSync(path.join(fx.dir, "adjudication.json"), JSON.stringify({ answers: { [flipUrl]: { answer: "rater" } } }));
  const adj = applyReview(fx.dir, deps);
  assert.equal(adj.ok, true, JSON.stringify(adj.refusals));
  const md = readFileSync(path.join(fx.dir, "brief.md"), "utf8");
  assert.match(md, new RegExp(`- Included: ${countsBefore.included + 1}\\n`));
  assert.match(md, new RegExp(`## Adjudicated screening[\\s\\S]*${flipUrl.replace(/[.]/g, "\\.")}`));
  assert.equal(checkReview(fx.dir, deps).derived.screening.kappa, kappa, "kappa is scored before adjudication");
  assert.equal(readFileSync(path.join(fx.dir, "brief.json"), "utf8"), briefBefore, "brief.json was edited");
});
