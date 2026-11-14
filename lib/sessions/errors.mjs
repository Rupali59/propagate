/**
 * The session error contract (propagate#272, DX10). Every failure is `<CODE>: <what>. Next: <command>` on stderr with a
 * distinct non-zero exit: 2 = could not read, or a usage error; 1 = refused. `--json` prints
 * `{ok:false, code, what, next, side_effects}`. The table below is the one list of codes; docs/REFERENCE.md §sessions
 * restates it for readers and a test asserts the two agree.
 */

/** The codes the act half (create, stop, rm, force) adds. Its tests live in sessions-act.test.mjs and check this list. */
export const ACT_CODES = Object.freeze({
  SESSION_ITEM_LIVE: 1,
  SESSION_LOCKED: 1,
  SESSION_FOLDER_UNKNOWN: 1,
  SESSION_LAUNCH_FAILED: 1,
  SESSION_LAUNCH_TIMEOUT: 1,
  SESSION_FOLDER_UNTRUSTED: 1,
  SESSION_ID_UNKNOWN: 1,
  SESSION_WRONG_KIND: 1,
  SESSION_NOT_STOPPED: 1,
  SESSION_SELF: 1,
  SESSION_PID_CHANGED: 1,
  SESSION_STILL_PRESENT: 1,
  SESSION_ACT_FAILED: 1,
});

/** code -> exit. */
export const CODES = Object.freeze({
  ...ACT_CODES,
  SESSION_READER_FAILED: 2,
  SESSION_SHAPE_UNKNOWN: 2,
  SESSION_USAGE: 2,
  SESSION_ASSOC_UNREADABLE: 2,
  SESSION_NOT_FOUND: 1,
  SESSION_AMBIGUOUS: 1,
  SESSION_GOAL_UNKNOWN: 1,
  SESSION_ASSOC_WRITE_FAILED: 1,
});

/**
 * A typed failure. `next` must be a command or an instruction, never empty: a refusal that names no next step is the
 * thing this contract exists to end.
 * @returns {{ok:false, code:string, what:string, next:string, side_effects:string[]}}
 */
export function fail(code, what, next, side_effects = []) {
  if (!Object.hasOwn(CODES, code)) throw new Error(`unknown session error code ${code}`);
  if (!next) throw new Error(`session error ${code} has no next step`);
  return { ok: false, code, what, next, side_effects };
}

/** The exit code of a typed failure. */
export function exitOf(f) {
  return CODES[f.code] ?? 2;
}

/** The one stderr line. */
export function renderFailure(f) {
  return `${f.code}: ${f.what}. Next: ${f.next}`;
}
