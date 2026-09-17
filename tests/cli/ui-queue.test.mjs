/**
 * The disposition UI — the write gate and the queue model.
 *
 * WHAT IS WORTH TESTING HERE. Not the HTML. The UI's whole risk is that a button
 * is a lower-friction write than a typed command, against an APPEND-ONLY store
 * where a wrong event cannot be removed. N27 put 11 spurious events in that store
 * and silently closed 3 real worklist items; N44 added 2 more. So the tests below
 * are all about what the server REFUSES.
 *
 * The `reason` rule is deliberately stricter than the CLI's — `validateEvent`
 * demands a reason only for `wontfix` and `baselined`. Here every disposition
 * needs one, because N64 records 556 unexplained rows from v1 and N85 found
 * templated reasoning copied across 15 edges in a single batch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { guardRequest, validateWrite } from "../../commands/ui.mjs";
import { buildQueue, queueSummary, shortPath } from "../../lib/report/queue.mjs";

const item = (over = {}) => ({
  edge_id: "abc12345",
  state: "DRIFTED",
  allowed: ["propagated", "no-change-needed", "source-corrected", "decoupled", "deferred", "wontfix"],
  ...over,
});

// ── the request guard ──────────────────────────────────────────────────────

test("a non-loopback Host is refused even with a valid token", () => {
  const req = { headers: { host: "evil.example.com" }, url: "/api/queue?token=T" };
  assert.match(guardRequest(req, "T", 4599), /non-loopback/);
});

test("a cross-origin request is refused — loopback alone is not a boundary", () => {
  // The hazard scripts/claude-queue-ui.py recorded as its C4: a page on any site
  // can issue requests to a plain loopback server from the user's browser.
  const req = { headers: { host: "127.0.0.1:4599", origin: "https://evil.example.com" }, url: "/api/queue?token=T" };
  assert.match(guardRequest(req, "T", 4599), /cross-origin/);
});

test("a missing or wrong token is refused", () => {
  const base = { headers: { host: "127.0.0.1:4599" } };
  assert.match(guardRequest({ ...base, url: "/api/queue" }, "T", 4599), /token/);
  assert.match(guardRequest({ ...base, url: "/api/queue?token=nope" }, "T", 4599), /token/);
});

test("a same-origin loopback request with the token is allowed", () => {
  const req = { headers: { host: "127.0.0.1:4599", origin: "http://127.0.0.1:4599" }, url: "/api/queue?token=T" };
  assert.equal(guardRequest(req, "T", 4599), null);
});

// ── the write gate ─────────────────────────────────────────────────────────

test("a disposition with no reason is REFUSED, and the refusal says why the bar is higher here", () => {
  const err = validateWrite({ edge_id: "abc12345", disposition: "no-change-needed", reason: "" }, item());
  assert.match(err, /reason/);
  assert.match(err, /stricter than the CLI/, "the refusal must explain itself, not just say invalid");
});

test("a token reason is refused — 'ok' is not an audit trail", () => {
  assert.match(validateWrite({ edge_id: "abc12345", disposition: "deferred", reason: "ok" }, item()), /12 characters/);
});

test("a DIVERGED edge refuses everything except both-reconciled", () => {
  const d = item({ state: "DIVERGED", allowed: ["both-reconciled"] });
  const err = validateWrite({ edge_id: "abc12345", disposition: "no-change-needed", reason: "a perfectly good reason" }, d);
  assert.match(err, /DIVERGED/);
  assert.match(err, /both-reconciled/, "the refusal must name what IS allowed");
  assert.equal(validateWrite({ edge_id: "abc12345", disposition: "both-reconciled", reason: "read both sides, they agree" }, d), null);
});

test("an edge that is no longer actionable is refused, and the message says to reload", () => {
  // Two windows open, one disposes first. The second must not write against a
  // stale render — "not found" would read as a bug rather than a race.
  const err = validateWrite({ edge_id: "gone", disposition: "deferred", reason: "long enough reason" }, undefined);
  assert.match(err, /reload/);
});

// ── the queue model ────────────────────────────────────────────────────────

test("never-judged is null, never 0 — the two are different facts", () => {
  const rows = [{ edge_id: "e1", state: "DRIFTED", source: { path: "/r/a/b.md" }, downstream: { path: "/r/c/d.md" } }];
  const [it] = buildQueue(rows, new Map(), { root: "/r/" });
  assert.equal(it.noiseRatio, null, "a 0 would assert 'judged, always a no-op'");
  assert.equal(it.judgedCount, 0);
});

test("a DIVERGED row offers only both-reconciled — the UI must not render a control the write path refuses", () => {
  const rows = [{ edge_id: "e2", state: "DIVERGED", source: { path: "/r/a.md" }, downstream: { path: "/r/b.md" } }];
  const [it] = buildQueue(rows, new Map(), { root: "/r/" });
  assert.deepEqual(it.allowed, ["both-reconciled"]);
});

test("noisy rows sort LAST — the queue leads with what deserves attention", () => {
  const rows = [
    { edge_id: "noisy", state: "DRIFTED", source: { path: "/r/a.md" }, downstream: { path: "/r/b.md" } },
    { edge_id: "fresh", state: "DRIFTED", source: { path: "/r/c.md" }, downstream: { path: "/r/d.md" } },
  ];
  const hist = new Map([["noisy", { total: 9, noChange: 9, last: null, dispositions: [] }]]);
  const items = buildQueue(rows, hist, { root: "/r/" });
  assert.equal(items[0].edge_id, "fresh", "never-judged first");
  assert.equal(items[items.length - 1].edge_id, "noisy", "judged 9× and always 'no' goes last");
});

test("the summary reports never-judged and mostly-no-op separately from the total", () => {
  const rows = [
    { edge_id: "a", state: "DRIFTED", source: { path: "/r/a.md" }, downstream: { path: "/r/b.md" } },
    { edge_id: "b", state: "DIVERGED", source: { path: "/r/c.md" }, downstream: { path: "/r/d.md" } },
  ];
  const hist = new Map([["b", { total: 4, noChange: 4, last: null, dispositions: [] }]]);
  const s = queueSummary(buildQueue(rows, hist, { root: "/r/" }));
  assert.equal(s.total, 2);
  assert.equal(s.neverJudged, 1);
  assert.equal(s.highNoise, 1);
  assert.deepEqual(s.byState, { DRIFTED: 1, DIVERGED: 1 });
});

test("shortPath keeps the workspace AND the parent — 53 files here are named CLAUDE.md", () => {
  const a = shortPath("/r/Vipin Kaushik/VipinKaushik/CLAUDE.md", "/r/");
  const b = shortPath("/r/Vipin Kaushik/astroacharya/CLAUDE.md", "/r/");
  assert.notEqual(a, b);
  assert.match(a, /VipinKaushik/);
});
