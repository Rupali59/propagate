/**
 * lib/report/machinery.mjs -- the data behind GET /api/machinery (dashboard Phase 2).
 *
 * The sources are injected, so none of this reads the tree. The default sources are exercised
 * by tests/cli/ui-server.test.mjs (the production construction path) and, for the blind-scan
 * guards, by feeding the real libraries an empty world at the bottom of this file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { computeMachinery, createMachinery, toBlock, defaultSources, MACHINERY_KEYS, MACHINERY_TTL_MS, DETAIL_KEYS, PAGE_ONLY_KEYS, DORMANT_DAYS, HISTORY_ROWS, HISTORY_COMMANDS,
  shapeClaims, shapeRules, shapeCaps, shapeSkills, shapeBacklog, shapeGoals, shapeGoalRows, shapePlans, planStatusWord, backlogKind,
  shapeHistory, shapeDoctorHistory, shapeMonitorHistory, shapeReleaseHistory, parseMonitorLine } from "../../lib/report/machinery.mjs";
import { priorityCaveat, groupForBrief } from "../../lib/report/backlog.mjs";
import { goalCounts } from "../../lib/report/goals.mjs";

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

test("machinery: the default sources have the six tile keys and the page-only ones (a missing source would be a TypeError, caught as an error block, not a missing tile)", () => {
  assert.deepEqual(PAGE_ONLY_KEYS, ["history"], "history is the one source with a page and no tile");
  assert.deepEqual(Object.keys(defaultSources).sort(), [...MACHINERY_KEYS, ...PAGE_ONLY_KEYS].sort());
  assert.equal(MACHINERY_KEYS.includes("history"), false, "the Overview shows six tiles; history is not one of them");
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
      console.log(JSON.stringify({ ...Object.fromEntries(["claims","caps","backlog","goals"].map((k) => [k, m[k]])), history: m.details.history, failures: m.pageFailures }));`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: { ...process.env, PROPAGATE_STATE_DIR: dir, PROPAGATE_HUB_ROOT: "" }, timeout: 60000 });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    for (const k of ["claims", "caps", "backlog", "goals"]) {
      assert.equal(out[k].status, "error", `${k} looked at nothing and reported ${JSON.stringify(out[k])}`);
      assert.equal(out[k].count, null, k);
      assert.ok(out[k].reason, k);
    }
    // History in the same empty world: nothing was ever recorded in a fresh state dir, and each part SAYS so with a
    // reason of its own. It is neither an error nor a silent empty table (rule:discernment-checks 2).
    assert.deepEqual(out.failures, {}, "reading three absent files is not a failure");
    assert.deepEqual(out.history.parts.map((p) => [p.key, p.status]), [["doctor", "none"], ["monitor", "none"], ["release", "none"]]);
    for (const p of out.history.parts) assert.match(p.reason, /^no recorded run/, p.key);
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

/* Phase 4b literals. A backlog item with no priority, one duplicated across registers, an id-keyed one and one whose
   text carries markup; a goals file that could not be read, a goal that is neither open nor closed, one that claims
   a command; plans in each of the four states and one that could not be read. */
const BACKLOG = {
  ranked: [
    { file: "/h/GitHub/A/TODOS.md", line: 10, text: "**TM-001 — fix the thing** (P0, blocks X)", format: "checkbox", priority: 0, id: "TM-001", sources: [{ file: "/h/GitHub/A/TODOS.md", line: 10 }] },
    { file: "/h/GitHub/B/propagation/state/B/STATE.md", line: 40, text: "wrap the\n  long   line <b>x</b>", format: "state-bullet", priority: null, section: "Pending", sources: [{ file: "/h/GitHub/B/propagation/state/B/STATE.md", line: 40 }, { file: "/h/GitHub/B/propagation/state/workspace/STATE.md", line: 7 }] },
    { file: "/h/GitHub/C/ISSUES.md", line: 3, text: "N7 · an issue P2 cap", format: "id-keyed", priority: 2, id: "N7", sources: [{ file: "/h/GitHub/C/ISSUES.md", line: 3 }] },
    { file: "/h/GitHub/D/NOTES.md", line: null, text: "no line recorded", format: "checkbox", priority: null, sources: [] },
  ],
  totals: { stateFilesRead: 2, todoFilesRead: 1, issueFilesRead: 1, unparsedFiles: 0, delegated: [{ file: "/h/GitHub/E/TODOS.md", delegatedTo: "https://x" }] },
  handovers: { files: [{ file: "/h/GitHub/HANDOVERS.md", sections: [{ status: "open" }, { status: "unknown" }, { status: "closed" }] }] },
  mergedCount: 1,
};
const GOAL_FILES = [
  { file: "/h/GitHub/G1/GOALS.md", unread: false, entries: [
    { n: 1, title: "open with a command", status: "open", derivation: "claimed", command: "node check.mjs\nnode second.mjs" },
    { n: 2, title: "open judgement", status: "open", derivation: "waived", command: null },
    { n: 3, title: "closed, uncheckable", status: "closed", derivation: "none", command: null },
    { n: 4, title: "nobody said what finishes it", status: "unknown", derivation: "claimed", command: null },
  ] },
  { file: "/h/GitHub/G2/GOALS.md", unread: true, entries: [], reason: "no '## <N> · <title>' goal sections found — format not recognised" },
];
const PLANS = { results: [{
  root: "/h/GitHub/propagate", external: false, ok: true, empty: false, scanned: 50, dropped: [], excluded: [{ file: "x" }],
  plans: [
    { file: "/h/GitHub/propagate/docs/plans/2026-08-01-a.md", unreadable: false, state: "live", why: "cited directly by a hub seed", finishedBy: null, statusPhrase: "ACTIVE", authoredDate: { date: "2026-08-01", source: "basename" }, gated: false, grade: "flagged" },
    { file: "/h/GitHub/propagate/docs/plans/2026-08-02-b.md", unreadable: false, state: "finished", why: "Status: names a finished word", finishedBy: "status", statusPhrase: "done", authoredDate: { date: "2026-08-02", source: "basename" }, gated: false, grade: "flagged" },
    { file: "/h/GitHub/propagate/docs/plans/archive/2026-08-03-c.md", unreadable: false, state: "finished", why: "lives under archive/ or _archive/", finishedBy: "archive-dir", statusPhrase: null, authoredDate: { date: null, source: "unknown" }, gated: false, grade: "flagged" },
    { file: "/h/GitHub/propagate/docs/plans/2026-08-04-d.md", unreadable: false, state: "undeclared", why: "not archived, no finished Status:, not linked from any hub seed", finishedBy: null, statusPhrase: null, authoredDate: { date: "2026-08-04", source: "basename" }, gated: false, grade: "flagged" },
    { file: "/h/GitHub/propagate/docs/plans/2026-08-05-e.md", unreadable: true, reason: "EACCES: permission denied" },
  ],
}] };

/** The count each page derives from ITS OWN rows -- written independently of the shape functions' `count`. */
const rowDerived = {
  claims: (d) => d.rows.length,
  rules: (d) => d.rows.filter((r) => r.coverage === "unexercised").length + d.rows.reduce((n, r) => n + r.restatedIn.length, 0),
  caps: (d) => d.rows.filter((r) => r.status === "over").length,
  skills: (d) => d.rows.filter((r) => r.status === "never invoked").length,
  backlog: (d) => d.rows.filter((r) => r.priority === null).length,
  goals: (d) => d.rows.filter((r) => r.status === "open").length,
};
const fixtureSources = () => ({
  ...sources(),
  claims: async () => shapeClaims(CLAIMS, { "expired-date": "expired date" }, (f) => "describe " + f.check),
  rules: async () => shapeRules(RULES_RES, RULES_COV),
  caps: async () => shapeCaps(CAPS),
  skills: async () => shapeSkills(SKILLS, TX, NOW),
  backlog: async () => shapeBacklog(BACKLOG, priorityCaveat),
  goals: async () => shapeGoals(GOAL_FILES, shapePlans(PLANS)),
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
  assert.deepEqual(await m.readDetail("nope"), { ok: false, error: "no such view: nope" });
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


/* ══ Dashboard Phase 4b: Backlog, Goals and Plans, History ═════════════════════════════════════════════════════════ */

test("phase 4b: the backlog and goals TILE counts are the counts derived by a SECOND route from the library's own data", () => {
  // Backlog: the CLI's own derivation (groupForBrief) counts the unprioritised items; the tile must agree with it.
  const viaCli = groupForBrief(BACKLOG.ranked).byPriority.none;
  assert.equal(shapeBacklog(BACKLOG, priorityCaveat).count, viaCli);
  assert.equal(viaCli, 2, "the literal has two items with no priority");
  // Goals: goalCounts is what `propagate goals` prints; the tile's open count and denominator must agree with it.
  const c = goalCounts(GOAL_FILES);
  const g = shapeGoals(GOAL_FILES, { ok: true, rows: [], summary: {} });
  assert.equal(g.count, c.open);
  assert.equal(g.of, c.total, "the denominator is goals actually read; an unreadable file adds none");
  assert.equal(c.open, 2);
});

test("phase 4b backlog: rows keep the ranked items and only those; text is one line without markup; a missing line stays null; kind comes from the register's own name", () => {
  const s = shapeBacklog(BACKLOG, priorityCaveat);
  assert.equal(s.detail.rows.length, 4);
  const [a, b, c, d] = s.detail.rows;
  assert.deepEqual([a.priority, a.ref, a.text, a.kind, a.alsoIn], [0, "TM-001", "TM-001 — fix the thing (P0, blocks X)", "todo", 0], "markers stripped, id carried");
  assert.equal(b.text, "wrap the long line <b>x</b>", "newlines and runs of spaces collapse; markup is left as text for the client to escape");
  assert.deepEqual([b.priority, b.kind, b.alsoIn, b.section], [null, "state", 1, "Pending"], "a merged duplicate says it is also recorded elsewhere");
  assert.equal(c.kind, "issue");
  assert.deepEqual([d.line, d.kind, d.alsoIn], [null, "other", 0], "no line -> null; an unknown register name is 'other', not a guess");
  assert.equal(new Set(s.detail.rows.map((r) => r.id)).size, 4, "ids are unique");
  assert.deepEqual(s.detail.summary.byPriority, { P0: 1, P1: 0, P2: 1, P3: 0, none: 2 });
  assert.equal(s.detail.summary.handovers.sections, 3, "handovers are summarised, not rows");
  assert.equal(s.detail.summary.handovers.open, 1);
  assert.equal(s.detail.summary.delegatedRegisters, 1);
  assert.equal(s.detail.rows.some((r) => /HANDOVERS/.test(r.file)), false, "a handover section is never a ranked row");
  assert.deepEqual(s.detail.kinds.map((k) => [k.kind, k.count]).sort(), [["issue", 1], ["other", 1], ["state", 1], ["todo", 1]]);
  assert.equal(backlogKind("/x/TODOS.md"), "todo");
  assert.equal(backlogKind("/x/y/ISSUES.md"), "issue");
});

test("#104 backlog: a GitHub row carries its url, repo and labels through shapeBacklog; only an https url is carried; the summary names the trackers and their age", () => {
  const gh = (over) => ({ id: "#12", repo: "o/r", url: "https://github.com/o/r/issues/12", text: "an issue **bold**", priority: 1, file: "/h/GitHub/E/TODOS.md", line: null, kind: "github", labels: ["task", "priority:P1"], sources: [{ file: "/h/GitHub/E/TODOS.md", line: null }], ...over });
  const r = {
    ranked: [gh(), gh({ id: "#13", url: "javascript:alert(1)", stale: true }), gh({ id: "#14", url: "http://github.com/o/r/issues/14" })],
    totals: { stateFilesRead: 0, todoFilesRead: 1, issueFilesRead: 0, delegated: [{ file: "/h/GitHub/E/TODOS.md", delegatedTo: "https://github.com/o/r/issues" }],
      trackers: { trackers: 2, counted: 1, unreadable: 1, unsupported: 0, notFetched: 0, stale: 1, openIssues: 3, rankedIssues: 3, handoverIssues: 2, asOf: "2026-10-19T01:00:00.000Z", asOfAgeMs: 2 * 3600_000, cache: { error: null } } },
    handovers: { files: [], github: { open: 2 } },
  };
  const s = shapeBacklog(r, priorityCaveat);
  const [a, b, c] = s.detail.rows;
  assert.deepEqual([a.ref, a.url, a.repo, a.kind, a.line, a.labels, a.stale], ["#12", "https://github.com/o/r/issues/12", "o/r", "github", null, ["task", "priority:P1"], false]);
  assert.equal(b.url, null, "a javascript: url is never carried: the page renders it as an href");
  assert.equal(b.stale, true);
  assert.equal(c.url, null, "only https");
  assert.deepEqual(s.detail.kinds, [{ kind: "github", label: "GitHub", count: 3 }]);
  assert.deepEqual(s.detail.summary.github, { trackers: 2, counted: 1, unreadable: 1, unsupported: 0, notFetched: 0, stale: 1, open: 3, ranked: 3, handoverIssues: 2, asOf: "2026-10-19T01:00:00.000Z", asOfText: "2 h ago", cacheError: null });
  assert.equal(s.detail.summary.handovers.github, 2);
  // A non-GitHub row has none of the GitHub keys: the shape is unchanged for the existing page.
  const plain = shapeBacklog(BACKLOG, priorityCaveat).detail.rows[0];
  assert.equal("url" in plain, false);
});

test("phase 4b backlog: the floor caveat is the CLI's own sentence (one function), and it is absent when everything has a priority", () => {
  const s = shapeBacklog(BACKLOG, priorityCaveat);
  assert.equal(s.detail.summary.caveat, '2 of 4 carry NO priority — so "2 prioritised" is a floor, not a ranking');
  assert.deepEqual(priorityCaveat(2, 4), { head: "2 of 4 carry NO priority", tail: 'so "2 prioritised" is a floor, not a ranking' });
  assert.equal(priorityCaveat(0, 4), null, "nothing unprioritised -> no caveat to make");
  const all = shapeBacklog({ ranked: [BACKLOG.ranked[0]], totals: BACKLOG.totals }, priorityCaveat);
  assert.equal(all.detail.summary.caveat, null);
  assert.equal(all.count, 0);
  const empty = shapeBacklog({ ranked: [], totals: { stateFilesRead: 3, todoFilesRead: 2, issueFilesRead: 1 } }, priorityCaveat);
  assert.equal(empty.detail.rows.length, 0);
  assert.equal(empty.detail.summary.filesRead.todo, 2, "an empty backlog still says how many files it read");
});

test("phase 4b goals: an unreadable file is a ROW with its reason, never dropped and never zero goals; unknown is never closed", () => {
  const rows = shapeGoalRows(GOAL_FILES);
  assert.equal(rows.length, 5, "four goals and one unreadable file");
  const bad = rows.find((r) => r.status === "unreadable");
  assert.equal(bad.file, "/h/GitHub/G2/GOALS.md");
  assert.match(bad.reason, /format not recognised/);
  assert.equal(bad.n, null);
  assert.deepEqual(rows.filter((r) => r.status !== "unreadable").map((r) => r.status), ["open", "open", "closed", "unknown"]);
  assert.deepEqual(rows.map((r) => r.derivation), ["claimed", "waived", "none", "claimed", null]);
  assert.equal(rows[0].command, "node check.mjs\nnode second.mjs", "a multi-line command keeps its newlines (a # comment must not swallow the next line)");
  assert.equal(rows[3].command, null, "a derivation claimed with no extractable command has no command to copy");
  assert.equal(rows.filter((r) => r.status === "closed").length, 1);
  const g = shapeGoals(GOAL_FILES, { ok: true, rows: [], summary: {} });
  assert.deepEqual(g.detail.summary, { files: 2, unreadable: 1, goals: 4, open: 2, closed: 1, unknown: 1, claimed: 2, waived: 1, uncheckable: 1 });
  assert.match(g.top, /2 files · 1 unreadable · 1 cannot be checked · 1 closed/);
});

test("phase 4b plans: the four words map from the library's state and how it was found; unreadable and invalid roots are stated, not dropped", () => {
  const p = shapePlans(PLANS);
  assert.equal(p.ok, true);
  assert.deepEqual(p.rows.map((r) => r.status), ["linked", "finished", "archived", "undeclared", "unreadable"]);
  assert.deepEqual([p.rows[2].date, p.rows[2].dateSource], [null, "unknown"], "an unknown date stays null, it is not filled in");
  assert.equal(p.rows[4].reason, "EACCES: permission denied");
  assert.deepEqual(p.summary.byStatus, { linked: 1, finished: 1, archived: 1, undeclared: 1, unreadable: 1 });
  assert.equal(p.summary.scanned, 50);
  assert.equal(p.summary.excluded, 1);
  assert.equal(planStatusWord({ state: "finished", finishedBy: "archive-dir" }), "archived");
  assert.equal(planStatusWord({ state: "finished", finishedBy: "status" }), "finished");
  const bad = shapePlans({ results: [{ root: "/nope", ok: false, reason: "not-a-directory", detail: "ENOENT" }] });
  assert.deepEqual(bad, { ok: false, error: "not-a-directory: ENOENT (/nope)" });
  assert.equal(shapePlans({ results: [] }).ok, false, "no result for the root is an error, not zero plans");
  const none = shapePlans({ results: [{ root: "/r", ok: true, empty: true, scanned: 12, plans: [], dropped: [], excluded: [] }] });
  assert.equal(none.ok, true);
  assert.deepEqual([none.rows.length, none.summary.scanned], [0, 12], "an empty result still names what was scanned");
});

test("phase 4b goals: a plans failure rides inside the goals detail and does not fail the goals tile", async () => {
  const m = createMachinery({ sources: { ...sources(), goals: async () => shapeGoals(GOAL_FILES, { ok: false, error: "plans exploded" }) } });
  const tile = await m.read();
  assert.equal(tile.goals.status, "ok");
  const page = await m.readDetail("goals");
  assert.equal(page.ok, true);
  assert.deepEqual(page.plans, { ok: false, error: "plans exploded" });
});

/* ---- History ---- */

const SNAP_OK = { ok: true, ageMs: 5, payload: { generatedAt: "2026-10-17T08:10:19.576Z", problems: 5, totals: { pass: 182, warn: 543, fail: 5, info: 100, note: 30, accepted: 3 },
  sections: [{ name: "State", pass: 0, warn: 1, fail: 0, info: 1, note: 0, accepted: 0 }, { name: "Delivery", pass: 4, warn: 2, fail: 3, accepted: 1 }] } };
const LOG_LINES = [
  "2026-10-17T07:36:28.915Z ran=1 rows=1254 actionable=142 notified=8 suppressed=134 ms=3453 run=7d8e4a8a",
  "this line is not a monitor line",
  '2026-10-17T08:08:28.626Z ran=1 rows=1254 actionable=0 notified=0 suppressed=0 ms=12 error="reconcile \\"broke\\"" run=20515ede',
];
const RUNS = [
  { ts: "2026-10-17T07:22:19.979Z", command: "release", outcome: "ok", duration_ms: 100344, origin: "interactive", kind: "command" },
  { ts: "2026-10-17T07:58:16.595Z", command: "release", outcome: "error", duration_ms: 125314, origin: "interactive", kind: "command" },
  { ts: "2026-10-17T08:00:00.000Z", command: "monitor", outcome: "ok", duration_ms: 5, origin: "interactive", kind: "command" },
  { ts: "2026-10-17T09:00:00.000Z", command: "release", outcome: "refused", duration_ms: 1, origin: "widget", kind: "command" },
];

test("phase 4b history doctor: a recorded snapshot gives its time, outcome and one row per section; a failed last run keeps the last good time; absence is attributable", () => {
  const d = shapeDoctorHistory(SNAP_OK);
  assert.equal(d.status, "recorded");
  assert.equal(d.at, "2026-10-17T08:10:19.576Z");
  assert.equal(d.outcome, "5 fail · 543 warn · 3 accepted · 182 pass");
  assert.deepEqual(d.rows.map((r) => [r.name, r.fail, r.warn, r.accepted, r.pass]), [["State", 0, 1, 0, 0], ["Delivery", 3, 2, 1, 4]]);
  assert.equal(d.summary.failing, true);
  assert.equal(d.command, HISTORY_COMMANDS.doctor);
  const failed = shapeDoctorHistory({ ok: false, reason: "doctor failed on its last run — boom", payload: { error: "boom", generatedAt: "2026-10-17T09:00:00.000Z", lastGoodAt: "2026-10-17T04:00:00.000Z", sections: null } });
  assert.equal(failed.status, "failed");
  assert.equal(failed.rows.length, 0, "a failed run has no sections to show");
  assert.equal(failed.summary.lastGoodAt, "2026-10-17T04:00:00.000Z");
  assert.match(failed.reason, /boom/);
  assert.deepEqual([shapeDoctorHistory({ ok: false, reason: "no snapshot yet — the monitor has not run since this was added" }).status, shapeDoctorHistory({ ok: false, reason: "snapshot is not valid JSON — a write was interrupted" }).status], ["none", "error"],
    "'never recorded' and 'recorded but unreadable' are different statuses");
  assert.match(shapeDoctorHistory({ ok: false, reason: "no snapshot yet — x" }).reason, /^no recorded run/);
  const hollow = shapeDoctorHistory({ ok: true, payload: { generatedAt: "x", sections: [] } });
  assert.equal(hollow.status, "error", "a snapshot with no sections is not a clean run");
  assert.equal(shapeDoctorHistory({ ok: true, payload: { generatedAt: "x" } }).status, "error", "sections missing altogether is also an error");
});

test("phase 4b history monitor: parses what logRun writes, newest first, capped; an error line is 'could not look'; an unmatched line is counted; a log nothing parses is a blind scan, not quiet", () => {
  assert.deepEqual(parseMonitorLine(LOG_LINES[0]), { at: "2026-10-17T07:36:28.915Z", rows: 1254, actionable: 142, notified: 8, suppressed: 134, ms: 3453, error: null, runId: "7d8e4a8a", raw: LOG_LINES[0] });
  assert.equal(parseMonitorLine(LOG_LINES[1]), null);
  assert.equal(parseMonitorLine(LOG_LINES[2]).error, 'reconcile "broke"', "the JSON-quoted error is decoded");
  assert.equal(parseMonitorLine("2026-10-17T07:36:28.915Z ran=1 rows=1 actionable=1 notified=1 suppressed=1 ms=1").runId, null, "a line from before run= existed still parses");
  const m = shapeMonitorHistory({ exists: true, lines: LOG_LINES });
  assert.equal(m.status, "recorded");
  assert.deepEqual(m.rows.map((r) => r.at), ["2026-10-17T08:08:28.626Z", "2026-10-17T07:36:28.915Z"], "newest first");
  assert.equal(m.outcome, 'could not look: reconcile "broke"');
  assert.deepEqual(m.summary, { runs: 2, notifiedRuns: 1, couldNotLook: 1, unparsedLines: 1, shown: 2, limit: HISTORY_ROWS });
  const many = Array.from({ length: HISTORY_ROWS + 5 }, (_, i) => `2026-10-17T${String(Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}:00.000Z ran=1 rows=1 actionable=1 notified=0 suppressed=1 ms=1`);
  const capped = shapeMonitorHistory({ exists: true, lines: many });
  assert.equal(capped.rows.length, HISTORY_ROWS);
  assert.equal(capped.summary.runs, HISTORY_ROWS + 5, "the cap limits the rows shown, not the count of runs");
  assert.equal(capped.rows[0].at, "2026-10-17T12:00:00.000Z", "the newest are the ones kept");
  const blind = shapeMonitorHistory({ exists: true, lines: ["garbage", "more garbage"] });
  assert.equal(blind.status, "error");
  assert.match(blind.reason, /2 lines and none match the format logRun writes.*gone blind/);
  assert.equal(shapeMonitorHistory({ exists: false, lines: [] }).status, "none");
  assert.match(shapeMonitorHistory({ exists: false, lines: [] }).reason, /^no recorded run/);
  assert.equal(shapeMonitorHistory({ exists: true, lines: [] }).status, "none", "an existing empty log is 'nothing recorded', stated");
  assert.equal(shapeMonitorHistory({ reason: "monitor.log could not be read: EACCES" }).status, "error");
});

test("phase 4b history release: only exit status and duration are recorded, so the part is 'partial' and says which gate is NOT; no run is 'none'; other commands are ignored", () => {
  const r = shapeReleaseHistory(RUNS);
  assert.equal(r.status, "partial", "recorded, but not the per-gate results the page was asked for");
  assert.deepEqual(r.rows.map((x) => [x.at, x.outcome]), [["2026-10-17T09:00:00.000Z", "refused"], ["2026-10-17T07:58:16.595Z", "error"], ["2026-10-17T07:22:19.979Z", "ok"]], "release runs only, newest first");
  assert.equal(r.rows.some((x) => x.at === "2026-10-17T08:00:00.000Z"), false, "a monitor run is not a release run");
  assert.deepEqual(r.summary, { runs: 3, nonZero: 2, shown: 3, limit: HISTORY_ROWS, gateResultsRecorded: false });
  assert.match(r.note, /Which gate passed or failed is not recorded/);
  assert.equal(r.outcome, "exited non-zero (refused)");
  assert.equal(r.command, HISTORY_COMMANDS.release);
  const none = shapeReleaseHistory([{ ts: "2026-10-17T08:00:00.000Z", command: "monitor", outcome: "ok" }]);
  assert.equal(none.status, "none");
  assert.match(none.reason, /release --check does not persist its result/);
  assert.equal(shapeReleaseHistory({ reason: "the command ledger could not be read: EACCES" }).reason, "the command ledger could not be read: EACCES");
  assert.equal(shapeReleaseHistory(null).status, "error");
});

test("phase 4b history: it is page-only -- not a tile block, one cached run, a part that cannot be read does not fail the others, and it runs nothing", async () => {
  let calls = 0;
  const src = { ...sources(), history: async () => { calls += 1; return shapeHistory({ doctor: SNAP_OK, monitor: { reason: "monitor.log could not be read: EACCES" }, release: RUNS }); } };
  const m = createMachinery({ sources: src });
  const tile = await m.read();
  assert.equal(tile.history, undefined, "the tile payload has no history block");
  assert.equal(JSON.stringify(tile).includes('"parts"'), false);
  const page = await m.readDetail("history");
  assert.equal(page.ok, true);
  assert.equal(page.headline, null);
  assert.deepEqual(page.parts.map((p) => [p.key, p.status]), [["doctor", "recorded"], ["monitor", "error"], ["release", "partial"]]);
  assert.deepEqual(page.summary, { withARecord: 2, of: 3, limit: HISTORY_ROWS });
  assert.equal(calls, 1, "the page read the run the tile read");
  const down = createMachinery({ sources: { ...sources(), history: async () => { throw new Error("history exploded"); } } });
  assert.deepEqual(await down.readDetail("history"), { ok: false, error: "history exploded" });
  assert.equal((await down.read()).claims.status, "ok", "and the tiles are untouched");
  const unconfigured = createMachinery({ sources: sources() });
  assert.deepEqual(await unconfigured.readDetail("history"), { ok: false, error: "the history source is not configured" });
});

test("phase 4b history: the default source READS only -- the commands it offers are strings, and nothing in the module spawns one", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../lib/report/machinery.mjs", import.meta.url), "utf8");
  assert.equal(/child_process|spawnSync|execFileSync|execSync|\bspawn\(/.test(src), false, "machinery.mjs must not be able to run release, monitor or doctor");
  assert.deepEqual(Object.keys(HISTORY_COMMANDS).sort(), ["doctor", "monitor", "release"]);
  assert.equal(HISTORY_COMMANDS.monitor, "propagate monitor --dry-run", "the monitor command offered is the dry run: a plain run notifies and writes");
});

/* ---- release history with the per-gate record (release-checks.jsonl) ---- */
const REC = (ts, over = {}) => ({ ts, version: "0.15.34", overall: "ready", exitCode: 0, gates: [
  { name: "version-manifests", status: "passed", detail: "four manifests agree" }, { name: "suite", status: "passed", detail: "1 pass" },
  { name: "make-public-check", status: "could-not-run", reason: "no identity map" }, { name: "stranger-install", status: "failed", detail: "doctor exited 1" }], ...over });
test("release history with a recorded run: status 'recorded', the last run's four gates, and the old caveat is gone", () => {
  const r = shapeReleaseHistory(RUNS, HISTORY_ROWS, { checks: [REC("2026-10-17T10:00:00.000Z", { overall: "blocked", exitCode: 1 })], bad: [], exists: true });
  assert.equal(r.status, "recorded");
  assert.equal(r.outcome, "BLOCKED · v0.15.34");
  assert.deepEqual(r.gates.map((g) => [g.name, g.status, g.detail]), [["version-manifests", "passed", "four manifests agree"], ["suite", "passed", "1 pass"], ["make-public-check", "could-not-run", "no identity map"], ["stranger-install", "failed", "doctor exited 1"]]);
  assert.doesNotMatch(String(r.note), /Which gate passed or failed is not recorded/);
  assert.equal(r.summary.gateResultsRecorded, true);
  assert.equal(r.rows[0].recorded, true);
  assert.equal(r.rows[0].gates.length, 4);
});
test("release history mixed: ledger runs before the record stay listed as 'exit status only' with why; a ledger row beside a record is the SAME run, not a second", () => {
  const checks = { checks: [REC("2026-10-17T09:59:50.000Z")], bad: [], exists: true };
  const runs = [...RUNS, { ts: "2026-10-17T10:00:00.000Z", command: "release", outcome: "ok", duration_ms: 90000, origin: "interactive", kind: "command" },
    { ts: "2026-10-17T11:00:00.000Z", command: "release", outcome: "error", duration_ms: 5, origin: "interactive", kind: "command" }];
  const r = shapeReleaseHistory(runs, HISTORY_ROWS, checks);
  assert.equal(r.rows.filter((x) => x.recorded).length, 1);
  assert.equal(r.rows.filter((x) => !x.recorded).length, 4, "3 older ledger runs + the 11:00 one with no record; the 10:00 ledger row is the recorded run");
  const old = r.rows.find((x) => x.at === "2026-10-17T07:22:19.979Z");
  assert.match(old.why, /ran before gate results were recorded \(2026-10-17\)/);
  assert.match(r.rows.find((x) => x.at === "2026-10-17T11:00:00.000Z").why, /no gate result was recorded for this run \(it ended before its gates finished, or it was a usage error\)/);
  assert.equal(r.status, "partial", "the newest run (11:00) has no gate result, so the page does not call itself recorded");
  assert.equal(r.gates.length, 4, "the last recorded run's gates are still shown");
});
test("release history: a corrupt line is a row with its reason and line number, never skipped; an unreadable file is a reason, never 'nothing recorded'", () => {
  const r = shapeReleaseHistory([], HISTORY_ROWS, { checks: [REC("2026-10-17T10:00:00.000Z")], bad: [{ line: 3, reason: "not JSON: Unexpected token" }], exists: true });
  assert.deepEqual(r.bad, [{ line: 3, reason: "not JSON: Unexpected token" }]);
  assert.equal(r.summary.unreadableLines, 1);
  const only = shapeReleaseHistory(RUNS, HISTORY_ROWS, { reason: "EACCES: permission denied" });
  assert.match(only.bad[0].reason, /release-checks\.jsonl could not be read: EACCES/);
  assert.notEqual(only.status, "none");
  const none = shapeReleaseHistory([], HISTORY_ROWS, { checks: [], bad: [], exists: false });
  assert.equal(none.status, "none");
});
test("shapeHistory feeds releaseChecks through: the page reads the file, not only the command ledger", () => {
  const h = shapeHistory({ doctor: SNAP_OK, monitor: { exists: false, lines: [] }, release: RUNS, releaseChecks: { checks: [REC("2026-10-17T10:00:00.000Z")], bad: [], exists: true } });
  const rel = h.detail.parts.find((p) => p.key === "release");
  assert.equal(rel.status, "recorded");
  assert.equal(rel.gates.length, 4);
});
