// plan-goal (G3 Done-when 2): an ExitPlanMode whose plan names no active goal is refused unless it carries a
// goal_reason line. Tested by EFFECT (rule:safety-flag-needs-a-test): the approvals log is snapshotted, so "a deny
// records nothing" is a read of the file, not of the hook's own words. Plans and GOALS.md are LITERALS, never built
// through a helper that could only express valid ones (rule:mutate-behind-the-fixture-builder): do not tidy them
// onto a builder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "hooks", "plan-goal.mjs");

const GOALS = `# Goals

## G1 · Parked one

**Active since 2026-11-13**
**Parked (cycle 1, 2026-11-14):** waits.

**Done when:** x.

## G2 · The live one

**Active since 2026-11-13 · appetite 4 weeks**

**Done when:** y.

## G3 · Another live one

**Active since 2026-11-13 · appetite 4 weeks**

**Done when:** z.
`;

/** One sandbox per test: temp HOME (with a plans dir), temp state dir, temp GOALS.md. */
function sandbox({ goals = GOALS } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "plan-goal-"));
  const home = path.join(root, "home");
  const plans = path.join(home, ".claude", "plans");
  mkdirSync(plans, { recursive: true });
  const state = path.join(root, "state");
  const goalsFile = path.join(root, "GOALS.md");
  if (goals !== null) writeFileSync(goalsFile, goals);
  const log = path.join(state, "plans", "approvals.jsonl");
  return {
    plans,
    log,
    rows: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []),
    run(event) {
      const r = spawnSync("node", [HOOK], {
        input: JSON.stringify(event),
        encoding: "utf8",
        env: { ...process.env, HOME: home, PROPAGATE_STATE_DIR: state, PROPAGATE_GOALS_FILES: goals === null ? path.join(root, "absent.md") : goalsFile },
      });
      assert.equal(r.status, 0, `the hook always exits 0: ${r.stderr}`);
      const out = r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null;
      return { raw: r.stdout, out, deny: out?.permissionDecision === "deny", reason: out?.permissionDecisionReason ?? "", ctx: out?.additionalContext ?? "" };
    },
  };
}

const exitPlan = (plan) => ({ tool_name: "ExitPlanMode", tool_input: plan === undefined ? {} : { plan } });

test("an active Goal: G2 is allowed and logs one row", () => {
  const sb = sandbox();
  const r = sb.run(exitPlan("# Plan\n\nGoal: G2\n\nDo the thing.\n"));
  assert.equal(r.deny, false);
  const rows = sb.rows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].goal, "G2");
  assert.equal(rows[0].plan, "tool_input");
  assert.ok(rows[0].ts);
});

test("a bold, lower-case goal line counts", () => {
  const sb = sandbox();
  const r = sb.run(exitPlan("# Plan\n\n**goal:** G3\n"));
  assert.equal(r.deny, false);
  assert.equal(sb.rows()[0].goal, "G3");
});

test("no Goal line is denied, names the active ids and both fixes, and records nothing", () => {
  const sb = sandbox();
  const r = sb.run(exitPlan("# Plan\n\nDo the thing.\n"));
  assert.equal(r.deny, true);
  assert.match(r.reason, /names no goal/);
  assert.match(r.reason, /active: G2, G3/);
  assert.match(r.reason, /Goal: G<n>/);
  assert.match(r.reason, /goal_reason:/);
  assert.equal(sb.rows().length, 0);
});

test("an inactive id is denied: G9 is declared nowhere, G1 is parked", () => {
  for (const id of ["G9", "G1"]) {
    const sb = sandbox();
    const r = sb.run(exitPlan(`# Plan\n\nGoal: ${id}\n`));
    assert.equal(r.deny, true, `${id} must be refused`);
    assert.match(r.reason, new RegExp(`names ${id}, which is not active`));
    assert.equal(sb.rows().length, 0);
  }
});

test("Goal: Parked is denied", () => {
  const sb = sandbox();
  const r = sb.run(exitPlan("# Plan\n\nGoal: Parked\n"));
  assert.equal(r.deny, true);
  assert.equal(sb.rows().length, 0);
});

test("goal_reason lets a goal-less plan through and logs an override row", () => {
  const sb = sandbox();
  const r = sb.run(exitPlan("# Plan\n\ngoal_reason: one-off repair outside the cycle\n"));
  assert.equal(r.deny, false);
  const rows = sb.rows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].goal, null);
  assert.equal(rows[0].reason, "one-off repair outside the cycle");
});

test("an empty goal_reason is not a reason", () => {
  const sb = sandbox();
  const r = sb.run(exitPlan("# Plan\n\ngoal_reason:   \n"));
  assert.equal(r.deny, true);
  assert.equal(sb.rows().length, 0);
});

test("no plan text anywhere is allowed and says 'not checked'", () => {
  const sb = sandbox();
  const r = sb.run(exitPlan(undefined));
  assert.equal(r.deny, false);
  assert.match(r.ctx, /plan goal not checked: no plan text found/);
  assert.equal(sb.rows().length, 0);
});

test("no active goal can be read is allowed and says 'not checked'", () => {
  for (const goals of [null, "# Goals\n\n## G1 · Idle\n\n**Done when:** x.\n"]) {
    const sb = sandbox({ goals });
    const r = sb.run(exitPlan("# Plan\n\nno goal named\n"));
    assert.equal(r.deny, false);
    assert.match(r.ctx, /plan goal not checked: no active goal was read/);
    assert.equal(sb.rows().length, 0);
  }
});

test("an Agent event is silent", () => {
  const sb = sandbox();
  const r = sb.run({ tool_name: "Agent", tool_input: { prompt: "no goal here" } });
  assert.equal(r.raw, "");
  assert.equal(sb.rows().length, 0);
});

test("tool_input.plan is preferred over the newest plan file", () => {
  const sb = sandbox();
  writeFileSync(path.join(sb.plans, "newest.md"), "# From the file\n\nGoal: G3\n");
  const r = sb.run(exitPlan("# Inline\n\nGoal: G2\n"));
  assert.equal(r.deny, false);
  assert.equal(sb.rows()[0].goal, "G2");
  assert.equal(sb.rows()[0].plan, "tool_input");
});

test("without tool_input.plan the newest recent plan file is read, and its path is logged", () => {
  const sb = sandbox();
  writeFileSync(path.join(sb.plans, "older.md"), "# Older\n\nGoal: G3\n");
  const old = new Date(Date.now() - 5 * 60 * 1000);
  utimesSync(path.join(sb.plans, "older.md"), old, old);
  writeFileSync(path.join(sb.plans, "newest.md"), "# Newest\n\nGoal: G2\n");
  const r = sb.run(exitPlan(undefined));
  assert.equal(r.deny, false);
  assert.equal(sb.rows()[0].goal, "G2");
  assert.equal(sb.rows()[0].plan, path.join(sb.plans, "newest.md"));
});

test("a plan file older than 15 minutes is ignored", () => {
  const sb = sandbox();
  const f = path.join(sb.plans, "stale.md");
  writeFileSync(f, "# Stale\n\nno goal at all\n");
  const old = new Date(Date.now() - 20 * 60 * 1000);
  utimesSync(f, old, old);
  const r = sb.run(exitPlan(undefined));
  assert.equal(r.deny, false, "a stale file is no plan text, so not a deny");
  assert.match(r.ctx, /no plan text found/);
});

test("plansDirectory in settings.json redirects the plan lookup", () => {
  const sb = sandbox();
  const home = path.dirname(path.dirname(sb.plans));
  mkdirSync(path.join(home, "elsewhere"), { recursive: true });
  writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ plansDirectory: "~/elsewhere" }));
  writeFileSync(path.join(home, "elsewhere", "p.md"), "# P\n\nno goal\n");
  const r = sb.run(exitPlan(undefined));
  assert.equal(r.deny, true, "the plan was read from the configured directory");
});

test("a payload that is not JSON exits 0 silently", () => {
  const r = spawnSync("node", [HOOK], { input: "not json", encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});
