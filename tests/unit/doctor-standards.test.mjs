import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkStandards, FINDING_SEVERITY, SEVERITY } from "../../lib/report/doctor/standards.mjs";
import { Reporter } from "../../lib/report/doctor/reporter.mjs";
import { writeVersions } from "../../lib/kb/standards/versions.mjs";

// Invented names only (public repo): standard `acme-tool`, workspace `acme-ws`, projects p0..pN.
const ROWS = {
  ok: (n, v = "acme-tool 1.2.0") => `### acme-tool-00${n} · row ${n}\n**State:** adopted\n**Source:** Acme docs · **Version:** ${v} · **Checked:** 2026-11-14\n**Check:** test: t${n}\n**Fails when:** the thing is removed\n\n`,
  noFails: (n) => `### acme-tool-00${n} · row ${n}\n**State:** adopted\n**Source:** Acme docs · **Version:** acme-tool 1.2.0\n**Check:** test: t${n}\n\n`,
  review: (n) => `### acme-tool-00${n} · row ${n}\n**State:** adopted\n**Source:** Acme docs\n**Check:** review: a reviewer reads it\n\n`,
  retired: (n) => `### acme-tool-00${n} · row ${n}\n**State:** retired\n**Source:** Acme docs\n**Check:** none\n\n`,
};

/** A whole fixture tree: registry, page, workspace sidecars, a state dir and 12 fake units (the first `withAcme` carry acme.yaml). */
function fixture({ rows = ROWS.ok(1), sidecars = {}, versions = null, withAcme = 2, n = 12, schema = 1, pageExtra = "" } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "doc-std-"));
  const pdir = path.join(root, "standards");
  mkdirSync(path.join(pdir, "tool"), { recursive: true });
  const file = path.join(root, "standards.yml");
  writeFileSync(file, `schema_version: ${schema}\nstandards:\n  acme-tool:\n    kind: tool\n    page: tool/acme-tool.md\n    detect: {files: [acme.yaml]}\n    probe: {cmd: acme, args: [--version], parse: "(\\\\S+)"}\n`);
  writeFileSync(path.join(pdir, "tool", "acme-tool.md"), `---\nid: acme-tool\nkind: tool\nversion_probe: acme-tool\n---\n\n## Rows\n\n${rows}${pageExtra}`);
  const ws = path.join(root, "ws");
  for (const [proj, text] of Object.entries(sidecars)) {
    mkdirSync(path.join(ws, "propagation", "state", proj), { recursive: true });
    writeFileSync(path.join(ws, "propagation", "state", proj, ".sidecar.yml"), text);
  }
  const state = path.join(root, "state");
  mkdirSync(state);
  if (versions) writeVersions(state, { at: "2026-11-15T00:00:00Z", tools: { "acme-tool": { version: versions, at: "2026-11-15T00:00:00Z" } } });
  const units = [];
  for (let i = 0; i < n; i++) {
    const abs = path.join(root, "units", `u${i}`);
    mkdirSync(abs, { recursive: true });
    if (i < withAcme) writeFileSync(path.join(abs, "acme.yaml"), "x: 1\n");
    units.push({ workspace: "acme-ws", project: `p${i}`, rel: `u${i}`, abs });
  }
  return { integrations: { kbStandardsFile: file, kbStandardsDir: pdir }, workspaces: [{ name: "acme-ws", root: ws }], stateDir: state, units, minUnits: 10 };
}

async function run(fx) {
  const reporter = new Reporter();
  await checkStandards({ reporter, ...fx });
  return reporter;
}
const find = (r, kind, re) => r.entries.find((e) => e.kind === kind && re.test(`${e.label} ${e.detail}`));
const adopt = (units = "[u0]") => `project: p0\nstandards:\n  adopted:\n    - {standard: acme-tool, units: ${units}, since: "2026-11-01", by: someone}\n`;

test("the section declares one SEVERITY and each finding its own", () => {
  assert.equal(SEVERITY, "S2");
  assert.equal(FINDING_SEVERITY["RE-VERIFY"], "S3");
  assert.equal(FINDING_SEVERITY["STANDARDS-UNREADABLE"], "S2");
});

test("unconfigured: one info, no inconclusive, no problem", async () => {
  const r = await run({ integrations: {}, workspaces: [], stateDir: os_tmp(), units: [] });
  assert.equal(r.entriesOfKind("info").filter((e) => /not configured/.test(e.detail)).length, 1);
  assert.equal(r.entriesOfKind("inconclusive").length, 0);
  assert.equal(r.problems, 0);
});
const os_tmp = () => mkdtempSync(path.join(os.tmpdir(), "doc-std-s-"));

test("STANDARDS-UNREADABLE: a registry with the wrong schema is inconclusive", async () => {
  const r = await run(fixture({ schema: 9 }));
  assert.ok(find(r, "inconclusive", /STANDARDS-UNREADABLE.*schema_version/));
  assert.ok(r.problems >= 1);
});

test("STANDARDS-UNREADABLE: a page with a duplicate row id is inconclusive", async () => {
  const r = await run(fixture({ rows: ROWS.ok(1) + ROWS.ok(1) }));
  assert.ok(find(r, "inconclusive", /STANDARDS-UNREADABLE.*duplicate row id/));
});

test("STANDARDS-UNREADABLE: a blind scan (too few units) is inconclusive, not a clean pass", async () => {
  const r = await run(fixture({ n: 3, withAcme: 3 }));
  assert.ok(find(r, "inconclusive", /STANDARDS-UNREADABLE.*gone blind/));
  assert.equal(r.entriesOfKind("pass").length, 0);
});

test("RE-VERIFY: warns once per standard, folded, with the versions", async () => {
  const r = await run(fixture({ rows: ROWS.ok(1) + ROWS.ok(2), versions: "1.3.0" }));
  const w = find(r, "warn", /RE-VERIFY/);
  assert.ok(w, JSON.stringify(r.entries));
  assert.match(w.detail, /acme-tool: 2 row\(s\) re-verify \(1\.2\.0 → 1\.3\.0\)/);
  assert.equal(r.entriesOfKind("warn").filter((e) => /RE-VERIFY/.test(e.detail)).length, 1);
});

test("version not read: an info with the count and the command", async () => {
  const r = await run(fixture({ rows: ROWS.ok(1) + ROWS.ok(2), versions: null }));
  const i = find(r, "info", /version not read/);
  assert.ok(i);
  assert.match(i.detail, /2 row\(s\) version not read: standards versions --refresh/);
});

test("UNCHECKED-ROW: an info count per page that points at `standards review`", async () => {
  const r = await run(fixture({ rows: ROWS.ok(1) + ROWS.review(2) + ROWS.review(3), versions: "1.2.0" }));
  const i = find(r, "info", /unchecked/);
  assert.ok(i);
  assert.match(i.detail, /acme-tool: 2 row\(s\) unchecked; review rows are recorded with `standards review` \(#290\)/);
  assert.equal(r.problems, 0);
});

test("CHECK-CANNOT-FAIL: a test row with no `Fails when:` warns", async () => {
  const r = await run(fixture({ rows: ROWS.ok(1) + ROWS.noFails(2), versions: "1.2.0" }));
  const w = find(r, "warn", /CHECK-CANNOT-FAIL/);
  assert.ok(w);
  assert.match(w.detail, /acme-tool-002/);
  assert.doesNotMatch(w.detail, /acme-tool-001/);
});

test("DETECTED-NOT-ADOPTED: warns naming the project; a decline silences it", async () => {
  const a = await run(fixture({ versions: "1.2.0" }));
  const w = find(a, "warn", /DETECTED-NOT-ADOPTED/);
  assert.ok(w);
  assert.match(w.detail, /p0/);
  assert.match(w.detail, /p1/);
  const b = await run(fixture({ versions: "1.2.0", sidecars: { p0: adopt(), p1: "project: p1\nstandards:\n  declined:\n    - {standard: acme-tool, reason: uses another tool}\n" } }));
  assert.equal(find(b, "warn", /DETECTED-NOT-ADOPTED/), undefined);
});

test("ADOPTED-UNDETECTED: an adopted unit that is on disk but not detected warns", async () => {
  const r = await run(fixture({ versions: "1.2.0", withAcme: 2, sidecars: { p5: "project: p5\nstandards:\n  adopted:\n    - {standard: acme-tool, units: [u5], since: \"2026-11-01\", by: someone}\n" } }));
  const w = find(r, "warn", /ADOPTED-UNDETECTED/);
  assert.ok(w);
  assert.match(w.detail, /p5/);
  assert.equal(find(r, "warn", /UNIT-NOT-ON-DISK/), undefined);
});

test("UNIT-NOT-ON-DISK: an adopted unit that is not on disk says so, not 'not detected'", async () => {
  const r = await run(fixture({ versions: "1.2.0", sidecars: { p0: adopt("[ghost]") } }));
  const w = find(r, "warn", /UNIT-NOT-ON-DISK/);
  assert.ok(w);
  assert.match(w.detail, /ghost/);
  assert.equal(find(r, "warn", /ADOPTED-UNDETECTED/), undefined);
});

test("OVERRIDE-NO-REASON, OVERRIDE-STALE and DECLINE-NO-REASON each fail (check false)", async () => {
  const sc = `project: p0\nstandards:\n  adopted:\n    - {standard: acme-tool, units: [u0], since: "2026-11-01", by: someone}\n  overrides:\n    - {standard: acme-tool, row: acme-tool-001}\n    - {standard: acme-tool, row: acme-tool-009, reason: gone}\n    - {standard: other-tool, row: other-tool-001, reason: not adopted}\n  declined:\n    - {standard: third-tool}\n`;
  const r = await run(fixture({ versions: "1.2.0", sidecars: { p0: sc } }));
  const fails = r.entriesOfKind("fail").map((e) => e.detail).join("\n");
  assert.match(fails, /OVERRIDE-NO-REASON.*acme-tool-001/);
  assert.match(fails, /OVERRIDE-STALE.*acme-tool-009/);
  assert.match(fails, /OVERRIDE-STALE.*other-tool-001/);
  assert.match(fails, /DECLINE-NO-REASON.*third-tool/);
  assert.equal(r.entriesOfKind("fail").every((e) => e.label === "standards declarations"), true);
  assert.equal(r.problems, 4);
});

test("a retired row is a stale override target", async () => {
  const sc = "project: p0\nstandards:\n  adopted:\n    - {standard: acme-tool, units: [u0], since: \"2026-11-01\", by: someone}\n  overrides:\n    - {standard: acme-tool, row: acme-tool-002, reason: old}\n";
  const r = await run(fixture({ rows: ROWS.ok(1) + ROWS.retired(2), versions: "1.2.0", sidecars: { p0: sc } }));
  assert.match(r.entriesOfKind("fail").map((e) => e.detail).join("\n"), /OVERRIDE-STALE.*acme-tool-002/);
});

test("declarations that are all in order pass", async () => {
  const sc = "project: p0\nstandards:\n  adopted:\n    - {standard: acme-tool, units: [u0], since: \"2026-11-01\", by: someone}\n  overrides:\n    - {standard: acme-tool, row: acme-tool-001, reason: pinned on purpose}\n";
  const r = await run(fixture({ versions: "1.2.0", sidecars: { p0: sc } }));
  assert.ok(find(r, "pass", /standards declarations/));
});

test("KEY NEGATIVE: warnings only (re-verify, detected-not-adopted, cannot-fail, unit-not-on-disk) leave the problem count at 0", async () => {
  const r = await run(fixture({ rows: ROWS.ok(1) + ROWS.noFails(2) + ROWS.review(3), versions: "1.3.0", sidecars: { p5: "project: p5\nstandards:\n  adopted:\n    - {standard: acme-tool, units: [ghost], since: \"2026-11-01\", by: someone}\n" } }));
  for (const re of [/RE-VERIFY/, /DETECTED-NOT-ADOPTED/, /CHECK-CANNOT-FAIL/, /UNIT-NOT-ON-DISK/]) assert.ok(find(r, "warn", re), String(re));
  assert.equal(r.problems, 0);
  assert.equal(r.entriesOfKind("inconclusive").length, 0);
  assert.equal(r.entriesOfKind("fail").length, 0);
});

test("KEY NEGATIVE: 'version not read' alone leaves the problem count at 0 (design finding 5)", async () => {
  const r = await run(fixture({ rows: ROWS.ok(1) + ROWS.ok(2), versions: null }));
  assert.equal(r.problems, 0, "version not read is an info, not a problem");
  assert.equal(r.entriesOfKind("inconclusive").length, 0);
  assert.ok(find(r, "info", /version not read/));
});

test("DETECTED-NOT-ADOPTED: a project name shared by two workspaces is listed as <workspace>/<project>, and the command uses it", async () => {
  const fx = fixture({ versions: "1.2.0" });
  // a second workspace with its own project called p0, also carrying acme.yaml
  const abs = path.join(path.dirname(fx.stateDir), "units", "b0");
  mkdirSync(abs, { recursive: true });
  writeFileSync(path.join(abs, "acme.yaml"), "x: 1\n");
  fx.units.push({ workspace: "ws-b", project: "p0", rel: "b0", abs });
  const w = find(await run(fx), "warn", /DETECTED-NOT-ADOPTED/);
  assert.ok(w);
  assert.match(w.detail, /acme-ws\/p0/);
  assert.match(w.detail, /ws-b\/p0/);
  assert.match(w.detail, /(^|[ ,])p1([ ,]|$)/, "a unique name stays bare");
  assert.match(w.detail, /propagate standards adopt acme-tool <workspace>\/<project>/);
});

test("the cache age is shown, and a cached non-version value reads as not read", async () => {
  const fx = fixture({ rows: ROWS.ok(1), versions: "is" });
  const r = await run({ ...fx, now: Date.parse("2026-11-15T03:00:00Z") });
  assert.ok(find(r, "info", /versions read 3h ago/));
  assert.ok(find(r, "info", /version not read/), "\"is\" is not a version");
});

test("a sidecar whose adopted: is not a list is ONE inconclusive entry with no doubled prefix", async () => {
  const r = await run(fixture({ versions: "1.2.0", sidecars: { p0: "project: p0\nstandards:\n  adopted: notalist\n" } }));
  const bad = r.entriesOfKind("inconclusive").filter((e) => /notalist|must be a mapping|adopted/.test(e.detail));
  assert.equal(bad.length, 1, JSON.stringify(bad));
  assert.doesNotMatch(bad[0].detail, /STANDARDS-UNREADABLE:.*STANDARDS-UNREADABLE:/);
  assert.equal(r.problems, 1);
});

test("a throw inside checkStandards is an inconclusive entry and counts as a problem, never silent", async () => {
  const { runStandardsSection } = await import("../../lib/report/doctor/standards.mjs");
  const fx = fixture({ versions: "1.2.0" });
  // a registry entry with a non-string `page` throws out of loadStandards (registry.mjs path.join)
  const regFile = fx.integrations.kbStandardsFile;
  writeFileSync(regFile, "schema_version: 1\nstandards:\n  acme-tool:\n    kind: tool\n    page: 5\n");
  const reporter = new Reporter();
  await runStandardsSection({ reporter, ...fx });
  const e = find(reporter, "inconclusive", /standards could not run/);
  assert.ok(e, JSON.stringify(reporter.entries));
  assert.ok(reporter.problems >= 1);
});
