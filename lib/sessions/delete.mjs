/**
 * `propagate sessions stop | rm | stop --force` (propagate#272, the act half, delete). Three functions, one per verb,
 * because they have three different safety stories:
 *
 *   stop   background sessions only: `claude stop <id>`.
 *   rm     background sessions only: `claude rm <id>`, refused unless the session is stopped or done.
 *   force  an INTERACTIVE session, which Claude Code can end only by its pid. Sends SIGTERM and nothing stronger.
 *
 * Each takes a session already selected from the live view (selectSession) and is a DRY RUN unless `apply` is true: the
 * dry run returns what would run and touches nothing. With `apply`, an intent event is appended to assoc.jsonl BEFORE
 * the side effect and an outcome event after it, so a crash between them leaves a visible intent with no outcome.
 *
 * force is the dangerous one. A pid is recycled by the OS, and the pid in `claude agents --json` may be seconds old.
 * So immediately before the signal the live list is read again and the SAME pid + sessionId + cwd must still be listed,
 * else `SESSION_PID_CHANGED` and 0 signals were sent. The current session (CLAUDE_CODE_SESSION_ID), and this process
 * and its parent, are never signalled. After the signal the list is re-read for up to 10 s: still listed is
 * `SESSION_STILL_PRESENT`, never a quiet success.
 *
 * Only `lib/sessions/live.mjs` runs `claude`; this file imports `runClaude` from there. Every argv is an array.
 */
import { stateDir } from "../core/paths.mjs";
import { append } from "./assoc.mjs";
import { fail } from "./errors.mjs";
import { readLive as defaultReadLive, runClaude } from "./live.mjs";

export const ACT_TIMEOUT_MS = 30000;
export const FORCE_WAIT_MS = 10000;
const FORCE_POLL_MS = 250;
/** `claude rm` is accepted only for a session in one of these states. */
export const REMOVABLE_STATES = new Set(["stopped", "done"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const label = (s) => `${s.name || "(unnamed)"} (${s.id || s.sessionId.slice(0, 8)})`;
const selector = (s) => (s.id || (s.pid ? `pid:${s.pid}` : s.sessionId.slice(0, 8)));

/** Refuse the session this very process is running in (and its twin row). */
function selfCheck(s, env) {
  if (env.CLAUDE_CODE_SESSION_ID && env.CLAUDE_CODE_SESSION_ID === s.sessionId) {
    return fail("SESSION_SELF", `${label(s)} is the current session (CLAUDE_CODE_SESSION_ID); it will not be stopped from inside itself`, "run this from another terminal", []);
  }
  if (s.pid && (s.pid === process.pid || s.pid === process.ppid)) {
    return fail("SESSION_SELF", `pid ${s.pid} is this command or the shell that ran it`, "run this from another terminal", []);
  }
  return null;
}

function common(o) {
  return {
    stateDirPath: o.stateDirPath ?? stateDir(),
    now: o.now ?? Date.now,
    readLive: o.readLive ?? defaultReadLive,
    env: o.env ?? process.env,
    apply: o.apply === true,
  };
}

/** The intent or outcome line. A failed append before a side effect refuses the side effect. */
async function put(c, event) {
  return append(event, { stateDirPath: c.stateDirPath, now: c.now });
}

const writeFailed = (e, what) => fail("SESSION_ASSOC_WRITE_FAILED", `${what} was not recorded (${e.message}), so nothing was done`, "retry the same command; the action was NOT taken");

/**
 * @param {object} s a session from the view (live.mjs row + folder + association)
 * @param {{apply?: boolean, stateDirPath?: string, now?: () => number, readLive?: Function, env?: object}} [o]
 */
export async function stop(s, o = {}) {
  const c = common(o);
  if (s.kind !== "background" || !s.id) {
    return fail("SESSION_WRONG_KIND", `${label(s)} is an interactive session; claude stop handles background sessions only`, `propagate sessions stop ${selector(s)} --force  (sends SIGTERM to pid ${s.pid ?? "?"})`);
  }
  const self = selfCheck(s, c.env);
  if (self) return self;
  const argv = ["stop", s.id];
  if (!c.apply) return { ok: true, dryRun: true, action: "stop", target: label(s), argv, next: `propagate sessions stop ${s.id} --apply` };

  try {
    await put(c, { event: "stop-requested", rowKey: s.key, argv, id: s.id, sessionId: s.sessionId });
  } catch (e) {
    return writeFailed(e, "the stop request");
  }
  const r = runClaude(argv, { timeout: ACT_TIMEOUT_MS });
  const after = c.readLive({ now: c.now });
  const row = after.ok ? after.rows.find((x) => x.key === s.key) : null;
  const state = !after.ok ? "unknown (could not re-read claude agents)" : row ? row.state : "absent";
  if (!r.ok) {
    const why = r.error ?? `exit ${r.status}${r.stderr.trim() ? `: ${r.stderr.trim().split("\n")[0]}` : ""}`;
    await put(c, { event: "stop-aborted", rowKey: s.key, reason: why, state }).catch(() => {});
    return fail("SESSION_ACT_FAILED", `claude stop failed (${why}); the session is now ${state}`, `claude agents --json  (then retry propagate sessions stop ${s.id} --apply)`, []);
  }
  try {
    await put(c, { event: "stopped", rowKey: s.key, state });
  } catch (e) {
    return fail("SESSION_ASSOC_WRITE_FAILED", `the session was stopped but the outcome was not recorded (${e.message})`, `propagate sessions show ${s.id}`, ["a session was stopped"]);
  }
  return { ok: true, applied: true, action: "stop", target: label(s), state, next: state === "absent" ? "propagate sessions" : `propagate sessions rm ${s.id} --apply` };
}

export async function rm(s, o = {}) {
  const c = common(o);
  if (s.kind !== "background" || !s.id) {
    return fail("SESSION_WRONG_KIND", `${label(s)} is an interactive session; claude rm handles background sessions only, and an interactive one is never removed`, `propagate sessions stop ${selector(s)} --force`);
  }
  const self = selfCheck(s, c.env);
  if (self) return self;
  if (!REMOVABLE_STATES.has(String(s.state).toLowerCase())) {
    return fail("SESSION_NOT_STOPPED", `${label(s)} is ${s.state}; rm is refused unless the session is stopped or done`, `propagate sessions stop ${s.id} --apply`);
  }
  const argv = ["rm", s.id];
  if (!c.apply) return { ok: true, dryRun: true, action: "rm", target: label(s), argv, next: `propagate sessions rm ${s.id} --apply` };

  try {
    await put(c, { event: "rm-requested", rowKey: s.key, argv, id: s.id, sessionId: s.sessionId });
  } catch (e) {
    return writeFailed(e, "the removal request");
  }
  const r = runClaude(argv, { timeout: ACT_TIMEOUT_MS });
  const after = c.readLive({ now: c.now });
  const still = after.ok && after.rows.some((x) => x.key === s.key);
  if (!r.ok || still) {
    const why = !r.ok ? (r.error ?? `exit ${r.status}${r.stderr.trim() ? `: ${r.stderr.trim().split("\n")[0]}` : ""}`) : "it is still listed";
    await put(c, { event: "stop-aborted", rowKey: s.key, reason: `rm: ${why}` }).catch(() => {});
    return fail(still && r.ok ? "SESSION_STILL_PRESENT" : "SESSION_ACT_FAILED", `claude rm ${r.ok ? "returned 0 but" : "failed:"} ${why}`, `claude agents --json  (then retry propagate sessions rm ${s.id} --apply)`, []);
  }
  try {
    await put(c, { event: "removed", rowKey: s.key });
  } catch (e) {
    return fail("SESSION_ASSOC_WRITE_FAILED", `the session was removed but the outcome was not recorded (${e.message})`, "propagate sessions", ["a session was removed"]);
  }
  return { ok: true, applied: true, action: "rm", target: label(s), next: "propagate sessions" };
}

/** The same pid, sessionId and cwd, still an interactive row. */
const sameProcess = (a, b) => b.kind === "interactive" && b.pid === a.pid && b.sessionId === a.sessionId && b.cwd === a.cwd;

/**
 * @param {object} s an interactive session from the view
 * @param {{apply?: boolean, stateDirPath?: string, now?: () => number, readLive?: Function, env?: object, waitMs?: number, pollMs?: number}} [o]
 */
export async function force(s, o = {}) {
  const c = common(o);
  if (s.kind !== "interactive" || !Number.isInteger(s.pid) || s.pid <= 1) {
    return fail("SESSION_WRONG_KIND", `${label(s)} is not an interactive session with a pid; --force signals interactive sessions only`, `propagate sessions stop ${selector(s)}`);
  }
  const self = selfCheck(s, c.env);
  if (self) return self;
  if (!c.apply) return { ok: true, dryRun: true, action: "force", target: label(s), signal: "SIGTERM", pid: s.pid, next: `propagate sessions stop ${selector(s)} --force --apply` };

  try {
    await put(c, { event: "stop-requested", rowKey: s.key, signal: "SIGTERM", pid: s.pid, sessionId: s.sessionId, cwd: s.cwd });
  } catch (e) {
    return writeFailed(e, "the stop request");
  }
  // The re-read sits immediately before the signal: the pid is only as fresh as this read.
  const check = c.readLive({ now: c.now });
  if (!check.ok) {
    await put(c, { event: "stop-aborted", rowKey: s.key, reason: "could not re-read claude agents before the signal" }).catch(() => {});
    return { ...check, side_effects: [] };
  }
  if (!check.rows.some((x) => sameProcess(s, x))) {
    await put(c, { event: "stop-aborted", rowKey: s.key, reason: "pid + sessionId + cwd no longer match", pid: s.pid }).catch(() => {});
    return fail("SESSION_PID_CHANGED", `pid ${s.pid} is no longer ${label(s)} in ${s.cwd}; 0 signals were sent`, "propagate sessions  (read the list again, then retry with the new pid)", []);
  }
  try {
    process.kill(s.pid, "SIGTERM");
  } catch (e) {
    await put(c, { event: "stop-aborted", rowKey: s.key, reason: `kill: ${e.code ?? e.message}` }).catch(() => {});
    return fail("SESSION_ACT_FAILED", `could not signal pid ${s.pid} (${e.code ?? e.message})`, "propagate sessions  (it may already be gone)", []);
  }
  const deadline = Date.now() + (o.waitMs ?? FORCE_WAIT_MS);
  let last = check;
  for (;;) {
    await sleep(o.pollMs ?? FORCE_POLL_MS);
    last = c.readLive({ now: c.now });
    if (last.ok && !last.rows.some((x) => sameProcess(s, x))) break;
    if (Date.now() >= deadline) {
      await put(c, { event: "stop-unconfirmed", rowKey: s.key, pid: s.pid, reason: last.ok ? "still listed after SIGTERM" : "could not re-read after SIGTERM" }).catch(() => {});
      return last.ok
        ? fail("SESSION_STILL_PRESENT", `pid ${s.pid} is still listed ${(o.waitMs ?? FORCE_WAIT_MS) / 1000} s after SIGTERM`, `propagate sessions show pid:${s.pid}  (SIGTERM was sent; it is not escalated)`, ["SIGTERM was sent"])
        : { ...last, side_effects: ["SIGTERM was sent"] };
    }
  }
  try {
    await put(c, { event: "stopped", rowKey: s.key, pid: s.pid, signal: "SIGTERM" });
  } catch (e) {
    return fail("SESSION_ASSOC_WRITE_FAILED", `pid ${s.pid} ended but the outcome was not recorded (${e.message})`, "propagate sessions", ["a session was stopped"]);
  }
  return { ok: true, applied: true, action: "force", target: label(s), signal: "SIGTERM", pid: s.pid, next: "propagate sessions" };
}
