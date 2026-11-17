/**
 * compute.mjs — the glance: every signal read, judged and rendered into a glance.json object (propagate#295).
 *
 * THE INPUT CONTRACT (eng review I1, I2). The glance NEVER runs doctor, reconcile or `gh`. Its callers hand it what they
 * already hold: the monitor its reconcile `rows` and its fresh doctor JSON, CLI `doctor` its in-memory doctor JSON.
 * Everything else is a read of a file another component already wrote. With no rows from the caller, the edges item
 * is CARRIED from the previous glance while that glance is fresh, and is unknown otherwise; it is never recounted
 * here, so the glance's edge figures cannot disagree with the run that produced them.
 * tests/unit/glance.test.mjs T-V10 asserts no file in lib/glance imports reconcile, child_process, config.mjs (which
 * runs discovery at load) or the doctor snapshot module.
 *
 * ONE READER THROWING makes that signal `unknown: <reason>`; the others still run and the file is still written.
 * A signal whose source is not set up on this install (no broadcast index, no work store, no scheduled-jobs section)
 * is SKIPPED with its reason in `skipped`, never shown as unknown forever and never silently dropped.
 */
import { readFileSync, openSync, readSync, fstatSync, closeSync } from "node:fs";
import path from "node:path";

import { stateDir } from "../core/paths.mjs";
import { actionOf, ACTIONS } from "../edges/states.mjs";
import { pruneGuard } from "../guard/log.mjs";
import { readIndex, foldShown } from "../broadcast/index.mjs";
import { openDbReadOnly } from "../work/db.mjs";
import { list as listWork } from "../work/queue.mjs";
import { SIGNALS, signalByName, fillFix, PROMOTE_AFTER_MS } from "./signals.mjs";
import { dailyVerdict, utcDay, DAY_MS } from "./verdict.mjs";
import { formatLine, iconOf, hhmm, clip } from "./render.mjs";
import { SCHEMA_VERSION, STALE_AFTER_S, readGlance, writeGlance } from "./store.mjs";
import { readAcks, ackFor } from "./acks.mjs";

const H = 3600000;
const WINDOW_DAYS = 8; // today plus the 7 prior days the median is taken over
const GUARD_PAIR_MS = 10 * 60000;
const UNATTENDED_MS = 2 * DAY_MS;
const ISO_AT_START = /^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s/;
/** A hook errors.log line that is a trace, not a failure (hooks/subagent-cost.mjs: #223 skips and degraded-but-written rows). */
const TRACE_LINE = / skipped: | row written without it$/;

export function fmtAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  if (ms < H) return `${Math.max(1, Math.round(ms / 60000))}m`;
  if (ms < 2 * DAY_MS) return `${Math.round(ms / H)}h`;
  return `${Math.round(ms / DAY_MS)}d`;
}

const slug = (s) => String(s).toLowerCase().replace(/\d+/g, "n").replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "x";

/** The default file locations, all under the state dir. The CLI passes its env overrides (PROPAGATE_DOCTOR_SNAPSHOT, PROPAGATE_MONITOR_LOG). */
export function defaultPaths(dir) {
  return {
    snapshot: path.join(dir, "doctor-snapshot.json"),
    monitor: path.join(dir, "monitor.log"),
    metrics: path.join(dir, "metrics.jsonl"),
    hookLogs: [path.join(dir, "sessions", "errors.log"), path.join(dir, "costs", "errors.log")],
    guardDir: path.join(dir, "guard"),
  };
}

/** The last `bytes` of a file as lines (the first, possibly partial, line dropped). null when absent. */
function tailLines(file, bytes = 256 * 1024) {
  let fd;
  try {
    fd = openSync(file, "r");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n");
    if (start > 0) lines.shift();
    return lines.filter((l) => l.trim());
  } finally {
    closeSync(fd);
  }
}

function readText(file) {
  try {
    return readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

// ── item construction ────────────────────────────────────────────────────────

/**
 * One item. `since` is carried from the previous glance by id. A propagate-owned broken item older than
 * PROMOTE_AFTER_MS is promoted to needs-you (design §2): propagate has retried it for 6 monitor runs and failed.
 */
function makeItem(ctx, name, { id, verdict, flag = null, subject, what, cause, fixKey, slots = {}, looked_at = 0, ...extra }) {
  const sig = signalByName(name);
  const nowIso = new Date(ctx.now).toISOString();
  const prev = ctx.prevById.get(id);
  const since = prev?.since && !Number.isNaN(Date.parse(prev.since)) ? prev.since : nowIso;
  let v = verdict;
  let key = fixKey ?? (flag === "unknown" ? "unknown" : flag === "learning" ? "learning" : verdict);
  let shown = what;
  if (v === "broken" && flag === null && sig.owner === "propagate" && ctx.now - Date.parse(since) > PROMOTE_AFTER_MS && sig.fix.needs_you) {
    v = "needs_you";
    key = "needs_you";
    shown = `stuck ${fmtAge(ctx.now - Date.parse(since))}: ${what}`;
  }
  const fix = fillFix(name, key, slots);
  return {
    id, signal: name, kind: sig.kind, verdict: v, flag, owner: sig.owner,
    subject, what: shown,
    line: formatLine(iconOf({ verdict: v, flag }), subject, shown, fix.text),
    why: `${shown} because ${cause}; next: ${fix.command ?? fix.text}`,
    fix, since, looked_at, source: sig.source,
    ...extra,
  };
}

function unknownItem(ctx, name, what, cause) {
  return makeItem(ctx, name, { id: name, verdict: "broken", flag: "unknown", subject: name, what, cause });
}

/** Days with data, for an event log: the monitor's run days plus the log's own days; or, with no monitor history, every calendar day from the log's first. */
function eventDataDays(ctx, lineDays) {
  const today = utcDay(ctx.now);
  const from = utcDay(ctx.now - (WINDOW_DAYS - 1) * DAY_MS);
  if (ctx.monitorDays.size) return [...new Set([...ctx.monitorDays, ...lineDays, today])].filter((d) => d >= from);
  if (!lineDays.length) return [today];
  const first = [...lineDays].sort()[0];
  const out = [];
  for (let t = Date.parse(`${first}T00:00:00Z`); utcDay(t) <= today; t += DAY_MS) out.push(utcDay(t));
  return out;
}

/** The shared tail of an event-log signal: 0 events is working; otherwise the daily rule. */
function eventVerdict(ctx, name, { id, subject, counts, events, lineDays, cause, what, slots, extra = {} }) {
  const today = utcDay(ctx.now);
  const failuresToday = counts.get(today) ?? 0;
  if (!events) return makeItem(ctx, name, { id, verdict: "working", subject, what: "no events", cause: "the log is empty or absent, which is 0 events", slots: { n: 0, ...slots }, failures_today: 0, ...extra });
  const v = dailyVerdict({ counts, dataDays: eventDataDays(ctx, lineDays), today });
  if (v.state === "learning") return makeItem(ctx, name, { id, verdict: "working", flag: "learning", subject, what, cause: v.reason, slots: { have: v.have, need: v.need, n: failuresToday, ...slots }, looked_at: events, failures_today: failuresToday, ...extra });
  return makeItem(ctx, name, { id, verdict: v.state === "broken" ? "broken" : "working", subject, what, cause: `${cause}: ${v.reason}`, slots: { n: failuresToday, ...slots }, looked_at: events, failures_today: failuresToday, ...extra });
}

// ── the doctor source, shared by doctor and jobs ────────────────────────────

function doctorSource(ctx) {
  if (ctx.doctor) {
    const at = Date.parse(ctx.doctor.generatedAt ?? "") || ctx.now;
    if (ctx.doctor.error) return { ok: false, reason: `latest failed: ${ctx.doctor.error}`, ageMs: ctx.now - at };
    return { ok: true, payload: ctx.doctor, ageMs: ctx.now - at, source: "in-memory" };
  }
  const text = readText(ctx.paths.snapshot);
  if (text === null) return { ok: false, absent: true, reason: "no snapshot yet" };
  let p;
  try {
    p = JSON.parse(text);
  } catch {
    return { ok: false, reason: "snapshot is not valid JSON" };
  }
  const at = Date.parse(p?.generatedAt ?? "");
  if (p?.error) {
    const good = Date.parse(p.lastGoodAt ?? "");
    return { ok: false, reason: `${Number.isNaN(good) ? "never good" : `last good ${fmtAge(ctx.now - good)} ago`}, latest failed: ${p.error}` };
  }
  if (Number.isNaN(at) || !Array.isArray(p?.sections)) return { ok: false, reason: "snapshot has no generatedAt / sections" };
  return { ok: true, payload: p, ageMs: ctx.now - at, source: "snapshot" };
}

/**
 * What a failing doctor entry says, as a sentence. A ratchet or threshold entry's `label` is the predicate
 * ("instructions.over_ceiling == 0"), which is what the notification title showed (#312); doctor's own `detail`
 * (or `message`) says what is wrong in words, cut to its first clause (before " \u2014 "): the rest is rationale. The label is the fallback only when there is nothing else.
 */
export function doctorWhat(e) {
  for (const k of ["detail", "message"]) {
    const v = typeof e[k] === "string" ? e[k].split(" \u2014 ")[0].trim() : "";
    if (v) return v;
  }
  return String(e.label);
}

// ── the readers, one per signal ─────────────────────────────────────────────

const READERS = {
  readDoctor(ctx) {
    const name = "doctor";
    const src = ctx.doctorSrc;
    if (!src.ok) return { items: [unknownItem(ctx, name, src.absent ? "not computed yet" : "cannot read (latest run failed)", src.reason)] };
    if (src.ageMs > signalByName(name).staleAfterMs) return { items: [unknownItem(ctx, name, `stale, ${fmtAge(src.ageMs)} old`, `the doctor result is older than 26 h`)] };
    const items = [];
    const seen = new Set();
    let pass = 0;
    for (const s of src.payload.sections ?? []) {
      for (const e of s.entries ?? []) {
        if (e.kind === "pass") pass++;
        if (e.kind !== "fail") continue;
        let id = `doctor:${slug(s.name)}:${e.check_id ?? slug(e.label)}`;
        for (let n = 2; seen.has(id); n++) id = `${id.replace(/~\d+$/, "")}~${n}`;
        seen.add(id);
        const human = e.human === true;
        items.push(makeItem(ctx, name, {
          id, verdict: human ? "needs_you" : "broken", subject: "doctor", what: clip(doctorWhat(e), 200),
          cause: human ? `doctor marks it as needing a person (${s.name})` : `doctor's check failed in ${s.name}`,
          looked_at: 1, section: s.name,
        }));
      }
    }
    if (!items.length) {
      if (!pass) return { items: [unknownItem(ctx, name, "no checks in the result", "the doctor result holds no pass or fail")] };
      items.push(makeItem(ctx, name, { id: name, verdict: "working", subject: "doctor", what: `${pass} checks pass`, cause: "no check is red", slots: { time: hhmm(ctx.now - src.ageMs) }, looked_at: pass }));
    }
    return { items };
  },

  readJobs(ctx) {
    const name = "jobs";
    const src = ctx.doctorSrc;
    if (!src.ok) return { skip: "the doctor source is unreadable (shown under doctor)" };
    if (src.ageMs > signalByName(name).staleAfterMs) return { skip: "the doctor source is stale (shown under doctor)" };
    const sec = (src.payload.sections ?? []).find((s) => s.name === "Scheduled jobs");
    if (!sec) return { skip: "doctor printed no scheduled-jobs section" };
    const entries = sec.entries ?? [];
    const info = entries.find((e) => e.kind === "info" && e.label === "scheduled jobs");
    if (info && /^skipped: /.test(info.detail ?? "")) return { skip: `scheduled jobs ${info.detail}` };
    const items = [];
    for (const e of entries) {
      if (e.kind === "warn" && e.label === "no scheduled jobs found") items.push(unknownItem(ctx, name, "looked at no jobs", "the scheduled-jobs section matched nothing"));
      if (e.kind !== "warn" || e.label !== "scheduled job needs attention") continue;
      const detail = String(e.detail ?? "");
      const label = e.check_id?.startsWith("jobs.") ? e.check_id.slice(5) : (/^([^:\s]+):/.exec(detail)?.[1] ?? "unnamed");
      const problem = detail.slice(label.length + 2).replace(/\s*\(.*$/, "") || "needs attention";
      // The subject is the label's last two segments (`diary.collect`): enough to recognise in 80 characters; the id keeps it whole.
      const short = label.split(".").slice(-2).join(".");
      items.push(makeItem(ctx, name, { id: `job:${label}`, verdict: "broken", subject: `job ${short}`, what: problem, cause: "its last run did not succeed", looked_at: 1, job: label }));
    }
    if (!items.length) {
      if (!info) return { items: [unknownItem(ctx, name, "no job summary", "the scheduled-jobs section has no summary line")] };
      items.push(makeItem(ctx, name, { id: name, verdict: "working", subject: "jobs", what: "every job's last run succeeded", cause: "no job warned", slots: { time: hhmm(ctx.now - src.ageMs) }, looked_at: 1 }));
    }
    return { items };
  },

  readMetrics(ctx) {
    const name = "metrics";
    const text = readText(ctx.paths.metrics);
    if (text === null) return { items: [unknownItem(ctx, name, "no doctor history yet", "doctor has not recorded a metrics line")] };
    const from = utcDay(ctx.now - (WINDOW_DAYS - 1) * DAY_MS);
    const byDay = new Map();
    let last = null;
    let n = 0;
    for (const line of text.split("\n")) {
      // Cheap pre-filter on the ts prefix: only the window is parsed (the file holds up to 3000 records).
      const day = /^\{"ts":"(\d{4}-\d\d-\d\d)/.exec(line)?.[1];
      if (!day || day < from) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      const v = r?.metrics?.["doctor.problems"];
      if (typeof v !== "number") continue;
      byDay.set(day, v);
      last = r.ts;
      n++;
    }
    if (!last) return { items: [unknownItem(ctx, name, "no record in 8 days", "metrics.jsonl has no doctor.problems in the window")] };
    const age = ctx.now - Date.parse(last);
    if (age > signalByName(name).staleAfterMs) return { items: [unknownItem(ctx, name, `stale, ${fmtAge(age)} old`, "the last doctor record is older than 26 h")] };
    const today = utcDay(ctx.now);
    const v = dailyVerdict({ counts: byDay, dataDays: [...byDay.keys()], today: byDay.has(today) ? today : [...byDay.keys()].sort().at(-1) }, { chronic: false });
    const latest = [...byDay.entries()].sort().at(-1)[1];
    const what = `${latest} problems, median ${v.median ?? "not set"}`;
    if (v.state === "learning") return { items: [makeItem(ctx, name, { id: name, verdict: "working", flag: "learning", subject: "doctor history", what, cause: v.reason, fixKey: "working", slots: { time: hhmm(Date.parse(last)) }, looked_at: n })] };
    return { items: [makeItem(ctx, name, { id: name, verdict: v.state === "broken" ? "broken" : "working", subject: "doctor history", what, cause: v.reason, slots: { time: hhmm(Date.parse(last)) }, looked_at: n })] };
  },

  readMonitor(ctx) {
    const name = "monitor";
    const lines = tailLines(ctx.paths.monitor);
    if (lines === null) return { items: [unknownItem(ctx, name, "has not run", "monitor.log does not exist")] };
    const from = utcDay(ctx.now - (WINDOW_DAYS - 1) * DAY_MS);
    let last = null;
    let lastLine = "";
    for (const l of lines) {
      const ts = ISO_AT_START.exec(l)?.[1];
      if (!ts) continue;
      const day = ts.slice(0, 10);
      if (day >= from) ctx.monitorDays.add(day);
      last = ts;
      lastLine = l;
    }
    if (!last) return { items: [unknownItem(ctx, name, "no run with a timestamp", "monitor.log holds no parseable line")] };
    const age = ctx.now - Date.parse(last);
    if (age > signalByName(name).staleAfterMs) return { items: [unknownItem(ctx, name, `silent for ${fmtAge(age)}`, "the monitor has not logged a run in 3 x 1800 s")] };
    const err = / error=("(?:[^"\\]|\\.)*")/.exec(lastLine)?.[1];
    if (err) {
      let msg = err;
      try { msg = JSON.parse(err); } catch { /* keep the raw text */ }
      return { items: [makeItem(ctx, name, { id: name, verdict: "broken", subject: "monitor", what: `last run failed: ${msg}`, cause: "the monitor's last run logged an error", looked_at: lines.length })] };
    }
    return { items: [makeItem(ctx, name, { id: name, verdict: "working", subject: "monitor", what: `ran ${fmtAge(age)} ago`, cause: "it logged a run within 3 x 1800 s", slots: { time: hhmm(Date.parse(last)) }, looked_at: lines.length })] };
  },

  readEdges(ctx) {
    const name = "edges";
    if (!Array.isArray(ctx.rows)) {
      const prev = ctx.previous;
      const prevAge = prev ? ctx.now - Date.parse(prev.generatedAt) : Infinity;
      const carried = (prev?.items ?? []).filter((i) => i.signal === name && i.flag !== "unknown");
      if (carried.length && prevAge <= signalByName(name).staleAfterMs) return { items: carried.map((i) => ({ ...i, carried: true })) };
      return { items: [unknownItem(ctx, name, "not computed here", "only the monitor holds reconcile rows, and no fresh glance carries them")] };
    }
    const total = ctx.rows.length;
    if (!total) return { items: [unknownItem(ctx, name, "reconcile returned 0 rows", "a reconcile over a declared tree cannot be empty")] };
    const by = new Map();
    for (const r of ctx.rows) {
      const a = actionOf(r.state, r.blocked === true);
      if (!by.has(a)) by.set(a, []);
      by.get(a).push(r.edge_id);
    }
    const items = [];
    const broken = by.get(ACTIONS.BROKEN) ?? [];
    const unmapped = by.get(ACTIONS.UNKNOWN) ?? [];
    if (broken.length) items.push(makeItem(ctx, name, { id: "edges:broken", verdict: "broken", subject: "edges", what: `${broken.length} broken of ${total} reconciled`, cause: "their files or refs no longer resolve", count: broken.length, subjects: broken.slice(0, 50), looked_at: total }));
    if (unmapped.length) items.push(makeItem(ctx, name, { id: "edges:unknown", verdict: "broken", flag: "unknown", subject: "edges", what: `${unmapped.length} of ${total} in an unmapped state`, cause: "reconcile produced a state actionOf does not know", count: unmapped.length, looked_at: total }));
    const settling = [ACTIONS.JUDGE, ACTIONS.PICK_A_SIDE, ACTIONS.BLOCKED].reduce((a, k) => a + (by.get(k)?.length ?? 0), 0);
    const fine = total - broken.length - unmapped.length;
    if (fine > 0) items.push(makeItem(ctx, name, { id: name, verdict: "working", subject: "edges", what: `${fine} of ${total} reconciled are fine or settling`, cause: "judge, pick-a-side and blocked edges are settled by propagate", slots: { n: settling }, looked_at: total }));
    return { items };
  },

  readHooks(ctx) {
    const name = "hooks";
    const from = utcDay(ctx.now - (WINDOW_DAYS - 1) * DAY_MS);
    const counts = new Map();
    const lineDays = new Set();
    let events = 0;
    for (const f of ctx.paths.hookLogs) {
      const text = readText(f);
      if (text === null) continue;
      for (const l of text.split("\n")) {
        const ts = ISO_AT_START.exec(l)?.[1];
        if (!ts) continue;
        const day = ts.slice(0, 10);
        if (day < from) continue;
        events++;
        lineDays.add(day);
        if (!TRACE_LINE.test(l)) counts.set(day, (counts.get(day) ?? 0) + 1);
      }
    }
    const today = counts.get(utcDay(ctx.now)) ?? 0;
    return { items: [eventVerdict(ctx, name, { id: name, subject: "hooks", counts, events, lineDays: [...lineDays], cause: "error-shaped lines in the hook error logs", what: `${today} errors today` })] };
  },

  readGuard(ctx) {
    const name = "guard";
    const from = utcDay(ctx.now - (WINDOW_DAYS - 1) * DAY_MS);
    const months = [...new Set([utcDay(ctx.now - (WINDOW_DAYS - 1) * DAY_MS).slice(0, 7), utcDay(ctx.now).slice(0, 7)])];
    const rows = [];
    for (const m of months) {
      const text = readText(path.join(ctx.paths.guardDir, `${m}.jsonl`));
      if (text === null) continue;
      for (const l of text.split("\n")) {
        if (!l.trim()) continue;
        try {
          const r = JSON.parse(l);
          if (r && typeof r.ts === "string" && r.ts.slice(0, 10) >= from) rows.push(r);
        } catch { /* an unparseable row is skipped, as every jsonl reader here does */ }
      }
    }
    rows.sort((a, b) => a.ts.localeCompare(b.ts));
    const counts = new Map();
    const lineDays = new Set();
    let deniesToday = 0;
    const today = utcDay(ctx.now);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      lineDays.add(r.ts.slice(0, 10));
      if (r.event !== "deny") continue;
      if (r.ts.slice(0, 10) === today) deniesToday++;
      const t = Date.parse(r.ts);
      const followed = rows.slice(i + 1).some((x) => x.event === "allow-bg" && x.session === r.session && x.command_hash === r.command_hash && Date.parse(x.ts) - t <= GUARD_PAIR_MS);
      if (!followed) counts.set(r.ts.slice(0, 10), (counts.get(r.ts.slice(0, 10)) ?? 0) + 1);
    }
    const notRerun = counts.get(today) ?? 0;
    return { items: [eventVerdict(ctx, name, { id: name, subject: "guard", counts, events: rows.length, lineDays: [...lineDays], cause: "blocked commands not re-run in the background", what: `${deniesToday} blocks today, ${notRerun} not re-run`, slots: { n: deniesToday } })] };
  },

  readBroadcast(ctx) {
    const name = "broadcast";
    let index;
    try {
      index = readIndex(ctx.dir);
    } catch (e) {
      return { items: [unknownItem(ctx, name, `cannot read (${e.code ?? "malformed"})`, `the broadcast index is unreadable: ${e.message}`)] };
    }
    if (!index) return { skip: "no broadcast index (day open writes it)" };
    const age = ctx.now - Date.parse(index.generatedAt);
    if (age > signalByName(name).staleAfterMs) return { items: [unknownItem(ctx, name, `stale, ${fmtAge(age)} old`, "the broadcast index is older than 7 days")] };
    const kids = Object.values(index.parents ?? {}).flatMap((p) => (Array.isArray(p?.children) ? p.children : []).filter((c) => c && c.state !== "closed"));
    const shown = foldShown(ctx.dir);
    let oldest = null;
    for (const v of shown.byChild.values()) if (v.lastTs && (!oldest || v.lastTs < oldest)) oldest = v.lastTs;
    const recorderOld = oldest !== null && ctx.now - Date.parse(oldest) > UNATTENDED_MS;
    const unattended = kids.filter((c) => {
      const s = shown.byChild.get(`${c.repo}#${c.number}`.toLowerCase());
      return s?.lastTs ? ctx.now - Date.parse(s.lastTs) > UNATTENDED_MS : recorderOld;
    });
    if (unattended.length) {
      return { items: [makeItem(ctx, name, { id: "broadcast:unattended", verdict: "needs_you", subject: "broadcast", what: `${unattended.length} of ${kids.length} open children unseen for 2 days`, cause: "no session in their repos has shown them", count: unattended.length, subjects: unattended.slice(0, 50).map((c) => `${c.repo}#${c.number}`), looked_at: kids.length })] };
    }
    return { items: [makeItem(ctx, name, { id: name, verdict: "working", subject: "broadcast", what: `${kids.length} open children`, cause: "every open child was shown within 2 days", slots: { n: kids.length }, looked_at: kids.length })] };
  },

  readWork(ctx) {
    const name = "work";
    const h = openDbReadOnly(ctx.dir);
    if (h.status === "unknown") {
      if (h.reason === "no store" || h.reason === "store not initialised") return { skip: `work queue: ${h.reason}` };
      return { items: [unknownItem(ctx, name, clip(h.reason, 40), `the work queue could not be read: ${h.reason}`)] };
    }
    let all;
    try {
      all = listWork({}, { db: h.db, now: () => ctx.now });
    } finally {
      h.db.close();
    }
    const parked = all.filter((r) => r.effective_state === "parked");
    if (!parked.length) {
      const open = all.filter((r) => r.effective_state === "pending" || r.effective_state === "claimed").length;
      return { items: [makeItem(ctx, name, { id: name, verdict: "working", subject: "work", what: `${open} open items`, cause: "no item is parked", slots: { n: open }, looked_at: all.length })] };
    }
    return {
      items: parked.map((r) => makeItem(ctx, name, {
        id: `work:${r.id}`, verdict: "needs_you", subject: "work", what: `${r.kind} ${r.scope ?? ""} parked after ${r.refusals} refusals`.replace(/\s+/g, " "),
        cause: "it was refused twice, so the queue parked it for a person", looked_at: all.length,
      })),
    };
  },
};

// ── the compute ─────────────────────────────────────────────────────────────

/** The order signals are read in: monitor first, because the event logs take its run days as their data days. */
const READ_ORDER = ["monitor", "doctor", "metrics", "jobs", "edges", "hooks", "guard", "broadcast", "work"];

/**
 * ACKS (propagate#296): a problem item with an ack that holds for its episode carries `ack: {at, until}` (additive
 * field). Its verdict, the glance verdict and needs_you_ids are unchanged: an ack is "I know", not "it is fixed".
 *
 * @param {{dir?: string, now?: number, doctor?: object|null, rows?: object[]|null, previous?: object|null, paths?: object, acks?: Map}} opts
 * @returns {{glance: object}}
 */
export function computeGlance({ dir = stateDir(), now = Date.now(), doctor = null, rows = null, previous = null, paths = {}, acks = null } = {}) {
  const ctx = {
    dir, now, doctor, rows, previous,
    paths: { ...defaultPaths(dir), ...paths },
    prevById: new Map((previous?.items ?? []).map((i) => [i.id, i])),
    monitorDays: new Set(),
  };
  ctx.doctorSrc = (() => {
    try {
      return doctorSource(ctx);
    } catch (e) {
      return { ok: false, reason: `cannot read (${e.code ?? e.message})` };
    }
  })();
  const items = [];
  const skipped = [];
  const readable = new Set();
  for (const name of READ_ORDER) {
    const sig = signalByName(name);
    let r;
    try {
      r = READERS[sig.reader](ctx);
    } catch (e) {
      r = { items: [unknownItem(ctx, name, `cannot read (${e.code ?? "error"})`, `its reader threw: ${String(e.message).slice(0, 120)}`)] };
    }
    if (r.skip) {
      skipped.push({ signal: name, reason: r.skip });
      continue;
    }
    for (const it of r.items) {
      items.push(it);
      if (sig.kind === "heartbeat" && it.flag !== "unknown") readable.add(name);
    }
  }
  let ackMap = acks;
  if (!ackMap) {
    try { ackMap = readAcks(dir); } catch { ackMap = new Map(); }
  }
  for (const it of items) {
    if (it.verdict === "working") continue;
    const a = ackFor(ackMap, it.id, it.since, now);
    if (a) it.ack = a;
    else delete it.ack;
  }
  const blind = readable.size === 0;
  const verdict = blind ? "blind" : items.some((i) => i.verdict === "needs_you") ? "needs_you" : items.some((i) => i.verdict === "broken") ? "broken" : "working";
  return {
    glance: {
      schema_version: SCHEMA_VERSION,
      generatedAt: new Date(now).toISOString(),
      stale_after_s: STALE_AFTER_S,
      verdict,
      signals_checked: SIGNALS.length - skipped.length,
      needs_you_ids: items.filter((i) => i.verdict === "needs_you").map((i) => i.id),
      skipped,
      items,
    },
  };
}

/** 0 working, 1 broken or needs-you, 2 nothing could be read (a blind glance). */
export function exitCodeOf(glance) {
  if (!glance || glance.verdict === "blind") return 2;
  return glance.verdict === "working" ? 0 : 1;
}

/**
 * Read the previous glance, compute, prune the guard log, write. The previous file being corrupt or newer is not an
 * error here: it only loses the carried `since` and edges, and the new file replaces it.
 * @returns {{glance: object, pruned: string[], written: boolean}}
 */
export function runGlance({ dir = stateDir(), now = Date.now(), doctor = null, rows = null, paths = {}, write = true } = {}) {
  let previous = null;
  try {
    previous = readGlance(dir);
  } catch {
    previous = null;
  }
  const { glance } = computeGlance({ dir, now, doctor, rows, previous, paths });
  let pruned = [];
  if (write) {
    // The CLI prunes, never the hook (design §1). Moved here from `day open` (#294 deferred it): every glance caller
    // is a CLI process, and the glance runs on each monitor pass, so the 90-day bound holds without a daily run.
    pruned = pruneGuard(dir, now);
    writeGlance(glance, dir);
  }
  return { glance, pruned, written: write };
}

