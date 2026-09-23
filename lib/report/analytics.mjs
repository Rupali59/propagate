/**
 * analytics.mjs — charts from data that already exists.
 *
 * NOTHING HERE IS COLLECTED FOR THIS PURPOSE. Two files on disk already carry
 * 33 days of history, written as a side effect of running `doctor` and
 * `verify`:
 *
 *   ~/.propagate/metrics.jsonl    one row per run: {ts, run_id, metrics{}}
 *   ~/.propagate/events/*.jsonl   one row per judgement
 *
 * Derive on demand; remember nothing. `rule:delegation-criteria` §2 is this
 * repo's most expensive lesson — a 60-second watcher ran 4,420 times and found
 * nothing in 4,384 of them, and was replaced by a command that derives the same
 * answer in 1.2 s and cannot miss a change it was not watching for.
 *
 * ── TWO HONESTY RULES, BOTH ASSERTED ──────────────────────────────────────
 *
 * 1. A SERIES STATES ITS COVERAGE. `observed_at_commit` is present on 53% of
 *    events; a chart drawn over it that does not say so is claiming a
 *    completeness it does not have.
 *
 * 2. A GAP IN THE DATA RENDERS AS A GAP. Interpolating a line across days when
 *    nothing ran asserts a measurement nobody took. `points` therefore carries
 *    explicit nulls, and the client breaks the path on them rather than
 *    joining across.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { STATE_DIR } from "../core/config.mjs";
import { sideOf, HUB } from "./surface.mjs";

const DAY = 86400000;
const dayOf = (ts) => String(ts).slice(0, 10);

/** Parse a .jsonl leniently, counting what it could not read. */
function parseJsonl(text) {
  const rows = [];
  let malformed = 0;
  for (const line of String(text).split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { rows.push(JSON.parse(t)); } catch { malformed += 1; }
  }
  return { rows, malformed };
}

export async function readMetrics(dir = STATE_DIR) {
  try {
    return parseJsonl(await readFile(path.join(dir, "metrics.jsonl"), "utf8"));
  } catch (err) {
    // "no metrics file" and "a metrics file that failed to read" are different
    // facts, and only the first means the feature has never been used.
    return { rows: [], malformed: 0, error: err.code === "ENOENT" ? null : String(err.message), absent: err.code === "ENOENT" };
  }
}

/**
 * Daily series from the metric rows: the LAST value seen each day.
 *
 * Last, not mean: these are gauges — "how many rows are open right now" — and
 * averaging a gauge across a day invents a value that was never true.
 */
export function dailySeries(rows, key) {
  const byDay = new Map();
  let seen = 0;
  for (const r of rows) {
    const v = r?.metrics?.[key];
    if (typeof v !== "number") continue;
    seen += 1;
    byDay.set(dayOf(r.ts), v);   // later rows overwrite earlier ones
  }
  if (!byDay.size) return { points: [], coverage: { rows: seen, of: rows.length }, empty: true };

  const days = [...byDay.keys()].sort();
  const first = Date.parse(days[0]);
  const last = Date.parse(days[days.length - 1]);
  const points = [];
  for (let t = first; t <= last; t += DAY) {
    const d = new Date(t).toISOString().slice(0, 10);
    // NULL, not the previous value. A day with no run is a day nobody measured,
    // and carrying the last reading forward would draw a flat line asserting
    // stability that was never observed.
    points.push({ day: d, value: byDay.has(d) ? byDay.get(d) : null });
  }
  return {
    points,
    coverage: { rows: seen, of: rows.length, days: byDay.size, span: points.length },
    empty: false,
  };
}

/** `<workspace>:<relpath>` -> an absolute path, so the ONE hub rule can read it. */
export function pathOfNode(nodeId, root) {
  const s = String(nodeId ?? "");
  const i = s.indexOf(":");
  if (i < 0) return null;
  const ws = s.slice(0, i);
  const rel = s.slice(i + 1);
  const base = root.endsWith("/") ? root : root + "/";
  // "GitHub" is the hub itself: its rows are already root-relative.
  return ws === "GitHub" ? base + rel : base + ws + "/" + rel;
}

/**
 * Judgements split by which side of the hub/workspace line they touched.
 *
 * Reuses `sideOf` rather than re-deriving the rule. That rule lived twice once
 * — server and browser — and two readers of one fact with nothing comparing
 * them is the N86 shape.
 */
export function boundaryCounts(events, root) {
  const out = { hub: 0, workspace: 0, unattributable: 0, byWorkspace: {} };
  for (const e of events) {
    const abs = pathOfNode(e.node_id, root);
    const side = abs ? sideOf(abs, root) : null;
    if (!side) { out.unattributable += 1; continue; }
    if (side === HUB) out.hub += 1;
    else { out.workspace += 1; out.byWorkspace[side] = (out.byWorkspace[side] ?? 0) + 1; }
  }
  return out;
}

/** Disposition mix per ISO week — is the 47% no-op share falling? */
export function dispositionByWeek(events) {
  const weeks = new Map();
  const kinds = new Set();
  for (const e of events) {
    const t = Date.parse(e.ts);
    if (!Number.isFinite(t)) continue;
    const d = new Date(t);
    // Monday of that week, as a stable bucket key.
    const monday = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY).toISOString().slice(0, 10);
    const k = String(e.disposition ?? "unknown");
    kinds.add(k);
    if (!weeks.has(monday)) weeks.set(monday, {});
    const w = weeks.get(monday);
    w[k] = (w[k] ?? 0) + 1;
  }
  const order = [...kinds].sort();
  return {
    kinds: order,
    weeks: [...weeks.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([week, counts]) => ({
        week,
        total: order.reduce((n, k) => n + (counts[k] ?? 0), 0),
        counts: Object.fromEntries(order.map((k) => [k, counts[k] ?? 0])),
      })),
  };
}

/** Field coverage across the event store, so a chart can state its own limits. */
export function fieldCoverage(events, field) {
  const have = events.filter((e) => e?.[field] !== undefined && e[field] !== null).length;
  return { have, of: events.length, pct: events.length ? have / events.length : null };
}

/**
 * The payload. Each chart carries its own error, so one unreadable source does
 * not blank the division.
 */
export async function analyticsPayload(opts = {}) {
  const root = opts.root ?? "";
  const deps = opts.deps ?? (await defaultDeps());

  const charts = {};
  const guard = async (key, fn) => {
    try { charts[key] = { ...(await fn()), error: null }; }
    catch (err) { charts[key] = { error: String(err?.message ?? err), points: null }; }
  };

  const m = await deps.readMetrics();
  const metricChart = (key, title, subject) => guard(key, async () => {
    if (m.absent) return { title, subject, absent: true, points: [], note: "no metrics file yet — this fills as doctor runs" };
    if (m.error) throw new Error(m.error);
    const s = dailySeries(m.rows, subject);
    return { title, subject, ...s, malformed: m.malformed };
  });

  await metricChart("backlog", "Open rows", "rows.open");
  await metricChart("problems", "Doctor problems", "doctor.problems");
  await metricChart("duration", "Doctor duration (ms)", "doctor.duration_ms");

  await guard("scale", async () => {
    if (m.absent) return { title: "One hub, many projects", absent: true, series: [] };
    const ws = dailySeries(m.rows, "workspaces.discovered");
    const sc = dailySeries(m.rows, "sidecars.loaded");
    return {
      title: "One hub, many projects",
      series: [
        { name: "workspaces discovered", ...ws },
        { name: "sidecars loaded", ...sc },
      ],
    };
  });

  let events = [];
  let eventsError = null;
  try { ({ events } = await deps.readEvents({})); } catch (err) { eventsError = String(err?.message ?? err); }

  await guard("boundary", async () => {
    if (eventsError) throw new Error(eventsError);
    const b = boundaryCounts(events, root);
    return {
      title: "Hub or workspace",
      ...b,
      total: events.length,
      // Stated, not hidden: a row whose node_id has no workspace prefix cannot
      // be placed on either side of the line.
      note: b.unattributable ? `${b.unattributable} judgement(s) could not be attributed to a side` : null,
    };
  });

  await guard("dispositions", async () => {
    if (eventsError) throw new Error(eventsError);
    return { title: "What the answer was", ...dispositionByWeek(events), total: events.length };
  });

  return {
    charts,
    coverage: {
      events: events.length,
      metricRows: m.rows?.length ?? 0,
      // THE 53%. Any chart that leans on commit data has to say this.
      observedAtCommit: eventsError ? null : fieldCoverage(events, "observed_at_commit"),
      reason: fieldCoverage(events, "reason"),
    },
    eventsError,
    generatedAt: new Date().toISOString(),
  };
}

export async function defaultDeps() {
  const { readEvents } = await import("../edges/events.mjs");
  return { readEvents, readMetrics: () => readMetrics() };
}
