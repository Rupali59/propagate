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
import { runCleanerGc, deriveRepos, normaliseGcResult } from "../../lib/worktrees/cleaner-gc.mjs";
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

test("no repositories to hand over is exit 2, a blind scan and not a clean one", () => {
  const r = runCleanerGc({ cleanerDir: stubCleaner(), paths: [] });
  assert.equal(r.code, "CLEANER_NO_PATHS");
  assert.equal(r.exit, 2);
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

test("deriveRepos dedupes by git common dir and names workspaces that are not repositories", () => {
  const answers = {
    "/ws/a": { status: 0, stdout: "/ws/a\n.git\n" },
    "/ws/a/sub": { status: 0, stdout: "/ws/a\n.git\n" },
    "/ws/b": { status: 0, stdout: "/ws/b\n.git\n" },
    "/ws/none": { status: 128, stdout: "" },
  };
  const spawn = (_g, args) => answers[args[1]];
  const { repos, skipped } = deriveRepos([{ root: "/ws/a" }, { root: "/ws/a/sub" }, { root: "/ws/b" }, { root: "/ws/none" }], { spawn, realpath: (p) => p });
  assert.deepEqual(repos, ["/ws/a", "/ws/b"]);
  assert.equal(skipped.length, 1);
});

test("with no paths named, the repos come from discovery; an empty discovery is exit 2 (blind)", async () => {
  const dir = stubCleaner({ result: RESULT({ routes: [] }), exit: 0 });
  const spawnFor = (stdout) => (cmd, args, o) => (cmd === "git" ? { status: 0, stdout } : spawnSync(cmd, args, o));
  const lines = [];
  const code = await worktreesCmd([], { cleanerDir: dir, workspaces: [{ root: "/ws/a" }], spawn: spawnFor("/ws/a\n.git\n"), stateDirPath: tmp(), out: (s) => lines.push(s), err: () => {} });
  assert.equal(code, 0);
  assert.equal(argvLog(dir)[0], "--json /ws/a");
  const errs = [];
  const none = await worktreesCmd([], { cleanerDir: dir, workspaces: [], stateDirPath: tmp(), out: () => {}, err: (s) => errs.push(s) });
  assert.equal(none, 2);
  assert.match(errs.join(""), /discovery found none/);
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
