/**
 * cli-imports.test.mjs — every module under cli/ loads, and every dynamic import() in cli.mjs and
 * digest.mjs that points at cli/ resolves to a file that exists.
 *
 * Why this exists (#97, G60): a relative DYNAMIC import that no longer resolves does not fail at parse
 * time, so `node --check` passes and doctor stays green; it fails only when the one command that
 * dispatches to it is run. Moving commands/*.mjs to cli/ changed 17+ such specifiers. Nothing short of
 * EXECUTING each import (or checking each specifier against the disk) sees a stale one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import vm from "node:vm";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI_DIR = path.join(REPO, "cli");

/** Every `import("./cli/...")` / `import('./cli/...')` / `import(`./cli/...`)` specifier in `source`. */
export function cliSpecifiers(source) {
  return [...source.matchAll(/import\(\s*(["'`])(\.\/cli\/[^"'`]+)\1\s*\)/g)].map((m) => m[2]);
}

/** Specifiers that do not resolve against `root`. */
export function unresolved(specs, root) {
  return specs.filter((s) => !existsSync(path.join(root, s)));
}

const SOURCES = ["cli.mjs", "digest.mjs"];

test("every cli/*.mjs module imports (a dynamic import that fails is silent until its command runs)", async () => {
  const mods = readdirSync(CLI_DIR).filter((n) => n.endsWith(".mjs")).sort();
  assert.ok(mods.length >= 17, `only ${mods.length} modules under cli/ — the scan has gone blind, it has not found nothing`);
  for (const m of mods) {
    const ns = await import(pathToFileURL(path.join(CLI_DIR, m)).href);
    assert.ok(ns && typeof ns === "object", `cli/${m} did not load`);
  }
});

test("cli/ui.client.js is a browser script, not a module: it parses, and is not imported", () => {
  // It runs in a page with Preact/htm as globals, so importing it here would throw ReferenceError.
  // Compiling (not running) it proves it is syntactically whole where it now lives.
  assert.doesNotThrow(() => new vm.Script(readFileSync(path.join(CLI_DIR, "ui.client.js"), "utf8"), { filename: "cli/ui.client.js" }));
});

test("every dynamic import(\"./cli/...\") in cli.mjs and digest.mjs resolves to an existing file", () => {
  const specs = SOURCES.flatMap((f) => cliSpecifiers(readFileSync(path.join(REPO, f), "utf8")));
  assert.ok(specs.length >= 17, `only ${specs.length} ./cli/ import specifiers found in ${SOURCES.join(" + ")} — the scan has gone blind, it has not found nothing`);
  assert.deepEqual(unresolved(specs, REPO), [], "these import() specifiers point at files that do not exist");
});

test("the specifier check can fail: one specifier mutated in an in-memory copy of cli.mjs is reported", () => {
  const real = readFileSync(path.join(REPO, "cli.mjs"), "utf8");
  const first = cliSpecifiers(real)[0];
  assert.ok(first, "no specifier to mutate");
  const bad = first.replace(/\.mjs$/, "-gone.mjs");
  const mutated = real.replace(first, bad);
  assert.notEqual(mutated, real, "the mutation did not apply");
  assert.deepEqual(unresolved(cliSpecifiers(real), REPO), [], "the real copy must be clean for the mutation to mean anything");
  assert.deepEqual(unresolved(cliSpecifiers(mutated), REPO), [bad], "the stale specifier was not reported");
});
