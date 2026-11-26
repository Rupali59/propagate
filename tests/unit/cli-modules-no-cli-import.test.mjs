/**
 * cli-modules-no-cli-import.test.mjs — no cli/*.mjs module imports cli.mjs back (epic #143, #162).
 *
 * Why: cli.mjs dispatches to cli/*.mjs. A module that imports cli.mjs makes a cycle, and
 * because cli.mjs runs its dispatch at load time, an import from a command module would
 * execute the CLI. Dependencies point one way: cli.mjs -> cli/*.mjs -> lib/.
 *
 * The population is derived by walking cli/, with a floor: a walk that finds nothing must
 * read as a blind scan, never as a clean one (rule:derive-dont-curate).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI_DIR = path.join(REPO, "cli");

/** Specifiers in `source` (static `from`, bare `import "x"`, and `import("x")`) that name cli.mjs. */
export function cliMjsImports(source) {
  const specs = [
    ...source.matchAll(/\bfrom\s*(["'`])([^"'`]+)\1/g),
    ...source.matchAll(/\bimport\s*(["'`])([^"'`]+)\1/g),
    ...source.matchAll(/\bimport\(\s*(["'`])([^"'`]+)\1\s*\)/g),
  ].map((m) => m[2]);
  return specs.filter((s) => /(^|\/)cli\.mjs$/.test(s));
}

function modules() {
  return readdirSync(CLI_DIR).filter((n) => n.endsWith(".mjs")).sort();
}

test("no cli/*.mjs imports cli.mjs", () => {
  const mods = modules();
  assert.ok(mods.length >= 30, `only ${mods.length} modules under cli/ — the scan has gone blind, it has not found nothing`);
  const offenders = mods
    .map((m) => ({ m, hits: cliMjsImports(readFileSync(path.join(CLI_DIR, m), "utf8")) }))
    .filter((x) => x.hits.length);
  assert.deepEqual(offenders, [], "these cli/ modules import cli.mjs; depend on lib/ instead, never on the dispatcher");
});

test("the detector can fail: a planted import of cli.mjs is reported, in each import form", () => {
  assert.deepEqual(cliMjsImports('import { x } from "../cli.mjs";'), ["../cli.mjs"]);
  assert.deepEqual(cliMjsImports('const m = await import("../cli.mjs");'), ["../cli.mjs"]);
  assert.deepEqual(cliMjsImports('import "../cli.mjs";'), ["../cli.mjs"]);
  assert.deepEqual(cliMjsImports('import { y } from "./doctor.mjs";'), [], "a sibling module is not cli.mjs");
});
