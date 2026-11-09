/**
 * `propagate context` — gotcha-guard injection volume per compaction window (propagate #225).
 *
 * The transcript is built literally, one JSONL line per record, so the cases that matter reach the
 * counter exactly as written: the `hook_system_message` twin that must NOT be counted, a non-gotcha
 * `hook_additional_context`, an attachment holding two showings, and a compact_boundary between them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { gotchaContextByWindow } from "../../lib/report/context.mjs";
import { contextCmd } from "../../cli/context.mjs";

const ctx = (...strings) => ({ attachment: { type: "hook_additional_context", content: strings } });
const sysmsg = (s) => ({ attachment: { type: "hook_system_message", content: s } });
const boundary = { type: "system", subtype: "compact_boundary" };

const ONE = "gotcha · G1 · one\n  **Instead:** x\n  full entry: f#G1\n";
const TWO = "gotcha · G2 · two\n  body\n\ngotcha · G3 · three\n  body\n";

const RECORDS = [
  ctx(ONE),
  sysmsg(ONE), // the twin: costs no context, must not be counted
  ctx("You are in explanatory mode"), // another hook's context: not a gotcha
  boundary,
  ctx(TWO),
  ctx(ONE),
];

test("counts injections, showings and chars per window, from hook_additional_context only", () => {
  const r = gotchaContextByWindow(RECORDS);
  assert.deepEqual(r.windows, [
    { window: 1, injections: 1, showings: 1, chars: ONE.length },
    { window: 2, injections: 2, showings: 3, chars: TWO.length + ONE.length },
  ]);
  assert.deepEqual(r.total, { injections: 3, showings: 4, chars: TWO.length + 2 * ONE.length });
  assert.equal(r.additionalContextRecords, 4);
});

test("a `gotcha · ` in the middle of a line is not a showing", () => {
  const r = gotchaContextByWindow([ctx("the text says gotcha · here but is not a header")]);
  assert.equal(r.total.showings, 0);
});

test("the command reports a transcript file, as text and as JSON", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ctx-test-"));
  try {
    const file = path.join(dir, "t.jsonl");
    writeFileSync(file, RECORDS.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const lines = [];
    assert.equal(await contextCmd(["--transcript", file], { out: (s) => lines.push(s) }), 0);
    assert.match(lines.join("\n"), /total\s+3\s+4\s+/);
    const j = [];
    await contextCmd(["--transcript", file, "--json"], { out: (s) => j.push(s) });
    assert.equal(JSON.parse(j.join("")).total.showings, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("could-not-run is exit 2 with a reason, never a clean zero", async () => {
  const errs = [];
  assert.equal(await contextCmd([], { err: (s) => errs.push(s) }), 2);
  assert.match(errs.join("\n"), /--transcript/);
  assert.equal(await contextCmd(["--transcript", "/no/such/file.jsonl"], { err: (s) => errs.push(s) }), 2);
  const dir = mkdtempSync(path.join(os.tmpdir(), "ctx-test-"));
  try {
    const file = path.join(dir, "garbage.jsonl");
    writeFileSync(file, "not json\nalso not json\n");
    assert.equal(await contextCmd(["--transcript", file], { err: (s) => errs.push(s) }), 2);
    assert.match(errs.join("\n"), /gone blind/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
