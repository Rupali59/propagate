/**
 * lib/research/watch.mjs — `propagate kb watch add|list|check|mark|rm` (#402, epic #321 S4): "what is new since I last
 * looked", for a query across the discover engines or for one repository, PyPI package or feed.
 *
 * STORE. `$STATE/kb/watch/<name>.json`: `{query, sources, targets, cursor:{<source>: "YYYY-MM-DD"}, seen:{<key>: first_seen}}`.
 * `sources` are discover engine ids (a `--sources` group is expanded when the watch is added). `targets` are the
 * query-less watchers: `{type:"repo"|"pypi"|"feed", ref}`, each a release feed read through the same request runner as a
 * discover engine (so a 429, an HTTP error and a malformed body are named failures, never "0 new"). Writes are
 * tmp-then-rename. A store that cannot be read is exit 2 and is never overwritten, by any subcommand.
 *
 * `check` IS PURE. It writes nothing: not the store, not discover's last-request file (it passes `lastFile: null`, so the
 * spacing between requests is kept in this process only). It returns the items whose `key` is not in `seen`, and asks
 * each source for "since" natively where one exists: the MCP registry's `updated_since`, GitHub's `pushed:>=`, a
 * claudemarketplaces `lastUpdated` comparison, and the release feeds' own dates. A source with no native "since" is a
 * key diff against `seen`. The cursor only narrows the request; `seen` decides what is new, so a re-sent item is never
 * reported twice and a cursor lost to a bad edit costs bandwidth, not correctness.
 *
 * `mark` records keys as seen after the caller has used them (a crashed agent loses nothing). `mark <name> <key...>`
 * touches `seen` only, never the cursor: an unmarked item older than a marked one must still come back. `mark --all-new`
 * runs `check`, marks everything it returned and advances each source's cursor to the newest `updated` it returned, but
 * only for a source that answered and returned fewer rows than the limit: a truncated answer proves nothing about
 * what lies beyond it, so its cursor stays.
 *
 * EXIT CODES. 0 ran (0 new is still 0: an empty answer is a result, stated as such). 2 usage, a store that is missing or
 * unreadable, a refused add/rm, or ANY source that failed (the items the others returned are still printed).
 * There is no background job: a watch is derived when someone runs `check`.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ALL_ENGINES, ALL_ENGINE_IDS, SOURCE_GROUPS, Malformed } from "./discover-engines.mjs";
import { ghFetch, redact, runEngine } from "./discover.mjs";
import { stateDir } from "../core/paths.mjs";

export const WATCH_USAGE = 'usage: propagate kb watch add <name> (--query "<q>" [--sources academic|code|skills|all] | --repo <owner/repo> | --pypi <name> | --feed <url>) | kb watch list [--json] | kb watch check [<name>] [--json] | kb watch mark <name> (<key...>|--all-new) [--json] | kb watch rm <name>';
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PYPI_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CHECK_LIMIT = 100;

const fail = (code, what, next) => ({ ok: false, code, what, next });

function emit(f, asJson, io) {
  if (asJson) io.log(JSON.stringify(f, null, 2));
  else io.error(`${f.code}: error: kb watch: ${f.what}. Next: ${f.next}`);
  return 2;
}

const hasText = (v) => typeof v === "string" && v.trim() !== "";
const isoDay = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null);
const dayOf = (v) => {
  if (typeof v !== "string" || !v) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  return isoDay(Date.parse(v));
};

// ---------------------------------------------------------------- release feeds as engine-shaped adapters

const releaseRow = (engine, kind, key, f) => ({
  engine, id: f.id, doi: null, title: f.title, year: null, venue: f.venue, is_peer_reviewed_hint: false, oa_url: null,
  url: f.url ?? null, kind, key, updated: dayOf(f.updated),
});
const sinceFilter = (rows, since) => (since ? rows.filter((r) => (r.updated ?? "") >= since.slice(0, 10)) : rows);

/** GitHub releases of one repository, read through `gh api` (PROPAGATE_GH_BIN overrides the binary). */
export function githubReleases(repo) {
  const id = `gh-release:${repo.toLowerCase()}`;
  return {
    id, keyEnv: null, transport: "gh", minIntervalMs: () => 2100,
    request() {
      const endpoint = `repos/${repo}/releases?per_page=30`;
      return { url: `https://api.github.com/${endpoint}`, headers: {}, gh: endpoint };
    },
    parse(text, { since = null } = {}) {
      let j;
      try {
        j = JSON.parse(text);
      } catch {
        throw new Malformed("GitHub releases did not return JSON");
      }
      if (!Array.isArray(j)) throw new Malformed("GitHub releases body is not an array");
      const rows = j.filter((r) => !(r && r.draft === true)).map((r, i) => {
        if (!r || typeof r !== "object" || !hasText(r.tag_name)) throw new Malformed(`GitHub release ${i} has no tag_name`);
        return releaseRow(id, "release", `ghrel:${repo.toLowerCase()}@${r.tag_name}`, { id: `${repo}@${r.tag_name}`, title: `${repo} ${r.name || r.tag_name}`, venue: "GitHub releases", url: r.html_url, updated: r.published_at ?? r.created_at });
      });
      return sinceFilter(rows, since);
    },
  };
}

const unescapeXml = (s) =>
  s.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&").trim();
const tagText = (block, names) => {
  for (const n of names) {
    const m = new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`, "i").exec(block);
    if (m) return unescapeXml(m[1]);
  }
  return "";
};
const linkOf = (block) => {
  const href = /<link\b[^>]*\bhref\s*=\s*["']([^"']+)["']/i.exec(block);
  return href ? unescapeXml(href[1]) : tagText(block, ["link"]);
};

/** The entries of an RSS 2.0 or Atom body: `[{title, link, guid, date}]`. Throws Malformed for anything else. */
export function parseFeed(text, what) {
  if (typeof text !== "string") throw new Malformed(`${what} body is not text`);
  const isRss = /<rss\b/i.test(text) && /<channel\b/i.test(text);
  const isAtom = /<feed\b/i.test(text);
  if (!isRss && !isAtom) throw new Malformed(`${what} is neither an RSS nor an Atom document`);
  const re = isRss ? /<item\b[^>]*>([\s\S]*?)<\/item>/gi : /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi;
  const out = [];
  for (const m of text.matchAll(re)) {
    const b = m[1];
    const title = tagText(b, ["title"]);
    const link = linkOf(b);
    if (!title && !link) throw new Malformed(`${what} has an entry with no title and no link`);
    out.push({ title, link, guid: tagText(b, ["guid", "id"]), date: tagText(b, ["pubDate", "published", "updated", "dc:date"]) });
  }
  return out;
}

/** PyPI's release feed for one project: `https://pypi.org/rss/project/<name>/releases.xml` (no search API exists). */
export function pypiReleases(name) {
  const id = `pypi-release:${name.toLowerCase()}`;
  return {
    id, keyEnv: null, minIntervalMs: () => 1000,
    request: () => ({ url: `https://pypi.org/rss/project/${encodeURIComponent(name)}/releases.xml`, headers: {} }),
    parse(text, { since = null } = {}) {
      const rows = parseFeed(text, "PyPI release feed").map((e) => {
        if (!hasText(e.title)) throw new Malformed("PyPI release feed has an entry with no version title");
        return releaseRow(id, "release", `pypirel:${name.toLowerCase()}@${e.title}`, { id: `${name}@${e.title}`, title: `${name} ${e.title}`, venue: "PyPI releases", url: e.link, updated: e.date });
      });
      return sinceFilter(rows, since);
    },
  };
}

/** Any RSS or Atom feed URL. The key is the feed URL plus the entry's guid, else its link, else its title. */
export function genericFeed(url) {
  const id = `feed:${url}`;
  return {
    id, keyEnv: null, minIntervalMs: () => 1000,
    request: () => ({ url, headers: {} }),
    parse(text, { since = null } = {}) {
      const rows = parseFeed(text, "feed").map((e) => {
        const ident = e.guid || e.link || e.title;
        return releaseRow(id, "feed-item", `feed:${url}#${ident}`, { id: ident, title: e.title || e.link, venue: "feed", url: e.link || null, updated: e.date });
      });
      return sinceFilter(rows, since);
    },
  };
}

function targetAdapter(t) {
  if (t.type === "repo") return githubReleases(t.ref);
  if (t.type === "pypi") return pypiReleases(t.ref);
  return genericFeed(t.ref);
}

// ---------------------------------------------------------------- the store

const watchDir = (state) => path.join(state, "kb", "watch");
const storeFile = (state, name) => path.join(watchDir(state), `${name}.json`);

/** `{ok:true, store}` or `{ok:false, why}`. Never throws. A store that is not exactly the documented shape is unreadable. */
function readStore(file) {
  let j;
  try {
    j = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return { ok: false, why: `${file} is not readable JSON (${err.message})` };
  }
  const obj = (v) => v && typeof v === "object" && !Array.isArray(v);
  const good =
    obj(j) && (j.query === null || typeof j.query === "string") && Array.isArray(j.sources) && j.sources.every((s) => typeof s === "string") &&
    Array.isArray(j.targets) && j.targets.every((t) => obj(t) && ["repo", "pypi", "feed"].includes(t.type) && hasText(t.ref)) && obj(j.cursor) && obj(j.seen);
  if (!good) return { ok: false, why: `${file} is not a watch store (expected {query, sources, targets, cursor, seen})` };
  return { ok: true, store: j };
}

/** Atomic write: tmp then rename. Returns null, or the error text. */
function writeStore(file, store) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n");
    renameSync(tmp, file);
    return null;
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing to clean */
    }
    return err.message;
  }
}

function openStore(state, name, asJson, io) {
  if (!NAME_RE.test(name ?? "")) return { code: emit(fail("WATCH_USAGE", `a watch name is letters, digits, . _ - (got ${JSON.stringify(name ?? "")})`, WATCH_USAGE), asJson, io) };
  const file = storeFile(state, name);
  if (!existsSync(file)) return { code: emit(fail("WATCH_MISSING", `there is no watch named ${name} (${file})`, "kb watch list shows the watches; kb watch add creates one"), asJson, io) };
  const r = readStore(file);
  if (!r.ok) return { code: emit(fail("WATCH_STORE", r.why, "fix or move the file named above; kb watch never overwrites a store it cannot read"), asJson, io) };
  return { file, store: r.store };
}

// ---------------------------------------------------------------- check

/**
 * Run every source of `store` and return `{items, sourcesRun, sourcesFailed, answered}`. Writes nothing.
 * `answered[sourceId] = {max, truncated}` is what `mark --all-new` needs to advance a cursor safely.
 */
async function collect(store, inject, env) {
  const fetchFn = inject.fetch ?? globalThis.fetch;
  const ghFn = inject.gh ?? ((endpoint) => ghFetch(endpoint, env));
  const sleep = inject.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = inject.now ?? Date.now;
  const keys = { openalex: env.OPENALEX_API_KEY || null, s2: env.S2_API_KEY || null };
  const secrets = Object.values(keys).filter(Boolean);
  const contact = inject.contact ?? env.PROPAGATE_KB_CONTACT ?? null;
  const last = new Map();
  const notes = [];

  const sources = [];
  const sourcesFailed = [];
  for (const id of store.sources) {
    const eng = ALL_ENGINES.find((e) => e.id === id);
    if (eng) sources.push({ eng, query: store.query ?? "" });
    else sourcesFailed.push({ source: id, code: "WATCH_UNKNOWN_SOURCE", reason: `${id}: error: not a known engine (${ALL_ENGINE_IDS.join(", ")})` });
  }
  for (const t of store.targets) sources.push({ eng: targetAdapter(t), query: "" });

  const byKey = new Map();
  const sourcesRun = [];
  const answered = {};
  for (const { eng, query } of sources) {
    const since = typeof store.cursor[eng.id] === "string" ? store.cursor[eng.id] : null;
    const o = await runEngine(eng, { query, limit: CHECK_LIMIT, key: keys[eng.id] ?? null, contact, since, fetchFn, ghFn, sleep, now, last, lastFile: null, persisted: {}, warn: (w) => notes.push(w) });
    if (o.status !== "ok") {
      sourcesFailed.push({ source: eng.id, code: o.code, reason: redact(o.reason, secrets) });
      continue;
    }
    sourcesRun.push(eng.id);
    const dates = o.rows.map((r) => r.updated).filter(Boolean).sort();
    answered[eng.id] = { max: dates.length ? dates[dates.length - 1] : null, truncated: o.rows.length >= CHECK_LIMIT };
    for (const r of o.rows) {
      const have = byKey.get(r.key);
      if (have) {
        if (!have.engines.includes(eng.id)) have.engines.push(eng.id);
      } else byKey.set(r.key, { kind: r.kind ?? "paper", key: r.key, title: r.title ?? "", url: r.url ?? r.oa_url ?? null, updated: r.updated ?? null, engines: [eng.id] });
    }
  }
  const all = [...byKey.values()];
  const items = all.filter((it) => !(it.key in store.seen));
  return { items, sourcesRun, sourcesFailed, answered, seenReturned: all.length - items.length, notes };
}

function parseArgs(rest, valueFlags, boolFlags) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (boolFlags.includes(a)) flags[a] = true;
    else if (valueFlags.includes(a)) {
      const v = rest[i + 1];
      if (v === undefined || v.startsWith("--")) return { error: `${a} needs a value` };
      flags[a] = v;
      i++;
    } else if (a.startsWith("--")) return { error: `unknown argument ${a}` };
    else pos.push(a);
  }
  return { pos, flags };
}

// ---------------------------------------------------------------- subcommands

function addCmd(rest, ctx) {
  const { io, state, asJson } = ctx;
  const p = parseArgs(rest, ["--query", "--sources", "--repo", "--pypi", "--feed"], ["--json"]);
  if (p.error) return emit(fail("WATCH_USAGE", p.error, WATCH_USAGE), asJson, io);
  const { pos, flags } = p;
  const name = pos[0];
  if (pos.length !== 1 || !NAME_RE.test(name)) return emit(fail("WATCH_USAGE", "kb watch add needs one <name> (letters, digits, . _ -)", WATCH_USAGE), asJson, io);
  const hasQuery = flags["--query"] !== undefined;
  if (flags["--sources"] !== undefined && !hasQuery) return emit(fail("WATCH_USAGE", "--sources only goes with --query", WATCH_USAGE), asJson, io);
  if (hasQuery && !hasText(flags["--query"])) return emit(fail("WATCH_USAGE", "--query is empty", WATCH_USAGE), asJson, io);
  const targets = [];
  if (flags["--repo"] !== undefined) {
    if (!REPO_RE.test(flags["--repo"])) return emit(fail("WATCH_USAGE", `--repo must be owner/repo, got ${JSON.stringify(flags["--repo"])}`, WATCH_USAGE), asJson, io);
    targets.push({ type: "repo", ref: flags["--repo"] });
  }
  if (flags["--pypi"] !== undefined) {
    if (!PYPI_RE.test(flags["--pypi"])) return emit(fail("WATCH_USAGE", `--pypi must be a package name, got ${JSON.stringify(flags["--pypi"])}`, WATCH_USAGE), asJson, io);
    targets.push({ type: "pypi", ref: flags["--pypi"] });
  }
  if (flags["--feed"] !== undefined) {
    let u = null;
    try {
      u = new URL(flags["--feed"]);
    } catch {
      /* reported below */
    }
    if (!u || !["http:", "https:"].includes(u.protocol)) return emit(fail("WATCH_USAGE", `--feed must be an http(s) URL, got ${JSON.stringify(flags["--feed"])}`, WATCH_USAGE), asJson, io);
    targets.push({ type: "feed", ref: u.toString() });
  }
  if (!hasQuery && !targets.length) return emit(fail("WATCH_USAGE", "a watch needs --query, --repo, --pypi or --feed", WATCH_USAGE), asJson, io);
  let sources = [];
  if (hasQuery) {
    const groups = (flags["--sources"] ?? "all").split(",").map((g) => g.trim());
    const bad = groups.find((g) => !(g in SOURCE_GROUPS));
    if (bad !== undefined) return emit(fail("WATCH_USAGE", `--sources must be a comma list of ${Object.keys(SOURCE_GROUPS).join(", ")}, got ${JSON.stringify(bad)}`, WATCH_USAGE), asJson, io);
    sources = [...new Set(groups.flatMap((g) => SOURCE_GROUPS[g]))];
  }
  const file = storeFile(state, name);
  if (existsSync(file)) return emit(fail("WATCH_EXISTS", `a watch named ${name} already exists (${file})`, "pick another name, or kb watch rm it first; add never overwrites"), asJson, io);
  const store = { query: hasQuery ? flags["--query"] : null, sources, targets, cursor: {}, seen: {} };
  const w = writeStore(file, store);
  if (w) return emit(fail("WATCH_STORE", `could not write ${file} (${w})`, "check that the state directory is writable"), asJson, io);
  if (asJson) io.log(JSON.stringify({ ok: true, name, file, ...store }, null, 2));
  else io.log(`added watch ${name}: ${[hasQuery ? `${JSON.stringify(flags["--query"])} on ${sources.join(",")}` : null, ...targets.map((t) => `${t.type} ${t.ref}`)].filter(Boolean).join("; ")}`);
  return 0;
}

function listCmd(rest, ctx) {
  const { io, state, asJson } = ctx;
  const p = parseArgs(rest, [], ["--json"]);
  if (p.error || p.pos.length) return emit(fail("WATCH_USAGE", p.error ?? "kb watch list takes no argument", WATCH_USAGE), asJson, io);
  const dir = watchDir(state);
  const names = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort() : [];
  let code = 0;
  const rows = names.map((name) => {
    const r = readStore(storeFile(state, name));
    if (!r.ok) {
      code = 2;
      return { name, error: r.why };
    }
    return { name, query: r.store.query, sources: r.store.sources, targets: r.store.targets, seen: Object.keys(r.store.seen).length };
  });
  if (asJson) io.log(JSON.stringify({ ok: code === 0, watches: rows }, null, 2));
  else if (!rows.length) io.log(`no watches (looked in ${dir})`);
  else
    for (const r of rows) {
      if (r.error) io.error(`WATCH_STORE: error: kb watch: ${r.name}: ${r.error}`);
      else io.log(`${r.name}: ${[r.query !== null ? `${JSON.stringify(r.query)} on ${r.sources.join(",")}` : null, ...r.targets.map((t) => `${t.type} ${t.ref}`)].filter(Boolean).join("; ")} (${r.seen} seen)`);
    }
  return code;
}

async function checkCmd(rest, ctx) {
  const { io, state, asJson, inject, env } = ctx;
  const p = parseArgs(rest, [], ["--json"]);
  if (p.error || p.pos.length > 1) return emit(fail("WATCH_USAGE", p.error ?? "kb watch check takes at most one <name>", WATCH_USAGE), asJson, io);
  let names;
  if (p.pos.length) names = [p.pos[0]];
  else {
    const dir = watchDir(state);
    names = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort() : [];
  }
  let code = 0;
  const watches = [];
  for (const name of names) {
    const o = openStore(state, name, asJson, io);
    if (o.code !== undefined) {
      code = 2;
      continue;
    }
    const c = await collect(o.store, inject, env);
    if (c.sourcesFailed.length) code = 2;
    watches.push({ name, new: c.items, sources_run: c.sourcesRun, sources_failed: c.sourcesFailed, counts: { new: c.items.length, already_seen: c.seenReturned } });
  }
  const total = watches.reduce((n, w) => n + w.new.length, 0);
  if (asJson) io.log(JSON.stringify({ ok: code === 0, watches, counts: { watches: watches.length, new: total } }, null, 2));
  else {
    if (!names.length) io.log("no watches: nothing was checked");
    for (const w of watches) {
      io.log(`${w.name}: ${w.new.length} new (${w.counts.already_seen} already seen; sources: ${w.sources_run.join(", ") || "none answered"})`);
      for (const it of w.new) io.log(`  ${it.key}  ${it.title}${it.updated ? `  [${it.updated}]` : ""}${it.url ? `  ${it.url}` : ""}`);
      for (const f of w.sources_failed) io.error(`${f.code}: ${f.reason}`);
    }
  }
  return code;
}

async function markCmd(rest, ctx) {
  const { io, state, asJson, inject, env } = ctx;
  const p = parseArgs(rest, [], ["--json", "--all-new"]);
  if (p.error) return emit(fail("WATCH_USAGE", p.error, WATCH_USAGE), asJson, io);
  const [name, ...keys] = p.pos;
  const allNew = p.flags["--all-new"] === true;
  if (!name || (allNew ? keys.length > 0 : keys.length === 0)) return emit(fail("WATCH_USAGE", "kb watch mark needs <name> and either one or more keys or --all-new (not both)", WATCH_USAGE), asJson, io);
  const o = openStore(state, name, asJson, io);
  if (o.code !== undefined) return o.code;
  const store = o.store;
  const when = new Date((inject.now ?? Date.now)()).toISOString();
  let marked = keys;
  let cursorMoved = {};
  let failed = [];
  if (allNew) {
    const c = await collect(store, inject, env);
    failed = c.sourcesFailed;
    marked = c.items.map((it) => it.key);
    for (const id of c.sourcesRun) {
      const a = c.answered[id];
      if (a && a.max && !a.truncated && (store.cursor[id] ?? "") < a.max) {
        store.cursor[id] = a.max;
        cursorMoved[id] = a.max;
      }
    }
  }
  const fresh = marked.filter((k) => !(k in store.seen));
  for (const k of fresh) store.seen[k] = when;
  const w = writeStore(o.file, store);
  if (w) return emit(fail("WATCH_STORE", `could not write ${o.file} (${w})`, "check that the state directory is writable"), asJson, io);
  if (asJson) io.log(JSON.stringify({ ok: failed.length === 0, name, marked: fresh, already_seen: marked.length - fresh.length, cursor: cursorMoved, sources_failed: failed }, null, 2));
  else {
    io.log(`${name}: marked ${fresh.length} as seen${marked.length > fresh.length ? ` (${marked.length - fresh.length} already were)` : ""}`);
    for (const f of failed) io.error(`${f.code}: ${f.reason}`);
  }
  return failed.length ? 2 : 0;
}

function rmCmd(rest, ctx) {
  const { io, state, asJson } = ctx;
  const p = parseArgs(rest, [], ["--json"]);
  if (p.error || p.pos.length !== 1) return emit(fail("WATCH_USAGE", p.error ?? "kb watch rm needs one <name>", WATCH_USAGE), asJson, io);
  const name = p.pos[0];
  if (!NAME_RE.test(name)) return emit(fail("WATCH_USAGE", `a watch name is letters, digits, . _ - (got ${JSON.stringify(name)})`, WATCH_USAGE), asJson, io);
  const file = storeFile(state, name);
  if (!existsSync(file)) return emit(fail("WATCH_MISSING", `there is no watch named ${name} (${file}); nothing was removed`, "kb watch list shows the watches"), asJson, io);
  try {
    unlinkSync(file);
  } catch (err) {
    return emit(fail("WATCH_STORE", `could not remove ${file} (${err.message})`, "check the file's permissions"), asJson, io);
  }
  if (asJson) io.log(JSON.stringify({ ok: true, removed: name }, null, 2));
  else io.log(`removed watch ${name}`);
  return 0;
}

/**
 * @param {string[]} rest everything after `watch`
 * @param {object} inject tests: io, env, fetch, gh, sleep, now, contact, stateDirPath
 */
export async function watchCmd(rest, inject = {}) {
  const io = inject.io ?? console;
  const asJson = rest.includes("--json");
  const ctx = { io, asJson, inject, env: inject.env ?? process.env, state: inject.stateDirPath ?? stateDir() };
  const [sub, ...args] = rest;
  if (sub === "add") return addCmd(args, ctx);
  if (sub === "list") return listCmd(args, ctx);
  if (sub === "check") return checkCmd(args, ctx);
  if (sub === "mark") return markCmd(args, ctx);
  if (sub === "rm") return rmCmd(args, ctx);
  return emit(fail("WATCH_USAGE", sub === undefined ? "kb watch needs a subcommand" : `unknown kb watch subcommand ${JSON.stringify(sub)}`, WATCH_USAGE), asJson, io);
}

/** #408: tagged for tests/unit/blind-readers.test.mjs. Text that is not RSS or Atom throws Malformed, never `[]`. */
export const READER = {
  parseFeed: { hostile: (h) => [h.junkText, "feed"] },
};
