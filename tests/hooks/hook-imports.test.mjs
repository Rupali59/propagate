/**
 * Every module a hook imports must exist.
 *
 * WHY THIS EXISTS. `doc-authority.mjs` imported `lib/docs.mjs`, `lib/config.mjs` and
 * `lib/edges.mjs`. On 2026-08-20 `lib/` was reorganised into
 * `lib/{core,edges,graph,report,rules,skills}/` and all three paths vanished. The hook
 * runs on every Edit|Write, threw on import, and hit `process.exit(0)` — its documented
 * fail-open. So from 2026-08-20 to 2026-08-22 it enforced NOTHING and reported nothing.
 * Measured at the time of the fix: a payload for a file governed at `authority: counsel`
 * produced exit 0 and ZERO bytes of stderr, where the correct answer is exit 2.
 *
 * The suite was green throughout. Nothing asserted this, because the hooks lived outside
 * the repo entirely — there was no file for a test to point at.
 *
 * WHAT THIS ASSERTS, AND WHY IT IS SHAPED THIS WAY. Not "the hook runs" — a fail-open
 * hook runs fine while broken, which is the entire defect. This extracts every
 * `path.join(SKILL, ...)` specifier out of the source and asserts the target FILE EXISTS.
 * A moved module fails here immediately, at the next `lib/` reorganisation, instead of
 * two days later by accident.
 *
 * rule:enforcement-watches-itself — a check that reports success forever is worse than no
 * check. This is the check that could not previously fire.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const HOOKS = path.join(ROOT, "hooks");

/** Hook sources, excluding their own tests. */
function hookFiles() {
  return readdirSync(HOOKS)
    .filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs"))
    .map((f) => path.join(HOOKS, f));
}

/**
 * Every `path.join(SKILL, "a", "b", …)` in the source, as a repo-relative path.
 * SKILL is the propagate root, which IS this repo — so the join resolves against ROOT.
 */
function skillJoinTargets(src) {
  const out = [];
  const re = /path\.join\(\s*SKILL\s*,\s*([^)]*)\)/g;
  let m;
  while ((m = re.exec(src))) {
    const parts = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    if (parts.length) out.push(path.join(...parts));
  }
  return out;
}

test("hooks/ contains the hooks the plugin ships", () => {
  const names = hookFiles().map((f) => path.basename(f)).sort();
  assert.deepEqual(names, ["agent-guard.mjs", "agent-nudge.mjs", "dispatch-model.mjs", "doc-authority.mjs", "gotcha-guard.mjs", "load-rules.mjs", "plan-goal.mjs", "rule-guard.mjs", "session-guide.mjs", "subagent-cost.mjs"],
    "a hook was added or removed without updating this assertion");
});

for (const file of hookFiles()) {
  const name = path.basename(file);
  test(`${name}: every module it imports from the skill root exists`, () => {
    const src = readFileSync(file, "utf8");
    const targets = skillJoinTargets(src);
    const missing = targets.filter((rel) => !existsSync(path.join(ROOT, rel)));
    assert.deepEqual(
      missing,
      [],
      `${name} imports module(s) that do not exist: ${missing.join(", ")}. ` +
        `This is how doc-authority.mjs silently enforced nothing for two days — it fails ` +
        `open on an import error, so a moved module is indistinguishable from "not installed".`,
    );
  });

  test(`${name}: parses`, () => {
    // A syntax error would also be swallowed by the fail-open catch.
    assert.doesNotThrow(() => new Function(`return 0`), "sanity");
    const src = readFileSync(file, "utf8");
    assert.ok(src.length > 0, `${name} is empty`);
  });
}

test("doc-authority distinguishes ABSENT from BROKEN", () => {
  // The specific regression: both used to exit 0 silently. Absence may be silent;
  // a present-but-broken propagate must not be (rule:discernment-checks §2).
  const src = readFileSync(path.join(HOOKS, "doc-authority.mjs"), "utf8");
  assert.match(src, /existsSync\(SKILL\)/,
    "doc-authority must test whether the skill root exists before treating an import " +
      "failure as 'not installed'");
  assert.match(src, /NOTHING was checked/,
    "the broken-but-present path must write an attributable message to stderr");
});

/**
 * G5 — count REGISTRATIONS, never hooks.
 *
 * `gotcha-guard.mjs` is one file registered TWICE, against `Edit|Write` and against `Bash`.
 * A check phrased "all three hooks fire" counts it once, so dropping the Bash matcher would
 * silently stop guarding every shell command while the check still passed. That is the
 * doc-authority failure shape reproduced inside the verification written to catch it.
 */
test("hooks.json declares exactly 12 registrations, and every command resolves", () => {
  const manifest = JSON.parse(readFileSync(path.join(HOOKS, "hooks.json"), "utf8"));
  const seen = [];
  for (const [event, groups] of Object.entries(manifest.hooks)) {
    for (const group of groups) {
      for (const h of group.hooks) {
        seen.push({ event, matcher: group.matcher, command: h.command });
      }
    }
  }

  assert.equal(seen.length, 12,
    `expected 12 registrations, found ${seen.length}. gotcha-guard is registered twice by ` +
      `design (Edit|Write and Bash); collapsing it to one silently stops guarding Bash.`);
  // #272: session-guide is a SessionStart registration with NO matcher, so it fires on every source (compaction included).
  const guideReg = seen.find((s) => s.event === "SessionStart" && /session-guide\.mjs/.test(s.command));
  assert.ok(guideReg, "SessionStart must run hooks/session-guide.mjs (#272)");
  assert.equal(guideReg.matcher, undefined, "session-guide must have no matcher: every source, including compact, re-delivers");
  // #188: the cost ledger is written only by this registration. Without it, lanes finish unrecorded.
  assert.ok(seen.some((s) => s.event === "SubagentStop" && /subagent-cost\.mjs/.test(s.command)),
    "SubagentStop must run hooks/subagent-cost.mjs (#188 cost ledger)");
  // #251: the read-only guard is the ONLY enforcement for propagate agents (plugin agents cannot carry hooks).
  // Its matcher must cover every write tool, or a read-only agent writes with one of the uncovered ones.
  const guard = seen.find((s) => s.event === "PreToolUse" && /agent-guard\.mjs/.test(s.command));
  assert.ok(guard, "PreToolUse must run hooks/agent-guard.mjs (#251)");
  for (const tool of ["Bash", "Write", "Edit", "NotebookEdit"]) {
    assert.ok(guard.matcher.split("|").includes(tool), `agent-guard matcher must include ${tool}`);
  }

  // rule-guard's matcher must cover subagent dispatch. This is the ONLY surface on which
  // rule:model-routing is observable — an omitted `model` is an absent key in a `Agent`
  // tool_input, verified live 2026-08-28. Narrowing this matcher would leave the rule
  // loaded and unable to fire, which reads identically to "no violations".
  const ruleMatchers = seen.filter((r) => r.command.includes("rule-guard")).map((r) => r.matcher);
  assert.deepEqual(ruleMatchers, ["Agent|Task|ExitPlanMode", "Bash"],
    "rule-guard must stay registered against Agent|Task|ExitPlanMode, and on Bash for shell-command triggers");
  // The Bash registration is narrowed by an `if` (the owner's option b, 2026-11-13): rule-guard runs only for
  // commands mentioning vercel. A rule whose trigger is another shell command needs this widened.
  const bashRule = manifest.hooks.PreToolUse.find((g) => g.matcher === "Bash" && g.hooks.some((h) => h.command.includes("rule-guard")));
  assert.equal(bashRule?.hooks.find((h) => h.command.includes("rule-guard"))?.if, "Bash(*vercel*)");

  // Both gotcha-guard matchers must survive.
  const guardMatchers = seen
    .filter((r) => r.command.includes("gotcha-guard"))
    .map((r) => r.matcher)
    .sort();
  assert.deepEqual(guardMatchers, ["Bash", "Edit|Write"],
    "gotcha-guard must stay registered against BOTH Edit|Write and Bash");

  // Every command must point at a file that exists, via the plugin-root placeholder.
  for (const r of seen) {
    assert.match(r.command, /\$\{CLAUDE_PLUGIN_ROOT\}/,
      `${r.event} command hardcodes a path instead of using \${CLAUDE_PLUGIN_ROOT}: ${r.command}`);
    const rel = r.command.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)/)?.[1];
    assert.ok(rel && existsSync(path.join(ROOT, rel)),
      `${r.event} [${r.matcher}] points at a missing file: ${rel}`);
  }
});

/**
 * The plugin cutover deleted ~/.claude/skills/propagate. Any hook that still hardcodes it
 * resolves to a missing directory and — because doc-authority treats a missing SKILL as
 * "not installed" — goes SILENT. That is correct behaviour on a wrong premise, and it is
 * the second time this exact constant caused a silent no-op.
 */
test("no hook hardcodes ~/.claude/skills/propagate as the skill root", () => {
  for (const file of hookFiles()) {
    const src = readFileSync(file, "utf8");
    const hardcoded = /"\.claude"\s*,\s*"skills"\s*,\s*"propagate"/.test(src);
    assert.ok(!hardcoded,
      `${path.basename(file)} hardcodes ~/.claude/skills/propagate. That path no longer ` +
        `exists after the plugin cutover. Use CLAUDE_PLUGIN_ROOT, falling back to a path ` +
        `derived from import.meta.url.`);
  }
});

test("doc-authority resolves its skill root from the plugin, not from HOME", () => {
  const src = readFileSync(path.join(HOOKS, "doc-authority.mjs"), "utf8");
  assert.match(src, /CLAUDE_PLUGIN_ROOT/,
    "must prefer the harness-provided plugin root");
  assert.match(src, /fileURLToPath\(import\.meta\.url\)/,
    "must fall back to its own location so direct invocation and tests still work");
});

/**
 * propagate#272 (Eng finding "the original arrangement spreads CLI knowledge"): lib/sessions/live.mjs is the only
 * code that runs `claude` for sessions. `claude --bg --help` STARTS a session, so a second spawner is a second chance
 * to launch one by accident. The population is derived by walking lib/ cli/ hooks/, with a floor.
 *
 * EXEMPT lists the spawners that predate the sessions work and are not session code: each carries its reason, and
 * a stale entry (one that no longer spawns claude) fails below.
 */
test("only lib/sessions/live.mjs spawns `claude` for sessions (derived walk, with exemptions named)", () => {
  const EXEMPT = {
    "lib/skills/skills-create.mjs": "`claude -p <prompt>` to generate a skill; not a session",
    "lib/core/plugin-validate.mjs": "`claude plugin validate`; not a session",
    "lib/core/release.mjs": "the release gate's `claude plugin validate`; not a session",
  };
  const spawnsClaude = (src) =>
    /\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync)\(\s*["'`]claude\b/.test(src) ||
    /\b[A-Za-z]*[bB]in\s*=\s*["']claude["']/.test(src) ||
    /PROPAGATE_CLAUDE_BIN/.test(src);
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : walk(p);
    return e.name.endsWith(".mjs") ? [p] : [];
  });
  const files = ["lib", "cli", "hooks"].flatMap((d) => walk(path.join(ROOT, d))).concat(path.join(ROOT, "cli.mjs"));
  assert.ok(files.length >= 50, `only ${files.length} source files walked: the scan has gone blind, it has not found nothing`);
  const hits = files.filter((f) => spawnsClaude(readFileSync(f, "utf8"))).map((f) => path.relative(ROOT, f));
  assert.ok(hits.includes("lib/sessions/live.mjs"), "the scan cannot see live.mjs, so it is blind");
  const offenders = hits.filter((h) => h !== "lib/sessions/live.mjs" && !Object.hasOwn(EXEMPT, h));
  assert.deepEqual(offenders, [], `these files run the claude binary outside lib/sessions/live.mjs: ${offenders.join(", ")}`);
  const stale = Object.keys(EXEMPT).filter((e) => !hits.includes(e));
  assert.deepEqual(stale, [], `exemptions that no longer spawn claude, delete them: ${stale.join(", ")}`);
});
