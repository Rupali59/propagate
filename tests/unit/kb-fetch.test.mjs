import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { kbCmd } from "../../cli/kb.mjs";
import { canonicalUrl, landedOnLoginPage, parseRobots, resolveSource, robotsAllows } from "../../lib/research/fetch.mjs";
import { findQuote } from "../../lib/research/quotes.mjs";

const tmp = (p = "kbf-") => mkdtempSync(path.join(os.tmpdir(), p));
const HAS_PDFTOTEXT = spawnSync("pdftotext", ["-v"]).error === undefined;

/** A one-page PDF with a known sentence, built by hand so the suite needs no fixture binary. */
function makePdf(sentence) {
  const stream = `BT /F1 12 Tf 20 100 Td (${sentence}) Tj ET`;
  const bodies = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const off = [];
  bodies.forEach((b, i) => { off.push(out.length); out += `${i + 1} 0 obj\n${b}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n${off.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const PAGE_SENTENCE = "The quick brown fox jumps over the lazy dog today";
const PDF_SENTENCE = "Retrieval augmented generation reduces hallucinated citations";
const BODY_MARKER = "UNIQUE-BODY-MARKER-7f3a";
const page = (body) => `<!doctype html><html><head><title>t</title></head><body><p>${body}</p><p>${BODY_MARKER}</p></body></html>`;

let server;
let base; // http://127.0.0.1:PORT
let alt; // http://localhost:PORT, a different host name for the same stub
const hits = { wayback: 0, robots: 0 };
let robotsTxt = "User-agent: *\nDisallow: /private\n";

before(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const send = (code, type, body, extra = {}) => { res.writeHead(code, { "content-type": type, ...extra }); res.end(body); };
    switch (u.pathname) {
      case "/robots.txt": hits.robots++; return send(200, "text/plain", robotsTxt);
      case "/page": return send(200, "text/html; charset=utf-8", page(PAGE_SENTENCE));
      case "/md": return send(200, "text/markdown", `# Title\n\nSome [linked words](https://example.com/x) in the **markdown** body of this file.\n`);
      case "/doc.pdf": return send(200, "application/pdf", makePdf(PDF_SENTENCE));
      case "/pdf/2401.00001": return send(200, "application/pdf", makePdf(PDF_SENTENCE));
      case "/gone": return send(404, "text/plain", "nope");
      case "/forbidden": return send(403, "text/plain", "no");
      case "/private": return send(200, "text/html", page("private page"));
      case "/to-login": return send(302, "text/plain", "", { location: "/login?next=/to-login" });
      case "/login": return send(200, "text/html", `<html><body><h1>Welcome</h1><form><input type="password" name="p"></form></body></html>`);
      case "/consent-short": return send(200, "text/html", `<html><body><p>Before you continue to the site, please accept cookies.</p></body></html>`);
      case "/to-other-host": return send(302, "text/plain", "", { location: `${alt}/landing` });
      case "/landing": return send(200, "text/html", page("a perfectly normal looking article about something else"));
      case "/wayback/available": {
        hits.wayback++;
        const target = u.searchParams.get("url") ?? "";
        if (target.includes("stale")) return send(200, "application/json", JSON.stringify({ archived_snapshots: { closest: { available: true, url: "http://web.archive.org/web/2020/" + target, status: "200" } } }));
        if (target.includes("wayback-down")) return send(503, "text/plain", "down");
        return send(200, "application/json", JSON.stringify({ archived_snapshots: {} }));
      }
      default:
        if (u.pathname.startsWith("/unpaywall/")) {
          const doi = decodeURIComponent(u.pathname.slice("/unpaywall/".length));
          if (!u.searchParams.get("email")) return send(422, "application/json", "{}");
          if (doi === "10.1000/open") return send(200, "application/json", JSON.stringify({ is_oa: true, best_oa_location: { url_for_pdf: `${base}/doc.pdf`, url: `${base}/page` } }));
          if (doi === "10.1000/closed") return send(200, "application/json", JSON.stringify({ is_oa: false, best_oa_location: null }));
          return send(404, "application/json", JSON.stringify({ message: "not found" }));
        }
        return send(404, "text/plain", "not found");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  base = `http://127.0.0.1:${port}`;
  alt = `http://localhost:${port}`;
});
after(() => new Promise((r) => server.close(r)));

/** Run `kb fetch --json`; returns {code, j, err, dir, state}. */
async function run(urls, o = {}) {
  const dir = o.dir ?? path.join(tmp(), "review");
  const state = o.state ?? tmp("kbf-state-");
  const out = [];
  const err = [];
  const io = { log: (s) => out.push(String(s)), error: (s) => err.push(String(s)) };
  const code = await kbCmd(["fetch", dir, ...urls, "--json"], {
    io, stateDirPath: state, contact: null, timeoutMs: 8000,
    endpoints: { wayback: `${base}/wayback/available`, unpaywall: `${base}/unpaywall` },
    ...o.inject,
  });
  const text = out.join("\n");
  return { code, j: text ? JSON.parse(text) : null, err: err.join("\n"), dir, state };
}

const stored = (state, sha) => readFileSync(path.join(state, "kb", "fetched", sha), "utf8");

test("an HTML page is read, its text stored under $STATE/kb/fetched/<sha256>, and the record has the contract fields", async () => {
  const r = await run([`${base}/page`]);
  assert.equal(r.code, 0);
  const rec = r.j.records[0];
  assert.equal(rec.classification, "ok");
  for (const k of ["url", "final_url", "status", "type", "sha256", "date"]) assert.ok(k in rec, `record lacks ${k}`);
  assert.equal(rec.status, 200);
  assert.equal(rec.type, "html");
  assert.match(rec.sha256, /^[0-9a-f]{64}$/);
  assert.equal(findQuote(stored(r.state, rec.sha256), PAGE_SENTENCE).found, true, "the gate must find the page's sentence in the stored text");
  const onDisk = JSON.parse(readFileSync(path.join(r.dir, "fetched.json"), "utf8"));
  assert.equal(onDisk.records.length, 1);
});

test("markdown is stored as served (Accept: text/markdown is honoured by the server's own type)", async () => {
  const r = await run([`${base}/md`]);
  assert.equal(r.j.records[0].type, "markdown");
  assert.equal(findQuote(stored(r.state, r.j.records[0].sha256), "Some linked words in the markdown body of this file").found, true);
});

test("a PDF is read through pdftotext and its sentence is quotable", { skip: HAS_PDFTOTEXT ? false : "pdftotext is not installed here, so the real-PDF path cannot run" }, async () => {
  const r = await run([`${base}/doc.pdf`]);
  assert.equal(r.code, 0);
  const rec = r.j.records[0];
  assert.equal(rec.type, "pdf");
  assert.equal(findQuote(stored(r.state, rec.sha256), PDF_SENTENCE).found, true);
});

test("a PDF read through an injected pdftotext is stored from its output (runs without poppler)", async () => {
  const calls = [];
  const run1 = (cmd, args, opts) => { calls.push([cmd, args, Buffer.isBuffer(opts.input) && opts.input.subarray(0, 5).toString("latin1")]); return "Injected text of the paper, long enough to quote from."; };
  const r = await run([`${base}/doc.pdf`], { inject: { run: run1, pdftotextBin: "fake-pdftotext" } });
  assert.equal(r.j.records[0].classification, "ok");
  assert.deepEqual(calls[0], ["fake-pdftotext", ["-enc", "UTF-8", "-", "-"], "%PDF-"]);
  assert.match(stored(r.state, r.j.records[0].sha256), /Injected text of the paper/);
});

test("pdftotext missing exits 2, names the fix, and writes no fetched.json", async () => {
  const r = await run([`${base}/page`, `${base}/doc.pdf`], { inject: { pdftotextBin: "/nonexistent/pdftotext-for-test" } });
  assert.equal(r.code, 2);
  assert.match(r.j.code, /FETCH_PDFTOTEXT_MISSING/);
  assert.match(r.j.what, /not installed/);
  assert.match(r.j.next, /poppler/);
  assert.equal(existsSync(path.join(r.dir, "fetched.json")), false, "an aborted run must not leave a partial fetched.json");
});

test("a redirect to a login page that returns 200 is not_retrieved, with the reason", async () => {
  const r = await run([`${base}/to-login`]);
  assert.equal(r.code, 1);
  const rec = r.j.records[0];
  assert.equal(rec.status, 200);
  assert.equal(rec.classification, "not_retrieved", "a 200 login page must not be recorded as ok");
  assert.equal(rec.sha256, null, "nothing may be stored for a login page");
  assert.match(rec.note, /login or consent path/);
});

test("a 200 that lands on another host is not_retrieved", async () => {
  const r = await run([`${base}/to-other-host`]);
  const rec = r.j.records[0];
  assert.equal(rec.classification, "not_retrieved");
  assert.match(rec.note, /redirected to another host/);
  assert.equal(rec.sha256, null);
});

test("landedOnLoginPage: password field, short consent page, resolver exemption, and a normal page", () => {
  const s = "https://example.com/a";
  assert.equal(landedOnLoginPage({ startUrl: s, finalUrl: s, html: `<input type="password">` }).login, true);
  assert.equal(landedOnLoginPage({ startUrl: s, finalUrl: s, html: "<p>Please sign in to continue</p>" }).login, true);
  assert.equal(landedOnLoginPage({ startUrl: s, finalUrl: "https://www.example.com/a", html: "<p>fine</p>" }).login, false, "www. is the same host");
  assert.equal(landedOnLoginPage({ startUrl: "https://doi.org/10.1/x", finalUrl: "https://publisher.example/x", html: "<p>fine</p>" }).login, false, "doi.org exists to redirect");
  const long = `<p>${"word ".repeat(400)} please log in to the forum below</p>`;
  assert.equal(landedOnLoginPage({ startUrl: s, finalUrl: s, html: long }).login, false, "a long article mentioning login is still an article");
});

test("a short consent page with no password field is not_retrieved", async () => {
  const r = await run([`${base}/consent-short`]);
  assert.equal(r.j.records[0].classification, "not_retrieved");
});

test("robots.txt is respected: a disallowed path is not fetched and is not_retrieved", async () => {
  const r = await run([`${base}/private`]);
  assert.equal(r.j.records[0].classification, "not_retrieved");
  assert.match(r.j.records[0].note, /robots\.txt/);
  assert.equal(r.j.records[0].status, null, "the page itself must never have been requested");
});

test("robots parsing: longest match wins, ties go to allow, our own group beats *", () => {
  const rules = parseRobots("User-agent: *\nDisallow: /a\nAllow: /a/ok\n\nUser-agent: propagate-kb-fetch\nDisallow: /only-us\n");
  assert.equal(robotsAllows(rules, "/a/x"), true, "our group has no /a rule");
  assert.equal(robotsAllows(rules, "/only-us/x"), false);
  const star = parseRobots("User-agent: *\nDisallow: /a\nAllow: /a/ok\n");
  assert.equal(robotsAllows(star, "/a/ok/1"), true, "the longer Allow beats the shorter Disallow");
  assert.equal(robotsAllows(star, "/a/no"), false);
  assert.equal(robotsAllows(parseRobots("User-agent: *\nDisallow: /*.pdf$\n"), "/x/paper.pdf"), false);
});

test("a hallucinated URL (404, no Wayback record) is classified hallucinated", async () => {
  const r = await run([`${base}/gone`]);
  assert.equal(r.code, 1);
  assert.equal(r.j.records[0].classification, "hallucinated");
  assert.equal(r.j.records[0].status, 404);
  assert.match(r.j.records[0].note, /no record of this URL/);
});

test("a 404 with a Wayback snapshot is stale and carries the snapshot URL", async () => {
  const u = `${base}/stale-page-that-existed`;
  const r = await run([u]);
  assert.equal(r.j.records[0].classification, "stale");
  assert.match(r.j.records[0].wayback_url, /web\.archive\.org/);
});

test("Wayback unavailable is not_retrieved, never a guess at stale or hallucinated", async () => {
  const r = await run([`${base}/wayback-down-and-missing`]);
  assert.equal(r.j.records[0].classification, "not_retrieved");
  assert.match(r.j.records[0].note, /not classified as stale or hallucinated/);
});

test("a 403 is not_retrieved and never sent to Wayback", async () => {
  const before = hits.wayback;
  const r = await run([`${base}/forbidden`]);
  assert.equal(r.j.records[0].classification, "not_retrieved");
  assert.equal(hits.wayback, before, "only 404, 410 and unresolvable hosts are checked against Wayback");
});

test("a name that does not resolve is checked against Wayback", async () => {
  const r = await run(["http://no-such-host.invalid/paper"]);
  assert.equal(r.j.records[0].classification, "hallucinated");
});

test("resolveSource: arXiv, OpenReview and ACL Anthology go to their PDFs", () => {
  assert.equal(resolveSource("https://arxiv.org/abs/2401.00001v2").fetchUrl, "https://arxiv.org/pdf/2401.00001v2");
  assert.equal(resolveSource("https://arxiv.org/pdf/2401.00001.pdf").fetchUrl, "https://arxiv.org/pdf/2401.00001");
  assert.equal(resolveSource("https://arxiv.org/abs/cs/0112017").fetchUrl, "https://arxiv.org/pdf/cs/0112017");
  assert.equal(resolveSource("https://openreview.net/forum?id=AbC123").fetchUrl, "https://openreview.net/pdf?id=AbC123");
  assert.equal(resolveSource("https://aclanthology.org/2020.acl-main.1/").fetchUrl, "https://aclanthology.org/2020.acl-main.1.pdf");
  assert.equal(resolveSource("https://aclanthology.org/2020.acl-main.1.pdf").resolvedFrom, undefined, "an ACL PDF link is already a PDF");
  assert.equal(resolveSource("https://example.com/x").fetchUrl, "https://example.com/x");
  assert.equal(resolveSource("https://github.com/o/r").kind, "github");
  assert.equal(resolveSource("https://doi.org/10.1000/open").doi, "10.1000/open");
});

test("an arXiv abstract URL is fetched as its PDF (host mapped to the stub), and the record says so", async () => {
  const seen = [];
  const fetchImpl = (u, init) => {
    seen.push(String(u));
    const x = new URL(u);
    return fetch(`${base}${x.pathname}${x.search}`, init);
  };
  const r = await run(["https://arxiv.org/abs/2401.00001"], { inject: { fetchImpl, run: () => "Arxiv paper text that a researcher could quote from." } });
  assert.equal(r.j.records[0].classification, "ok");
  assert.equal(r.j.records[0].resolved_from, "arxiv");
  assert.equal(r.j.records[0].url, "https://arxiv.org/abs/2401.00001", "the record keeps the URL as given");
  assert.ok(seen.includes("https://arxiv.org/pdf/2401.00001"), `the PDF URL was never requested: ${seen.join(", ")}`);
});

test("a DOI goes through Unpaywall to the open-access PDF", async () => {
  const r = await run(["https://doi.org/10.1000/open"], { inject: { contact: "contact@example.com", run: () => "Open access paper body text for quoting purposes." } });
  assert.equal(r.j.records[0].classification, "ok");
  assert.equal(r.j.records[0].resolved_from, "unpaywall");
  assert.equal(r.j.records[0].final_url, `${base}/doc.pdf`);
});

test("a bare DOI is accepted, and a closed-access DOI is not_retrieved with no other route tried", async () => {
  const r = await run(["10.1000/closed"], { inject: { contact: "contact@example.com" } });
  assert.equal(r.j.records[0].url, "https://doi.org/10.1000/closed");
  assert.equal(r.j.records[0].classification, "not_retrieved");
  assert.match(r.j.records[0].note, /no open-access copy/);
  assert.equal(r.j.records[0].final_url, null, "nothing but Unpaywall was asked");
});

test("with no Unpaywall email the run says so, and never invents one", async () => {
  let asked = false;
  const fetchImpl = (u, init) => { if (String(u).includes("unpaywall")) asked = true; return fetch(String(u).replace(/^https?:\/\/doi\.org/, base), init); };
  const r = await run(["https://doi.org/10.1000/open"], { inject: { fetchImpl, contact: null } });
  assert.equal(asked, false, "Unpaywall must not be called without a contact email");
  assert.match(r.j.records[0].note, /Unpaywall skipped: no contact set/);
});

test("GitHub URLs go through gh api; a repo URL is read from its README endpoint", async () => {
  const calls = [];
  const gh = (cmd, args) => { calls.push([cmd, args]); return "# Readme\n\nThis repository does one useful thing well."; };
  const r = await run(["https://github.com/example-org/example-repo"], { inject: { run: gh, ghBin: "fake-gh" } });
  assert.equal(r.j.records[0].classification, "ok");
  assert.equal(r.j.records[0].type, "github");
  assert.deepEqual(calls[0][1].slice(-1), ["repos/example-org/example-repo/readme"]);
  assert.equal(calls[0][0], "fake-gh");
});

test("gh logged out exits 2 with the fix named", async () => {
  const gh = () => { const e = new Error("x"); e.stderr = "To get started with GitHub CLI, please run:  gh auth login"; throw e; };
  const r = await run(["https://github.com/example-org/example-repo"], { inject: { run: gh } });
  assert.equal(r.code, 2);
  assert.equal(r.j.code, "FETCH_GH_UNAUTHENTICATED");
  assert.match(r.j.next, /gh auth login/);
});

test("a GitHub 404 is checked against Wayback like any other 404", async () => {
  const gh = () => { const e = new Error("x"); e.stderr = "gh: Not Found (HTTP 404)"; throw e; };
  const r = await run(["https://github.com/example-org/never-existed"], { inject: { run: gh } });
  assert.equal(r.j.records[0].classification, "hallucinated");
});

test("the same URL with ?utm= or a trailing slash is one source, fetched once", async () => {
  assert.equal(canonicalUrl("https://Example.com/a/?utm_source=x#frag"), canonicalUrl("https://example.com/a"));
  const r = await run([`${base}/page`, `${base}/page/?utm_campaign=z`]);
  assert.equal(r.j.records.length, 1);
  assert.equal(r.j.duplicates.length, 1);
});

test("a second run replaces the record for the same URL and keeps the others", async () => {
  const state = tmp("kbf-state-");
  const dir = path.join(tmp(), "review");
  await run([`${base}/page`, `${base}/md`], { dir, state });
  await run([`${base}/page`], { dir, state });
  const onDisk = JSON.parse(readFileSync(path.join(dir, "fetched.json"), "utf8"));
  assert.deepEqual(onDisk.records.map((x) => x.url).sort(), [`${base}/md`, `${base}/page`].sort());
});

test("exit codes: 0 all ok, 1 some not retrieved, 2 usage", async () => {
  assert.equal((await run([`${base}/page`])).code, 0);
  assert.equal((await run([`${base}/page`, `${base}/gone`])).code, 1);
  assert.equal((await run([])).code, 2);
  assert.equal((await run(["not-a-url"])).code, 2);
});

// ---- the safety claim: a body never lands in the repo or <dir> ---------------------------------------------------

function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = readFileSync(p).toString("base64");
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

test("SAFETY: bodies land only under $STATE/kb/fetched; <dir> holds fetched.json with no body text", async () => {
  const repo = tmp("kbf-repo-");
  const repoBefore = JSON.stringify(snapshot(repo));
  const r = await run([`${base}/page`, `${base}/md`]);
  assert.equal(r.code, 0);
  assert.deepEqual(readdirSync(r.dir), ["fetched.json"], "<dir> may hold only fetched.json");
  assert.equal(readFileSync(path.join(r.dir, "fetched.json"), "utf8").includes(BODY_MARKER), false, "fetched.json must not carry the body");
  assert.equal(JSON.stringify(snapshot(repo)), repoBefore);
  const files = readdirSync(path.join(r.state, "kb", "fetched"));
  assert.equal(files.length, 2);
  assert.ok(files.some((f) => readFileSync(path.join(r.state, "kb", "fetched", f), "utf8").includes(BODY_MARKER)));
});

test("SAFETY: a store inside <dir>, or <dir> inside the store, is refused before any byte is written", async () => {
  const dir = tmp("kbf-dir-");
  const before = JSON.stringify(snapshot(dir));
  const inside = await run([`${base}/page`], { dir, state: path.join(dir, "state") });
  assert.equal(inside.code, 2);
  assert.equal(inside.j.code, "FETCH_STORE_UNSAFE");
  assert.equal(JSON.stringify(snapshot(dir)), before, "the refused run wrote something");
  const state = tmp("kbf-state-");
  const around = await run([`${base}/page`], { dir: path.join(state, "kb", "fetched", "review"), state });
  assert.equal(around.code, 2);
  assert.equal(JSON.stringify(snapshot(state)), JSON.stringify({}), "the refused run wrote something into the store");
});

test("SAFETY: a store inside a git work tree is refused, and nothing is written", async () => {
  const repo = tmp("kbf-repo-");
  mkdirSync(path.join(repo, ".git"));
  const before = JSON.stringify(snapshot(repo));
  const r = await run([`${base}/page`], { state: path.join(repo, "state") });
  assert.equal(r.code, 2);
  assert.equal(r.j.code, "FETCH_STORE_UNSAFE");
  assert.match(r.j.what, /git work tree/);
  assert.equal(JSON.stringify(snapshot(repo)), before);
});

test("an unreadable existing fetched.json stops the run rather than being overwritten", async () => {
  const dir = path.join(tmp(), "review");
  mkdirSync(dir);
  writeFileSync(path.join(dir, "fetched.json"), "{not json");
  const r = await run([`${base}/page`], { dir });
  assert.equal(r.code, 2);
  assert.equal(r.j.code, "FETCH_FILE_UNREADABLE");
  assert.equal(readFileSync(path.join(dir, "fetched.json"), "utf8"), "{not json");
});

test("the contact comes from PROPAGATE_KB_CONTACT, else integrations.kbContact, and is the address Unpaywall is asked with", async () => {
  const seen = [];
  const fetchImpl = (u, init) => { seen.push(String(u)); return fetch(String(u).replace(/^https?:\/\/doi\.org/, base), init); };
  const saved = process.env.PROPAGATE_KB_CONTACT;
  try {
    delete process.env.PROPAGATE_KB_CONTACT;
    await run(["https://doi.org/10.1000/closed"], { inject: { contact: undefined, integrations: { kbContact: "cfg@example.com" }, workspaces: [], fetchImpl } });
    assert.ok(seen.some((u) => u.includes("/unpaywall/10.1000/closed?email=cfg%40example.com")), `integrations.kbContact was not used: ${seen.join(", ")}`);
    seen.length = 0;
    process.env.PROPAGATE_KB_CONTACT = "env@example.com";
    await run(["https://doi.org/10.1000/closed"], { inject: { contact: undefined, integrations: { kbContact: "cfg@example.com" }, workspaces: [], fetchImpl } });
    assert.ok(seen.some((u) => u.includes("email=env%40example.com")), `the env var must win: ${seen.join(", ")}`);
  } finally {
    if (saved === undefined) delete process.env.PROPAGATE_KB_CONTACT; else process.env.PROPAGATE_KB_CONTACT = saved;
  }
});
