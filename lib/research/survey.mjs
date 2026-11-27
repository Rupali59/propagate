/**
 * lib/research/survey.mjs — `propagate kb survey "<question>" [...]` and `kb survey verify <claims.json>` (#401, epic
 * #321 S3): one call that finds papers, repos, packages, skills and plugins for a question and prints them as JSON, so
 * any agent can use it without driving six engines by hand.
 *
 * REUSE. Discovery is `discoverCmd` (lib/research/discover.mjs), called with a capturing `io` and `--json`, run in the
 * survey directory; its `engines` list is the source of `sources_run` / `sources_failed`, and the de-duplicated rows it
 * wrote to `<dir>/discovered.json` are the items. Fetching is `fetchAll` (lib/research/fetch.mjs). Quote checking is
 * lib/research/quotes.mjs. Nothing here re-implements any of them.
 *
 * WRITES. Only `<dir>` (default `$STATE/kb/surveys/<YYYY-MM-DD>-<slug>/`: discovered.json, searches.json, and with
 * --fetch fetched.json), `$STATE/kb/fetched/<sha>` (the existing body store) and, through discover, the existing
 * `$STATE/kb/discover-last-request.json` that spaces an engine's requests across runs. Never the knowledge base, the
 * hub or the event store. `kb survey verify` is pure and writes nothing.
 *
 * EXIT CODES (survey). 0 at least one item and no source failed. 1 no item and no source failed. 2 any source failed,
 * a usage error, or the store could not be written. On a 2 the items the other sources found are still printed and
 * `sources_failed` names each failure: a failure never reads as 0 items.
 * EXIT CODES (verify). 0 every quote ok. 1 any quote not ok. 2 unreadable input.
 */
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { discoverCmd } from "./discover.mjs";
import { FetchFatal, canonicalUrl, fetchAll } from "./fetch.mjs";
import { MAX_QUOTE_WORDS, MIN_QUOTE_WORDS, checkQuoteLength, findQuote } from "./quotes.mjs";
import { stateDir } from "../core/paths.mjs";

export const SURVEY_USAGE = 'usage: propagate kb survey "<question>" [--sources academic|code|skills|all] [--engine <id>] [--limit n] [--fetch] [--json] [--dir <d>] [--timeout <s>] | kb survey verify <claims.json> [--json]';
export const DEFAULT_TIMEOUT_S = 120;
const SLUG_MAX = 60;

const fail = (code, what, next) => ({ ok: false, code, what, next });

/** `YYYY-MM-DD-<slug>`'s slug: lower-case, runs of non-alphanumerics to one hyphen, at most SLUG_MAX characters. */
export function slugify(question) {
  const s = String(question).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, SLUG_MAX).replace(/-+$/g, "");
  return s || "survey";
}

function emitUsage(f, asJson, io) {
  if (asJson) io.log(JSON.stringify(f, null, 2));
  else io.error(`${f.code}: error: ${f.what}. Next: ${f.next}`);
  return 2;
}

/** A discover failure the engines list cannot express (usage, a store it could not read) as a one-line message. */
function discoverFailure(text) {
  try {
    const j = JSON.parse(text);
    if (j && typeof j === "object" && !Array.isArray(j) && j.code) return { engine: "discover", code: j.code, message: `${j.what ?? ""}${j.next ? `. Next: ${j.next}` : ""}`.trim() };
  } catch {
    /* not JSON: fall through */
  }
  return null;
}

/** Wait for `p`, or resolve `{timedOut:true}` after `ms`. The timer never keeps the process alive. */
function withTimeout(p, ms) {
  let timer;
  const t = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
    timer.unref?.();
  });
  return Promise.race([p.then((v) => ({ value: v })), t]).finally(() => clearTimeout(timer));
}

const itemUrl = (r) => r.url ?? r.oa_url ?? (typeof r.doi === "string" && r.doi ? `https://doi.org/${r.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")}` : null);

function toItem(r) {
  return { kind: r.kind ?? "paper", key: r.key, title: r.title ?? "", url: itemUrl(r), updated: r.updated ?? null, engines: Array.isArray(r.engines) ? r.engines : r.engine ? [r.engine] : [] };
}

/**
 * @param {string[]} rest everything after `survey`
 * @param {object} inject tests: io, env, fetch (discover), fetchImpl (fetch; defaults to `fetch`), gh, run, now, sleep, contact, stateDirPath
 */
export async function surveyCmd(rest, inject = {}) {
  if (rest[0] === "verify") return verifyCmd(rest.slice(1), inject);
  const io = inject.io ?? console;
  const asJson = rest.includes("--json");
  const pos = [];
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--json" || a === "--fetch") {
      flags[a] = true;
    } else if (["--sources", "--engine", "--limit", "--dir", "--timeout"].includes(a)) {
      const v = rest[i + 1];
      if (v === undefined || v.startsWith("--")) return emitUsage(fail("SURVEY_USAGE", `${a} needs a value`, SURVEY_USAGE), asJson, io);
      flags[a] = v;
      i++;
    } else if (a.startsWith("--")) return emitUsage(fail("SURVEY_USAGE", `unknown argument ${a}`, SURVEY_USAGE), asJson, io);
    else pos.push(a);
  }
  if (pos.length !== 1 || !pos[0].trim()) return emitUsage(fail("SURVEY_USAGE", 'kb survey needs one quoted "<question>"', SURVEY_USAGE), asJson, io);
  const question = pos[0].trim();
  let timeoutS = DEFAULT_TIMEOUT_S;
  if (flags["--timeout"] !== undefined) {
    timeoutS = Number(flags["--timeout"]);
    if (!Number.isFinite(timeoutS) || timeoutS <= 0) return emitUsage(fail("SURVEY_USAGE", "--timeout must be a positive number of seconds", SURVEY_USAGE), asJson, io);
  }

  const state = inject.stateDirPath ?? stateDir();
  const now = inject.now ?? Date.now;
  const dir = path.resolve(flags["--dir"] ?? path.join(state, "kb", "surveys", `${new Date(now()).toISOString().slice(0, 10)}-${slugify(question)}`));
  try {
    if (existsSync(dir) && !statSync(dir).isDirectory()) throw new Error("it exists and is not a folder");
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    return emitUsage(fail("SURVEY_STORE", `the survey folder ${dir} could not be written (${e.message})`, "pass --dir <an existing or new folder you can write to>"), asJson, io);
  }

  // Discovery: the real discoverCmd, captured. A survey is meant to be broad, so the default is --sources all.
  const dargs = [dir, question, "--json"];
  if (flags["--engine"] !== undefined) dargs.push("--engine", flags["--engine"]);
  else dargs.push("--sources", flags["--sources"] ?? "all");
  if (flags["--limit"] !== undefined) dargs.push("--limit", flags["--limit"]);
  const captured = [];
  const cap = { log: (...a) => captured.push(a.join(" ")), error: () => {} };
  const run = discoverCmd(dargs, { ...inject, io: cap, stateDirPath: state, now });
  const settled = await withTimeout(run, timeoutS * 1000);

  const sourcesRun = [];
  const sourcesFailed = [];
  let results = [];
  let engineIds = [];
  if (settled.timedOut) {
    // discover reports per engine only when it finishes, so on a timeout no engine is known to have answered.
    const { SOURCE_GROUPS, ALL_ENGINE_IDS } = await import("./discover-engines.mjs");
    const groups = (flags["--sources"] ?? "all").split(",").map((g) => g.trim());
    engineIds = flags["--engine"] !== undefined ? [flags["--engine"]] : [...new Set(groups.flatMap((g) => SOURCE_GROUPS[g] ?? []))];
    if (!engineIds.length) engineIds = ALL_ENGINE_IDS;
    for (const id of engineIds) sourcesFailed.push({ engine: id, code: "SURVEY_TIMEOUT", message: `${id}: did not finish within ${timeoutS} s` });
  } else {
    const text = captured.join("\n");
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* handled below */
    }
    if (parsed && Array.isArray(parsed.engines)) {
      for (const e of parsed.engines) {
        engineIds.push(e.engine);
        if (e.status === "failed") sourcesFailed.push({ engine: e.engine, code: e.code ?? "DISCOVER_FAILED", message: e.reason ?? "failed" });
        else sourcesRun.push(e.engine);
      }
      results = Array.isArray(parsed.results) ? parsed.results : [];
    } else {
      sourcesFailed.push(discoverFailure(text) ?? { engine: "discover", code: "SURVEY_DISCOVER", message: "discover returned nothing this command could read; this is not 0 items" });
    }
  }

  // Items: the rows discover merged into discovered.json, limited to the keys this run returned.
  let items = [];
  const file = path.join(dir, "discovered.json");
  const wanted = new Set(results.map((r) => r.key));
  if (existsSync(file) && wanted.size) {
    try {
      const rows = JSON.parse(readFileSync(file, "utf8"));
      items = rows.filter((r) => r && wanted.has(r.key)).map(toItem);
    } catch (e) {
      sourcesFailed.push({ engine: "discover", code: "SURVEY_STORE", message: `${file} could not be read (${e.message})` });
    }
  }
  const asDiscovered = new Map(items.map((it) => [it.key, it]));
  for (const r of results) if (!asDiscovered.has(r.key)) items.push(toItem(r)), asDiscovered.set(r.key, items[items.length - 1]);

  // Fetching.
  let fetchedOk;
  let notRetrieved;
  if (flags["--fetch"] && !settled.timedOut) {
    const withUrl = items.filter((it) => it.url);
    if (withUrl.length) {
      try {
        const out = await fetchAll({
          dir, urls: withUrl.map((it) => it.url), stateDirPath: state, now, fetchImpl: inject.fetchImpl, run: inject.run,
          pdftotextBin: inject.pdftotextBin, ghBin: inject.ghBin, contact: typeof inject.contact === "string" && inject.contact.trim() ? inject.contact.trim() : null,
          endpoints: inject.endpoints, timeoutMs: inject.timeoutMs,
        });
        const byUrl = new Map(out.records.map((r) => [canonicalUrl(r.url), r]));
        fetchedOk = 0;
        notRetrieved = 0;
        for (const it of withUrl) {
          const rec = byUrl.get(canonicalUrl(it.url));
          if (rec && rec.classification === "ok" && rec.sha256) {
            it.body_path = path.join(state, "kb", "fetched", rec.sha256);
            it.status = "ok";
            fetchedOk++;
          } else {
            it.status = "not_retrieved";
            it.reason = rec ? (rec.reason ?? rec.classification) : "unexpected";
            notRetrieved++;
          }
        }
      } catch (e) {
        if (!(e instanceof FetchFatal)) throw e;
        sourcesFailed.push({ engine: "fetch", code: e.code, message: `${e.what}. Next: ${e.next}` });
      }
    }
  }

  const byKind = {};
  for (const it of items) byKind[it.kind] = (byKind[it.kind] ?? 0) + 1;
  const counts = { items: items.length, by_kind: byKind };
  if (fetchedOk !== undefined) Object.assign(counts, { fetched_ok: fetchedOk, not_retrieved: notRetrieved });
  const exit = sourcesFailed.length ? 2 : items.length === 0 ? 1 : 0;
  const payload = { question, dir, sources_run: sourcesRun, sources_failed: sourcesFailed, items, counts };

  if (asJson) {
    io.log(JSON.stringify(payload, null, 2));
    return exit;
  }
  for (const it of items) io.log(`${it.kind}  ${it.key}  ${it.title}${it.status ? `  [${it.status}${it.reason ? `: ${it.reason}` : ""}]` : ""}`);
  const kinds = Object.entries(byKind).map(([k, n]) => `${k} ${n}`).join(", ");
  io.log(`${items.length} item(s)${kinds ? ` (${kinds})` : ""} from ${sourcesRun.length} source(s) in ${dir}${fetchedOk !== undefined ? `; fetched ${fetchedOk} ok, ${notRetrieved} not_retrieved` : ""}`);
  if (items.length === 0 && !sourcesFailed.length) io.log(`0 items from every source asked (${sourcesRun.join(", ")}) for ${JSON.stringify(question)}`);
  for (const f of sourcesFailed) io.error(`${f.code}: error: ${f.engine}: ${f.message}`);
  return exit;
}

/**
 * `kb survey verify <claims.json> [--json]`: for each quote of each claim, its length and `findQuote` against the body
 * (`body_path`, or `sha256` resolved to `$STATE/kb/fetched/<sha>`). Pure: writes nothing.
 */
export async function verifyCmd(rest, inject = {}) {
  const io = inject.io ?? console;
  const asJson = rest.includes("--json");
  const pos = rest.filter((a) => a !== "--json");
  const bad = pos.find((a) => a.startsWith("--"));
  if (bad) return emitUsage(fail("SURVEY_USAGE", `unknown argument ${bad}`, SURVEY_USAGE), asJson, io);
  if (pos.length !== 1) return emitUsage(fail("SURVEY_USAGE", "kb survey verify needs one <claims.json>", SURVEY_USAGE), asJson, io);
  let claims;
  try {
    const j = JSON.parse(readFileSync(pos[0], "utf8"));
    if (!j || !Array.isArray(j.claims)) throw new Error("no `claims` array");
    for (const [i, c] of j.claims.entries()) {
      if (!c || typeof c.text !== "string" || !Array.isArray(c.quotes)) throw new Error(`claim ${i} needs a string \`text\` and a \`quotes\` array`);
      for (const [k, q] of c.quotes.entries()) if (!q || typeof q.text !== "string" || (typeof q.body_path !== "string" && typeof q.sha256 !== "string")) throw new Error(`claim ${i} quote ${k} needs \`text\` and a \`body_path\` or \`sha256\``);
    }
    claims = j.claims;
  } catch (e) {
    return emitUsage(fail("SURVEY_INPUT", `${pos[0]} could not be read as claims (${e.message})`, 'pass {"claims":[{"text":"...","quotes":[{"text":"...","body_path":"..."}]}]}'), asJson, io);
  }
  const state = inject.stateDirPath ?? stateDir();
  const bodies = new Map();
  const bodyOf = (q) => {
    const p = typeof q.body_path === "string" ? q.body_path : path.join(state, "kb", "fetched", q.sha256);
    if (!bodies.has(p)) {
      try {
        bodies.set(p, readFileSync(p, "utf8"));
      } catch {
        bodies.set(p, null);
      }
    }
    return bodies.get(p);
  };
  const rows = [];
  for (const c of claims) {
    for (const q of c.quotes) {
      const len = checkQuoteLength(q.text);
      let row;
      if (!len.ok) row = { claim: c.text, quote: q.text, ok: false, reason: len.words < MIN_QUOTE_WORDS ? "too_short" : "too_long" };
      else {
        const body = bodyOf(q);
        if (body === null) row = { claim: c.text, quote: q.text, ok: false, reason: "body_missing" };
        else row = findQuote(body, q.text).found ? { claim: c.text, quote: q.text, ok: true } : { claim: c.text, quote: q.text, ok: false, reason: "not_found" };
      }
      rows.push(row);
    }
  }
  const failed = rows.filter((r) => !r.ok).length;
  const exit = failed ? 1 : 0;
  if (asJson) {
    io.log(JSON.stringify({ ok: exit === 0, results: rows }, null, 2));
    return exit;
  }
  for (const r of rows) io.log(`${r.ok ? "ok       " : r.reason.padEnd(9)} ${JSON.stringify(r.quote)}  (claim: ${r.claim})`);
  io.log(`${rows.length - failed} of ${rows.length} quote(s) ok (${MIN_QUOTE_WORDS}-${MAX_QUOTE_WORDS} words, found verbatim)`);
  return exit;
}
