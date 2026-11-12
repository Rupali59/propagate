// check-curator — the deterministic gate on doc-curator's claims (propagate#251). One failing fixture per
// clause, built from literals written to a temp dir, so removing a clause turns exactly its test red.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkCurator } from "../../scripts/check-curator.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "check-curator.mjs");
const dir = mkdtempSync(path.join(os.tmpdir(), "check-curator-"));
writeFileSync(path.join(dir, "doc.md"), "# Doc\n\nRun `tool --old-flag` to start.\nThis doc is orphaned.\n");
writeFileSync(path.join(dir, "code.txt"), "line one\nflag: --new-flag\nline three\nline four\nline five\nline six\nline seven\n");
const io = { readFile: (p) => readFileSync(p, "utf8"), exists: (p) => existsSync(p) };

const claim = (over = {}) => ({
  path: "doc.md",
  claim: "stale",
  statement: "Run `tool --old-flag` to start.",
  evidence: { quote: "flag: --new-flag", file: "code.txt", line: 2 },
  ...over,
});
const check = (claims) => checkCurator({ root: dir, claims }, io);
const refusedWith = (r, re) => r.refused.some((x) => x.reasons.some((m) => re.test(m)));

test("a valid claim passes and is INFERRED, never applied", () => {
  const r = check([claim()]);
  assert.equal(r.ok, true);
  assert.equal(r.inferred[0].status, "INFERRED");
});

test("path that does not exist is refused", () => {
  const r = check([claim({ path: "nope.md" })]);
  assert.equal(r.ok, false);
  assert.ok(refusedWith(r, /path does not exist/));
});

test("evidence.file that does not exist is refused", () => {
  const r = check([claim({ evidence: { quote: "x", file: "nope.txt", line: 1 } })]);
  assert.ok(refusedWith(r, /evidence\.file does not exist/));
});

test("quote not on the file at that line is refused", () => {
  const r = check([claim({ evidence: { quote: "flag: --new-flag", file: "code.txt", line: 7 } })]);
  assert.ok(refusedWith(r, /evidence\.quote is not on/));
});

test("quote may span from the line onward, up to 5 lines", () => {
  assert.equal(check([claim({ evidence: { quote: "flag: --new-flag\nline three", file: "code.txt", line: 2 } })]).ok, true);
});

test("claim other than stale/current is refused", () => {
  const r = check([claim({ claim: "probably stale" })]);
  assert.ok(refusedWith(r, /exactly "stale" or "current"/));
});

test("structural claim is refused and names curate-docs", () => {
  const r = check([claim({ statement: "This doc is orphaned." })]);
  assert.ok(refusedWith(r, /structural: re-derive with curate-docs/));
  assert.ok(refusedWith(r, /curate-docs\/cli\.mjs/));
});

test("missing statement is refused", () => {
  const r = check([claim({ statement: undefined })]);
  assert.ok(refusedWith(r, /no statement/));
});

test("statement not found in the doc is refused", () => {
  const r = check([claim({ statement: "A sentence the doc never says." })]);
  assert.ok(refusedWith(r, /statement is not found in the doc/));
});

test("empty claims list is not a pass", () => {
  const r = check([]);
  assert.equal(r.ok, false);
  assert.match(r.error, /nothing proposed/);
});

test("CLI exit codes: 0 pass, 1 refused, 1 empty, 2 unreadable", () => {
  const run = (obj) => {
    const f = path.join(dir, "p.json");
    writeFileSync(f, typeof obj === "string" ? obj : JSON.stringify(obj));
    return spawnSync(process.execPath, [SCRIPT, f], { encoding: "utf8" }).status;
  };
  assert.equal(run({ root: dir, claims: [claim()] }), 0);
  assert.equal(run({ root: dir, claims: [claim({ claim: "x" })] }), 1);
  assert.equal(run({ root: dir, claims: [] }), 1);
  assert.equal(run("not json"), 2);
  assert.equal(run({ nope: 1 }), 2);
});
