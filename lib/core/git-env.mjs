/**
 * lib/core/git-env.mjs — the environment for propagate's READ-ONLY git calls.
 *
 * `git status` (and `git diff`) opportunistically refresh `.git/index` stat data and take
 * `index.lock` to do it. For a tool whose contract is "I read your repo", that is a write
 * (#102): it can flip bytes under `.git/` while a test asserts nothing changed, and it
 * can collide with a live session's own `git commit` (G72). `GIT_OPTIONAL_LOCKS=0` makes
 * git skip exactly those optional writes; it does not affect `add`, `mv`, `commit` or any
 * command that needs the lock to do its job, so only read-only call sites should use this
 * and mutating ones need not.
 *
 * Pure: no I/O at import.
 */

/** @param {NodeJS.ProcessEnv} [base] @returns {NodeJS.ProcessEnv} */
export function readOnlyGitEnv(base = process.env) {
  return { ...base, GIT_OPTIONAL_LOCKS: "0" };
}
