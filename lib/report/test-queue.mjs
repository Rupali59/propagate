/**
 * lib/report/test-queue.mjs — a READ-ONLY view of the machine-wide test queue (propagate#428).
 *
 * The queue is a standalone tool that lives in the hub (scripts/test-queue/test-queue.mjs). propagate never imports
 * it and never takes its locks: it reads the files the tool writes, in `${TEST_QUEUE_DIR:-~/.local/state/test-queue}`.
 * That directory is NOT stateDir(): PROPAGATE_STATE_DIR is scoped per session and test, and a queue that followed it
 * would be private to each caller (the tool's own README says so).
 *
 *   test-runs/<id>.json   one record per run, schema 1 (exit, dirty, head, cpu_busy, suspect, refused, ...)
 *   tickets/<seq>         JSON the tool pads with spaces; `state` is "queued" or "running"
 *   intent                a gate at the head of the queue
 *
 * Nothing here probes a lock, so a ticket whose process died still reads as queued. The text says "(not lock-checked)"
 * for that reason. A file that does not parse is UNREAD (lib/core/unread.mjs), reported next to what did parse, never
 * dropped and never counted as zero. A missing directory is `present: false`: the tool is not used on this machine.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { unread } from "../core/unread.mjs";

export const NOT_USED = "test-queue not used on this machine";

/** The queue directory. TEST_QUEUE_DIR wins; never stateDir(). */
export function queueDir(env = process.env) {
  return env.TEST_QUEUE_DIR || path.join(os.homedir(), ".local", "state", "test-queue");
}

const runsPath = (dir) => path.join(dir, "test-runs");
const ticketsPath = (dir) => path.join(dir, "tickets");
const note = (n, what) => `${n} ${what} file${n === 1 ? "" : "s"} did not parse`;

/** Read a directory: names, `null` when it does not exist, or {error} for anything else (a file where a directory was expected). */
function list(dir) {
  try {
    return { names: readdirSync(dir) };
  } catch (e) {
    return e.code === "ENOENT" ? { names: null } : { error: e.code ?? e.message };
  }
}

/**
 * Run records of the last `days` days. Only schema 1 is understood; any other record counts as unread.
 * @returns {{present:boolean, runs:object[], unreadCount:number, note?:string}|{unread:true, reason:string, runs:object[], unreadCount:number, present:boolean}}
 */
export function readRuns({ days = 30, dir = queueDir(), now = Date.now() } = {}) {
  if (!existsSync(dir)) return { present: false, runs: [], unreadCount: 0, note: NOT_USED };
  const l = list(runsPath(dir));
  if (l.error) return { ...unread(`test-runs is not readable (${l.error})`), present: true, runs: [], unreadCount: 1 };
  const cutoff = now - days * 86400000;
  const runs = [];
  let bad = 0;
  for (const name of (l.names ?? []).filter((n) => n.endsWith(".json"))) {
    let r;
    try {
      r = JSON.parse(readFileSync(path.join(runsPath(dir), name), "utf8"));
    } catch {
      bad++;
      continue;
    }
    if (!r || typeof r !== "object" || r.schema !== 1) {
      bad++;
      continue;
    }
    if (typeof r.started_at === "number" && r.started_at < cutoff) continue;
    runs.push({ ...r, id: r.id ?? name.replace(/\.json$/, ""), file: path.join(runsPath(dir), name) });
  }
  runs.sort((a, b) => (a.started_at ?? 0) - (b.started_at ?? 0));
  const base = { present: true, runs, unreadCount: bad };
  return bad ? { ...unread(`${note(bad, "run record")} (schema 1 only)`), ...base } : base;
}

/**
 * Tickets in seq order, the intent marker and the latest record. No lock is probed.
 * @returns {object}
 */
export function readStatus({ dir = queueDir(), now = Date.now() } = {}) {
  if (!existsSync(dir)) return { present: false, running: [], queued: [], intent: null, last: null, lockChecked: false, unreadCount: 0, note: NOT_USED };
  const l = list(ticketsPath(dir));
  if (l.error) return { ...unread(`tickets is not readable (${l.error})`), present: true, running: [], queued: [], intent: null, last: null, lockChecked: false, unreadCount: 1 };
  const tickets = [];
  let bad = 0;
  for (const name of (l.names ?? []).filter((n) => /^\d+$/.test(n)).sort((a, b) => Number(a) - Number(b))) {
    try {
      const t = JSON.parse(readFileSync(path.join(ticketsPath(dir), name), "utf8"));
      if (!t || typeof t !== "object") throw new Error("not an object");
      tickets.push({ ...t, seq: Number(name) });
    } catch {
      bad++;
    }
  }
  let intent = null;
  try {
    intent = JSON.parse(readFileSync(path.join(dir, "intent"), "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") bad++;
  }
  const runs = readRuns({ days: 30, dir, now });
  const last = runs.runs.filter((r) => !r.refused).at(-1) ?? null;
  const out = {
    present: true,
    running: tickets.filter((t) => t.state === "running"),
    queued: tickets.filter((t) => t.state !== "running"),
    intent,
    last,
    lockChecked: false,
    unreadCount: bad + runs.unreadCount,
  };
  return out.unreadCount ? { ...unread([bad ? note(bad, "ticket or intent") : null, runs.unread ? runs.reason : null].filter(Boolean).join("; ")), ...out } : out;
}

/** Blind-readers registry (#408): a corrupt record or ticket in an otherwise present directory must read as unread. */
export const READER = {
  readRuns: {
    hostile: (h) => {
      const dir = path.join(h.dir, "q-runs");
      mkdirSync(runsPath(dir), { recursive: true });
      writeFileSync(path.join(runsPath(dir), "x.json"), "not json {");
      return [{ dir }];
    },
  },
  checkRunEvidence: {
    hostile: (h) => {
      const dir = path.join(h.dir, "q-evidence");
      mkdirSync(runsPath(dir), { recursive: true });
      writeFileSync(path.join(runsPath(dir), "junk.json"), "not json {");
      return [{ dir, runId: "junk", sha: "a".repeat(40), repoDir: h.dir }];
    },
  },
  readStatus: {
    hostile: (h) => {
      const dir = path.join(h.dir, "q-status");
      mkdirSync(ticketsPath(dir), { recursive: true });
      writeFileSync(path.join(ticketsPath(dir), "7"), "not json {");
      return [{ dir }];
    },
  },
};

// ── rendering ───────────────────────────────────────────────────────────────

const mins = (ms) => `${Math.max(0, Math.round(ms / 60000))}m`;

/** The one `glance` line. Pure over readStatus' result. */
export function glanceLine(s, now = Date.now()) {
  if (!s.present) return `test-queue: not used on this machine`;
  const head = s.unread ? `could not read part of the queue (${s.reason}); ` : "";
  const cpu = s.last?.cpu_busy?.mean;
  const tail = typeof cpu === "number" ? `; last cpu ${Math.round(cpu)}%` : "";
  if (s.running.length) {
    const r = s.running[0];
    const t = Date.parse(r.started_at ?? "");
    const age = Number.isFinite(t) ? ` ${mins(now - t)}` : "";
    return `test-queue: ${head}${r.profile ?? "run"} running${age} (${r.project ?? "?"}); ${s.queued.length} waiting${tail}`;
  }
  if (s.queued.length) return `test-queue: ${head}${s.queued.length} queued or running (not lock-checked)${tail}`;
  return `test-queue: ${head}idle${tail}`;
}

// ── waiting rows ────────────────────────────────────────────────────────────

const when = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

/**
 * Rows for `propagate waiting`: SUSPECT failures (a pass under load is NOT suspect, the maintainer's decision),
 * and runs that were refused (exit 75). Pure over readRuns' result.
 */
export function queueRows(r) {
  const rows = [];
  for (const x of r.runs) {
    const peak = x.cpu_busy?.peak;
    const cpu = typeof peak === "number" ? `, cpu peak ${Math.round(peak)}%` : "";
    if (x.refused) {
      rows.push({
        kind: "test-run",
        what: `refused run: ${x.project ?? "?"} ${x.profile ?? "?"} gave up waiting for a quiet machine (exit ${x.exit}) at ${when(x.started_at)}`,
        url: x.file,
        recommendation: "nothing ran: re-run when the machine is quiet (`test-queue load`), or defer it",
        answer: "defer",
      });
    } else if (x.suspect) {
      rows.push({
        kind: "test-run",
        what: `suspect failure: ${x.project ?? "?"} ${x.profile ?? "?"} exit ${x.exit} at ${when(x.started_at)}${cpu}`,
        url: x.file,
        recommendation: `it failed while the machine was busy, so the failure may not be the code: re-run it quietly (\`test-queue run --profile ${x.profile ?? "gate"} -- <command>\`) before acting on it`,
        answer: "lane",
      });
    }
  }
  return rows;
}

/**
 * Rows for gate passes recorded WITHOUT run evidence (`--no-run-evidence`), from the last `days` days.
 * @returns {{rows: object[], errors: string[]}}
 */
export function noEvidenceRows(stateDirPath, { days = 7, now = Date.now() } = {}) {
  const gates = path.join(stateDirPath, "gates");
  const l = list(gates);
  if (l.error) return { rows: [], errors: [`gates is not readable (${l.error})`] };
  const rows = [];
  const errors = [];
  for (const name of (l.names ?? []).filter((n) => n.endsWith(".json"))) {
    let g;
    try {
      g = JSON.parse(readFileSync(path.join(gates, name), "utf8"));
    } catch (e) {
      errors.push(`gates/${name} is not readable (${e.message})`);
      continue;
    }
    if (typeof g?.no_run_evidence !== "string" || !g.no_run_evidence) continue;
    const at = Date.parse(g.passed_at ?? "");
    if (Number.isFinite(at) && at < now - days * 86400000) continue;
    rows.push({
      kind: "gate-pass",
      what: `gate pass on ${String(g.sha).slice(0, 7)} recorded with no run evidence: "${g.no_run_evidence}"`,
      url: path.join(gates, name),
      recommendation: "no test-queue run backs this pass: accept the stated reason, or re-gate through the queue and record it with --run",
      answer: "approve",
    });
  }
  return { rows, errors };
}

// ── the gate-pass evidence check ────────────────────────────────────────────

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** `git merge-base --is-ancestor`: true, false, or {error}. Exit 1 is "not an ancestor"; any other failure is not an answer. */
function isAncestor(repoDir, sha, head) {
  const r = spawnSync("git", ["-C", repoDir, "merge-base", "--is-ancestor", sha, head], { encoding: "utf8", timeout: 15000 });
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  return { error: (r.stderr || r.error?.message || `git exited ${r.status}`).trim() };
}

/**
 * Does run `runId` back a gate pass on PR head `sha`? All four must hold: exit 0, a clean tree, `sha` an ancestor of
 * the run's head (checked in `repoDir`, the PR's repo), and the run not refused. A pass under load is accepted: only a
 * FAILURE under load is suspect (the maintainer's decision, 2026-11-27). Every unmet condition is listed, not the first.
 * @returns {{ok: boolean, reasons: string[], run: object|null}}
 */
export function checkRunEvidence({ dir = queueDir(), runId, sha, repoDir = process.cwd() }) {
  if (!RUN_ID.test(String(runId ?? ""))) return { ok: false, run: null, reasons: [`run id "${runId}" is not a run id (the file name under test-runs/, without .json)`] };
  const file = path.join(runsPath(dir), `${runId}.json`);
  let run;
  try {
    run = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return { ok: false, run: null, reasons: [`no run record ${file}`] };
    const why = `run record ${file} is not readable (${e.message})`;
    return { ok: false, run: null, reasons: [why], ...unread(why) };
  }
  if (!run || typeof run !== "object" || run.schema !== 1) {
    const why = `run record ${file} is not schema 1`;
    return { ok: false, run: null, reasons: [why], ...unread(why) };
  }
  const reasons = [];
  if (run.refused === true) reasons.push("the run was refused (it never ran the command)");
  if (run.exit !== 0) reasons.push(`the run did not pass (exit ${run.exit}${run.signal ? `, signal ${run.signal}` : ""})`);
  if (run.dirty !== false) reasons.push(run.dirty === true ? "the run's working tree was dirty, so it did not test a commit" : "the run does not say whether its tree was clean");
  if (typeof run.head !== "string" || !FULL_SHA.test(run.head)) reasons.push("the run records no head commit");
  else {
    const a = isAncestor(repoDir, sha, run.head);
    if (a === false) reasons.push(`the PR head ${sha.slice(0, 7)} is not an ancestor of the run's head ${run.head.slice(0, 7)} (checked in ${repoDir}), so the run did not test it`);
    else if (a !== true) reasons.push(`could not check ancestry in ${repoDir} (${a.error})`);
  }
  return { ok: reasons.length === 0, reasons, run };
}
