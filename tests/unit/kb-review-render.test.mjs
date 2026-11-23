import { test } from "node:test";
import assert from "node:assert/strict";
import { checkReview } from "../../lib/kb/review/check.mjs";
import { parseProtocol } from "../../lib/kb/review/protocol.mjs";
import { renderBrief, renderCandidates } from "../../lib/kb/review/render.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildReview, QUOTE1 } from "../fixtures/kb-review/build.mjs";

function rendered(o = { agreement: "reliable" }) {
  const fx = buildReview(o);
  const check = checkReview(fx.dir, { stateDirPath: fx.state, integrations: fx.integrations });
  const protocol = parseProtocol(readFileSync(path.join(fx.dir, "protocol.md"), "utf8")).fields;
  const agreement = o.agreement ? JSON.parse(readFileSync(path.join(fx.dir, "agreement.json"), "utf8")) : null;
  return { fx, check, brief: renderBrief(protocol, fx.brief, check, agreement), cand: renderCandidates(fx.brief, check) };
}

test("brief.md has the RQ heading, a Limitations section with a line per restriction, and the counts", () => {
  const { check, brief } = rendered();
  assert.match(brief, /^## RQ1: which method\?$/m);
  const lim = brief.split("## Limitations")[1].split("\n## ")[0];
  for (const re of [/sources in en were searched/, /No date window/, /tier 1, 2, 3 sources/, /15 tool calls/, /1 round/, /rapid-multivocal review/]) assert.match(lim, re);
  assert.equal(lim.split("\n").filter((l) => l.startsWith("- ")).length, 7, "5 restrictions + type + quote_verified");
  for (const [k, label] of [["identified", "Identified"], ["duplicates", "Duplicates removed"], ["screened", "Screened"], ["excluded", "Excluded"], ["not_retrieved", "Not retrieved"], ["included", "Included"]]) {
    assert.match(brief, new RegExp(`- ${label}: ${check.counts[k]}$`, "m"));
  }
});

test("each claim shows its quote linked to its source with a tier, and the literal quote_verified", () => {
  const { brief } = rendered();
  assert.ok(brief.includes("quote_verified"));
  assert.ok(brief.includes(`"${QUOTE1}" ([https://example.com/a](https://example.com/a), tier 2: tier table)`));
  assert.match(brief, /tier 1: official docs/);
});

test("no line says verified without the quote_ prefix", () => {
  const { brief, cand } = rendered();
  for (const text of [brief, cand]) for (const line of text.split("\n")) {
    for (const m of line.matchAll(/verified/gi)) assert.equal(line.slice(m.index - 6, m.index), "quote_", line);
  }
});

test("the agreement and AI-use disclosure are present; an unsampled review says so", () => {
  const { brief } = rendered();
  assert.match(brief, /## Screening agreement[\s\S]*Verdict: reliable/);
  assert.match(brief, /## AI use[\s\S]*example-model 1 \(lane L1\)/);
  assert.match(rendered({}).brief, /## Screening agreement\n\nNot sampled\./);
});

test("candidates.md carries the not-adopted heading and each standard-row claim, quote and tier-1 basis", () => {
  const { cand } = rendered();
  assert.match(cand, /Not adopted: a candidate becomes a row only through a PR the maintainer merges/);
  assert.match(cand, /Tier-1 basis: https:\/\/docs\.example\.org\/guide \(official docs\)/);
  assert.match(cand, /C2: tests cover paths/);
  assert.ok(!cand.includes("a page about foxes"), "reference proposals are not candidates");
});
