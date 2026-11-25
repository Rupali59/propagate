// #366: a body that is only a citation (or has almost no text) is not_retrieved, never ok, and the floor is on the record.
// @size medium — starts a local server
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { kbCmd } from "../../cli/kb.mjs";
import { citationOnly, MIN_TEXT_CHARS } from "../../lib/research/fetch.mjs";

const page = (body) => `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;
const CITATION = "Smith J, Jones K (2024) Screening studies with language models. Journal of Stub Research 12(3):45-67. doi:10.1000/stub";
const ABSTRACT = "We tested whether a language model can screen titles and abstracts for a systematic review as reliably as two human reviewers. "
  + "Across 400 records the model agreed with the reviewers on most inclusion decisions and missed few relevant studies. Full text is at doi:10.1000/real.";
const STUBS = {
  "/doi-citation": page(`<p>${CITATION}</p>`),
  "/doi-stub-short": page("<p>Abstract not available.</p>"),
  "/abstract": page(`<p>${ABSTRACT}</p>`),
};
let server;
let base;
before(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/robots.txt") { res.writeHead(404); return res.end(); }
    if (STUBS[u.pathname]) { res.writeHead(200, { "content-type": "text/html" }); return res.end(STUBS[u.pathname]); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));

async function fetchOne(p) {
  const out = [];
  await kbCmd(["fetch", path.join(mkdtempSync(path.join(os.tmpdir(), "kbc-")), "review"), `${base}${p}`, "--json"], {
    io: { log: (s) => out.push(String(s)), error: () => {} },
    stateDirPath: mkdtempSync(path.join(os.tmpdir(), "kbc-state-")), contact: null, timeoutMs: 2000,
  });
  return JSON.parse(out.join("\n")).records[0];
}

test("a DOI stub page holding only a citation is not_retrieved with reason citation_only, and nothing is stored", async () => {
  const rec = await fetchOne("/doi-citation");
  assert.equal(rec.classification, "not_retrieved");
  assert.equal(rec.reason, "citation_only");
  assert.equal(rec.sha256, null);
  assert.match(rec.detail, /bibliographic line/);
});

test("a stub page with almost no text is under the floor: not_retrieved, citation_only, and the floor is in the record", async () => {
  const rec = await fetchOne("/doi-stub-short");
  assert.equal(rec.classification, "not_retrieved");
  assert.equal(rec.reason, "citation_only");
  assert.equal(rec.floor_chars, MIN_TEXT_CHARS);
  assert.ok(rec.text_chars < rec.floor_chars, `${rec.text_chars} chars should be under the floor`);
  assert.match(rec.detail, /under the floor of 40/);
});

test("a short but real abstract page stays ok, even though it mentions its DOI, and the floor is in the record", async () => {
  const rec = await fetchOne("/abstract");
  assert.equal(rec.classification, "ok");
  assert.equal(rec.floor_chars, MIN_TEXT_CHARS);
  assert.ok(rec.text_chars >= rec.floor_chars);
  assert.match(rec.sha256, /^[0-9a-f]{64}$/);
});

test("citationOnly: floor edge, shape, and prose escape", () => {
  assert.equal(citationOnly("x".repeat(MIN_TEXT_CHARS - 1)).citationOnly, true);
  assert.equal(citationOnly("a plain sentence with no id at all, just forty or more characters here").citationOnly, false);
  assert.equal(citationOnly(CITATION).citationOnly, true);
  assert.equal(citationOnly(ABSTRACT).citationOnly, false);
  assert.equal(citationOnly(null).citationOnly, true, "no text at all is nothing to read");
});
