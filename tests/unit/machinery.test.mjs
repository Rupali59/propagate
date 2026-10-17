/**
 * lib/report/machinery.mjs -- the data behind GET /api/machinery (dashboard Phase 2).
 *
 * The sources are injected, so none of this reads the tree. The default sources are exercised
 * by tests/cli/ui-server.test.mjs (the production construction path) and, for the blind-scan
 * guards, by feeding the real libraries an empty world at the bottom of this file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { computeMachinery, createMachinery, toBlock, defaultSources, MACHINERY_KEYS, MACHINERY_TTL_MS } from "../../lib/report/machinery.mjs";

const fine = (k, n = 3) => async () => ({ count: n, of: 10, label: k, top: "top " + k });
const sources = (over = {}) => Object.fromEntries(MACHINERY_KEYS.map((k) => [k, over[k] ?? fine(k)]));

test("machinery: the keys are the six sources, in the Overview's order", () => {
  assert.deepEqual(MACHINERY_KEYS, ["claims", "rules", "caps", "skills", "backlog", "goals"]);
});

test("machinery: one block per source, and a throwing source is status:error with its message and a null count, not a 0", async () => {
  const out = await computeMachinery(sources({ skills: async () => { throw new Error("cannot read ~/.claude/skills"); } }));
  for (const k of MACHINERY_KEYS) assert.ok(out[k], k);
  assert.equal(out.skills.status, "error");
  assert.equal(out.skills.reason, "cannot read ~/.claude/skills");
  assert.equal(out.skills.count, null);
  assert.equal(out.claims.status, "ok");
  assert.equal(out.claims.count, 3);
});

test("machinery: a source that returns no numeric count is an error, not a count of nothing", () => {
  assert.equal(toBlock({ status: "fulfilled", value: { label: "x" } }).status, "error");
  assert.equal(toBlock({ status: "fulfilled", value: { count: 0, label: "x" } }).count, 0, "a real zero stays a zero");
  assert.equal(toBlock({ status: "fulfilled", value: undefined }).status, "error");
});

test("machinery: the six run in parallel, not one after another", async () => {
  let running = 0, peak = 0;
  const slow = (k) => async () => { running += 1; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 20)); running -= 1; return { count: 1, label: k, top: "" }; };
  await computeMachinery(Object.fromEntries(MACHINERY_KEYS.map((k) => [k, slow(k)])));
  assert.equal(peak, 6);
});

test("machinery: inside the TTL the cache returns the SAME object and does not recompute; after it, a new one", async () => {
  let calls = 0, t = 1000;
  const m = createMachinery({ sources: sources({ claims: async () => { calls += 1; return { count: calls, label: "f", top: "" }; } }), ttlMs: 60000, now: () => t });
  const a = await m.read();
  t += 59999;
  const b = await m.read();
  assert.equal(b, a, "same object inside the TTL");
  assert.equal(calls, 1);
  t += 2;
  const c = await m.read();
  assert.notEqual(c, a);
  assert.equal(c.claims.count, 2);
});

test("machinery: two concurrent first requests share one computation", async () => {
  let calls = 0;
  const m = createMachinery({ sources: sources({ goals: async () => { calls += 1; await new Promise((r) => setTimeout(r, 10)); return { count: 1, label: "g", top: "" }; } }) });
  const [a, b] = await Promise.all([m.read(), m.read()]);
  assert.equal(a, b);
  assert.equal(calls, 1);
});

test("machinery: a response in which every source failed is not cached, so the next try can recover", async () => {
  let fail = true;
  const all = Object.fromEntries(MACHINERY_KEYS.map((k) => [k, async () => { if (fail) throw new Error("down"); return { count: 1, label: k, top: "" }; }]));
  const m = createMachinery({ sources: all, ttlMs: 60000 });
  const first = await m.read();
  assert.ok(MACHINERY_KEYS.every((k) => first[k].status === "error"));
  fail = false;
  const second = await m.read();
  assert.ok(MACHINERY_KEYS.every((k) => second[k].status === "ok"), "the failed answer was held for the TTL");
});

test("machinery: the TTL is the one constant, and it is a minute", () => {
  assert.equal(MACHINERY_TTL_MS, 60000);
});

test("machinery: the default sources have all six keys (a missing source would be a TypeError, caught as an error block, not a missing tile)", () => {
  assert.deepEqual(Object.keys(defaultSources).sort(), [...MACHINERY_KEYS].sort());
});

test("machinery: with NO config (a state dir that has no searchRoots) claims, caps, backlog and goals are errors that say so, never a clean 0", async () => {
  // The measured defect behind the guards: a library that looks at an empty world returns a tidy zero
  // (claims: 0 files checked, 0 findings), which a tile would print as "all clear". A fresh state dir
  // has no config.yml, so discovery finds nothing -- exactly that world -- in a CHILD process because
  // the state dir is fixed at import time.
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const dir = mkdtempSync(path.join(tmpdir(), "mach-blind-"));
  try {
    const script = `
      import { computeMachinery } from ${JSON.stringify(path.resolve(import.meta.dirname, "../../lib/report/machinery.mjs"))};
      const m = await computeMachinery();
      console.log(JSON.stringify(Object.fromEntries(["claims","caps","backlog","goals"].map((k) => [k, m[k]]))));`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: { ...process.env, PROPAGATE_STATE_DIR: dir, PROPAGATE_HUB_ROOT: "" }, timeout: 60000 });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    for (const k of ["claims", "caps", "backlog", "goals"]) {
      assert.equal(out[k].status, "error", `${k} looked at nothing and reported ${JSON.stringify(out[k])}`);
      assert.equal(out[k].count, null, k);
      assert.ok(out[k].reason, k);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("machinery: read({fresh:true}) recomputes inside the TTL and replaces what is held", async () => {
  let calls = 0, t = 1000;
  const m = createMachinery({ sources: sources({ claims: async () => { calls += 1; return { count: calls, label: "f", top: "" }; } }), ttlMs: 60000, now: () => t });
  const a = await m.read();
  t += 1000;
  const b = await m.read({ fresh: true });
  assert.notEqual(b, a, "the refresh button got the cached answer back");
  assert.equal(b.claims.count, 2);
  const c = await m.read();
  assert.equal(c, b, "the fresh value is what is held afterwards");
});
