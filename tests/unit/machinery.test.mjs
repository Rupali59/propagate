/**
 * lib/report/machinery.mjs -- the data behind GET /api/machinery (dashboard Phase 2).
 *
 * The sources are injected, so none of this reads the tree. The default sources are exercised
 * by tests/cli/ui-server.test.mjs (the production construction path) and, for the blind-scan
 * guards, by feeding the real libraries an empty world at the bottom of this file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { computeMachinery, createMachinery, toBlock, defaultSources, MACHINERY_KEYS, MACHINERY_TTL_MS, DETAIL_KEYS, DORMANT_DAYS, shapeClaims, shapeRules, shapeCaps, shapeSkills } from "../../lib/report/machinery.mjs";

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

/* ══ Dashboard Phase 4a: one computation feeds the tile and the page ═══════════════════════════════════════════
   The libraries' output is written out below as LITERALS (rule:mutate-behind-the-fixture-builder): hostile shapes
   a real run has produced -- a finding with no line, a restatement whose match spans lines (empty `hits`), a cap of
   null on an exempt file, a usage timestamp that is not a number -- must not be tidied onto a helper. */

const NOW = Date.UTC(2026, 9, 17);
const DAY = 86_400_000;
const CLAIMS = {
  findings: [
    { check: "expired-date", file: "/h/GitHub/a.md", line: 12, marker: "until", approx: false, dateText: "2026-06-17", expiredISO: "2026-06-17", daysExpired: 122, snippet: "x", looksHistorical: true },
    { check: "rotted-citation", subtype: "dead-branch", file: "/h/GitHub/b.md", branch: "gone", repoRoot: "/h/GitHub", context: "see gone" },
    { check: "footer-stale", file: "/h/GitHub/c.md", footer: "2026-08-10", newestInline: "2026-10-12" },
  ],
  coverage: { filesChecked: 702, sidecarsChecked: 50, sourceEdges: 350, globsSkipped: 3 },
  files: { unreadable: ["/h/x"] }, sidecars: { unreadable: [] },
};
const RULES_RES = {
  rules: [
    { id: "alpha", scope: "global", __file: "/h/.claude/rules/alpha.md" },
    { id: "beta", scope: "next-projects", __file: "/h/.claude/rules/beta.md" },
    { id: "gamma", scope: "global", __file: "/h/.claude/rules/gamma.md" },
  ],
  filesScanned: 9,
  findings: [
    { rule: "gamma", file: "/h/GitHub/x/CLAUDE.md", hits: [41, 50], lines: ["..."], spansLines: false },
    { rule: "gamma", file: "/h/GitHub/y/CLAUDE.md", hits: [], lines: [], spansLines: true },
  ],
  referencedRestatements: [{ rule: "alpha", file: "/h/GitHub/z/CLAUDE.md", line: 7 }],
};
const RULES_COV = [
  { id: "alpha", matched: 0, referenced: 3, status: "adopted" },
  { id: "beta", matched: 0, referenced: 0, status: "unexercised" },
  { id: "gamma", matched: 2, referenced: 0, status: "firing" },
];
const CAPS = {
  records: [
    { file: "/h/GitHub/A/CLAUDE.md", kind: "CLAUDE.md", scope: "workspace", project: "A", metric: "lines", actual: 300, cap: 150, status: "over" },
    { file: "/h/GitHub/B/CLAUDE.md", kind: "CLAUDE.md", scope: "project", project: "B", metric: "lines", actual: 176, cap: 180, status: "yellow" },
    { file: "/h/GitHub/C/GOTCHAS.md", kind: "GOTCHAS.md", scope: "project", project: "C", metric: "entries", actual: 16, cap: null, status: "exempt" },
    { file: "/h/GitHub/D/CLAUDE.md", kind: "CLAUDE.md", scope: "project", project: "D", metric: "lines", actual: 10, cap: 180, status: "ok" },
  ],
  totals: { measured: 4, over: 1, yellow: 1, exempt: 1, skippedStubs: 0, excessLines: 150 },
};
const SKILLS = {
  skills: [
    { id: "never-used", installer: "handmade", provenance: null, usageCount: 0, transcriptCount: 0, lastUsedAt: null, neverInvoked: true },
    { id: "old", installer: "npx-skills", provenance: { source: "owner/repo", sourceUrl: null }, usageCount: 3, transcriptCount: 0, lastUsedAt: NOW - (DORMANT_DAYS + 1) * DAY, neverInvoked: false },
    { id: "fresh", installer: "gstack-relink", provenance: null, usageCount: 9, transcriptCount: 2, lastUsedAt: NOW - DAY, neverInvoked: false },
    { id: "transcript-only", installer: "handmade", provenance: null, usageCount: 0, transcriptCount: 4, lastUsedAt: null, neverInvoked: false },
    { id: "bad-stamp", installer: "handmade", provenance: null, usageCount: 1, transcriptCount: 0, lastUsedAt: "yesterday", neverInvoked: false },
  ],
  orphanUsageKeys: ["gone-1", "gone-2"],
};
const TX = { scanned: true, byName: {} };

/** The count each page derives from ITS OWN rows -- written independently of the shape functions' `count`. */
const rowDerived = {
  claims: (d) => d.rows.length,
  rules: (d) => d.rows.filter((r) => r.coverage === "unexercised").length + d.rows.reduce((n, r) => n + r.restatedIn.length, 0),
  caps: (d) => d.rows.filter((r) => r.status === "over").length,
  skills: (d) => d.rows.filter((r) => r.status === "never invoked").length,
};
const fixtureSources = () => ({
  ...sources(),
  claims: async () => shapeClaims(CLAIMS, { "expired-date": "expired date" }, (f) => "describe " + f.check),
  rules: async () => shapeRules(RULES_RES, RULES_COV),
  caps: async () => shapeCaps(CAPS),
  skills: async () => shapeSkills(SKILLS, TX, NOW),
});

for (const k of DETAIL_KEYS) {
  test(`phase 4a: the ${k} TILE count equals the count derived from the ${k} PAGE's rows (one computation, two readers)`, async () => {
    const m = createMachinery({ sources: fixtureSources() });
    const tile = (await m.read())[k];
    const page = await m.readDetail(k);
    assert.equal(tile.status, "ok");
    assert.equal(page.ok, true);
    assert.equal(tile.count, rowDerived[k](page), `${k}: the tile says ${tile.count}, its rows say ${rowDerived[k](page)}`);
    assert.equal(page.headline.count, tile.count, "and the page's own headline is the tile's figure");
    assert.ok(tile.count > 0, "the fixture must have something to count, or equality proves nothing");
  });
}

test("phase 4a: the fixture counts are the ones written out by hand (so the equality above is not two copies of one bug)", async () => {
  const m = createMachinery({ sources: fixtureSources() });
  const t = await m.read();
  assert.equal(t.claims.count, 3);
  assert.equal(t.rules.count, 3, "1 unexercised + 2 restatement files");
  assert.equal(t.rules.of, 3);
  assert.equal(t.caps.count, 1);
  assert.equal(t.caps.of, 4);
  assert.equal(t.skills.count, 1, "only the skill with zero uses AND zero transcripts");
});

test("phase 4a: the tile and the page come from ONE computation -- six source calls, not twelve -- and the rows never ride on the tile payload", async () => {
  let calls = 0;
  const counted = Object.fromEntries(MACHINERY_KEYS.map((k) => [k, async () => { calls += 1; return fixtureSources()[k](); }]));
  const m = createMachinery({ sources: counted });
  const tile = await m.read();
  await m.readDetail("claims"); await m.readDetail("rules"); await m.readDetail("caps"); await m.readDetail("skills");
  assert.equal(calls, 6, "each source ran once for the tile and all four pages together");
  assert.equal(JSON.stringify(tile).includes('"rows"'), false, "the tile response stays small");
  assert.deepEqual(Object.keys(tile).sort(), ["caps", "claims", "generatedAt", "goals", "ok", "backlog", "rules", "skills", "ttlMs"].sort());
  const fresh = await m.readDetail("claims", { fresh: true });
  assert.equal(calls, 12, "fresh recomputes everything, as it does for the tile");
  assert.equal(fresh.ok, true);
});

test("phase 4a: a failed source is {ok:false, error: its reason} on its page; a source with a count but no rows is also an error, never an empty table", async () => {
  const m = createMachinery({ sources: { ...fixtureSources(), caps: async () => { throw new Error("caps could not place the files: hub root is not configured"); }, skills: async () => ({ count: 4, of: 9, label: "x", top: "" }) } });
  const caps = await m.readDetail("caps");
  assert.deepEqual(caps, { ok: false, error: "caps could not place the files: hub root is not configured" });
  const skills = await m.readDetail("skills");
  assert.equal(skills.ok, false);
  assert.match(skills.error, /count but no rows/);
  assert.equal((await m.readDetail("claims")).ok, true, "the others are fine");
  assert.deepEqual(await m.readDetail("backlog"), { ok: false, error: "no such view: backlog" });
});

test("phase 4a claims: rows carry kind, file, line, message and the claim; a finding with no line keeps the file and a null line", () => {
  const s = shapeClaims(CLAIMS, { "expired-date": "expired date" }, (f) => "describe " + f.check);
  const [exp, rot, foot] = s.detail.rows;
  assert.deepEqual([exp.kind, exp.kindLabel, exp.file, exp.line, exp.claim, exp.message, exp.historical], ["expired-date", "expired date", "/h/GitHub/a.md", 12, "until 2026-06-17", "describe expired-date", true]);
  assert.deepEqual([rot.line, rot.claim, rot.kindLabel], [null, "gone", "rotted-citation"], "no line -> null; unlabelled kind falls back to the kind");
  assert.equal(foot.claim, "2026-08-10");
  assert.deepEqual(s.detail.kinds.map((k) => [k.kind, k.count]), [["expired-date", 1], ["rotted-citation", 1], ["footer-stale", 1]]);
  assert.deepEqual(s.detail.summary, { findings: 3, filesChecked: 702, sidecarsChecked: 50, sourceEdges: 350, globsSkipped: 3, unreadable: 1 });
  assert.equal(new Set(s.detail.rows.map((r) => r.id)).size, 3, "row ids are unique");
  const empty = shapeClaims({ findings: [], coverage: { filesChecked: 5 } });
  assert.equal(empty.count, 0);
  assert.equal(empty.detail.summary.filesChecked, 5, "an empty result still names what it examined");
});

test("phase 4a rules: restated wins the display status, coverage keeps the other fact; the first hit is the line, a spanning match has none", () => {
  const s = shapeRules(RULES_RES, RULES_COV);
  const by = Object.fromEntries(s.detail.rows.map((r) => [r.id, r]));
  assert.equal(by.gamma.status, "restated");
  assert.equal(by.gamma.coverage, "firing");
  assert.deepEqual(by.gamma.restatedIn, [{ file: "/h/GitHub/x/CLAUDE.md", line: 41 }, { file: "/h/GitHub/y/CLAUDE.md", line: null }]);
  assert.deepEqual(by.alpha.excusedIn, [{ file: "/h/GitHub/z/CLAUDE.md", line: 7 }], "an excused restatement is shown but not counted");
  assert.equal(by.alpha.status, "adopted");
  assert.equal(by.beta.file, "/h/.claude/rules/beta.md", "the file is the library's own resolved path");
  assert.deepEqual(s.detail.summary, { rules: 3, adopted: 1, firing: 1, unexercised: 1, restated: 2, restatedRules: 1, excused: 1, filesScanned: 9 });
});

test("phase 4a caps: over, yellow and exempt are rows, ok is not; an exempt file has a null ratio and sorts nowhere near the worst", () => {
  const s = shapeCaps(CAPS);
  assert.deepEqual(s.detail.rows.map((r) => [r.status, r.ratio]), [["over", 2], ["yellow", 176 / 180], ["exempt", null]]);
  assert.deepEqual(s.detail.summary, { measured: 4, over: 1, yellow: 1, exempt: 1, skippedStubs: 0, excessLines: 150 });
  assert.match(s.top, /worst 2\.0x/);
  const none = shapeCaps({ records: [CAPS.records[3]], totals: { measured: 1, over: 0, yellow: 0, exempt: 0 } });
  assert.equal(none.count, 0);
  assert.equal(none.top, "none over cap");
  assert.equal(none.detail.rows.length, 0);
  assert.equal(none.detail.summary.measured, 1, "the empty page can still say how many were measured");
});

test("phase 4a skills: never invoked, dormant and active are decided at the stated boundary; a non-numeric stamp is not a date", () => {
  const s = shapeSkills(SKILLS, TX, NOW);
  const st = Object.fromEntries(s.detail.rows.map((r) => [r.id, r.status]));
  assert.deepEqual(st, { "never-used": "never invoked", old: "dormant", fresh: "active", "transcript-only": "active", "bad-stamp": "active" });
  assert.equal(s.detail.rows.find((r) => r.id === "bad-stamp").lastUsedAt, null, "a string stamp is null, not NaN");
  assert.equal(s.detail.rows.find((r) => r.id === "old").provenance, "owner/repo");
  const edge = shapeSkills({ skills: [{ id: "x", usageCount: 1, transcriptCount: 0, lastUsedAt: NOW - DORMANT_DAYS * DAY, neverInvoked: false }], orphanUsageKeys: [] }, TX, NOW);
  assert.equal(edge.detail.rows[0].status, "active", "exactly DORMANT_DAYS ago is not yet dormant");
  assert.equal(s.detail.summary.dormantDays, DORMANT_DAYS);
  assert.equal(s.detail.summary.neverInvokedMeans, "zero in skillUsage AND zero in transcripts");
  const blind = shapeSkills(SKILLS, { scanned: false }, NOW);
  assert.equal(blind.detail.summary.transcriptProbe, false);
  assert.match(blind.top, /transcript probe unavailable/);
});
