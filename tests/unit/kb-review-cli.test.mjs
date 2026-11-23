import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { kbCmd } from "../../cli/kb.mjs";
import { drawSample } from "../../lib/kb/review/agree.mjs";
import { buildReview } from "../fixtures/kb-review/build.mjs";

async function kb(argv, fx, inject = {}) {
  const out = [];
  const err = [];
  const io = { log: (...a) => out.push(a.join(" ")), error: (...a) => err.push(a.join(" ")) };
  const code = await kbCmd(argv, { io, integrations: fx.integrations, workspaces: [], stateDirPath: fx.state, now: () => Date.parse("2026-11-23T12:00:00Z"), ...inject });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

test("check: exit 0 on the valid fixture, 1 on a refusal, JSON carries the refusals", async () => {
  const ok = buildReview();
  assert.equal((await kb(["review", "check", ok.dir], ok)).code, 0);
  const bad = buildReview({ approved: false });
  const r = await kb(["review", "check", bad.dir, "--json"], bad);
  assert.equal(r.code, 1);
  assert.equal(JSON.parse(r.out).refusals[0].code, "PROTOCOL_UNAPPROVED");
  const text = await kb(["review", "check", bad.dir], bad);
  assert.match(text.out, /REFUSED PROTOCOL_UNAPPROVED/);
});

test("check: not configured is exit 2 with {ok:false, code, what, next} under --json", async () => {
  const fx = buildReview();
  const r = await kb(["review", "check", fx.dir, "--json"], { ...fx, integrations: { ...fx.integrations, kbTiersFile: null } });
  assert.equal(r.code, 2);
  const j = JSON.parse(r.out);
  assert.equal(j.ok, false);
  assert.equal(j.code, "KB_TIERS_NOT_CONFIGURED");
  assert.ok(j.what && j.next);
  const t = await kb(["review", "check", fx.dir], { ...fx, integrations: { ...fx.integrations, kbTiersFile: null } });
  assert.match(t.err, /^KB_TIERS_NOT_CONFIGURED: .+\. Next: /);
});

test("check: a missing directory and a bad subcommand are exit 2", async () => {
  const fx = buildReview();
  assert.equal((await kb(["review", "check", path.join(fx.root, "nope")], fx)).code, 2);
  assert.equal((await kb(["review", "frobnicate"], fx)).code, 2);
  assert.equal((await kb(["review"], fx)).code, 2);
  assert.equal((await kb(["review", "check", fx.dir, "--wat"], fx)).code, 2);
});

test("check --refetch: drift is a warning and never a refusal", async () => {
  const fx = buildReview();
  const refetch = async (urls) => urls.map((url) => ({ url, classification: "ok", sha256: "f".repeat(64) }));
  const r = await kb(["review", "check", fx.dir, "--refetch", "--json"], fx, { refetch });
  assert.equal(r.code, 0);
  assert.ok(JSON.parse(r.out).warnings.some((w) => w.code === "SOURCE_DRIFTED"));
});

test("new: creates the protocol (0), refuses to overwrite (1), and is 2 when not configured or under-specified", async () => {
  const fx = buildReview();
  const args = ["review", "new", "fresh-review", "--decision", "pick one", "--decider", "owner"];
  const r = await kb(args, fx);
  assert.equal(r.code, 0);
  const file = path.join(fx.reviews, "2026-11-23-fresh-review", "protocol.md");
  assert.ok(existsSync(file));
  const again = await kb([...args, "--json"], fx);
  assert.equal(again.code, 1);
  assert.equal(JSON.parse(again.out).code, "KB_REVIEW_EXISTS");
  assert.equal((await kb(args, { ...fx, integrations: {} })).code, 2);
  assert.equal((await kb(["review", "new", "x"], fx)).code, 2, "no --decision or --decider");
  assert.equal((await kb(["review", "new", "Bad Slug", "--decision", "d", "--decider", "p"], fx)).code, 2);
});

test("agree: prints the sample (0), records only with --apply (0), then scores (0 reliable, 1 unreliable)", async () => {
  const fx = buildReview();
  const sample = await kb(["review", "agree", fx.dir, "--json"], fx);
  assert.equal(sample.code, 0);
  assert.ok(!sample.out.includes('"decision"'), "the sample is blind");
  const s = drawSample(fx.brief);
  const agent = new Map(fx.brief.screened.map((x) => [x.url, x.decision === "included" ? "include" : "exclude"]));
  const answers = (flip) => ({
    screening: Object.fromEntries(s.screening.map((x) => [x.url, flip ? (agent.get(x.url) === "include" ? "exclude" : "include") : agent.get(x.url)])),
    support: Object.fromEntries(s.support.map((x) => [x.claim_id, "supports"])),
  });
  const f = path.join(mkdtempSync(path.join(os.tmpdir(), "kb-ans-")), "a.json");
  writeFileSync(f, JSON.stringify(answers(false)));
  assert.equal((await kb(["review", "agree", fx.dir, "--record", f], fx)).code, 0);
  assert.equal(existsSync(path.join(fx.dir, "agreement.json")), false, "dry run writes nothing");
  assert.equal((await kb(["review", "agree", fx.dir, "--record", f, "--apply"], fx)).code, 0);
  assert.equal((await kb(["review", "agree", fx.dir], fx)).code, 0);
  const bad = buildReview({ agreement: "unreliable" });
  assert.equal((await kb(["review", "agree", bad.dir], bad)).code, 1);
  writeFileSync(f, JSON.stringify({ screening: {}, support: {} }));
  const inc = await kb(["review", "agree", fx.dir, "--record", f, "--apply", "--json"], buildReview());
  assert.equal(inc.code, 1);
});

test("apply: exit 0 and the three files on the valid fixture, 1 with nothing written on a refusal", async () => {
  const fx = buildReview({ agreement: "reliable" });
  const r = await kb(["review", "apply", fx.dir], fx);
  assert.equal(r.code, 0, r.err);
  for (const f of ["brief.md", "candidates.md"]) assert.ok(existsSync(path.join(fx.dir, f)), f);
  assert.match(readFileSync(fx.refs, "utf8"), /example-a:/);
  const bad = buildReview({ agreement: "reliable", approved: false });
  const rb = await kb(["review", "apply", bad.dir, "--json"], bad);
  assert.equal(rb.code, 1);
  assert.equal(existsSync(path.join(bad.dir, "brief.md")), false);
  assert.equal(JSON.parse(rb.out).ok, false);
});
