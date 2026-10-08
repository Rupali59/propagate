/**
 * public-forbidden.test.mjs — what `make-public` refuses to publish after scrubbing.
 *
 * The home-path pattern carried the `i` flag until 2026-10-04, so GitHub's own
 * `github.com/users/<owner>/projects/<n>` URL read as an "absolute macOS home
 * path", and the first one committed (7fe37a5) turned the make-public watchlist
 * tests red on the committed tree. Both directions are pinned here: real home
 * paths are still caught, public GitHub user URLs are not.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { FORBIDDEN } from "../../lib/core/public-forbidden.mjs";

const hits = (text) =>
  FORBIDDEN.flatMap(({ re, label }) => {
    re.lastIndex = 0;
    return (text.match(re) ?? []).map(() => label);
  });

test("a real macOS home path is still refused", () => {
  assert.deepEqual(hits("cwd is /Users/someone/Documents/x"), ["absolute macOS home path"]);
});

test("the home-dir username is refused in any case", () => {
  // Built at runtime: the literal in this file would itself be refused by make-public (N123).
  const user = ["RUPALI", "B"].join(".");
  assert.deepEqual(hits(`owner ${user} wrote this`), ["home-dir username"]);
});

test("a GitHub user/project URL is NOT a home path (the 7fe37a5 false positive)", () => {
  assert.deepEqual(hits("board: https://github.com/users/Rupali59/projects/3"), []);
  assert.deepEqual(hits("https://github.com/users/someone/projects/1/views/2"), []);
});
