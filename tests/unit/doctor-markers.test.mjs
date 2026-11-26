/**
 * doctor-markers.test.mjs — propagate#295 (glance PR2, T-D1/T-D2): the `human` and `check_id` doctor markers.
 *
 * Doctor's JSON is a function of its rendered text (lib/report/doctor/structure.mjs), so a marker kept only on the
 * Reporter entry would be dropped at the seam. These tests drive the REAL renderer (cli.mjs renderDoctorEntries) and
 * parse its output back, the way the E5 action test does: a test that writes the marker by hand proves the parser and
 * not the pipeline.
 *
 * Run: PROPAGATE_STATE_DIR="$(mktemp -d)" node --test tests/unit/doctor-markers.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyLine, toSections, marksSuffix, MARK } from "../../lib/report/doctor/structure.mjs";
import { Reporter } from "../../lib/report/doctor/reporter.mjs";

async function rendered(build) {
  const { renderDoctorEntries } = await import("../../cli/doctor.mjs");
  const r = new Reporter();
  r.header("Checks");
  build(r);
  const out = [];
  const real = console.log;
  console.log = (...a) => { out.push(a.join(" ")); };
  try { renderDoctorEntries(r.drain()); } finally { console.log = real; }
  return { out, entries: toSections(out)[0].entries };
}

test("T-D1: human and check_id survive render -> parse, with and without an action", async () => {
  const { entries } = await rendered((r) => {
    r.check("token expires soon", false, "rotate it by hand", undefined, { human: true, check_id: "auth.token" });
    r.check("ledger readable", false, "2 rows", { kind: "command", target: "propagate doctor --full" }, { check_id: "ledger.read" });
    r.warn("scheduled job needs attention", "job-a: last exit code 1", { check_id: "jobs.job-a" });
    r.check("plain", true, "no marks");
  });
  const by = Object.fromEntries(entries.map((e) => [e.label, e]));
  assert.equal(by["token expires soon"].human, true);
  assert.equal(by["token expires soon"].check_id, "auth.token");
  assert.equal(by["token expires soon"].detail, "rotate it by hand", "the marker is not left glued to the detail");
  assert.equal(by["ledger readable"].check_id, "ledger.read");
  assert.equal(by["ledger readable"].human, undefined, "human is OMITTED when not set, never false");
  assert.deepEqual(by["ledger readable"].action, { kind: "command", target: "propagate doctor --full" });
  assert.equal(by["ledger readable"].detail, "2 rows");
  assert.equal(by["scheduled job needs attention"].check_id, "jobs.job-a");
  assert.equal(by["plain"].check_id, undefined);
  assert.deepEqual(Object.keys(by["plain"]).sort(), ["detail", "kind", "label"], "an unmarked entry keeps its old shape");
});

test("T-D1: an entry with no marks renders byte-identically to before (no suffix)", async () => {
  const { out } = await rendered((r) => r.check("plain", false, "detail"));
  assert.ok(!out.join("\n").includes(MARK.trim()), out.join("\n"));
  assert.equal(marksSuffix(undefined), "");
  assert.equal(marksSuffix({}), "");
});

test("T-D1: marker-like text mid-line, or an unknown token, is not misread", () => {
  const mid = classifyLine(`  ✗ label  some detail${MARK}human and then more words`);
  assert.equal(mid.human, undefined);
  assert.match(mid.detail, /and then more words$/);
  const unknown = classifyLine(`  ✗ label  detail${MARK}admin`);
  assert.equal(unknown.human, undefined);
  assert.equal(unknown.check_id, undefined);
  const ok = classifyLine(`  ✗ label  detail${MARK}human id=a.b`);
  assert.equal(ok.human, true);
  assert.equal(ok.check_id, "a.b");
  assert.equal(ok.detail, "detail");
});

test("T-D1: the Reporter refuses a malformed check_id rather than rendering a marker the parser cannot read back", () => {
  const r = new Reporter();
  assert.throws(() => r.check("x", false, "", undefined, { check_id: "has space" }), /check_id/);
  assert.throws(() => r.check("x", false, "", undefined, { check_id: "" }), /check_id/);
  assert.throws(() => r.warn("x", "", { human: "yes" }), /human/);
});
