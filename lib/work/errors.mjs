/**
 * The work-queue error contract (propagate#150). Every failure is `<CODE>: <what>. Next: <command>`, the same shape as
 * lib/sessions/errors.mjs, with one difference: `fail` THROWS a WorkError instead of returning a value, because the
 * queue's callers run inside transactions that must roll back. The CLI maps a WorkError to its `exit` and to
 * `{ok:false, code, what, next}`. Exit 2 = could not run; 1 = refused.
 */

/** code -> exit. */
export const CODES = Object.freeze({
  WORK_USAGE: 2,
  WORK_STORE_UNREADABLE: 2,
  WORK_STORE_UNSAFE: 2,
  WORK_STORE_TOO_NEW: 2,
  WORK_NODE_TOO_OLD: 2,
  WORK_SYNC_TRUNCATED: 2,
  WORK_NOT_FOUND: 1,
  WORK_NOT_CLAIMANT: 1,
  WORK_LEASE_EXPIRED: 1,
  WORK_ITEM_EXPIRED: 1,
  WORK_GITHUB_FAILED: 2,
  WORK_HUB_UNKNOWN: 2,
});

/** A typed failure. */
export class WorkError extends Error {
  /**
   * @param {string} code
   * @param {string} what
   * @param {string} next
   */
  constructor(code, what, next) {
    super(`${code}: ${what}. Next: ${next}`);
    this.name = "WorkError";
    this.code = code;
    this.what = what;
    this.next = next;
    this.exit = CODES[code];
  }

  /** The `--json` shape. */
  toJSON() {
    return { ok: false, code: this.code, what: this.what, next: this.next };
  }
}

/**
 * Throw a typed failure. `next` must be a command or an instruction, never empty: a refusal that names no next step is
 * the thing this contract exists to end. An unknown code or an empty `next` is a programming error, so it throws a
 * plain Error, never a WorkError.
 * @returns {never}
 */
export function fail(code, what, next) {
  if (!Object.hasOwn(CODES, code)) throw new Error(`unknown work error code ${code}`);
  if (!next) throw new Error(`work error ${code} has no next step`);
  throw new WorkError(code, what, next);
}
