import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { compareVersions, rowStatus, buildStandardsReport, NO_VERSION_REASON } from "../../lib/standards/status.mjs";
import { readVersions, refreshVersions, writeVersions } from "../../lib/standards/versions.mjs";
import { loadRegistry, loadStandards } from "../../lib/standards/registry.mjs";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "std-status-"));

test("compareVersions: newer installed is re-verify, same major.minor is verified, non-semver is unverifiable", () => {
  assert.equal(compareVersions("flutter 3.47.7", "3.48.0"), "re-verify");
  assert.equal(compareVersions("3.47.7", "3.47.9"), "verified");
  assert.equal(compareVersions("3.47.7", "3.46.1"), "verified");
  assert.equal(compareVersions("2026-11", "x"), "unverifiable");
  assert.equal(compareVersions("GA4", "GA4"), "unverifiable");
  assert.equal(compareVersions("GitHub (date-versioned)", "3.1.0"), "unverifiable");
  assert.equal(compareVersions("3.47.7", ">=3.50.1"), "re-verify");
  assert.equal(compareVersions(null, "3.1.0"), "unverifiable");
});

test("rowStatus: review and none rows are unchecked; no version in use is unverifiable with the reason", () => {
  const base = { version: "acme 1.2.0", check: { kind: "test", target: "t" } };
  assert.equal(rowStatus({ ...base, check: { kind: "review", target: null } }, "1.2.0"), "unchecked");
  assert.equal(rowStatus({ ...base, check: { kind: "none", target: null } }, null), "unchecked");
  assert.equal(rowStatus(base, null), "unverifiable");
  assert.equal(rowStatus(base, "1.2.4"), "verified");
  assert.equal(rowStatus(base, "1.3.0"), "re-verify");
});

const row = (n, extra = {}) => ({ id: `acme-tool-00${n}`, title: `row ${n}`, state: "adopted", version: "acme-tool 1.2.0", check: { kind: "test", target: "x" }, ...extra });
const std = (rows) => ({ id: "acme-tool", kind: "tool", probe: { cmd: "acme", args: ["--version"], parse: "Acme (\\S+)" }, detect: { deps: [], files: ["acme.yaml"], env: [], registries: [] }, page: { id: "acme-tool", versionProbe: "acme-tool", rows } });

function fakeUnits(n, withAcme) {
  const dir = tmp();
  const units = [];
  for (let i = 0; i < n; i++) {
    const abs = path.join(dir, `u${i}`);
    mkdirSync(abs);
    if (i < withAcme) writeFileSync(path.join(abs, "acme.yaml"), "x: 1\n");
    units.push({ workspace: "acme-ws", project: `p${i}`, rel: `u${i}`, abs });
  }
  return units;
}

test("with no versions cache every tool row is unverifiable with the stated reason", () => {
  const r = buildStandardsReport({ standards: [std([row(1), row(2, { check: { kind: "review", target: null } })])], units: fakeUnits(12, 2), sidecars: [], versions: null, now: 0 });
  assert.equal(r.ok, true);
  const s = r.standards[0];
  assert.deepEqual(s.rows.map((x) => x.status), ["unverifiable", "unchecked"]);
  assert.equal(s.rows[0].reason, "version not read (standards versions --refresh)");
  assert.equal(NO_VERSION_REASON, "version not read (standards versions --refresh)");
  assert.equal(s.detected.length, 2);
  assert.deepEqual(s.counts, { verified: 0, "re-verify": 0, unverifiable: 1, unchecked: 1 });
});

test("a newer machine version from the cache makes the row re-verify", () => {
  const versions = { at: "2026-11-15T00:00:00Z", tools: { "acme-tool": { version: "1.3.0", at: "2026-11-15T00:00:00Z" } } };
  const r = buildStandardsReport({ standards: [std([row(1)])], units: fakeUnits(12, 1), sidecars: [], versions, now: 0 });
  assert.equal(r.standards[0].rows[0].status, "re-verify");
  assert.equal(r.standards[0].versionSource, "probe");
});

test("a project lockfile version wins over the machine version", () => {
  const units = fakeUnits(12, 1);
  writeFileSync(path.join(units[0].abs, "pubspec.lock"), "sdks:\n  dart: \">=3.0.0 <4.0.0\"\n  flutter: \">=1.2.0\"\n");
  const s = std([row(1)]);
  s.probe = { cmd: "flutter", args: [], parse: "x" };
  s.page.versionProbe = "flutter";
  const versions = { at: "t", tools: { flutter: { version: "9.9.9", at: "t" } } };
  const r = buildStandardsReport({ standards: [s], units, sidecars: [], versions, now: 0 });
  assert.equal(r.standards[0].versionSource, "lockfile");
  assert.equal(r.standards[0].rows[0].status, "verified");
});

test("fewer than the floor of units is a blind scan, never zero detected", () => {
  const r = buildStandardsReport({ standards: [std([row(1)])], units: fakeUnits(3, 3), sidecars: [], versions: null, now: 0, minUnits: 10 });
  assert.equal(r.ok, false);
  assert.match(r.blind, /^only 3 units scanned/);
});

test("adopted projects come from sidecars, and a malformed block is a problem naming the file", () => {
  const sidecars = [
    { workspace: "acme-ws", project: "p0", file: "/x/p0/.sidecar.yml", standards: { adopted: [{ standard: "acme-tool", units: ["u0"], verified_on: "acme 1.2.0" }] } },
    { workspace: "acme-ws", project: "p1", file: "/x/p1/.sidecar.yml", standards: "oops" },
    { workspace: "acme-ws", project: "p2", file: "/x/p2/.sidecar.yml" },
  ];
  const r = buildStandardsReport({ standards: [std([row(1)])], units: fakeUnits(12, 1), sidecars, versions: null, now: 0 });
  assert.deepEqual(r.standards[0].adopted.map((a) => a.project), ["p0"]);
  assert.ok(r.problems.some((p) => p.includes("STANDARDS-UNREADABLE") && p.includes("/x/p1/.sidecar.yml")));
});

test("refreshVersions: an injected run is parsed and written; a failing probe is recorded, not missing", () => {
  const dir = tmp();
  const probes = {
    flutter: { cmd: "flutter", args: ["--version"], parse: "Flutter (\\S+)" },
    broken: { cmd: "nope", args: [], parse: "(\\S+)" },
  };
  const calls = [];
  const run = (cmd, args) => {
    calls.push(cmd);
    if (cmd === "nope") throw new Error("ENOENT");
    return "Flutter 3.48.0 • channel stable";
  };
  const v = refreshVersions({ probes, run, now: () => "2026-11-15T10:00:00Z" });
  assert.equal(v.tools.flutter.version, "3.48.0");
  assert.equal(v.tools.broken.version, null);
  assert.match(v.tools.broken.error, /ENOENT/);
  assert.deepEqual(calls.sort(), ["flutter", "nope"]);
  writeVersions(dir, v);
  assert.deepEqual(readVersions(dir), v);
  assert.equal(readVersions(tmp()), null);
});

test("registry: a non-mapping entry, a bad row id and a bad Checked date are problems, never drops", () => {
  const dir = tmp();
  const file = path.join(dir, "standards.yml");
  writeFileSync(file, "schema_version: 1\nstandards:\n  acme-tool:\n    kind: tool\n    page: tool/acme-tool.md\n  broken: just-a-string\n");
  const r = loadRegistry(file);
  assert.equal(r.ok, true);
  assert.ok(r.problems.some((p) => /broken/.test(p) && /not a mapping/.test(p)));
  mkdirSync(path.join(dir, "tool"));
  writeFileSync(path.join(dir, "tool", "acme-tool.md"), `---
id: acme-tool
kind: tool
---

### other-001 · wrong prefix
**State:** adopted
**Source:** s · **Version:** acme 1.0.0 · **Checked:** 14 Nov 2026
**Check:** review: x
`);
  const l = loadStandards({ standardsFile: file, standardsDir: dir });
  assert.ok(l.problems.some((p) => /other-001/.test(p) && /acme-tool-<nnn>/.test(p)));
  assert.ok(l.problems.some((p) => /Checked/.test(p) && /YYYY-MM-DD/.test(p)));
  assert.ok(l.problems.some((p) => /broken/.test(p)));
});

// ── fix round 1 ──────────────────────────────────────────────────────────────

test("F1: a global standard detects only units with code, not none or unknown toolchains", () => {
  const units = fakeUnits(12, 0).map((u, i) => ({ ...u, toolchain: i < 8 ? "npm" : i < 10 ? "none" : "unknown" }));
  const g = { id: "acme-glob", kind: "global", detect: null, page: { rows: [] } };
  const r = buildStandardsReport({ standards: [g], units, sidecars: [], versions: null, now: 0 });
  assert.equal(r.standards[0].detected.length, 8);
});

test("F2: version in use is per unit, order-independent, with each source named", () => {
  const units = fakeUnits(12, 2);
  const lock = (u, v) => writeFileSync(path.join(u.abs, "pubspec.lock"), `sdks:\n  acme-tool: ">=${v}"\n`);
  lock(units[0], "1.9.0"); // newer than the row's 1.2.0
  lock(units[1], "1.1.0");
  const s = std([row(1)]);
  const a = buildStandardsReport({ standards: [s], units, sidecars: [], versions: null, now: 0 });
  const b = buildStandardsReport({ standards: [s], units: [...units].reverse(), sidecars: [], versions: null, now: 0 });
  assert.deepEqual(a.standards[0], b.standards[0], "unit order must not change the result");
  const sd = a.standards[0];
  assert.equal(sd.projects.find((p) => p.project === "p0").rows[0].status, "re-verify");
  assert.equal(sd.projects.find((p) => p.project === "p1").rows[0].status, "verified");
  assert.equal(sd.rows[0].status, "re-verify", "standard level shows the worst");
  assert.equal(sd.projectCounts["re-verify"], 1);
  assert.equal(sd.projectCounts.verified, 1);
  assert.match(sd.projects[0].units[0].source, /^lockfile: .*pubspec\.lock$/);
});

test("F2: a unit with no lockfile falls back to the machine probe and names it", () => {
  const versions = { at: "t", tools: { "acme-tool": { version: "1.2.5", at: "t" } } };
  const r = buildStandardsReport({ standards: [std([row(1)])], units: fakeUnits(12, 1), sidecars: [], versions, now: 0 });
  assert.equal(r.standards[0].projects[0].units[0].source, "probe: acme-tool");
});

test("F3: a project naming nothing is reported unknown, not zero", () => {
  const r = buildStandardsReport({ standards: [std([row(1)])], units: fakeUnits(12, 1), sidecars: [], versions: null, now: 0, project: "nope" });
  assert.equal(r.ok, false);
  assert.equal(r.unknownProject, "nope");
});

test("F4: the report counts the sidecars it read and lists unreadable ones with the reason", () => {
  const sidecars = [{ workspace: "w", project: "p0", file: "/a/.sidecar.yml" }, { workspace: "w", project: "p1", file: "/b/.sidecar.yml", error: "unreadable sidecar: bad yaml" }];
  const r = buildStandardsReport({ standards: [std([row(1)])], units: fakeUnits(12, 1), sidecars, versions: null, now: 0 });
  assert.equal(r.sidecars_scanned, 2);
  assert.deepEqual(r.sidecars_unreadable, [{ file: "/b/.sidecar.yml", reason: "unreadable sidecar: bad yaml" }]);
  assert.ok(r.problems.some((p) => p.includes("/b/.sidecar.yml") && p.includes("bad yaml")), "reason is verbatim, not 'must be a mapping'");
  assert.ok(!r.problems.some((p) => /must be a mapping/.test(p)));
});

test("F14/F15: a service reference with no usable detect is a problem, never every-unit", () => {
  const g = { id: "acme-glob", kind: "global", service: "ghost", detect: null, page: { rows: [] } };
  const r = buildStandardsReport({ standards: [g], units: fakeUnits(12, 0).map((u) => ({ ...u, toolchain: "npm" })), sidecars: [], versions: null, now: 0, serviceDetects: null });
  assert.equal(r.standards[0].detected.length, 0);
  assert.ok(r.problems.some((p) => /acme-glob/.test(p) && /ghost/.test(p)));
});

test("refreshVersions: a capture that is not a version (\"is\") is recorded as null with the error, never stored", () => {
  const v = refreshVersions({ probes: { f: { cmd: "f", parse: "Flutter (\\S+)" } }, run: () => "Flutter is not on the path", now: () => "2026-11-15T10:00:00Z" });
  assert.equal(v.tools.f.version, null);
  assert.equal(v.tools.f.error, "probe output did not contain a version: is");
});

test("a cached non-version value is treated as not read, and the cache age is derived", async () => {
  const { usableVersion, cacheAge } = await import("../../lib/standards/versions.mjs");
  const cache = { at: "2026-11-15T07:00:00Z", tools: { flutter: { version: "is", at: "x" }, ok: { version: "3.1.0", at: "x" } } };
  assert.equal(usableVersion(cache, "flutter"), null);
  assert.equal(usableVersion(cache, "ok"), "3.1.0");
  assert.equal(cacheAge(cache, Date.parse("2026-11-15T10:00:00Z")), "3h ago");
  assert.equal(cacheAge(null), null);
});
