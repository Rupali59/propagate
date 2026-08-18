/**
 * Strip ANSI SGR sequences from captured CLI output.
 *
 * Exists so nobody writes the raw match again. `docs/GOTCHAS.md` **G30**: a test
 * asserting `/✗\s*no unowned ledger files/` failed while the check was firing
 * perfectly, because raw stdout is `\x1B[31m✗\x1B[0m no unowned ledger files` —
 * the escape sits *between* the glyph and the label. A terminal strips it;
 * `spawnSync` does not, so the bug looks like the check is broken.
 *
 * It was recorded, and then re-implemented inline in two separate test files
 * (`journal.test.mjs`, `whole-project-ledger.test.mjs`) with no shared helper —
 * which is how the next person writes it a third time, slightly differently.
 *
 * Deliberately narrow: SGR (`m`) only. Cursor movement, erase-line and the rest
 * do not appear in this CLI's output, and a regex broad enough to eat them would
 * also eat legitimate text containing `\x1B[`.
 *
 * @param {string} s
 * @returns {string}
 */
export const plain = (s) => String(s).replace(/\x1B\[[0-9;]*m/g, "");

/**
 * Assert that `pattern` matches `output` once ANSI is stripped, and say what the
 * raw bytes were when it does not — the failure message is the whole point,
 * since "did not match" on coloured output sends people to the wrong file.
 *
 * @param {import("node:assert")} assert - the caller's assert, so this helper
 *   stays dependency-free and the stack trace points at the calling test
 * @param {string} output
 * @param {RegExp} pattern
 * @param {string} [message]
 */
export function assertMatchesPlain(assert, output, pattern, message) {
  const stripped = plain(output);
  assert.match(
    stripped,
    pattern,
    `${message || "output did not match"}\n` +
      `  pattern : ${pattern}\n` +
      `  stripped: ${JSON.stringify(stripped.slice(0, 300))}\n` +
      `  raw     : ${JSON.stringify(String(output).slice(0, 300))}\n` +
      `  (if the two differ only by \\x1B[..m, this helper is the fix — GOTCHAS G30)`,
  );
}
