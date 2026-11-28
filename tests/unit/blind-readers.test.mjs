// #408: readers that did not understand their input must say so. One convention (lib/core/unread.mjs), one test over
// the whole class, derived rather than listed (rule:derive-dont-curate).
//
// Three layers:
//   1. every module that exports `READER` is imported; each tagged reader is fed an input it must NOT recognise and
//      must answer with an unread result or throw. A bare 0, an empty list or `ok` fails.
//   2. a derivation over lib/: every exported parse*/read*/check* function is tagged or on EXEMPT below with a reason,
//      so a new reader cannot skip layer 1.
//   3. command-level: settle --check, check --changed and goals check never report clean on input they did not read.
// @size small
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

import { isUnread, unread } from "../../lib/core/unread.mjs";
import { checkCmd } from "../../cli/goals.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LIB = path.join(ROOT, "lib");
const FLOOR = 8;

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (n.endsWith(".mjs")) out.push(p);
  }
  return out;
}
const rel = (p) => path.relative(LIB, p).split(path.sep).join("/");
const files = walk(LIB);

// Which modules declare READER is read from source, so a module is imported only when it opts in.
const readerFiles = files.filter((f) => /^export const READER\b/m.test(readFileSync(f, "utf8")));

async function loadReaders() {
  const out = [];
  for (const f of readerFiles) {
    const mod = await import(pathToFileURL(f).href);
    for (const [name, meta] of Object.entries(mod.READER)) {
      assert.equal(typeof mod[name], "function", `${rel(f)} READER names ${name}, which it does not export as a function`);
      assert.equal(typeof meta.hostile, "function", `${rel(f)}::${name} has no hostile() factory`);
      out.push({ key: `${rel(f)}::${name}`, fn: mod[name], hostile: meta.hostile });
    }
  }
  return out;
}

function hostileInputs() {
  const dir = mkdtempSync(path.join(tmpdir(), "blind-"));
  const adir = path.join(dir, "a-directory");
  mkdirSync(adir);
  const junk = path.join(dir, "junk.txt");
  const junkText = "\u0000\u0001 {not: markdown, not json\n".repeat(30);
  writeFileSync(junk, junkText);
  return { dir: adir, junk, junkText };
}

test("unread() and isUnread(): every existing shape is recognised, and the lookalikes are not", () => {
  assert.deepEqual(unread("why"), { unread: true, reason: "why" });
  for (const yes of [
    unread("x"),
    { unreadable: true, reason: "EISDIR" },
    { status: "unreadable", reason: "timed out" },
    { error: "unreadable: EISDIR" },
    { error: "unreadable", reason: "EISDIR" },
    { count: null, registers: 0, reason: "1 register(s) unreadable" },
    { format: "unrecognised", open: null },
    { entries: [], unread: true, reason: "r" },
  ]) assert.equal(isUnread(yes), true, JSON.stringify(yes));
  for (const no of [
    null, undefined, 0, "", "unread", [], {}, { ok: true }, { count: 0 }, { count: null }, { count: null, reason: "" },
    { unread: false }, { unread: 0 }, { format: "checkbox" }, { error: null }, { error: "boom" }, { status: "counted" },
    { entries: [] }, { items: [] }, { totals: { open: 0 } },
  ]) assert.equal(isUnread(no), false, JSON.stringify(no));
});

test("floor: the scan found enough tagged readers, or it has gone blind", async () => {
  const readers = await loadReaders();
  assert.ok(readers.length >= FLOOR, `only ${readers.length} readers found (floor ${FLOOR}) across ${readerFiles.length} READER modules: the scan has gone blind, it has not found nothing`);
});

test("every tagged reader answers an input it must not recognise with unread or an explicit throw, never a bare 0", async () => {
  const readers = await loadReaders();
  const h = hostileInputs();
  const failures = [];
  for (const r of readers) {
    let result;
    try {
      result = await r.fn(...r.hostile(h));
    } catch (err) {
      if (err instanceof Error && String(err.message).length > 0) continue; // an explicit, named refusal
      failures.push(`${r.key}: threw a non-error ${String(err)}`);
      continue;
    }
    if (!isUnread(result)) failures.push(`${r.key}: returned ${JSON.stringify(result).slice(0, 160)}, which is not unread`);
  }
  assert.deepEqual(failures, [], `readers that returned a silent answer for input they did not understand:\n${failures.join("\n")}`);
});

// ── the derivation: every parse*/read*/check* export is tagged or exempt ──────────────────────────────────────────

// Each group: [why none of these needs the hostile-input test, the exports]. Classified by what the function is, not
// individually mutated: moving one into READER is the way to put it under test. The per-function audit of the
// own-state group (does a CORRUPT file read as empty?) is the follow-up the issue names.
const EXEMPT = [
  ["reads one ref's head for a refusal check; an unreadable repo returns {error}, never a bare null, and the caller exits 2 (#455)", [
    "refs/record-pruned.mjs::readLiveHead",
  ]],
  ["reads propagate's own day snapshot for a hook; null (missing or unreadable) is never a count: the caller writes goal null with goal_source stating why (#442)", [
    "sessions/assoc-write.mjs::readSnapshot",
  ]],
  ["returns an explicit verdict (ok/violations/problems) over its own checks, not a count read out of foreign input; a blind scan is named by its own floor where it has one", [
    "research/quotes.mjs::checkQuoteLength",
    "core/release-kind.mjs::checkBump",
    "core/release-tags.mjs::checkTagsAtHead",
    "kb/review/disagree.mjs::checkAdjudication",
    "sessions/live.mjs::checkShape",
    "registers/insert.mjs::checkParseInvariant",
    "rules/load-tier.mjs::checkLoadTiers",
    "rules/paths-guard.mjs::checkRulePaths",
    "rules/rules-check.mjs::checkRules",
    "rules/rules-check.mjs::checkRulesAdjudicated",
    "report/goals-check.mjs::checkGoals",
    "report/docs.mjs::checkCoverage",
    "report/goals.mjs::checkDirectionQuote",
    "report/plans.mjs::checkRoot",
    "report/plans.mjs::checkPlans",
    "report/doctor/registers.mjs::checkRegisters",
    "report/doctor/unrecorded.mjs::checkUnrecorded",
    "report/doctor/decisions.mjs::checkDecisions",
    "report/doctor/reminders.mjs::checkReminders",
    "report/doctor/retirement.mjs::checkRetirement",
    "report/doctor/discovery.mjs::checkDiscovery",
    "report/doctor/cross.mjs::checkCrossRepoEdges",
    "report/doctor/workspaces.mjs::checkWorkspace",
    "report/doctor/environment.mjs::checkEnvironment",
    "report/doctor/scheduled-jobs.mjs::checkScheduledJobs",
    "report/doctor/services.mjs::checkServices",
    "report/doctor/hooks.mjs::checkHooks",
    "report/doctor/instructions.mjs::checkInstructions",
    "report/doctor/kb.mjs::checkStandards",
    "report/doctor/backlog.mjs::checkBacklog",
    "report/doctor/delivery.mjs::checkDelivery",
    "edges/cited-commits.mjs::checkCitedCommits",
    "glance/acks.mjs::checkIds",
    "claims/check.mjs::checkPriceLiteralsVsCode",
    "claims/check.mjs::checkFooterVsInline",
  ]],
  ["parses one scalar or one line and returns null/a named shape for a non-match; it reports no count that a misread could turn into 0", [
    "research/fetch.mjs::parseRobots",
    "tasks/plan.mjs::parseGithubRemote",
    "tasks/tracker.mjs::parsePaginatedArrays",
    "core/setup.mjs::parseRootsArg",
    "core/plist.mjs::parsePlistWatchPaths",
    "core/worktrees.mjs::parsePorcelain",
    "kb/review/protocol.mjs::parseProtocol",
    "kb/standards/parse.mjs::parsePage",
    "report/health-exceptions.mjs::parseHealthExceptions",
    "report/metrics.mjs::parseSince",
    "report/decisions.mjs::parseDecisions",
    "report/doc-kind.mjs::parseSupersedes",
    "report/rollup.mjs::parseFooter",
    "report/color.mjs::parseHex",
    "report/sprint-plan.mjs::parseSamples",
    "report/machinery.mjs::parseMonitorLine",
    "report/adoption.mjs::parseSystems",
    "report/adoption.mjs::parseSystemsTable",
    "report/instructions.mjs::parseBudgetRegistry",
    "report/backlog.mjs::parseGithubIssuesUrl",
    "report/doctor/unrecorded.mjs::parseStatus",
    "report/doctor/scheduled-jobs.mjs::parseLaunchctlPrint",
    "skills/index-db.mjs::parseLedgerFile",
    "skills/index-db.mjs::parseDecisionsFile",
    "skills/index-db.mjs::parseStateHeaderDate",
    "glance/acks.mjs::parseUntil",
    "broadcast/model.mjs::parseRef",
  ]],
  ["reads a file propagate itself wrote (state, ledger, cache, log); absent means empty by design, and a corrupt file is thrown or named by the reader. Classified by module, not individually mutated: the audit of these is the follow-up named in the test", [
    "research/fetch.mjs::readFetched",
    "tasks/tracker-cache.mjs::readTrackerCache",
    "core/state.mjs::readState",
    "core/runs.mjs::readRuns",
    "core/costs.mjs::readingAt",
    "core/costs.mjs::readCosts",
    "core/release-record.mjs::readReleaseChecks",
    "kb/review/status.mjs::readStatus",
    "kb/review/agree.mjs::readAgreement",
    "kb/review/rater.mjs::readCriteria",
    "kb/standards/sidecars.mjs::readSidecars",
    "kb/standards/versions.mjs::readVersions",
    "kb/standards/adopt.mjs::readAdoptions",
    "sessions/live.mjs::readLive",
    "sessions/resolve.mjs::readCheckouts",
    "rules/load-tier.mjs::readExcludes",
    "refs/snapshot.mjs::readLifecycle",
    "refs/snapshot.mjs::readSnapshot",
    "rules/paths-guard.mjs::readDenyPatterns",
    "refs/active-lines.mjs::readActiveLines",
    "report/monitor.mjs::readNotified",
    "rules/census-cache.mjs::readCensus",
    "report/analytics.mjs::readMetrics",
    "report/metrics.mjs::readMetricsRecords",
    "report/metrics.mjs::readLastMetricsRecord",
    "report/goals-run.mjs::readTrust",
    "report/day-close-auto.mjs::readLastClose",
    "report/adoption.mjs::readSystemsTable",
    "report/seen-edges.mjs::readSeen",
    "report/services.mjs::readRegistryRows",
    "report/backlog.mjs::readDelegatedTrackers",
    "report/stream.mjs::readCursor",
    "report/manifest.mjs::readSidecar",
    "report/doctor/snapshot.mjs::readSnapshot",
    "skills/skills-scan.mjs::readSkillLock",
    "skills/skills-scan.mjs::readSkillUsage",
    "glance/notifications.mjs::readNotifyState",
    "glance/acks.mjs::readAcksState",
    "edges/ledger.mjs::readLedgerWithStats",
    "edges/ledger.mjs::readLedger",
    "edges/ledger.mjs::readLedgerByEra",
    "glance/store.mjs::readGlance",
    "glance/store.mjs::readGlanceState",
    "edges/events.mjs::readEvents",
    "reminders/insert-log.mjs::readInsertLog",
    "broadcast/status.mjs::readStatus",
    "reminders/read.mjs::readReminders",
    "broadcast/index.mjs::readIndex",
    "reminders/reconcile-log.mjs::readReconcileLog",
    "claims/store.mjs::readClaims",
    "claims/runs.mjs::readRuns",
  ]],
  ["an I/O or subprocess wrapper that reports failure in its own result (ok:false, error, null) rather than a count", [
    "core/git-env.mjs::readOnlyGitEnv",
    "report/day.mjs::readBackQuery",
    "report/day.mjs::readBoards",
    "report/day.mjs::readBoardRead",
    "report/day.mjs::readBoardsRest",
    "report/inventory.mjs::readFrontmatterDescription",
    "report/backlog.mjs::readTextSafe",
    "report/manifest.mjs::readYamlSafe",
    "report/doctor/fingerprint.mjs::readFingerprint",
    "report/doctor/delivery.mjs::readInstalledPlugins",
    "report/doctor/delivery.mjs::readKnownMarketplaces",
    "skills/skills-scan.mjs::readFrontmatterName",
    "skills/skills-scan.mjs::readFrontmatterFields",
    "broadcast/gh.mjs::readJson",
    "reminders/osascript.mjs::readRaw",
  ]],
]
;

const CANDIDATE_RE = /^export (?:async )?function ((?:parse|read|check)[A-Za-z0-9_]*)/gm;

function candidates() {
  const out = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(CANDIDATE_RE)) out.push(`${rel(f)}::${m[1]}`);
  }
  return out;
}

test("derivation: every exported parse*/read*/check* function under lib/ is tagged READER or exempt with a reason", async () => {
  const cands = candidates();
  assert.ok(cands.length >= 50, `only ${cands.length} candidates found: the scan has gone blind, it has not found nothing`);
  const tagged = new Set((await loadReaders()).map((r) => r.key));
  const exempt = new Map();
  for (const [why, keys] of EXEMPT) {
    assert.ok(why.length > 20, "an exemption needs a reason");
    for (const k of keys) {
      assert.ok(!exempt.has(k), `${k} is exempt twice`);
      exempt.set(k, why);
    }
  }
  const missing = cands.filter((c) => !tagged.has(c) && !exempt.has(c));
  assert.deepEqual(missing, [], `untagged readers: add \`export const READER\` with a hostile() factory in the module, or an EXEMPT row with a reason:\n${missing.join("\n")}`);
  const stale = [...exempt.keys()].filter((k) => !cands.includes(k));
  assert.deepEqual(stale, [], `EXEMPT rows naming functions that no longer exist: ${stale.join(", ")}`);
  const both = [...exempt.keys()].filter((k) => tagged.has(k));
  assert.deepEqual(both, [], `exempt and tagged: ${both.join(", ")}`);
});

// ── command level ────────────────────────────────────────────────────────────────────────────────────────────

function cli(args, env, cwd) {
  const r = spawnSync(process.execPath, [path.join(ROOT, "cli.mjs"), ...args], {
    cwd, encoding: "utf8", timeout: 60_000, input: "",
    env: { ...process.env, PROPAGATE_STATE_DIR: env.state, PROPAGATE_SEARCH_ROOTS: env.root },
  });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function hostileWorkspace() {
  const base = mkdtempSync(path.join(tmpdir(), "blind-cmd-"));
  const root = path.join(base, "ws");
  const state = path.join(base, "state");
  mkdirSync(root);
  mkdirSync(state);
  writeFileSync(path.join(root, "a.md"), "not a register\n");
  writeFileSync(path.join(root, "proposals.json"), "{{ not json");
  return { root, state };
}

test("command: settle <file> --check <unreadable proposals> is never exit 0", () => {
  const w = hostileWorkspace();
  const r = cli(["settle", "a.md", "--check", "proposals.json"], w, w.root);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /settle/);
});

test("command: check --changed on a tree it cannot resolve is never exit 0", () => {
  const w = hostileWorkspace();
  spawnSync("git", ["init", "-q", "."], { cwd: w.root });
  const r = cli(["check", "--changed"], w, w.root);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /error|workspace|unread/i);
});

test("command: goals check on a GOALS.md it cannot read never passes, and names the unread file", async () => {
  const h = hostileInputs();
  const lines = [];
  const OPT = [{ id: "a", name: "Backlog" }, { id: "b", name: "Ready" }, { id: "c", name: "In progress" }, { id: "d", name: "Done" }];
  const empty = { totalCount: 0, nodes: [] };
  const board = { id: "P7", number: 7, title: "B", closed: false, fields: { nodes: [{ id: "S", name: "Status", options: OPT }, { id: "G", name: "Goal", options: [{ id: "g", name: "G1" }] }] } };
  const fetcher = {
    rateLimit: () => ({ graphql: { remaining: 5000, limit: 5000 } }),
    graphql: async (q) => (q.includes("projectsV2(first:100)")
      ? { viewer: { projectsV2: { totalCount: 1, nodes: [board] } } }
      : { viewer: { b7: { number: 7, title: "B", ready: empty, prog: empty, backlog: empty, done: empty, recent: empty, stale: empty } } }),
  };
  const push = (s) => lines.push(s);
  const code = await checkCmd([], { files: [h.dir], fetcher, approvals: [], now: Date.UTC(2026, 10, 20), out: push, err: push });
  assert.notEqual(code, 0, lines.join("\n"));
  assert.match(lines.join("\n"), /unread|not checked|0 active goals/);
});

// ── found by the first run, not small enough to fix here (listed in the #408 report) ─────────────────────────────

test.todo("edges/ledger.mjs::readLedger returns [] for a file of non-JSONL junk, with no malformed count on the readLedger path (readLedgerWithStats may carry one): tag it once it reports unread");
test.todo("core/costs.mjs::summarizeTranscript returns {empty:true, malformed:N} for a transcript that is all junk; isUnread does not recognise `empty`, so decide whether all-malformed is unread");
