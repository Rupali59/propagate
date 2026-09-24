/**
 * doctor-severity.test.mjs — N87 slice 2b.
 *
 * Every doctor section declares the severity of what it reports, so the terse
 * gate (slice 3) can show failures and above-threshold warnings and count the
 * rest.
 *
 * WHY THE SECTION AND NOT THE CALL SITE. Measured 2026-09-23: doctor has 60
 * `reporter.check` call sites across 8 modules. Sixty judgements is a
 * classification project nobody finishes; eight is one diff. N87 framed this as
 * "14 distinct check classes", which matched neither number.
 *
 * A module whose checks genuinely span two severities should SPLIT — that is
 * normally a module doing two jobs, and the split is the finding.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const DIR = new URL("../../lib/report/doctor/", import.meta.url);
const VALID = ["S1", "S2", "S3"];

const REPORTS_RE = /reporter\.(check|warn|info|note|header|inconclusive)\(/;

/**
 * THE POPULATION IS "MODULES THAT REPORT", DERIVED — not "files in the
 * directory". Those are different sets and only one answers the question.
 *
 * The first draft of this test used the filename list, and failed on
 * `snapshot.mjs` and `structure.mjs`. Measured: both emit ZERO `reporter.*`
 * calls — `structure.mjs` exports `stripAnsi`/`classifyLine`/`toSections`, it
 * parses doctor output rather than producing it. Declaring a severity on a
 * module that reports nothing would be a value with no meaning, added only to
 * satisfy a check. `rule:discernment-checks` §5: state what the measurement is
 * over, and confirm it is the same thing the claim is about.
 *
 * Derived, never listed, so a new reporting module is graded the day it lands.
 */
const allFiles = readdirSync(DIR).filter((f) => f.endsWith(".mjs")).sort();
const reports = (f) => REPORTS_RE.test(readFileSync(new URL(f, DIR), "utf8"));
const modules = allFiles.filter((f) => f !== "reporter.mjs" && reports(f));
const helpers = allFiles.filter((f) => f !== "reporter.mjs" && !reports(f));

test("the module corpus is not empty — a coverage test that finds nothing reports perfect coverage", () => {
  assert.ok(modules.length >= 7, `only ${modules.length} doctor modules found: ${modules.join(", ")}`);
});

test("every doctor section declares a severity, and it is one of S1/S2/S3", async () => {
  const missing = [];
  const invalid = [];
  for (const f of modules) {
    const m = await import(new URL(f, DIR));
    if (!("SEVERITY" in m)) {
      missing.push(f);
    } else if (!VALID.includes(m.SEVERITY)) {
      invalid.push(`${f}=${JSON.stringify(m.SEVERITY)}`);
    }
  }
  assert.deepEqual(missing, [], `these doctor sections declare no SEVERITY: ${missing.join(", ")}`);
  assert.deepEqual(invalid, [], `these declare something that is not S1/S2/S3: ${invalid.join(", ")}`);
});

test("modules that report NOTHING are exempt, and are NAMED rather than silently skipped", () => {
  // "Found nothing to grade" and "graded everything" must not render alike.
  assert.ok(helpers.length > 0, "if this is 0, the reporting-detection regex has stopped matching");
  for (const h of helpers) {
    assert.ok(!REPORTS_RE.test(readFileSync(new URL(h, DIR), "utf8")), `${h} reports after all — it needs a severity`);
  }
  console.log(`    exempt helpers (no reporter calls): ${helpers.join(", ")}`);
});

test("reporter.mjs is deliberately exempt — it is the contract, not a section", async () => {
  // Named rather than silently skipped: an exemption nobody states is
  // indistinguishable from an omission.
  const m = await import(new URL("reporter.mjs", DIR));
  assert.ok(!("SEVERITY" in m), "reporter.mjs owns the vocabulary; it reports nothing of its own");
});
