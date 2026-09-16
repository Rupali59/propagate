/**
 * `propagate` is a published npm bin and `status` is its hottest command —
 * doctor alone defers 14 modules for exactly this reason. `commands/plans.mjs`
 * pulls in the curate-docs link-graph machinery, so it MUST be reached only
 * through a dynamic `await import()` inside cli.mjs's dispatch arm, never a
 * top-level import (prior learning: `extracting-cli-code-can-make-lazy-imports-eager`).
 *
 * This is a REAL test, not a comment: it is mutated in-memory below and must
 * go red for the stated reason (`rule:discernment-checks` §1 — a check that
 * cannot fail is worse than no check). The mutation never touches the actual
 * cli.mjs on disk.
 *
 * Run: `npm test` (G56).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(REPO, "cli.mjs");

// Matches a real ES module import DECLARATION. These are only legal at the top
// level of a module (Node throws a SyntaxError otherwise), so finding one
// anywhere in the file text is equivalent to finding one at "top level" — there
// is nowhere else it could legally be.
const STATIC_IMPORT_RE = /^import\s+[\s\S]*?\sfrom\s+["']([^"']+)["'];?/gm;

function staticImportSpecifiers(text) {
  return [...text.matchAll(STATIC_IMPORT_RE)].map((m) => m[1]);
}

test("cli.mjs has NO top-level (static) import of the plans command or lib module", () => {
  const text = readFileSync(CLI, "utf8");
  const offenders = staticImportSpecifiers(text).filter((s) => s.includes("plans.mjs"));
  assert.deepEqual(
    offenders,
    [],
    `cli.mjs statically imports ${offenders.join(", ")} — this would tax every ` +
      `\`status\`/\`check\` invocation with the curate-docs link-graph dependency`,
  );
});

test("cli.mjs DOES reach commands/plans.mjs via a dynamic await import() — the command must still work", () => {
  const text = readFileSync(CLI, "utf8");
  assert.match(
    text,
    /await import\(\s*["']\.\/commands\/plans\.mjs["']\s*\)/,
    "no dynamic import of commands/plans.mjs found — the `plans` dispatch arm may have been removed or rewritten to something this pattern can't see",
  );
});

test("mutation gate: an injected top-level import of plans.mjs IS caught by the detector above", () => {
  // In-memory only. Proves staticImportSpecifiers() can fail — a detector that
  // cannot fail is worse than no detector (rule:discernment-checks §1).
  const real = readFileSync(CLI, "utf8");
  const mutated = `import { plansCmd } from "./commands/plans.mjs";\n${real}`;
  const offenders = staticImportSpecifiers(mutated).filter((s) => s.includes("plans.mjs"));
  assert.deepEqual(offenders, ["./commands/plans.mjs"]);
});

test("mutation gate: reverting the injection leaves the detector clean again (byte-identical revert check)", () => {
  const real = readFileSync(CLI, "utf8");
  const mutated = `import { plansCmd } from "./commands/plans.mjs";\n${real}`;
  const reverted = mutated.replace(`import { plansCmd } from "./commands/plans.mjs";\n`, "");
  assert.equal(reverted, real, "the revert must reproduce the original text exactly");
  const offenders = staticImportSpecifiers(reverted).filter((s) => s.includes("plans.mjs"));
  assert.deepEqual(offenders, []);
});
