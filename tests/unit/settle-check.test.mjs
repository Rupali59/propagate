// settle-check — the deterministic gate on edge-settler's proposals (propagate#251). One failing fixture per
// clause, so removing any clause turns exactly its test red.
import { test } from "node:test";
import assert from "node:assert/strict";

import { checkProposals } from "../../lib/edges/settle-check.mjs";
import { REASON_PLACEHOLDER } from "../../lib/edges/disposition.mjs";

const item = (edge_id, extra = {}) => ({
  edge_id,
  state: "DRIFTED",
  source: "/w/repo/src.md",
  downstream: "/w/repo/down.md",
  allowed: ["propagated", "no-change-needed", "deferred", "wontfix", "baselined", "decoupled"],
  viaOutOfOrder: [],
  blockedBy: [],
  ...extra,
});
const worklist = { items: [item("e1"), item("e2")] };
const GOOD = "abc1234";
// A fake git: GOOD exists and touched src.md; "dead999" exists but touched nothing on these edges.
const git = {
  exists: (sha) => sha === GOOD || sha === "dead999",
  touched: (sha, file) => sha === GOOD && file.endsWith("src.md"),
};
const prop = (edge_id, extra = {}) => ({ edge_id, disposition: "no-change-needed", reason: "down.md:12 still holds", shas: [GOOD], ...extra });

test("all edges proposed, allowed, with real evidence: PASS with dry-run and apply commands", () => {
  const r = checkProposals(worklist, [prop("e1"), prop("e2")], git);
  assert.equal(r.ok, true);
  assert.equal(r.accepted.length, 2);
  assert.match(r.accepted[0].dryRun, /--edge e1 --disposition no-change-needed/);
  assert.doesNotMatch(r.accepted[0].dryRun, /--apply/);
  assert.match(r.accepted[0].apply, /--apply$/);
});

test("coverage: an edge on the worklist that was not proposed is MISSING and fails", () => {
  const r = checkProposals(worklist, [prop("e1")], git);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ["e2"]);
});

test("coverage: an id not on this file's worklist is EXTRA and fails (the position-binding error)", () => {
  const r = checkProposals(worklist, [prop("e1"), prop("e2"), prop("e9")], git);
  assert.equal(r.ok, false);
  assert.deepEqual(r.extra, ["e9"]);
});

test("coverage: a duplicated id fails", () => {
  const r = checkProposals(worklist, [prop("e1"), prop("e1"), prop("e2")], git);
  assert.equal(r.ok, false);
  assert.deepEqual(r.duplicate, ["e1"]);
});

test("predicate: propagated on a DIVERGED edge is refused (allowed list excludes it)", () => {
  const w = { items: [item("e1", { state: "DIVERGED", allowed: ["both-reconciled", "deferred"] })] };
  const r = checkProposals(w, [prop("e1", { disposition: "propagated" })], git);
  assert.equal(r.ok, false);
  assert.match(r.rejected[0].reasons.join(), /not allowed on this DIVERGED edge/);
});

test("predicate: a disposition reachable only via --out-of-order is refused; the override is the parent's", () => {
  const w = { items: [item("e1", { allowed: ["deferred"], viaOutOfOrder: ["propagated"], blockedBy: [{ edge_id: "up1" }] })] };
  const r = checkProposals(w, [prop("e1", { disposition: "propagated" })], git);
  assert.equal(r.ok, false);
  assert.match(r.rejected[0].reasons.join(), /needs --out-of-order \(blocked by up1\)/);
});

test("reason: empty or the placeholder is refused", () => {
  for (const reason of ["", "   ", REASON_PLACEHOLDER]) {
    const r = checkProposals({ items: [item("e1")] }, [prop("e1", { reason })], git);
    assert.equal(r.ok, false, `reason ${JSON.stringify(reason)} must fail`);
    assert.match(r.rejected[0].reasons.join(), /no reason/);
  }
});

test("evidence: no SHA, a non-SHA, an unknown SHA, and a SHA that touched neither side are each refused", () => {
  const cases = [
    [[], /no evidence SHA/],
    [["working tree"], /not a commit SHA/],
    [["fffffff"], /does not exist/],
    [["dead999"], /touched neither/],
  ];
  for (const [shas, why] of cases) {
    const r = checkProposals({ items: [item("e1")] }, [prop("e1", { shas })], git);
    assert.equal(r.ok, false, `shas ${JSON.stringify(shas)} must fail`);
    assert.match(r.rejected[0].reasons.join(), why);
  }
});

test("shape: a non-array is an error, not an empty pass; {proposals: [...]} is accepted", () => {
  assert.match(checkProposals(worklist, { nope: 1 }, git).error, /not an array/);
  assert.equal(checkProposals(worklist, { proposals: [prop("e1"), prop("e2")] }, git).ok, true);
});

test("floor: an empty proposal list never passes, even for an empty worklist", () => {
  assert.equal(checkProposals({ items: [] }, [], git).ok, false);
});

// The CLI path: the second gate (verify WITHOUT --apply) must be able to fail the whole check on its own.
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settleCheck } from "../../cli/settle.mjs";

test("settle --check: a verify dry-run refusal fails the check even when checkProposals accepted everything", async () => {
  const dir = mkdtempSync(join(tmpdir(), "settle-check-"));
  const f = join(dir, "p.json");
  writeFileSync(f, JSON.stringify([prop("e1"), prop("e2")]));
  const lines = [];
  const io = { log: (s) => lines.push(s) };
  const calls = [];
  const w = { ...worklist, file: "/w/repo/src.md", fileShort: "src.md" };
  const ok = await settleCheck(w, f, { io, asJson: false, deps: { git, runVerify: (a) => (calls.push(a), { status: 0 }) } });
  assert.equal(ok, 0);
  assert.ok(calls.every((a) => !a.includes("--apply")), "the dry run must never carry --apply");
  const bad = await settleCheck(w, f, { io, asJson: false, deps: { git, runVerify: (a) => ({ status: a[1] === "e2" ? 3 : 0, stderr: "blocked upstream" }) } });
  assert.equal(bad, 1);
  assert.ok(lines.some((l) => /FAIL e2.*blocked upstream/.test(l)));
  assert.equal(await settleCheck(w, join(dir, "absent.json"), { io, asJson: false, deps: { git } }), 2);
});
