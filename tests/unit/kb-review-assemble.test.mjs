// kb review assemble (#327): lanes + searches.json + fetched.json -> brief.json, deterministically, behind validateLane.
// Each Review Focus case constructs the input that would break the rule and asserts the refusal AND that nothing was
// written (a directory snapshot, not the command's own description of itself: rule:safety-flag-needs-a-test).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { kbCmd } from "../../cli/kb.mjs";
import { COMMANDS } from "../../lib/core/commands.mjs";
import { assembleBrief } from "../../lib/kb/review/assemble.mjs";
import { validateLane } from "../../lib/kb/review/lane-schema.mjs";
import { validateBrief } from "../../lib/kb/review/schema.mjs";
import { checkReview } from "../../lib/kb/review/check.mjs";
import { BODY1, BODY2, QUOTE1, QUOTE2, SEARCH_DATE, buildReview, snapshot } from "../fixtures/kb-review/build.mjs";

const sha = (t) => createHash("sha256").update(t).digest("hex");
const S1 = sha(BODY1);
const S2 = sha(BODY2);
const NOW = Date.parse("2026-11-23T12:00:00Z");

async function kb(argv, fx) {
  const out = [];
  const err = [];
  const io = { log: (...a) => out.push(a.join(" ")), error: (...a) => err.push(a.join(" ")) };
  const code = await kbCmd(argv, { io, integrations: fx.integrations, workspaces: [], stateDirPath: fx.state, now: () => NOW });
  return { code, out: out.join("\n"), err: err.join("\n") };
}
const lane = (id, o) => ({ lane: id, model: "example-model", round: 1, rq: "RQ1", handed: [], screened: [], claims: [], gaps: [], suggestions: [], ...o });
const included = (s, reason = "meets inclusion 1") => ({ sha256: s, decision: "included", reason });
const writeLane = (fx, l, id = l.lane) => {
  mkdirSync(path.join(fx.dir, "lanes"), { recursive: true });
  writeFileSync(path.join(fx.dir, "lanes", `${id}.json`), typeof l === "string" ? l : JSON.stringify(l, null, 2));
};
const two = (fx) => {
  writeLane(fx, lane("L1", { handed: [S1], screened: [included(S1)], claims: [{ text: "foxes jump", quotes: [QUOTE1], sha256s: [S1] }] }));
  writeLane(fx, lane("L2", { handed: [S2], screened: [included(S2)], claims: [{ text: "tests cover paths", quotes: [QUOTE2], sha256s: [S2] }] }));
};
/** Fetch a further saved body: the body in the store and its fetched.json record. */
function addBody(fx, text, url) {
  const s = sha(text);
  writeFileSync(path.join(fx.state, "kb", "fetched", s), text);
  const f = JSON.parse(readFileSync(path.join(fx.dir, "fetched.json"), "utf8"));
  f.records.push({ url, final_url: url, status: 200, type: "html", sha256: s, date: SEARCH_DATE, classification: "ok" });
  writeFileSync(path.join(fx.dir, "fetched.json"), JSON.stringify(f, null, 2));
  return s;
}

test("two valid lanes give a brief.json that passes validateBrief, with ids, URLs, not_retrieved and ai_use filled", async () => {
  const fx = buildReview();
  two(fx);
  const r = await kb(["review", "assemble", fx.dir, "--json"], fx);
  assert.equal(r.code, 0, r.err || r.out);
  const brief = JSON.parse(readFileSync(path.join(fx.dir, "brief.json"), "utf8"));
  assert.deepEqual(validateBrief(brief), { ok: true, problems: [] });
  assert.deepEqual(brief.claims.map((c) => c.id), ["C1", "C2"]);
  assert.deepEqual(brief.sources.map((s) => [s.id, s.url, s.sha256, s.secondary_review]), [["S1", "https://example.com/a", S1, false], ["S2", "https://docs.example.org/guide", S2, false]]);
  assert.deepEqual(brief.claims[0].quotes, [{ source_id: "S1", text: QUOTE1 }]);
  assert.deepEqual(brief.claims[1].source_ids, ["S2"]);
  assert.deepEqual(brief.screened.map((s) => [s.url, s.decision, s.lane]), [["https://example.com/a", "included", "L1"], ["https://docs.example.org/guide", "included", "L2"], ["https://example.com/c", "not_retrieved", "fetch"]]);
  assert.match(brief.screened[2].reason, /not_retrieved/);
  assert.deepEqual(brief.disagreements, { RQ1: "none found" });
  assert.deepEqual(brief.ai_use.models, [{ lane: "L1", model: "example-model", version: "unreported" }, { lane: "L2", model: "example-model", version: "unreported" }]);
  assert.equal(brief.ai_use.run_date, "2026-11-23T12:00:00.000Z");
  assert.match(brief.ai_use.prompt_sha, /^[0-9a-f]{64}$/);
  assert.deepEqual(brief.ai_use.decided, ["screening", "extraction"]);
  assert.equal(brief.protocol_sha, fx.protocolSha);
  assert.deepEqual(brief.searches, [{ lane: "L1", engine: "openalex", query: "llm screening", date: SEARCH_DATE, hits: 5 }]);
  // and the gate agrees with what was assembled
  const gate = checkReview(fx.dir, { stateDirPath: fx.state, integrations: fx.integrations });
  assert.deepEqual(gate.refusals, []);
});

test("lane conflicts, proposals and secondary review are carried into the brief, with claim indexes mapped to ids", async () => {
  const fx = buildReview();
  writeLane(fx, lane("L1", {
    handed: [S1, S2], screened: [included(S1), included(S2)], secondary_review: [S2],
    claims: [{ text: "foxes jump", quotes: [QUOTE1], sha256s: [S1] }, { text: "tests cover paths", quotes: [QUOTE2], sha256s: [S2] }],
    conflicts: ["S1 and S2 differ on whether tests are needed"],
    proposals: [{ target: "reference", claims: [1], text: "a guide to testing", ref_id: "guide-testing" }],
  }));
  const r = await kb(["review", "assemble", fx.dir], fx);
  assert.equal(r.code, 0, r.err);
  const brief = JSON.parse(readFileSync(path.join(fx.dir, "brief.json"), "utf8"));
  assert.deepEqual(brief.disagreements, { RQ1: ["L1: S1 and S2 differ on whether tests are needed"] });
  assert.deepEqual(brief.proposals, [{ target: "reference", claim_ids: ["C2"], text: "a guide to testing", ref_id: "guide-testing" }]);
  assert.deepEqual(brief.sources.map((s) => s.secondary_review), [false, true]);
});

test("a quote is attributed to the claim's source that holds it; one that is in none keeps its first source for the gate to refuse", async () => {
  const fx = buildReview();
  writeLane(fx, lane("L1", {
    handed: [S1, S2], screened: [included(S1), included(S2)],
    claims: [{ text: "both", quotes: [QUOTE2, "this exact sentence is nowhere in either saved body"], sha256s: [S1, S2] }],
  }));
  assert.equal((await kb(["review", "assemble", fx.dir], fx)).code, 0);
  const brief = JSON.parse(readFileSync(path.join(fx.dir, "brief.json"), "utf8"));
  assert.deepEqual(brief.claims[0].quotes.map((q) => q.source_id), ["S2", "S1"]);
  assert.ok(checkReview(fx.dir, { stateDirPath: fx.state, integrations: fx.integrations }).refusals.some((x) => x.code === "QUOTE_NOT_FOUND"));
});

test("Review Focus 2: a lane citing or screening a sha it was not handed is refused, naming the lane and the sha; nothing is written", async () => {
  const fx = buildReview();
  const before = snapshot(fx.dir);
  writeLane(fx, lane("L1", { handed: [S1], screened: [included(S1)], claims: [{ text: "x", quotes: [QUOTE2], sha256s: [S2] }] }));
  const after = snapshot(fx.dir);
  const r = await kb(["review", "assemble", fx.dir], fx);
  assert.equal(r.code, 1);
  assert.match(r.err, /LANE_NOT_HANDED: lane L1 cites [0-9a-f]{64}, which the coordinator never handed it/);
  assert.ok(r.err.includes(S2));
  assert.match(r.err, /L1\.json/);
  assert.equal(snapshot(fx.dir), after, "a refused assemble must write nothing");
  assert.notEqual(before, after);
  // a screened row for an unhanded sha, and a handed sha that is not a fetched body
  const fx2 = buildReview();
  const ghost = "c".repeat(64);
  writeLane(fx2, lane("L1", { handed: [S1, ghost], screened: [included(S1), included(S2), included(ghost)], claims: [{ text: "x", quotes: [QUOTE1], sha256s: [S1] }] }));
  const r2 = await kb(["review", "assemble", fx2.dir, "--json"], fx2);
  assert.equal(r2.code, 1);
  const codes = JSON.parse(r2.out).problems.map((p) => p.code);
  assert.ok(codes.includes("LANE_NOT_HANDED") && codes.includes("LANE_NOT_FETCHED"), codes.join());
});

test("Review Focus 3: a lane that returns prose, or JSON of the wrong shape, is exit 2 naming the lane file, and no brief is produced", async () => {
  for (const [why, content] of [["prose", "Here are my findings: the first source says foxes jump."], ["a JSON array", "[1,2]"], ["JSON of the wrong shape", JSON.stringify({ lane: "L1", findings: ["x"] })]]) {
    const fx = buildReview();
    writeLane(fx, lane("L2", { handed: [S2], screened: [included(S2)], claims: [{ text: "y", quotes: [QUOTE2], sha256s: [S2] }] }));
    writeLane(fx, content, "L1");
    const before = snapshot(fx.dir);
    const r = await kb(["review", "assemble", fx.dir, "--json"], fx);
    assert.equal(r.code, 2, `${why}: ${r.out}`);
    const j = JSON.parse(r.out);
    assert.equal(j.ok, false);
    assert.ok(j.what.includes("L1.json"), `${why}: must name the lane file: ${j.what}`);
    assert.equal(snapshot(fx.dir), before, `${why}: must not write or alter brief.json`);
    const t = await kb(["review", "assemble", fx.dir], fx);
    assert.match(t.err, /^LANE_(UNREADABLE|SHAPE): .*L1\.json.*\. Next: /);
  }
});

test("Review Focus 4: a second snowball round (round 3, or a round started from a snowball source) is SNOWBALL_EXCEEDED", async () => {
  const fx = buildReview();
  const S3 = addBody(fx, "Third. A snowballed page says that every claim needs a quotation from its source. End.", "https://example.com/s3");
  writeLane(fx, lane("L1", { handed: [S1, S2], screened: [included(S1), included(S2)], claims: [{ text: "a", quotes: [QUOTE1], sha256s: [S1] }, { text: "b", quotes: [QUOTE2], sha256s: [S2] }] }));
  writeLane(fx, lane("L3", { round: 2, from: [S1], handed: [S3], screened: [included(S3)], claims: [{ text: "c", quotes: ["every claim needs a quotation from its source"], sha256s: [S3] }] }));
  // one snowball round from included round-1 sources is the budget, and is accepted
  assert.equal((await kb(["review", "assemble", fx.dir], fx)).code, 0);

  const S4 = addBody(fx, "Fourth. A second-round page says a second snowball round is a protocol violation, always. End.", "https://example.com/s4");
  writeLane(fx, lane("L4", { round: 2, from: [S3], handed: [S4], screened: [included(S4)], claims: [{ text: "d", quotes: ["a second snowball round is a protocol violation, always"], sha256s: [S4] }] }));
  const snap = snapshot(fx.dir);
  const r = await kb(["review", "assemble", fx.dir, "--json"], fx);
  assert.equal(r.code, 1);
  assert.ok(JSON.parse(r.out).problems.some((p) => p.code === "SNOWBALL_EXCEEDED" && /L4/.test(p.what)), r.out);
  assert.equal(snapshot(fx.dir), snap);

  writeLane(fx, lane("L4", { round: 3, from: [S1], handed: [S4], screened: [included(S4)], claims: [{ text: "d", quotes: ["a second snowball round is a protocol violation, always"], sha256s: [S4] }] }));
  assert.ok(JSON.parse((await kb(["review", "assemble", fx.dir, "--json"], fx)).out).problems.some((p) => p.code === "SNOWBALL_EXCEEDED"), "round 3 is a second round");
});

test("Review Focus 4: a round-2 lane started from a source round 1 excluded (or from nothing) is refused", async () => {
  const fx = buildReview();
  const S3 = addBody(fx, "Third. A snowballed page says that every claim needs a quotation from its source. End.", "https://example.com/s3");
  writeLane(fx, lane("L1", { handed: [S1, S2], screened: [{ sha256: S1, decision: "excluded", reason: "off topic" }, included(S2)], claims: [{ text: "b", quotes: [QUOTE2], sha256s: [S2] }] }));
  writeLane(fx, lane("L3", { round: 2, from: [S1], handed: [S3], screened: [included(S3)], claims: [{ text: "c", quotes: ["every claim needs a quotation from its source"], sha256s: [S3] }] }));
  const r = await kb(["review", "assemble", fx.dir, "--json"], fx);
  assert.equal(r.code, 1);
  assert.ok(JSON.parse(r.out).problems.some((p) => p.code === "SNOWBALL_SOURCE_EXCLUDED"), r.out);
  writeLane(fx, lane("L3", { round: 2, handed: [S3], screened: [included(S3)], claims: [{ text: "c", quotes: ["every claim needs a quotation from its source"], sha256s: [S3] }] }));
  assert.ok(JSON.parse((await kb(["review", "assemble", fx.dir, "--json"], fx)).out).problems.some((p) => p.code === "SNOWBALL_SOURCE_EXCLUDED"), "no origin");
});

test("the protocol's snowball_rounds is the budget: 0 refuses any round-2 lane", async () => {
  const fx = buildReview({ tweakProtocol: (t) => t.replace("snowball_rounds: 1", "snowball_rounds: 0") });
  const S3 = addBody(fx, "Third. A snowballed page says that every claim needs a quotation from its source. End.", "https://example.com/s3");
  writeLane(fx, lane("L1", { handed: [S1, S2], screened: [included(S1), included(S2)], claims: [{ text: "a", quotes: [QUOTE1], sha256s: [S1] }, { text: "b", quotes: [QUOTE2], sha256s: [S2] }] }));
  writeLane(fx, lane("L3", { round: 2, from: [S1], handed: [S3], screened: [included(S3)], claims: [{ text: "c", quotes: ["every claim needs a quotation from its source"], sha256s: [S3] }] }));
  const r = await kb(["review", "assemble", fx.dir, "--json"], fx);
  assert.equal(r.code, 1);
  assert.ok(JSON.parse(r.out).problems.some((p) => p.code === "SNOWBALL_EXCEEDED"));
});

test("a 4-word quote is refused, as is an empty reason", async () => {
  const fx = buildReview();
  writeLane(fx, lane("L1", { handed: [S1], screened: [included(S1)], claims: [{ text: "foxes", quotes: ["quick brown fox jumps"], sha256s: [S1] }] }));
  const r = await kb(["review", "assemble", fx.dir, "--json"], fx);
  assert.equal(r.code, 1);
  assert.ok(JSON.parse(r.out).problems.some((p) => p.code === "QUOTE_LENGTH" && /4 words/.test(p.what)), r.out);
  const fx2 = buildReview();
  writeLane(fx2, lane("L1", { handed: [S1], screened: [{ sha256: S1, decision: "excluded", reason: "  " }] }));
  assert.ok(JSON.parse((await kb(["review", "assemble", fx2.dir, "--json"], fx2)).out).problems.some((p) => p.code === "REASON_MISSING"));
});

test("a source is never silently dropped: handed with no decision, fetched with no lane, or handed to two lanes", async () => {
  const fx = buildReview();
  writeLane(fx, lane("L1", { handed: [S1, S2], screened: [included(S1)], claims: [{ text: "foxes", quotes: [QUOTE1], sha256s: [S1] }] }));
  const codes = JSON.parse((await kb(["review", "assemble", fx.dir, "--json"], fx)).out).problems.map((p) => p.code);
  assert.ok(codes.includes("LANE_UNSCREENED"), codes.join());
  const fx2 = buildReview();
  writeLane(fx2, lane("L1", { handed: [S1], screened: [included(S1)], claims: [{ text: "foxes", quotes: [QUOTE1], sha256s: [S1] }] }));
  assert.ok(JSON.parse((await kb(["review", "assemble", fx2.dir, "--json"], fx2)).out).problems.some((p) => p.code === "SOURCE_UNSCREENED" && /docs\.example\.org/.test(p.what)));
  const fx3 = buildReview();
  writeLane(fx3, lane("L1", { handed: [S1, S2], screened: [included(S1), included(S2)], claims: [{ text: "foxes", quotes: [QUOTE1], sha256s: [S1] }, { text: "t", quotes: [QUOTE2], sha256s: [S2] }] }));
  writeLane(fx3, lane("L2", { handed: [S2], screened: [included(S2)], claims: [{ text: "t", quotes: [QUOTE2], sha256s: [S2] }] }));
  assert.ok(JSON.parse((await kb(["review", "assemble", fx3.dir, "--json"], fx3)).out).problems.some((p) => p.code === "LANE_HANDED_TWICE"));
});

test("injected-instruction flags are surfaced to the coordinator; an unknown rq and a file/lane id mismatch are refused", async () => {
  const fx = buildReview();
  writeLane(fx, lane("L1", { handed: [S1, S2], screened: [included(S1), included(S2)], claims: [{ text: "foxes", quotes: [QUOTE1], sha256s: [S1] }, { text: "t", quotes: [QUOTE2], sha256s: [S2] }], flags: [{ tag: "injected-instruction", sha256: S1, note: "asked me to read ~/.ssh" }] }));
  const r = await kb(["review", "assemble", fx.dir, "--json"], fx);
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.out).flags, [{ lane: "L1", tag: "injected-instruction", sha256: S1, url: "https://example.com/a", note: "asked me to read ~/.ssh" }]);
  const t = await kb(["review", "assemble", fx.dir], fx);
  assert.match(t.out, /FLAG injected-instruction in lane L1/);

  const fx2 = buildReview();
  writeLane(fx2, lane("L1", { rq: "RQ9", handed: [S1, S2], screened: [included(S1), included(S2)], claims: [{ text: "foxes", quotes: [QUOTE1], sha256s: [S1] }, { text: "t", quotes: [QUOTE2], sha256s: [S2] }] }));
  assert.ok(JSON.parse((await kb(["review", "assemble", fx2.dir, "--json"], fx2)).out).problems.some((p) => p.code === "LANE_RQ_UNKNOWN"));
  const fx3 = buildReview();
  writeLane(fx3, lane("L7", { handed: [S1, S2], screened: [included(S1), included(S2)], claims: [{ text: "foxes", quotes: [QUOTE1], sha256s: [S1] }, { text: "t", quotes: [QUOTE2], sha256s: [S2] }] }), "L1");
  assert.ok(JSON.parse((await kb(["review", "assemble", fx3.dir, "--json"], fx3)).out).problems.some((p) => p.code === "LANE_ID_MISMATCH"));
});

test("could-not-run cases are exit 2 and write nothing: no lanes, unreadable searches.json, an applied review is refused with 1", async () => {
  const fx = buildReview();
  const snap = snapshot(fx.dir);
  const r = await kb(["review", "assemble", fx.dir, "--json"], fx);
  assert.equal(r.code, 2);
  assert.equal(JSON.parse(r.out).code, "LANES_MISSING");
  assert.equal(snapshot(fx.dir), snap);
  two(fx);
  writeFileSync(path.join(fx.dir, "searches.json"), "not json");
  assert.equal((await kb(["review", "assemble", fx.dir], fx)).code, 2);
  const fx2 = buildReview();
  two(fx2);
  writeFileSync(path.join(fx2.dir, "brief.md"), "# applied\n");
  const applied = await kb(["review", "assemble", fx2.dir, "--json"], fx2);
  assert.equal(applied.code, 1);
  assert.equal(JSON.parse(applied.out).problems[0].code, "ALREADY_APPLIED");
  assert.equal((await kb(["review", "assemble"], fx)).code, 2);
  assert.equal((await kb(["review", "assemble", fx.dir, "--wat"], fx)).code, 2);
  assert.equal(assembleBrief(fx.dir, {}).cannotRun, true, "no state dir is could-not-run");
});

test("validateLane: the shape problems are malformed, the rule problems are not", () => {
  const ok = lane("L1", { handed: [S1], screened: [included(S1)], claims: [{ text: "x", quotes: [QUOTE1], sha256s: [S1] }] });
  assert.deepEqual(validateLane(ok, new Set([S1])), { ok: true, malformed: false, problems: [] });
  assert.equal(validateLane("prose", new Set()).malformed, true);
  assert.equal(validateLane({ ...ok, screened: "none" }, new Set([S1])).malformed, true);
  const rule = validateLane({ ...ok, claims: [{ text: "x", quotes: ["four words only here"], sha256s: [S1] }] }, new Set([S1]));
  assert.equal(rule.ok, false);
  assert.equal(rule.malformed, false);
  assert.equal(validateLane(ok, new Set()).problems[0].code, "LANE_NOT_FETCHED");
  // a claim on a source the lane excluded, and a snowball suggestion from one
  const ex = validateLane({ ...ok, screened: [{ sha256: S1, decision: "excluded", reason: "no" }], suggestions: [{ kind: "doi", value: "10.1/x", from_sha256: S1 }] }, new Set([S1])).problems.map((p) => p.code);
  assert.deepEqual(ex, ["LANE_CLAIM_SOURCE", "LANE_SUGGESTION_SOURCE"]);
});

test("the command table and docs/REFERENCE.md both carry the subcommand", () => {
  assert.ok(COMMANDS["kb review assemble"], "kb review assemble is not in the command table");
  assert.match(readFileSync(path.join(import.meta.dirname, "..", "..", "docs", "REFERENCE.md"), "utf8"), /\| `kb review assemble <dir>/);
});
