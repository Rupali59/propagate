/**
 * ui-build.mjs — a fingerprint of the files `propagate ui` serves, so a stale
 * server can be told from a current one.
 *
 * WHY THIS EXISTS (outside review F5, 2026-10-15). `page()` reads the client
 * from DISK on every request, but the server's own code is whatever was loaded
 * when it started. After an edit, an old running server therefore serves a NEW
 * page that talks to OLD endpoints: the page renders, every request returns
 * 200 or a 404 JSON, and nothing says the two halves are from different
 * builds. The id makes the mismatch a comparison instead of a puzzle:
 *
 *   - the server computes it ONCE at start and serves it from /api/version
 *     (what the running code is);
 *   - `page()` computes it fresh from disk and writes it on the body as
 *     data-build (what the page it just read is);
 *   - widget/open-ui.sh compares /api/version with the files on disk and
 *     replaces a server that is behind.
 *
 * THE ALGORITHM IS PLAIN CONCATENATION, on purpose. open-ui.sh has to produce
 * the same value with no node (its tests stub node with a script that sleeps
 * for 30 seconds), and `cat <files> | shasum -a 256 | cut -c1-16` is the only
 * form both languages can state identically. File order is fixed here and
 * restated there: ui.mjs, ui.client.js, then every commands/ui/css/*.css in
 * code-unit order (bash runs it under LC_ALL=C for the same reason). Change
 * the list in one place and the other computes a different id for the same
 * tree, so every click would then restart the server: the symptom is a widget
 * that always replaces a healthy UI.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";

const COMMANDS_DIR = new URL("../../commands/", import.meta.url);

/** The files whose bytes make up the id, in order. */
export function buildFiles(commandsDir = COMMANDS_DIR) {
  const dir = typeof commandsDir === "string"
    ? pathToFileURL(commandsDir.endsWith("/") ? commandsDir : commandsDir + "/")
    : commandsDir;
  const css = readdirSync(new URL("ui/css/", dir)).filter((f) => f.endsWith(".css")).sort();
  return ["ui.mjs", "ui.client.js", ...css.map((f) => "ui/css/" + f)].map((rel) => new URL(rel, dir));
}

/**
 * @param {string|URL} [commandsDir] override for tests; defaults to this checkout's commands/
 * @returns {string} 16 hex characters
 */
export function buildId(commandsDir = COMMANDS_DIR) {
  const files = buildFiles(commandsDir);
  // A floor, not a formality: a css folder that reads as empty would hash to
  // the id of "ui.mjs + ui.client.js" and look like a valid build.
  if (files.length < 3) throw new Error(`ui build id: only ${files.length} file(s) found — the scan has gone blind`);
  const h = createHash("sha256");
  for (const f of files) h.update(readFileSync(f));
  return h.digest("hex").slice(0, 16);
}
