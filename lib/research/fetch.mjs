/**
 * lib/research/fetch.mjs — `propagate kb fetch`: read a source's raw bytes, record what happened, and say plainly
 * when the page was not what was asked for (#324, design §S3 and §Revision 3).
 *
 * WHY THIS EXISTS. WebFetch hands a page through a small model before the agent sees it, so a "quote" taken from it
 * can be a paraphrase. This reads the source itself: Node fetch (redirects followed by hand, so each hop is
 * checked), a fixed HTML-to-text step, `pdftotext` for PDFs, `gh api` for GitHub. The gate reads the same stored
 * text through lib/research/quotes.mjs.
 *
 * CLASSIFICATION. ok | not_retrieved | stale | hallucinated.
 *   - A 404/410 or a name that does not resolve is checked against the Wayback Machine's availability API, the
 *     method of Rao et al. 2026 (arXiv 2604.03173): a snapshot means the page existed (stale), none means the URL
 *     probably never did (hallucinated). Any other failure is not_retrieved and is never sent to Wayback.
 *   - A 200 that lands on a login or consent page, or a page robots.txt disallows, is not_retrieved.
 *   - A body with almost no text, or only a citation line (a DOI landing page), is not_retrieved: citation_only (#366).
 *   - A paywall with no open-access copy is not_retrieved. No shadow library is ever consulted.
 *
 * EXIT-RELEVANT FAILURES are thrown as FetchFatal (could not run): pdftotext missing when a PDF turns up, gh
 * missing or logged out when a GitHub URL turns up, a store that would put a body inside the repo or `<dir>`.
 * Everything else is a per-URL record, so one dead link never hides the other nine.
 *
 * Bodies go to `$STATE/kb/fetched/<sha256>` (the sha of the stored text, which is what the gate reads) and are
 * never written into the repo or `<dir>`: assertSafeStore refuses the run before any byte is written.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { htmlToText } from "./quotes.mjs";

export const FETCHED_FILE = "fetched.json";
export const SCHEMA_VERSION = 1;
export const USER_AGENT = "propagate-kb-fetch";
const MAX_REDIRECTS = 5;
const MAX_BYTES = 40 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20000;
const ACCEPT = "text/markdown, text/html;q=0.9, application/pdf;q=0.8, text/plain;q=0.7, */*;q=0.1";
/**
 * The least extracted text a body may hold and still be `ok` (#366), in characters after whitespace is collapsed.
 * Chosen from the fixtures: the shortest body any existing test records as ok is 49 characters, so 40 sits just under
 * it. It is a floor, not a judgement of quality: the real work against citation stubs is `citationOnly`'s shape test.
 * The value is written into every record it judged (`floor_chars`), so a reader can audit it.
 */
export const MIN_TEXT_CHARS = 40;
const BIB_ID = /\bdoi\s*[:/]|doi\.org\/|\b10\.\d{4,9}\/\S+|\b(?:19|20)\d{2}[a-z]?\b[^.\n]{0,80}?\b\d+\s*[(:]\s*\d/i;
const MAX_CITATION_WORDS = 60;
const PROSE_SENTENCE_WORDS = 15;

/**
 * Is this extracted text too thin to read, or only a bibliographic line? Pure.
 *   - under `floor` characters: nothing to read;
 *   - up to 60 words that carry a DOI or a year-volume-pages pattern and no sentence of
 *     15 words or more: a citation, as DOI landing pages and publisher stubs serve.
 * A short real abstract has such a sentence, so it stays ok even when it mentions its DOI.
 * @returns {{citationOnly: boolean, chars: number, why?: string}}
 */
export function citationOnly(text, floor = MIN_TEXT_CHARS) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  const chars = flat.length;
  if (chars < floor) return { citationOnly: true, chars, why: `only ${chars} characters of text, under the floor of ${floor}` };
  const words = flat.split(" ").length;
  const prose = flat.split(/(?<=[.!?])\s+/).some((sentence) => sentence.split(" ").length >= PROSE_SENTENCE_WORDS);
  if (words <= MAX_CITATION_WORDS && BIB_ID.test(flat) && !prose) return { citationOnly: true, chars, why: `${words} words that read as a bibliographic line with no abstract or text` };
  return { citationOnly: false, chars };
}

/** Hosts whose whole job is to redirect somewhere else; landing on another host from them is expected. */
const RESOLVER_HOSTS = new Set(["doi.org", "dx.doi.org"]);

/**
 * Why a record is not `ok` (#367). A closed list, so a review can count by reason: `login_page`, `cross_host`,
 * `robots`, `http_<code>` (the server's status), `timeout`, `citation_only` (a body with no text to read),
 * `unexpected` (everything else: a refused connection, an unknown host, a paywall with no open copy, a tool failure).
 * Every record that is not `ok` carries `reason` and a `detail` sentence; `note` and `error` stay for older readers.
 */
export const RETRIEVAL_REASONS = ["login_page", "cross_host", "robots", "http_<code>", "timeout", "citation_only", "unexpected"];
const httpReason = (status) => (Number.isInteger(status) ? `http_${status}` : "unexpected");
const TIMEOUT_CODES = new Set(["TimeoutError", "AbortError", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);
const isTimeout = (code) => TIMEOUT_CODES.has(code);

/** A failure that stops the whole run (exit 2) rather than marking one URL. */
export class FetchFatal extends Error {
  constructor(code, what, next) {
    super(what);
    this.code = code;
    this.what = what;
    this.next = next;
  }
}

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; } };

/** The key two spellings of one source share: no fragment, no utm_* params, no trailing slash, host lower-cased. */
export function canonicalUrl(raw) {
  try {
    const u = new URL(raw);
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (/^utm_/i.test(k)) u.searchParams.delete(k);
    u.hostname = u.hostname.toLowerCase();
    const p = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : u.pathname;
    return `${u.protocol}//${u.host}${p}${u.search}`;
  } catch {
    return String(raw).trim();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Which kind of source is this, and where do its bytes really live
// ---------------------------------------------------------------------------------------------------------------

/**
 * Pure. Decide how a URL is read. arXiv, OpenReview and the ACL Anthology resolve to their PDFs; a DOI goes to
 * Unpaywall; a GitHub page goes through `gh api`; anything else is fetched as written.
 * @returns {{kind: "github"|"doi"|"http", fetchUrl: string, resolvedFrom?: string, doi?: string, gh?: object}}
 */
export function resolveSource(raw) {
  let u;
  try { u = new URL(raw); } catch { return { kind: "http", fetchUrl: raw }; }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const parts = u.pathname.split("/").filter(Boolean);

  if (host === "arxiv.org" && (parts[0] === "abs" || parts[0] === "pdf") && parts.length >= 2) {
    const id = parts.slice(1).join("/").replace(/\.pdf$/i, "");
    return { kind: "http", fetchUrl: `https://arxiv.org/pdf/${id}`, resolvedFrom: "arxiv" };
  }
  if (host === "openreview.net" && (u.pathname === "/forum" || u.pathname === "/pdf") && u.searchParams.get("id")) {
    return { kind: "http", fetchUrl: `https://openreview.net/pdf?id=${encodeURIComponent(u.searchParams.get("id"))}`, resolvedFrom: "openreview" };
  }
  if (host === "aclanthology.org" && parts.length === 1 && !/\.(pdf|bib|xml)$/i.test(parts[0])) {
    return { kind: "http", fetchUrl: `https://aclanthology.org/${parts[0]}.pdf`, resolvedFrom: "aclanthology" };
  }
  if (host === "doi.org" || host === "dx.doi.org") {
    const doi = decodeURIComponent(u.pathname.replace(/^\//, ""));
    if (/^10\.\d{4,9}\/\S+$/.test(doi)) return { kind: "doi", fetchUrl: raw, doi };
  }
  if (host === "github.com" && parts.length >= 2) {
    const [owner, repo, kindSeg, ...rest] = parts;
    const repoName = repo.replace(/\.git$/, "");
    if (parts.length === 2) return { kind: "github", fetchUrl: raw, gh: { endpoint: `repos/${owner}/${repoName}/readme`, raw: true } };
    if (kindSeg === "blob" && rest.length >= 2) {
      const [ref, ...file] = rest;
      return { kind: "github", fetchUrl: raw, gh: { endpoint: `repos/${owner}/${repoName}/contents/${file.join("/")}?ref=${encodeURIComponent(ref)}`, raw: true } };
    }
    if ((kindSeg === "issues" || kindSeg === "pull") && /^\d+$/.test(rest[0] ?? "")) {
      const n = rest[0];
      return { kind: "github", fetchUrl: raw, gh: { endpoint: `repos/${owner}/${repoName}/${kindSeg === "pull" ? "pulls" : "issues"}/${n}`, jq: '"# " + .title + "\\n\\n" + (.body // "")' } };
    }
  }
  return { kind: "http", fetchUrl: raw };
}

// ---------------------------------------------------------------------------------------------------------------
// Login and consent landings
// ---------------------------------------------------------------------------------------------------------------

const LOGIN_PATH = /(^|\/)(log-?in|sign-?in|signin|sso|auth(enticate)?|consent|accounts?\/(login|signin))(\/|$)/i;
const LOGIN_PHRASE = /(sign in|log in|login) to (continue|view|read|access)|please (sign|log) in|accept (all )?cookies|cookie (consent|preferences)|before you continue to/i;

/**
 * Did a 200 land somewhere that is not the page that was asked for? Pure.
 *   - the final URL is on a different host (www. ignored), unless the request started at a resolver like doi.org;
 *   - the final URL's path is a login or consent path;
 *   - the page carries a password field, or is short and says "sign in to continue" or asks for cookie consent.
 * @returns {{login: boolean, kind?: "cross_host"|"login_page", reason?: string}}
 */
export function landedOnLoginPage({ startUrl, finalUrl, html = "" }) {
  const sh = hostOf(startUrl);
  const fh = hostOf(finalUrl);
  if (sh && fh && sh !== fh && !RESOLVER_HOSTS.has(sh)) return { login: true, kind: "cross_host", reason: `redirected to another host (${sh} to ${fh})` };
  try {
    if (LOGIN_PATH.test(new URL(finalUrl).pathname)) return { login: true, kind: "login_page", reason: "landed on a login or consent path" };
  } catch { /* an unparseable final URL is judged by its body */ }
  if (/<input\b[^>]*type\s*=\s*["']?password/i.test(html)) return { login: true, kind: "login_page", reason: "the page asks for a password" };
  const text = htmlToText(html);
  if (text.length < 1500 && LOGIN_PHRASE.test(text)) return { login: true, kind: "login_page", reason: "a short page asking to sign in or accept cookies" };
  return { login: false };
}

// ---------------------------------------------------------------------------------------------------------------
// robots.txt (RFC 9309, the part this needs)
// ---------------------------------------------------------------------------------------------------------------

/** @returns {{allow: boolean, pattern: string}[]} the rules of the group that names us, else of `*` */
export function parseRobots(text) {
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  for (const lineRaw of String(text).split(/\r?\n/)) {
    const line = lineRaw.replace(/#.*/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (key === "user-agent") {
      if (!lastWasAgent || !cur) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(m[2].trim().toLowerCase());
      lastWasAgent = true;
    } else if ((key === "allow" || key === "disallow") && cur) {
      lastWasAgent = false;
      if (m[2].trim() !== "") cur.rules.push({ allow: key === "allow", pattern: m[2].trim() });
    } else lastWasAgent = false;
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== "*" && USER_AGENT.includes(a)));
  const pick = mine.length ? mine : groups.filter((g) => g.agents.includes("*"));
  return pick.flatMap((g) => g.rules);
}

function robotsMatch(pattern, pathAndQuery) {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = new RegExp(`^${body.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}${anchored ? "$" : ""}`);
  return re.test(pathAndQuery);
}

/** Longest matching rule wins; a tie goes to allow. No rule means allowed. */
export function robotsAllows(rules, pathAndQuery) {
  let best = null;
  for (const r of rules) {
    if (!robotsMatch(r.pattern, pathAndQuery)) continue;
    if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow)) best = r;
  }
  return best ? best.allow : true;
}

// ---------------------------------------------------------------------------------------------------------------
// The fetcher
// ---------------------------------------------------------------------------------------------------------------

/**
 * @param {object} o
 * @param {typeof fetch} [o.fetchImpl]
 * @param {number} [o.timeoutMs]
 * @param {Map} [o.robotsCache] origin to rules, shared across one run
 */
async function httpGet(url, o) {
  const fetchImpl = o.fetchImpl ?? fetch;
  const timeout = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const robots = await robotsVerdict(current, o);
    if (robots.blocked) return { blocked: robots.why, finalUrl: current, status: null };
    let res;
    try {
      res = await fetchImpl(current, { redirect: "manual", headers: { "user-agent": USER_AGENT, accept: ACCEPT }, signal: AbortSignal.timeout(timeout) });
    } catch (e) {
      const code = e?.cause?.code ?? e?.code ?? e?.name;
      return { error: String(e?.cause?.message ?? e?.message ?? e), errorCode: code, timedOut: isTimeout(code) || isTimeout(e?.name), finalUrl: current, status: null };
    }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get("location");
      if (!loc) return { finalUrl: current, status: res.status, error: "redirect with no Location header" };
      current = new URL(loc, current).href;
      continue;
    }
    // The timeout covers the body too: a server that sends headers and then stalls rejects HERE, so the read is
    // inside the same error handling as the request (ISSUE-004).
    let buf;
    try {
      buf = Buffer.from(await res.arrayBuffer());
    } catch (e) {
      const code = e?.cause?.code ?? e?.code ?? e?.name;
      return { error: `reading the body failed: ${String(e?.cause?.message ?? e?.message ?? e)}`, errorCode: code, timedOut: isTimeout(code) || isTimeout(e?.name), finalUrl: current, status: res.status };
    }
    if (buf.length > MAX_BYTES) return { finalUrl: current, status: res.status, error: `body over ${MAX_BYTES} bytes` };
    return { finalUrl: current, status: res.status, contentType: res.headers.get("content-type") ?? "", bytes: buf };
  }
  return { finalUrl: current, status: null, error: `more than ${MAX_REDIRECTS} redirects` };
}

async function robotsVerdict(url, o) {
  const u = new URL(url);
  const cache = o.robotsCache ?? (o.robotsCache = new Map());
  if (!cache.has(u.origin)) {
    let rules = [];
    let blocked = null;
    try {
      const res = await (o.fetchImpl ?? fetch)(`${u.origin}/robots.txt`, { redirect: "follow", headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(o.timeoutMs ?? DEFAULT_TIMEOUT_MS) });
      if (res.status >= 500) blocked = `robots.txt answered ${res.status}, which RFC 9309 reads as disallow`;
      else if (res.status === 200) rules = parseRobots(await res.text());
      // 4xx: no robots file, everything allowed.
    } catch (e) {
      // A host that does not exist has no robots.txt to honour; the page fetch fails the same way and is classified there.
      if (e?.cause?.code !== "ENOTFOUND") blocked = `robots.txt could not be read (${e?.cause?.code ?? e?.message ?? e}), which RFC 9309 reads as disallow`;
    }
    cache.set(u.origin, { rules, blocked });
  }
  const c = cache.get(u.origin);
  if (c.blocked) return { blocked: true, why: c.blocked };
  return robotsAllows(c.rules, u.pathname + u.search) ? { blocked: false } : { blocked: true, why: "disallowed by robots.txt" };
}

/** Wayback availability API: a snapshot means the page existed (stale), none means it probably never did. */
async function waybackCheck(url, o) {
  const api = o.endpoints?.wayback ?? "https://archive.org/wayback/available";
  try {
    const res = await (o.fetchImpl ?? fetch)(`${api}?url=${encodeURIComponent(url)}`, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(o.timeoutMs ?? DEFAULT_TIMEOUT_MS) });
    if (res.status !== 200) return { unavailable: `Wayback availability API answered ${res.status}` };
    const j = await res.json();
    const snap = j?.archived_snapshots?.closest;
    if (snap?.available && snap.url) return { snapshot: snap.url };
    if (j && typeof j === "object" && "archived_snapshots" in j) return { snapshot: null };
    return { unavailable: "Wayback availability API returned a shape this reader does not recognise" };
  } catch (e) {
    return { unavailable: `Wayback availability API unreachable (${e?.cause?.code ?? e?.message ?? e})` };
  }
}

/** A record that is not `ok`: the reason from RETRIEVAL_REASONS, and a sentence saying what happened. */
const notOk = (rec, classification, reason, detail, extra = {}) => ({ ...rec, classification, reason, detail, ...extra, note: detail });

async function classifyMissing(rec, url, o, why, reason) {
  const w = await waybackCheck(url, o);
  if (w.unavailable) return notOk(rec, "not_retrieved", reason, `${why}; ${w.unavailable}, so it is not classified as stale or hallucinated`);
  if (w.snapshot) return notOk(rec, "stale", reason, `${why}; the Wayback Machine holds a snapshot, so the page existed and has gone`, { wayback_url: w.snapshot });
  return notOk(rec, "hallucinated", reason, `${why}; the Wayback Machine has no record of this URL, so it was probably never real`);
}

function pdfToText(bytes, o) {
  const bin = o.pdftotextBin ?? "pdftotext";
  const run = o.run ?? ((cmd, args, opts) => execFileSync(cmd, args, opts));
  try {
    return String(run(bin, ["-enc", "UTF-8", "-", "-"], { input: bytes, encoding: "utf8", maxBuffer: MAX_BYTES, timeout: 60000, stdio: ["pipe", "pipe", "pipe"] }));
  } catch (e) {
    if (e?.code === "ENOENT") throw new FetchFatal("FETCH_PDFTOTEXT_MISSING", `a PDF was fetched but \`${bin}\` is not installed, so its text cannot be read`, "install poppler (brew install poppler) so pdftotext is on PATH, then re-run");
    return { failed: String(e?.stderr ?? e?.message ?? e).trim().split("\n")[0] };
  }
}

function ghGet(gh, o) {
  const bin = o.ghBin ?? process.env.PROPAGATE_GH_BIN ?? "gh";
  const run = o.run ?? ((cmd, args, opts) => execFileSync(cmd, args, opts));
  const args = ["api", ...(gh.raw ? ["-H", "Accept: application/vnd.github.raw+json"] : []), ...(gh.jq ? ["--jq", gh.jq] : []), gh.endpoint];
  try {
    return { text: String(run(bin, args, { encoding: "utf8", maxBuffer: MAX_BYTES, timeout: 60000, stdio: ["ignore", "pipe", "pipe"] })), status: 200 };
  } catch (e) {
    if (e?.code === "ENOENT") throw new FetchFatal("FETCH_GH_MISSING", `a GitHub URL was given but \`${bin}\` is not installed`, "install the GitHub CLI (brew install gh), then re-run");
    const err = String(e?.stderr ?? e?.message ?? "");
    const code = Number(/HTTP (\d{3})/.exec(err)?.[1]);
    if (/gh auth login|not logged in|authentication required|HTTP 401|Bad credentials/i.test(err)) {
      throw new FetchFatal("FETCH_GH_UNAUTHENTICATED", "gh is not logged in (or its token was refused), so GitHub URLs cannot be read", "run `gh auth login`, then re-run");
    }
    return { status: Number.isFinite(code) ? code : null, error: err.trim().split("\n")[0] || "gh api failed" };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// One URL, then many
// ---------------------------------------------------------------------------------------------------------------

function store(stateDirPath, text) {
  const sha = sha256(text);
  const dir = path.join(stateDirPath, "kb", "fetched");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, sha);
  if (!existsSync(file)) {
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, file);
  }
  return sha;
}

/** The contact address Unpaywall asks callers to identify with (the shared kb contact). Never guessed. */
const noContactNote = "Unpaywall skipped: no contact set (set PROPAGATE_KB_CONTACT, or kbContact under integrations: in config.yml)";

async function fetchOne(url, o) {
  const base = { url, final_url: null, status: null, type: null, sha256: null, date: new Date(o.now()).toISOString() };
  const src = resolveSource(url);
  if (src.resolvedFrom) base.resolved_from = src.resolvedFrom;
  const notes = [];
  let fetchUrl = src.fetchUrl;

  if (src.kind === "github") {
    const g = ghGet(src.gh, o);
    if (g.error !== undefined) {
      const rec = { ...base, final_url: url, status: g.status };
      if (g.status === 404) return classifyMissing(rec, url, o, "GitHub answered 404", "http_404");
      return notOk(rec, "not_retrieved", httpReason(g.status), `gh api failed: ${g.error}`);
    }
    if (g.text.trim() === "") return notOk({ ...base, final_url: url, status: 200 }, "not_retrieved", "unexpected", "GitHub returned an empty body");
    return { ...base, final_url: url, status: 200, type: "github", sha256: store(o.stateDirPath, g.text), classification: "ok" };
  }

  if (src.kind === "doi") {
    if (!o.contact) notes.push(noContactNote);
    else {
      const api = `${o.endpoints?.unpaywall ?? "https://api.unpaywall.org/v2"}/${encodeURIComponent(src.doi).replace(/%2F/gi, "/")}?email=${encodeURIComponent(o.contact)}`;
      let up;
      try {
        const res = await (o.fetchImpl ?? fetch)(api, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(o.timeoutMs ?? DEFAULT_TIMEOUT_MS) });
        up = { status: res.status, json: res.status === 200 ? await res.json() : null };
      } catch (e) {
        up = { error: String(e?.cause?.code ?? e?.message ?? e), code: e?.cause?.code ?? e?.code ?? e?.name };
      }
      if (up.error) return notOk(base, "not_retrieved", isTimeout(up.code) ? "timeout" : "unexpected", `Unpaywall unreachable (${up.error})`);
      if (up.status === 404) return notOk({ ...base, status: 404 }, "not_retrieved", "http_404", "Unpaywall has no record of this DOI (it covers Crossref DOIs only, so this is not proof the DOI is false)");
      if (up.status !== 200) return notOk({ ...base, status: up.status }, "not_retrieved", httpReason(up.status), `Unpaywall answered ${up.status}`);
      const loc = up.json?.best_oa_location;
      const oa = loc?.url_for_pdf ?? loc?.url ?? null;
      if (!up.json?.is_oa || !oa) return notOk({ ...base, status: 200 }, "not_retrieved", "unexpected", "no open-access copy of this DOI (Unpaywall); not fetched from anywhere else");
      fetchUrl = oa;
      base.resolved_from = "unpaywall";
    }
  }

  const r = await httpGet(fetchUrl, o);
  const rec = { ...base, final_url: r.finalUrl, status: r.status };
  const withNotes = (x) => (notes.length ? { ...x, note: [x.note, ...notes].filter(Boolean).join("; ") } : x);
  const fail = (reason, detail, extra = {}) => withNotes(notOk({ ...rec, ...extra }, "not_retrieved", reason, detail));
  if (r.blocked) return fail("robots", r.blocked);
  if (r.error) {
    if (r.errorCode === "ENOTFOUND") return withNotes(await classifyMissing(rec, url, o, "the host name does not resolve", "unexpected"));
    return fail(r.timedOut ? "timeout" : "unexpected", r.error);
  }
  if (r.status === 404 || r.status === 410) return withNotes(await classifyMissing(rec, url, o, `the server answered ${r.status}`, `http_${r.status}`));
  if (r.status < 200 || r.status > 299) return fail(httpReason(r.status), `the server answered ${r.status}${r.status === 401 || r.status === 403 ? " (access refused; not retried through another route)" : ""}`);

  const isPdf = r.bytes.subarray(0, 5).toString("latin1") === "%PDF-" || /pdf/i.test(r.contentType);
  let type;
  let text;
  if (isPdf) {
    const t = pdfToText(r.bytes, o);
    if (typeof t !== "string") return fail("unexpected", `pdftotext could not read the file: ${t.failed}`, { type: "pdf" });
    type = "pdf";
    text = t;
  } else {
    const decoded = r.bytes.toString("utf8");
    const head = decoded.slice(0, 600).toLowerCase();
    if (/text\/markdown/i.test(r.contentType)) { type = "markdown"; text = decoded; }
    else if (/html/i.test(r.contentType) || /<!doctype html|<html[\s>]/.test(head)) {
      const login = landedOnLoginPage({ startUrl: fetchUrl, finalUrl: r.finalUrl, html: decoded });
      if (login.login) return fail(login.kind, `HTTP ${r.status}, but this is not the page: ${login.reason}`, { type: "html" });
      type = "html";
      text = htmlToText(decoded);
    } else if (/^text\/|json|xml/i.test(r.contentType) || r.contentType === "") { type = "text"; text = decoded; }
    else return fail("unexpected", `unsupported content type ${JSON.stringify(r.contentType)}`);
  }
  if (type !== "html") {
    // A non-HTML 200 can still have crossed hosts; only the host rule applies (no HTML to inspect).
    const login = landedOnLoginPage({ startUrl: fetchUrl, finalUrl: r.finalUrl });
    if (login.login) return fail(login.kind, `HTTP ${r.status}, but this is not the page: ${login.reason}`, { type });
  }
  const thin = citationOnly(text);
  const judged = { text_chars: thin.chars, floor_chars: MIN_TEXT_CHARS };
  if (thin.citationOnly) return fail("citation_only", `${thin.why} (a DOI landing page, a publisher stub, a scanned PDF or an empty page), so there is nothing to read`, { type, ...judged });
  return withNotes({ ...rec, type, ...judged, sha256: store(o.stateDirPath, text), classification: "ok" });
}

// ---------------------------------------------------------------------------------------------------------------
// The store guard, the file, the batch
// ---------------------------------------------------------------------------------------------------------------

function insideGitWorkTree(p) {
  let cur = path.resolve(p);
  for (;;) {
    if (existsSync(path.join(cur, ".git"))) return cur;
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}

/**
 * Bodies must never land in the repo or in `<dir>`. Refuse the whole run BEFORE any write when the store would
 * (a) sit inside `<dir>`, (b) contain `<dir>`, or (c) sit inside a git work tree. A guard checked after the write is
 * a report, not a guard (rule:safety-flag-needs-a-test).
 */
export function assertSafeStore(stateDirPath, dir) {
  const store = path.resolve(stateDirPath, "kb", "fetched");
  const d = path.resolve(dir);
  const within = (a, b) => a === b || a.startsWith(b + path.sep);
  if (within(store, d) || within(d, store)) throw new FetchFatal("FETCH_STORE_UNSAFE", `the body store (${store}) and the review folder (${d}) overlap, so page bodies would land in the review folder`, "point PROPAGATE_STATE_DIR somewhere outside the review folder");
  const repo = insideGitWorkTree(store);
  if (repo) throw new FetchFatal("FETCH_STORE_UNSAFE", `the body store (${store}) is inside the git work tree ${repo}, so page bodies could be committed`, "point PROPAGATE_STATE_DIR at a folder outside any repository");
}

/** @returns {{records: object[]}|null} null when the file is absent; throws FetchFatal when it is unreadable */
export function readFetched(dir) {
  const file = path.join(dir, FETCHED_FILE);
  if (!existsSync(file)) return null;
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    if (!j || !Array.isArray(j.records)) throw new Error("no `records` array");
    return j;
  } catch (e) {
    throw new FetchFatal("FETCH_FILE_UNREADABLE", `${file} could not be read (${e.message}), and overwriting it would lose its records`, "fix or move that file, then re-run");
  }
}

/**
 * Fetch each URL (duplicates by canonicalUrl collapse to the first spelling), then write `<dir>/fetched.json`,
 * replacing any record for the same canonical URL and keeping the rest. Nothing is written when a fatal stops the run.
 * @param {object} o {dir, urls, stateDirPath, now, fetchImpl, run, pdftotextBin, ghBin, contact, endpoints, timeoutMs}
 * @returns {Promise<{records: object[], duplicates: string[], file: string}>} records of THIS run
 */
export async function fetchAll(o) {
  const dir = path.resolve(o.dir);
  assertSafeStore(o.stateDirPath, dir);
  if (existsSync(dir) && !statSync(dir).isDirectory()) throw new FetchFatal("FETCH_DIR_NOT_A_DIRECTORY", `${dir} exists and is not a folder`, "pass the review folder, e.g. propagate kb fetch <dir> <url...>");
  const prior = readFetched(dir);
  const seen = new Map();
  const duplicates = [];
  for (const u of o.urls) {
    const key = canonicalUrl(u);
    if (seen.has(key)) duplicates.push(u);
    else seen.set(key, u);
  }
  const ctx = { ...o, now: o.now ?? Date.now, robotsCache: new Map() };
  const records = [];
  for (const u of seen.values()) {
    // One URL must never cost the batch its records (ISSUE-004). A FetchFatal is a deliberate stop and still stops.
    try {
      records.push(await fetchOne(u, ctx));
    } catch (e) {
      if (e instanceof FetchFatal) throw e;
      records.push({ url: u, final_url: null, status: null, type: null, sha256: null, date: new Date(ctx.now()).toISOString(), classification: "not_retrieved", reason: "unexpected", detail: `unexpected failure: ${String(e?.message ?? e)}`, error: `unexpected failure: ${String(e?.message ?? e)}` });
    }
  }
  mkdirSync(dir, { recursive: true });
  const fresh = new Set(records.map((r) => canonicalUrl(r.url)));
  const kept = (prior?.records ?? []).filter((r) => !fresh.has(canonicalUrl(r.url)));
  const file = path.join(dir, FETCHED_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ schema_version: SCHEMA_VERSION, records: [...kept, ...records] }, null, 2)}\n`);
  renameSync(tmp, file);
  return { records, duplicates, file };
}
