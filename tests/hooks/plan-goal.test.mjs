// plan-goal (G3 Done-when 2): an ExitPlanMode whose plan names no active goal is refused unless it carries a
// goal_reason line. Tested by EFFECT (rule:safety-flag-needs-a-test): the approvals log is snapshotted, so "a deny
// records nothing" is a read of the file, not of the hook's own words. Plans and GOALS.md are LITERALS, never built
// through a helper that could only express valid ones (rule:mutate-behind-the-fixture-builder): do not tidy them
// onto a builder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, utimesSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "hooks", "plan-goal.mjs");

// The gate clock is injected (PROPAGATE_PLAN_GATE_NOW). ENFORCED is past the Surface grace date, IN_GRACE before it,
// so no test depends on the day it is run.
const ENFORCED = "2026-12-15T12:00:00Z";
const IN_GRACE = "2026-11-20T12:00:00Z";

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
function sandbox({ goals = GOALS, now = ENFORCED } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "plan-goal-"));
  const home = path.join(root, "home");
  const plans = path.join(home, ".claude", "plans");
  mkdirSync(plans, { recursive: true });
  const state = path.join(root, "state");
  const goalsFile = path.join(root, "GOALS.md");
  if (goals !== null) writeFileSync(goalsFile, goals);
  const log = path.join(state, "plans", "approvals.jsonl");
  const gateDir = path.join(state, "plan-gate");
  return {
    plans,
    log,
    state,
    gateRows: () =>
      existsSync(gateDir)
        ? readdirSync(gateDir).flatMap((f) => readFileSync(path.join(gateDir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)))
        : [],
    gateFiles: () => (existsSync(gateDir) ? readdirSync(gateDir) : []),
    rows: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []),
    run(event, extraEnv = {}) {
      // The Surface gate is forced ON here (PROPAGATE_PLAN_SURFACE_GATE) so these tests do not depend on whether the
      // machine running them declares a hub. The off-switch tests below pass `null` to remove a key from the env.
      const env = { ...process.env, HOME: home, PROPAGATE_STATE_DIR: state, PROPAGATE_GOALS_FILES: goals === null ? path.join(root, "absent.md") : goalsFile, PROPAGATE_PLAN_GATE_NOW: now, PROPAGATE_PLAN_SURFACE_GATE: "on", ...extraEnv };
      for (const k of Object.keys(env)) if (env[k] === null) delete env[k];
      const r = spawnSync("node", [HOOK], { input: JSON.stringify(event), encoding: "utf8", env });
      assert.equal(r.status, 0, `the hook always exits 0: ${r.stderr}`);
      const out = r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null;
      return { raw: r.stdout, out, deny: out?.permissionDecision === "deny", reason: out?.permissionDecisionReason ?? "", ctx: out?.additionalContext ?? "" };
    },
  };
}

const exitPlan = (plan) => ({ tool_name: "ExitPlanMode", tool_input: plan === undefined ? {} : { plan } });

test("an active Goal: G2 is allowed and logs one row", () => {
  const sb = sandbox();
  const r = sb.run(exitPlan("# Plan\n\nGoal: G2\nSurface: none\n\nDo the thing.\n"));
  assert.equal(r.deny, false);
  const rows = sb.rows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].goal, "G2");
  assert.equal(rows[0].plan, "tool_input");
  assert.ok(rows[0].ts);
});

test("a bold, lower-case goal line counts", () => {
  const sb = sandbox();
  const r = sb.run(exitPlan("# Plan\n\n**goal:** G3\nSurface: none\n"));
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
  const r = sb.run(exitPlan("# Plan\n\ngoal_reason: one-off repair outside the cycle\nSurface: none\n"));
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
    const r = sb.run(exitPlan("# Plan\n\nno goal named\nSurface: none\n"));
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
  writeFileSync(path.join(sb.plans, "newest.md"), "# From the file\n\nGoal: G3\nSurface: none\n");
  const r = sb.run(exitPlan("# Inline\n\nGoal: G2\nSurface: none\n"));
  assert.equal(r.deny, false);
  assert.equal(sb.rows()[0].goal, "G2");
  assert.equal(sb.rows()[0].plan, "tool_input");
});

test("without tool_input.plan the newest recent plan file is read, and its path is logged", () => {
  const sb = sandbox();
  writeFileSync(path.join(sb.plans, "older.md"), "# Older\n\nGoal: G3\nSurface: none\n");
  const old = new Date(Date.now() - 5 * 60 * 1000);
  utimesSync(path.join(sb.plans, "older.md"), old, old);
  writeFileSync(path.join(sb.plans, "newest.md"), "# Newest\n\nGoal: G2\nSurface: none\n");
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

// ---- Surface / Need / References checked gates (#297, glance design §6, T-P1..P8) ----
// Plans are literals on purpose (see the header). The complete Need and References sections are spelled out in
// every test that needs them, so a test cannot pass because a shared constant drifted.

test("T-P1: Surface: ui without ## Need is denied, names ## Need, includes the template, and logs one deny row", () => {
  const sb = sandbox();
  const r = sb.run(
    exitPlan("# Plan\n\nGoal: G2\nSurface: ui\n\n## References checked\n\n- node:test: the runner already in use, it fits.\n"),
  );
  assert.equal(r.deny, true);
  assert.match(r.reason, /this plan is missing: /);
  assert.match(r.reason, /## Need/);
  assert.doesNotMatch(r.reason, /missing: [^\n]*## References checked/, "References are present, so not listed as missing");
  // The template to paste, so a second try can pass.
  for (const s of ["Surface: none", "Question:", "Decision:", "Today:", "Retire when:", "## References checked"]) assert.ok(r.reason.includes(s), `template carries ${s}`);
  assert.equal(sb.rows().length, 0, "a deny records no approval");
  const g = sb.gateRows();
  assert.equal(g.length, 1);
  assert.equal(g[0].verdict, "deny");
  assert.ok(g[0].missing.some((m) => m.startsWith("## Need")));
});

test("T-P2: a complete Surface plan passes and logs surface in the approval row", () => {
  const sb = sandbox();
  const r = sb.run(
    exitPlan(
      "# Plan\n\nGoal: G2\nSurface: ui\n\n## Need\n\n- Question: what is broken?\n- Decision: whether to open a session.\n- Today: a long doctor run.\n- Retire when: unopened for 30 days.\n\n## References checked\n\n- node:test: the runner already in use, it fits.\n\n## Steps\n\n1. Build.\n",
    ),
  );
  assert.equal(r.deny, false, r.reason);
  const rows = sb.rows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].goal, "G2");
  assert.equal(rows[0].surface, "ui");
  assert.equal(sb.gateRows().length, 0, "a clean pass logs no gate row");
});

test("T-P3: Surface: none passes with neither section", () => {
  const sb = sandbox();
  const r = sb.run(exitPlan("# Plan\n\nGoal: G2\nSurface: none\n\nRefactor only.\n"));
  assert.equal(r.deny, false, r.reason);
  assert.equal(sb.rows()[0].surface, "none");
});

test("T-P4: no Surface line warns inside the grace window and is denied after it", () => {
  const plan = "# Plan\n\nGoal: G2\n\nDo the thing.\n";
  const before = sandbox({ now: IN_GRACE });
  const w = before.run(exitPlan(plan));
  assert.equal(w.deny, false, "inside the grace window a missing Surface line only warns");
  assert.match(w.ctx, /Surface/);
  assert.match(w.ctx, /2026-11-30/, "the warning names the enforcement date");
  assert.equal(before.rows()[0].surface, null);
  const wg = before.gateRows();
  assert.equal(wg.length, 1);
  assert.equal(wg[0].verdict, "warn");
  assert.deepEqual(wg[0].missing, ["Surface"]);

  const after = sandbox({ now: ENFORCED });
  const d = after.run(exitPlan(plan));
  assert.equal(d.deny, true, "after the grace date a missing Surface line is denied");
  assert.match(d.reason, /missing: Surface/);
  assert.equal(after.rows().length, 0);
});

test("T-P4b: inside the grace window a Surface plan with missing sections is still denied", () => {
  const sb = sandbox({ now: IN_GRACE });
  const r = sb.run(exitPlan("# Plan\n\nGoal: G2\nSurface: widget\n"));
  assert.equal(r.deny, true);
  assert.match(r.reason, /## Need/);
  assert.match(r.reason, /## References checked/);
});

test("surface_reason overrides the gate and is logged with the approval", () => {
  const sb = sandbox();
  const r = sb.run(exitPlan("# Plan\n\nGoal: G2\nSurface: ui\nsurface_reason: a throwaway spike, deleted tomorrow\n"));
  assert.equal(r.deny, false, r.reason);
  const rows = sb.rows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].surface_reason, "a throwaway spike, deleted tomorrow");
  assert.match(r.ctx, /surface_reason/);
});

test("surface_reason also covers a plan with no Surface line after the grace date", () => {
  const sb = sandbox();
  const r = sb.run(exitPlan("# Plan\n\nGoal: G2\nsurface_reason: tooling inside the hook itself\n"));
  assert.equal(r.deny, false, r.reason);
});

test("an empty surface_reason is not a reason", () => {
  const sb = sandbox();
  const r = sb.run(exitPlan("# Plan\n\nGoal: G2\nSurface: ui\nsurface_reason:   \n"));
  assert.equal(r.deny, true);
});

test("T-P7: a plan missing both Goal and Surface gets ONE denial listing both", () => {
  const sb = sandbox();
  const r = sb.run(exitPlan("# Plan\n\nDo the thing.\n"));
  assert.equal(r.deny, true);
  assert.equal((r.raw.match(/permissionDecision"/g) ?? []).length, 1, "one decision object, not two");
  assert.match(r.reason, /this plan is missing: Goal, Surface\./);
  assert.match(r.reason, /names no goal/);
  assert.match(r.reason, /Goal: G<n>/);
  assert.match(r.reason, /goal_reason:/);
  assert.match(r.reason, /Surface: none/);
  assert.match(r.reason, /surface_reason:/);
  const g = sb.gateRows();
  assert.equal(g.length, 1);
  assert.deepEqual(g[0].missing, ["Goal", "Surface"]);
});

test("the fail-open path (no active goal readable) still runs the Surface check", () => {
  for (const goals of [null, "# Goals\n\n## G1 · Idle\n\n**Done when:** x.\n"]) {
    const sb = sandbox({ goals });
    const r = sb.run(exitPlan("# Plan\n\nSurface: ui\n"));
    assert.equal(r.deny, true, "a Surface plan missing its sections is denied even when goals cannot be read");
    assert.match(r.reason, /## Need/);
    assert.doesNotMatch(r.reason, /missing: Goal/, "an unread goal is not a missing goal");
    assert.match(r.reason, /plan goal not checked: no active goal was read/);
  }
  const sb = sandbox({ goals: null, now: IN_GRACE });
  const w = sb.run(exitPlan("# Plan\n\nno surface line\n"));
  assert.equal(w.deny, false);
  assert.match(w.ctx, /plan goal not checked/);
  assert.match(w.ctx, /2026-11-30/);
  assert.equal(sb.gateRows()[0].verdict, "warn");
});

test("T-P5: bold and upper-case Surface lines are accepted", () => {
  for (const line of ["**Surface:** widget", "Surface: UI", "- **Surface**: Command"]) {
    const sb = sandbox();
    const r = sb.run(
      exitPlan(
        `# Plan\n\nGoal: G2\n${line}\n\n## Need\n\nQuestion: q?\nDecision: d.\nToday: t.\nRetire when: r.\n\n## References checked\n\n- a library: why it fit.\n`,
      ),
    );
    assert.equal(r.deny, false, `${line}: ${r.reason}`);
  }
});

test("an unknown Surface value is denied, naming the allowed values", () => {
  const sb = sandbox();
  const r = sb.run(exitPlan("# Plan\n\nGoal: G2\nSurface: page\n"));
  assert.equal(r.deny, true);
  assert.match(r.reason, /Surface/);
  assert.match(r.reason, /ui\|widget\|command\|job\|skill/);
});

test("T-P6: Need labels outside the ## Need section are denied", () => {
  const sb = sandbox();
  const r = sb.run(
    exitPlan(
      "# Plan\n\nGoal: G2\nSurface: ui\n\n## Need\n\nQuestion: q?\n\n## Later\n\nDecision: d.\nToday: t.\nRetire when: r.\n\n## References checked\n\n- a library: why.\n",
    ),
  );
  assert.equal(r.deny, true);
  assert.match(r.reason, /## Need \(Decision:, Today:, Retire when:\)/);
});

test("empty Need labels and an empty References section are denied", () => {
  const sb = sandbox();
  const r = sb.run(
    exitPlan("# Plan\n\nGoal: G2\nSurface: job\n\n## Need\n\n- Question:\n- Decision: d.\n- Today: t.\n- Retire when: r.\n\n## References checked\n\n## Steps\n"),
  );
  assert.equal(r.deny, true);
  assert.match(r.reason, /## Need \(Question:\)/);
  assert.match(r.reason, /## References checked/);
});

test("a ## Need inside a fenced code block does not count", () => {
  const sb = sandbox();
  const r = sb.run(
    exitPlan(
      "# Plan\n\nGoal: G2\nSurface: skill\n\n```\n## Need\nQuestion: q?\nDecision: d.\nToday: t.\nRetire when: r.\n\n## References checked\n- x: y.\n```\n",
    ),
  );
  assert.equal(r.deny, true);
  assert.match(r.reason, /## Need/);
  assert.match(r.reason, /## References checked/);
});

test("the gate log row is {ts, session, verdict, missing} with no plan text, in a YYYY-MM file", () => {
  const sb = sandbox();
  const r = sb.run({ tool_name: "ExitPlanMode", session_id: "sess-123", tool_input: { plan: "# SECRET-PLAN-TEXT\n\nSurface: ui\nGoal: G2\n" } });
  assert.equal(r.deny, true);
  assert.deepEqual(sb.gateFiles(), ["2026-12.jsonl"], "the file is named by the month of the (injected) clock");
  const raw = readFileSync(path.join(sb.state, "plan-gate", "2026-12.jsonl"), "utf8");
  assert.ok(!raw.includes("SECRET-PLAN-TEXT"), "no plan text in the log");
  const [row] = sb.gateRows();
  assert.deepEqual(Object.keys(row).sort(), ["missing", "session", "ts", "verdict"]);
  assert.equal(row.session, "sess-123");
  assert.equal(row.verdict, "deny");
});

test("a gate-log write failure never turns a deny into an allow", () => {
  const sb = sandbox();
  const blocker = path.join(sb.state, "..", "blocker");
  writeFileSync(blocker, "not a directory");
  const r = sb.run(exitPlan("# Plan\n\nGoal: G2\nSurface: ui\n"), { PROPAGATE_STATE_DIR: blocker });
  assert.equal(r.deny, true);
});

test("T-P8: no plan text is still allowed, and says the Surface was not checked either", () => {
  const sb = sandbox();
  const r = sb.run(exitPlan(undefined));
  assert.equal(r.deny, false);
  assert.match(r.ctx, /plan goal not checked: no plan text found/);
  assert.match(r.ctx, /Surface not checked: no plan text found/);
});

test("the pure decision is exported and takes an injected clock", async () => {
  const { decidePlan, SURFACE_ENFORCE_FROM } = await import(HOOK);
  assert.equal(SURFACE_ENFORCE_FROM, "2026-11-30");
  const plan = "# P\n\nGoal: G2\n";
  assert.equal(decidePlan(plan, ["G2"], { now: Date.parse("2026-11-29T23:59:59Z") }).deny, undefined);
  assert.ok(decidePlan(plan, ["G2"], { now: Date.parse("2026-11-30T00:00:00Z") }).deny);
});

// ---- Fix 1: a gate its own template satisfies cannot fail. Placeholder values are refused. ----

test("the exact pasted template is denied, naming which labels are unfilled", async () => {
  const { decidePlan } = await import(HOOK);
  const first = decidePlan("# P\n\nGoal: G2\n", ["G2"], { now: Date.parse(ENFORCED) });
  const template = first.deny.split("Paste and fill in:\n\n")[1];
  assert.ok(template && template.includes("## Need"), "the denial carries a template to paste");
  const sb = sandbox();
  const r = sb.run(exitPlan(`# Plan\n\nGoal: G2\n${template}\n`));
  assert.equal(r.deny, true, "an unfilled template must not satisfy its own gate");
  assert.match(r.reason, /## Need unfilled \(Question:, Decision:, Today:, Retire when:\)/);
  assert.match(r.reason, /## References checked unfilled/);
});

test("placeholder values are refused: TODO, TBD, ?, -, <...>", () => {
  const sb = sandbox();
  const r = sb.run(
    exitPlan(
      "# Plan\n\nGoal: G2\nSurface: ui\n\n## Need\n\n- Question: TODO\n- Decision: tbd\n- Today: ?\n- Retire when: <later>\n\n## References checked\n\n- -\n- TBD\n",
    ),
  );
  assert.equal(r.deny, true);
  assert.match(r.reason, /## Need unfilled \(Question:, Decision:, Today:, Retire when:\)/);
  assert.match(r.reason, /## References checked unfilled/);
});

test("a filled plan passes, including real text that contains angle brackets", () => {
  const sb = sandbox();
  const r = sb.run(
    exitPlan(
      "# Plan\n\nGoal: G2\nSurface: command\n\n## Need\n\n- Question: which `Goal: G<n>` lines are stale?\n- Decision: whether to re-plan.\n- Today: reading approvals.jsonl by hand.\n- Retire when: goals check reports it.\n\n## References checked\n\n- node:test: already the runner, it fits.\n",
    ),
  );
  assert.equal(r.deny, false, r.reason);
});

// ---- Fix 2: the off switch. propagate is public; outside the owner's tree the Surface gate defaults OFF. ----

const NON_CONFORMING = "# Plan\n\nGoal: G2\nSurface: ui\n";

test("with the key off, a non-conforming plan passes silently", () => {
  for (const off of ["off", "false", "0"]) {
    const sb = sandbox();
    const r = sb.run(exitPlan(NON_CONFORMING), { PROPAGATE_PLAN_SURFACE_GATE: off });
    assert.equal(r.deny, false, `${off}: ${r.reason}`);
    assert.doesNotMatch(r.ctx, /Surface/, "off means silent: no Surface note at all");
    assert.equal(sb.gateRows().length, 0, "off logs nothing");
  }
});

test("the key off in config.yml (hooks.planSurfaceGate) also turns it off", () => {
  const sb = sandbox();
  mkdirSync(sb.state, { recursive: true });
  writeFileSync(path.join(sb.state, "config.yml"), "hooks:\n  planSurfaceGate: off\n");
  const r = sb.run(exitPlan(NON_CONFORMING), { PROPAGATE_PLAN_SURFACE_GATE: null, PROPAGATE_HUB_ROOT: "/nonexistent-hub" });
  assert.equal(r.deny, false, "the config key wins over the hub default");
});

test("with no hub and no approvals log, the gate defaults off", () => {
  const sb = sandbox();
  const r = sb.run(exitPlan(NON_CONFORMING), { PROPAGATE_PLAN_SURFACE_GATE: null, PROPAGATE_HUB_ROOT: null, PROPAGATE_SEARCH_ROOTS: null });
  assert.equal(r.deny, false, r.reason);
  assert.doesNotMatch(r.ctx, /Surface/);
  assert.equal(sb.gateRows().length, 0);
});

test("a declared hub, or an existing approvals log, turns the default on", () => {
  const hub = sandbox();
  const r1 = hub.run(exitPlan(NON_CONFORMING), { PROPAGATE_PLAN_SURFACE_GATE: null, PROPAGATE_HUB_ROOT: "/some/hub" });
  assert.equal(r1.deny, true, "a declared hub is the owner's tree");
  const appr = sandbox();
  mkdirSync(path.dirname(appr.log), { recursive: true });
  writeFileSync(appr.log, "");
  const r2 = appr.run(exitPlan(NON_CONFORMING), { PROPAGATE_PLAN_SURFACE_GATE: null, PROPAGATE_HUB_ROOT: null, PROPAGATE_SEARCH_ROOTS: null });
  assert.equal(r2.deny, true, "an approvals log means plan-goal has run here before");
});

test("with the key on, it denies even without a hub", () => {
  const sb = sandbox();
  const r = sb.run(exitPlan(NON_CONFORMING), { PROPAGATE_PLAN_SURFACE_GATE: "on", PROPAGATE_HUB_ROOT: null, PROPAGATE_SEARCH_ROOTS: null });
  assert.equal(r.deny, true);
  assert.match(r.reason, /## Need/);
});

test("the off switch never disables the Goal check", () => {
  const sb = sandbox();
  const r = sb.run(exitPlan("# Plan\n\nno goal\n"), { PROPAGATE_PLAN_SURFACE_GATE: "off" });
  assert.equal(r.deny, true);
  assert.match(r.reason, /missing: Goal\./);
  assert.doesNotMatch(r.reason, /Surface/);
});

// ---- #301: a plan that says Surface: none but names a surface marker WARNS (never denies). ----

test("#301: Surface: none naming notify( warns, names the marker, suggests notification, and logs warn-surface-mismatch", () => {
  const sb = sandbox();
  const r = sb.run(exitPlan("# Plan\n\nGoal: G2\nSurface: none\n\nCall NOTIFY(user, msg) when done.\n"));
  assert.equal(r.deny, false, r.reason);
  assert.match(r.ctx, /Surface: none/);
  assert.match(r.ctx, /notify\(/);
  assert.match(r.ctx, /Surface: notification/);
  const rows = sb.gateRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].verdict, "warn-surface-mismatch");
  assert.deepEqual(Object.keys(rows[0]).sort(), ["missing", "session", "ts", "verdict"]);
  assert.equal(sb.rows()[0].surface, "none", "the approval is still recorded");
});

test("#301: each marker suggests its matching Surface kind", async () => {
  const { decidePlan } = await import(HOOK);
  const cases = [
    ["edit hooks/foo.mjs", "hooks/", "hook"],
    ["tweak the Widget", "widget", "widget"],
    ["add a row to COMMANDS", "COMMANDS", "command"],
    ["edit lib/core/commands.mjs", "COMMANDS", "command"],
    ["a launchd job", "launchd", "job"],
    ["write com.x.plist", "launchd", "job"],
    ["into ~/Library/LaunchAgents", "launchd", "job"],
  ];
  for (const [body, marker, kind] of cases) {
    const d = decidePlan(`Goal: G2\nSurface: none\n\n${body}\n`, ["G2"], { now: Date.parse("2026-12-15T12:00:00Z") });
    assert.equal(d.deny, undefined, body);
    assert.ok(d.surfaceMismatch, `${body}: no mismatch warning`);
    assert.ok(d.surfaceMismatch.includes(marker), `${body}: ${d.surfaceMismatch}`);
    assert.ok(d.surfaceMismatch.includes(`Surface: ${kind}`), `${body}: ${d.surfaceMismatch}`);
  }
});

test("#301: Surface: none with no markers is silent", () => {
  const sb = sandbox();
  const r = sb.run(exitPlan("# Plan\n\nGoal: G2\nSurface: none\n\nRefactor the parser only.\n"));
  assert.equal(r.deny, false, r.reason);
  assert.doesNotMatch(r.ctx, /mismatch|suggest/i);
  assert.equal(sb.gateRows().length, 0);
});

test("#301: a declared Surface naming widget gets no mismatch warning", () => {
  const sb = sandbox();
  const plan = [
    "# Plan", "", "Goal: G2", "Surface: ui", "", "Touch the widget.", "",
    "## Need", "Question: is it up?", "Decision: restart or not", "Today: I open a terminal", "Retire when: never", "",
    "## References checked", "- Ubersicht docs: fits", "",
  ].join("\n");
  const r = sb.run(exitPlan(plan));
  assert.equal(r.deny, false, r.reason);
  assert.doesNotMatch(r.ctx, /mismatch/i);
  assert.equal(sb.gateRows().length, 0);
});

test("#301: with the gate off, Surface: none naming notify( is silent", () => {
  const sb = sandbox();
  const r = sb.run(exitPlan("# Plan\n\nGoal: G2\nSurface: none\n\nnotify(x)\n"), { PROPAGATE_PLAN_SURFACE_GATE: "off" });
  assert.equal(r.deny, false, r.reason);
  assert.doesNotMatch(r.ctx, /Surface|notify/);
  assert.equal(sb.gateRows().length, 0);
});

test("#301: the prose word 'commands' is not the command-table marker; the COMMANDS identifier is", async () => {
  const { decidePlan } = await import(HOOK);
  const now = Date.parse("2026-12-15T12:00:00Z");
  const prose = decidePlan("Goal: G2\nSurface: none\n\nrun these commands, then the Commands list\n", ["G2"], { now });
  assert.equal(prose.surfaceMismatch, undefined, `prose "commands" must be silent: ${prose.surfaceMismatch}`);
  const ident = decidePlan("Goal: G2\nSurface: none\n\nadd an entry to COMMANDS\n", ["G2"], { now });
  assert.match(ident.surfaceMismatch ?? "", /COMMANDS \(suggests Surface: command\)/);
});

test("#301: a Surface: none plan saying 'run these commands' is silent end to end", () => {
  const sb = sandbox();
  const r = sb.run(exitPlan("# Plan\n\nGoal: G2\nSurface: none\n\nrun these commands\n"));
  assert.equal(r.deny, false, r.reason);
  assert.doesNotMatch(r.ctx, /suggests/);
  assert.equal(sb.gateRows().length, 0);
});
