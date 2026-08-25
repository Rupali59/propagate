/**
 * Every dynamic import inside an extracted doctor module must RESOLVE.
 *
 * WHY THIS EXISTS — a near-miss during #31 T2, and the most dangerous failure
 * mode the split has.
 *
 * The per-workspace section was moved out of cli.mjs carrying
 * `await import("./lib/refs/findings.mjs")`. That specifier is correct relative
 * to cli.mjs at the repo root and WRONG relative to lib/report/doctor/, where
 * it resolves to lib/report/doctor/lib/refs/findings.mjs. Nothing catches this:
 *
 *   - `node --check` passes. A dynamic import is not resolved at parse time.
 *   - Every unit test passes. They exercise the module's other paths.
 *   - `doctor` EXITS 0. The section wraps that region in a try/catch that
 *     reports a failed probe as `info` — deliberately, because "the probe could
 *     not run" is a third state distinct from pass and fail
 *     (rule:discernment-checks §2). So a missing module renders as one dim
 *     informational line.
 *
 * Measured: doctor's output silently fell from 465 lines to 241 — an entire
 * branch-registry section for every workspace, gone — while the command
 * reported success. It was caught only by diffing against a captured baseline.
 *
 * A static analogue cannot exist here: static imports fail loudly at load, so
 * only the dynamic ones need this. And a grep for the literal "./lib/" would be
 * a fingerprint for ONE spelling of the mistake; resolving each specifier
 * catches every spelling, including ones nobody has made yet.
 *
 * Run: `npm test` (G56).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DOCTOR_DIR = path.join(DIR, "..", "..", "lib", "report", "doctor");

/** Every `await import("<specifier>")` / `import("<specifier>")` literal in a file. */
function dynamicImportSpecifiers(source) {
  return [...source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
}

const MODULES = existsSync(DOCTOR_DIR)
  ? readdirSync(DOCTOR_DIR, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith(".mjs"))
  : [];

test("there are doctor modules to check — an empty scan must not read as a pass", () => {
  // rule:discernment-checks §1. If lib/report/doctor/ is renamed or emptied,
  // every assertion below vacuously passes and this file reports health for a
  // directory it never looked at.
  assert.ok(
    MODULES.length > 0,
    `no .mjs files found under ${DOCTOR_DIR} — this suite would then verify nothing while passing`,
  );
});

test("every dynamic import in a doctor module resolves from that module", async () => {
  const failures = [];
  let checked = 0;

  for (const rel of MODULES) {
    const abs = path.join(DOCTOR_DIR, rel);
    const specifiers = dynamicImportSpecifiers(readFileSync(abs, "utf8"));
    for (const spec of specifiers) {
      checked++;
      // Only relative specifiers can be wrong in this specific way; a bare
      // package name resolves through node_modules regardless of location.
      if (!spec.startsWith(".")) continue;
      const target = path.resolve(path.dirname(abs), spec);
      if (!existsSync(target)) {
        failures.push(
          `${rel}: import("${spec}") -> ${target} does not exist. ` +
            `A specifier copied out of cli.mjs is relative to the REPO ROOT, not to this module.`,
        );
        continue;
      }
      // Exists is necessary but not sufficient — prove it actually loads.
      try {
        await import(pathToFileURL(target).href);
      } catch (err) {
        failures.push(`${rel}: import("${spec}") exists but failed to load — ${err.message}`);
      }
    }
  }

  assert.deepEqual(
    failures,
    [],
    `unresolvable dynamic import(s) in extracted doctor modules:\n  ${failures.join("\n  ")}\n` +
      `These do NOT fail node --check, do NOT fail unit tests, and do NOT fail doctor — ` +
      `the section's try/catch reports them as an informational "probe could not run" line ` +
      `while its whole output disappears.`,
  );

  // Absence must be attributable: "0 specifiers checked" and "all resolved" are
  // different facts, and only one of them is evidence.
  assert.ok(
    checked > 0,
    `scanned ${MODULES.length} module(s) and found NO dynamic imports at all — ` +
      `either the regex stopped matching or the modules changed shape. Verify before trusting this pass.`,
  );
});
