import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { standardsCmd } from "../../cli/standards.mjs";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "std-cli-"));

function hub() {
  const dir = tmp();
  mkdirSync(path.join(dir, "tool"));
  writeFileSync(path.join(dir, "standards.yml"), `schema_version: 1
standards:
  acme-tool:
    kind: tool
    page: tool/acme-tool.md
    detect: {files: [acme.yaml]}
    probe: {cmd: acme, args: ["--version"], parse: "Acme (\\\\S+)"}
`);
  writeFileSync(path.join(dir, "tool", "acme-tool.md"), `---
id: acme-tool
kind: tool
version_probe: acme-tool
---

### acme-tool-001 · Cap waits
**State:** adopted
**Source:** s · **Version:** acme-tool 1.2.0 · **Checked:** 2026-11-14
**Check:** test: t
**Fails when:** the cap is gone
`);
  const units = [];
  for (let i = 0; i < 12; i++) {
    const abs = path.join(dir, `u${i}`);
    mkdirSync(abs);
    if (i === 0) writeFileSync(path.join(abs, "acme.yaml"), "x: 1\n");
    units.push({ workspace: "acme-ws", project: `p${i}`, rel: `u${i}`, abs });
  }
  return { dir, units, integrations: { kbStandardsFile: path.join(dir, "standards.yml"), kbStandardsDir: dir, servicesFile: null } };
}

function run(argv, inject) {
  const out = [];
  const err = [];
  const io = { log: (s) => out.push(String(s)), error: (s) => err.push(String(s)) };
  return standardsCmd(argv, { io, stateDirPath: tmp(), sidecars: [], workspaces: [], ...inject }).then((code) => ({ code, out: out.join("\n"), err: err.join("\n") }));
}

test("standards --json: exit 0 with the report", async () => {
  const h = hub();
  const r = await run(["--json"], { integrations: h.integrations, units: h.units });
  assert.equal(r.code, 0);
  const j = JSON.parse(r.out);
  assert.equal(j.ok, true);
  assert.equal(j.standards[0].id, "acme-tool");
  assert.equal(j.standards[0].detected.length, 1);
  assert.equal(j.standards[0].rows[0].status, "unverifiable");
});

test("standards: unconfigured is exit 2 STANDARDS_NOT_CONFIGURED, as JSON and as text", async () => {
  const inject = { integrations: { kbStandardsFile: null, kbStandardsDir: null }, units: [] };
  const r = await run(["--json"], inject);
  assert.equal(r.code, 2);
  const j = JSON.parse(r.out);
  assert.equal(j.ok, false);
  assert.equal(j.code, "STANDARDS_NOT_CONFIGURED");
  assert.ok(j.what && j.next);
  const t = await run([], inject);
  assert.equal(t.code, 2);
  assert.match(t.err, /STANDARDS_NOT_CONFIGURED/);
});

test("standards: a blind scan is exit 2 STANDARDS_BLIND, not zero detected", async () => {
  const h = hub();
  const r = await run(["--json"], { integrations: h.integrations, units: h.units.slice(0, 2) });
  assert.equal(r.code, 2);
  assert.equal(JSON.parse(r.out).code, "STANDARDS_BLIND");
});

test("standards: unknown flag, and --std naming no standard, are usage failures", async () => {
  const h = hub();
  assert.equal((await run(["--bogus"], { integrations: h.integrations, units: h.units })).code, 2);
  const r = await run(["--json", "--std", "nope"], { integrations: h.integrations, units: h.units });
  assert.equal(r.code, 2);
  assert.equal(JSON.parse(r.out).code, "STANDARDS_UNKNOWN");
});

test("standards versions --refresh writes versions.json from an injected run; no spawn happens otherwise", async () => {
  const h = hub();
  const stateDirPath = tmp();
  const run1 = () => "Acme 1.3.0 build";
  const r = await run(["versions", "--refresh", "--json"], { integrations: h.integrations, stateDirPath, run: run1 });
  assert.equal(r.code, 0);
  const file = path.join(stateDirPath, "kb", "versions.json");
  assert.ok(existsSync(file));
  assert.equal(JSON.parse(readFileSync(file, "utf8")).tools["acme-tool"].version, "1.3.0");
  // without --refresh the injected run must not be called
  let called = false;
  const r2 = await run(["versions", "--json"], { integrations: h.integrations, stateDirPath, run: () => { called = true; return ""; } });
  assert.equal(r2.code, 0);
  assert.equal(called, false);
  assert.equal(JSON.parse(r2.out).versions.tools["acme-tool"].version, "1.3.0");
  // and the cache now drives re-verify
  const r3 = await run(["--json"], { integrations: h.integrations, units: h.units, stateDirPath });
  assert.equal(JSON.parse(r3.out).standards[0].rows[0].status, "re-verify");
});

test("standards versions with no cache says so, exit 0", async () => {
  const h = hub();
  const r = await run(["versions", "--json"], { integrations: h.integrations });
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.out).versions, null);
});

test("F3: --project naming nothing is exit 2 STANDARDS_UNKNOWN_PROJECT", async () => {
  const h = hub();
  const r = await run(["--json", "--project", "nope"], { integrations: h.integrations, units: h.units });
  assert.equal(r.code, 2);
  assert.equal(JSON.parse(r.out).code, "STANDARDS_UNKNOWN_PROJECT");
});

test("F4: JSON and text both state how many sidecars were read", async () => {
  const h = hub();
  const sidecars = [{ workspace: "acme-ws", project: "p0", file: "/x/.sidecar.yml", error: "unreadable sidecar: boom" }];
  const j = JSON.parse((await run(["--json"], { integrations: h.integrations, units: h.units, sidecars })).out);
  assert.equal(j.sidecars_scanned, 1);
  assert.equal(j.sidecars_unreadable[0].reason, "unreadable sidecar: boom");
  const t = await run([], { integrations: h.integrations, units: h.units, sidecars });
  assert.match(t.out, /1 sidecar\(s\) read, 1 unreadable/);
  assert.match(t.out, /unreadable sidecar \/x\/\.sidecar\.yml: unreadable sidecar: boom/);
});

test("F5: --refresh with no probes is exit 2 STANDARDS_NO_PROBES and leaves versions.json untouched", async () => {
  const h = hub();
  writeFileSync(path.join(h.dir, "standards.yml"), "schema_version: 1\nstandards:\n  acme-tool:\n    kind: tool\n    page: tool/acme-tool.md\n    detect: {files: [acme.yaml]}\n");
  const stateDirPath = tmp();
  mkdirSync(path.join(stateDirPath, "kb"));
  const file = path.join(stateDirPath, "kb", "versions.json");
  const good = JSON.stringify({ at: "t", tools: { "acme-tool": { version: "1.0.0", at: "t" } } });
  writeFileSync(file, good);
  const r = await run(["versions", "--refresh", "--json"], { integrations: h.integrations, stateDirPath, run: () => "Acme 9.9.9" });
  assert.equal(r.code, 2);
  assert.equal(JSON.parse(r.out).code, "STANDARDS_NO_PROBES");
  assert.equal(readFileSync(file, "utf8"), good);
});

test("F14: an unreadable services.yml is a reported problem for a standard that reuses a service", async () => {
  const h = hub();
  writeFileSync(path.join(h.dir, "standards.yml"), "schema_version: 1\nstandards:\n  acme-tool:\n    kind: tool\n    page: tool/acme-tool.md\n    service: ghost\n");
  const svc = path.join(h.dir, "services.yml");
  writeFileSync(svc, "schema_version: 1\nservices: [unclosed");
  const r = await run(["--json"], { integrations: { ...h.integrations, servicesFile: svc }, units: h.units });
  const j = JSON.parse(r.out);
  assert.equal(r.code, 1);
  assert.ok(j.problems.some((p) => /services\.yml could not be read/.test(p)));
});
