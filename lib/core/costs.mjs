/**
 * lib/core/costs.mjs — an append-only ledger of what a finished subagent lane cost.
 *
 * propagate#188. `rule:record-completion-cost` asks for start/end time, week_pct and
 * cc_cost_week at both ends, and the lane's own tokens. Nothing recorded them, and the
 * "tokens" figure shown when a lane finishes turned out to be its FINAL API REQUEST only
 * (measured 2026-11-06: 173,860 reported against 2,575,333 cache_read + 152,467
 * cache_create + 17,305 output actually spent). The truth is in the subagent transcript:
 * `usage` on each assistant message, deduped by `message.id`.
 *
 * Store discipline is copied from lib/core/runs.mjs:
 *   - $PROPAGATE_STATE_DIR/costs/<YYYY-MM>.jsonl (default ~/.propagate/costs/), sharded by
 *     UTC month of the row's `ts`. Machine-local on purpose: the hub's propagation/state/
 *     is committed, and every lane would be a commit.
 *   - Append only. No function here edits or rewrites a row.
 *   - A read counts malformed lines in `malformed` and never throws.
 *   - Root is computed per call (not at import), so a test or the hook picks up
 *     PROPAGATE_STATE_DIR as it is at the time of the call.
 *
 * Deliberately NOT imported from lib/core/config.mjs: that module walks the filesystem at
 * import (100-470ms, paths.mjs header) and a hook pays it on every subagent stop.
 *
 * No dollars field in v1: per-type pricing is an estimate that needs a price table.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { stateDir, HOME } from "./paths.mjs";

export const ATTRIBUTION = "week deltas are an upper bound: shared by every parallel session";

/** A reading older than this before the lane's timestamp is "missing", not stale-but-used. */
export const READING_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** The widget's sample stream. */
export const DEFAULT_SAMPLES_PATH = path.join(HOME, ".local", "state", "claude-usage-widget", "samples.jsonl");

/** The samples file; PROPAGATE_SAMPLES_PATH overrides it so tests never read the real one. */
export function samplesPath() {
  return process.env.PROPAGATE_SAMPLES_PATH || DEFAULT_SAMPLES_PATH;
}

/** $STATE_DIR/costs, computed at call time. */
export function costsDir() {
  return path.join(stateDir(), "costs");
}

/** `2026-11.jsonl` for an ISO timestamp, same key as runs.mjs. */
export function shardFileForTs(ts) {
  const iso = ts instanceof Date ? ts.toISOString() : ts;
  return `${iso.slice(0, 7)}.jsonl`;
}

export function shardPathForTs(ts) {
  return path.join(costsDir(), shardFileForTs(ts));
}

/**
 * Sum a subagent transcript's usage by type, once per unique `message.id`.
 *
 * The same message.id repeats across lines (one line per content block), so summing lines
 * over-counts: measured 34 assistant lines for 18 API calls. Duplicates carry identical
 * usage; the last occurrence wins.
 *
 * Never returns zeros for input it could not read: `{unreadable:true,reason}` for a file it
 * cannot open, `{empty:true}` for one with no assistant usage (rule:discernment-checks §2).
 *
 * @param {string} transcriptPath
 * @returns {{api_calls:number, usage:{input:number,output:number,cache_create:number,cache_read:number},
 *   models:string[], start:string|null, end:string|null, malformed:number}
 *   | {unreadable:true, reason:string} | {empty:true, malformed:number}}
 */
export function summarizeTranscript(transcriptPath) {
  let raw;
  try {
    raw = readFileSync(transcriptPath, "utf8");
  } catch (err) {
    return { unreadable: true, reason: err?.code || String(err?.message || err) };
  }

  const byId = new Map();
  let malformed = 0;
  let start = null;
  let end = null;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      malformed++;
      continue;
    }
    if (typeof row?.timestamp === "string") {
      if (start === null) start = row.timestamp;
      end = row.timestamp;
    }
    const msg = row?.message;
    if (row?.type !== "assistant" || !msg || typeof msg.id !== "string" || !msg.usage) continue;
    byId.set(msg.id, msg);
  }

  if (byId.size === 0) return { empty: true, malformed };

  const usage = { input: 0, output: 0, cache_create: 0, cache_read: 0 };
  const models = new Set();
  for (const msg of byId.values()) {
    const u = msg.usage;
    usage.input += u.input_tokens || 0;
    usage.output += u.output_tokens || 0;
    usage.cache_create += u.cache_creation_input_tokens || 0;
    usage.cache_read += u.cache_read_input_tokens || 0;
    if (msg.model) models.add(msg.model);
  }
  return { api_calls: byId.size, usage, models: [...models], start, end, malformed };
}

/** The marker a `costs window` invocation leaves in a transcript; the default `until` stops before the last one. */
export const SELF_INVOCATION_MARKER = "costs window";

/**
 * What an anchor may match: `text` blocks and `tool_use` inputs only. Never `thinking`,
 * `redacted_thinking` or any `signature` (base64 that matches short patterns by accident).
 */
function searchableText(content) {
  if (typeof content === "string") return content + "\n";
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const b of content) {
    if (b?.type === "text" && typeof b.text === "string") out += b.text + "\n";
    else if (b?.type === "tool_use") out += JSON.stringify(b.input ?? {}) + "\n";
  }
  return out;
}

/**
 * Group a session transcript into API messages (propagate#233).
 *
 * Claude Code writes each content block of one assistant message as its OWN line under one
 * `message.id`. So a message here is: its EARLIEST line's timestamp, its LAST usage (same
 * dedupe as summarizeTranscript), and ALL its content blocks concatenated, so a tool input in
 * the 3rd block is searchable (a per-line view loses both the dedupe and the anchor).
 */
function groupMessages(raw) {
  const byId = new Map();
  let malformed = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      malformed++;
      continue;
    }
    const msg = row?.message;
    if (row?.type !== "assistant" || !msg || typeof msg.id !== "string") continue;
    const ms = Date.parse(row.timestamp);
    let m = byId.get(msg.id);
    if (!m) {
      m = { id: msg.id, ts: ms, text: "", usage: null, model: null };
      byId.set(msg.id, m);
    }
    if (Number.isFinite(ms) && (!Number.isFinite(m.ts) || ms < m.ts)) m.ts = ms;
    m.text += searchableText(msg.content);
    if (msg.usage) m.usage = msg.usage;
    if (msg.model) m.model = msg.model;
  }
  const messages = [...byId.values()].filter((m) => Number.isFinite(m.ts)).sort((a, b) => a.ts - b.ts);
  return { messages, malformed };
}

const ANCHOR_PREFIX = "anchor:";

/** ~80 characters of the message's text centred on the regex match, JSON escaping noise flattened. */
function excerpt(m, re) {
  const hit = re.exec(m.text);
  const at = hit ? hit.index : 0;
  const len = hit ? hit[0].length : 0;
  const start = Math.max(0, at + Math.floor(len / 2) - 40);
  return m.text
    .slice(start, start + Math.max(80, len))
    .replace(/\\[nrt]/g, " ")
    .replace(/\\(["\\])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Tokens and minutes for a window of a MAIN-session transcript (the cost ledger only has lanes).
 *
 * Bounds, in order: since <= from <= to <= until. `since` is a lower bound for anchor resolution
 * and for the window (earlier messages are ignored entirely: an anchor can match an earlier
 * session-day). `from`/`to` are ISO timestamps or `anchor:<regex>`; `from` anchors to the FIRST
 * matching message in range, `to` to the LAST one at or before `until`. `until` defaults to just
 * before the latest message containing "costs window" (exclusive), so the command's own text
 * cannot satisfy its own anchors; an explicit `until` is inclusive and overrides.
 *
 * Never returns zeros for something it could not resolve: `{error, ...}` (rule:discernment-checks §2).
 *
 * @param {string} transcriptPath
 * @param {{from:string,to:string,since?:string,until?:string}} opts
 */
export function summarizeWindow(transcriptPath, opts = {}) {
  let raw;
  try {
    raw = readFileSync(transcriptPath, "utf8");
  } catch (err) {
    return { error: "unreadable", reason: err?.code || String(err?.message || err) };
  }
  const { messages: all, malformed } = groupMessages(raw);
  if (all.length === 0) return { error: "empty", reason: "no assistant messages", malformed };

  const iso = (v, which) => {
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? ms : { error: "bad-timestamp", which, value: v };
  };

  let sinceMs = -Infinity;
  if (opts.since != null) {
    sinceMs = iso(opts.since, "since");
    if (typeof sinceMs !== "number") return sinceMs;
  }

  let untilMs = Infinity;
  let untilExclusive = false;
  let untilSource = "none (no costs window invocation found)";
  if (opts.until != null) {
    untilMs = iso(opts.until, "until");
    if (typeof untilMs !== "number") return untilMs;
    untilSource = "explicit";
  } else {
    for (const m of all) {
      if (m.text.includes(SELF_INVOCATION_MARKER) && (!untilExclusive || m.ts > untilMs)) {
        untilMs = m.ts;
        untilExclusive = true;
        untilSource = "latest message containing 'costs window' (excluded)";
      }
    }
  }

  const inRange = (m) => m.ts >= sinceMs && (untilExclusive ? m.ts < untilMs : m.ts <= untilMs);
  const messages = all.filter(inRange);

  const resolve = (spec, which) => {
    if (typeof spec === "string" && spec.startsWith(ANCHOR_PREFIX)) {
      let re;
      try {
        re = new RegExp(spec.slice(ANCHOR_PREFIX.length));
      } catch (err) {
        return { error: "bad-anchor", which, reason: String(err.message) };
      }
      // A message quoting a `costs window` invocation can never be an anchor (it would match its own,
      // or an earlier run's, quoted anchors). It still COUNTS toward usage: that spend is real.
      // Also skip any message quoting the anchor as typed (`anchor:<pattern>`): every invocation does,
      // however it was spelled, and a genuine working message holds the matched text, never that form.
      const typed = [spec, JSON.stringify(spec).slice(1, -1)];
      const hits = messages.filter(
        (m) => !m.text.includes(SELF_INVOCATION_MARKER) && !typed.some((t) => m.text.includes(t)) && re.test(m.text),
      );
      if (hits.length === 0) return { error: "anchor-not-found", which };
      const m = which === "from" ? hits[0] : hits[hits.length - 1];
      return { ms: m.ts, anchor: excerpt(m, re) };
    }
    const ms = Date.parse(spec);
    if (!Number.isFinite(ms)) return { error: "bad-timestamp", which, value: spec };
    return { ms };
  };

  const f = resolve(opts.from, "from");
  if (f.error) return f;
  const t = resolve(opts.to, "to");
  if (t.error) return t;
  if (f.ms > t.ms) {
    return { error: "from-after-to", from_ts: new Date(f.ms).toISOString(), to_ts: new Date(t.ms).toISOString() };
  }

  const usage = { input: 0, output: 0, cache_create: 0, cache_read: 0 };
  const models = new Set();
  let apiCalls = 0;
  for (const m of messages) {
    if (m.ts < f.ms || m.ts > t.ms || !m.usage) continue;
    apiCalls++;
    usage.input += m.usage.input_tokens || 0;
    usage.output += m.usage.output_tokens || 0;
    usage.cache_create += m.usage.cache_creation_input_tokens || 0;
    usage.cache_read += m.usage.cache_read_input_tokens || 0;
    if (m.model) models.add(m.model);
  }

  return {
    from_ts: new Date(f.ms).toISOString(),
    to_ts: new Date(t.ms).toISOString(),
    from_anchor: f.anchor ?? null,
    to_anchor: t.anchor ?? null,
    until: Number.isFinite(untilMs) ? new Date(untilMs).toISOString() : null,
    until_source: untilSource,
    minutes: Math.round((t.ms - f.ms) / 60000),
    api_calls: apiCalls,
    usage,
    total: usage.input + usage.output + usage.cache_create + usage.cache_read,
    models: [...models],
    malformed,
    attribution: WINDOW_ATTRIBUTION,
  };
}

export const WINDOW_ATTRIBUTION =
  "main-session window: anything concurrent in it is counted, so this is an upper bound.";

/**
 * The widget reading at or before `ts`, per rule:record-completion-cost: the latest
 * `ok:true` line with a non-zero `cc_cost_week` (a 0 is a --quick sample without ccusage,
 * not a reading). Older than 6h before `ts` is "missing", never silently used.
 *
 * @param {string} samplesPath
 * @param {string|Date} ts
 * @returns {{t:string, week_pct:number|null, cc_cost_week:number}|{missing:string}}
 */
export function readingAt(samplesPath, ts) {
  const at = ts instanceof Date ? ts.getTime() : Date.parse(ts);
  if (!Number.isFinite(at)) return { missing: "no usable timestamp" };
  let raw;
  try {
    raw = readFileSync(samplesPath, "utf8");
  } catch (err) {
    return { missing: err?.code === "ENOENT" ? "no samples file" : `samples file unreadable (${err?.code || err})` };
  }

  let best = null;
  let bestMs = -Infinity;
  let anyOk = false;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row?.ok !== true || !(typeof row.cc_cost_week === "number" && row.cc_cost_week > 0)) continue;
    anyOk = true;
    const ms = Date.parse(row.t);
    if (!Number.isFinite(ms) || ms > at) continue;
    if (ms > bestMs) {
      best = row;
      bestMs = ms;
    }
  }

  if (!anyOk) return { missing: "none ok with non-zero cc_cost_week" };
  if (!best) return { missing: "none at or before the timestamp" };
  if (at - bestMs > READING_MAX_AGE_MS) return { missing: "older than 6h" };
  return { t: best.t, week_pct: best.week_pct ?? null, cc_cost_week: best.cc_cost_week };
}

function delta(a, b) {
  return typeof a === "number" && typeof b === "number" ? Math.round((b - a) * 1e6) / 1e6 : null;
}

function minutesBetween(start, end) {
  const a = Date.parse(start);
  const b = Date.parse(end);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round(((b - a) / 60000) * 10) / 10 : null;
}

function readingFields(startR, endR, field) {
  const s = startR && !startR.missing ? startR[field] : null;
  const e = endR && !endR.missing ? endR[field] : null;
  const out = { start: s ?? null, end: e ?? null, delta: delta(s, e) };
  const missing = [];
  if (startR?.missing) missing.push(`start: ${startR.missing}`);
  if (endR?.missing) missing.push(`end: ${endR.missing}`);
  if (missing.length) out.missing = missing.join("; ");
  return out;
}

/**
 * One ledger row. A transcript that could not be summarised yields `usage:null` with
 * `summary_status` saying why, never zeros.
 *
 * @param {object} payload   SubagentStop stdin (session_id, agent_id, agent_type, ...)
 * @param {object} meta      agent-<id>.meta.json contents ({} if absent)
 * @param {object} summary   summarizeTranscript() result
 * @param {object} startReading readingAt() at the lane's start
 * @param {object} endReading   readingAt() at the lane's end
 * @param {{now?: Date, source?: string}} [opts]
 */
export function buildCostRow(payload, meta, summary, startReading, endReading, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const ok = summary && !summary.unreadable && !summary.empty;
  const start = ok ? summary.start : null;
  const end = ok ? summary.end : null;
  const description = typeof meta?.description === "string" ? meta.description : null;
  const issueMatch = description ? description.match(/#\d+/) : null;

  const row = {
    ts: end || now.toISOString(),
    kind: "lane",
    session_id: payload?.session_id ?? null,
    agent_id: payload?.agent_id ?? null,
    agent_type: payload?.agent_type ?? meta?.agentType ?? null,
    description,
    issue: issueMatch ? issueMatch[0] : null,
    model: ok ? summary.models[0] ?? meta?.model ?? null : meta?.model ?? null,
    models: ok ? summary.models : [],
    start,
    end,
    minutes: start && end ? minutesBetween(start, end) : null,
    usage: ok ? summary.usage : null,
    api_calls: ok ? summary.api_calls : null,
    summary_status: ok ? "ok" : summary?.unreadable ? `unreadable: ${summary.reason}` : "empty: no assistant usage",
    week_pct: readingFields(startReading, endReading, "week_pct"),
    cc_cost_week: readingFields(startReading, endReading, "cc_cost_week"),
    attribution: ATTRIBUTION,
    source: opts.source || "subagent-stop",
  };
  if (!issueMatch) row.issue_source = "none in description";
  if (ok && summary.malformed) row.malformed_transcript_lines = summary.malformed;
  return row;
}

/**
 * propagate#223: Claude Code fires SubagentStop for its own internal agents too; they carry no
 * `agent_type` and have no transcript on disk. They are not lanes, so the hook writes no row.
 * True only for BOTH conditions: a real lane (non-empty agent_type) with a missing transcript
 * keeps its `usage:null` row, and an empty agent_type with a readable transcript is real usage.
 */
export function isInternalAgentWithoutTranscript(payload, meta, summary) {
  const type = payload?.agent_type || meta?.agentType;
  return !(typeof type === "string" && type) && Boolean(summary?.unreadable) && summary.reason === "ENOENT";
}

/**
 * A ledger row the hook wrote BEFORE #223: empty agent_type, source subagent-stop, transcript
 * ENOENT. The file is append-only so these stay on disk; lane readers skip them. Backfill rows
 * with an empty agent_type (widget history) are real and are NOT matched.
 */
export function isLegacyInternalNoiseRow(row) {
  return (
    !row?.agent_type &&
    row?.source === "subagent-stop" &&
    row?.summary_status === "unreadable: ENOENT" &&
    row?.usage == null
  );
}

/**
 * Append ONE already-stamped row, synchronously, with no lock: one small O_APPEND write is
 * atomic on POSIX at this size (same reasoning as runs.mjs appendRunSync). Never edits an
 * existing row. Throws on failure; the hook swallows and logs.
 *
 * @param {{ts:string}} row
 * @returns {string} shard path written
 */
export function appendCostSync(row) {
  if (!row || typeof row.ts !== "string") {
    throw new Error("appendCostSync: row.ts (ISO string) is required");
  }
  const shardPath = shardPathForTs(row.ts);
  mkdirSync(costsDir(), { recursive: true });
  appendFileSync(shardPath, JSON.stringify(row) + "\n");
  return shardPath;
}

/**
 * Read all rows; unparseable lines are COUNTED, never thrown. `filter.lanesOnly` drops legacy
 * internal-agent noise rows (#223) and reports how many as `ignored`, and keeps only the last row
 * per `agent_id` (#233), reporting the rest as `superseded`.
 */
export function readCosts(filter = {}) {
  const dir = costsDir();
  const rows = [];
  let malformed = 0;
  let ignored = 0;
  if (!existsSync(dir)) return { rows, malformed, ignored, superseded: 0 };
  const files = readdirSync(dir).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort();
  for (const file of files) {
    for (const line of readFileSync(path.join(dir, file), "utf8").split("\n")) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        malformed++;
        continue;
      }
      if (filter.since && !(typeof row.ts === "string" && row.ts >= filter.since)) continue;
      if (filter.lanesOnly && isLegacyInternalNoiseRow(row)) {
        ignored++;
        continue;
      }
      rows.push(row);
    }
  }
  if (!filter.lanesOnly) return { rows, malformed, ignored, superseded: 0 };

  // propagate#233 trap 4: a lane resumed with SendMessage writes one row per stop, each
  // CUMULATIVE (#216: 9.17M, 11.47M, 12.92M). Summing double-counts, so keep the last row per
  // agent_id: latest `end`, ties broken by file order. Rows without an agent_id are kept.
  const latest = new Map();
  rows.forEach((row, i) => {
    if (!row.agent_id) return;
    const cur = latest.get(row.agent_id);
    if (!cur || String(row.end ?? "") >= String(rows[cur].end ?? "")) latest.set(row.agent_id, i);
  });
  const kept = rows.filter((row, i) => !row.agent_id || latest.get(row.agent_id) === i);
  return { rows: kept, malformed, ignored, superseded: rows.length - kept.length };
}

/** One line per failure, to $STATE_DIR/costs/errors.log. Never throws. */
export function logCostError(message) {
  try {
    mkdirSync(costsDir(), { recursive: true });
    appendFileSync(
      path.join(costsDir(), "errors.log"),
      `${new Date().toISOString()} ${String(message).replace(/\s+/g, " ").slice(0, 500)}\n`,
    );
  } catch {
    /* nowhere left to report to */
  }
}
