/**
 * instructions.mjs — the per-session instruction-budget model, its exceptions registry, the
 * doctor glue, `propagate instructions`, and `--calibrate`.
 *
 * Every fixture is a fake HOME built in a temp dir, so nothing here reads the author's
 * ~/.claude. Inputs are written as LITERAL files on purpose (rule:mutate-behind-the-fixture-builder):
 * the hostile cases — a rule whose YAML fails to parse, an @import inside a code span — must
 * reach the collector exactly as written, not through a helper that would tidy them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createBudgetModel,
  instructionBudget,
  stripBlockComments,
  extractImports,
  ruleScope,
  parseBudgetRegistry,
  evaluateBudget,
  calibrate,
  DEFAULT_LIMIT,
} from "../../lib/report/instructions.mjs";
import { checkInstructions } from "../../lib/report/doctor/instructions.mjs";
import { Reporter } from "../../lib/report/doctor/reporter.mjs";
import { EXPECTATIONS, evaluateExpectations, detectVanishedKeys } from "../../lib/report/metrics.mjs";
import { instructionsCmd } from "../../commands/instructions.mjs";

/** A fake home; returns helpers. `x(n)` is n chars of filler so totals are exact. */
function fixture() {
  const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), "instr-")));
  const w = (rel, text) => {
    const p = path.join(home, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, text);
    return p;
  };
  return { home, w, p: (rel) => path.join(home, rel) };
}
const x = (n) => "x".repeat(n);
const MODEL = (home, extra = {}) => createBudgetModel({ home, managedDir: null, ...extra });
const BUDGET = (f, o = {}) => instructionBudget({ home: f.home, managedDir: null, minDirs: 1, ...o });

// ── the measurement ──────────────────────────────────────────────────────────

test("two chains: the worst directory is the one whose chain is longer, and totals are exact", () => {
  const f = fixture();
  f.w(".claude/CLAUDE.md", x(100));
  f.w("ws/CLAUDE.md", x(1000));
  f.w("ws/deep/app/CLAUDE.md", x(500)); // ancestor ws/CLAUDE.md also loads
  f.w("other/CLAUDE.md", x(2000));
  const b = BUDGET(f, { dirs: [f.p("ws"), f.p("ws/deep/app"), f.p("other")] });
  const by = Object.fromEntries(b.dirs.map((r) => [path.relative(f.home, r.dir), r.total]));
  assert.equal(by["ws"], 1100);
  assert.equal(by["ws/deep/app"], 1600, "child + ancestor + user");
  assert.equal(by["other"], 2100);
  assert.equal(b.worst_dir, f.p("other"));
  assert.equal(b.max, 2100);
  // the deeper chain wins when it is bigger
  f.w("ws/CLAUDE.md", x(5000));
  const b2 = BUDGET(f, { dirs: [f.p("ws"), f.p("ws/deep/app"), f.p("other")] });
  assert.equal(b2.worst_dir, f.p("ws/deep/app"));
  assert.equal(b2.max, 5600);
  assert.equal(b2.dirs[0].biggest.chars, 5000, "names the biggest file in the chain");
});

test("frontmatter and block comments are not counted; the user CLAUDE.md and user rules are", () => {
  const f = fixture();
  f.w(".claude/CLAUDE.md", `---\nname: z\n---\n${x(10)}`);
  f.w(".claude/rules/a.md", `<!-- a maintainer note\nthat spans two lines -->\n${x(20)}`);
  f.w(".claude/rules/sub/b.md", x(30)); // recursive walk
  f.w("ws/CLAUDE.md", x(40));
  const ls = MODEL(f.home).loadSet(f.p("ws"));
  assert.equal(ls.total, 10 + 20 + 30 + 40);
  assert.equal(stripBlockComments("<!-- c -->\nkeep"), "keep");
  assert.equal(stripBlockComments("```\n<!-- inside a fence -->\n```").includes("inside a fence"), true, "comments inside fences are kept");
  assert.equal(stripBlockComments("text <!-- inline --> more").includes("inline"), true, "inline comments are kept");
});

test("@import: recursive, relative to the importer, deduped; code spans, fences, quotes, emails and @scope tokens are not imports", () => {
  const f = fixture();
  f.w("ws/CLAUDE.md", [
    "See @docs/a.md for more.",
    "A code span `see @docs/nope.md here` is not an import, nor is an email me@docs/a.md.",
    'Quoted "@docs/quoted.md" is skipped. A scope mention @scope/pkg and @someone are ignored.',
    "Escaped: @docs/with\\ space.md",
    "```",
    "@docs/fenced.md",
    "```",
  ].join("\n"));
  f.w("ws/docs/a.md", `${x(100)}\n@b.md`); // relative to a.md, not to CLAUDE.md
  f.w("ws/docs/b.md", x(50));
  f.w("ws/docs/nope.md", x(7000));
  f.w("ws/docs/quoted.md", x(7000));
  f.w("ws/docs/fenced.md", x(7000));
  f.w("ws/docs/with space.md", x(3));
  const ls = MODEL(f.home).loadSet(f.p("ws"));
  const claude = ls.files.find((q) => q.file.endsWith("ws/CLAUDE.md")).chars;
  assert.equal(ls.total, claude + (100 + "\n@b.md".length) + 50 + 3, "a.md, b.md (via a.md) and the escaped-space file; nothing else");
  assert.deepEqual(extractImports("x `a @no b` y @yes z"), ["yes"]);
  assert.deepEqual(extractImports('"@no" a@b.c @ok.md'), ["ok.md"]);
  assert.equal(ls.notes.some((nn) => /not found/.test(nn)), false, "@scope tokens are ignored, not flagged");
});

test("@import: a missing path-like target is stated; a cycle terminates; depth is bounded", () => {
  const f = fixture();
  f.w("ws/CLAUDE.md", "@gone.md and @loop.md");
  f.w("ws/loop.md", `${x(5)}\n@CLAUDE.md`); // cycle back to the importer
  const ls = MODEL(f.home).loadSet(f.p("ws"));
  assert.ok(ls.notes.some((nn) => /import not found: @gone\.md/.test(nn)));
  assert.equal(ls.files.filter((q) => q.file.endsWith("CLAUDE.md")).length, 1, "cycle: counted once");
  // a chain deeper than the hop limit stops and says so
  for (let i = 0; i < 8; i++) f.w(`chain/c${i}.md`, `${x(1)} @c${i + 1}.md`);
  f.w("chain/CLAUDE.md", "@c0.md");
  const deep = MODEL(f.home).loadSet(f.p("chain"));
  assert.ok(deep.notes.some((nn) => /import depth \d reached/.test(nn)));
  assert.ok(deep.files.length < 10);
});

test("project .claude/rules: counted without paths:, not counted with paths:; a rule whose YAML fails counts as always-loaded", () => {
  const f = fixture();
  f.w("ws/CLAUDE.md", x(10));
  f.w("ws/.claude/rules/plain.md", x(100));
  f.w("ws/.claude/rules/scoped.md", `---\npaths:\n  - "**/*.test.ts"\n---\n${x(1000)}`);
  f.w("ws/.claude/rules/broken.md", `---\npaths: [unclosed\n  : :\n---\n${x(7)}`);
  const ls = MODEL(f.home).loadSet(f.p("ws"));
  assert.equal(ls.total, 10 + 100 + (`${x(7)}`.length), "plain + broken-YAML counted, scoped not");
  assert.ok(ls.notes.some((nn) => /does not parse, counted as always-loaded.*broken\.md/.test(nn)));
  assert.deepEqual(ruleScope("---\npaths:\n  - a\n---\nb"), { scoped: true, yamlFailed: false });
  assert.deepEqual(ruleScope("---\npaths: []\n---\nb"), { scoped: false, yamlFailed: false }, "an empty list scopes nothing");
  assert.equal(ruleScope("---\npaths: [oops\n---\nb").yamlFailed, true);
});

test("claudeMdExcludes: real ** globs, merged across layers, matched on the symlink path AND the realpath", () => {
  const f = fixture();
  // The user rules dir is a SYMLINK to a store elsewhere, as in the real tree.
  f.w("store/rules/keep.md", x(10));
  f.w("store/rules/conventions/long.md", x(1000));
  f.w("store/rules/_TODO.md", x(500));
  mkdirSync(f.p(".claude"), { recursive: true });
  symlinkSync(f.p("store/rules"), f.p(".claude/rules"));
  f.w("ws/CLAUDE.md", x(1));
  f.w(".claude/settings.json", JSON.stringify({ claudeMdExcludes: [`${f.home}/store/rules/conventions/**`] })); // the REALPATH form
  f.w("ws/.claude/settings.local.json", JSON.stringify({ claudeMdExcludes: ["**/_TODO.md"] })); // another layer, relative glob
  const ls = MODEL(f.home).loadSet(f.p("ws"));
  assert.equal(ls.total, 10 + 1, "conventions/** (realpath pattern) and **/_TODO.md (project layer) both excluded");
  assert.equal(ls.excluded_chars, 1500);
  // and the symlink-path form of the same pattern works too
  f.w(".claude/settings.json", JSON.stringify({ claudeMdExcludes: [`${f.home}/.claude/rules/conventions/**`] }));
  const ls2 = MODEL(f.home).loadSet(f.p("ws"));
  assert.equal(ls2.excluded_chars, 1500);
  // with no excludes at all, nothing is silently dropped
  f.w(".claude/settings.json", "{}");
  f.w("ws/.claude/settings.local.json", "{}");
  assert.equal(MODEL(f.home).loadSet(f.p("ws")).total, 10 + 1 + 1000 + 500);
});

test("settings.json missing or unreadable: stated in notes, totals still produced", () => {
  const f = fixture();
  f.w(".claude/CLAUDE.md", x(10));
  f.w("ws/CLAUDE.md", x(5));
  const b = BUDGET(f, { dirs: [f.p("ws")] });
  assert.equal(b.status, "ok");
  assert.ok(b.notes.some((nn) => /settings\.json not found — claudeMdExcludes NOT applied/.test(nn)));
  f.w(".claude/settings.json", "{ not json");
  const b2 = BUDGET(f, { dirs: [f.p("ws")] });
  assert.ok(b2.notes.some((nn) => /not readable JSON.*NOT applied/.test(nn)));
  assert.equal(b2.max, 15);
});

test("the blind floor: fewer owning directories than the floor is 'blind', never a clean zero", () => {
  const f = fixture();
  const none = instructionBudget({ home: f.home, managedDir: null, roots: [f.p("empty")], minDirs: 20 });
  assert.equal(none.status, "roots-missing");
  mkdirSync(f.p("ws"), { recursive: true });
  f.w("ws/CLAUDE.md", "x");
  const few = instructionBudget({ home: f.home, managedDir: null, roots: [f.p("ws")], minDirs: 20 });
  assert.equal(few.status, "blind");
  assert.match(few.reason, /scan has gone blind, it has not found nothing/);
});

test("population is derived from the walk: every directory owning a CLAUDE.md, .claude/CLAUDE.md attributed to its parent", () => {
  const f = fixture();
  f.w("r/a/CLAUDE.md", "x");
  f.w("r/b/.claude/CLAUDE.md", "y");
  f.w("r/c/node_modules/CLAUDE.md", "z");
  const b = instructionBudget({ home: f.home, managedDir: null, roots: [f.p("r")], minDirs: 1 });
  assert.deepEqual(b.dirs.map((d) => path.relative(f.p("r"), d.dir)).sort(), ["a", "b"]);
});

// ── the registry and the verdicts ────────────────────────────────────────────

const REG = (obj) => parseBudgetRegistry(obj);
test("registry: malformed entries are problems, not silently dropped", () => {
  assert.ok(REG("exceptions:\n  a:\n    ceiling: 5\n").problems.some((p) => /missing `reason:`/.test(p)));
  assert.ok(REG("exceptions:\n  a:\n    reason: r\n").problems.some((p) => /ceiling/.test(p)));
  assert.ok(REG("[1, 2]").problems.length);
  assert.ok(REG("limit: -3\n").problems.length);
  const ok = REG("limit: 100\nexceptions:\n  a/b:\n    reason: why\n    ceiling: 150\n");
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.limit, 100);
  assert.equal(ok.entries.get("a/b").ceiling, 150);
});

test("exceptions: listed-over is excepted; unlisted-over fails; listed-under is stale; orphan is stale; over-ceiling fails", () => {
  const f = fixture();
  const hub = f.home;
  f.w("over/CLAUDE.md", x(300)); // 300
  f.w("excepted/CLAUDE.md", x(300));
  f.w("under/CLAUDE.md", x(10));
  f.w("grown/CLAUDE.md", x(400));
  const b = BUDGET(f, { dirs: ["over", "excepted", "under", "grown"].map((d) => f.p(d)), limit: 100 });
  const entries = REG(
    [
      "exceptions:",
      "  excepted: {reason: big, ceiling: 300}",
      "  under: {reason: was big, ceiling: 300}",
      "  gone: {reason: deleted, ceiling: 300}",
      "  grown: {reason: big, ceiling: 300}",
    ].join("\n"),
  ).entries;
  const ev = evaluateBudget(b, entries, { hubRoot: hub, limit: 100 });
  assert.deepEqual(ev.unexcepted_over.map((u) => path.basename(u.dir)), ["over"]);
  assert.deepEqual(ev.stale.map((s) => s.key).sort(), ["gone", "under"]);
  assert.match(ev.stale.find((s) => s.key === "gone").reason, /directory is gone/);
  assert.match(ev.stale.find((s) => s.key === "under").reason, /remove the entry/);
  assert.deepEqual(ev.over_ceiling.map((o) => path.basename(o.dir)), ["grown"]);
  assert.equal(ev.excepted, 2, "excepted + grown are listed; 'over' is not");
  assert.equal(ev.worst_unexcepted.dir, f.p("over"), "worst UNEXCEPTED ignores the bigger listed dirs");
  assert.equal(ev.worst.dir, f.p("grown"), "worst overall is the biggest, listed or not");
  // an orphan whose directory exists but no longer owns a CLAUDE.md says so
  mkdirSync(f.p("bare"), { recursive: true });
  const ev2 = evaluateBudget(b, REG("exceptions:\n  bare: {reason: r, ceiling: 5}\n").entries, { hubRoot: hub, limit: 100 });
  assert.match(ev2.stale[0].reason, /no longer owns a CLAUDE\.md/);
});

// ── doctor glue ──────────────────────────────────────────────────────────────

function glue(f, registryText, opts = {}) {
  let registryFile = null;
  if (registryText !== null) registryFile = f.w("scripts/execution/instruction-budget.yml", registryText);
  const reporter = new Reporter();
  const r = checkInstructions({ reporter, roots: [f.p("ws")], registryFile: opts.registryFile ?? registryFile, home: f.home, managedDir: null, minDirs: opts.minDirs ?? 1 });
  return { r, reporter };
}

test("doctor glue: no registry -> skipped as INFO, all keys still emitted (as null), nothing fails", () => {
  const f = fixture();
  f.w("ws/CLAUDE.md", x(500));
  const { r, reporter } = glue(f, null);
  assert.deepEqual(Object.keys(r.metrics).sort(), ["instructions.chars.max", "instructions.over_ceiling", "instructions.stale_exceptions", "instructions.unexcepted_over"]);
  assert.ok(Object.values(r.metrics).every((v) => v === null));
  assert.equal(reporter.problems, 0);
  assert.match(reporter.entriesOfKind("info")[0].detail, /skipped — no exceptions registry.*not measured, which is different from within budget/i);
  // a configured-but-missing registry is the same: skipped, stated
  const g2 = glue(f, null, { registryFile: f.p("nope.yml") });
  assert.match(g2.reporter.entriesOfKind("info")[0].detail, /does not exist/);
  assert.equal(g2.reporter.problems, 0);
  // and null passes the expectations while a MISSING key fails (a collector that stopped)
  assert.deepEqual(evaluateExpectations({ ...cleanForInstructions(), ...r.metrics }).filter((v) => v.key.startsWith("instructions.")), []);
});

test("doctor glue: the floor applies only when the registry resolves", () => {
  const f = fixture();
  f.w("ws/CLAUDE.md", x(500));
  const { r, reporter } = glue(f, "limit: 100\nexceptions: {}\n", { minDirs: 20 });
  assert.equal(reporter.problems, 1, "blind scan is a failing check, never a pass");
  assert.equal(reporter.entriesOfKind("fail")[0].label, "instruction budget scan covers the tree");
  assert.match(reporter.entriesOfKind("fail")[0].detail, /gone blind/);
  assert.equal(r.metrics["instructions.unexcepted_over"], null);
  // the same tree with no registry: no floor, no failure
  const g = glue(f, null, { minDirs: 20 });
  assert.equal(g.reporter.problems, 0);
});

test("doctor glue: metrics, context and the two info lines (worst UNEXCEPTED with headroom, worst overall)", () => {
  const f = fixture();
  f.w("ws/a/CLAUDE.md", x(700)); // excepted
  f.w("ws/b/CLAUDE.md", x(300)); // unexcepted, over
  f.w("ws/c/CLAUDE.md", x(40)); // under
  f.w("ws/d/CLAUDE.md", x(10)); // listed but under -> stale
  const { r, reporter } = glue(
    f,
    "limit: 100\nexceptions:\n  ws/a: {reason: big, ceiling: 600}\n  ws/d: {reason: was big, ceiling: 900}\n",
  );
  // minDirs=1 floor satisfied; roots = ws, which owns 4 dirs
  assert.equal(r.metrics["instructions.unexcepted_over"], 1);
  assert.equal(r.metrics["instructions.stale_exceptions"], 1);
  assert.equal(r.metrics["instructions.over_ceiling"], 1, "a is 700 > ceiling 600");
  assert.equal(r.metrics["instructions.chars.max"], 700);
  assert.match(r.context.unexcepted[0], /ws\/b 300 \(\+200\)/);
  const infos = reporter.entriesOfKind("info").map((e) => `${e.label} ${e.detail}`);
  assert.match(infos[0], /worst unexcepted: ws\/b 300 \/ 100 \(\+200 OVER\).*biggest in chain: ws\/b\/CLAUDE\.md 300.*2 dir\(s\) over, 1 excepted/);
  assert.match(infos[1], /worst overall\)\s+ws\/a 700 chars \(\+600 over 100, excepted\)/);
  // violations flow through EXPECTATIONS with the offending dirs as detail
  const v = evaluateExpectations({ ...cleanForInstructions(), ...r.metrics }, EXPECTATIONS, { instructionsContext: r.context });
  const byKey = Object.fromEntries(v.map((q) => [q.key, q]));
  assert.match(byKey["instructions.unexcepted_over"].detail, /ws\/b 300/);
  assert.match(byKey["instructions.stale_exceptions"].detail, /ws\/d: now 40|ws\/d: now/);
  assert.match(byKey["instructions.over_ceiling"].detail, /ws\/a 700 > ceiling 600/);
  assert.match(byKey["instructions.unexcepted_over"].basis, /2026-10-02/);
  assert.match(byKey["instructions.unexcepted_over"].basis, /harness/);
});

test("doctor glue: a malformed registry fails a check (and still emits the keys)", () => {
  const f = fixture();
  f.w("ws/CLAUDE.md", x(5));
  const { r, reporter } = glue(f, "exceptions:\n  a: {ceiling: 5}\n");
  assert.equal(reporter.problems, 1);
  assert.equal(reporter.entriesOfKind("fail")[0].label, "instruction-budget registry parses");
  assert.match(reporter.entriesOfKind("fail")[0].detail, /missing `reason:`/);
  assert.equal("instructions.unexcepted_over" in r.metrics, true);
});

test("vanished-key guard: an instructions key present before and absent now is reported", () => {
  const before = { "instructions.unexcepted_over": 0, "instructions.stale_exceptions": 0, "instructions.over_ceiling": 0 };
  assert.deepEqual(detectVanishedKeys({}, before).sort(), Object.keys(before).sort());
  assert.deepEqual(detectVanishedKeys({ ...before, "instructions.unexcepted_over": null }, before), [], "null is a value (a stated skip), not a vanished key");
});

function cleanForInstructions() {
  return {
    "workspaces.discovered": 1,
    "sidecars.loaded": 3,
    "sidecars.rejected": 0,
    "sidecars.problems": 0,
    "ledger.unknown_types": 0,
    "ledger.malformed": 0,
    "graph.cycles": 0,
    "graph.duplicate_pairs": 0,
    "rows.open": 5,
    "decisions.entries": 2,
    "decisions.with_tokens": 2,
    "plist.watchpaths": 1,
    "state.tracked_files": 10,
    "doctor.duration_ms": 450,
    "docs.supersession_prose_only": 0,
    "docs.supersedes_unresolvable": 0,
  };
}

// ── `propagate instructions` ─────────────────────────────────────────────────

test("instructions command: --json carries every directory, the evaluation and the scan definition", async () => {
  const f = fixture();
  f.w(".claude/CLAUDE.md", x(10));
  f.w("ws/a/CLAUDE.md", x(500));
  f.w("ws/b/CLAUDE.md", x(1));
  const reg = f.w("scripts/execution/instruction-budget.yml", "limit: 100\nexceptions:\n  ws/a: {reason: big, ceiling: 510}\n");
  const lines = [];
  // minDirs is not injectable through the command (the floor is the production one), so this
  // fixture is also the proof that a tiny tree is reported blind with exit 2.
  const code = await instructionsCmd(["--json"], { roots: [f.p("ws")], registryFile: reg, home: f.home, out: (s) => lines.push(s) });
  assert.equal(code, 2);
  const j = JSON.parse(lines.join("\n"));
  assert.equal(j.status, "blind");
  assert.match(j.reason, /gone blind/);
  assert.equal(j.limit, 100);
  assert.ok(j.scan.limits.includes("depth 6"));
});

test("instructions command: a tree at the floor lists every dir with excepted/ceiling and exits 0", async () => {
  const f = fixture();
  f.w(".claude/CLAUDE.md", x(10));
  for (let i = 0; i < 20; i++) f.w(`ws/p${i}/CLAUDE.md`, x(i === 0 ? 500 : 1));
  const reg = f.w("scripts/execution/instruction-budget.yml", "limit: 100\nexceptions:\n  ws/p0: {reason: big, ceiling: 510}\n");
  const lines = [];
  const code = await instructionsCmd(["--json"], { roots: [f.p("ws")], registryFile: reg, home: f.home, out: (s) => lines.push(s) });
  assert.equal(code, 0);
  const j = JSON.parse(lines.join("\n"));
  assert.equal(j.dirs.length, 20);
  const p0 = j.dirs.find((d) => d.dir.endsWith("ws/p0"));
  assert.equal(p0.excepted, true);
  assert.equal(p0.ceiling, 510);
  assert.equal(j.evaluation.unexcepted_over.length, 0);
  const text = [];
  await instructionsCmd([], { roots: [f.p("ws")], registryFile: reg, home: f.home, out: (s) => text.push(s) });
  assert.match(text.join("\n").replace(/\x1b\[[0-9;]*m/g, ""), /excepted .*ws\/p0/);
});

// ── calibration ──────────────────────────────────────────────────────────────

function logOf(f, rows) {
  return f.w("log.jsonl", rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

test("calibrate: a set comparison — a matching session passes; extra and missing files are NAMED, not just counted", () => {
  const f = fixture();
  const user = f.w(".claude/CLAUDE.md", x(10));
  const rule = f.w(".claude/rules/r.md", x(10));
  f.w(".claude/rules/scoped.md", `---\npaths:\n  - "**/*.ts"\n---\n${x(5)}`);
  const ws = f.w("ws/CLAUDE.md", x(10));
  const model = MODEL(f.home);
  const row = (session_id, file_path, load_reason = "session_start") => ({ session_id, cwd: f.p("ws"), file_path, load_reason, logged_at: "2026-10-02T00:00:00Z" });
  const good = calibrate({ logPath: logOf(f, [row("s1", user), row("s1", rule), row("s1", ws), row("s1", f.p("ws/sub/CLAUDE.md"), "nested_traversal")]), model });
  assert.equal(good.status, "ok");
  assert.equal(good.mismatches, 0, "later-load reasons are not part of the session-start set");
  // same TOTAL file count, different files: a totals comparison would pass this
  const swapped = calibrate({ logPath: logOf(f, [row("s2", user), row("s2", f.p(".claude/rules/scoped.md")), row("s2", ws)]), model });
  assert.equal(swapped.mismatches, 1);
  const r = swapped.results[0];
  assert.equal(r.predicted, r.logged, "equal counts");
  assert.deepEqual(r.missing, [rule]);
  assert.deepEqual(r.extra, [f.p(".claude/rules/scoped.md")]);
});

test("calibrate: no log, an empty log, and a session with no cwd are stated, never a pass", () => {
  const f = fixture();
  const model = MODEL(f.home);
  assert.equal(calibrate({ logPath: f.p("absent.jsonl"), model }).status, "no-log");
  const empty = calibrate({ logPath: f.w("e.jsonl", "\nnot json\n"), model });
  assert.equal(empty.status, "empty");
  const nocwd = calibrate({ logPath: f.w("c.jsonl", JSON.stringify({ session_id: "s", file_path: "/x", load_reason: "session_start" }) + "\n"), model });
  assert.equal(nocwd.mismatches, 1);
  assert.match(nocwd.results[0].error, /no cwd/);
});

test("calibrate: a log over the byte cap is read tail-only, and the cap is stated", () => {
  const f = fixture();
  f.w(".claude/CLAUDE.md", x(1));
  const rows = [];
  for (let i = 0; i < 200; i++) rows.push({ session_id: `s${i}`, cwd: f.home, file_path: f.p(".claude/CLAUDE.md"), load_reason: "session_start", logged_at: `2026-10-02T00:${String(i % 60).padStart(2, "0")}:00Z` });
  const r = calibrate({ logPath: logOf(f, rows), model: MODEL(f.home), maxBytes: 2000 });
  assert.equal(r.truncated, true);
  assert.ok(r.sessions < 200 && r.sessions > 0);
  assert.equal(r.badLines, 0, "the partial first line is dropped, not counted as a parse failure");
  const capped = calibrate({ logPath: logOf(f, rows), model: MODEL(f.home), maxSessions: 5 });
  assert.equal(capped.capped, true);
  assert.equal(capped.sessions, 5);
});

test("calibrate: replays the real T1 log shape (session_start / path_glob_match / nested_traversal)", () => {
  const f = fixture();
  const user = f.w(".claude/CLAUDE.md", x(10));
  const proj = f.w("ws/CLAUDE.md", x(10));
  const base = { session_id: "t1", cwd: f.p("ws"), hook_event_name: "InstructionsLoaded", logged_at: "2026-10-02T05:20:36.250Z" };
  const log = logOf(f, [
    { ...base, file_path: user, memory_type: "User", load_reason: "session_start" },
    { ...base, file_path: proj, memory_type: "Project", load_reason: "session_start" },
    { ...base, file_path: f.p("ws/pkg.json"), memory_type: "User", load_reason: "path_glob_match", globs: ["**/package.json"], trigger_file_path: f.p("ws/package.json") },
    { ...base, file_path: f.p("ws/sub/CLAUDE.md"), memory_type: "Project", load_reason: "nested_traversal", trigger_file_path: f.p("ws/sub/x.ts") },
  ]);
  assert.equal(calibrate({ logPath: log, model: MODEL(f.home) }).mismatches, 0);
});

test("DEFAULT_LIMIT is the 145,000 gate (5k under the observed 150,000)", () => {
  assert.equal(DEFAULT_LIMIT, 145000);
});
