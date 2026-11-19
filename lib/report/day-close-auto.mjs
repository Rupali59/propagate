/**
 * lib/report/day-close-auto.mjs — the day-close catch-up (propagate#339).
 *
 * `day close` ran only when someone typed it. The first SessionStart of each day now starts `day close --apply`
 * DETACHED if the last close has not run today, and every later session's guide shows what that run did.
 *
 * NODE BUILTINS AND paths.mjs ONLY. hooks/session-guide.mjs imports this, and a hook that imports config.mjs pays
 * workspace discovery at load (measured +0.2 s on a 0.08 s process, see that hook's header).
 *
 * FILES, all under `$STATE/day/`:
 *   last-close.json    the record of the last `day close` run (every run, `--apply` or not)
 *   close-<date>.txt   that run's output (a dry run writes close-<date>.dry.txt, so it never overwrites an apply)
 *   close.lock         `{pid, ts}`; exists while a catch-up run is alive. `wx` create is the mutual exclusion.
 *
 * NOTHING HERE TALKS TO GITHUB. The hook path (decide, lock, spawn, read the line) makes no network call and no write
 * to any board: the detached child does, and it is the existing `day close --apply`, which writes only promotions and
 * closed -> Done.
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** A transient failure is retried by the next session, but not within this long of the last attempt. */
export const RETRY_COOLDOWN_MS = 10 * 60 * 1000;
/** A lock older than this is a crashed run, not a live one (a real run takes minutes). */
export const LOCK_MAX_AGE_MS = 2 * 3600 * 1000;
/** `day close` waits this long before retrying a transient refusal, once. */
export const RETRY_DELAY_MS = 60 * 1000;

const dayDir = (dir) => path.join(dir, "day");
export const lastClosePath = (dir) => path.join(dayDir(dir), "last-close.json");
export const lockPath = (dir) => path.join(dayDir(dir), "close.lock");
export const closeTextPath = (dir, date, apply = true) => path.join(dayDir(dir), `close-${date}${apply ? "" : ".dry"}.txt`);

const pad = (n) => String(n).padStart(2, "0");
/** Local calendar date, as `day close` uses for "today". */
export const ymd = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

// ── failure classes ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What kind of refusal a failure text is. Three transient classes, each retried once and then recorded for the next
 * session: a burst or hourly rate limit, a 5xx from GitHub, and a timeout or reset on the wire.
 * @returns {{kind: "rate-limited"|"unavailable", label: string}|null} null for anything else (a real failure)
 */
export function classifyFailure(text) {
  const s = String(text ?? "");
  // NOT bare /rate limit/: "could not read the GitHub rate limit: <cause>" names the call that failed, not a refusal.
  if (/(secondary|api) rate limit|rate limit exceeded|exceeded[^.;]*rate limit|abuse detection|HTTP 429|GraphQL remaining \d+ is below|cannot cover about \d+ request/i.test(s)) return { kind: "rate-limited", label: "rate-limited" };
  const http = /HTTP (5\d\d)/.exec(s);
  if (http) return { kind: "unavailable", label: `github unavailable (HTTP ${http[1]})` };
  const net = /\b(ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ESOCKETTIMEDOUT)\b/.exec(s);
  if (net) return { kind: "unavailable", label: `github unavailable (${net[1]})` };
  return null;
}

// ── the record and the guide line ───────────────────────────────────────────────────────────────────────────────

/**
 * The record `day close` leaves for the next session. Pure. `r` is buildDayClose's result; `prev` the previous record.
 * `caughtUpDate` is the date of the last run that APPLIED and finished clean: a dry run or a failure never moves it, so
 * a hand-run dry run cannot make the catch-up believe the day was closed.
 */
export function lastCloseRecord(r, { apply, now, prev = null }) {
  const date = ymd(now);
  const transient = r.failure ?? classifyFailure(r.reason);
  let status = "ok";
  if (r.partial) status = "partial";
  else if (r.exit !== 0) status = transient ? transient.kind : "failed";
  const rec = {
    date,
    mode: apply ? "apply" : "dry-run",
    promoted: r.promote?.length ?? 0,
    closedToDone: r.closeFix?.length ?? 0,
    inProgress: r.inProgress?.length ?? 0,
    exit: r.exit,
    status,
    finishedAt: new Date(now).toISOString(),
    reason: String(r.reason ?? "").slice(0, 300),
  };
  if (r.partial) rec.partial = r.partial;
  if (transient) rec.failureLabel = transient.label;
  if (apply && status === "ok") rec.caughtUpDate = date;
  else if (prev?.caughtUpDate) rec.caughtUpDate = prev.caughtUpDate;
  return rec;
}

const statusOf = (rec) => rec.status ?? (rec.exit === 0 ? "ok" : "failed");
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The one line a session's guide shows. At most 160 characters. Never empty: a record it cannot read says so. */
export function guideLine(rec) {
  if (!rec || typeof rec !== "object" || typeof rec.date !== "string") return "day close: last-close.json unreadable; run propagate day close";
  const head = `day close ${rec.date}`;
  const file = `close-${rec.date}${rec.mode === "dry-run" ? ".dry" : ""}.txt`;
  const st = statusOf(rec);
  const label = rec.failureLabel ?? (st === "rate-limited" ? "rate-limited" : "github unavailable");
  let line;
  if (st === "ok") {
    line = `${head}${rec.mode === "dry-run" ? " (dry run, nothing written)" : ""}: ${rec.promoted ?? 0} promoted, ${rec.closedToDone ?? 0} closed → Done, ${rec.inProgress ?? 0} In progress to look at (${file})`;
  } else if (st === "partial") {
    line = `${head}: partial: ${rec.partial?.written ?? "?"} of ${rec.partial?.total ?? "?"} written, the rest next session (${file})`;
  } else if (st === "rate-limited" || st === "unavailable") {
    line = `${head}: ${label}, will retry next session (${file})`;
  } else {
    line = `${head}: failed (exit ${rec.exit ?? "?"}): ${String(rec.reason ?? "").replace(/\s+/g, " ")} (${file})`;
  }
  return clip(line, 160);
}

/** null when absent; THROWS when unreadable. */
export function readLastClose(dir) {
  let text;
  try {
    text = readFileSync(lastClosePath(dir), "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
  const rec = JSON.parse(text);
  if (!rec || typeof rec !== "object" || typeof rec.date !== "string") throw new Error("last-close.json has no date");
  return rec;
}

/** Atomic (temp, then rename). */
export function writeLastClose(dir, rec) {
  const target = lastClosePath(dir);
  const tmp = `${target}.${process.pid}.tmp`;
  mkdirSync(path.dirname(target), { recursive: true });
  try {
    writeFileSync(tmp, JSON.stringify(rec, null, 2));
    renameSync(tmp, target);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return target;
}

// ── the off switch and the decision ─────────────────────────────────────────────────────────────────────────────

const OFF = /^(0|false|off|no)$/i;

/**
 * Off with `PROPAGATE_DAY_CLOSE_AUTO=0` or `dayCloseAuto: false` in `$STATE/config.yml`. The env var wins when set
 * (so `=1` turns a config-off back on for one session). Read by regex, never by config.mjs (see the file header).
 */
export function autoEnabled({ env, configText }) {
  const e = env?.PROPAGATE_DAY_CLOSE_AUTO;
  if (e !== undefined && String(e).trim() !== "") {
    return OFF.test(String(e).trim()) ? { on: false, why: "PROPAGATE_DAY_CLOSE_AUTO=0" } : { on: true, why: "PROPAGATE_DAY_CLOSE_AUTO set" };
  }
  const m = /^dayCloseAuto:\s*["']?([^"'#\s]+)["']?\s*(#.*)?$/m.exec(String(configText ?? ""));
  if (m && OFF.test(m[1])) return { on: false, why: "config.yml dayCloseAuto is off" };
  return { on: true, why: "default" };
}

/**
 * Does this session start a catch-up? Pure (reads only last-close.json and the clock).
 * @returns {{action: "start"|"skip"|"off", why: string, rec: object|null}}
 */
export function catchUpDecision({ dir, now, env, configText }) {
  const sw = autoEnabled({ env, configText });
  if (!sw.on) return { action: "off", why: sw.why, rec: null };
  let rec;
  try {
    rec = readLastClose(dir);
  } catch (e) {
    // An unreadable record must not leave the boards ungroomed forever: run, and the run rewrites it.
    return { action: "start", why: `last-close.json unreadable (${e.message})`, rec: null };
  }
  if (!rec) return { action: "start", why: "no close has ever run", rec };
  const today = ymd(now);
  const caughtUp = rec.caughtUpDate ?? (rec.mode === "apply" && statusOf(rec) === "ok" ? rec.date : null);
  if (caughtUp === today) return { action: "skip", why: "day close already ran today", rec };
  if (rec.mode === "apply" && rec.date === today) {
    const st = statusOf(rec);
    if (st === "failed") return { action: "skip", why: "today's run failed; it is retried tomorrow", rec };
    const age = now - Date.parse(rec.finishedAt ?? "");
    if (Number.isFinite(age) && age < RETRY_COOLDOWN_MS) return { action: "skip", why: "retried too recently", rec };
  }
  return { action: "start", why: caughtUp ? `last caught up ${caughtUp}` : "never caught up", rec };
}

// ── the lock ────────────────────────────────────────────────────────────────────────────────────────────────────

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};

/** Atomic `wx` create. A lock whose holder is dead, or older than LOCK_MAX_AGE_MS, is removed and taken. */
export function acquireLock(dir, { now, pid }) {
  const f = lockPath(dir);
  mkdirSync(path.dirname(f), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(f, "wx");
      writeFileSync(fd, JSON.stringify({ pid, ts: now }));
      closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;    }
    let held = null;
    try {
      held = JSON.parse(readFileSync(f, "utf8"));
    } catch {
      // unreadable: another session may be mid-write; treat as held unless it is also old (below)
    }
    const stale = held ? !alive(held.pid) || now - held.ts > LOCK_MAX_AGE_MS : false;
    if (!stale) return false;
    rmSync(f, { force: true });
  }
  return false;
}

/** Overwrite the lock with the real holder's pid (the hook creates it, the detached child owns it). */
export function setLockPid(dir, pid, now) {
  writeFileSync(lockPath(dir), JSON.stringify({ pid, ts: now }));
}

/** Remove the lock only if `pid` holds it. */
export function releaseLock(dir, pid) {
  try {
    const held = JSON.parse(readFileSync(lockPath(dir), "utf8"));
    if (held.pid === pid) rmSync(lockPath(dir), { force: true });
  } catch {
    // no lock, or unreadable: nothing of ours to release
  }
}

// ── starting the run ────────────────────────────────────────────────────────────────────────────────────────────

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "cli.mjs");

/**
 * Take the lock and start `day close --apply` detached. Returns at once and never waits for the child.
 * `PROPAGATE_DAY_CLOSE_CMD` replaces the script the child runs (tests; it receives `day close --apply`). Inside the
 * node test runner with no override it REFUSES to spawn (the stub-or-refuse rule of lib/sessions/live.mjs runClaude,
 * gotcha G91): a suite must never start a real board run.
 * @returns {{started: boolean, why: string, pid?: number}}
 */
export function startCatchUp(dir, { now, env }) {
  const script = env.PROPAGATE_DAY_CLOSE_CMD || null;
  if (!script && env.NODE_TEST_CONTEXT) return { started: false, why: "refused: running under the test runner with no PROPAGATE_DAY_CLOSE_CMD stub" };
  const target = script || CLI;
  if (!existsSync(target)) return { started: false, why: `day close script not found: ${target}` };
  if (!acquireLock(dir, { now, pid: process.pid })) return { started: false, why: "another session is already running day close" };
  try {
    const child = spawn(process.execPath, [target, "day", "close", "--apply"], { detached: true, stdio: "ignore", env: { ...env, PROPAGATE_DAY_CLOSE_AUTO_CHILD: "1" } });
    child.on("error", () => {});
    child.unref();
    setLockPid(dir, child.pid, now);
    return { started: true, why: "started", pid: child.pid };
  } catch (e) {
    rmSync(lockPath(dir), { force: true });
    return { started: false, why: `could not start: ${e.message}` };
  }
}
