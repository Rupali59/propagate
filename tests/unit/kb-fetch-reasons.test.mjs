// #367: every record that is not ok says why, from a closed list, and the review counts by that reason.
// @size medium — starts a local server
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { kbCmd } from "../../cli/kb.mjs";
import { notRetrievedByReason, checkReview } from "../../lib/kb/review/check.mjs";
import { parseProtocol } from "../../lib/kb/review/protocol.mjs";
import { renderBrief } from "../../lib/kb/review/render.mjs";
import { buildReview } from "../fixtures/kb-review/build.mjs";

const page = (body) => `<!doctype html><html><head><title>t</title></head><body><p>${body}</p></body></html>`;
let server;
let base;
let alt;

before(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const send = (code, type, body, extra = {}) => { res.writeHead(code, { "content-type": type, ...extra }); res.end(body); };
    switch (u.pathname) {
      case "/robots.txt": return send(200, "text/plain", "User-agent: *\nDisallow: /private\n");
      case "/to-login": return send(302, "text/plain", "", { location: "/login?next=/x" });
      case "/login": return send(200, "text/html", `<html><body><form><input type="password"></form></body></html>`);
      case "/to-other-host": return send(302, "text/plain", "", { location: `${alt}/landing` });
      case "/landing": return send(200, "text/html", page("a normal article on another host"));
      case "/private": return send(200, "text/html", page("private"));
      case "/forbidden": return send(403, "text/plain", "no");
      case "/gone": return send(404, "text/plain", "nope");
      case "/stall": res.writeHead(200, { "content-type": "text/html" }); return res.write("<html><body>partial");
      case "/image": return send(200, "image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      case "/wayback/available": return send(200, "application/json", JSON.stringify({ archived_snapshots: {} }));
      default: return send(404, "text/plain", "not found");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  base = `http://127.0.0.1:${port}`;
  alt = `http://localhost:${port}`;
});
after(() => { server.closeAllConnections?.(); return new Promise((r) => server.close(r)); });

async function fetchOne(url) {
  const out = [];
  await kbCmd(["fetch", path.join(mkdtempSync(path.join(os.tmpdir(), "kbr-")), "review"), url, "--json"], {
    io: { log: (s) => out.push(String(s)), error: () => {} },
    stateDirPath: mkdtempSync(path.join(os.tmpdir(), "kbr-state-")), contact: null, timeoutMs: 400,
    endpoints: { wayback: `${base}/wayback/available` },
  });
  return JSON.parse(out.join("\n")).records[0];
}

for (const [name, path_, reason, detail] of [
  ["a login page", "/to-login", "login_page", /login or consent path/],
  ["a landing on another host", "/to-other-host", "cross_host", /another host/],
  ["a robots.txt disallow", "/private", "robots", /robots\.txt/],
  ["a 403", "/forbidden", "http_403", /403/],
  ["a stalled body", "/stall", "timeout", /./],
  ["a content type this reader cannot use", "/image", "unexpected", /unsupported content type/],
]) {
  test(`${name} is not_retrieved with reason ${reason} and a detail`, async () => {
    const rec = await fetchOne(`${base}${path_}`);
    assert.equal(rec.classification, "not_retrieved");
    assert.equal(rec.reason, reason);
    assert.match(rec.detail, detail);
    assert.equal(rec.sha256, null);
  });
}

test("a 404 that is stale or hallucinated still carries http_404", async () => {
  const rec = await fetchOne(`${base}/gone`);
  assert.equal(rec.classification, "hallucinated");
  assert.equal(rec.reason, "http_404");
  assert.ok(rec.detail.length > 0);
});

test("the existing note field is kept, equal to detail, for older readers", async () => {
  const rec = await fetchOne(`${base}/forbidden`);
  assert.equal(rec.note, rec.detail);
});

test("notRetrievedByReason counts the same representatives as the not_retrieved count, with unrecorded kept", () => {
  const rows = [
    { url: "https://a.example/1", decision: "not_retrieved", retrieval_reason: "http_403" },
    { url: "https://a.example/2", decision: "not_retrieved", retrieval_reason: "http_403" },
    { url: "https://a.example/3", decision: "not_retrieved", retrieval_reason: "timeout" },
    { url: "https://a.example/4", decision: "not_retrieved" },
    { url: "https://a.example/5", decision: "included" },
    { url: "https://a.example/1?utm_source=x", decision: "duplicate", retrieval_reason: "http_403" },
  ];
  assert.deepEqual(notRetrievedByReason(rows), { http_403: 2, timeout: 1, unrecorded: 1 });
});

test("kb review check breaks not_retrieved down by reason, and brief.md states it", () => {
  const fx = buildReview({ agreement: "reliable" });
  const check = checkReview(fx.dir, { stateDirPath: fx.state, integrations: fx.integrations });
  assert.deepEqual(check.derived.not_retrieved_by_reason, { http_404: 1 });
  assert.equal(Object.values(check.derived.not_retrieved_by_reason).reduce((a, b) => a + b, 0), check.counts.not_retrieved);
  const protocol = parseProtocol(readFileSync(path.join(fx.dir, "protocol.md"), "utf8")).fields;
  const agreement = JSON.parse(readFileSync(path.join(fx.dir, "agreement.json"), "utf8"));
  const md = renderBrief(protocol, fx.brief, check, agreement);
  assert.match(md, /Not retrieved, by reason:\n\n- http_404: 1$/m);
});
