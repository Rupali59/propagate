/**
 * worktrees-cleaner.test.mjs — propagate#274, #446: `propagate worktrees` (contract C1, C4) against a STUB cleaner.
 *
 * The stub is a literal shell script in a temp dir that records its own argv and prints a canned C1 result, so the
 * safety claims are measured on the side effect: the recorded argv has no `--apply` on a dry run, and the gh stub is
 * never called unless `--apply` was given (rule:safety-flag-needs-a-test). Every name is synthetic (public repo).
 *
 * Run: PROPAGATE_STATE_DIR="$(mktemp -d)" node --test tests/unit/worktrees-cleaner.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { worktreesCmd } from "../../cli/worktrees.mjs";
import { runCleanerGc, normaliseGcResult } from "../../lib/worktrees/cleaner-gc.mjs";
import { postRoutes, routeKey, ledgerPath } from "../../lib/worktrees/routes.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmp = () => mkdtempSync(path.join(tmpdir(), "wtc-"));

const ROUTE = { kind: "issue-comment", repo: "acme/widgets", issue: 42, head: "a".repeat(40), body: "branch feat/42-x is unmerged: 2 patches not upstream" };
const RESULT = (extra = {}) => ({
  schema_version: 1, now: "2026-11-28T10:00:00+05:30", applied: false,
  actions: [{ path: "/w/acme/.worktrees/old", verdict: "landed", status: "planned" }],
  refused: [{ path: "/w/acme/.worktrees/dirty", reason: "dirty" }],
  routes: [ROUTE], ...extra,
});

/** A stub cleaner dir: scripts/worktree-gc.sh records argv (one line per call) and prints out.json with `exit`. */
function stubCleaner({ result = RESULT(), exit = 1, stdout = null } = {}) {
  const dir = tmp();
  mkdirSync(path.join(dir, "scripts"), { recursive: true });
  writeFileSync(path.join(dir, "out.json"), stdout ?? JSON.stringify(result));
  const sh = path.join(dir, "scripts", "worktree-gc.sh");
  writeFileSync(sh, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${dir}/argv.log"\ncat "${dir}/out.json"\nexit ${exit}\n`);
  chmodSync(sh, 0o755);
  return dir;
}
const argvLog = (dir) => (existsSync(path.join(dir, "argv.log")) ? readFileSync(path.join(dir, "argv.log"), "utf8").trim().split("\n") : []);

/** A stub gh: records argv, exits with the code in `code` beside it. */
function stubGh({ code = 0 } = {}) {
  const dir = tmp();
  const sh = path.join(dir, "gh");
  writeFileSync(sh, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${dir}/argv.log"\n[ ${code} -ne 0 ] && echo "gh: boom" >&2\nexit ${code}\n`);
  chmodSync(sh, 0o755);
  return { dir, bin: sh };
}

async function run(args, { cleanerDir, gh, state = tmp() } = {}) {
  const lines = [];
  const errs = [];
  const code = await worktreesCmd(args, { cleanerDir, stateDirPath: state, ghBin: gh?.bin, out: (s) => lines.push(s), err: (s) => errs.push(s) });
  return { code, out: lines.join("\n"), err: errs.join("\n"), state };
}

test("an unset cleanerDir is 'cleaner not configured' with exit 2, never 0", async () => {
  const r = await run(["/some/repo"], { cleanerDir: null });
  assert.equal(r.code, 2);
  assert.match(r.err, /cleaner not configured/);
  const j = await run(["/some/repo", "--json"], { cleanerDir: "" });
  assert.equal(j.code, 2);
  assert.equal(JSON.parse(j.out).code, "CLEANER_NOT_CONFIGURED");
});

test("a cleanerDir with no worktree-gc.sh is its own coded exit 2", () => {
  const r = runCleanerGc({ cleanerDir: tmp(), paths: ["/r"] });
  assert.equal(r.exit, 2);
  assert.equal(r.code, "CLEANER_SCRIPT_MISSING");
});

test("an empty path list is allowed: the cleaner derives its own set, so argv carries no repo", () => {
  const dir = stubCleaner({ result: RESULT({ routes: [] }), exit: 0 });
  const r = runCleanerGc({ cleanerDir: dir, paths: [] });
  assert.equal(r.ok, true);
  assert.equal(argvLog(dir)[0], "--json");
});

for (const code of [0, 1]) {
  test(`the cleaner's exit ${code} passes through`, async () => {
    const dir = stubCleaner({ result: RESULT({ routes: [] }), exit: code });
    const r = await run(["/repo"], { cleanerDir: dir });
    assert.equal(r.code, code);
  });
}

test("the cleaner's exit 2 passes through as could-not-run, carrying its stderr", async () => {
  const dir = stubCleaner({ exit: 2, stdout: "" });
  const r = await run(["/repo"], { cleanerDir: dir });
  assert.equal(r.code, 2);
  assert.match(r.err, /could not run/);
});

test("an exit outside 0/1/2 and output that is not JSON are each exit 2 with their own code", () => {
  assert.equal(runCleanerGc({ cleanerDir: stubCleaner({ exit: 7 }), paths: ["/r"] }).code, "CLEANER_EXIT");
  const bad = runCleanerGc({ cleanerDir: stubCleaner({ exit: 0, stdout: "all clean" }), paths: ["/r"] });
  assert.equal(bad.code, "CLEANER_BAD_OUTPUT");
  assert.equal(bad.exit, 2);
});

test("a dry run calls the cleaner WITHOUT --apply; --apply passes it (the stub's recorded argv)", async () => {
  const dir = stubCleaner({ result: RESULT({ routes: [] }), exit: 0 });
  await run(["/repo-a", "/repo-b"], { cleanerDir: dir });
  await run(["/repo-a", "--apply"], { cleanerDir: dir });
  const [dry, applied] = argvLog(dir);
  assert.equal(dry, "--json /repo-a /repo-b", "a dry run must not carry --apply");
  assert.equal(applied, "--json --apply /repo-a");
});

test("routes are posted only under --apply: a dry run never calls gh", async () => {
  const dir = stubCleaner();
  const gh = stubGh();
  const state = tmp();
  const dry = await run(["/repo"], { cleanerDir: dir, gh, state });
  assert.match(dry.out, /route would-post acme\/widgets#42@/);
  assert.equal(existsSync(path.join(gh.dir, "argv.log")), false, "gh must not be called on a dry run");
  assert.equal(existsSync(ledgerPath(state)), false, "a dry run writes no ledger");
  await run(["/repo", "--apply"], { cleanerDir: dir, gh, state });
  assert.deepEqual(readFileSync(path.join(gh.dir, "argv.log"), "utf8").trim().split("\n"), [`issue comment 42 -R acme/widgets --body ${ROUTE.body}`]);
});

test("the same head is commented once, however many --apply runs", async () => {
  const dir = stubCleaner();
  const gh = stubGh();
  const state = tmp();
  await run(["/repo", "--apply"], { cleanerDir: dir, gh, state });
  const second = await run(["/repo", "--apply"], { cleanerDir: dir, gh, state });
  assert.match(second.out, /route already-posted/);
  assert.equal(readFileSync(path.join(gh.dir, "argv.log"), "utf8").trim().split("\n").length, 1);
  assert.equal(readFileSync(ledgerPath(state), "utf8").trim().split("\n").length, 1);
  // a new head on the same issue is a new comment
  writeFileSync(path.join(dir, "out.json"), JSON.stringify(RESULT({ routes: [{ ...ROUTE, head: "b".repeat(40) }] })));
  await run(["/repo", "--apply"], { cleanerDir: dir, gh, state });
  assert.equal(readFileSync(path.join(gh.dir, "argv.log"), "utf8").trim().split("\n").length, 2);
});

test("a gh failure is counted, named, raises a clean exit to 1, and is retried next run (not in the ledger)", async () => {
  const dir = stubCleaner({ result: RESULT({ routes: [ROUTE] }), exit: 0 });
  const state = tmp();
  const bad = stubGh({ code: 1 });
  const r = await run(["/repo", "--apply", "--json"], { cleanerDir: dir, gh: bad, state });
  assert.equal(r.code, 1);
  const j = JSON.parse(r.out);
  assert.equal(j.route_counts.failed, 1);
  assert.match(j.routes[0].error, /boom/);
  assert.equal(existsSync(ledgerPath(state)), false, "a failed post must not be recorded as posted");
  const good = stubGh();
  const retry = await run(["/repo", "--apply"], { cleanerDir: dir, gh: good, state });
  assert.equal(retry.code, 0);
  assert.equal(readFileSync(path.join(good.dir, "argv.log"), "utf8").trim().split("\n").length, 1);
});

test("a malformed route is reported as invalid, never dropped and never posted", () => {
  const gh = stubGh();
  const { rows, counts } = postRoutes({ routes: [{ kind: "issue-comment", repo: "nope", issue: 1, body: "x" }, { kind: "slack", repo: "a/b", issue: 1, body: "x" }], apply: true, stateDir: tmp(), ghBin: gh.bin });
  assert.equal(counts.invalid, 2);
  assert.equal(rows.length, 2);
  assert.equal(existsSync(path.join(gh.dir, "argv.log")), false);
});

test("a route with no head still dedupes, by its body", () => {
  const a = routeKey({ repo: "a/b", issue: 1, body: "same" });
  assert.equal(a, routeKey({ repo: "a/b", issue: 1, body: "same" }));
  assert.notEqual(a, routeKey({ repo: "a/b", issue: 1, body: "other" }));
});

test("normaliseGcResult reads both the apply shape and a dry run's classify shape", () => {
  const applied = normaliseGcResult({ schema_version: 1, applied: true, actions: [{ path: "/p", verdict: "landed", status: "removed" }], refused: [], routes: [ROUTE] });
  assert.equal(applied.applied, true);
  assert.equal(applied.routes.length, 1);
  const nested = normaliseGcResult({ worktrees: [], summary: { total: 3, tier_a: 1, tier_b: 2 }, proposal: { apply: [{ path: "/q", verdict: "landed" }] }, apply_result: { applied: true, actions: [{ path: "/q", verdict: "landed", status: "removed" }], refused: [] } });
  assert.equal(nested.actions[0].status, "removed");
  const classify = normaliseGcResult({ worktrees: [], summary: { total: 3, tier_a: 1, tier_b: 2 }, proposal: { apply: [{ path: "/q", verdict: "landed" }] } });
  assert.deepEqual(classify.actions, [{ path: "/q", verdict: "landed", status: "planned" }]);
  assert.equal(classify.summary.tier_b, 2);
  assert.equal(normaliseGcResult([]), null);
  assert.equal(normaliseGcResult(null), null);
});

// Regression, propagate#274 live smoke: a workspace-derived repo set omitted a repository the cleaner audits, so one
// of two routes was lost. With no paths named propagate must pass NONE and let the cleaner derive its own set.
test("with no paths named, propagate passes no repo and both routes the cleaner prints come back", async () => {
  const other = { ...ROUTE, repo: "acme/gadgets", issue: 7, head: "b".repeat(40) };
  const dir = stubCleaner({ result: RESULT({ routes: [ROUTE, other] }), exit: 1 });
  const lines = [];
  const code = await worktreesCmd(["--json"], { cleanerDir: dir, workspaces: [{ root: "/ws/a" }], stateDirPath: tmp(), out: (s) => lines.push(s), err: () => {} });
  assert.equal(code, 1);
  assert.equal(argvLog(dir)[0], "--json", "no repository path may be passed when none was named");
  const j = JSON.parse(lines.join("\n"));
  assert.deepEqual(j.routes.map((r) => r.key), [`acme/widgets#42@${"a".repeat(40)}`, `acme/gadgets#7@${"b".repeat(40)}`]);
});

// Regression: a literal C1 --json shaped like the real output (top-level routes WITHOUT head, tier_b rows carry it).
test("a route with no head borrows the full head from its proposal.tier_b row; none is hashed silently", async () => {
  const sha = "1e50309938799cfdbbeaedcafd47d603e2632c7c";
  const sha2 = "151a777aeabc05daf386a6ec4ddaa9c2d994dac4";
  const real = {
    now: "2026-11-28T10:00:00+05:30", schema_version: 1, summary: { total: 3, tier_a: 0, tier_b: 3 },
    routes: [
      { kind: "issue-comment", repo: "owner/repo", issue: 618, path: "/w/repo/.claude/worktrees/perf-618-x", branch: "perf/618-x", verdict: "unlanded", body: "cleaner: 1 unlanded commit(s)" },
      { kind: "issue-comment", repo: "owner/other", issue: 162, path: "/w/other/.claude/worktrees/refactor-162-y", branch: "refactor/162-y", verdict: "unlanded", body: "cleaner: 4 unlanded commit(s)" },
      { kind: "issue-comment", repo: "owner/third", issue: 9, path: "/w/third/.claude/worktrees/fix-9-z", branch: "fix/9-z", verdict: "unlanded", body: "cleaner: 2 unlanded commit(s)" },
    ],
    proposal: { apply: [], tier_b: [
      { path: "/w/repo/.claude/worktrees/perf-618-x", repo: "/w/repo", branch: "perf/618-x", head: sha, verdict: "unlanded", route: { kind: "issue-comment", repo: "owner/repo", issue: 618, head: sha, body: "cleaner: 1 unlanded commit(s)" } },
      { path: "/w/other/.claude/worktrees/refactor-162-y", repo: "/w/other", branch: "refactor/162-y", head: sha2, verdict: "unlanded", route: { kind: "issue-comment", repo: "owner/other", issue: 162, body: "cleaner: 4 unlanded commit(s)" } },
    ] },
  };
  const dir = stubCleaner({ result: real, exit: 1 });
  const lines = [];
  await worktreesCmd(["--json"], { cleanerDir: dir, stateDirPath: tmp(), out: (s) => lines.push(s), err: () => {} });
  const j = JSON.parse(lines.join("\n"));
  assert.equal(j.routes[0].key, `owner/repo#618@${sha}`);
  assert.equal(j.routes[0].head, sha);
  assert.equal(j.routes[1].key, `owner/other#162@${sha2}`, "head taken from the tier_b row when the route lacks it");
  assert.equal(j.routes[2].head_missing, true);
  assert.match(j.routes[2].key, /^owner\/third#9@body-/);
  assert.equal(j.route_counts.head_missing, 1);
});

test("the spawned CLI: unset cleaner is exit 2 'cleaner not configured'; an unknown flag is exit 2", () => {
  const env = { ...process.env, PROPAGATE_STATE_DIR: tmp() };
  delete env.PROPAGATE_CLEANER_DIR;
  const r = spawnSync(process.execPath, [path.join(ROOT, "cli.mjs"), "worktrees", "/some/repo"], { env, encoding: "utf8" });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /cleaner not configured/);
  const f = spawnSync(process.execPath, [path.join(ROOT, "cli.mjs"), "worktrees", "--nope"], { env, encoding: "utf8" });
  assert.equal(f.status, 2);
});
