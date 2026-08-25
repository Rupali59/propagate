/**
 * No file may CALL a `lib/` export it never imported.
 *
 * WHY THIS EXISTS — the single most expensive defect class of the cli.mjs split,
 * six instances on 2026-08-25 alone, one of which reached committed code and
 * shipped as a crash.
 *
 * When a helper moves from cli.mjs into lib/, every remaining call site becomes
 * a bare reference to a name that no longer exists. Nothing catches it:
 *
 *   - `node --check` passes. An undefined global is legal at parse time; it is
 *     a ReferenceError only when the line EXECUTES.
 *   - Every other test passes. They exercise other branches.
 *   - The command works — until someone takes the one branch that reaches it.
 *
 * Measured: `formatAge` moved to lib/edges/ledger.mjs and left a call at
 * cli.mjs:2298 inside `reconcileInbound`. `propagate reconcile --inbound`
 * crashed with a ReferenceError for every user, through multiple commits, while
 * the default reconcile path stayed green.
 *
 * WHY A SCAN AND NOT A RUNTIME LOOP. Runtime errors SERIALISE — a branch dies at
 * its first undefined name, so fix-and-rerun reports progress while concealing
 * how many remain. Extracting `status` had FOUR such references and runtime
 * surfaced only TWO. This scan found all four in one pass.
 *
 * WHY THE SCAN LOOKS THE WAY IT DOES. Two earlier hand-rolled free-variable
 * analyses gave false CLEARS here, because both needed correct JS scope
 * modelling and neither had it. This asks a question that needs no scope
 * analysis at all: is this name a known `lib/` export, is it CALLED unqualified,
 * and is it absent from every binding this file establishes? `known` is
 * deliberately over-collected, so the scan errs toward silence rather than
 * noise — a false negative here costs one bug, a false positive costs trust in
 * the whole suite.
 *
 * Run: `npm test` (G56 — never bare `node --test`, that writes to the
 * production ledger).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(DIR, "..", "..");

/** Every name `lib/**` exports. */
function libExports() {
  const out = new Set();
  const libDir = path.join(REPO, "lib");
  for (const rel of readdirSync(libDir, { recursive: true }).map(String)) {
    if (!rel.endsWith(".mjs")) continue;
    const src = readFileSync(path.join(libDir, rel), "utf8");
    for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)) {
      out.add(m[1]);
    }
  }
  return out;
}

/**
 * Every name a file BINDS: static + dynamic import bindings (including `as`
 * aliases), top-level declarations, and destructured `const {…} =` bindings.
 * Over-collection is intentional — see the header.
 */
function boundNames(src) {
  const out = new Set();
  for (const m of src.matchAll(/import\s*\{([^}]*)\}/g)) {
    for (const piece of m[1].split(",")) {
      const name = piece.includes(" as ") ? piece.split(" as ")[1] : piece;
      const t = name.trim();
      if (t) out.add(t);
    }
  }
  for (const m of src.matchAll(/^\s*(?:export\s+)?(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    out.add(m[1]);
  }
  for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
    for (const piece of m[1].split(",")) {
      const t = piece.split(":").pop().trim();
      if (t) out.add(t);
    }
  }
  for (const m of src.matchAll(/import\s+(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)\s+from/g)) out.add(m[1]);
  return out;
}

/** Files that consume lib/ and are not themselves under lib/. */
function targets() {
  const files = [];
  for (const rel of ["cli.mjs", "digest.mjs"]) {
    const abs = path.join(REPO, rel);
    if (existsSync(abs)) files.push(abs);
  }
  const cmds = path.join(REPO, "commands");
  if (existsSync(cmds)) {
    for (const rel of readdirSync(cmds, { recursive: true }).map(String)) {
      if (rel.endsWith(".mjs")) files.push(path.join(cmds, rel));
    }
  }
  return files;
}

/** Unqualified calls to `exports` that `src` never binds. */
function bareCalls(src, exports) {
  const bound = boundNames(src);
  const found = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(\*|\/\/)/.test(line)) continue; // comment
    for (const name of exports) {
      if (bound.has(name)) continue;
      // `[^.\w$]` is the load-bearing part: it rejects `ns.name(`, which is a
      // namespace call and always fine. Without it every `lc.promote(` and
      // `gi.buildModel(` reports, and a scan that cries wolf gets ignored.
      const re = new RegExp(`(^|[^.\\w$])${name}\\s*\\(`);
      if (re.test(line)) found.push({ line: i + 1, name, text: line.trim().slice(0, 100) });
    }
  }
  return found;
}

const EXPORTS = libExports();
const TARGETS = targets();

test("the scan has inputs — an empty corpus must not read as a pass", () => {
  // rule:discernment-checks §1 and §2. With no lib exports or no target files,
  // every assertion below passes vacuously and this file reports health for
  // something it never looked at.
  assert.ok(EXPORTS.size > 50, `only ${EXPORTS.size} lib exports found — the export regex likely stopped matching`);
  assert.ok(TARGETS.length > 2, `only ${TARGETS.length} target files found — commands/ may have moved`);
});

test("the scan CAN fail — a synthetic bare reference is detected", () => {
  // The mutation this guard needs to be trustworthy. Pick a real export, call
  // it unqualified from a file that does not import it, and require a hit.
  const victim = [...EXPORTS][0];
  const synthetic = `const x = ${victim}(1);\n`;
  const hits = bareCalls(synthetic, EXPORTS);
  assert.equal(hits.length, 1, `the scan failed to flag a deliberate bare call to ${victim}`);
  assert.equal(hits[0].name, victim);

  // And it must NOT flag the qualified form, or it would be unusable.
  assert.equal(bareCalls(`const x = ns.${victim}(1);\n`, EXPORTS).length, 0, "a namespace call must not report");
  // ...nor a call in a file that imports the name.
  assert.equal(
    bareCalls(`import { ${victim} } from "./lib/x.mjs";\nconst x = ${victim}(1);\n`, EXPORTS).length,
    0,
    "an imported name must not report",
  );
});

test("no file calls a lib/ export it does not import", () => {
  const failures = [];
  for (const abs of TARGETS) {
    for (const hit of bareCalls(readFileSync(abs, "utf8"), EXPORTS)) {
      failures.push(`${path.relative(REPO, abs)}:${hit.line}  ${hit.name}() — ${hit.text}`);
    }
  }
  assert.deepEqual(
    failures,
    [],
    `bare reference(s) to lib/ exports — these throw ReferenceError only when the line RUNS, ` +
      `so node --check passes, the unit tests pass, and the command crashes for whoever takes ` +
      `that branch:\n  ${failures.join("\n  ")}`,
  );
});
