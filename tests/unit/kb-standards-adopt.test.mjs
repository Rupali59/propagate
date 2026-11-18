import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "yaml";
import { standardsCmd } from "../../cli/kb.mjs";
import { readAdoptions } from "../../lib/kb/standards/adopt.mjs";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "std-adopt-"));

const SIDECAR = `# sidecar for p0
project: p0
repo_root: /nowhere/p0
credentials:
  # kept exactly as written
  token_ref:   "doppler://acme/prd/TOKEN"   # odd spacing on purpose
  other: [a,   b]
`;

/** A hub with one tool standard, 12 units (project p0 owns u0, which holds acme.yaml), and a workspace holding p0's sidecar. */
function fixture({ sidecar = SIDECAR } = {}) {
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
**Check:** test: npm run t:waits
**Fails when:** the cap is gone

### acme-tool-002 · Pin the lockfile
**State:** adopted
**Source:** s
**Check:** review: reviewer confirms
`);
  const units = [];
  for (let i = 0; i < 12; i++) {
    const abs = path.join(dir, `u${i}`);
    mkdirSync(abs);
    if (i === 0) writeFileSync(path.join(abs, "acme.yaml"), "x: 1\n");
    units.push({ workspace: "acme-ws", project: `p${i}`, rel: `u${i}`, abs });
  }
  const root = path.join(dir, "ws");
  const sdir = path.join(root, "propagation", "state", "p0");
  mkdirSync(sdir, { recursive: true });
  const sidecarFile = path.join(sdir, ".sidecar.yml");
  if (sidecar !== null) writeFileSync(sidecarFile, sidecar);
  return {
    dir,
    units,
    sidecarFile,
    workspaces: [{ name: "acme-ws", root }],
    integrations: { kbStandardsFile: path.join(dir, "standards.yml"), kbStandardsDir: dir, servicesFile: null },
  };
}

function run(argv, f, extra = {}) {
  const out = [];
  const err = [];
  const io = { log: (s) => out.push(String(s)), error: (s) => err.push(String(s)) };
  const inject = { io, stateDirPath: tmp(), sidecars: [], integrations: f.integrations, units: f.units, workspaces: f.workspaces, by: "tester", now: () => Date.parse("2026-11-16T10:00:00Z"), ...extra };
  return standardsCmd(argv, inject).then((code) => ({ code, out: out.join("\n"), err: err.join("\n") }));
}

const bytes = (f) => readFileSync(f.sidecarFile, "utf8");

test("adopt dry run leaves the sidecar bytes identical and prints the rows and the checks it would run", async () => {
  const f = fixture();
  const before = bytes(f);
  const r = await run(["adopt", "acme-tool", "p0"], f);
  assert.equal(r.code, 0, r.err);
  assert.equal(bytes(f), before, "a dry run must not touch the sidecar");
  assert.match(r.out, /dry run/);
  assert.match(r.out, /acme-tool-001/);
  assert.match(r.out, /acme-tool-002/);
  assert.match(r.out, /npm run t:waits/);
  assert.match(r.out, /u0/);
});

test("adopt --apply writes standards.adopted[0] and leaves credentials: byte for byte", async () => {
  const f = fixture();
  const r = await run(["adopt", "acme-tool", "p0", "--evidence", "t:waits exit 0", "--apply"], f);
  assert.equal(r.code, 0, r.err);
  const after = bytes(f);
  assert.ok(after.startsWith(SIDECAR), "every original byte is kept, unchanged and in place");
  const doc = yaml.parse(after);
  assert.equal(doc.standards.adopted.length, 1);
  const a = doc.standards.adopted[0];
  assert.equal(a.standard, "acme-tool");
  assert.deepEqual(a.units, ["u0"]);
  assert.equal(String(a.since), "2026-11-16");
  assert.equal(a.by, "tester");
  assert.equal(a.evidence, "t:waits exit 0");
  assert.ok("verified_on" in a);
  assert.deepEqual(doc.credentials, yaml.parse(SIDECAR).credentials);
});

test("adopting again is idempotent: one entry, refreshed verified_on, other keys untouched", async () => {
  const f = fixture();
  await run(["adopt", "acme-tool", "p0", "--apply"], f);
  const first = yaml.parse(bytes(f)).standards.adopted[0];
  const later = Date.parse("2026-12-01T10:00:00Z");
  const stateDirPath = tmp();
  mkdirSync(path.join(stateDirPath, "standards"));
  writeFileSync(path.join(stateDirPath, "standards", "versions.json"), JSON.stringify({ at: "t", tools: { "acme-tool": { version: "1.3.0", at: "t" } } }));
  const r = await run(["adopt", "acme-tool", "p0", "--apply"], f, { now: () => later, by: "someone-else", stateDirPath });
  assert.equal(r.code, 0, r.err);
  const doc = yaml.parse(bytes(f));
  assert.equal(doc.standards.adopted.length, 1);
  assert.equal(String(doc.standards.adopted[0].since), String(first.since), "since is the first adoption");
  assert.equal(doc.standards.adopted[0].by, first.by, "by is the first adopter");
  assert.notEqual(doc.standards.adopted[0].verified_on, first.verified_on, "verified_on is refreshed");
  assert.equal(doc.standards.adopted[0].verified_on, "acme-tool 1.3.0");
  assert.ok(bytes(f).startsWith(SIDECAR));
  assert.match(r.out, /refresh/);
});

test("--units overrides the detected units", async () => {
  const f = fixture();
  await run(["adopt", "acme-tool", "p0", "--units", "u0,u5", "--apply"], f);
  assert.deepEqual(yaml.parse(bytes(f)).standards.adopted[0].units, ["u0", "u5"]);
});

test("adopt --apply with no gh identity is exit 2 STANDARDS_IDENTITY_UNKNOWN and writes nothing", async () => {
  const f = fixture();
  const before = bytes(f);
  const r = await run(["adopt", "acme-tool", "p0", "--apply", "--json"], f, { by: () => null });
  assert.equal(r.code, 2);
  assert.equal(JSON.parse(r.out).code, "STANDARDS_IDENTITY_UNKNOWN");
  assert.equal(bytes(f), before);
});

for (const verb of ["decline", "remove"]) {
  test(`${verb} --apply is exit 2 STANDARDS_APPROVAL_UNAVAILABLE and the bytes are unchanged`, async () => {
    // decline needs a standard NOT adopted; remove needs one that is.
    const f = fixture({ sidecar: verb === "remove" ? `${SIDECAR}standards:\n  adopted:\n    - {standard: acme-tool, units: [u0], since: 2026-11-01, by: tester, verified_on: "acme-tool 1.2.0"}\n` : SIDECAR });
    const before = bytes(f);
    const r = await run([verb, "acme-tool", "p0", "--reason", "not a fit", "--apply", "--json"], f);
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.out).code, "STANDARDS_APPROVAL_UNAVAILABLE");
    assert.match(JSON.parse(r.out).what, /approvals are built in standards slice S4/);
    assert.equal(bytes(f), before);
  });

  test(`${verb} dry run prints what would be recorded and writes nothing`, async () => {
    // decline needs a standard NOT adopted; remove needs one that is.
    const f = fixture({ sidecar: verb === "remove" ? `${SIDECAR}standards:\n  adopted:\n    - {standard: acme-tool, units: [u0], since: 2026-11-01, by: tester, verified_on: "acme-tool 1.2.0"}\n` : SIDECAR });
    const before = bytes(f);
    const r = await run([verb, "acme-tool", "p0", "--reason", "not a fit"], f);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /dry run/);
    assert.match(r.out, /not a fit/);
    assert.match(r.out, new RegExp(verb === "decline" ? "declined" : "removed"));
    assert.equal(bytes(f), before);
  });

  test(`${verb} without --reason is exit 2 STANDARDS_USAGE`, async () => {
    const f = fixture();
    const r = await run([verb, "acme-tool", "p0", "--json"], f);
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.out).code, "STANDARDS_USAGE");
  });
}

test("readAdoptions: a malformed standards: block is {error}; no block is empty; a good block is read", () => {
  const f = fixture({ sidecar: `${SIDECAR}standards: [oops]\n` });
  const bad = readAdoptions(f.sidecarFile);
  assert.ok(bad.error, JSON.stringify(bad));
  writeFileSync(f.sidecarFile, `${SIDECAR}standards:\n  adopted: notalist\n`);
  assert.ok(readAdoptions(f.sidecarFile).error);
  writeFileSync(f.sidecarFile, SIDECAR);
  assert.deepEqual(readAdoptions(f.sidecarFile), { adopted: [], overrides: [], declined: [], removed: [], reviews: [], local_page: null });
  writeFileSync(f.sidecarFile, `${SIDECAR}standards:\n  adopted:\n    - {standard: acme-tool, units: [u0]}\n  local_page: docs/x.md\n`);
  const ok = readAdoptions(f.sidecarFile);
  assert.equal(ok.adopted[0].standard, "acme-tool");
  assert.equal(ok.local_page, "docs/x.md");
});

test("adopt on a project with a malformed standards: block refuses and writes nothing", async () => {
  const f = fixture({ sidecar: `${SIDECAR}standards: [oops]\n` });
  const before = bytes(f);
  const r = await run(["adopt", "acme-tool", "p0", "--apply", "--json"], f);
  assert.equal(r.code, 2);
  assert.equal(JSON.parse(r.out).code, "STANDARDS_UNREADABLE");
  assert.equal(bytes(f), before);
});

test("a project with no sidecar is exit 2 STANDARDS_PROJECT_UNKNOWN naming the expected path", async () => {
  const f = fixture({ sidecar: null });
  const r = await run(["adopt", "acme-tool", "p0", "--json"], f);
  assert.equal(r.code, 2);
  const j = JSON.parse(r.out);
  assert.equal(j.code, "STANDARDS_PROJECT_UNKNOWN");
  assert.ok(j.what.includes(f.sidecarFile), j.what);
});

test("an unknown standard, a missing argument and an unknown flag are exit 2", async () => {
  const f = fixture();
  assert.equal(JSON.parse((await run(["adopt", "nope", "p0", "--json"], f)).out).code, "STANDARDS_UNKNOWN");
  assert.equal(JSON.parse((await run(["adopt", "acme-tool", "--json"], f)).out).code, "STANDARDS_USAGE");
  assert.equal(JSON.parse((await run(["adopt", "acme-tool", "p0", "--bogus", "--json"], f)).out).code, "STANDARDS_USAGE");
});

test("only the standards: block is rewritten: keys before and after it keep their bytes", async () => {
  const tail = "after_key:   {a: 1,   b: 2}   # trailing\n";
  const f = fixture({ sidecar: `${SIDECAR}standards:\n  adopted: []\n  local_page: docs/x.md\n${tail}` });
  const r = await run(["adopt", "acme-tool", "p0", "--apply"], f);
  assert.equal(r.code, 0, r.err);
  const after = bytes(f);
  assert.ok(after.startsWith(SIDECAR));
  assert.ok(after.endsWith(tail), after);
  const doc = yaml.parse(after);
  assert.equal(doc.standards.adopted[0].standard, "acme-tool");
  assert.equal(doc.standards.local_page, "docs/x.md");
});

test("decline of an adopted standard, and remove of one never adopted, are exit 2", async () => {
  const adopted = fixture({ sidecar: `${SIDECAR}standards:\n  adopted:\n    - {standard: acme-tool, units: [u0]}\n` });
  assert.equal(JSON.parse((await run(["decline", "acme-tool", "p0", "--reason", "x", "--json"], adopted)).out).code, "STANDARDS_ALREADY_ADOPTED");
  const none = fixture();
  assert.equal(JSON.parse((await run(["remove", "acme-tool", "p0", "--reason", "x", "--json"], none)).out).code, "STANDARDS_NOT_ADOPTED");
});

test("a reviews: list beside adopted is read, and survives an adopt --apply (Task 6b needs no schema change)", async () => {
  const rev = "  reviews:\n    - {row: acme-tool-002, by: tester, on: 2026-11-10}\n";
  const f = fixture({ sidecar: `${SIDECAR}standards:\n  adopted: []\n${rev}` });
  assert.equal(readAdoptions(f.sidecarFile).reviews[0].row, "acme-tool-002");
  await run(["adopt", "acme-tool", "p0", "--apply"], f);
  const doc = yaml.parse(bytes(f));
  assert.equal(doc.standards.reviews[0].row, "acme-tool-002");
  assert.equal(doc.standards.adopted.length, 1);
});

/** Two workspaces that each hold a project called `shared`, each with its own acme.yaml unit and its own sidecar. */
function twoWorkspaces() {
  const f = fixture();
  const rootB = path.join(f.dir, "wsb");
  const sidecars = [f.sidecarFile];
  const add = (root, name, dirName, project) => {
    const sdir = path.join(root, "propagation", "state", dirName);
    mkdirSync(sdir, { recursive: true });
    const file = path.join(sdir, ".sidecar.yml");
    writeFileSync(file, `project: ${project}\nrepo_root: /nowhere/${name}\n`);
    sidecars.push(file);
  };
  add(f.workspaces[0].root, "acme-ws", "shared", "shared");
  add(rootB, "ws-b", "shared", "shared");
  // a sidecar whose directory name differs from its project: field
  add(rootB, "ws-b", "dirname-differs", "renamed");
  for (const [ws, rel] of [["acme-ws", "shared-unit"], ["ws-b", "b-unit"], ["ws-b", "r-unit"]]) {
    const abs = path.join(f.dir, rel);
    mkdirSync(abs);
    writeFileSync(path.join(abs, "acme.yaml"), "x: 1\n");
    f.units.push({ workspace: ws, project: rel === "r-unit" ? "renamed" : "shared", rel, abs });
  }
  f.workspaces.push({ name: "ws-b", root: rootB });
  f.allSidecars = sidecars;
  return f;
}
const snapshot = (f) => f.allSidecars.map((x) => readFileSync(x, "utf8")).join("\n--\n");

test("an ambiguous bare project name is refused with exit 2 and writes no sidecar at all", async () => {
  const f = twoWorkspaces();
  const before = snapshot(f);
  for (const argv of [["adopt", "acme-tool", "shared"], ["adopt", "acme-tool", "shared", "--apply"], ["decline", "acme-tool", "shared", "--reason", "r"], ["remove", "acme-tool", "shared", "--reason", "r"]]) {
    const r = await run(argv, f);
    assert.equal(r.code, 2, argv.join(" "));
    assert.match(r.err, /STANDARDS_PROJECT_AMBIGUOUS/);
    assert.match(r.err, /acme-ws\/shared/);
    assert.match(r.err, /ws-b\/shared/);
    assert.equal(snapshot(f), before, `${argv.join(" ")} must write no sidecar`);
  }
});

test("a qualified <workspace>/<project> targets that workspace's sidecar and its units only", async () => {
  const f = twoWorkspaces();
  const r = await run(["adopt", "acme-tool", "ws-b/shared", "--apply"], f);
  assert.equal(r.code, 0, r.err);
  const bFile = f.allSidecars[2];
  const doc = yaml.parse(readFileSync(bFile, "utf8"));
  assert.deepEqual(doc.standards.adopted[0].units, ["b-unit"], "units come from ws-b only, not acme-ws/shared-unit");
  assert.equal(doc.standards.adopted[0].standard, "acme-tool");
  assert.equal(yaml.parse(readFileSync(f.allSidecars[1], "utf8")).standards, undefined, "the other workspace's `shared` sidecar is untouched");
  assert.equal(readFileSync(f.sidecarFile, "utf8"), SIDECAR);
});

test("a project resolves by the sidecar's `project:` field, not by its directory name", async () => {
  const f = twoWorkspaces();
  const r = await run(["adopt", "acme-tool", "renamed", "--apply"], f);
  assert.equal(r.code, 0, r.err);
  const doc = yaml.parse(readFileSync(f.allSidecars[3], "utf8"));
  assert.deepEqual(doc.standards.adopted[0].units, ["r-unit"]);
  const r2 = await run(["adopt", "acme-tool", "dirname-differs"], f);
  assert.equal(r2.code, 2);
  assert.match(r2.err, /STANDARDS_PROJECT_UNKNOWN/);
});
