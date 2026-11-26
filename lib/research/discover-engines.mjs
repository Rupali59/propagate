/**
 * lib/research/discover-engines.mjs — one adapter per scholarly search engine (#356, epic #321 S10).
 *
 * An adapter is `{ id, keyEnv, minIntervalMs(hasKey), request({query, limit, key, contact}), parse(bodyText) }`.
 * `request` returns `{ url, headers }`: a key travels ONLY in a header, never in the URL, so no URL echoed in an
 * error can carry it. `parse` returns normalised rows `{engine, id, doi, title, year, venue, is_peer_reviewed_hint,
 * oa_url, abstract?}` and THROWS `Malformed` when the body is not the shape the engine documents: "could not
 * understand the response" must never read as "0 results" (rule:discernment-checks §6).
 *
 * Every row also carries `kind` ("paper" for these four), `key` (the identity the same work has in every engine:
 * `doi:<lower-case doi>` when a DOI exists, else `arxiv:<id without version>` or `<engine>:<id>`) and `updated`
 * (an ISO date when the source gives one, else null). `discover.mjs` de-duplicates on `key` (#399).
 *
 * Limits, from each provider's own docs (checked 2026-11-23):
 *   OpenAlex   https://help.openalex.org/guides/authentication : 10 req/s keyless, 30 req/s with a free key, $1/day
 *              budget; a 429 body carries "reason" ("daily_budget" = spent for the day).
 *   Semantic Scholar https://www.semanticscholar.org/product/api : unauthenticated pool is shared; "The introductory
 *              rate limit for an API key is 1 RPS"; the key goes in the `x-api-key` header.
 *   arXiv      https://info.arxiv.org/help/api/tou.html : "no more than one request every three seconds", one
 *              connection at a time.
 *   Crossref   https://www.crossref.org/documentation/retrieve-metadata/rest-api/access-and-authentication/ : public
 *              pool 1 req/s for queries, polite pool (a `mailto`) 3 req/s.
 */

export class Malformed extends Error {}

const stripDoi = (d) => (typeof d === "string" && d ? d.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").toLowerCase() : null);
const clean = (s) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "");
const yearOf = (y) => (Number.isInteger(y) ? y : null);


/** `doi:` + the DOI, lower-cased and with any URL or `doi:` prefix removed; null when there is no DOI. */
export function doiKey(d) {
  if (typeof d !== "string") return null;
  const bare = d.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "").toLowerCase();
  return bare ? `doi:${bare}` : null;
}

/** An arXiv id without its version suffix: `2301.00001v2` -> `2301.00001`, `hep-th/9901001v1` -> `hep-th/9901001`. */
export const arxivBare = (id) => String(id).replace(/^arxiv:/i, "").replace(/v\d+$/i, "");

/** The cross-engine identity of a record: a DOI wins, else arXiv id, else `<engine>:<id>`. Also used for old rows. */
export function recordKey(row) {
  const d = doiKey(row.doi);
  if (d) return d;
  if (row.engine === "arxiv") return `arxiv:${arxivBare(row.id)}`;
  return `${row.engine}:${row.id}`;
}

/** An ISO date (YYYY-MM-DD) from a source timestamp, or null when it is absent or not a date. */
const isoDate = (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);

/** Add `kind`, `key` and `updated` to a freshly parsed row. */
const withIdentity = (row, updated) => ({ ...row, kind: "paper", key: recordKey(row), updated: isoDate(updated) });

function parseJson(text, what) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Malformed(`${what} did not return JSON`);
  }
}

const openalex = {
  id: "openalex",
  keyEnv: "OPENALEX_API_KEY",
  minIntervalMs: (hasKey) => (hasKey ? 34 : 100),
  request({ query, limit, key, contact }) {
    const u = new URL("https://api.openalex.org/works");
    u.searchParams.set("search", query);
    u.searchParams.set("per_page", String(limit));
    if (contact) u.searchParams.set("mailto", contact);
    return { url: u.toString(), headers: key ? { Authorization: `Bearer ${key}` } : {} };
  },
  parse(text) {
    const j = parseJson(text, "OpenAlex");
    if (!j || !Array.isArray(j.results)) throw new Malformed("OpenAlex body has no `results` array");
    return j.results.map((w, i) => {
      if (!w || typeof w !== "object" || (!w.id && !w.doi)) throw new Malformed(`OpenAlex result ${i} has no id`);
      const src = w.primary_location?.source ?? null;
      const row = {
        engine: "openalex",
        id: String(w.id ?? w.doi).replace(/^https?:\/\/openalex\.org\//, ""),
        doi: stripDoi(w.doi),
        title: clean(w.display_name ?? w.title),
        year: yearOf(w.publication_year),
        venue: clean(src?.display_name) || null,
        is_peer_reviewed_hint: Boolean(src && ["journal", "conference", "book series"].includes(src.type)),
        oa_url: w.open_access?.oa_url ?? null,
      };
      const idx = w.abstract_inverted_index;
      if (idx && typeof idx === "object") {
        const words = [];
        for (const [word, pos] of Object.entries(idx)) for (const p of Array.isArray(pos) ? pos : []) words[p] = word;
        const abs = clean(words.filter((x) => x !== undefined).join(" "));
        if (abs) row.abstract = abs;
      }
      return withIdentity(row, w.updated_date);
    });
  },
};

const s2 = {
  id: "s2",
  keyEnv: "S2_API_KEY",
  minIntervalMs: () => 1000,
  request({ query, limit, key }) {
    const u = new URL("https://api.semanticscholar.org/graph/v1/paper/search");
    u.searchParams.set("query", query);
    u.searchParams.set("limit", String(limit));
    u.searchParams.set("fields", "title,year,venue,abstract,externalIds,openAccessPdf,publicationTypes");
    return { url: u.toString(), headers: key ? { "x-api-key": key } : {} };
  },
  parse(text) {
    const j = parseJson(text, "Semantic Scholar");
    if (!j || typeof j !== "object") throw new Malformed("Semantic Scholar body is not an object");
    if (!Array.isArray(j.data)) {
      if (j.total === 0) return [];
      throw new Malformed("Semantic Scholar body has no `data` array");
    }
    return j.data.map((p, i) => {
      if (!p || typeof p !== "object" || !p.paperId) throw new Malformed(`Semantic Scholar result ${i} has no paperId`);
      const types = Array.isArray(p.publicationTypes) ? p.publicationTypes : [];
      const row = {
        engine: "s2",
        id: p.paperId,
        doi: stripDoi(p.externalIds?.DOI),
        title: clean(p.title),
        year: yearOf(p.year),
        venue: clean(p.venue) || null,
        is_peer_reviewed_hint: types.includes("JournalArticle") || types.includes("Conference"),
        oa_url: p.openAccessPdf?.url ?? null,
      };
      if (clean(p.abstract)) row.abstract = clean(p.abstract);
      return withIdentity(row, null);
    });
  },
};

const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? m[1] : null;
};
const unxml = (s) => (s ?? "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/**
 * arXiv's `all:<whole query>` matches loosely (a live query returned an unrelated paper), so build one `all:` term per
 * token joined by AND, keeping a "quoted phrase" as a single `all:"..."` term.
 */
export function arxivQuery(query) {
  const terms = [];
  for (const m of query.matchAll(/"([^"]+)"|(\S+)/g)) {
    const phrase = m[1]?.trim();
    if (phrase) terms.push(`all:"${phrase}"`);
    else if (m[2]) terms.push(`all:${m[2].replace(/"/g, "")}`);
  }
  return terms.join(" AND ");
}

const arxiv = {
  id: "arxiv",
  keyEnv: null,
  minIntervalMs: () => 3000,
  request({ query, limit }) {
    const u = new URL("https://export.arxiv.org/api/query");
    u.searchParams.set("search_query", arxivQuery(query));
    u.searchParams.set("max_results", String(limit));
    u.searchParams.set("sortBy", "relevance");
    return { url: u.toString(), headers: {} };
  },
  parse(text) {
    if (!/<feed[\s>]/.test(text)) throw new Malformed("arXiv body is not an Atom feed");
    const blocks = text.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];
    return blocks.map((b, i) => {
      const idUrl = tag(b, "id");
      if (!idUrl) throw new Malformed(`arXiv entry ${i} has no id`);
      // An error is an Atom entry too: its id is .../api/errors#..., and it is not a paper.
      if (/\/api\/errors/.test(idUrl)) throw new Malformed(`arXiv returned an error entry: ${clean(unxml(tag(b, "summary")))}`);
      const pdf = b.match(/<link[^>]*title="pdf"[^>]*href="([^"]+)"/) ?? b.match(/<link[^>]*href="([^"]+)"[^>]*title="pdf"/);
      const published = tag(b, "published");
      const row = {
        engine: "arxiv",
        id: idUrl.replace(/^https?:\/\/arxiv\.org\/abs\//, ""),
        doi: stripDoi(unxml(clean(tag(b, "arxiv:doi") ?? ""))),
        title: clean(unxml(tag(b, "title"))),
        year: published && /^\d{4}/.test(published) ? Number(published.slice(0, 4)) : null,
        venue: clean(unxml(tag(b, "arxiv:journal_ref") ?? "")) || "arXiv",
        is_peer_reviewed_hint: false,
        oa_url: pdf ? pdf[1] : null,
      };
      const abs = clean(unxml(tag(b, "summary")));
      if (abs) row.abstract = abs;
      return withIdentity(row, tag(b, "updated"));
    });
  },
};

const DOI_RE = /^10\.\d{4,9}\/\S+$/;
const crossref = {
  id: "crossref",
  keyEnv: null,
  minIntervalMs: () => 1000,
  request({ query, limit, contact }) {
    const q = query.trim();
    const isDoi = DOI_RE.test(q);
    const u = isDoi ? new URL(`https://api.crossref.org/works/${encodeURIComponent(q)}`) : new URL("https://api.crossref.org/works");
    if (!isDoi) {
      u.searchParams.set("query", query);
      u.searchParams.set("rows", String(limit));
    }
    if (contact) u.searchParams.set("mailto", contact);
    return { url: u.toString(), headers: {} };
  },
  parse(text) {
    const j = parseJson(text, "Crossref");
    if (!j || j.status !== "ok" || !j.message || typeof j.message !== "object") throw new Malformed("Crossref body is not a status:ok message");
    const items = Array.isArray(j.message.items) ? j.message.items : j.message.DOI ? [j.message] : null;
    if (!items) throw new Malformed("Crossref message has neither `items` nor a work");
    return items.map((w, i) => {
      if (!w || typeof w !== "object" || !w.DOI) throw new Malformed(`Crossref item ${i} has no DOI`);
      const parts = w.issued?.["date-parts"]?.[0];
      const row = {
        engine: "crossref",
        id: stripDoi(w.DOI),
        doi: stripDoi(w.DOI),
        title: clean(Array.isArray(w.title) ? w.title[0] : w.title),
        year: Array.isArray(parts) ? yearOf(parts[0]) : null,
        venue: clean(Array.isArray(w["container-title"]) ? w["container-title"][0] : w["container-title"]) || null,
        is_peer_reviewed_hint: ["journal-article", "proceedings-article"].includes(w.type),
        oa_url: null,
      };
      const abs = clean(unxml((w.abstract ?? "").replace(/<[^>]+>/g, " ")));
      if (abs) row.abstract = abs;
      return withIdentity(row, w.deposited?.["date-time"] ?? w.indexed?.["date-time"]);
    });
  },
};

// ---- code and skill engines (#400, epic #321 S2) -------------------------------------------------------------------
// Their rows carry `kind` (repo, package, skill, plugin-marketplace, mcp-server), a `key` (`gh:<owner/repo>` is shared
// by github and plugins, so one repo is one row), `url`, and the same base fields as a paper row. `parse(text, {query,
// limit})` takes the request's query and limit for the two endpoints that cannot filter or cap server-side. Response
// shapes were confirmed with one live request each on 2026-11-26 (GitHub's from its documented search response).

const hasText = (v) => typeof v === "string" && v.trim() !== "";
/** A non-paper row: the base fields every row carries, then identity. */
const codeRow = (engine, kind, key, f, updated) => ({
  engine, id: f.id, doi: null, title: clean(f.title), year: null, venue: f.venue, is_peer_reviewed_hint: false, oa_url: null,
  url: f.url ?? null, ...(clean(f.abstract) ? { abstract: clean(f.abstract) } : {}), kind, key, updated: isoDate(updated),
});

/**
 * GitHub repository search, read through the `gh` binary (PROPAGATE_GH_BIN overrides it, as in lib/research/fetch.mjs):
 * the gh login carries the token, so no key is handled here. `transport: "gh"` tells discover.mjs to run
 * `gh api <endpoint>` instead of a fetch. GitHub's search limit is 30 requests a minute, hence 2100 ms.
 */
const github = {
  id: "github",
  keyEnv: null,
  transport: "gh",
  minIntervalMs: () => 2100,
  request({ query, limit }) {
    const endpoint = `search/repositories?q=${encodeURIComponent(query)}&per_page=${limit}`;
    return { url: `https://api.github.com/${endpoint}`, headers: {}, gh: endpoint };
  },
  parse(text) {
    const j = parseJson(text, "GitHub");
    if (!j || !Array.isArray(j.items)) throw new Malformed("GitHub body has no `items` array");
    return j.items.map((r, i) => {
      if (!r || typeof r !== "object" || !hasText(r.full_name)) throw new Malformed(`GitHub item ${i} has no full_name`);
      return codeRow("github", "repo", `gh:${r.full_name.toLowerCase()}`, { id: r.full_name, title: r.full_name, venue: "GitHub", url: r.html_url, abstract: r.description }, r.pushed_at);
    });
  },
};

const npm = {
  id: "npm",
  keyEnv: null,
  minIntervalMs: () => 1000,
  request({ query, limit }) {
    const u = new URL("https://registry.npmjs.org/-/v1/search");
    u.searchParams.set("text", query);
    u.searchParams.set("size", String(limit));
    return { url: u.toString(), headers: {} };
  },
  parse(text) {
    const j = parseJson(text, "npm");
    if (!j || !Array.isArray(j.objects)) throw new Malformed("npm body has no `objects` array");
    return j.objects.map((o, i) => {
      const p = o?.package;
      if (!p || typeof p !== "object" || !hasText(p.name)) throw new Malformed(`npm object ${i} has no package.name`);
      return codeRow("npm", "package", `npm:${p.name}`, { id: p.name, title: p.name, venue: "npm", url: p.links?.npm ?? `https://www.npmjs.com/package/${p.name}`, abstract: p.description }, p.date ?? o.updated);
    });
  },
};

const skills = {
  id: "skills",
  keyEnv: null,
  minIntervalMs: () => 1000,
  request({ query }) {
    const u = new URL("https://skills.sh/api/search");
    u.searchParams.set("q", query);
    return { url: u.toString(), headers: {} };
  },
  parse(text, { limit = Infinity } = {}) {
    const j = parseJson(text, "skills.sh");
    if (!j || !Array.isArray(j.skills)) throw new Malformed("skills.sh body has no `skills` array");
    return j.skills.slice(0, limit).map((s, i) => {
      if (!s || typeof s !== "object" || !hasText(s.source) || !hasText(s.skillId)) throw new Malformed(`skills.sh skill ${i} has no source or skillId`);
      return codeRow("skills", "skill", `skill:${s.source}/${s.skillId}`.toLowerCase(), { id: `${s.source}/${s.skillId}`, title: s.name || s.skillId, venue: "skills.sh", url: `https://skills.sh/${s.source}/${s.skillId}` }, null);
    });
  },
};

const plugins = {
  id: "plugins",
  keyEnv: null,
  minIntervalMs: () => 1000,
  // The endpoint returns every marketplace (about 2,800) and has no search, so `parse` filters and ranks client-side.
  request() {
    return { url: "https://claudemarketplaces.com/api/marketplaces", headers: {} };
  },
  parse(text, { query = "", limit = Infinity } = {}) {
    const j = parseJson(text, "claudemarketplaces");
    if (!Array.isArray(j)) throw new Malformed("claudemarketplaces body is not an array");
    j.forEach((m, i) => {
      if (!m || typeof m !== "object" || !hasText(m.repo)) throw new Malformed(`claudemarketplaces item ${i} has no repo`);
    });
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const hay = (m) => `${m.repo} ${m.description ?? ""} ${Array.isArray(m.pluginKeywords) ? m.pluginKeywords.join(" ") : ""}`.toLowerCase();
    return j
      .filter((m) => words.every((w) => hay(m).includes(w)))
      .sort((a, b) => (Number(b.stars) || 0) - (Number(a.stars) || 0))
      .slice(0, limit)
      .map((m) => codeRow("plugins", "plugin-marketplace", `gh:${m.repo.toLowerCase()}`, { id: m.repo, title: m.repo, venue: "Claude marketplaces", url: `https://github.com/${m.repo}`, abstract: m.description }, m.lastUpdated));
  },
};

const mcp = {
  id: "mcp",
  keyEnv: null,
  minIntervalMs: () => 1000,
  request({ query, limit }) {
    const u = new URL("https://registry.modelcontextprotocol.io/v0/servers");
    u.searchParams.set("search", query);
    u.searchParams.set("limit", String(limit));
    return { url: u.toString(), headers: {} };
  },
  parse(text) {
    const j = parseJson(text, "MCP registry");
    if (!j || !Array.isArray(j.servers)) throw new Malformed("MCP registry body has no `servers` array");
    return j.servers.map((e, i) => {
      const s = e?.server;
      if (!s || typeof s !== "object" || !hasText(s.name)) throw new Malformed(`MCP registry entry ${i} has no server.name`);
      const meta = e._meta?.["io.modelcontextprotocol.registry/official"];
      return codeRow("mcp", "mcp-server", `mcp:${s.name}`, { id: s.name, title: s.title || s.name, venue: "MCP registry", url: s.websiteUrl ?? s.repository?.url, abstract: s.description }, meta?.updatedAt);
    });
  },
};

/** The academic engines, in their default order: OpenAlex, then Semantic Scholar, arXiv, Crossref. */
export const ENGINES = [openalex, s2, arxiv, crossref];
export const ENGINE_IDS = ENGINES.map((e) => e.id);

/** Every engine, and the `--sources` groups (#400). With neither `--sources` nor `--engine`, the default is `academic`. */
export const ALL_ENGINES = [...ENGINES, github, npm, skills, plugins, mcp];
export const ALL_ENGINE_IDS = ALL_ENGINES.map((e) => e.id);
export const SOURCE_GROUPS = {
  academic: ["openalex", "s2", "arxiv", "crossref"],
  code: ["github", "npm"],
  skills: ["skills", "plugins", "mcp"],
};
SOURCE_GROUPS.all = [...SOURCE_GROUPS.academic, ...SOURCE_GROUPS.code, ...SOURCE_GROUPS.skills];
