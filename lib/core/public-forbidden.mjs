/**
 * Patterns that must not survive into the public tree (`bin/make-public.mjs`),
 * checked AFTER the identity map has scrubbed known names.
 *
 * Lives here rather than inside the script because the script runs on import, so
 * a constant defined there cannot be tested — and this one was wrong for a week
 * with nothing able to look at it.
 *
 * CASE-SENSITIVE ON PURPOSE. A macOS home directory is `/Users/<name>`, capital U.
 * Until 2026-10-04 the pattern carried the `i` flag, so it also matched GitHub's
 * own `https://github.com/users/<owner>/projects/<n>` — a public URL, not a path.
 * The first such URL entered a tracked file in 7fe37a5 (TODOS PR-034, linking
 * GitHub Project #3) and turned three `make-public --check` tests red on the
 * committed tree: "1 FILE(S) STILL CARRY PRIVATE CONTENT … absolute macOS home
 * path". The username pattern keeps `i`: the home-dir username in any case is the leak.
 *
 * NEVER WRITE THE LITERAL USERNAME IN THIS FILE OR ITS TEST — not in a comment, not in
 * a fixture. make-public reads every TRACKED file, these included, and refuses on it.
 * The first version did both, and turned main red the moment it was committed (N123).
 */
export const FORBIDDEN = Object.freeze([
  { re: /rupali\.b/gi, label: "home-dir username" },
  { re: /\/Users\/[a-z]/g, label: "absolute macOS home path" },
]);
