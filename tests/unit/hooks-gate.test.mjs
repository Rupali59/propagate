/**
 * hooks-gate.test.mjs — `propagate hooks instructions-gate` (#221).
 *
 * Every repo is a real git repo in a temp dir, built by hand. The safety-flag test snapshots every
 * fixture's `.githooks` and `.git/config` before and after a run WITHOUT --apply
 * (rule:safety-flag-needs-a-test): it measures the side effect, not the word "would" in stdout.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { planInstructionGate, applyPlan, insertGate, scriptCallsGate, ownerOfRemote, GATE_SNIPPET } from "../../lib/report/hooks-gate.mjs";
import { hooksCmd } from "../../cli/hooks.mjs";
import { checkHooks } from "../../lib/report/doctor/hooks.mjs";
import { Reporter } from "../../lib/report/doctor/reporter.mjs";

const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function world() {
  const dir = mkdtempSync(path.join(tmpdir(), "hooks-gate-"));
  const repos = [];
  const make = (name, { remote = "https://github.com/acme/" + name + ".git", files = ["CLAUDE.md"], hooks = null, hooksPath = null, gitHook = null } = {}) => {
    const root = path.join(dir, name);
    mkdirSync(root, { recursive: true });
    git(root, "init", "-q");
    git(root, "config", "user.email", "t@example.com");
    git(root, "config", "user.name", "t");
    if (remote) git(root, "remote", "add", "origin", remote);
    for (const f of files) {
      mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
      writeFileSync(path.join(root, f), "# rules\n");
    }
    if (!files.length) writeFileSync(path.join(root, "README.md"), "x\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "init");
    if (hooksPath) git(root, "config", "core.hooksPath", hooksPath);
    if (hooks !== null) {
      const hd = path.join(root, hooksPath ?? ".githooks");
      mkdirSync(hd, { recursive: true });
      writeFileSync(path.join(hd, "pre-commit"), hooks);
    }
    if (gitHook !== null) writeFileSync(path.join(root, ".git", "hooks", "pre-commit"), gitHook);
    repos.push({ root, name });
    return root;
  };
  return { dir, repos, make, clean: () => rmSync(dir, { recursive: true, force: true }) };
}

const row = (plan, name) => plan.rows.find((r) => r.repo === name);

function snapshot(roots) {
  const out = [];
  for (const r of roots) {
    out.push(`${r}:config=${readFileSync(path.join(r, ".git", "config"), "utf8")}`);
    const hd = path.join(r, ".githooks");
    if (existsSync(hd)) for (const f of readdirSync(hd).sort()) out.push(`${hd}/${f}=${readFileSync(path.join(hd, f), "utf8")}:${statSync(path.join(hd, f)).mode}`);
    else out.push(`${hd}=ABSENT`);
    const gh = path.join(r, ".git", "hooks", "pre-commit");
    out.push(`${gh}=${existsSync(gh) ? readFileSync(gh, "utf8") : "ABSENT"}`);
  }
  return out.join("\n");
}

test("repo tracking CLAUDE.md with no hooks: would create, and would set hooksPath", () => {
  const w = world();
  try {
    w.make("a");
    const p = planInstructionGate({ repos: w.repos, owned: ["acme"] });
    assert.equal(row(p, "a").action, "create");
    assert.equal(row(p, "a").config, "set");
    assert.equal(row(p, "a").owned, true);
  } finally { w.clean(); }
});

test("existing pre-commit without the gate: would append", () => {
  const w = world();
  try {
    w.make("a", { hooksPath: ".githooks", hooks: "#!/bin/sh\necho hi\nexit 0\n" });
    const p = planInstructionGate({ repos: w.repos, owned: ["acme"] });
    assert.equal(row(p, "a").action, "append");
    assert.equal(row(p, "a").config, "keep");
  } finally { w.clean(); }
});

test("existing pre-commit with the gate: nothing", () => {
  const w = world();
  try {
    w.make("a", { hooksPath: ".githooks", hooks: `#!/bin/sh\n${GATE_SNIPPET}exit 0\n` });
    assert.equal(row(planInstructionGate({ repos: w.repos, owned: ["acme"] }), "a").action, "none");
  } finally { w.clean(); }
});

test("a commented-out gate line is not a gate", () => {
  assert.equal(scriptCallsGate("#!/bin/sh\n# node cli.mjs instructions --gate\nexit 0\n"), false);
  assert.equal(scriptCallsGate("node cli.mjs instructions --gate\n"), true);
});

test("core.hooksPath elsewhere inside the repo: appended there, not repointed", () => {
  const w = world();
  try {
    const root = w.make("a", { hooksPath: "tools/hooks", hooks: "#!/bin/sh\nexit 0\n" });
    const p = planInstructionGate({ repos: w.repos, owned: ["acme"] });
    assert.equal(row(p, "a").action, "append");
    assert.ok(row(p, "a").hookFile.endsWith(path.join("tools", "hooks", "pre-commit")));
    applyPlan(p.rows);
    assert.equal(git(root, "config", "--get", "core.hooksPath").trim(), "tools/hooks");
    assert.ok(scriptCallsGate(readFileSync(path.join(root, "tools", "hooks", "pre-commit"), "utf8")));
    assert.ok(!existsSync(path.join(root, ".githooks")));
  } finally { w.clean(); }
});

test("core.hooksPath outside the repo is skipped, never written", () => {
  const w = world();
  try {
    const shared = path.join(w.dir, "shared-hooks");
    mkdirSync(shared);
    w.make("a", { hooksPath: shared });
    const r = row(planInstructionGate({ repos: w.repos, owned: ["acme"] }), "a");
    assert.equal(r.action, "skip-external");
  } finally { w.clean(); }
});

test("an existing real .git/hooks/pre-commit is appended to, not orphaned by repointing", () => {
  const w = world();
  try {
    const root = w.make("a", { gitHook: "#!/bin/sh\necho mine\n" });
    const p = planInstructionGate({ repos: w.repos, owned: ["acme"] });
    assert.equal(row(p, "a").action, "append");
    assert.equal(row(p, "a").config, "keep");
    applyPlan(p.rows);
    assert.throws(() => git(root, "config", "--get", "core.hooksPath"), /./);
  } finally { w.clean(); }
});

test("a not-owned remote is skipped, and --apply does not touch it", () => {
  const w = world();
  try {
    const root = w.make("a", { remote: "git@github.com:someone-else/a.git" });
    const p = planInstructionGate({ repos: w.repos, owned: ["acme"] });
    assert.equal(row(p, "a").owned, false);
    assert.equal(applyPlan(p.rows).length, 0);
    assert.ok(!existsSync(path.join(root, ".githooks")));
  } finally { w.clean(); }
});

test("empty allowlist: nothing is owned", () => {
  const w = world();
  try {
    w.make("a");
    const p = planInstructionGate({ repos: w.repos, owned: [] });
    assert.equal(row(p, "a").owned, false);
    assert.equal(applyPlan(p.rows).length, 0);
  } finally { w.clean(); }
});

test("a repo tracking no instruction file is excluded and counted", () => {
  const w = world();
  try {
    w.make("a", { files: [] });
    w.make("b", { files: ["pkg/AGENTS.md"] });
    const p = planInstructionGate({ repos: w.repos, owned: ["acme"] });
    assert.equal(row(p, "a"), undefined);
    assert.equal(p.excluded, 1);
    assert.ok(row(p, "b"), "an instruction file at depth is tracked");
  } finally { w.clean(); }
});

test("0 repos: the floor says the scan is blind", () => {
  const p = planInstructionGate({ repos: [], owned: ["acme"] });
  assert.equal(p.blind, true);
  assert.match(p.reason, /only 0 repos found .* gone blind/);
});

test("hooksCmd exits 2 on a blind scan", async () => {
  const code = await hooksCmd(["instructions-gate"], { repos: [], out: () => {} });
  assert.equal(code, 2);
});

test("SAFETY FLAG: without --apply, no fixture's .githooks or .git/config changes (every action kind)", async () => {
  const w = world();
  try {
    w.make("create");
    w.make("append", { hooksPath: ".githooks", hooks: "#!/bin/sh\nexit 0\n" });
    w.make("gitHook", { gitHook: "#!/bin/sh\necho x\n" });
    w.make("gated", { hooksPath: ".githooks", hooks: `#!/bin/sh\n${GATE_SNIPPET}` });
    w.make("foreign", { remote: "git@github.com:other/foreign.git" });
    const roots = w.repos.map((r) => r.root);
    const before = snapshot(roots);
    const lines = [];
    for (const extra of [[], ["--json"]]) {
      const code = await hooksCmd(["instructions-gate", "--owned", "acme", ...extra], { repos: w.repos, out: (s) => lines.push(s) });
      assert.equal(code, 0);
    }
    assert.ok(lines.join("\n").includes("create"), "the dry run reported actions");
    assert.equal(snapshot(roots), before, "dry run must not touch .githooks or .git/config");
    // And the control: the same call WITH --apply does change them, so the snapshot can fail.
    await hooksCmd(["instructions-gate", "--apply", "--owned", "acme"], { repos: w.repos, out: () => {} });
    assert.notEqual(snapshot(roots), before);
  } finally { w.clean(); }
});

test("--apply then dry-run again: nothing to do (idempotent), hook executable, nothing committed", async () => {
  const w = world();
  try {
    const a = w.make("create");
    w.make("append", { hooksPath: ".githooks", hooks: "#!/bin/sh\necho hi\nexit 0\n" });
    const head = git(a, "rev-parse", "HEAD");
    await hooksCmd(["instructions-gate", "--apply", "--owned", "acme"], { repos: w.repos, out: () => {} });
    const p = planInstructionGate({ repos: w.repos, owned: ["acme"] });
    assert.deepEqual(p.rows.map((r) => r.action), ["none", "none"]);
    assert.equal(git(a, "config", "--get", "core.hooksPath").trim(), ".githooks");
    assert.ok(statSync(path.join(a, ".githooks", "pre-commit")).mode & 0o100, "created hook is executable");
    assert.equal(git(a, "rev-parse", "HEAD"), head, "apply never commits");
    // the appended gate sits BEFORE the hook's exit, or it would never run
    const script = readFileSync(path.join(w.dir, "append", ".githooks", "pre-commit"), "utf8");
    assert.ok(script.indexOf("instructions --gate") < script.lastIndexOf("\nexit 0"));
  } finally { w.clean(); }
});

test("insertGate places the gate before the first column-0 exit", () => {
  const out = insertGate("#!/bin/sh\necho a\nexit 0\n");
  assert.ok(out.indexOf("instructions --gate") < out.indexOf("\nexit 0"));
  assert.ok(insertGate("#!/bin/sh\necho a\n").includes("instructions --gate"));
});

test("the hook snippet: passes through exit 0/2, blocks on 1, skips with a notice when propagate is absent", () => {
  const w = world();
  try {
    const fake = (name, code) => {
      const f = path.join(w.dir, name);
      writeFileSync(f, `process.exit(${code});\n`);
      return f;
    };
    const run = (cliPath, extraEnv = {}) => {
      const hook = path.join(w.dir, "hook.sh");
      writeFileSync(hook, `#!/bin/sh\n${GATE_SNIPPET}exit 0\n`);
      try {
        const o = execFileSync("sh", [hook], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HOME: w.dir, PROPAGATE_CLI: cliPath, ...extraEnv } });
        return { code: 0, out: o };
      } catch (e) { return { code: e.status, err: String(e.stderr) }; }
    };
    assert.equal(run(fake("ok.mjs", 0)).code, 0);
    assert.equal(run(fake("block.mjs", 1)).code, 1);
    assert.equal(run(fake("judge.mjs", 2)).code, 0);
    const missing = run(path.join(w.dir, "does-not-exist.mjs"));
    assert.equal(missing.code, 0, "a missing propagate never blocks a commit");
  } finally { w.clean(); }
});

test("the snippet as the LAST thing in a hook still exits 0 on a pass (no trailing exit 0 to hide behind)", () => {
  // 2026-11-11: the block ended `[ "$_pg_rc" -eq 2 ] && echo ...`. On a pass that test is false, so a hook with nothing
  // after the block exited 1 and blocked every commit, silently: 5 of 28 gated hooks ended at the block. The test above
  // always appends `exit 0`, the one shape that hides it. Literal hook text, no builder (rule:mutate-behind-the-fixture-builder).
  const w = world();
  try {
    const run = (code) => {
      const f = path.join(w.dir, `cli-${code}.mjs`);
      writeFileSync(f, `process.exit(${code});\n`);
      const hook = path.join(w.dir, "last.sh");
      writeFileSync(hook, `#!/bin/sh\necho earlier step\n${GATE_SNIPPET}`);
      try { execFileSync("sh", [hook], { stdio: "pipe", env: { ...process.env, HOME: w.dir, PROPAGATE_CLI: f } }); return 0; } catch (e) { return e.status; }
    };
    assert.equal(run(0), 0, "a passing gate at the end of a hook must not block the commit");
    assert.equal(run(2), 0, "could-not-judge is allowed");
    assert.equal(run(1), 1, "and a real over-limit still blocks");
  } finally { w.clean(); }
});

test("the hook resolves the installed plugin from installed_plugins.json (no relative path)", () => {
  const w = world();
  try {
    const plug = path.join(w.dir, "plug");
    mkdirSync(plug);
    writeFileSync(path.join(plug, "cli.mjs"), "process.exit(1);\n");
    mkdirSync(path.join(w.dir, ".claude", "plugins"), { recursive: true });
    writeFileSync(path.join(w.dir, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "propagate@propagate": [{ installPath: plug }] } }));
    const hook = path.join(w.dir, "hook.sh");
    writeFileSync(hook, `#!/bin/sh\n${GATE_SNIPPET}exit 0\n`);
    let status = 0;
    try { execFileSync("sh", [hook], { stdio: "pipe", env: { ...process.env, HOME: w.dir, PROPAGATE_CLI: "" } }); } catch (e) { status = e.status; }
    assert.equal(status, 1, "the plugin's cli.mjs was found and its exit 1 blocked");
  } finally { w.clean(); }
});

test("ownerOfRemote reads https and scp forms, lowercased", () => {
  assert.equal(ownerOfRemote("https://github.com/Acme/x.git"), "acme");
  assert.equal(ownerOfRemote("git@github.com:Acme/x.git"), "acme");
  assert.equal(ownerOfRemote(null), null);
  assert.equal(ownerOfRemote("not a url"), null);
});

test("doctor: a repo tracking an instruction file without the gate is a warn, never a fail", async () => {
  const w = world();
  try {
    w.make("ungated");
    w.make("gated", { hooksPath: ".githooks", hooks: `#!/bin/sh\n${GATE_SNIPPET}` });
    // With an owner allowlist, each owned ungated repo is a warn, naming it.
    const gatePlan = planInstructionGate({ repos: w.repos, owned: [] });
    for (const r of gatePlan.rows) r.owned = true; // treat the fixtures as owned: the allowlist path is under test, not remote parsing
    const reporter = new Reporter();
    await checkHooks({ reporter, roots: [w.dir], gatePlan, ownedAllowlist: ["fixture-owner"] });
    const warns = reporter.drain().filter((e) => e.kind === "warn");
    assert.equal(warns.length, 1);
    assert.equal(warns[0].label, "instruction-budget gate missing");
    assert.match(warns[0].detail, /^ungated:/);
    assert.equal(reporter.problems, 0);
  } finally { w.clean(); }
});

test("doctor: with NO owner allowlist the gaps are one info line, not a warn per repo (the first real run would have added 44 warnings)", async () => {
  const w = world();
  try {
    w.make("ungated-a");
    w.make("ungated-b");
    const gatePlan = planInstructionGate({ repos: w.repos, owned: [] });
    const reporter = new Reporter();
    await checkHooks({ reporter, roots: [w.dir], gatePlan, ownedAllowlist: [] });
    const entries = reporter.drain();
    assert.deepEqual(entries.filter((e) => e.kind === "warn" && e.label === "instruction-budget gate missing"), []);
    assert.match(JSON.stringify(entries), /2 repo\(s\) tracking an instruction file lack the gate; ownership is not configured/);
  } finally { w.clean(); }
});

test("an excluded repo (hooks.excludeRepos) is reported and never planned for a write, even when owned", () => {
  const w = world();
  try {
    w.make("fork");
    const plan = planInstructionGate({ repos: w.repos, owned: [], exclude: [w.repos[0].name] });
    assert.equal(plan.rows[0].action, "excluded");
    assert.equal(plan.rows[0].owned, false);
  } finally { w.clean(); }
});

test("a gate block written by an older version is planned as 'update', replaced by --apply, and then left alone", () => {
  const w = world();
  try {
    // A literal old block: same markers, a different body (the pre-fix resolver). Not built from GATE_SNIPPET.
    const old = "#!/bin/sh\n# >>> propagate instructions-gate (propagate#221) - old\n_pg_cli=\"/stale/cli.mjs\"\nnode \"$_pg_cli\" instructions --gate\n# <<< propagate instructions-gate\nexit 0\n";
    w.make("stale", { hooksPath: ".githooks", hooks: old, remote: "https://github.com/me/stale.git" });
    const p1 = planInstructionGate({ repos: w.repos, owned: ["me"] });
    assert.equal(row(p1, "stale").action, "update");
    applyPlan(p1.rows);
    const now = readFileSync(path.join(w.repos[0].root, ".githooks", "pre-commit"), "utf8");
    assert.ok(now.includes(GATE_SNIPPET.replace(/\n$/, "")), "the current block replaces the old one");
    assert.ok(!now.includes("/stale/cli.mjs"), "the old body is gone");
    assert.ok(now.trimEnd().endsWith("exit 0"), "text outside the markers is kept");
    const p2 = planInstructionGate({ repos: w.repos, owned: ["me"] });
    assert.equal(row(p2, "stale").action, "none", "idempotent after the update");
  } finally { w.clean(); }
});

test("the hook resolves propagate from the directory marketplace before a stale cached installPath", () => {
  const home = mkdtempSync(path.join(tmpdir(), "hooks-home-"));
  try {
    const live = path.join(home, "live"); const stale = path.join(home, "stale");
    for (const d of [live, stale]) { mkdirSync(d, { recursive: true }); writeFileSync(path.join(d, "cli.mjs"), "// fake\n"); }
    mkdirSync(path.join(home, ".claude", "plugins"), { recursive: true });
    writeFileSync(path.join(home, ".claude", "plugins", "known_marketplaces.json"), JSON.stringify({ propagate: { source: { source: "directory", path: live } } }));
    writeFileSync(path.join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "propagate@propagate": [{ installPath: stale }] } }));
    // The resolver line, lifted from the snippet itself so the test exercises what ships.
    const line = GATE_SNIPPET.split("\n").find((l) => l.includes("known_marketplaces.json"));
    assert.ok(line, "the snippet must consult known_marketplaces.json");
    const js = line.slice(line.indexOf("node -e '") + "node -e '".length, line.lastIndexOf("'"));
    const out = execFileSync(process.execPath, ["-e", js], { env: { ...process.env, HOME: home }, encoding: "utf8" });
    assert.equal(out, path.join(live, "cli.mjs"));
    rmSync(path.join(home, ".claude", "plugins", "known_marketplaces.json"));
    const fallback = execFileSync(process.execPath, ["-e", js], { env: { ...process.env, HOME: home }, encoding: "utf8" });
    assert.equal(fallback, path.join(stale, "cli.mjs"), "with no directory marketplace it falls back to installPath");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
