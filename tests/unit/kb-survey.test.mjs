/**
 * `kb survey` and `kb survey verify` (#401, epic #321 S3). No network: `inject.fetch` (discover), `inject.gh` and
 * `inject.fetchImpl` (fetch) are stubs. The safety test snapshots every file under a temp state dir and a fake hub
 * before and after (rule:safety-flag-needs-a-test): the unsafe path is "writes outside the survey folder and the
 * body store", so the side effect is measured, not the output.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { kbCmd } from "../../cli/kb.mjs";
import { slugify } from "../../lib/research/survey.mjs";

const FIX = path.join(import.meta.dirname, "..", "fixtures", "discover");
const fx = (n) => readFileSync(path.join(FIX, n), "utf8");
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "survey-"));
const NOW = Date.parse("2026-11-26T10:00:00Z");

function io() {
  const out = [];
  const err = [];
  return { out, err, log: (...a) => out.push(a.join(" ")), error: (...a) => err.push(a.join(" ")) };
}

/** host -> {status, body}; an unknown host throws, like a dead network. */
function stub(routes) {
  const fn = async (url) => {
    const r = routes[new URL(url).host];
    if (!r) throw new Error(`stub: no route for ${new URL(url).host}`);
    return { status: r.status ?? 200, text: async () => r.body, headers: { get: () => null } };
  };
  return fn;
}
const ghStub = (body) => async () => ({ status: 200, text: async () => body, headers: { get: () => null } });

// Both packages mention the query term, so npm's relevance filter (2 of 3+ terms, or all of 1-2) keeps both; these
// tests are about survey's exit codes and --fetch, not npm ranking, which kb-discover-code.test.mjs covers.
const NPM_OK = {
  "registry.npmjs.org": {
    body: JSON.stringify({
      objects: [
        { searchScore: 2, updated: "2026-11-25T10:00:00.000Z", package: { name: "widget-kit", description: "Widgets for tests", date: "2026-11-01T00:00:00.000Z", links: { npm: "https://www.npmjs.com/package/widget-kit" } } },
        { searchScore: 1, updated: "2026-09-02T10:00:00.000Z", package: { name: "@sample/gizmo", description: "A widget gizmo", date: null } },
      ],
      total: 2,
    }),
  },
};
const NPM_EMPTY = { "registry.npmjs.org": { body: '{"objects":[]}' } };
const NPM_DOWN = { "registry.npmjs.org": { status: 500, body: "" } };

function base(extra = {}) {
  return { io: io(), env: {}, stateDirPath: tmp(), contact: null, sleep: async () => {}, now: () => NOW, ...extra };
}
const survey = async (args, inject) => {
  const code = await kbCmd(["survey", ...args], inject);
  return { code, out: inject.io.out.join("\n"), err: inject.io.err.join("\n") };
};
const jsonOf = (r) => JSON.parse(r.out);

test("survey --json: every field of the documented shape is present", async () => {
  const dir = tmp();
  const inj = base({ fetch: stub(NPM_OK), gh: ghStub(fx("github.json")) });
  const r = await survey(["widget", "--sources", "code", "--json", "--dir", dir], inj);
  assert.equal(r.code, 0);
  const j = jsonOf(r);
  assert.deepEqual(Object.keys(j), ["question", "dir", "sources_run", "sources_failed", "items", "counts"]);
  assert.equal(j.question, "widget");
  assert.equal(j.dir, dir);
  assert.deepEqual(j.sources_run, ["github", "npm"]);
  assert.deepEqual(j.sources_failed, []);
  assert.ok(j.items.length >= 3);
  for (const it of j.items) {
    assert.deepEqual(Object.keys(it).sort(), ["engines", "key", "kind", "title", "updated", "url"]);
    assert.ok(it.key && it.kind && it.title && Array.isArray(it.engines) && it.engines.length);
  }
  const npm = j.items.find((i) => i.key === "npm:widget-kit");
  assert.equal(npm.kind, "package");
  assert.equal(npm.url, "https://www.npmjs.com/package/widget-kit");
  assert.equal(npm.updated, "2026-11-01");
  assert.equal(j.counts.items, j.items.length);
  assert.deepEqual(Object.keys(j.counts), ["items", "by_kind"]);
  assert.equal(Object.values(j.counts.by_kind).reduce((a, b) => a + b, 0), j.items.length);
});

test("survey: the default directory is <state>/kb/surveys/<date>-<slug of the question, at most 60 chars>", async () => {
  const inj = base({ fetch: stub(NPM_OK) });
  const q = "An Existing Claude Skill for Literature Review: what is there, and is it good enough to adopt?";
  const r = await survey([q, "--engine", "npm", "--json"], inj);
  const j = jsonOf(r);
  const leaf = path.basename(j.dir);
  assert.equal(path.dirname(j.dir), path.join(inj.stateDirPath, "kb", "surveys"));
  assert.match(leaf, /^2026-11-26-[a-z0-9-]+$/);
  assert.ok(leaf.length - "2026-11-26-".length <= 60);
  assert.equal(slugify("   "), "survey");
  assert.equal(slugify("x".repeat(80)).length, 60);
});

test("survey: the default is --sources all, broader than discover's academic default", async () => {
  const hosts = [];
  const f = async (url) => (hosts.push(new URL(url).host), { status: 200, text: async () => "{}", headers: { get: () => null } });
  const inj = base({ fetch: f, gh: ghStub("{}") });
  const r = await survey(["widget", "--json", "--dir", tmp()], inj);
  const j = jsonOf(r);
  assert.equal(j.sources_failed.length + j.sources_run.length, 10, "all ten engines were asked (academic 4, code 2, skills 4 with clihub)");
  assert.ok(hosts.includes("registry.npmjs.org") && hosts.includes("api.openalex.org"));
});

test("exit 0: at least one item and no source failed", async () => {
  const r = await survey(["widget", "--engine", "npm", "--dir", tmp()], base({ fetch: stub(NPM_OK) }));
  assert.equal(r.code, 0);
  assert.match(r.out, /^package {2}npm:widget-kit {2}widget-kit/m);
  assert.match(r.out, /2 item\(s\) \(package 2\) from 1 source\(s\)/);
});

test("exit 1: no item and no source failed, stated as 0 items from the sources asked", async () => {
  const r = await survey(["widget", "--engine", "npm", "--json", "--dir", tmp()], base({ fetch: stub(NPM_EMPTY) }));
  assert.equal(r.code, 1);
  const j = jsonOf(r);
  assert.deepEqual(j.sources_failed, []);
  assert.deepEqual(j.sources_run, ["npm"]);
  assert.equal(j.counts.items, 0);
});

test("exit 2: a failed source is named in sources_failed and the other source's items are still printed", async () => {
  const inj = base({ fetch: stub(NPM_DOWN), gh: ghStub(fx("github.json")) });
  const r = await survey(["widget", "--sources", "code", "--json", "--dir", tmp()], inj);
  assert.equal(r.code, 2, "a failed source must exit 2");
  const j = jsonOf(r);
  assert.equal(j.sources_failed.length, 1);
  assert.equal(j.sources_failed[0].engine, "npm");
  assert.equal(j.sources_failed[0].code, "DISCOVER_HTTP");
  assert.match(j.sources_failed[0].message, /HTTP 500/);
  assert.deepEqual(j.sources_run, ["github"]);
  assert.ok(j.items.length > 0 && j.items.every((i) => i.engines.includes("github")), "partial items survive the failure");
  assert.notEqual(j.counts.items, 0);
});

test("exit 2: a failure alone is never 0 items (exit 2, not 1)", async () => {
  const r = await survey(["widget", "--engine", "npm", "--json", "--dir", tmp()], base({ fetch: stub(NPM_DOWN) }));
  assert.equal(r.code, 2);
  const j = jsonOf(r);
  assert.equal(j.counts.items, 0);
  assert.equal(j.sources_failed[0].engine, "npm");
});

test("exit 2: text mode names the failure on stderr", async () => {
  const r = await survey(["widget", "--engine", "npm", "--dir", tmp()], base({ fetch: stub(NPM_DOWN) }));
  assert.equal(r.code, 2);
  assert.match(r.err, /DISCOVER_HTTP: error: npm: npm: error: HTTP 500/);
});

test("exit 2: usage errors, an unwritable folder, a bad engine", async () => {
  for (const args of [[], ["a", "b"], ["widget", "--bogus"], ["widget", "--limit"], ["widget", "--timeout", "0"]]) {
    const r = await survey([...args, "--json"], base());
    assert.equal(r.code, 2, JSON.stringify(args));
    assert.equal(jsonOf(r).code, "SURVEY_USAGE");
  }
  const file = path.join(tmp(), "afile");
  writeFileSync(file, "x");
  const r = await survey(["widget", "--engine", "npm", "--dir", file, "--json"], base({ fetch: stub(NPM_OK) }));
  assert.equal(r.code, 2);
  assert.equal(jsonOf(r).code, "SURVEY_STORE");
  const e = await survey(["widget", "--engine", "nope", "--json", "--dir", tmp()], base());
  assert.equal(e.code, 2);
  assert.equal(jsonOf(e).sources_failed[0].code, "DISCOVER_USAGE");
});

test("--timeout: sources that never finish are reported failed as SURVEY_TIMEOUT, exit 2", async () => {
  const never = () => new Promise(() => {});
  const r = await survey(["widget", "--engine", "npm", "--timeout", "0.05", "--json", "--dir", tmp()], base({ fetch: never }));
  assert.equal(r.code, 2);
  const j = jsonOf(r);
  assert.deepEqual(j.sources_failed.map((f) => [f.engine, f.code]), [["npm", "SURVEY_TIMEOUT"]]);
  assert.equal(j.counts.items, 0);
});

test("--fetch: body_path only on ok items; the rest say not_retrieved with a reason", async () => {
  const inj = base({
    fetch: stub(NPM_OK),
    fetchImpl: async (url) => {
      const u = new URL(url);
      const send = (status, type, body) => ({ status, headers: { get: (h) => (h.toLowerCase() === "content-type" ? type : null) }, arrayBuffer: async () => Buffer.from(body), text: async () => body });
      if (u.pathname === "/robots.txt") return send(404, "text/plain", "");
      if (u.pathname.endsWith("widget-kit")) return send(200, "text/html", "<html><body><p>Widget Kit builds widgets for testing purposes, with a long enough body to read.</p></body></html>");
      return send(403, "text/plain", "no");
    },
  });
  const r = await survey(["widget", "--engine", "npm", "--fetch", "--json", "--dir", tmp()], inj);
  assert.equal(r.code, 0);
  const j = jsonOf(r);
  const ok = j.items.find((i) => i.key === "npm:widget-kit");
  const bad = j.items.find((i) => i.key === "npm:@sample/gizmo");
  assert.equal(ok.status, "ok");
  assert.match(ok.body_path, new RegExp(`^${path.join(inj.stateDirPath, "kb", "fetched").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[0-9a-f]{64}$`));
  assert.match(readFileSync(ok.body_path, "utf8"), /Widget Kit builds widgets/);
  assert.equal(bad.status, "not_retrieved");
  assert.equal(bad.reason, "http_403");
  assert.ok(!("body_path" in bad), "no body_path on a not_retrieved item");
  assert.deepEqual(j.counts, { items: 2, by_kind: { package: 2 }, fetched_ok: 1, not_retrieved: 1 });
});

function snapshot(root) {
  const m = new Map();
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else m.set(p, `${statSync(p).size}:${readFileSync(p, "utf8")}`);
    }
  };
  walk(root);
  return m;
}

test("safety: a survey (with --fetch) writes nothing outside its own folder and the body store", async () => {
  const state = tmp();
  const hub = tmp();
  mkdirSync(path.join(hub, "propagation", "state"), { recursive: true });
  writeFileSync(path.join(hub, "propagation", "state", "STATE.md"), "hub state\n");
  writeFileSync(path.join(hub, "CLAUDE.md"), "hub rules\n");
  mkdirSync(path.join(state, "kb"), { recursive: true });
  writeFileSync(path.join(state, "kb", "references.yml"), "existing: knowledge base\n");
  writeFileSync(path.join(state, "events.jsonl"), '{"event":"prior"}\n');
  const beforeState = snapshot(state);
  const beforeHub = snapshot(hub);
  const cwd = process.cwd();
  process.chdir(hub);
  let r;
  try {
    const inj = base({
      stateDirPath: state,
      env: { PROPAGATE_STATE_DIR: state },
      fetch: stub(NPM_OK),
      gh: ghStub(fx("github.json")),
      fetchImpl: async (url) => ({ status: new URL(url).pathname === "/robots.txt" ? 404 : 200, headers: { get: () => "text/plain" }, arrayBuffer: async () => Buffer.from("A plain body that is long enough to count as readable text."), text: async () => "" }),
    });
    r = await survey(["safety question", "--sources", "code", "--fetch", "--json"], inj);
  } finally {
    process.chdir(cwd);
  }
  assert.equal(r.code, 0);
  const run = jsonOf(r).dir;
  assert.equal(path.dirname(run), path.join(state, "kb", "surveys"));
  assert.deepEqual([...snapshot(hub)], [...beforeHub], "the hub must be byte-identical");
  const after = snapshot(state);
  const allowed = (p) => p.startsWith(run + path.sep) || p.startsWith(path.join(state, "kb", "fetched") + path.sep) || p === path.join(state, "kb", "discover-last-request.json");
  const changed = [...after.keys()].filter((p) => before(p) !== after.get(p));
  function before(p) { return beforeState.get(p); }
  assert.ok(changed.length >= 3, `the survey did write (${changed.length} files changed); a snapshot of nothing proves nothing`);
  assert.deepEqual(changed.filter((p) => !allowed(p)), [], "nothing outside the survey folder, the body store and discover's request-time file may change");
  for (const p of beforeState.keys()) assert.equal(after.get(p), beforeState.get(p), `${p} was pre-existing and must be untouched`);
});

// ---- verify --------------------------------------------------------------------------------------------------

const BODY = "Retrieval augmented generation reduces hallucinated citations in long documents when the sources are read directly.";
function claimsFile(state, { sha = true } = {}) {
  const store = path.join(state, "kb", "fetched");
  mkdirSync(store, { recursive: true });
  const sha256 = "a".repeat(64);
  writeFileSync(path.join(store, sha256), BODY);
  const bodyPath = path.join(state, "body.txt");
  writeFileSync(bodyPath, BODY);
  const f = path.join(state, "claims.json");
  writeFileSync(f, JSON.stringify({
    claims: [
      { text: "RAG reduces fake citations", quotes: [
        { text: "reduces hallucinated citations in long documents", body_path: bodyPath },
        ...(sha ? [{ text: "Retrieval augmented generation reduces hallucinated citations", sha256 }] : []),
      ] },
    ],
  }));
  return { f, bodyPath, sha256 };
}
const verify = async (args, inject) => (inject.io.out.length = inject.io.err.length = 0, { code: await kbCmd(["survey", "verify", ...args], inject), out: inject.io.out.join("\n"), err: inject.io.err.join("\n") });

test("verify: ok quotes (by body_path and by sha256) exit 0 and write nothing", async () => {
  const inj = base();
  const { f } = claimsFile(inj.stateDirPath);
  const before = snapshot(inj.stateDirPath);
  const r = await verify([f, "--json"], inj);
  assert.equal(r.code, 0);
  const j = JSON.parse(r.out);
  assert.equal(j.results.length, 2);
  assert.ok(j.results.every((x) => x.ok === true && !("reason" in x)));
  assert.deepEqual(Object.keys(j.results[0]), ["claim", "quote", "ok"]);
  assert.deepEqual([...snapshot(inj.stateDirPath)], [...before], "verify is pure");
});

test("verify: too_short, too_long, not_found and body_missing are each named, exit 1", async () => {
  const inj = base();
  const { bodyPath } = claimsFile(inj.stateDirPath);
  const f = path.join(inj.stateDirPath, "bad.json");
  writeFileSync(f, JSON.stringify({ claims: [{ text: "c", quotes: [
    { text: "reduces hallucinated", body_path: bodyPath },
    { text: Array.from({ length: 20 }, (_, i) => `word${i}`).join(" "), body_path: bodyPath },
    { text: "this sentence is not anywhere in the saved body", body_path: bodyPath },
    { text: "reduces hallucinated citations in long documents", body_path: path.join(inj.stateDirPath, "missing.txt") },
    { text: "reduces hallucinated citations in long documents", sha256: "b".repeat(64) },
  ] }] }));
  const r = await verify([f, "--json"], inj);
  assert.equal(r.code, 1);
  assert.deepEqual(JSON.parse(r.out).results.map((x) => x.reason), ["too_short", "too_long", "not_found", "body_missing", "body_missing"]);
  const t = await verify([f], inj);
  assert.equal(t.code, 1);
  assert.match(t.out, /not_found/);
});

test("verify: unreadable or malformed input exits 2", async () => {
  const inj = base();
  const f = path.join(inj.stateDirPath, "nope.json");
  assert.equal((await verify([f, "--json"], inj)).code, 2);
  writeFileSync(f, "not json");
  assert.equal((await verify([f, "--json"], inj)).code, 2);
  writeFileSync(f, JSON.stringify({ claims: [{ text: "c", quotes: [{ text: "x" }] }] }));
  const r = await verify([f, "--json"], inj);
  assert.equal(r.code, 2);
  assert.equal(JSON.parse(r.out).code, "SURVEY_INPUT");
  assert.equal((await verify([], inj)).code, 2);
});
