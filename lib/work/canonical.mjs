/**
 * Canonical URLs for the work queue's dedupe key (propagate#150).
 *
 * github.com collapses to `github.com/<owner>/<repo>` (lowercased, no `.git`, no deeper path): that triple is unique, so
 * a repo, its `tree/main/docs` page and its `.git` clone URL are one thing. Anything else keeps the path's CASE and drops
 * the query, fragment and trailing slash, because lowercasing a path would merge distinct pages (C9a). `www.` is dropped.
 */

const URL_RE = /https?:\/\/[^\s<>"'`]+/i;

/** The first `http(s)://` URL in `text`, as written but without the punctuation that closes a sentence or a markdown link. */
export function firstUrl(text) {
  const m = URL_RE.exec(String(text ?? ""));
  if (!m) return null;
  return m[0].replace(/[).,;:!?\]}]+$/, "");
}

/** @returns {string|null} the canonical form of the first URL in `text`, or null when there is none. */
export function canonicalUrl(text) {
  const raw = firstUrl(text);
  if (!raw) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  const host = u.host.toLowerCase().replace(/^www\./, "");
  const segs = u.pathname.split("/").filter(Boolean);
  if (host === "github.com") {
    if (segs.length === 0) return "github.com";
    if (segs.length === 1) return `github.com/${segs[0].toLowerCase()}`;
    return `github.com/${segs[0].toLowerCase()}/${segs[1].replace(/\.git$/i, "").toLowerCase()}`;
  }
  return segs.length ? `${host}/${segs.join("/")}` : host;
}
