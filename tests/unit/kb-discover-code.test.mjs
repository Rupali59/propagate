/**
 * `kb discover` code and skill engines and `--sources` (#400, epic #321 S2). Fixtures use the real field names of each
 * endpoint (confirmed live 2026-11-26) with invented values. No network: `inject.fetch` and `inject.gh` are stubs, and
 * one test runs the real gh transport against a fake `PROPAGATE_GH_BIN` script.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverCmd } from "../../lib/research/discover.mjs";
import { ALL_ENGINES, Malformed } from "../../lib/research/discover-engines.mjs";

const FIX = path.join(import.meta.dirname, "..", "fixtures", "discover");
const fx = (n) => readFileSync(path.join(FIX, n), "utf8");
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "discover-code-"));
const engine = (id) => ALL_ENGINES.find((e) => e.id === id);
const readDiscovered = (dir) => JSON.parse(readFileSync(path.join(dir, "discovered.json"), "utf8"));

function io() {
  const out = [];
  const err = [];
  return { out, err, log: (...a) => out.push(a.join(" ")), error: (...a) => err.push(a.join(" ")) };
}

function stub(routes) {
  const calls = [];
  const fn = async (url) => {
    const host = new URL(url).host;
    calls.push(host);
    const r = routes[host];
    if (!r) throw new Error(`stub: no route for ${host}`);
    return { status: r.status ?? 200, text: async () => r.body, headers: { get: () => null } };
  };
  fn.calls = calls;
  return fn;
}
const ghStub = (body) => {
  const calls = [];
  const fn = async (endpoint) => (calls.push(endpoint), { status: 200, text: async () => body, headers: { get: () => null } });
  fn.calls = calls;
  return fn;
};
const base = (extra = {}) => ({ io: io(), env: {}, stateDirPath: tmp(), sleep: async () => {}, now: () => Date.parse("2026-11-26T10:00:00Z"), ...extra });

test("github: parses a repo search response; key is gh:<lower-case owner/repo>, updated is pushed_at", () => {
  const rows = engine("github").parse(fx("github.json"));
  assert.deepEqual(rows[0], {
    engine: "github", id: "Example-Org/Widget-Kit", doi: null, title: "Example-Org/Widget-Kit", year: null, venue: "GitHub",
    is_peer_reviewed_hint: false, oa_url: null, url: "https://github.com/Example-Org/Widget-Kit", abstract: "A kit of widgets",
    kind: "repo", key: "gh:example-org/widget-kit", updated: "2026-11-20",
  });
  assert.equal("abstract" in rows[1], false, "a null description is no abstract");
  assert.equal(engine("github").minIntervalMs(false), 2100);
});

test("npm: parses a package search response; updated prefers package.date", () => {
  const rows = engine("npm").parse(fx("npm.json"));
  assert.equal(rows[0].key, "npm:widget-kit");
  assert.equal(rows[0].kind, "package");
  assert.equal(rows[0].updated, "2026-11-01");
  assert.equal(rows[0].abstract, "Widgets for tests");
  assert.equal(rows[1].updated, "2026-09-02", "falls back to the object's `updated`");
  assert.equal(rows[1].url, "https://www.npmjs.com/package/@sample/gizmo");
  assert.match(engine("npm").request({ query: "a b", limit: 7 }).url, /text=a\+b&size=7/);
});

test("skills: parses {skills:[...]}; key and url come from source and skillId, limit caps the list", () => {
  const rows = engine("skills").parse(fx("skills.json"), { limit: 2 });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].key, "skill:example-org/widget-kit/widget-skill");
  assert.equal(rows[0].url, "https://skills.sh/example-org/widget-kit/widget-skill");
  assert.equal(rows[0].kind, "skill");
  assert.equal(rows[0].updated, null);
});

test("plugins: filters client-side on repo, description and keywords, ranks by stars, keys by repo", () => {
  const rows = engine("plugins").parse(fx("plugins.json"), { query: "widget", limit: 10 });
  assert.deepEqual(rows.map((r) => r.id), ["sample-user/gizmo", "Example-Org/Widget-Kit"], "unrelated repo dropped, higher stars first");
  assert.equal(rows[1].key, "gh:example-org/widget-kit");
  assert.equal(rows[1].kind, "plugin-marketplace");
  assert.equal(rows[1].updated, "2026-11-24");
  assert.equal(engine("plugins").parse(fx("plugins.json"), { query: "widget", limit: 1 }).length, 1);
  assert.deepEqual(engine("plugins").parse(fx("plugins.json"), { query: "nomatchatall" }), [], "no match is an empty list, not an error");
});

test("mcp: parses servers[].server; updated comes from _meta when present", () => {
  const rows = engine("mcp").parse(fx("mcp.json"));
  assert.equal(rows[0].key, "mcp:example.test/widget-server");
  assert.equal(rows[0].title, "Widget Server");
  assert.equal(rows[0].kind, "mcp-server");
  assert.equal(rows[0].updated, "2026-11-06");
  assert.equal(rows[0].url, "https://example.test/widget");
  assert.equal(rows[1].updated, null);
  assert.equal(rows[1].title, "example.test/bare");
});

test("every new engine throws Malformed on a body that is not its shape, and on a row without its identity", () => {
  const bad = {
    github: ["not json", "{}", '{"items":[{"html_url":"x"}]}'],
    npm: ["not json", "{}", '{"objects":[{"package":{}}]}'],
    skills: ["not json", "{}", '{"skills":[{"source":"a/b"}]}'],
    plugins: ["not json", "{}", '[{"stars":1}]'],
    mcp: ["not json", "{}", '{"servers":[{"server":{}}]}'],
  };
  for (const [id, bodies] of Object.entries(bad)) {
    for (const b of bodies) assert.throws(() => engine(id).parse(b, { query: "q", limit: 5 }), Malformed, `${id}: ${b}`);
  }
});

test("a malformed body from one engine gives exit 2, names the engine, and the others' rows are still written", async () => {
  const dir = tmp();
  const t = base({ fetch: stub({ "registry.npmjs.org": { body: '{"nope":1}' } }), gh: ghStub(fx("github.json")) });
  const code = await discoverCmd([dir, "widget", "--sources", "code"], t);
  assert.equal(code, 2);
  assert.ok(t.io.err.some((l) => /^DISCOVER_MALFORMED: npm: error: could not understand the response/.test(l)), t.io.err.join("\n"));
  assert.deepEqual(readDiscovered(dir).map((r) => r.engine), ["github", "github"]);
});

test("a github repo and a marketplace for the same repo dedupe to one row", async () => {
  const dir = tmp();
  const t = base({ gh: ghStub(fx("github.json")), fetch: stub({ "claudemarketplaces.com": { body: fx("plugins.json") } }) });
  assert.equal(await discoverCmd([dir, "widget", "--engine", "github"], t), 0);
  assert.equal(await discoverCmd([dir, "widget", "--engine", "plugins"], t), 0);
  const d = readDiscovered(dir);
  const rows = d.filter((r) => r.key === "gh:example-org/widget-kit");
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].engines, ["github", "plugins"]);
  assert.equal(rows[0].kind, "repo", "the first engine's kind wins");
  assert.equal(d.length, 2, "Widget-Kit plus sample-user/gizmo (gizmo appears in both sources too)");
});

test("--sources skills runs exactly skills, plugins and mcp", async () => {
  const dir = tmp();
  const f = stub({ "skills.sh": { body: fx("skills.json") }, "claudemarketplaces.com": { body: fx("plugins.json") }, "registry.modelcontextprotocol.io": { body: fx("mcp.json") } });
  const gh = ghStub(fx("github.json"));
  assert.equal(await discoverCmd([dir, "widget", "--sources", "skills"], base({ fetch: f, gh })), 0);
  assert.deepEqual([...f.calls].sort(), ["claudemarketplaces.com", "registry.modelcontextprotocol.io", "skills.sh"]);
  assert.equal(gh.calls.length, 0);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "searches.json"), "utf8")).map((s) => s.engine), ["skills", "plugins", "mcp"]);
});

test("with no --sources or --engine only the academic engines run; --sources code,skills and all pick the groups", async () => {
  const f = stub({});
  const gh0 = ghStub("{}");
  const t = base({ fetch: f, gh: gh0 });
  assert.equal(await discoverCmd([tmp(), "q"], t), 2);
  assert.deepEqual(f.calls, ["api.openalex.org", "api.semanticscholar.org", "export.arxiv.org", "api.crossref.org"]);
  assert.equal(gh0.calls.length, 0, "github is not in the academic group");
  const g = ghStub(fx("github.json"));
  const f2 = stub({ "registry.npmjs.org": { body: fx("npm.json") }, "skills.sh": { body: fx("skills.json") }, "claudemarketplaces.com": { body: fx("plugins.json") }, "registry.modelcontextprotocol.io": { body: fx("mcp.json") } });
  assert.equal(await discoverCmd([tmp(), "widget", "--sources", "code,skills"], base({ fetch: f2, gh: g })), 0);
  assert.deepEqual([...f2.calls].sort(), ["claudemarketplaces.com", "registry.modelcontextprotocol.io", "registry.npmjs.org", "skills.sh"]);
  assert.equal(g.calls.length, 1);
});

test("--sources rejects an unknown group; --engine still works for a new engine", async () => {
  const t = base();
  assert.equal(await discoverCmd([tmp(), "q", "--sources", "code,bogus"], t), 2);
  assert.match(t.io.err.join("\n"), /--sources must be a comma list of academic, code, skills, all, got "bogus"/);
  const dir = tmp();
  assert.equal(await discoverCmd([dir, "widget", "--engine", "npm"], base({ fetch: stub({ "registry.npmjs.org": { body: fx("npm.json") } }) })), 0);
  assert.equal(readDiscovered(dir)[0].engine, "npm");
});

test("the github request goes through gh api with the query encoded and the limit as per_page", async () => {
  const g = ghStub(fx("github.json"));
  await discoverCmd([tmp(), "agent skills", "--engine", "github", "--limit", "5"], base({ gh: g }));
  assert.deepEqual(g.calls, ["search/repositories?q=agent%20skills&per_page=5"]);
});

test("the real gh transport runs the PROPAGATE_GH_BIN binary, and a missing binary is a named failure", async () => {
  const dir = tmp();
  const bin = path.join(tmp(), "fake-gh.sh");
  writeFileSync(bin, `#!/bin/sh\n[ "$1" = api ] || exit 9\ncat <<'EOF'\n${fx("github.json")}\nEOF\n`);
  chmodSync(bin, 0o755);
  assert.equal(await discoverCmd([dir, "widget", "--engine", "github"], base({ env: { PROPAGATE_GH_BIN: bin } })), 0);
  assert.equal(readDiscovered(dir)[0].key, "gh:example-org/widget-kit");
  const t = base({ env: { PROPAGATE_GH_BIN: path.join(tmp(), "no-such-gh") } });
  assert.equal(await discoverCmd([tmp(), "widget", "--engine", "github"], t), 2);
  assert.match(t.io.err.join("\n"), /DISCOVER_NETWORK: github: error: request failed \(.*is not installed\)/);
});
