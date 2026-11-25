/**
 * lib/research/discover.mjs — `propagate kb discover <dir> "<query>" [--engine e] [--limit n] [--lane l] [--json]`
 * (#356, epic #321 S10): deterministic scholarly search, so a literature review finds papers through logged API
 * queries rather than WebSearch alone.
 *
 * WRITES, into <dir> (which must already exist):
 *   discovered.json  array of `{engine, id, doi, title, year, venue, is_peer_reviewed_hint, oa_url, abstract?}`,
 *                    merged with what is there, de-duplicated on (engine, id).
 *   searches.json    array, one `{lane?, engine, query, date, hits}` appended per engine that ANSWERED.
 *
 * KEYS. OPENALEX_API_KEY and S2_API_KEY are read from the environment, sent in a header, and never printed, logged or
 * written: every string leaving this module (stdout, stderr, both files) passes `redact`, so even a server that
 * echoes the key back is scrubbed. A missing key degrades to the keyless rate with one stated line.
 * CONTACT. The polite pool wants an address: PROPAGATE_KB_CONTACT, or `kbContact` under `integrations:`
 * in config.yml. With none set the command says so; it never guesses one.
 *
 * EXIT CODES. 0 at least one hit and every engine answered. 1 every engine answered and none had a hit (stated per
 * engine). 2 could not run: usage, a missing <dir>, or ANY engine that failed (a daily-budget 429, a response it could
 * not understand, a network error). A failed engine never reads as 0 results; results the other engines returned are
 * still written and the failure is stated beside them.
 * Every exit-2 line names what failed and why in ONE line and contains the word "error" (or "could", "429",
 * "budget"), so a coordinator that filters stderr for those words never loses a failure (#364).
 * SPACING ACROSS RUNS (#364). An engine's minimum interval (arXiv: one request per 3 s) used to hold only inside one
 * process, but a coordinator runs one `kb discover` per query. The time of each engine's last request is kept in
 * `$STATE/kb/discover-last-request.json` (written atomically), and a new request waits out the remainder, never more
 * than one interval. A missing or unreadable file means "no wait" plus ONE stated note, never a crash.
 * No real network in the suite: `inject.fetch` replaces the global fetch; `inject.now`/`inject.sleep` the clock.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ENGINES, ENGINE_IDS, Malformed } from "./discover-engines.mjs";
import { stateDir } from "../core/paths.mjs";

export const DISCOVER_USAGE = 'usage: propagate kb discover <dir> "<query>" [--engine openalex|s2|arxiv|crossref] [--limit n] [--lane <name>] [--json]';
export const CONTACT_ENV = "PROPAGATE_KB_CONTACT";
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const MAX_RETRIES = 2;
const MAX_RETRY_WAIT_MS = 60000;

const fail = (code, what, next) => ({ ok: false, code, what, next });
const REDACTED = "[redacted]";

/** Replace every secret in `text`. Longest first, so a secret that contains another is wholly removed. */
export function redact(text, secrets) {
  let out = String(text);
  for (const s of [...secrets].filter((x) => typeof x === "string" && x.length > 0).sort((a, b) => b.length - a.length)) out = out.split(s).join(REDACTED);
  return out;
}

export const LAST_REQUEST_FILE = "discover-last-request.json";

/** Read `{engine: ms}`. Never throws: `{times, warning}`; a warning means "no wait, and say why". */
function readLast(file) {
  if (!existsSync(file)) return { times: {}, warning: `${file} does not exist yet: no cross-run wait this time (first run, or state was cleared)` };
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("not a JSON object");
    const times = {};
    for (const [k, v] of Object.entries(j)) if (Number.isFinite(v)) times[k] = v;
    return { times, warning: null };
  } catch (err) {
    return { times: {}, warning: `${file} is unreadable (${err.message}): no cross-run wait this time; it is rewritten on the next request` };
  }
}

/** Atomic merge-write of one engine's timestamp. Returns a warning string on failure, else null. */
function writeLast(file, engine, ms) {
  try {
    const cur = readLast(file).times;
    cur[engine] = ms;
    mkdirSync(path.dirname(file), { recursive: true });
    const tmpFile = `${file}.${process.pid}.tmp`;
    writeFileSync(tmpFile, JSON.stringify(cur) + "\n");
    renameSync(tmpFile, file);
    return null;
  } catch (err) {
    return `could not record the last-request time in ${file} (${err.message}): the next run will not wait`;
  }
}

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

/** One engine, one query. Never throws: returns `{engine, status:"ok"|"failed", rows?, code?, reason?}`. */
async function runEngine(eng, { query, limit, key, contact, fetchFn, sleep, now, last, lastFile, persisted, warn }) {
  const req = eng.request({ query, limit, key, contact });
  for (let attempt = 0; ; attempt++) {
    const interval = eng.minIntervalMs(Boolean(key));
    const prev = Math.max(last.get(eng.id) ?? 0, persisted[eng.id] ?? 0);
    // Capped at one interval: a timestamp from the future (clock moved back) must not stall the run for hours.
    const wait = Math.min(interval, prev + interval - now());
    if (wait > 0) await sleep(wait);
    const t = now();
    last.set(eng.id, t);
    const w = writeLast(lastFile, eng.id, t);
    if (w) warn(w);
    let res;
    let body;
    try {
      res = await fetchFn(req.url, { headers: { Accept: "*/*", ...req.headers }, signal: AbortSignal.timeout(30000) });
      body = await res.text();
    } catch (err) {
      return { engine: eng.id, status: "failed", code: "DISCOVER_NETWORK", reason: `${eng.id}: error: request failed (${err.message})` };
    }
    if (res.status === 429) {
      let reason = null;
      let message = null;
      try {
        const j = JSON.parse(body);
        reason = j?.reason ?? null;
        message = typeof j?.message === "string" ? j.message.slice(0, 200) : null;
      } catch {
        /* a 429 with a non-JSON body is a per-second 429 */
      }
      if (reason === "daily_budget") {
        return { engine: eng.id, status: "failed", code: "DISCOVER_DAILY_BUDGET", reason: `${eng.id}: daily budget spent (429 reason: daily_budget); it resets at midnight UTC, not retried` };
      }
      if (attempt >= MAX_RETRIES) {
        return { engine: eng.id, status: "failed", code: "DISCOVER_RATE_LIMIT", reason: `${eng.id}: still rate limited (429${reason ? ` reason: ${reason}` : ""}) after ${MAX_RETRIES} retries${message ? `: ${message}` : ""}` };
      }
      let ra = Number(res.headers?.get?.("retry-after"));
      await sleep(Math.min(MAX_RETRY_WAIT_MS, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000));
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      return { engine: eng.id, status: "failed", code: "DISCOVER_HTTP", reason: `${eng.id}: error: HTTP ${res.status}` };
    }
    try {
      return { engine: eng.id, status: "ok", rows: eng.parse(body) };
    } catch (err) {
      if (!(err instanceof Malformed)) throw err;
      return { engine: eng.id, status: "failed", code: "DISCOVER_MALFORMED", reason: `${eng.id}: error: could not understand the response (${err.message}); this is not "0 results"` };
    }
  }
}

function readArray(file) {
  if (!existsSync(file)) return { ok: true, rows: [] };
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(j)) return { ok: false, why: `${file} is not a JSON array` };
    return { ok: true, rows: j };
  } catch (err) {
    return { ok: false, why: `${file} is not readable JSON (${err.message})` };
  }
}

/**
 * @param {string[]} rest everything after `discover`
 * @param {object} inject tests: io, fetch, env, now (ms), sleep, contact
 */
export async function discoverCmd(rest, inject = {}) {
  const io = inject.io ?? console;
  const env = inject.env ?? process.env;
  const asJson = rest.includes("--json");
  const emit = (f) => {
    if (asJson) io.log(JSON.stringify(f, null, 2));
    else io.error(`${f.code}: error: kb discover (no engine ran): ${f.what}. Next: ${f.next}`);
    return 2;
  };

  const pos = [];
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--json") continue;
    if (a === "--engine" || a === "--limit" || a === "--lane") {
      const v = rest[i + 1];
      if (v === undefined || v.startsWith("--")) return emit(fail("DISCOVER_USAGE", `${a} needs a value`, DISCOVER_USAGE));
      flags[a] = v;
      i++;
    } else if (a.startsWith("--")) return emit(fail("DISCOVER_USAGE", `unknown argument ${a}`, DISCOVER_USAGE));
    else pos.push(a);
  }
  if (pos.length !== 2 || !pos[1].trim()) return emit(fail("DISCOVER_USAGE", "kb discover needs a <dir> and a quoted \"<query>\"", DISCOVER_USAGE));
  const [dir, query] = pos;
  if (flags["--engine"] !== undefined && !ENGINE_IDS.includes(flags["--engine"])) {
    return emit(fail("DISCOVER_USAGE", `--engine must be one of ${ENGINE_IDS.join(", ")}, got ${JSON.stringify(flags["--engine"])}`, DISCOVER_USAGE));
  }
  let limit = DEFAULT_LIMIT;
  if (flags["--limit"] !== undefined) {
    limit = Number(flags["--limit"]);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return emit(fail("DISCOVER_USAGE", `--limit must be an integer from 1 to ${MAX_LIMIT}`, DISCOVER_USAGE));
  }
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return emit(fail("DISCOVER_DIR", `${path.resolve(dir)} is not an existing directory`, "create the review folder first, then re-run"));

  const discoveredFile = path.join(dir, "discovered.json");
  const searchesFile = path.join(dir, "searches.json");
  const prior = readArray(discoveredFile);
  const log = readArray(searchesFile);
  for (const r of [prior, log]) if (!r.ok) return emit(fail("DISCOVER_STORE", r.why, "fix or move the file named above; discover never overwrites what it cannot read"));

  const contact = inject.contact ?? env[CONTACT_ENV] ?? null;
  const keys = { openalex: env.OPENALEX_API_KEY || null, s2: env.S2_API_KEY || null };
  const secrets = Object.values(keys).filter(Boolean);
  const engines = ENGINES.filter((e) => !flags["--engine"] || e.id === flags["--engine"]);

  const notes = [];
  for (const e of engines) {
    if (e.keyEnv && !keys[e.id]) notes.push(`${e.keyEnv} is not set: ${e.id} runs at the keyless rate`);
  }
  if (!contact) notes.push(`no contact address for the polite pool: set ${CONTACT_ENV} (or kbContact under integrations: in config.yml); requests go without one`);

  const fetchFn = inject.fetch ?? globalThis.fetch;
  const sleep = inject.sleep ?? sleepReal;
  const now = inject.now ?? Date.now;
  const last = new Map();
  const lastFile = path.join(inject.stateDirPath ?? stateDir(), "kb", LAST_REQUEST_FILE);
  const stored = readLast(lastFile);
  if (stored.warning) notes.push(stored.warning);
  const warn = (w) => {
    if (!notes.includes(w)) notes.push(w);
  };
  const date = new Date(now()).toISOString().slice(0, 10);

  const outcomes = [];
  for (const e of engines) outcomes.push(await runEngine(e, { query, limit, key: keys[e.id] ?? null, contact, fetchFn, sleep, now, last, lastFile, persisted: stored.times, warn }));

  const seen = new Set(prior.rows.map((r) => `${r.engine}\u0000${r.id}`));
  const merged = [...prior.rows];
  const searchLog = [...log.rows];
  for (const o of outcomes) {
    if (o.status !== "ok") continue;
    for (const row of o.rows) {
      const k = `${row.engine}\u0000${row.id}`;
      if (!seen.has(k)) {
        seen.add(k);
        merged.push(row);
      }
    }
    searchLog.push({ ...(flags["--lane"] ? { lane: flags["--lane"] } : {}), engine: o.engine, query, date, hits: o.rows.length });
  }
  const anyOk = outcomes.some((o) => o.status === "ok");
  if (anyOk) {
    writeFileSync(discoveredFile, redact(JSON.stringify(merged, null, 2), secrets) + "\n");
    writeFileSync(searchesFile, redact(JSON.stringify(searchLog, null, 2), secrets) + "\n");
  }

  const failed = outcomes.filter((o) => o.status === "failed");
  const totalHits = outcomes.reduce((n, o) => n + (o.rows?.length ?? 0), 0);
  const exit = failed.length ? 2 : totalHits === 0 ? 1 : 0;
  const perEngine = outcomes.map((o) => (o.status === "ok" ? { engine: o.engine, status: o.rows.length ? "hits" : "zero", hits: o.rows.length } : { engine: o.engine, status: "failed", code: o.code, reason: o.reason }));

  if (asJson) {
    io.log(redact(JSON.stringify({ ok: exit === 0, exit, query, dir: path.resolve(dir), limit, engines: perEngine, notes, wrote: anyOk ? [discoveredFile, searchesFile] : [], results: outcomes.flatMap((o) => o.rows ?? []) }, null, 2), secrets));
    return exit;
  }
  for (const n of notes) io.error(redact(n, secrets));
  for (const p of perEngine) {
    if (p.status === "failed") io.error(redact(`${p.code}: ${p.reason}`, secrets));
    else io.log(`${p.engine}: ${p.hits === 0 ? "0 hits from " + p.engine : p.hits + " hit(s)"}`);
  }
  if (anyOk) io.log(`wrote ${discoveredFile} (${merged.length} total) and ${searchesFile}`);
  if (exit === 1) io.log(redact(`0 hits from every engine asked (${engines.map((e) => e.id).join(", ")}) for ${JSON.stringify(query)}`, secrets));
  return exit;
}
