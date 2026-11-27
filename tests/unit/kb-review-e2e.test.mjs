// A literature review end to end on fixtures (#327): the real `kb review` commands, `kb discover` and `kb fetch`, in a
// temp hub (a git repo) with a temp state dir. Only two things are stubbed: the scholarly API (recorded openalex
// fixture, no network) and the page host (a local HTTP server). The researchers are stood in for by two hand-written
// lane files. Nothing here tunes the test to the code: a failure is a finding in an earlier task.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { kbCmd } from "../../cli/kb.mjs";
import { drawSample } from "../../lib/kb/review/agree.mjs";
import { snapshot } from "../fixtures/kb-review/build.mjs";

const NOW = Date.parse("2026-11-23T12:00:00Z");
const OPENALEX = readFileSync(path.join(import.meta.dirname, "..", "fixtures", "discover", "openalex.json"), "utf8");
const SENTENCE_A = "Automated screening agrees with human reviewers on most clear cases";
const SENTENCE_B = "A second reviewer should sample the agent decisions before any adoption";
const QUOTE_A = "screening agrees with human reviewers on most clear cases";
const QUOTE_B = "second reviewer should sample the agent decisions before any adoption";
const REFS_BEFORE = "schema_version: 1\nreferences:\n  site-1:\n    kind: doc\n    url: https://example.com/existing\n    what: an existing thing\n    why: a reason\n    applies_to: [node]\n    verdict: adopt\n    checked: 2026-11-01\n    added: 2026-11-01\n";

let server;
let base;
before(async () => {
  server = http.createServer((req, res) => {
    const page = (t) => `<!doctype html><html><head><title>t</title></head><body><p>${t}</p></body></html>`;
    const send = (code, body) => { res.writeHead(code, { "content-type": "text/html; charset=utf-8" }); res.end(body); };
    if (req.url === "/robots.txt") return send(200, "User-agent: *\nDisallow:\n");
    if (req.url === "/a") return send(200, page(`Intro. ${SENTENCE_A}. More text.`));
    if (req.url === "/c") return send(200, page("An unrelated note about gardening, with no screening content at all."));
    if (req.url === "/b") return send(200, page(`Guide. ${SENTENCE_B}. End.`));
    return send(403, "no");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));

const git = (cwd, args, date) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });

async function kb(argv, ctx, extra = {}) {
  const out = [];
  const err = [];
  const io = { log: (...a) => out.push(a.join(" ")), error: (...a) => err.push(a.join(" ")) };
  const code = await kbCmd(argv, { io, integrations: ctx.integrations, workspaces: [], stateDirPath: ctx.state, now: () => NOW, env: {}, sleep: async () => {}, contact: null, timeoutMs: 8000, ...extra });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

/** Steps 1-5: new, approve and commit, discover, fetch. Returns the context the later steps use. */
async function setUp() {
  const root = mkdtempSync(path.join(os.tmpdir(), "kb-e2e-"));
  const hub = path.join(root, "hub");
  const state = path.join(root, "state");
  mkdirSync(hub, { recursive: true });
  mkdirSync(path.join(state, "kb", "fetched"), { recursive: true });
  git(hub, ["init", "-q"], "2026-11-22T09:00:00Z");
  git(hub, ["config", "user.email", "t@example.com"], "2026-11-22T09:00:00Z");
  git(hub, ["config", "user.name", "t"], "2026-11-22T09:00:00Z");
  const refs = path.join(root, "kb-references.yml");
  writeFileSync(refs, REFS_BEFORE);
  const tiers = path.join(root, "kb-tiers.yml");
  writeFileSync(tiers, "schema_version: 1\ndomains:\n  arxiv.org: 2\nofficial_docs: []\n");
  const integrations = { kbReviewsDir: path.join(hub, "kb", "reviews"), kbReferencesFile: refs, kbTiersFile: tiers };
  const ctx = { root, hub, state, refs, integrations };

  // 1. new
  assert.equal((await kb(["review", "new", "screening", "--decision", "pick a screening method", "--decider", "owner"], ctx)).code, 0);
  const dir = path.join(integrations.kbReviewsDir, "2026-11-23-screening");
  ctx.dir = dir;
  // 2. approve and commit the protocol, the day before the first search
  const proto = readFileSync(path.join(dir, "protocol.md"), "utf8")
    .replace("questions: []", 'questions: [{id: RQ1, text: "can an agent screen sources reliably?"}]')
    .replace("inclusion: []", 'inclusion: ["I1: an evaluation of automated screening or a guide to sampling its decisions"]')
    .replace("exclusion: []", 'exclusion: ["E1: off topic"]')
    .replace("approved: {by: null, date: null}", "approved: {by: owner, date: 2026-11-22}");
  writeFileSync(path.join(dir, "protocol.md"), proto);
  git(hub, ["add", "."], "2026-11-22T10:00:00Z");
  git(hub, ["commit", "-q", "-m", "protocol"], "2026-11-22T10:00:00Z");
  // 3. discover, through the recorded openalex fixture
  const fetchStub = async () => ({ status: 200, text: async () => OPENALEX, headers: { get: () => null } });
  assert.equal((await kb(["discover", dir, "automated screening", "--engine", "openalex", "--lane", "L1"], ctx, { fetch: fetchStub })).code, 0);
  // 4. fetch, through the stub page host; the third URL is refused (403), which is counted, not hidden
  const f = await kb(["fetch", dir, `${base}/a`, `${base}/b`, `${base}/c`, `${base}/denied`, "--json"], ctx, { endpoints: { wayback: `${base}/wayback`, unpaywall: `${base}/unpaywall` } });
  assert.equal(f.code, 1, f.err || f.out);
  const records = JSON.parse(readFileSync(path.join(dir, "fetched.json"), "utf8")).records;
  ctx.shaA = records.find((r) => r.url === `${base}/a`).sha256;
  ctx.shaB = records.find((r) => r.url === `${base}/b`).sha256;
  ctx.shaC = records.find((r) => r.url === `${base}/c`).sha256;
  assert.equal(records.find((r) => r.url === `${base}/denied`).classification, "not_retrieved");
  return ctx;
}

const lane = (id, o) => ({ lane: id, model: "example-model", round: 1, rq: "RQ1", gaps: [], suggestions: [], ...o });
const writeLanes = (ctx, quoteA = QUOTE_A) => {
  mkdirSync(path.join(ctx.dir, "lanes"), { recursive: true });
  const put = (l) => writeFileSync(path.join(ctx.dir, "lanes", `${l.lane}.json`), JSON.stringify(l, null, 2));
  put(lane("L1", {
    handed: [ctx.shaA], screened: [{ sha256: ctx.shaA, decision: "included", reason: "meets inclusion: an evaluation against human reviewers", identified_as: { title: "Agent screening against human reviewers", authors: ["A. Author"] } }],
    claims: [{ text: "agent screening matches humans on clear cases", quotes: [quoteA], sha256s: [ctx.shaA] }],
    proposals: [{ target: "reference", claims: [0], text: "a page on automated screening", ref_id: "screening-page" }],
  }));
  put(lane("L2", {
    handed: [ctx.shaB, ctx.shaC], screened: [{ sha256: ctx.shaB, decision: "included", reason: "meets inclusion: a guide to sampling agent decisions", identified_as: { title: "Sampling agent decisions: a guide" } }, { sha256: ctx.shaC, decision: "excluded", reason: "off topic: a note about gardening", identified_as: { title: "A note about gardening" } }],
    claims: [{ text: "agent decisions should be sampled by a second reviewer", quotes: [QUOTE_B], sha256s: [ctx.shaB] }],
  }));
};

test("the whole loop: new, approve, discover, fetch, assemble, check 0, agree, apply, and check 0 again", async () => {
  const ctx = await setUp();
  writeLanes(ctx);
  // 6. assemble
  const a = await kb(["review", "assemble", ctx.dir], ctx);
  assert.equal(a.code, 0, a.err || a.out);
  // 7. check passes on the assembled brief (the sample is not yet recorded: a warning, not a refusal)
  const c = await kb(["review", "check", ctx.dir, "--json"], ctx);
  assert.equal(c.code, 0, c.out);
  assert.deepEqual(JSON.parse(c.out).refusals, []);
  // 8. agree: the blind sample, then the recorded decisions, applied
  const brief = JSON.parse(readFileSync(path.join(ctx.dir, "brief.json"), "utf8"));
  const sample = drawSample(brief);
  const agent = new Map(brief.screened.map((x) => [x.url, x.decision === "included" ? "include" : "exclude"]));
  const decisions = path.join(ctx.root, "decisions.json");
  writeFileSync(decisions, JSON.stringify({ screening: Object.fromEntries(sample.screening.map((x) => [x.url, agent.get(x.url)])), support: Object.fromEntries(sample.support.map((x) => [x.claim_id, "supports"])) }));
  assert.equal((await kb(["review", "agree", ctx.dir], ctx)).code, 0);
  const rec = await kb(["review", "agree", ctx.dir, "--record", decisions, "--rater", "second reviewer", "--rater-kind", "human", "--apply"], ctx);
  assert.equal(rec.code, 0, rec.err || rec.out);
  assert.equal((await kb(["review", "agree", ctx.dir], ctx)).code, 0, "the recorded sample scores reliable");
  // 9. apply
  const ap = await kb(["review", "apply", ctx.dir], ctx);
  assert.equal(ap.code, 0, ap.err || ap.out);

  const refsAfter = readFileSync(ctx.refs, "utf8");
  assert.ok(refsAfter.startsWith(REFS_BEFORE), "existing entries are byte-unchanged");
  const parsed = YAML.parse(refsAfter);
  assert.deepEqual(Object.keys(parsed.references), ["site-1", "screening-page"], "kb-references.yml gained exactly the one proposed entry");
  assert.equal(parsed.references["screening-page"].verdict, "evaluate");
  assert.equal(parsed.references["screening-page"].url, `${base}/a`);

  const md = readFileSync(path.join(ctx.dir, "brief.md"), "utf8");
  assert.match(md, /## Limitations/);
  assert.match(md, /- Identified: 4\n- Duplicates removed: 0\n- Screened: 4\n- Excluded: 1\n- Not retrieved: 1\n- Included: 2/);

  const again = await kb(["review", "check", ctx.dir, "--json"], ctx);
  assert.equal(again.code, 0, again.out);
  assert.deepEqual(JSON.parse(again.out).refusals, [], "an applied review still passes its own gate");
  // an applied review is not re-assembled over its record
  assert.equal((await kb(["review", "assemble", ctx.dir], ctx)).code, 1);
});

test("a lane that quotes text its body does not hold: assemble passes it through, check refuses QUOTE_NOT_FOUND, apply writes nothing", async () => {
  const ctx = await setUp();
  writeLanes(ctx, "automated screening always beats every human reviewer everywhere");
  assert.equal((await kb(["review", "assemble", ctx.dir], ctx)).code, 0, "assemble never judges a quote: that is the gate's job");
  const c = await kb(["review", "check", ctx.dir, "--json"], ctx);
  assert.equal(c.code, 1);
  assert.ok(JSON.parse(c.out).refusals.some((r) => r.code === "QUOTE_NOT_FOUND"), c.out);

  const dirBefore = snapshot(ctx.dir);
  const refsBefore = readFileSync(ctx.refs, "utf8");
  // no sample is recorded here, so apply also reports SCREENING_UNSAMPLED; the assertion is that the quote is among the refusals
  const ap = await kb(["review", "apply", ctx.dir, "--json"], ctx);
  assert.equal(ap.code, 1);
  assert.ok(JSON.parse(ap.out).refusals.some((r) => r.code === "QUOTE_NOT_FOUND"));
  assert.equal(snapshot(ctx.dir), dirBefore, "apply wrote into the review directory");
  assert.equal(readFileSync(ctx.refs, "utf8"), refsBefore, "apply wrote to kb-references.yml");
});

test("the whole loop with a model second rater and no human answers: rater brief, record, disagreements, apply (#412)", async () => {
  const ctx = await setUp();
  writeLanes(ctx);
  assert.equal((await kb(["review", "assemble", ctx.dir], ctx)).code, 0);
  assert.equal((await kb(["review", "check", ctx.dir], ctx)).code, 0);
  const rb = await kb(["review", "agree", ctx.dir, "--rater-brief"], ctx);
  assert.equal(rb.code, 0, rb.err);
  const handed = JSON.parse(rb.out);
  assert.deepEqual(handed.criteria.inclusion.map((c) => c.id), ["I1"]);
  // the rater (stood in for here) reads each listed body and answers each criterion with a quote
  const body = (u) => readFileSync(u.body_path, "utf8");
  const answers = {};
  for (const it of handed.items) {
    const t = body(it);
    const quote = t.includes(SENTENCE_A) ? QUOTE_A : t.includes(SENTENCE_B) ? QUOTE_B : "An unrelated note about gardening, with no screening content at all";
    const off = quote.startsWith("An unrelated");
    answers[it.url] = { criteria: [{ id: "I1", met: !off, quote: off ? "" : quote, reason: "i1" }, { id: "E1", met: off, quote: off ? quote : "", reason: "e1" }], reason: off ? "off topic" : "on topic" };
  }
  const file = path.join(ctx.root, "rater-answers.json");
  writeFileSync(file, JSON.stringify({ model: "example-rater", screening: answers, support: Object.fromEntries(drawSample(JSON.parse(readFileSync(path.join(ctx.dir, "brief.json"), "utf8"))).support.map((s) => [s.claim_id, "supports"])) }));
  const rec = await kb(["review", "agree", ctx.dir, "--record", file, "--rater", "example-rater", "--rater-kind", "model-referenced", "--apply"], ctx);
  assert.equal(rec.code, 0, rec.err || rec.out);
  assert.equal((await kb(["review", "agree", ctx.dir], ctx)).code, 0, "the derived labels score reliable");
  const dis = await kb(["review", "agree", ctx.dir, "--disagreements"], ctx);
  assert.equal(dis.code, 0, dis.out + dis.err);
  assert.match(dis.out, /no disagreements: kb review apply/);
  const chk = JSON.parse((await kb(["review", "check", ctx.dir, "--json"], ctx)).out);
  assert.deepEqual(chk.refusals, [], "a model rater passes where the protocol says second reviewer: model");
  assert.equal((await kb(["review", "apply", ctx.dir], ctx)).code, 0);
});
