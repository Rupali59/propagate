/**
 * `kb discover` (#356): every engine's response shape, the daily-budget 429, a missing key, 0 hits, a malformed
 * response, and a planted key that must appear nowhere. A stub fetch serves recorded fixtures: NO real network.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverCmd, redact } from "../../lib/research/discover.mjs";
import { findDiscovered } from "../../lib/kb/review/tier.mjs";
import { recordKey } from "../../lib/research/discover-engines.mjs";
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
const base = (extra = {}) => ({ io: io(), env: {}, stateDirPath: tmp(), sleep: async () => {}, now: () => Date.parse("2026-11-23T10:00:00Z"), ...extra });

test("openalex: parses the works shape, strips ids, rebuilds the abstract, sets the peer-review hint", async () => {
  const dir = tmp();
  const f = stub({ "api.openalex.org": [ok(fx("openalex.json"))] });
  const code = await discoverCmd([dir, "agents", "--engine", "openalex", "--lane", "L1"], base({ fetch: f, contact: "x@example.org" }));
  assert.equal(code, 0);
  const d = JSON.parse(readFileSync(path.join(dir, "discovered.json"), "utf8"));
  assert.deepEqual(d[0], {
    engine: "openalex", id: "W111", doi: "10.1000/alpha.1", title: "Screening with agents", year: 2024,
    venue: "Journal of Review Methods", is_peer_reviewed_hint: true, oa_url: "https://example.org/alpha.pdf", abstract: "Agents screen papers well",
    engines: ["openalex"], ids: { openalex: "W111" }, kind: "paper", key: "doi:10.1000/alpha.1", updated: null,
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
  const code = await kbCmd(["discover", dir, "agents", "--engine", "openalex"], { io: io(), fetch: f, env: {}, stateDirPath: tmp(), sleep: async () => {}, integrations: { kbContact: "cfg@example.org" }, workspaces: [] });
  assert.equal(code, 0);
  assert.match(f.calls[0].url, /mailto=cfg%40example\.org/);
});

// ---- #364: spacing across separate invocations, and every exit-2 line naming its engine and reason ----

/** A virtual clock: `sleep` advances it, so the suite never waits and request times are exact. */
function clock(start = Date.parse("2026-11-23T10:00:00Z")) {
  const c = { t: start, now: () => c.t, sleep: async (ms) => { c.t += ms; }, advance: (ms) => { c.t += ms; } };
  return c;
}
/** Wraps a stub so each call also records the virtual time it was made at. */
function timed(f, c) {
  const times = [];
  const g = async (url, o) => { times.push(c.t); return f(url, o); };
  g.calls = f.calls;
  g.times = times;
  return g;
}
const lastFile = (st) => path.join(st, "kb", "discover-last-request.json");

test("arxiv: two invocations back to back are at least 3 s apart by the clock, because the last-request time is kept in state", async () => {
  const st = tmp();
  const c = clock();
  const f = timed(stub({ "export.arxiv.org": [ok(fx("arxiv.xml"))] }), c);
  for (const q of ["one", "two"]) assert.equal(await discoverCmd([tmp(), q, "--engine", "arxiv"], base({ fetch: f, stateDirPath: st, now: c.now, sleep: c.sleep })), 0);
  assert.equal(f.times.length, 2);
  assert.ok(f.times[1] - f.times[0] >= 3000, `gap was ${f.times[1] - f.times[0]} ms`);
  // elapsed real time between runs counts toward the spacing: 2 s later, wait only the remaining 1 s
  c.advance(2000);
  const before = c.t;
  await discoverCmd([tmp(), "three", "--engine", "arxiv"], base({ fetch: f, stateDirPath: st, now: c.now, sleep: c.sleep }));
  assert.equal(f.times[2] - before, 1000);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(lastFile(st), "utf8"))), ["arxiv"]);
});

test("a gap already longer than the spacing waits nothing; other engines keep their own interval across runs", async () => {
  const st = tmp();
  const c = clock();
  const f = timed(stub({ "export.arxiv.org": [ok(fx("arxiv.xml"))], "api.crossref.org": [ok(fx("crossref.json"))] }), c);
  await discoverCmd([tmp(), "a", "--engine", "arxiv"], base({ fetch: f, stateDirPath: st, now: c.now, sleep: c.sleep }));
  c.advance(10000);
  const t0 = c.t;
  await discoverCmd([tmp(), "b", "--engine", "arxiv"], base({ fetch: f, stateDirPath: st, now: c.now, sleep: c.sleep }));
  assert.equal(f.times[1], t0, "10 s gap: no wait");
  await discoverCmd([tmp(), "c", "--engine", "crossref"], base({ fetch: f, stateDirPath: st, now: c.now, sleep: c.sleep }));
  const t1 = c.t;
  await discoverCmd([tmp(), "d", "--engine", "crossref"], base({ fetch: f, stateDirPath: st, now: c.now, sleep: c.sleep }));
  assert.equal(f.times[3] - t1, 1000, "crossref's own 1 s spacing holds across runs");
});

test("a missing timestamp file means no wait and one stated note, not a crash", async () => {
  const st = tmp();
  const c = clock();
  const f = timed(stub({ "export.arxiv.org": [ok(fx("arxiv.xml"))] }), c);
  const b = base({ fetch: f, stateDirPath: st, now: c.now, sleep: c.sleep });
  const t0 = c.t;
  assert.equal(await discoverCmd([tmp(), "q", "--engine", "arxiv"], b), 0);
  assert.equal(f.times[0], t0, "no wait");
  const lines = b.io.err.filter((l) => /does not exist yet/.test(l));
  assert.equal(lines.length, 1);
  assert.ok(existsSync(lastFile(st)), "the file is created for the next run");
});

test("a corrupt timestamp file gives a warning and no wait, and is repaired", async () => {
  for (const junk of ["{broken", "[1,2]", '"text"']) {
    const st = tmp();
    mkdirSync(path.join(st, "kb"));
    writeFileSync(lastFile(st), junk);
    const c = clock();
    const f = timed(stub({ "export.arxiv.org": [ok(fx("arxiv.xml"))] }), c);
    const b = base({ fetch: f, stateDirPath: st, now: c.now, sleep: c.sleep });
    const t0 = c.t;
    assert.equal(await discoverCmd([tmp(), "q", "--engine", "arxiv"], b), 0, junk);
    assert.equal(f.times[0], t0, `${junk}: no wait`);
    assert.equal(b.io.err.filter((l) => /unreadable/.test(l)).length, 1, junk);
    assert.equal(typeof JSON.parse(readFileSync(lastFile(st), "utf8")).arxiv, "number");
  }
});

test("an unwritable state dir is a stated note, never a crash", async () => {
  const st = tmp();
  writeFileSync(path.join(st, "kb"), "a file where the directory should be");
  const b = base({ fetch: stub({ "export.arxiv.org": [ok(fx("arxiv.xml"))] }), stateDirPath: st });
  assert.equal(await discoverCmd([tmp(), "q", "--engine", "arxiv"], b), 0);
  assert.match(b.io.err.join("\n"), /could not record the last-request time/);
});

test("a timestamp from the future cannot stall the run for more than one interval", async () => {
  const st = tmp();
  const c = clock();
  mkdirSync(path.join(st, "kb"));
  writeFileSync(lastFile(st), JSON.stringify({ arxiv: c.t + 3600000 }));
  const f = timed(stub({ "export.arxiv.org": [ok(fx("arxiv.xml"))] }), c);
  const t0 = c.t;
  await discoverCmd([tmp(), "q", "--engine", "arxiv"], base({ fetch: f, stateDirPath: st, now: c.now, sleep: c.sleep }));
  assert.equal(f.times[0] - t0, 3000);
});

test("every exit-2 line is one line, names its engine and a reason, and carries a word a coordinator filters on", async () => {
  const FILTER = /hit|error|429|budget|could/i;
  const engineCases = [
    ["openalex", "api.openalex.org", { status: 429, body: fx("openalex-429-daily.json") }, /openalex: .*budget/],
    ["openalex", "api.openalex.org", { status: 429, body: fx("openalex-429-persecond.json") }, /openalex: .*429/],
    ["arxiv", "export.arxiv.org", { status: 503, body: "busy" }, /arxiv: error: HTTP 503/],
    ["s2", "api.semanticscholar.org", { status: 500, body: "x" }, /s2: error: HTTP 500/],
    ["crossref", "api.crossref.org", ok("not json"), /crossref: error: could not understand/],
  ];
  for (const [engine, host, resp, re] of engineCases) {
    const b = base({ fetch: stub({ [host]: [resp] }) });
    assert.equal(await discoverCmd([tmp(), "q", "--engine", engine], b), 2, `${engine} ${resp.status}`);
    const lines = b.io.err.filter((l) => /^DISCOVER_/.test(l));
    assert.equal(lines.length, 1, `exactly one failure line: ${lines}`);
    assert.match(lines[0], re);
    assert.match(lines[0], FILTER);
    assert.ok(!lines[0].includes("\n"));
  }
  // a network error (fetch throws)
  const bn = base({ fetch: async () => { throw new Error("ECONNRESET"); } });
  assert.equal(await discoverCmd([tmp(), "q", "--engine", "arxiv"], bn), 2);
  const ln = bn.io.err.filter((l) => /^DISCOVER_NETWORK/.test(l));
  assert.equal(ln.length, 1);
  assert.match(ln[0], /arxiv: error: request failed \(ECONNRESET\)/);
  // paths where no engine ran: usage, missing dir, unreadable store
  const bad = tmp();
  writeFileSync(path.join(bad, "discovered.json"), "{broken");
  for (const argv of [[], [tmp(), "q", "--engine", "bing"], ["/no/such/dir-xyz", "q"], [bad, "q"]]) {
    const b = base({ fetch: stub({}) });
    assert.equal(await discoverCmd(argv, b), 2, JSON.stringify(argv));
    const lines = b.io.err.filter((l) => /^DISCOVER_/.test(l));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /error: kb discover \(no engine ran\): .+Next:/);
    assert.match(lines[0], FILTER);
  }
});

// ---- #399: kind / key / updated, and de-duplication across engines on `key` ----

const oaBody = (works) => JSON.stringify({ results: works });
const oaWork = (id, doi, extra = {}) => ({ id: `https://openalex.org/${id}`, doi, display_name: "Shared paper", publication_year: 2024, primary_location: null, open_access: {}, ...extra });
const crBody = (items) => JSON.stringify({ status: "ok", "message-type": "work-list", message: { items } });
const crItem = (doi, extra = {}) => ({ DOI: doi, title: ["Shared paper"], issued: { "date-parts": [[2024]] }, type: "journal-article", ...extra });
const readDiscovered = (dir) => JSON.parse(readFileSync(path.join(dir, "discovered.json"), "utf8"));

test("one DOI from openalex and crossref is ONE row, engines in first-seen order, hit counts stay per engine", async () => {
  const dir = tmp();
  const f = stub({
    "api.openalex.org": [ok(oaBody([oaWork("W9", "https://doi.org/10.5555/Shared.1"), oaWork("W10", null)]))],
    "api.crossref.org": [ok(crBody([crItem("10.5555/SHARED.1")]))],
  });
  assert.equal(await discoverCmd([dir, "q", "--engine", "openalex"], base({ fetch: f })), 0);
  assert.equal(await discoverCmd([dir, "q", "--engine", "crossref"], base({ fetch: f })), 0);
  const d = readDiscovered(dir);
  assert.equal(d.length, 2, "the shared DOI is one row; the DOI-less work is the other");
  assert.equal(d[0].key, "doi:10.5555/shared.1");
  assert.deepEqual(d[0].engines, ["openalex", "crossref"]);
  assert.equal(d[0].engine, "openalex", "`engine` stays the first engine, for readers of the old shape");
  assert.equal(d[0].id, "W9");
  assert.deepEqual(d[1].engines, ["openalex"]);
  const s = JSON.parse(readFileSync(path.join(dir, "searches.json"), "utf8"));
  assert.deepEqual(s.map((r) => [r.engine, r.hits]), [["openalex", 2], ["crossref", 1]], "hits count what each engine returned");
});

test("the same DOI in one multi-engine run is one row too", async () => {
  const dir = tmp();
  const f = stub({
    "api.openalex.org": [ok(oaBody([oaWork("W9", "10.5555/x.1")]))],
    "api.semanticscholar.org": [ok(JSON.stringify({ data: [] , total: 0 }))],
    "export.arxiv.org": [ok(fx("arxiv-empty.xml"))],
    "api.crossref.org": [ok(crBody([crItem("10.5555/x.1")]))],
  });
  assert.equal(await discoverCmd([dir, "q"], base({ fetch: f })), 0);
  const d = readDiscovered(dir);
  assert.equal(d.length, 1);
  assert.deepEqual(d[0].engines, ["openalex", "crossref"]);
});

test("a later engine fills a null or missing field but never overwrites a value", async () => {
  const dir = tmp();
  const f = stub({
    "api.openalex.org": [ok(oaBody([oaWork("W9", "10.5555/fill.1", { display_name: "First title", primary_location: { source: { display_name: "Venue One", type: "journal" } } })]))],
    "api.crossref.org": [ok(crBody([crItem("10.5555/fill.1", { title: ["Second title"], "container-title": ["Venue Two"], abstract: "<jats:p>Only crossref has this.</jats:p>" })]))],
  });
  await discoverCmd([dir, "q", "--engine", "openalex"], base({ fetch: f }));
  assert.equal("abstract" in readDiscovered(dir)[0], false, "precondition: the first engine has no abstract");
  await discoverCmd([dir, "q", "--engine", "crossref"], base({ fetch: f }));
  const [row] = readDiscovered(dir);
  assert.equal(row.abstract, "Only crossref has this.", "missing field filled");
  assert.equal(row.title, "First title", "a value is never overwritten");
  assert.equal(row.venue, "Venue One");
});

test("an old discovered.json with no key, engines or kind merges without duplicates", async () => {
  const dir = tmp();
  const old = [
    { engine: "openalex", id: "W111", doi: "10.1000/alpha.1", title: "Screening with agents", year: 2024, venue: "Journal of Review Methods", is_peer_reviewed_hint: true, oa_url: "https://example.org/alpha.pdf" },
    { engine: "arxiv", id: "2401.00001v1", doi: null, title: "Old arxiv", year: 2024, venue: "arXiv", is_peer_reviewed_hint: false, oa_url: null },
  ];
  writeFileSync(path.join(dir, "discovered.json"), JSON.stringify(old));
  const f = stub({ "api.openalex.org": [ok(fx("openalex.json"))], "export.arxiv.org": [ok(`<feed><entry><id>http://arxiv.org/abs/2401.00001v2</id><title>Old arxiv</title><summary>S</summary></entry></feed>`)] });
  assert.equal(await discoverCmd([dir, "q", "--engine", "openalex"], base({ fetch: f })), 0);
  assert.equal(await discoverCmd([dir, "q", "--engine", "arxiv"], base({ fetch: f })), 0);
  const d = readDiscovered(dir);
  assert.equal(d.length, 3, "openalex.json's two works plus the old arXiv row; nothing twice");
  assert.deepEqual(d[0].engines, ["openalex"]);
  assert.equal(d[0].key, "doi:10.1000/alpha.1");
  assert.equal(d[1].key, "arxiv:2401.00001", "an old arXiv row is keyed without its version");
  assert.deepEqual(d[1].engines, ["arxiv"], "the v2 re-find folds into the v1 row");
  assert.equal(d[1].abstract, "S");
});

test("key normalisation: DOI case, URL prefix, doi: prefix, arXiv version suffix, engine fallback", () => {
  assert.equal(recordKey({ engine: "openalex", id: "W1", doi: "10.1000/ABC.1" }), "doi:10.1000/abc.1");
  assert.equal(recordKey({ engine: "s2", id: "p", doi: "https://doi.org/10.1000/ABC.1" }), "doi:10.1000/abc.1");
  assert.equal(recordKey({ engine: "s2", id: "p", doi: "https://dx.doi.org/10.1000/abc.1" }), "doi:10.1000/abc.1");
  assert.equal(recordKey({ engine: "s2", id: "p", doi: "doi:10.1000/abc.1" }), "doi:10.1000/abc.1");
  assert.equal(recordKey({ engine: "arxiv", id: "2301.00001v3", doi: null }), "arxiv:2301.00001");
  assert.equal(recordKey({ engine: "arxiv", id: "hep-th/9901001v1", doi: null }), "arxiv:hep-th/9901001");
  assert.equal(recordKey({ engine: "s2", id: "abc123", doi: null }), "s2:abc123");
  assert.equal(recordKey({ engine: "openalex", id: "W2", doi: "" }), "openalex:W2");
});

test("every engine's rows carry kind, key and updated (an ISO date, or null)", async () => {
  const dir = tmp();
  const f = stub({
    "api.openalex.org": [ok(oaBody([oaWork("W1", null, { updated_date: "2025-03-04T05:06:07.000000" })]))],
    "api.semanticscholar.org": [ok(fx("s2.json"))], "export.arxiv.org": [ok(fx("arxiv.xml"))],
    "api.crossref.org": [ok(crBody([crItem("10.7777/k.1", { deposited: { "date-time": "2024-02-03T00:00:00Z" } })]))],
  });
  assert.equal(await discoverCmd([dir, "q"], base({ fetch: f })), 0);
  const d = readDiscovered(dir);
  for (const r of d) {
    assert.equal(r.kind, "paper");
    assert.match(r.key, /^(doi|arxiv|openalex|s2):/);
    assert.ok(r.updated === null || /^\d{4}-\d{2}-\d{2}$/.test(r.updated), `${r.key}: ${r.updated}`);
  }
  assert.equal(d.find((r) => r.id === "W1").updated, "2025-03-04");
  assert.equal(d.find((r) => r.engine === "crossref").updated, "2024-02-03");
  assert.equal(d.find((r) => r.engine === "s2").updated, null);
  assert.equal(d.find((r) => r.engine === "arxiv").key, "doi:10.3000/gamma", "an arXiv entry that states a DOI is keyed by it");
});

test("an arXiv hit folded into a DOI row is still found by its arXiv URL, through ids.arxiv", async () => {
  const dir = tmp();
  const feed = `<feed><entry><id>http://arxiv.org/abs/2401.00009v1</id><title>Shared paper</title><summary>S</summary>
<arxiv:doi>10.5555/Fold.1</arxiv:doi><link title="pdf" href="http://arxiv.org/pdf/2401.00009v1"/></entry></feed>`;
  const f = stub({
    "api.openalex.org": [ok(oaBody([oaWork("W9", "10.5555/fold.1", { open_access: { oa_url: "https://example.org/fold.pdf" } })]))],
    "export.arxiv.org": [ok(feed)],
  });
  await discoverCmd([dir, "q", "--engine", "openalex"], base({ fetch: f }));
  await discoverCmd([dir, "q", "--engine", "arxiv"], base({ fetch: f }));
  const d = readDiscovered(dir);
  assert.equal(d.length, 1);
  assert.deepEqual(d[0].engines, ["openalex", "arxiv"]);
  assert.deepEqual(d[0].ids, { openalex: "W9", arxiv: "2401.00009v1" });
  assert.equal(d[0].oa_url, "https://example.org/fold.pdf", "the first oa_url stays, so only ids.arxiv can match the arXiv URL");
  assert.equal(findDiscovered(["https://arxiv.org/pdf/2401.00009v2"], d), d[0]);
  const oldRow = { engine: "openalex", id: "W1", doi: "10.1/x", oa_url: null };
  writeFileSync(path.join(dir, "discovered.json"), JSON.stringify([oldRow]));
  await discoverCmd([dir, "q", "--engine", "openalex"], base({ fetch: f }));
  assert.deepEqual(readDiscovered(dir)[0].ids, { openalex: "W1" }, "an old row gets ids on read");
});
