import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { kbCmd } from "../../cli/kb.mjs";
import { planMigrate } from "../../lib/kb/migrate.mjs";
import { readAdoptions } from "../../lib/kb/standards/adopt.mjs";
import { readSidecars } from "../../lib/kb/standards/sidecars.mjs";

const LEGACY = `# legacy
project: legacy
credentials:
  token_ref:   "doppler://acme/prd/TOKEN"   # odd spacing on purpose
standards:
  # a comment inside the block
  adopted:
    - {standard: acme-tool, units: [u0]}
after_key:   {a: 1,   b: 2}   # trailing
`;
const CURRENT = "project: current\nkb:\n  adopted:\n    - {standard: acme-tool, units: [u0]}\n";
const NONE = "project: plain\ncredentials: {x: 1}\n";
const BOTH = "project: both\nkb:\n  adopted: []\nstandards:\n  adopted: []\n";

/** A workspace holding one sidecar per entry of `sidecars` ({project: text}). */
function fixture(sidecars) {
  const root = mkdtempSync(path.join(os.tmpdir(), "kb-migrate-"));
  const files = {};
  for (const [name, text] of Object.entries(sidecars)) {
    const dir = path.join(root, "propagation", "state", name);
    mkdirSync(dir, { recursive: true });
    files[name] = path.join(dir, ".sidecar.yml");
    writeFileSync(files[name], text);
  }
  return { root, files, workspaces: [{ name: "acme-ws", root }] };
}

const allBytes = (f) => Object.values(f.files).map((x) => readFileSync(x, "utf8")).join("\u0000");

async function run(argv, f) {
  const out = [];
  const io = { log: (s) => out.push(String(s)), error: (s) => out.push(String(s)) };
  const code = await kbCmd(["migrate", ...argv], { io, workspaces: f.workspaces, integrations: {} });
  return { code, out: out.join("\n") };
}

test("safety: kb migrate without --apply leaves every sidecar byte unchanged, for each flag it combines with", async () => {
  const f = fixture({ legacy: LEGACY, current: CURRENT, plain: NONE, both: BOTH });
  const before = allBytes(f);
  for (const argv of [[], ["--json"]]) {
    const r = await run(argv, f);
    assert.equal(allBytes(f), before, `kb migrate ${argv.join(" ")} without --apply must not touch a sidecar`);
    assert.equal(r.code, 1, "the both-keys sidecar is a conflict");
  }
});

test("dry run over a tree with one legacy sidecar names it and exits 0", async () => {
  const f = fixture({ legacy: LEGACY, current: CURRENT, plain: NONE });
  const before = allBytes(f);
  const r = await run([], f);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /would rename standards: -> kb:/);
  assert.ok(r.out.includes(f.files.legacy));
  assert.equal(allBytes(f), before);
});

test("--apply rewrites exactly the sidecar that has standards:, renaming only the key", async () => {
  const f = fixture({ legacy: LEGACY, current: CURRENT, plain: NONE });
  const others = { current: readFileSync(f.files.current, "utf8"), plain: readFileSync(f.files.plain, "utf8") };
  const r = await run(["--apply", "--json"], f);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(JSON.parse(r.out).written, [f.files.legacy]);
  assert.equal(readFileSync(f.files.legacy, "utf8"), LEGACY.replace("\nstandards:\n", "\nkb:\n"));
  assert.equal(readFileSync(f.files.current, "utf8"), others.current);
  assert.equal(readFileSync(f.files.plain, "utf8"), others.plain);
  assert.equal((await run([], f)).out.includes("would rename"), false, "a second run has nothing left");
  assert.equal((await run(["--apply"], f)).code, 0);
});

test("a sidecar with both keys is a conflict naming the file; --apply leaves it and still migrates the others", async () => {
  const f = fixture({ legacy: LEGACY, both: BOTH });
  const bothBefore = readFileSync(f.files.both, "utf8");
  const r = await run(["--apply"], f);
  assert.equal(r.code, 1);
  assert.ok(r.out.includes(`${f.files.both}: both kb: and standards: are present; keep one (kb migrate)`), r.out);
  assert.equal(readFileSync(f.files.both, "utf8"), bothBefore);
  assert.match(readFileSync(f.files.legacy, "utf8"), /\nkb:\n/);
});

test("no workspaces is exit 2, never a clean zero", async () => {
  const r = await run([], { workspaces: [] });
  assert.equal(r.code, 2);
  assert.match(r.out, /KB_BLIND/);
});

test("nothing to migrate is exit 0", async () => {
  const f = fixture({ current: CURRENT, plain: NONE });
  assert.equal((await run([], f)).code, 0);
});

test("an unknown flag is a usage error", async () => {
  const f = fixture({ legacy: LEGACY });
  const r = await run(["--bogus"], f);
  assert.equal(r.code, 2);
  assert.equal(allBytes(f), LEGACY);
});

test("planMigrate is pure and reports an unparseable sidecar as a conflict", () => {
  const f = fixture({ legacy: LEGACY, broken: "a: [unclosed\n" });
  const before = allBytes(f);
  const plan = planMigrate(Object.values(f.files));
  assert.deepEqual(plan.changes, [{ file: f.files.legacy, from: "standards", to: "kb" }]);
  assert.equal(plan.conflicts.length, 1);
  assert.ok(plan.conflicts[0].includes(f.files.broken));
  assert.equal(allBytes(f), before);
});

test("readSidecars returns the block from either key and says which one", () => {
  const f = fixture({ legacy: LEGACY, current: CURRENT, plain: NONE, both: BOTH });
  const by = Object.fromEntries(readSidecars(f.workspaces).map((s) => [s.project, s]));
  assert.equal(by.legacy.key, "standards");
  assert.equal(by.current.key, "kb");
  assert.deepEqual(by.legacy.standards.adopted, by.current.standards.adopted);
  assert.equal(by.plain.key, null);
  assert.equal(by.plain.standards, undefined);
  assert.match(by.both.error, /both kb: and standards: are present; keep one \(kb migrate\)/);
});

test("readAdoptions reads kb: as it reads standards:, and refuses both keys with the exact message", () => {
  const f = fixture({ legacy: LEGACY, current: CURRENT, both: BOTH });
  assert.deepEqual(readAdoptions(f.files.current), readAdoptions(f.files.legacy));
  assert.deepEqual(readAdoptions(f.files.both), { error: `${f.files.both}: both kb: and standards: are present; keep one (kb migrate)` });
});
