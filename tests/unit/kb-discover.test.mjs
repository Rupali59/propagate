/**
 * `kb discover` (#356): every engine's response shape, the daily-budget 429, a missing key, 0 hits, a malformed
 * response, and a planted key that must appear nowhere. A stub fetch serves recorded fixtures: NO real network.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverCmd, redact } from "../../lib/research/discover.mjs";
import { kbCmd } from "../../cli/kb.mjs";

const FIX = path.join(import.meta.dirname, "..", "fixtures", "discover");
const fx = (n) => readFileSync(path.join(FIX, n), "utf8");
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "discover-"));

function io() {
  const out = [];
  const err = [];
  return { out, err, log: (...a) => out.push(a.join(" ")), error: (...a) => err.push(a.join(" ")) };
}

/** routes: host -> array of responses served in order (the last repeats). A response is {status, body, headers}. */
function stub(routes) {
  const calls = [];
  const idx = {};
  const fn = async (url, opts = {}) => {
    const host = new URL(url).host;
    calls.push({ url: String(url), headers: opts.headers ?? {}, host });
    const list = routes[host];
    if (!list) throw new Error(`stub: no route for ${host}`);
    const i = Math.min(idx[host] ?? 0, list.length - 1);
    idx[host] = (idx[host] ?? 0) + 1;
    const r = list[i];
    return { status: r.status ?? 200, text: async () => r.body, headers: { get: (h) => (r.headers ?? {})[h.toLowerCase()] ?? null } };
  };
  fn.calls = calls;
  return fn;
}

const ok = (body) => ({ status: 200, body });
const base = (extra = {}) => ({ io: io(), env: {}, sleep: async () => {}, now: () => Date.parse("2026-11-23T10:00:00Z"), ...extra });

test("openalex: parses the works shape, strips ids, rebuilds the abstract, sets the peer-review hint", async () => {
  const dir = tmp();
  const f = stub({ "api.openalex.org": [ok(fx("openalex.json"))] });
  const code = await discoverCmd([dir, "agents", "--engine", "openalex", "--lane", "L1"], base({ fetch: f, contact: "x@example.org" }));
  assert.equal(code, 0);
  const d = JSON.parse(readFileSync(path.join(dir, "discovered.json"), "utf8"));
  assert.deepEqual(d[0], {
    engine: "openalex", id: "W111", doi: "10.1000/alpha.1", title: "Screening with agents", year: 2024,
    venue: "Journal of Review Methods", is_peer_reviewed_hint: true, oa_url: "https://example.org/alpha.pdf", abstract: "Agents screen papers well",
  });
  assert.equal(d[1].is_peer_reviewed_hint, false);
  assert.equal(d[1].doi, null);
  assert.equal("abstract" in d[1], false);
  const s = JSON.parse(readFileSync(path.join(dir, "searches.json"), "utf8"));
  assert.deepEqual(s, [{ lane: "L1", engine: "openalex", query: "agents", date: "2026-11-23", hits: 2 }]);
  assert.match(f.calls[0].url, /mailto=x%40example\.org/);
});

test("s2: parses the paper shape; key goes in a header, never the URL", async () => {
  const dir = tmp();
  const f = stub({ "api.semanticscholar.org": [ok(fx("s2.json"))] });
  const code = await discoverCmd([dir, "agents", "--engine", "s2"], base({ fetch: f, env: { S2_API_KEY: "s2-key-value" } }));
  assert.equal(code, 0);
  const d = JSON.parse(readFileSync(path.join(dir, "discovered.json"), "utf8"));
  assert.equal(d[0].id, "abc123");
  assert.equal(d[0].doi, "10.2000/beta");
  assert.equal(d[0].is_peer_reviewed_hint, true);
  assert.equal(d[0].oa_url, "https://example.org/beta.pdf");
  assert.equal(d[0].abstract, "We study agents.");
  assert.equal(d[1].venue, null);
  assert.equal(d[1].year, null);
  assert.equal(f.calls[0].headers["x-api-key"], "s2-key-value");
  assert.ok(!f.calls[0].url.includes("s2-key-value"));
});

test("arxiv: parses the Atom feed (entities, whitespace, pdf link, doi)", async () => {
  const dir = tmp();
  const f = stub({ "export.arxiv.org": [ok(fx("arxiv.xml"))] });
  assert.equal(await discoverCmd([dir, "agents", "--engine", "arxiv"], base({ fetch: f })), 0);
  const d = JSON.parse(readFileSync(path.join(dir, "discovered.json"), "utf8"));
  assert.equal(d[0].id, "2401.00001v1");
  assert.equal(d[0].title, "Agentic screening of papers");
  assert.equal(d[0].abstract, "We screen & rank papers.");
  assert.equal(d[0].oa_url, "http://arxiv.org/pdf/2401.00001v1");
  assert.equal(d[0].doi, "10.3000/gamma");
  assert.equal(d[0].year, 2024);
  assert.equal(d[0].is_peer_reviewed_hint, false);
});

test("arxiv: one all: term per token joined by AND, a quoted phrase stays one term, sorted by relevance (exact URLs)", async () => {
  const cases = [
    ["systematic literature review", "https://export.arxiv.org/api/query?search_query=all%3Asystematic+AND+all%3Aliterature+AND+all%3Areview&max_results=5&sortBy=relevance"],
    ['"large language models" screening', "https://export.arxiv.org/api/query?search_query=all%3A%22large+language+models%22+AND+all%3Ascreening&max_results=5&sortBy=relevance"],
  ];
  for (const [q, url] of cases) {
    const f = stub({ "export.arxiv.org": [ok(fx("arxiv.xml"))] });
    assert.equal(await discoverCmd([tmp(), q, "--engine", "arxiv", "--limit", "5"], base({ fetch: f })), 0);
    assert.equal(f.calls[0].url, url);
  }
});

test("crossref: parses a work list, and a DOI query does a single-work lookup", async () => {
  const dir = tmp();
  const f = stub({ "api.crossref.org": [ok(fx("crossref.json"))] });
  assert.equal(await discoverCmd([dir, "reviews", "--engine", "crossref"], base({ fetch: f })), 0);
  const d = JSON.parse(readFileSync(path.join(dir, "discovered.json"), "utf8"));
  assert.deepEqual([d[0].id, d[0].year, d[0].venue, d[0].is_peer_reviewed_hint, d[0].abstract], ["10.4000/delta", 2022, "Journal of Delta", true, "Delta abstract."]);
  const dir2 = tmp();
  const f2 = stub({ "api.crossref.org": [ok(fx("crossref-doi.json"))] });
  assert.equal(await discoverCmd([dir2, "10.4000/delta", "--engine", "crossref"], base({ fetch: f2 })), 0);
  assert.match(f2.calls[0].url, /\/works\/10\.4000%2Fdelta/);
});

test("default engine order is openalex, s2, arxiv, crossref; one search-log row per engine", async () => {
  const dir = tmp();
  const f = stub({
    "api.openalex.org": [ok(fx("openalex.json"))], "api.semanticscholar.org": [ok(fx("s2.json"))],
    "export.arxiv.org": [ok(fx("arxiv.xml"))], "api.crossref.org": [ok(fx("crossref.json"))],
  });
  assert.equal(await discoverCmd([dir, "agents"], base({ fetch: f })), 0);
  assert.deepEqual(f.calls.map((c) => c.host), ["api.openalex.org", "api.semanticscholar.org", "export.arxiv.org", "api.crossref.org"]);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "searches.json"), "utf8")).map((r) => r.engine), ["openalex", "s2", "arxiv", "crossref"]);
});

test("a second run merges and de-duplicates on (engine, id) and appends to the log", async () => {
  const dir = tmp();
  const f = stub({ "api.openalex.org": [ok(fx("openalex.json"))] });
  await discoverCmd([dir, "a", "--engine", "openalex"], base({ fetch: f }));
  await discoverCmd([dir, "b", "--engine", "openalex"], base({ fetch: f }));
  assert.equal(JSON.parse(readFileSync(path.join(dir, "discovered.json"), "utf8")).length, 2);
  assert.equal(JSON.parse(readFileSync(path.join(dir, "searches.json"), "utf8")).length, 2);
});

test("a daily-budget 429 is exit 2 with the reason, is not retried, and writes nothing", async () => {
  const dir = tmp();
  const f = stub({ "api.openalex.org": [{ status: 429, body: fx("openalex-429-daily.json") }] });
  const b = base({ fetch: f });
  assert.equal(await discoverCmd([dir, "agents", "--engine", "openalex"], b), 2);
  assert.equal(f.calls.length, 1, "no retry loop on a daily budget");
  assert.match(b.io.err.join("\n"), /DISCOVER_DAILY_BUDGET.*daily_budget/);
  assert.deepEqual(readdirSync(dir), []);
});

test("a per-second 429 backs off by Retry-After, then succeeds", async () => {
  const dir = tmp();
  const f = stub({ "api.openalex.org": [{ status: 429, body: fx("openalex-429-persecond.json"), headers: { "retry-after": "3" } }, ok(fx("openalex.json"))] });
  const waits = [];
  const code = await discoverCmd([dir, "agents", "--engine", "openalex"], base({ fetch: f, sleep: async (ms) => waits.push(ms) }));
  assert.equal(code, 0);
  assert.equal(f.calls.length, 2);
  assert.ok(waits.includes(3000), `expected a 3000ms back-off, got ${waits}`);
});

test("a per-second 429 that never clears gives up after the retry cap with exit 2", async () => {
  const dir = tmp();
  const f = stub({ "api.openalex.org": [{ status: 429, body: fx("openalex-429-persecond.json") }] });
  assert.equal(await discoverCmd([dir, "agents", "--engine", "openalex"], base({ fetch: f })), 2);
  assert.equal(f.calls.length, 3);
});

test("a missing key degrades to the keyless rate with one stated line; no contact is stated, never guessed", async () => {
  const dir = tmp();
  const f = stub({ "api.openalex.org": [ok(fx("openalex.json"))] });
  const b = base({ fetch: f });
  assert.equal(await discoverCmd([dir, "agents", "--engine", "openalex"], b), 0);
  const err = b.io.err.join("\n");
  assert.equal(err.match(/OPENALEX_API_KEY is not set/g).length, 1);
  assert.match(err, /keyless rate/);
  assert.match(err, /no contact address.*PROPAGATE_KB_CONTACT/);
  assert.ok(!/mailto=/.test(f.calls[0].url));
  assert.ok(!("Authorization" in f.calls[0].headers));
});

test("the contact comes from PROPAGATE_KB_CONTACT and the no-contact line goes away", async () => {
  const dir = tmp();
  const f = stub({ "api.openalex.org": [ok(fx("openalex.json"))] });
  const b = base({ fetch: f, env: { PROPAGATE_KB_CONTACT: "lit@example.org", OPENALEX_API_KEY: "k" } });
  await discoverCmd([dir, "agents", "--engine", "openalex"], b);
  assert.match(f.calls[0].url, /mailto=lit%40example\.org/);
  assert.ok(!/no contact address/.test(b.io.err.join("\n")));
});

test("0 hits from every engine is exit 1 and says so per engine", async () => {
  const dir = tmp();
  const f = stub({
    "api.openalex.org": [ok(fx("openalex-empty.json"))], "api.semanticscholar.org": [ok(fx("s2-empty.json"))],
    "export.arxiv.org": [ok(fx("arxiv-empty.xml"))], "api.crossref.org": [ok(fx("crossref-empty.json"))],
  });
  const b = base({ fetch: f });
  assert.equal(await discoverCmd([dir, "zzzz"], b), 1);
  const out = b.io.out.join("\n");
  for (const e of ["openalex", "s2", "arxiv", "crossref"]) assert.match(out, new RegExp(`0 hits from ${e}`));
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "searches.json"), "utf8")).map((r) => r.hits), [0, 0, 0, 0]);
});

test("a malformed response is exit 2 'could not understand', never 0 results", async () => {
  for (const [host, engine, body] of [
    ["api.openalex.org", "openalex", '{"unexpected":true}'],
    ["api.openalex.org", "openalex", "<html>gateway</html>"],
    ["api.semanticscholar.org", "s2", '{"message":"Too Many Requests"}'],
    ["export.arxiv.org", "arxiv", "not xml at all"],
    ["export.arxiv.org", "arxiv", fx("arxiv-error.xml")],
    ["api.crossref.org", "crossref", '{"status":"failed"}'],
  ]) {
    const dir = tmp();
    const b = base({ fetch: stub({ [host]: [ok(body)] }) });
    const code = await discoverCmd([dir, "agents", "--engine", engine], b);
    assert.equal(code, 2, `${engine} ${body.slice(0, 30)}`);
    assert.match(b.io.err.join("\n"), /DISCOVER_MALFORMED.*could not understand/);
    assert.deepEqual(readdirSync(dir), [], "a malformed response writes nothing");
  }
});

test("one engine failing does not hide the others' results, but the run is exit 2", async () => {
  const dir = tmp();
  const f = stub({ "api.openalex.org": [{ status: 429, body: fx("openalex-429-daily.json") }], "api.semanticscholar.org": [ok(fx("s2.json"))], "export.arxiv.org": [ok(fx("arxiv-empty.xml"))], "api.crossref.org": [ok(fx("crossref-empty.json"))] });
  const b = base({ fetch: f });
  assert.equal(await discoverCmd([dir, "agents"], b), 2);
  assert.equal(JSON.parse(readFileSync(path.join(dir, "discovered.json"), "utf8")).length, 2);
});

test("KEY: a planted key appears in no stdout, stderr or written file, even when the server echoes it", async () => {
  const KEY_OA = "FAKE-OA-KEY-9f3a71c2";
  const KEY_S2 = "FAKE-S2-KEY-b84d10e7";
  const dir = tmp();
  const echoed = `{"results":[{"id":"https://openalex.org/W9","display_name":"title ${KEY_OA} and ${KEY_S2}","publication_year":2024}]}`;
  const f = stub({
    "api.openalex.org": [ok(echoed)],
    "api.semanticscholar.org": [ok(`{"message":"bad key ${KEY_S2}"}`)],
    "export.arxiv.org": [ok(fx("arxiv-empty.xml"))], "api.crossref.org": [ok(fx("crossref-empty.json"))],
  });
  for (const asJson of [false, true]) {
    const b = base({ fetch: f, env: { OPENALEX_API_KEY: KEY_OA, S2_API_KEY: KEY_S2 } });
    const code = await discoverCmd(asJson ? [dir, "agents", "--json"] : [dir, "agents"], b);
    assert.equal(code, 2, "the s2 body is malformed");
    const seen = [...b.io.out, ...b.io.err].join("\n");
    assert.ok(!seen.includes(KEY_OA) && !seen.includes(KEY_S2), `key leaked to output:\n${seen}`);
  }
  for (const name of readdirSync(dir)) {
    const text = readFileSync(path.join(dir, name), "utf8");
    assert.ok(!text.includes(KEY_OA) && !text.includes(KEY_S2), `key leaked into ${name}`);
  }
  assert.ok(readdirSync(dir).length > 0, "the scan must have looked at a written file");
  // and the keys did reach the server, in headers only
  assert.equal(f.calls[0].headers.Authorization, `Bearer ${KEY_OA}`);
  for (const c of f.calls) assert.ok(!c.url.includes(KEY_OA) && !c.url.includes(KEY_S2));
});

test("redact removes the longer secret whole and ignores empty values", () => {
  assert.equal(redact("a abc b", ["ab", "abc", "", null]), "a [redacted] b");
});

test("usage errors are exit 2 with a stated Next", async () => {
  for (const argv of [[], ["only-dir"], [tmp(), "q", "--engine", "bing"], [tmp(), "q", "--limit", "0"], [tmp(), "q", "--nope"], ["/no/such/dir-xyz", "q"]]) {
    const b = base({ fetch: stub({}) });
    assert.equal(await discoverCmd(argv, b), 2, JSON.stringify(argv));
    assert.match(b.io.err.join("\n"), /DISCOVER_(USAGE|DIR): .*Next:/);
  }
});

test("an unreadable store is refused rather than overwritten", async () => {
  const dir = tmp();
  writeFileSync(path.join(dir, "discovered.json"), "{broken");
  const b = base({ fetch: stub({ "api.openalex.org": [ok(fx("openalex.json"))] }) });
  assert.equal(await discoverCmd([dir, "a", "--engine", "openalex"], b), 2);
  assert.equal(readFileSync(path.join(dir, "discovered.json"), "utf8"), "{broken");
  assert.ok(!existsSync(path.join(dir, "searches.json")));
});

test("kb discover is reachable through kbCmd and reads kbContact from integrations", async () => {
  const dir = tmp();
  const f = stub({ "api.openalex.org": [ok(fx("openalex.json"))] });
  const code = await kbCmd(["discover", dir, "agents", "--engine", "openalex"], { io: io(), fetch: f, env: {}, sleep: async () => {}, integrations: { kbContact: "cfg@example.org" }, workspaces: [] });
  assert.equal(code, 0);
  assert.match(f.calls[0].url, /mailto=cfg%40example\.org/);
});
