/**
 * lib/kb/review/tier.mjs — derive a source's tier from what discover and fetch recorded, plus the hub tier table.
 * Offline and deterministic (plan ruling 1): no Crossref lookup, so a venue not recorded at discover time reads
 * as tier 2 or 3 until the source is re-discovered.
 *
 * A missing or unreadable table is a refusal to run (`KB_TIERS_NOT_CONFIGURED`), never "every source is tier 3".
 */
import { readYamlSafe } from "../../report/manifest.mjs";
import { canonicalUrl } from "../../research/fetch.mjs";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
export const hostOf = (u) => {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
};

/** @returns {{ok: true, table: {domains: object, official_docs: string[]}} | {ok: false, code: string, what: string, next: string}} */
export function loadTierTable(file) {
  const next = "set PROPAGATE_KB_TIERS_FILE (or kbTiersFile under integrations: in config.yml) to the hub's source-tier table";
  const bad = (what) => ({ ok: false, code: "KB_TIERS_NOT_CONFIGURED", what, next });
  if (!file) return bad("the source-tier table is not configured");
  const r = readYamlSafe(file);
  if (r.error) return bad(`the source-tier table could not be read: ${r.error} (${file})`);
  const d = r.data;
  if (!isObj(d) || d.schema_version !== 1) return bad(`the source-tier table is not a schema_version 1 mapping (${file})`);
  if (!isObj(d.domains)) return bad(`the source-tier table has no \`domains:\` mapping (${file})`);
  for (const [h, t] of Object.entries(d.domains)) if (![1, 2, 3].includes(t)) return bad(`domain ${h} has tier ${JSON.stringify(t)}, expected 1, 2 or 3 (${file})`);
  const docs = d.official_docs ?? [];
  if (!Array.isArray(docs) || !docs.every((x) => typeof x === "string")) return bad(`official_docs is not a list of hosts (${file})`);
  const norm = (h) => h.toLowerCase().replace(/^www\./, "");
  return { ok: true, table: { domains: Object.fromEntries(Object.entries(d.domains).map(([h, t]) => [norm(h), t])), official_docs: docs.map(norm) } };
}

// A preprint server is a host, not a venue: OpenAlex names arXiv "arXiv (Cornell University)" (ISSUE-001, /qa 2026-11-23).
const PREPRINT_VENUE = /\b(arxiv|biorxiv|medrxiv|chemrxiv|ssrn|preprints?|research square)\b/i;
// arXiv mints DataCite DOIs (10.48550/arXiv.*) for every preprint, so such a DOI says nothing about peer review.
const PREPRINT_DOI = /^10\.48550\//i;
const hasVenue = (r) => typeof r.venue === "string" && r.venue.trim() !== "" && !PREPRINT_VENUE.test(r.venue);
const peerReviewDoi = (r) => typeof r.doi === "string" && r.doi !== "" && !PREPRINT_DOI.test(r.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, ""));

/** The discovered record for a source: matched by the record's open-access URL, its DOI URL, or an arXiv id. */
export function findDiscovered(urls, discovered) {
  const keys = new Set(urls.filter(Boolean).map(canonicalUrl));
  for (const r of discovered ?? []) {
    if (!isObj(r)) continue;
    if (r.oa_url && keys.has(canonicalUrl(r.oa_url))) return r;
    if (r.doi && keys.has(canonicalUrl(`https://doi.org/${r.doi}`))) return r;
    // A row first found by another engine keeps that engine's id; `ids.arxiv` (or an `arxiv:` key) still names the arXiv one.
    if (r.engine !== "arxiv") {
      const aid = r.ids?.arxiv ?? (typeof r.key === "string" && r.key.startsWith("arxiv:") ? r.key.slice(6) : null);
      if (aid) for (const u of urls) if (hostOf(u) === "arxiv.org" && String(u).includes(String(aid).replace(/^arxiv:/i, "").replace(/v\d+$/i, ""))) return r;
    }
    if (r.engine === "arxiv" && r.id) {
      for (const u of urls) if (hostOf(u) === "arxiv.org" && String(u).includes(String(r.id).replace(/^arxiv:/i, ""))) return r;
    }
  }
  return null;
}

/**
 * Rules in order, first match wins; `basis` names the rule.
 * @param {{url: string, sha256?: string}} source
 * @returns {{tier: 1|2|3, basis: string}}
 */
export function deriveTier(source, { discovered = [], fetched = [], table }) {
  const rec = (fetched ?? []).find((f) => f.sha256 && f.sha256 === source.sha256) ?? null;
  const urls = [source.url, rec?.url, rec?.final_url];
  const hosts = urls.map(hostOf).filter(Boolean);
  const finalHost = hostOf(rec?.final_url ?? source.url);
  const d = findDiscovered(urls, discovered);
  if (d && hasVenue(d) && (d.is_peer_reviewed_hint === true || peerReviewDoi(d))) return { tier: 1, basis: `peer-reviewed venue ${d.venue.trim()}` };
  if (table.official_docs.includes(finalHost)) return { tier: 1, basis: "official docs" };
  if (hosts.includes("arxiv.org")) return { tier: 2, basis: "preprint (no venue record)" };
  for (const h of [finalHost, ...hosts]) if (h in table.domains) return { tier: table.domains[h], basis: "tier table" };
  return { tier: 3, basis: "default" };
}
