/**
 * Tests for the declared-exceptions registry (lib/report/health-exceptions.mjs) and its doctor
 * gate (lib/report/doctor/health-exceptions.mjs). Plan ticklish-gathering-brook, E6.
 *
 * Every hostile input is a LITERAL (rule:mutate-behind-the-fixture-builder): the registry text and
 * the findings are written out by hand, not produced by the code under test.
 *
 * Run: PROPAGATE_STATE_DIR="${TMPDIR:-/tmp}/propagate-test-state" node --test tests/unit/health-exceptions.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Reporter } from "../../lib/report/doctor/reporter.mjs";
import { createExceptionGate } from "../../lib/report/doctor/health-exceptions.mjs";
import { parseHealthExceptions } from "../../lib/report/health-exceptions.mjs";
import { buildDoctorJson } from "../../lib/report/doctor/structure.mjs";

function hubWith(registryText) {
  const hub = mkdtempSync(path.join(tmpdir(), "health-exc-"));
  const dir = path.join(hub, "scripts", "execution");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "health-exceptions.yml");
  if (registryText !== null) writeFileSync(file, registryText);
  return { hub, file };
}

const REGISTRY = `
exceptions:
  "v3-layout-empty:Khushboo":
    reason: "doc-only husk"
    since: 2026-10-15
  "rules-restated:skill-routing@Divyansh/AuroraV3/CLAUDE.md":
    reason: "fork, not ours to edit"
    since: 2026-09-25
`;

const khushboo = { subject: "Khushboo", label: "Khushboo's state/ holds no state" };
const grid = { subject: "Grid", label: "Grid's state/ holds no state" };

test("an accepted finding is not failing, is counted, and does not raise problems", () => {
  const { file } = hubWith(REGISTRY);
  const r = new Reporter();
  const gate = createExceptionGate({ reporter: r, registryFile: file });
  const failing = gate.apply("v3-layout-empty", [khushboo]);
  gate.apply("rules-restated", [{ subject: "skill-routing@Divyansh/AuroraV3/CLAUDE.md", label: "x" }]);
  const fin = gate.finish();
  assert.deepEqual(failing, [], "Khushboo is listed, so it must not be returned as failing");
  assert.equal(fin.accepted, 2);
  assert.equal(r.problems, 0, "accepted findings must never vote");
  const acc = r.entries.filter((e) => e.label.startsWith("accepted: "));
  assert.equal(acc.length, 2);
  assert.match(acc[0].detail, /doc-only husk/, "the reason must be shown");
});

test("an unlisted failing finding stays a failure", () => {
  const { file } = hubWith(REGISTRY);
  const r = new Reporter();
  const gate = createExceptionGate({ reporter: r, registryFile: file });
  const failing = gate.apply("v3-layout-empty", [khushboo, grid]);
  assert.deepEqual(failing.map((f) => f.subject), ["Grid"]);
});

test("a stale exception (its finding no longer fails) is a failure", () => {
  const { file } = hubWith(REGISTRY);
  const r = new Reporter();
  const gate = createExceptionGate({ reporter: r, registryFile: file });
  gate.apply("v3-layout-empty", []); // Khushboo no longer fails
  gate.apply("rules-restated", [{ subject: "skill-routing@Divyansh/AuroraV3/CLAUDE.md", label: "x" }]);
  gate.finish();
  const fails = r.entries.filter((e) => e.kind === "fail");
  assert.equal(fails.length, 1);
  assert.equal(fails[0].label, "health exceptions are all still needed");
  assert.match(fails[0].detail, /v3-layout-empty:Khushboo/);
  assert.match(fails[0].detail, /STALE/);
  assert.equal(r.problems, 1);
});

test("an exception whose check did not run is not judged stale", () => {
  const { file } = hubWith(REGISTRY);
  const r = new Reporter();
  const gate = createExceptionGate({ reporter: r, registryFile: file });
  gate.finish(); // neither check evaluated
  assert.equal(r.problems, 0);
  assert.ok(r.entries.some((e) => e.label === "health exceptions not judged"));
});

test("a missing registry is an attributable failure when something failed", () => {
  const { file } = hubWith(null);
  const r = new Reporter();
  const gate = createExceptionGate({ reporter: r, registryFile: file });
  const failing = gate.apply("v3-layout-empty", [khushboo]);
  gate.finish();
  assert.equal(failing.length, 1, "with no registry nothing is accepted");
  const f = r.entries.find((e) => e.kind === "fail");
  assert.ok(f, "must fail loudly");
  assert.equal(f.label, "health-exceptions registry present");
  assert.match(f.detail, /does not exist/);
  assert.match(f.detail, /no exception was consulted/);
});

test("a missing registry with nothing failing is an info line, not a silent pass", () => {
  const { file } = hubWith(null);
  const r = new Reporter();
  const gate = createExceptionGate({ reporter: r, registryFile: file });
  gate.apply("v3-layout-empty", []);
  gate.finish();
  assert.equal(r.problems, 0);
  const i = r.entries.find((e) => e.label === "health exceptions");
  assert.ok(i && /registry unavailable/.test(i.detail), "absence must be stated, not omitted");
});

test("an unparseable registry is an attributable failure, even with nothing failing", () => {
  const { file } = hubWith("exceptions: [unclosed\n  - : :");
  const r = new Reporter();
  const gate = createExceptionGate({ reporter: r, registryFile: file });
  const failing = gate.apply("v3-layout-empty", [khushboo]);
  gate.finish();
  assert.equal(failing.length, 1, "a broken registry must not accept anything");
  const f = r.entries.find((e) => e.kind === "fail" && e.label === "health-exceptions registry parses");
  assert.ok(f);
  assert.match(f.detail, /not valid YAML/);
});

test("registry problems: unknown check id, missing reason, bad since, absent exceptions key", () => {
  assert.match(parseHealthExceptions(`exceptions:\n  "nope:x":\n    reason: r\n    since: 2026-01-01\n`).problems.join(), /check-id/);
  assert.match(parseHealthExceptions(`exceptions:\n  "v3-layout-empty:A":\n    since: 2026-01-01\n`).problems.join(), /reason/);
  assert.match(parseHealthExceptions(`exceptions:\n  "v3-layout-empty:A":\n    reason: r\n    since: yesterday\n`).problems.join(), /since/);
  assert.match(parseHealthExceptions(`limit: 1\n`).problems.join(), /exceptions/);
  assert.deepEqual(parseHealthExceptions(`exceptions: {}\n`).problems, [], "explicit empty is valid");
});

test("the doctor snapshot carries `accepted` per section and in totals", () => {
  const { file } = hubWith(REGISTRY);
  const r = new Reporter();
  r.header("# Discovery integrity");
  const gate = createExceptionGate({ reporter: r, registryFile: file });
  gate.apply("v3-layout-empty", [khushboo]);
  r.info("a plain tally", "x");
  // Render the way cli.mjs renderDoctorEntries renders `info`, which is all #accepted rides on.
  const lines = r.drain().map((e) => (e.kind === "header" ? e.label : `  · ${e.label}  ${e.detail}`));
  const j = buildDoctorJson(lines, { problems: 0, generatedAt: "t" });
  const sec = j.sections.find((s) => s.name === "Discovery integrity");
  assert.equal(sec.accepted, 1);
  assert.equal(sec.info, 1, "accepted lines are NOT double counted as info");
  assert.equal(j.totals.accepted, 1);
  assert.equal(sec.entries[0].kind, "accepted");
});
