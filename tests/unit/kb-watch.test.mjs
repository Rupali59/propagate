/**
 * `kb watch add|list|check|mark|rm` (#402, epic #321 S4). No network: `inject.fetch` and `inject.gh` are stubs.
 * The safety test is rule:safety-flag-needs-a-test applied to "check is pure": the unsafe path is "check writes", so
 * every byte under the temp state dir is snapshotted before and after, and check is run over every kind of watch.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { kbCmd } from "../../cli/kb.mjs";
import { githubReleases, pypiReleases, genericFeed } from "../../lib/research/watch.mjs";
import { Malformed } from "../../lib/research/discover-engines.mjs";

const FX = path.join(import.meta.dirname, "..", "fixtures");
const fx = (...p) => readFileSync(path.join(FX, ...p), "utf8");
const NOW = Date.parse("2026-11-27T10:00:00Z");
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "watch-"));

function io() {
  const out = [];
  const err = [];
  return { out, err, log: (...a) => out.push(a.join(" ")), error: (...a) => err.push(a.join(" ")) };
}
function stub(routes, seen = []) {
  return async (url) => {
    const u = new URL(url);
    seen.push(url);
    const r = routes[u.host];
    if (!r) throw new Error(`stub: no route for ${u.host}`);
    return { status: r.status ?? 200, text: async () => r.body, headers: { get: () => null } };
  };
}
const ghStub = (body, seen = []) => async (endpoint) => {
  seen.push(endpoint);
  return { status: 200, text: async () => body, headers: { get: () => null } };
};
const base = (extra = {}) => ({ io: io(), env: {}, stateDirPath: tmp(), contact: null, sleep: async () => {}, now: () => NOW, ...extra });
const watch = async (args, inj) => {
  const code = await kbCmd(["watch", ...args], inj);
  return { code, out: inj.io.out.join("\n"), err: inj.io.err.join("\n") };
};
const fresh = (inj) => ({ ...inj, io: io() });
const SKILLS = { "skills.sh": { body: fx("discover", "skills.json") } };

/** path -> bytes for every file under `dir`. */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = path.join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out[p] = readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return out;
}
const storePath = (inj, name) => path.join(inj.stateDirPath, "kb", "watch", `${name}.json`);

test("add, then check, mark --all-new, check again: N new, then 0 new", async () => {
  const inj = base({ fetch: stub(SKILLS) });
  assert.equal((await watch(["add", "t", "--query", "widget", "--sources", "skills"], inj)).code, 0);
  // only the skills.sh route exists in the stub; keep the watch to that one engine
  const store = JSON.parse(readFileSync(storePath(inj, "t"), "utf8"));
  store.sources = ["skills"];
  writeFileSync(storePath(inj, "t"), JSON.stringify(store));

  const a = await watch(["check", "t", "--json"], fresh(inj));
  assert.equal(a.code, 0, a.err);
  const ja = JSON.parse(a.out);
  assert.equal(ja.watches[0].counts.new, 3);
  assert.deepEqual(ja.watches[0].new.map((i) => i.key).sort(), ["skill:example-org/widget-kit/widget-skill", "skill:sample-user/gizmo/gizmo-helper", "skill:third-org/third/third-skill"]);

  const m = await watch(["mark", "t", "--all-new", "--json"], fresh(inj));
  assert.equal(m.code, 0, m.err);
  assert.equal(JSON.parse(m.out).marked.length, 3);

  const b = await watch(["check", "t", "--json"], fresh(inj));
  const jb = JSON.parse(b.out);
  assert.equal(b.code, 0);
  assert.equal(jb.watches[0].counts.new, 0);
  assert.equal(jb.watches[0].counts.already_seen, 3);
  assert.equal(jb.counts.new, 0);
});

test("mark <key> marks exactly that key, and leaves the cursor alone", async () => {
  const inj = base({ fetch: stub(SKILLS) });
  await watch(["add", "t", "--query", "widget", "--sources", "skills"], inj);
  const store = JSON.parse(readFileSync(storePath(inj, "t"), "utf8"));
  store.sources = ["skills"];
  writeFileSync(storePath(inj, "t"), JSON.stringify(store));
  const r = await watch(["mark", "t", "skill:third-org/third/third-skill"], fresh(inj));
  assert.equal(r.code, 0);
  const after = JSON.parse(readFileSync(storePath(inj, "t"), "utf8"));
  assert.deepEqual(Object.keys(after.seen), ["skill:third-org/third/third-skill"]);
  assert.deepEqual(after.cursor, {});
  const c = JSON.parse((await watch(["check", "t", "--json"], fresh(inj))).out);
  assert.equal(c.watches[0].counts.new, 2);
});

test("check is PURE: every byte under the state dir is identical before and after, for every watch kind", async () => {
  const ghSeen = [];
  const inj = base({
    fetch: stub({ "skills.sh": SKILLS["skills.sh"], "pypi.org": { body: fx("watch", "pypi-releases.xml") }, "example.test": { body: fx("watch", "feed-atom.xml") } }),
    gh: ghStub(fx("watch", "gh-releases.json"), ghSeen),
  });
  await watch(["add", "q", "--query", "widget", "--sources", "skills"], inj);
  await watch(["add", "r", "--repo", "example-org/widget-kit"], inj);
  await watch(["add", "p", "--pypi", "widget-kit"], inj);
  await watch(["add", "f", "--feed", "https://example.test/feed.atom"], inj);
  for (const n of ["q"]) {
    const s = JSON.parse(readFileSync(storePath(inj, n), "utf8"));
    s.sources = ["skills"];
    writeFileSync(storePath(inj, n), JSON.stringify(s));
  }
  const before = snapshot(inj.stateDirPath);
  assert.equal(Object.keys(before).length, 4, "the snapshot must see the four stores, or this test is blind");
  for (const args of [["check"], ["check", "q"], ["check", "r"], ["check", "p"], ["check", "f", "--json"]]) {
    const r = await watch(args, fresh(inj));
    assert.equal(r.code, 0, `${args.join(" ")}: ${r.err}`);
    assert.deepEqual(snapshot(inj.stateDirPath), before, `kb watch ${args.join(" ")} must not touch the state dir`);
  }
  assert.ok(ghSeen.length >= 1, "the github path really ran");
});

test("the purity test goes red when check writes: the mutation is real", async () => {
  // A check that advanced the cursor would change the store's bytes; prove snapshot() sees such a write.
  const inj = base({ fetch: stub(SKILLS) });
  await watch(["add", "q", "--query", "widget", "--sources", "skills"], inj);
  const before = snapshot(inj.stateDirPath);
  const s = JSON.parse(readFileSync(storePath(inj, "q"), "utf8"));
  s.cursor.skills = "2026-11-27";
  writeFileSync(storePath(inj, "q"), JSON.stringify(s));
  assert.notDeepEqual(snapshot(inj.stateDirPath), before);
});

test("a corrupt store exits 2, names the file, and is left byte-for-byte untouched by every subcommand", async () => {
  const inj = base({ fetch: stub(SKILLS) });
  const file = storePath(inj, "bad");
  mkdirSync(path.dirname(file), { recursive: true });
  const CORRUPT = '{"query": "widget", "sources": ["skills"], "targets": [], "cursor": {}, "seen": {';
  writeFileSync(file, CORRUPT);
  for (const args of [["check", "bad"], ["mark", "bad", "k1"], ["mark", "bad", "--all-new"], ["list"], ["add", "bad", "--query", "x"]]) {
    const r = await watch(args, fresh(inj));
    assert.equal(r.code, 2, `${args.join(" ")} should exit 2`);
    assert.equal(readFileSync(file, "utf8"), CORRUPT, `${args.join(" ")} must not overwrite an unreadable store`);
  }
  const r = await watch(["check", "bad"], fresh(inj));
  assert.match(r.err, /WATCH_STORE: error/);
  assert.ok(r.err.includes(file));
  // a well-formed JSON that is not a store is also unreadable
  writeFileSync(file, '{"seen": []}');
  assert.equal((await watch(["check", "bad"], fresh(inj))).code, 2);
  assert.equal(readFileSync(file, "utf8"), '{"seen": []}');
});

test("rm of a missing watch is refused (exit 2) and removes nothing; rm of a real one removes it", async () => {
  const inj = base();
  await watch(["add", "keep", "--pypi", "widget-kit"], inj);
  const before = snapshot(inj.stateDirPath);
  const r = await watch(["rm", "nope"], fresh(inj));
  assert.equal(r.code, 2);
  assert.match(r.err, /WATCH_MISSING/);
  assert.deepEqual(snapshot(inj.stateDirPath), before);
  assert.equal((await watch(["rm", "keep"], fresh(inj))).code, 0);
  assert.deepEqual(snapshot(inj.stateDirPath), {});
});

test("add never overwrites an existing watch; a name cannot escape the watch folder", async () => {
  const inj = base();
  assert.equal((await watch(["add", "w", "--pypi", "widget-kit"], inj)).code, 0);
  const before = snapshot(inj.stateDirPath);
  const again = await watch(["add", "w", "--pypi", "other"], fresh(inj));
  assert.equal(again.code, 2);
  assert.match(again.err, /WATCH_EXISTS/);
  assert.deepEqual(snapshot(inj.stateDirPath), before);
  for (const bad of ["../escape", "a/b", ".hidden", ""]) assert.equal((await watch(["add", bad, "--pypi", "x"], fresh(inj))).code, 2, `name ${JSON.stringify(bad)}`);
  assert.deepEqual(snapshot(inj.stateDirPath), before);
});

test("add usage: needs a source of change, rejects bad values", async () => {
  for (const args of [["add", "w"], ["add", "w", "--sources", "skills"], ["add", "w", "--query", "x", "--sources", "nope"], ["add", "w", "--repo", "notarepo"], ["add", "w", "--feed", "ftp://x/y"], ["add", "w", "--pypi", "bad name"], ["bogus"], []]) {
    const inj = base();
    const r = await watch(args, inj);
    assert.equal(r.code, 2, args.join(" "));
    assert.deepEqual(snapshot(inj.stateDirPath), {}, `${args.join(" ")} must write nothing`);
  }
});

test("list shows each watch and its seen count", async () => {
  const inj = base();
  await watch(["add", "a", "--query", "widget", "--sources", "code"], inj);
  await watch(["add", "b", "--repo", "example-org/widget-kit"], inj);
  const j = JSON.parse((await watch(["list", "--json"], fresh(inj))).out);
  assert.deepEqual(j.watches.map((w) => w.name), ["a", "b"]);
  assert.deepEqual(j.watches[0].sources, ["github", "npm"]);
  assert.deepEqual(j.watches[1].targets, [{ type: "repo", ref: "example-org/widget-kit" }]);
  assert.equal(j.watches[0].seen, 0);
});

// ---------------------------------------------------------------- native since

test("the native since: the MCP registry gets updated_since, GitHub gets pushed:>=, plugins are filtered by lastUpdated", async () => {
  const urls = [];
  const gh = [];
  const inj = base({
    fetch: stub({ "registry.modelcontextprotocol.io": { body: fx("discover", "mcp.json") }, "claudemarketplaces.com": { body: fx("discover", "plugins.json") } }, urls),
    gh: ghStub(fx("discover", "github.json"), gh),
  });
  await watch(["add", "s", "--query", "widget", "--sources", "code"], inj);
  const s = JSON.parse(readFileSync(storePath(inj, "s"), "utf8"));
  s.sources = ["github", "mcp", "plugins"];
  s.cursor = { github: "2026-11-01", mcp: "2026-11-01", plugins: "2026-11-15" };
  writeFileSync(storePath(inj, "s"), JSON.stringify(s));
  const r = await watch(["check", "s", "--json"], fresh(inj));
  assert.equal(r.code, 0, r.err);
  assert.ok(urls.some((u) => u.includes("updated_since=2026-11-01T00%3A00%3A00Z")), `mcp request: ${urls.join(" ")}`);
  assert.ok(gh.some((e) => decodeURIComponent(e).includes("pushed:>=2026-11-01")), `github endpoint: ${gh.join(" ")}`);
  const items = JSON.parse(r.out).watches[0].new;
  assert.ok(items.find((i) => i.key === "gh:example-org/widget-kit").engines.includes("plugins"), "the plugin updated 2026-11-24 is after the 2026-11-15 cursor");
  // (the github stub ignores the query, so gizmo still arrives from it; what must be absent is the plugins row)
  assert.ok(!items.find((i) => i.key === "gh:sample-user/gizmo")?.engines.includes("plugins"), "the plugin updated 2026-11-10 is before the cursor");
});

test("mark --all-new advances a cursor only for a source that answered in full", async () => {
  const inj = base({ fetch: stub({ "registry.modelcontextprotocol.io": { body: fx("discover", "mcp.json") }, "skills.sh": SKILLS["skills.sh"] }) });
  await watch(["add", "s", "--query", "widget", "--sources", "skills"], inj);
  const s = JSON.parse(readFileSync(storePath(inj, "s"), "utf8"));
  s.sources = ["mcp", "skills"];
  writeFileSync(storePath(inj, "s"), JSON.stringify(s));
  const r = await watch(["mark", "s", "--all-new", "--json"], fresh(inj));
  assert.equal(r.code, 0, r.err);
  const after = JSON.parse(readFileSync(storePath(inj, "s"), "utf8"));
  assert.equal(after.cursor.mcp, "2026-11-06", "mcp rows carry updatedAt");
  assert.equal("skills" in after.cursor, false, "skills.sh gives no date, so there is nothing to advance to");
});

test("mark --all-new does not advance a cursor past a truncated answer", async () => {
  const many = JSON.stringify({ servers: Array.from({ length: 100 }, (_, i) => ({ server: { name: `example.test/s${i}`, description: "d", version: "1" }, _meta: { "io.modelcontextprotocol.registry/official": { updatedAt: "2026-11-06T00:00:00Z" } } })) });
  const inj = base({ fetch: stub({ "registry.modelcontextprotocol.io": { body: many } }) });
  await watch(["add", "s", "--query", "widget", "--sources", "skills"], inj);
  const st = JSON.parse(readFileSync(storePath(inj, "s"), "utf8"));
  st.sources = ["mcp"];
  writeFileSync(storePath(inj, "s"), JSON.stringify(st));
  const r = await watch(["mark", "s", "--all-new"], fresh(inj));
  assert.equal(r.code, 0, r.err);
  const after = JSON.parse(readFileSync(storePath(inj, "s"), "utf8"));
  assert.equal(Object.keys(after.seen).length, 100);
  assert.deepEqual(after.cursor, {}, "100 rows is the limit: more may lie beyond, so the cursor stays");
});

// ---------------------------------------------------------------- failures are not "0 new"

test("a failing source exits 2, is named, and the other source's items are still returned", async () => {
  const inj = base({ fetch: stub({ "skills.sh": SKILLS["skills.sh"], "registry.modelcontextprotocol.io": { status: 500, body: "" } }) });
  await watch(["add", "s", "--query", "widget", "--sources", "skills"], inj);
  const s = JSON.parse(readFileSync(storePath(inj, "s"), "utf8"));
  s.sources = ["skills", "mcp"];
  writeFileSync(storePath(inj, "s"), JSON.stringify(s));
  const before = snapshot(inj.stateDirPath);
  const r = await watch(["check", "s", "--json"], fresh(inj));
  assert.equal(r.code, 2);
  const j = JSON.parse(r.out);
  assert.equal(j.watches[0].counts.new, 3);
  assert.equal(j.watches[0].sources_failed[0].source, "mcp");
  const m = await watch(["mark", "s", "--all-new"], fresh(inj));
  assert.equal(m.code, 2, "a mark that could not ask every source says so");
  assert.notDeepEqual(snapshot(inj.stateDirPath), before, "what did answer was still marked");
});

// ---------------------------------------------------------------- the three release watchers

test("--repo: GitHub releases through gh, drafts dropped, key per tag", async () => {
  const gh = [];
  const inj = base({ gh: ghStub(fx("watch", "gh-releases.json"), gh) });
  await watch(["add", "r", "--repo", "Example-Org/Widget-Kit"], inj);
  const j = JSON.parse((await watch(["check", "r", "--json"], fresh(inj))).out);
  assert.deepEqual(gh, ["repos/Example-Org/Widget-Kit/releases?per_page=30"]);
  assert.deepEqual(j.watches[0].new.map((i) => i.key), ["ghrel:example-org/widget-kit@v2.1.0", "ghrel:example-org/widget-kit@v2.0.0"]);
  assert.equal(j.watches[0].new[0].updated, "2026-11-20");
  assert.equal(j.watches[0].new[0].kind, "release");
  await watch(["mark", "r", "--all-new"], fresh(inj));
  assert.equal(JSON.parse(readFileSync(storePath(inj, "r"), "utf8")).cursor["gh-release:example-org/widget-kit"], "2026-11-20");
  assert.equal(JSON.parse((await watch(["check", "r", "--json"], fresh(inj))).out).watches[0].counts.new, 0);
});

test("--pypi: the release RSS, key per version", async () => {
  const urls = [];
  const inj = base({ fetch: stub({ "pypi.org": { body: fx("watch", "pypi-releases.xml") } }, urls) });
  await watch(["add", "p", "--pypi", "widget-kit"], inj);
  const j = JSON.parse((await watch(["check", "p", "--json"], fresh(inj))).out);
  assert.deepEqual(urls, ["https://pypi.org/rss/project/widget-kit/releases.xml"]);
  assert.deepEqual(j.watches[0].new.map((i) => i.key), ["pypirel:widget-kit@1.4.0", "pypirel:widget-kit@1.3.0"]);
  assert.equal(j.watches[0].new[0].updated, "2026-11-24");
});

test("--feed: an Atom feed, keyed by feed URL and entry id; CDATA and entities are decoded", async () => {
  const inj = base({ fetch: stub({ "example.test": { body: fx("watch", "feed-atom.xml") } }) });
  await watch(["add", "f", "--feed", "https://example.test/feed.atom"], inj);
  const j = JSON.parse((await watch(["check", "f", "--json"], fresh(inj))).out);
  assert.deepEqual(j.watches[0].new.map((i) => i.key), ["feed:https://example.test/feed.atom#tag:example.test,2026:5", "feed:https://example.test/feed.atom#tag:example.test,2026:4"]);
  assert.equal(j.watches[0].new[0].title, "Release & notes 5");
  assert.equal(j.watches[0].new[1].title, "Release notes 4");
  assert.equal(j.watches[0].new[0].url, "https://example.test/posts/5");
});

test("each release watcher refuses a malformed body, by name, instead of reading it as 0 new", async () => {
  const cases = [
    ["--pypi", "widget-kit", { "pypi.org": { body: "<html><body>Not a feed</body></html>" } }, undefined],
    ["--feed", "https://example.test/f", { "example.test": { body: '{"not":"xml"}' } }, undefined],
    ["--repo", "o/r", {}, ghStub('{"message":"Not Found"}')],
  ];
  for (const [flag, ref, routes, gh] of cases) {
    const inj = base({ fetch: stub(routes), ...(gh ? { gh } : {}) });
    await watch(["add", "w", flag, ref], inj);
    const r = await watch(["check", "w", "--json"], fresh(inj));
    assert.equal(r.code, 2, `${flag}: ${r.out}`);
    const j = JSON.parse(r.out);
    assert.equal(j.watches[0].sources_failed[0].code, "DISCOVER_MALFORMED", flag);
    assert.match(j.watches[0].sources_failed[0].reason, /not "0 results"/);
    assert.equal(j.watches[0].counts.new, 0);
  }
});

test("adapters directly: a release with no tag, a feed entry with nothing in it, and an HTTP failure", async () => {
  assert.throws(() => githubReleases("o/r").parse('[{"name":"x"}]'), Malformed);
  assert.throws(() => pypiReleases("p").parse('<rss><channel><item><link>l</link></item></channel></rss>'), Malformed);
  assert.throws(() => genericFeed("https://e.test/f").parse("<feed><entry><id>1</id></entry></feed>"), Malformed);
  assert.deepEqual(pypiReleases("p").parse("<rss><channel><title>t</title></channel></rss>"), [], "a valid empty feed is an empty list");
  const inj = base({ fetch: stub({ "pypi.org": { status: 404, body: "" } }) });
  await watch(["add", "w", "--pypi", "missing-pkg"], inj);
  const r = await watch(["check", "w", "--json"], fresh(inj));
  assert.equal(r.code, 2);
  assert.equal(JSON.parse(r.out).watches[0].sources_failed[0].code, "DISCOVER_HTTP");
});

test("check with no name checks every watch; with none, says nothing was checked", async () => {
  const inj = base({ fetch: stub({ "pypi.org": { body: fx("watch", "pypi-releases.xml") }, "example.test": { body: fx("watch", "feed-atom.xml") } }) });
  const empty = await watch(["check"], fresh(inj));
  assert.equal(empty.code, 0);
  assert.match(empty.out, /no watches: nothing was checked/);
  await watch(["add", "p", "--pypi", "widget-kit"], inj);
  await watch(["add", "f", "--feed", "https://example.test/feed.atom"], inj);
  const j = JSON.parse((await watch(["check", "--json"], fresh(inj))).out);
  assert.deepEqual(j.watches.map((w) => w.name), ["f", "p"]);
  assert.equal(j.counts.new, 4);
});
