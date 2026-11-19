/**
 * search-usage.mjs — how much external search is used, and how often it fails (propagate #255, plan #133 Stage 0).
 *
 * Derived on demand from the Claude Code transcripts under ~/.claude/projects/ (top-level sessions AND
 * <session>/subagents/*.jsonl). Read-only: nothing here writes. Every later #133 stage is judged by a change
 * in these numbers, so the counters are strict about what they match:
 *
 *   - a CALL is a `tool_use` block, deduped by its id (a resumed or echoed transcript repeats blocks);
 *   - a FAILURE is read from the call's own `tool_result`, never from words anywhere else. `is_error` is
 *     counted on its own; "Not Found" / 429 / timeout / DNS are classified from an error's text, or, for
 *     WebFetch, from the tool's own leading phrase "The server returned HTTP <code>" on a non-error result.
 *     A 429 inside a Read or grep output is a different tool's result and is never seen here.
 *
 * Floor (`rule:derive-dont-curate`): fewer than MIN_TRANSCRIPTS transcripts in scope means the scan has gone
 * blind, which is a different fact from "no search happened".
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { CLAUDE_HOME } from "../core/paths.mjs";

export const MIN_TRANSCRIPTS = 20;
const MAX_DEPTH = 8;

/** The projects directory; PROPAGATE_PROJECTS_DIR overrides it so tests never read the real one. */
export function projectsDir() {
  return process.env.PROPAGATE_PROJECTS_DIR || path.join(CLAUDE_HOME, "projects");
}

export const SOURCES = Object.freeze({
  websearch_standard: "WebSearch (standard)",
  websearch_extended: "WebSearch (extended)",
  webfetch: "WebFetch",
  gh_search: "gh search",
  github_mcp: "github MCP",
  context7: "context7",
  vercel_docs: "Vercel docs",
  semrush: "Semrush",
  ahrefs: "Ahrefs",
  scholar: "Scholar Gateway",
});

const AUTH_TOOL = /__(complete_)?authenticat(e|ion)$/;
const GH_SEARCH = /(^|[\n;&|(]\s*)gh\s+search\s/;
const GITHUB_READ = /^mcp__github__(search_|get_|list_|issue_read|pull_request_read|projects_get|projects_list)/;

/** Which source a tool_use belongs to, or null. */
export function sourceOf(name, input) {
  if (name === "WebSearch") return input?.mode === "extended" ? "websearch_extended" : "websearch_standard";
  if (name === "WebFetch") return "webfetch";
  if (name === "Bash") return typeof input?.command === "string" && GH_SEARCH.test(input.command) ? "gh_search" : null;
  if (typeof name !== "string" || !name.startsWith("mcp__") || AUTH_TOOL.test(name)) return null;
  if (GITHUB_READ.test(name)) return "github_mcp";
  if (/context7/i.test(name)) return "context7";
  if (/^mcp__claude_ai_Vercel__search_vercel_documentation$/.test(name)) return "vercel_docs";
  if (/^mcp__claude_ai_Semrush__/.test(name)) return "semrush";
  if (/^mcp__claude_ai_Ahrefs__/.test(name)) return "ahrefs";
  if (/^mcp__claude_ai_Scholar_Gateway__/.test(name)) return "scholar";
  return null;
}

/** ToolSearch query -> the sources it loads tools for (a query may name several). */
const TOOLSEARCH = [
  ["websearch", /WebSearch/i],
  ["webfetch", /WebFetch/i],
  ["github_mcp", /github/i],
  ["context7", /context7/i],
  ["vercel_docs", /vercel/i],
  ["semrush", /semrush/i],
  ["ahrefs", /ahrefs/i],
  ["scholar", /scholar/i],
];

const BUCKETS = [
  ["pricing_limits", /pricing|price|quota|limit|\bplans?\b|\bcost/],
  ["docs_api", /docs?\b|documentation|\bapi\b|reference|\bsdk\b|guide|how to|tutorial/],
  ["code_repo", /github|\brepo|librar|package|\bnpm\b|open.?source|\bcli\b|skill|plugin|\bmcp\b/],
  ["recent_news", /\b20(2[5-9])\b|latest|release|announce|news|changelog/],
];
export const BUCKET_NAMES = [...BUCKETS.map(([n]) => n), "other"];

export function bucketOf(query) {
  const q = String(query ?? "").toLowerCase();
  for (const [name, re] of BUCKETS) if (re.test(q)) return name;
  return "other";
}
const normQuery = (q) => String(q ?? "").toLowerCase().replace(/\s+/g, " ").trim();

const emptyFailures = () => ({ is_error: 0, not_found: 0, rate_limited: 0, timeout: 0, dns: 0 });

/** Flatten a tool_result's content (string or blocks) to text. */
function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b) => (typeof b === "string" ? b : b?.text ?? "")).join("\n");
  return "";
}

/** Classify one result of a source call. Returns the kinds that apply (independent counters). */
export function classifyResult(isError, text) {
  const kinds = [];
  let httpOther = false;
  if (isError) {
    kinds.push("is_error");
    if (/\b429\b|too many requests|rate.?limit/i.test(text)) kinds.push("rate_limited");
    if (/timeout|timed out|ETIMEDOUT/i.test(text)) kinds.push("timeout");
    if (/ENOTFOUND|getaddrinfo|EAI_AGAIN/i.test(text)) kinds.push("dns");
    if (/\b404\b|\bnot found\b/i.test(text)) kinds.push("not_found");
  } else {
    const m = /^\s*The server returned HTTP (\d{3})\b/.exec(text);
    if (m) {
      if (m[1] === "404") kinds.push("not_found");
      else if (m[1] === "429") kinds.push("rate_limited");
      else httpOther = true;
    }
  }
  return { kinds, httpOther };
}

function parseBound(v, label) {
  if (v == null) return null;
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new Error(`${label}: "${v}" is not a date or ISO timestamp`);
  return t;
}

function listTranscripts(dir) {
  const files = [];
  (function walk(d, depth) {
    if (depth > MAX_DEPTH) return;
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile() && e.name.endsWith(".jsonl")) files.push(full);
    }
  })(dir, 0);
  return files;
}

/**
 * @param {{projectsDir?: string, since?: string|null, until?: string|null, project?: string|null}} [opts]
 *   `since` inclusive, `until` exclusive (a bare date is UTC midnight).
 */
export function searchUsage(opts = {}) {
  const dir = opts.projectsDir ?? projectsDir();
  const since = parseBound(opts.since, "--since");
  const until = parseBound(opts.until, "--until");
  const project = opts.project ?? null;

  const transcripts = { scanned: 0, top_level: 0, subagent: 0, unparsed_lines: 0 };
  const sources = {};
  for (const [id, label] of Object.entries(SOURCES)) sources[id] = { label, calls: 0, failures: emptyFailures(), http_other: 0 };
  const toolsearch = { total: 0 };
  for (const [id] of TOOLSEARCH) toolsearch[id] = 0;
  const queries = new Map();

  const base = {
    span: { since: opts.since ?? null, until: opts.until ?? null, project },
    dir, transcripts, sources, toolsearch,
  };
  if (!existsSync(dir)) {
    return { ...base, blind: true, reason: `projects directory not found: ${dir}`, websearch: summariseQueries(queries) };
  }

  /** id -> {source, isToolSearch, ...}; kept global so a result in one file finds its call in another. */
  const calls = new Map();
  const inSpan = (ts) => {
    if (since == null && until == null) return true;
    const t = Date.parse(ts);
    if (Number.isNaN(t)) return false;
    return (since == null || t >= since) && (until == null || t < until);
  };

  for (const file of listTranscripts(dir)) {
    const rel = path.relative(dir, file);
    if (project && !rel.split(path.sep)[0].includes(project)) continue;
    if (since != null) {
      let m;
      try { m = statSync(file).mtimeMs; } catch { continue; }
      if (m < since) continue; // last write precedes the span: nothing in it can be in range
    }
    transcripts.scanned++;
    if (rel.split(path.sep).includes("subagents")) transcripts.subagent++; else transcripts.top_level++;
    let text;
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line || (!line.includes('"tool_use"') && !line.includes('"tool_result"'))) continue;
      let r;
      try { r = JSON.parse(line); } catch { transcripts.unparsed_lines++; continue; }
      const content = r?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (b?.type === "tool_use" && b.id && !calls.has(b.id)) {
          if (!inSpan(r.timestamp)) continue;
          if (b.name === "ToolSearch") { calls.set(b.id, { toolsearch: String(b.input?.query ?? "") }); continue; }
          const source = sourceOf(b.name, b.input);
          if (source) calls.set(b.id, { source, query: b.name === "WebSearch" ? b.input?.query : null, result: null });
        } else if (b?.type === "tool_result" && b.tool_use_id) {
          const c = calls.get(b.tool_use_id);
          if (c && c.source && !c.result) c.result = classifyResult(b.is_error === true, textOf(b.content));
        }
      }
    }
  }

  for (const c of calls.values()) {
    if (c.toolsearch !== undefined) {
      toolsearch.total++;
      for (const [id, re] of TOOLSEARCH) if (re.test(c.toolsearch)) toolsearch[id]++;
      continue;
    }
    const s = sources[c.source];
    s.calls++;
    if (c.result) {
      for (const k of c.result.kinds) s.failures[k]++;
      if (c.result.httpOther) s.http_other++;
    }
    if (c.source.startsWith("websearch_")) {
      const q = normQuery(c.query);
      const e = queries.get(q) ?? { n: 0, bucket: bucketOf(q) };
      e.n++;
      queries.set(q, e);
    }
  }

  const blind = transcripts.scanned < MIN_TRANSCRIPTS;
  return {
    ...base,
    blind,
    reason: blind ? `only ${transcripts.scanned} transcripts in scope (floor ${MIN_TRANSCRIPTS})` : null,
    websearch: summariseQueries(queries),
  };
}

function summariseQueries(queries) {
  let total = 0, oneOff = 0;
  const buckets = Object.fromEntries(BUCKET_NAMES.map((n) => [n, 0]));
  for (const { n, bucket } of queries.values()) {
    total += n;
    buckets[bucket] += n;
    if (n === 1) oneOff++;
  }
  const distinct = queries.size;
  const rate = (x) => (total ? Math.round((x / total) * 10000) / 10000 : 0);
  return {
    total, distinct, repeated_calls: total - distinct,
    exact_repeat_rate: rate(total - distinct),
    one_off_rate: rate(oneOff),
    buckets,
  };
}
