/**
 * lib/research/discover-engines.mjs — one adapter per scholarly search engine (#356, epic #321 S10).
 *
 * An adapter is `{ id, keyEnv, minIntervalMs(hasKey), request({query, limit, key, contact}), parse(bodyText) }`.
 * `request` returns `{ url, headers }`: a key travels ONLY in a header, never in the URL, so no URL echoed in an
 * error can carry it. `parse` returns normalised rows `{engine, id, doi, title, year, venue, is_peer_reviewed_hint,
 * oa_url, abstract?}` and THROWS `Malformed` when the body is not the shape the engine documents: "could not
 * understand the response" must never read as "0 results" (rule:discernment-checks §6).
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
      return row;
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
      return row;
    });
  },
};

const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? m[1] : null;
};
const unxml = (s) => (s ?? "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

const arxiv = {
  id: "arxiv",
  keyEnv: null,
  minIntervalMs: () => 3000,
  request({ query, limit }) {
    const u = new URL("https://export.arxiv.org/api/query");
    u.searchParams.set("search_query", `all:${query}`);
    u.searchParams.set("max_results", String(limit));
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
      return row;
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
      return row;
    });
  },
};

/** The default order: OpenAlex, then Semantic Scholar, arXiv, Crossref. */
export const ENGINES = [openalex, s2, arxiv, crossref];
export const ENGINE_IDS = ENGINES.map((e) => e.id);
