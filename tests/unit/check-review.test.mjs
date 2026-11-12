// check-review — the deterministic gate on adversarial-reviewer's report (propagate#251). One failing fixture per
// clause, built as literals with injected fakes, so removing a clause turns exactly its test red.
import { test } from "node:test";
import assert from "node:assert/strict";

import { checkReview, render } from "../../scripts/check-review.mjs";

const files = { "a.md": 10 };
const env = (over = {}) => ({
  declaredEdges: ["e1", "e2"],
  exists: (f) => f in files,
  lineCount: (f) => files[f],
  runDemo: () => ({ stdout: "the defect is here\n" }),
  ...over,
});
const noRun = () => assert.fail("a refused or unverifiable demo must not run");
const finding = (over = {}) => ({ finding: "f", file: "a.md", line: 3, demo_cmd: "grep -n defect a.md", expect: "defect", ...over });
const report = (over = {}) => ({ artifact: "a.md", edges_reviewed: ["e1", "e2"], findings: [finding()], ...over });

test("pass: coverage equal as a set (order and duplicates irrelevant), finding verified", () => {
  const r = checkReview(report({ edges_reviewed: ["e2", "e1", "e1"] }), env());
  assert.equal(r.ok, true);
  assert.equal(r.verified.length, 1);
  assert.match(render("a.md", r).join("\n"), /PASS/);
});

test("coverage: a declared edge not reviewed is MISSING and fails", () => {
  const r = checkReview(report({ edges_reviewed: ["e1"] }), env());
  assert.equal(r.ok, false);
  assert.deepEqual(r.coverage.missing, ["e2"]);
});

test("coverage: a reviewed id that is not declared is EXTRA and fails", () => {
  const r = checkReview(report({ edges_reviewed: ["e1", "e2", "e9"] }), env());
  assert.equal(r.ok, false);
  assert.deepEqual(r.coverage.extra, ["e9"]);
});

test("coverage: edges_reviewed that is not an array fails", () => {
  assert.equal(checkReview({ findings: [] }, env()).ok, false);
});

test("place: a finding whose file does not exist is refuted and fails", () => {
  const r = checkReview(report({ findings: [finding({ file: "nope.md" })] }), env());
  assert.equal(r.ok, false);
  assert.match(r.refuted[0].reason, /does not exist/);
});

test("place: a line beyond the file's length is refuted and fails", () => {
  const r = checkReview(report({ findings: [finding({ line: 11 })] }), env());
  assert.equal(r.ok, false);
  assert.match(r.refuted[0].reason, /outside a\.md \(10 lines\)/);
});

test("demo: no demo_cmd or expect is UNVERIFIED: listed, not counted, does not fail", () => {
  for (const f of [finding({ demo_cmd: undefined }), finding({ expect: undefined })]) {
    const r = checkReview(report({ findings: [f] }), env({ runDemo: noRun }));
    assert.equal(r.ok, true);
    assert.equal(r.unverified.length, 1);
    assert.equal(r.verified.length, 0);
  }
});

test("read-only: a write demo is refused by the agent guard, never run, UNVERIFIED with the reason", () => {
  const r = checkReview(report({ findings: [finding({ demo_cmd: "rm -rf x" })] }), env({ runDemo: noRun }));
  assert.equal(r.ok, true);
  assert.equal(r.unverified.length, 1);
  assert.match(r.unverified[0].reason, /demo refused \(`rm` is not on the read list\)/);
  const redirect = checkReview(report({ findings: [finding({ demo_cmd: "echo x > a.md" })] }), env({ runDemo: noRun }));
  assert.match(redirect.unverified[0].reason, /redirection/);
});

test("result: a demo whose stdout does not match expect is REFUTED and fails", () => {
  const r = checkReview(report({ findings: [finding({ expect: "something else" })] }), env());
  assert.equal(r.ok, false);
  assert.equal(r.refuted.length, 1);
  assert.match(r.refuted[0].reason, /did not match/);
});

test("timeout: a demo that timed out is UNVERIFIED, not a pass", () => {
  const r = checkReview(report(), env({ runDemo: () => ({ stdout: "defect", timedOut: true }) }));
  assert.equal(r.verified.length, 0);
  assert.match(r.unverified[0].reason, /timed out/);
});

test("vacuous: 0 declared edges is not complete, and fails unless --allow-undeclared", () => {
  const rep = report({ edges_reviewed: [], findings: [] });
  const r = checkReview(rep, env({ declaredEdges: [] }));
  assert.equal(r.ok, false);
  assert.equal(r.coverage.vacuous, true);
  assert.match(render("a.md", r).join("\n"), /0 edges declared: coverage is vacuous, not complete/);
  assert.equal(checkReview(rep, env({ declaredEdges: [], allowUndeclared: true })).ok, true);
});
