/**
 * instructions-gate.test.mjs — #218, the commit-time ratchet on the instruction budget.
 *
 * `instructionsGate` is a flag-shaped promise of safety twice over: "never writes" and "skipped is
 * never a pass". Per rule:safety-flag-needs-a-test each is asserted on the EFFECT (a snapshot of the
 * tree, the status field), not on the gate describing itself.
 *
 * Every fixture is a literal fake HOME + fake hub in a temp dir, and `runGit` is a hand-written fake
 * whose three views (disk = working tree, `HEAD:` and `:` = what git would show) are set separately,
 * because the whole subject is that those views differ. Do not refactor the hostile cases onto a shared
 * builder (rule:mutate-behind-the-fixture-builder).
 *
 * Mutations performed against this file are recorded in the report that accompanied it; each guard is
 * named in the test that pins it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { instructionsGate, createBudgetModel, instructionBudget } from "../../lib/report/instructions.mjs";
import { instructionsCmd } from "../../cli/instructions.mjs";
import { probeHubGate, checkHooks } from "../../lib/report/doctor/hooks.mjs";

const x = (n) => "x".repeat(n);

/** A fake home + fake hub. `hub/CLAUDE.md` is 100 chars; limit used below is 1000. */
function tree() {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "igate-")));
  const home = path.join(base, "home");
  const hub = path.join(base, "hub");
  mkdirSync(path.join(home, ".claude"), { recursive: true });
  mkdirSync(hub, { recursive: true });
  const w = (rel, text) => {
    const p = path.join(hub, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, text);
    return p;
  };
  w("CLAUDE.md", x(100));
  return { base, home, hub, w };
}

/** Everything under `dir`, as one string: names, sizes and bytes. A snapshot is a claim about writing. */
function snapshot(dir) {
  const rows = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else rows.push(`${p}\0${statSync(p).size}\0${readFileSync(p, "utf8")}`);
    }
  };
  walk(dir);
  return rows.join("\n");
}

/**
 * A fake git. `staged` = paths in the index diff; `head` / `index` = text per rel path (absent key =
 * absent at that ref). Records every call so tests can assert the gate only READ.
 */
function fakeGit({ staged, head = {}, index = {}, throwOn = null }) {
  const calls = [];
  const runGit = (args) => {
    calls.push(args);
    if (throwOn && throwOn(args)) throw new Error("fatal: simulated git failure");
    if (args[0] === "diff") return staged.join("\n");
    if (args[0] === "show") {
      const spec = args[1];
      const [ref, rel] = spec.startsWith("HEAD:") ? [head, spec.slice(5)] : [index, spec.slice(1)];
      if (rel in ref) return ref[rel];
      throw new Error(`fatal: path '${rel}' does not exist`);
    }
    if (args[0] === "ls-files") {
      const rels = args.slice(args.indexOf("--") + 1);
      if (rels.some((r) => r.startsWith("*"))) return Object.keys({ ...head, ...index }).filter((r) => /(CLAUDE|AGENTS|GEMINI)\.md$/.test(r)).join("\n");
      return rels.filter((r) => r in index).join("\n");
    }
    throw new Error(`unexpected git call: ${args.join(" ")}`);
  };
  return { runGit, calls };
}

const READ_ONLY_GIT = new Set(["diff", "show", "ls-files"]);
const common = (t) => ({ repoRoot: t.hub, home: t.home, roots: [t.hub], hubRoot: t.hub, minDirs: 1, registry: { entries: new Map(), limit: 1000 } });

test("a staged SHRINK of an over-gate folder passes, even though the folder is still over", () => {
  // Pins the "grew" comparison. Mutation: drop `r.total > b` and this goes red, because any
  // over-gate commit would then block regardless of direction.
  const t = tree();
  t.w("a/CLAUDE.md", x(1300)); // on disk = staged. total 1400 > 1000
  const g = fakeGit({ staged: ["a/CLAUDE.md"], head: { "a/CLAUDE.md": x(1500) }, index: { "a/CLAUDE.md": x(1300) } });
  const r = instructionsGate({ ...common(t), runGit: g.runGit });
  assert.equal(r.status, "pass", JSON.stringify(r.blocked));
  assert.equal(r.blocked.length, 0);
  assert.equal(r.measured, true, "it must have actually measured — a pass by fast path would prove nothing here");
  const a = r.allowed.find((e) => e.key === "a");
  assert.equal(a.before, 1600);
  assert.equal(a.now, 1400);
  assert.match(a.reason, /did not grow/);
});

test("growth that CROSSES the gate blocks, and names the folder, both totals, the limit and the file", () => {
  const t = tree();
  t.w("a/CLAUDE.md", x(1200));
  const g = fakeGit({ staged: ["a/CLAUDE.md"], head: { "a/CLAUDE.md": x(800) }, index: { "a/CLAUDE.md": x(1200) } });
  const r = instructionsGate({ ...common(t), runGit: g.runGit });
  assert.equal(r.status, "blocked");
  assert.equal(r.blocked.length, 1);
  const b = r.blocked[0];
  assert.equal(b.key, "a");
  assert.equal(b.before, 900);
  assert.equal(b.now, 1300);
  assert.equal(b.added, 400);
  assert.equal(b.threshold, 1000);
  assert.deepEqual(b.files.map((f) => [path.relative(t.hub, f.file), f.added]), [["a/CLAUDE.md", 400]]);
});

test("growth that stays UNDER the gate passes", () => {
  const t = tree();
  t.w("a/CLAUDE.md", x(500));
  const g = fakeGit({ staged: ["a/CLAUDE.md"], head: { "a/CLAUDE.md": x(300) }, index: { "a/CLAUDE.md": x(500) } });
  const r = instructionsGate({ ...common(t), runGit: g.runGit });
  assert.equal(r.status, "pass");
  assert.equal(r.measured, true);
  assert.equal(r.allowed.find((e) => e.key === "a").reason, "under the gate");
});

test("a NEW instruction file that lands over the gate blocks (absent at HEAD counts as empty)", () => {
  const t = tree();
  t.w("n/CLAUDE.md", x(1500));
  const g = fakeGit({ staged: ["n/CLAUDE.md"], head: {}, index: { "n/CLAUDE.md": x(1500) } });
  const r = instructionsGate({ ...common(t), runGit: g.runGit });
  assert.equal(r.status, "blocked");
  assert.equal(r.blocked[0].key, "n");
  assert.equal(r.blocked[0].before, 100, "HEAD view: only the ancestor hub CLAUDE.md loads; the new file is absent");
});

test("an EXCEPTED folder may grow inside its ceiling and blocks past it", () => {
  const t = tree();
  const reg = { entries: new Map([["a", { reason: "r", ceiling: 1500 }]]), limit: 1000 };
  t.w("a/CLAUDE.md", x(1300)); // total 1400, within 1500
  let g = fakeGit({ staged: ["a/CLAUDE.md"], head: { "a/CLAUDE.md": x(1200) }, index: { "a/CLAUDE.md": x(1300) } });
  let r = instructionsGate({ ...common(t), registry: reg, runGit: g.runGit });
  assert.equal(r.status, "pass", "growth inside the ceiling is what an exception buys");

  t.w("a/CLAUDE.md", x(1500)); // total 1600 > 1500
  g = fakeGit({ staged: ["a/CLAUDE.md"], head: { "a/CLAUDE.md": x(1300) }, index: { "a/CLAUDE.md": x(1500) } });
  r = instructionsGate({ ...common(t), registry: reg, runGit: g.runGit });
  assert.equal(r.status, "blocked");
  assert.equal(r.blocked[0].threshold, 1500, "the threshold is the excepted ceiling, not the gate");
  assert.equal(r.blocked[0].ceiling, 1500);
});

test("FAST PATH: no instruction file staged computes no budget at all (call count)", () => {
  // Mutation: delete the fast-path return and `calls` becomes 2, which this asserts against.
  const t = tree();
  let calls = 0;
  const budget = (o) => { calls++; return instructionBudget(o); };
  const g = fakeGit({ staged: ["src/app.mjs", "README.md", "docs/plan.md"], head: {}, index: {} });
  const r = instructionsGate({ ...common(t), runGit: g.runGit, budget });
  assert.equal(r.status, "pass");
  assert.equal(r.measured, false);
  assert.match(r.reason, /no instruction file staged/);
  assert.equal(calls, 0, "no budget may be computed for a commit that stages no instruction file");
  assert.equal(g.calls.filter((c) => c[0] === "show").length, 0, "and no staged content is read either");
});

test("an instruction file staged DOES measure, twice (HEAD and index)", () => {
  const t = tree();
  t.w("a/CLAUDE.md", x(10));
  let calls = 0;
  const budget = (o) => { calls++; return instructionBudget(o); };
  const g = fakeGit({ staged: ["a/CLAUDE.md"], head: { "a/CLAUDE.md": x(5) }, index: { "a/CLAUDE.md": x(10) } });
  instructionsGate({ ...common(t), runGit: g.runGit, budget });
  assert.equal(calls, 2);
});

test("a .md that an instruction file IMPORTS counts as an instruction file", () => {
  const t = tree();
  t.w("a/CLAUDE.md", "@notes/big.md\n");
  t.w("a/notes/big.md", x(1500));
  const g = fakeGit({
    staged: ["a/notes/big.md"],
    head: { "a/CLAUDE.md": "@notes/big.md\n", "a/notes/big.md": x(500) },
    index: { "a/CLAUDE.md": "@notes/big.md\n", "a/notes/big.md": x(1500) },
  });
  const r = instructionsGate({ ...common(t), runGit: g.runGit });
  assert.equal(r.measured, true, "an imported file loads at session start, so changing it is changing the budget");
  assert.equal(r.status, "blocked");
});

test("an unreadable index is SKIPPED with a reason, never a pass", () => {
  // Mutation: make `skip()` return a pass status and this goes red.
  const t = tree();
  const g = fakeGit({ staged: [], throwOn: (a) => a[0] === "diff" });
  const r = instructionsGate({ ...common(t), runGit: g.runGit });
  assert.equal(r.status, "skipped");
  assert.notEqual(r.status, "pass");
  assert.match(r.reason, /could not read staged paths/);
  assert.equal(r.skipped[0].notable, true);
});

test("a staged file that is in the index but cannot be READ is skipped, not treated as deleted", () => {
  const t = tree();
  t.w("a/CLAUDE.md", x(1500));
  const g = fakeGit({
    staged: ["a/CLAUDE.md"],
    head: { "a/CLAUDE.md": x(10) },
    index: { "a/CLAUDE.md": x(1500) },
    throwOn: (a) => a[0] === "show" && a[1] === ":a/CLAUDE.md", // the read fails; ls-files still lists it
  });
  const r = instructionsGate({ ...common(t), runGit: g.runGit });
  assert.equal(r.status, "skipped");
  assert.match(r.reason, /in the index but could not be read/);
});

test("a blind scan is SKIPPED, not a clean budget", () => {
  const t = tree();
  t.w("a/CLAUDE.md", x(5));
  const g = fakeGit({ staged: ["a/CLAUDE.md"], head: {}, index: { "a/CLAUDE.md": x(5) } });
  const r = instructionsGate({ ...common(t), minDirs: 50, runGit: g.runGit });
  assert.equal(r.status, "skipped");
  assert.match(r.reason, /gone blind/);
});

test("a DELETED instruction file does not block (and the confirmed absence is not a skip)", () => {
  const t = tree();
  // not on disk, absent from the index, present at HEAD
  const g = fakeGit({ staged: ["a/CLAUDE.md"], head: { "a/CLAUDE.md": x(1500) }, index: {} });
  const r = instructionsGate({ ...common(t), runGit: g.runGit });
  assert.equal(r.status, "pass");
  assert.equal(r.measured, true);
});

test("BYPASS is reported as bypassed, and git is never consulted", () => {
  // Mutation: ignore `bypass` and this goes red (runGit would be called and a status other than
  // "bypassed" returned).
  const t = tree();
  const g = fakeGit({ staged: ["a/CLAUDE.md"] });
  const r = instructionsGate({ ...common(t), bypass: true, runGit: g.runGit });
  assert.equal(r.bypassed, true);
  assert.equal(r.status, "bypassed");
  assert.equal(g.calls.length, 0);
});

test("the gate NEVER WRITES: tree snapshot identical before and after, and only read-only git verbs", () => {
  const t = tree();
  t.w("a/CLAUDE.md", x(1200));
  const before = snapshot(t.base);
  for (const scenario of [
    { staged: ["a/CLAUDE.md"], head: { "a/CLAUDE.md": x(800) }, index: { "a/CLAUDE.md": x(1200) } }, // blocked
    { staged: ["a/CLAUDE.md"], head: { "a/CLAUDE.md": x(1500) }, index: { "a/CLAUDE.md": x(1200) } }, // pass
    { staged: ["src/x.mjs"], head: {}, index: {} }, // fast path
    { staged: ["a/CLAUDE.md"], head: {}, index: {}, throwOn: () => true }, // skipped
  ]) {
    const g = fakeGit(scenario);
    instructionsGate({ ...common(t), runGit: g.runGit });
    instructionsGate({ ...common(t), runGit: g.runGit, bypass: true });
    for (const c of g.calls) assert.ok(READ_ONLY_GIT.has(c[0]), `non-read git verb used: ${c.join(" ")}`);
  }
  assert.equal(snapshot(t.base), before, "the gate changed the tree");
});

test("overlay seam: string = that text, null = absent, undefined = the disk; default is unchanged", () => {
  const t = tree();
  const p = t.w("a/CLAUDE.md", x(40));
  const total = (m) => m.loadSet(path.join(t.hub, "a")).total;
  assert.equal(total(createBudgetModel({ home: t.home })), 140);
  assert.equal(total(createBudgetModel({ home: t.home, readFile: () => undefined })), 140);
  assert.equal(total(createBudgetModel({ home: t.home, readFile: (a) => (a === p ? x(7) : undefined) })), 107);
  assert.equal(total(createBudgetModel({ home: t.home, readFile: (a) => (a === p ? null : undefined) })), 100);
});

test("against REAL git: stage a growth, the gate blocks it; unstage, it passes", () => {
  const t = tree();
  const git = (...a) => execFileSync("git", ["-C", t.hub, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  t.w("a/CLAUDE.md", x(800));
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const runGit = (a) => git(...a);

  t.w("a/CLAUDE.md", x(1200));
  git("add", "a/CLAUDE.md");
  const blocked = instructionsGate({ ...common(t), runGit });
  assert.equal(blocked.status, "blocked", JSON.stringify(blocked));
  assert.equal(blocked.blocked[0].key, "a");

  git("reset", "-q", "HEAD", "a/CLAUDE.md");
  const passed = instructionsGate({ ...common(t), runGit });
  assert.equal(passed.status, "pass");
  assert.equal(passed.measured, false, "nothing staged: fast path");
});

test("CLI exit codes: 0 pass, 1 blocked, 2 could not run, 0 bypassed", async () => {
  const t = tree();
  t.w("a/CLAUDE.md", x(1200));
  const lines = [];
  const base = { roots: [t.hub], registryFile: null, home: t.home, repoRoot: t.hub, minDirs: 1, err: (s) => lines.push(s), out: () => {} };

  const blockedGit = fakeGit({ staged: ["a/CLAUDE.md"], head: { "a/CLAUDE.md": x(1500) }, index: { "a/CLAUDE.md": x(1700) } });
  // registryFile null => limit falls back to DEFAULT_LIMIT (145000), so nothing is over; use a tiny tree check below instead.
  assert.equal(await instructionsCmd(["--gate"], { ...base, runGit: blockedGit.runGit, env: {} }), 0);

  const reg = path.join(t.hub, "scripts", "execution", "instruction-budget.yml");
  mkdirSync(path.dirname(reg), { recursive: true });
  writeFileSync(reg, "limit: 1000\nexceptions: {}\n");
  const grow = fakeGit({ staged: ["a/CLAUDE.md"], head: { "a/CLAUDE.md": x(800) }, index: { "a/CLAUDE.md": x(1200) } });
  lines.length = 0;
  assert.equal(await instructionsCmd(["--gate"], { ...base, registryFile: reg, runGit: grow.runGit, env: {} }), 1);
  assert.ok(lines.some((l) => /refusing commit/.test(l)));
  assert.ok(lines.some((l) => /a {2}900 -> 1,300 chars \(\+400\), limit 1,000/.test(l)), lines.join("\n"));
  assert.ok(lines.some((l) => /grew by 400/.test(l)));

  const broken = fakeGit({ staged: [], throwOn: () => true });
  lines.length = 0;
  assert.equal(await instructionsCmd(["--gate"], { ...base, registryFile: reg, runGit: broken.runGit, env: {} }), 2);
  assert.ok(lines.some((l) => /not a pass/.test(l)));

  lines.length = 0;
  assert.equal(await instructionsCmd(["--gate"], { ...base, registryFile: reg, runGit: grow.runGit, env: { GSTACK_HYGIENE_BYPASS: "1" } }), 0);
  assert.ok(lines.some((l) => /bypassed/.test(l)), "a bypass must be said, not silent");
});

/* ── doctor: the hub's gate is reported, amber when absent ─────────────────── */

function hubRepo({ config = "", hooks = {}, hooksDir = ".git/hooks" } = {}) {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "igate-hub-")));
  mkdirSync(path.join(base, ".git"), { recursive: true });
  if (config) writeFileSync(path.join(base, ".git", "config"), config);
  mkdirSync(path.join(base, hooksDir), { recursive: true });
  for (const [n, body] of Object.entries(hooks)) writeFileSync(path.join(base, hooksDir, n), body);
  return base;
}

test("probeHubGate: missing when no hook, missing when the hook lacks the gate, live when it runs it", () => {
  const none = probeHubGate(hubRepo());
  assert.equal(none.state, "missing");
  assert.match(none.detail, /no pre-commit/);

  const other = probeHubGate(hubRepo({ hooks: { "pre-commit": "#!/bin/sh\nnode x/cli.mjs caps --gate\n" } }));
  assert.equal(other.state, "missing");
  assert.match(other.detail, /does not run/);

  // a commented-out gate is documentation, not a gate
  const commented = probeHubGate(hubRepo({ hooks: { "pre-commit": "#!/bin/sh\n# node propagate/cli.mjs instructions --gate\nexit 0\n" } }));
  assert.equal(commented.state, "missing");

  const live = probeHubGate(hubRepo({
    config: "[core]\n\thooksPath = .githooks\n",
    hooksDir: ".githooks",
    hooks: { "pre-commit": "#!/bin/sh\nnode propagate/cli.mjs instructions --gate || exit 1\n" },
  }));
  assert.equal(live.state, "live");

  assert.equal(probeHubGate(path.join(os.tmpdir(), "igate-no-such-hub")).state, "no-repo");
});

test("checkHooks warns (amber, not a failure) when the hub gate is missing, and says nothing alarming when live", async () => {
  const entries = [];
  const r = {
    problems: 0,
    header() {},
    note() {},
    info: (l, d) => entries.push(["info", l, d]),
    warn: (l, d) => entries.push(["warn", l, d]),
    check: (l, ok, d) => { entries.push(["check", l, ok, d]); if (!ok) r.problems++; },
  };
  const empty = realpathSync(mkdtempSync(path.join(os.tmpdir(), "igate-roots-")));
  await checkHooks({ reporter: r, roots: [empty], hubRoot: hubRepo() });
  const w = entries.find((e) => e[1] === "hub instruction-budget gate");
  assert.equal(w[0], "warn");
  assert.match(w[2], /missing/);
  assert.equal(r.problems, 0, "amber must not change doctor's exit code");

  entries.length = 0;
  const live = hubRepo({ hooks: { "pre-commit": "#!/bin/sh\nnode propagate/cli.mjs instructions --gate\n" } });
  await checkHooks({ reporter: r, roots: [empty], hubRoot: live });
  assert.equal(entries.find((e) => e[1] === "hub instruction-budget gate")[0], "info");

  entries.length = 0;
  await checkHooks({ reporter: r, roots: [empty], hubRoot: null });
  assert.match(entries.find((e) => e[1] === "hub instruction-budget gate")[2], /not configured/);
});
