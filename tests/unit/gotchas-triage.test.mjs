/**
 * Gotcha triage (propagate #216): `statusOf`, the unknown-Status warning, `allEntries`, and the
 * `gotchas.untriaged` ratchet. The guard's skip is tested through stdin/stdout in
 * hooks/gotcha-guard.test.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { statusOf, allEntries, selftestWarnings, untriagedGauge, STATUS_STATES } from "../../lib/gotchas/parse.mjs";
import { EXPECTATIONS, GOTCHAS_UNTRIAGED_BASELINE as BASE, evaluateExpectations } from "../../lib/report/metrics.mjs";

const entry = (status) => ({ rawBody: `body\n${status === null ? "" : `**Status:** ${status}\n`}**Instead:** x\n` });

test("statusOf reads each of the four values and the ref after the dash / by / date", () => {
  assert.deepEqual(statusOf(entry("live")), { state: "live", ref: "" });
  assert.deepEqual(statusOf(entry("resolved — commit abc123, hooks/x.mjs:12")), { state: "resolved", ref: "commit abc123, hooks/x.mjs:12" });
  assert.deepEqual(statusOf(entry("superseded by G80")), { state: "superseded", ref: "G80" });
  assert.deepEqual(statusOf(entry("retired 2026-11-09 — superseded by G80: loads in place (#226)")), {
    state: "retired",
    ref: "superseded by G80: loads in place (#226)",
  });
  assert.deepEqual(STATUS_STATES, ["live", "resolved", "superseded", "retired"]);
});

test("statusOf is null when the line is absent, and reports an unknown value as unknown (not as a state)", () => {
  assert.equal(statusOf(entry(null)), null);
  assert.equal(statusOf({}), null);
  assert.deepEqual(statusOf(entry("done")), { state: "unknown", ref: "done" });
  assert.deepEqual(statusOf(entry("")), { state: "unknown", ref: "" });
});

test("statusOf only reads a label LINE, not the word Status in prose", () => {
  assert.equal(statusOf({ rawBody: "the **Status:** line is described here, mid-sentence\n" }), null);
});

test("selftestWarnings flags an unknown Status value, and stays quiet for the four good ones", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "triage-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const mk = (id, st) => `### ${id} · t\n**Trigger:** \`x${id}\`\n**Status:** ${st}\n**Instead:** y\n`;
  const f = path.join(dir, "GOTCHAS.md");
  await writeFile(f, [mk("A1", "live"), mk("A2", "resolved — c"), mk("A3", "superseded by A1"), mk("A4", "retired 2026-11-09 — c"), mk("A5", "finished")].join("\n"));
  const w = selftestWarnings([f]).filter((x) => /Status/.test(x));
  assert.equal(w.length, 1, w.join("\n"));
  assert.match(w[0], /A5 has an unknown \*\*Status:\*\* value "finished"/);
});

test("allEntries returns triggerless entries too, each with its status", () => {
  const text = "# t\n### G1 · a\n**Trigger:** `x`\n**Status:** live\n\n### 1.1 numbered, no trigger\nbody\n\n### G2 · c\n**Status:** retired 2026-11-09 — z\n";
  const es = allEntries(text);
  assert.deepEqual(es.map((e) => e.id), ["G1", "1.1", "G2"]);
  assert.deepEqual(es.map((e) => e.status?.state ?? null), ["live", null, "retired"]);
});

// ---- the ratchet ---------------------------------------------------------------------------

const exp = EXPECTATIONS.find((e) => e.key === "gotchas.untriaged");

test("the gotchas.untriaged expectation exists (renaming it is this test's alarm)", () => {
  assert.ok(exp);
  assert.equal(typeof BASE, "number");
});

test("ratchet: baseline holds, +1 fails as GREW, a drop holds", () => {
  assert.equal(exp.assert({ "gotchas.untriaged": BASE }), true);
  assert.equal(exp.assert({ "gotchas.untriaged": BASE + 1 }), false, "one more untriaged entry must fail");
  assert.match(exp.detail({ "gotchas.untriaged": BASE + 1 }, {}), /GREW/);
  assert.equal(exp.assert({ "gotchas.untriaged": BASE - 10 }), true, "triage progress must hold");
  assert.equal(exp.assert({ "gotchas.untriaged": 0 }), true, "a real zero holds");
});

test("ratchet: null FAILS with 'could not run', never passes as zero", () => {
  // FAILING INPUT for the `?? 0` mutation: the sibling ratchets would pass this.
  assert.equal(exp.assert({ "gotchas.untriaged": null }), false);
  assert.equal(exp.assert({}), false, "an absent key is not a count either");
  assert.match(exp.detail({ "gotchas.untriaged": null }, {}), /^could not run: /);
  assert.match(exp.detail({ "gotchas.untriaged": null }, { gotchasUntriagedReason: "1 register(s) unreadable" }), /could not run: 1 register\(s\) unreadable/);
});

test("walk ran and found ZERO registers: the gauge is 0 and the expectation PASSES (a fresh install)", () => {
  // FAILING INPUT for the 'zero registers returns null' mutation (the stranger-install gate's shape).
  const g = untriagedGauge([], { globalIndex: "/no/such/global.md" });
  assert.deepEqual(g, { count: 0, registers: 0, reason: null });
  assert.equal(exp.assert({ "gotchas.untriaged": g.count }), true);
});

test("an unreadable register makes the gauge null with a reason, and the expectation fails 'could not run'", () => {
  const g = untriagedGauge(["/no/such/register/GOTCHAS.md"], { globalIndex: "/no/such/global.md" });
  assert.equal(g.count, null);
  assert.match(g.reason, /1 register\(s\) unreadable/);
  const v = evaluateExpectations({ "gotchas.untriaged": g.count }, [exp], { gotchasUntriagedReason: g.reason });
  assert.equal(v.length, 1);
  assert.match(v[0].detail, /could not run: 1 register\(s\) unreadable/);
});

test("the walk did not run: null fails 'could not run'", () => {
  const v = evaluateExpectations({ "gotchas.untriaged": null }, [exp], { gotchasUntriagedReason: "the doc walk did not run" });
  assert.equal(v.length, 1);
  assert.match(v[0].detail, /could not run: the doc walk did not run/);
});
