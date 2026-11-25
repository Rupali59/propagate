// Regression: ISSUE-004 — a server that sends headers and then stalls the body made the timeout reject OUTSIDE
// httpGet's try, so the rejection escaped fetchOne and fetchAll and killed `kb fetch`: no fetched.json, every
// earlier record lost. Found by the first real review (llm-screening, 44 URLs) on 2026-11-23.
// @size medium — starts a local server
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { kbCmd } from "../../cli/kb.mjs";

const PAGE = "<!doctype html><html><head><title>t</title></head><body><p>A normal page that answers in full and can be quoted later on.</p></body></html>";
const server = http.createServer((req, res) => {
  if (req.url === "/robots.txt") { res.writeHead(404); return res.end(); }
  if (req.url === "/stall") { res.writeHead(200, { "content-type": "text/html" }); return res.write("<html><body>partial"); } // never ends
  res.writeHead(200, { "content-type": "text/html" }); res.end(PAGE);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => { server.closeAllConnections?.(); return new Promise((r) => server.close(r)); });

test("a body that stalls past the timeout is not_retrieved for that URL, and the rest of the batch is still fetched and written", async () => {
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), "kbf-stall-")), "review");
  const out = [];
  const io = { log: (s) => out.push(String(s)), error: () => {} };
  const code = await kbCmd(["fetch", dir, `${base}/stall`, `${base}/page`, "--json"], {
    io, stateDirPath: mkdtempSync(path.join(os.tmpdir(), "kbf-stall-state-")), contact: null, timeoutMs: 400,
    endpoints: { wayback: `${base}/wayback/available`, unpaywall: `${base}/unpaywall` },
  });
  assert.equal(code, 1, "one URL not retrieved is exit 1, never a crash");
  assert.ok(existsSync(path.join(dir, "fetched.json")), "fetched.json must be written even when one URL timed out");
  const recs = JSON.parse(readFileSync(path.join(dir, "fetched.json"), "utf8")).records;
  assert.equal(recs.length, 2);
  const stall = recs.find((r) => r.url.endsWith("/stall"));
  const page = recs.find((r) => r.url.endsWith("/page"));
  assert.equal(stall.classification, "not_retrieved");
  assert.match(JSON.stringify(stall), /time/i, "the record names the timeout as its reason");
  assert.equal(page.classification, "ok", "the URL after the stalled one is still fetched");
});
