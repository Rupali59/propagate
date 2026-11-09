/**
 * #219 -- every reader of the "rule restated" finding honours the ONE accepted-findings registry
 * (scripts/execution/health-exceptions.yml). Before this, only doctor did: `rules check` exited 1 on
 * every run for a finding accepted as permanent, and the session banner warned about it at every start.
 *
 * FIXTURES ARE LITERAL STRINGS ON PURPOSE. They must not move onto a shared builder: a builder that
 * quietly normalised the registry key or the CLAUDE.md text would make an accepted/stale verdict pass
 * for the builder's reasons rather than the code's (rule:discernment-checks section 1).
 *
 * Every verdict is asserted WITH its reason, not just its exit code: a check that fails for the wrong
 * reason is as bad as one that cannot fail.
 */
// @size medium -- starts processes (CLI or script); run when affected

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkRulesAdjudicated } from "../../lib/rules/rules-check.mjs";

const HOOK = fileURLToPath(new URL("../../hooks/load-rules.mjs", import.meta.url));
const CLI = fileURLToPath(new URL("../../cli.mjs", import.meta.url));

// A fixture rule, a restating CLAUDE.md, and registries, all literal.
const RULE = '---\nid: fixture-rule\nscope: global\nstatus: active\nfingerprint: "the sky is plaid on tuesdays"\n---\n\nthe sky is plaid on tuesdays.\n';
const RESTATER = "# Fork\n\nRemember: the sky is plaid on tuesdays, always.\n";
const CLEAN = "# Fork\n\nNothing here restates anything.\n";
const REGISTRY_ACCEPTING =
  'exceptions:\n  "rules-restated:fixture-rule@Fork/CLAUDE.md":\n    reason: "PERMANENT: not our fork"\n    since: 2026-09-25\n';
const REGISTRY_EMPTY = "exceptions: {}\n";
const REGISTRY_BROKEN = "exceptions: [this is not a mapping\n";

/** hub/scripts/execution/health-exceptions.yml, hub/Fork/CLAUDE.md, hub-adjacent rules dir. */
function fixture({ registry, claudeMd }) {
  const hub = mkdtempSync(path.join(tmpdir(), "rules-accepted-"));
  const rulesDir = path.join(hub, "_rules");
  mkdirSync(rulesDir, { recursive: true });
  writeFileSync(path.join(rulesDir, "fixture-rule.md"), RULE);
  mkdirSync(path.join(hub, "Fork"), { recursive: true });
  writeFileSync(path.join(hub, "Fork", "CLAUDE.md"), claudeMd);
  const registryFile = path.join(hub, "scripts", "execution", "health-exceptions.yml");
  if (registry !== null) {
    mkdirSync(path.dirname(registryFile), { recursive: true });
    writeFileSync(registryFile, registry);
  }
  return { hub, rulesDir, registryFile, roots: [path.join(hub, "Fork")], cleanup: () => rmSync(hub, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) };
}

function run(f) {
  return checkRulesAdjudicated({ rulesDir: f.rulesDir, roots: [f.hub], exclude: [], registryFile: f.registryFile });
}

test("a restatement with a matching registry entry is ACCEPTED: exit 0, reason and since carried", () => {
  const f = fixture({ registry: REGISTRY_ACCEPTING, claudeMd: RESTATER });
  try {
    const r = run(f);
    assert.equal(r.diagnostic, "ok");
    assert.equal(r.failing.length, 0, JSON.stringify(r.failing));
    assert.equal(r.accepted.length, 1);
    assert.equal(r.accepted[0].reason, "PERMANENT: not our fork");
    assert.equal(r.accepted[0].since, "2026-09-25");
    assert.equal(r.accepted[0].key, "rules-restated:fixture-rule@Fork/CLAUDE.md", "subject must be <rule>@<hub-relative path>, as doctor builds it");
    assert.deepEqual(r.stale, []);
    assert.equal(r.exitCode, 0);
  } finally {
    f.cleanup();
  }
});

test("the same restatement with NO entry is failing: exit 1, nothing accepted", () => {
  const f = fixture({ registry: REGISTRY_EMPTY, claudeMd: RESTATER });
  try {
    const r = run(f);
    assert.equal(r.failing.length, 1);
    assert.equal(r.failing[0].rule, "fixture-rule");
    assert.equal(r.accepted.length, 0);
    assert.equal(r.exitCode, 1);
  } finally {
    f.cleanup();
  }
});

test("an entry whose finding is gone is STALE: exit 1, and the key is named", () => {
  const f = fixture({ registry: REGISTRY_ACCEPTING, claudeMd: CLEAN });
  try {
    const r = run(f);
    assert.equal(r.failing.length, 0);
    assert.deepEqual(r.stale, ["rules-restated:fixture-rule@Fork/CLAUDE.md"]);
    assert.equal(r.exitCode, 1, "a stale exception fails: the list may not outlive its reason");
  } finally {
    f.cleanup();
  }
});

test("a v3-layout-empty entry is NOT judged stale here (doctor owns it)", () => {
  const f = fixture({
    registry: 'exceptions:\n  "v3-layout-empty:Husk":\n    reason: "doc-only husk"\n    since: 2026-10-15\n',
    claudeMd: CLEAN,
  });
  try {
    const r = run(f);
    assert.deepEqual(r.stale, []);
    assert.equal(r.exitCode, 0);
  } finally {
    f.cleanup();
  }
});

test("a MISSING registry is exit 2 'registry-missing', never 0 and never 1", () => {
  const f = fixture({ registry: null, claudeMd: RESTATER });
  try {
    const r = run(f);
    assert.equal(r.exitCode, 2);
    assert.equal(r.diagnostic, "registry-missing");
    assert.equal(r.registry.state, "missing");
    assert.equal(r.accepted.length, 0, "nothing may be accepted without a registry");
  } finally {
    f.cleanup();
  }
});

test("an UNPARSEABLE registry is exit 2 'registry-broken'", () => {
  const f = fixture({ registry: REGISTRY_BROKEN, claudeMd: RESTATER });
  try {
    const r = run(f);
    assert.equal(r.exitCode, 2);
    assert.equal(r.diagnostic, "registry-broken");
  } finally {
    f.cleanup();
  }
});

test("excusedCount reports the referenced-and-restated bucket (#81), so green states its coverage", () => {
  const f = fixture({
    registry: REGISTRY_EMPTY,
    claudeMd: "# Fork\n\nSee rule:fixture-rule. Also: the sky is plaid on tuesdays.\n",
  });
  try {
    const r = run(f);
    assert.equal(r.exitCode, 0, "a pointer plus a copy is excused, not failing");
    assert.equal(r.excusedCount, 1);
  } finally {
    f.cleanup();
  }
});

/** The hook and the CLI resolve ~/.claude/rules from HOME, so the fixture rule lives there. */
function scopedHome(f) {
  const home = path.join(f.hub, "_home");
  mkdirSync(path.join(home, ".claude", "rules"), { recursive: true });
  writeFileSync(path.join(home, ".claude", "rules", "fixture-rule.md"), RULE);
  return home;
}

function hookCtx(f) {
  const r = spawnSync(process.execPath, [HOOK], {
    encoding: "utf8",
    input: JSON.stringify({ hook_event_name: "SessionStart", source: "startup" }),
    env: {
      ...process.env,
      HOME: scopedHome(f),
      PROPAGATE_SEARCH_ROOTS: f.hub,
      PROPAGATE_HEALTH_EXCEPTIONS_FILE: f.registryFile,
      PROPAGATE_STATE_DIR: path.join(f.hub, "_state"),
    },
  });
  try {
    return JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  } catch {
    return `((unparseable: ${r.stdout.slice(0, 200)} / ${r.stderr.slice(0, 200)}))`;
  }
}

test("banner: an accepted-only tree prints NO restatement warning, plus the dim accepted line", () => {
  const f = fixture({ registry: REGISTRY_ACCEPTING, claudeMd: RESTATER });
  try {
    const ctx = hookCtx(f);
    assert.doesNotMatch(ctx, /RESTATEMENT/, ctx.slice(-500));
    assert.match(ctx, /1 accepted restatement\(s\), see health-exceptions\.yml/, ctx.slice(-500));
  } finally {
    f.cleanup();
  }
});

test("banner: an UNLISTED restatement still warns", () => {
  const f = fixture({ registry: REGISTRY_EMPTY, claudeMd: RESTATER });
  try {
    const ctx = hookCtx(f);
    assert.match(ctx, /1 RESTATEMENT\(S\)/, ctx.slice(-500));
    assert.match(ctx, /restates rule:fixture-rule/);
  } finally {
    f.cleanup();
  }
});

test("banner: a stale entry is a warning", () => {
  const f = fixture({ registry: REGISTRY_ACCEPTING, claudeMd: CLEAN });
  try {
    const ctx = hookCtx(f);
    assert.match(ctx, /STALE accepted-restatement/, ctx.slice(-500));
    assert.match(ctx, /rules-restated:fixture-rule@Fork\/CLAUDE\.md/);
  } finally {
    f.cleanup();
  }
});

test("banner: a missing registry keeps the finding a warning (nothing could be accepted) and does not fail the hook", () => {
  const f = fixture({ registry: null, claudeMd: RESTATER });
  try {
    const ctx = hookCtx(f);
    assert.match(ctx, /1 RESTATEMENT\(S\)/, ctx.slice(-500));
  } finally {
    f.cleanup();
  }
});

test("CLI: `rules check` exits 0 with the accepted reason and the coverage line; --json carries the split", () => {
  const f = fixture({ registry: REGISTRY_ACCEPTING, claudeMd: RESTATER });
  try {
    const env = {
      ...process.env,
      HOME: scopedHome(f),
      PROPAGATE_SEARCH_ROOTS: f.hub,
      PROPAGATE_HEALTH_EXCEPTIONS_FILE: f.registryFile,
      PROPAGATE_STATE_DIR: path.join(f.hub, "_state"),
    };
    const t = spawnSync(process.execPath, [CLI, "rules", "check"], { encoding: "utf8", env, input: "" });
    const out = t.stdout.replace(/\x1B\[[0-9;]*m/g, "");
    assert.equal(t.status, 0, out + t.stderr);
    assert.match(out, /PERMANENT: not our fork/);
    assert.match(out, /0 failing · 1 accepted · 0 excused \(not checked, #81\)/);
    const j = spawnSync(process.execPath, [CLI, "rules", "check", "--json"], { encoding: "utf8", env, input: "" });
    const parsed = JSON.parse(j.stdout);
    assert.equal(j.status, 0);
    assert.equal(parsed.failing.length, 0);
    assert.equal(parsed.accepted[0].reason, "PERMANENT: not our fork");
  } finally {
    f.cleanup();
  }
});

test("CLI: `rules check` exits 2 and says 'did not run' when the registry is missing", () => {
  const f = fixture({ registry: null, claudeMd: RESTATER });
  try {
    const t = spawnSync(process.execPath, [CLI, "rules", "check"], {
      encoding: "utf8",
      input: "",
      env: {
        ...process.env,
        HOME: scopedHome(f),
        PROPAGATE_SEARCH_ROOTS: f.hub,
        PROPAGATE_HEALTH_EXCEPTIONS_FILE: f.registryFile,
        PROPAGATE_STATE_DIR: path.join(f.hub, "_state"),
      },
    });
    const out = t.stdout.replace(/\x1B\[[0-9;]*m/g, "");
    assert.equal(t.status, 2, out + t.stderr);
    assert.match(out, /rules check did not run/);
    assert.match(out, /NOT a clean result/);
  } finally {
    f.cleanup();
  }
});

test("doctor: an inert gotcha reports at WARN (!), and the exit status is unchanged by it", () => {
  // A workspace whose GOTCHAS.md uses `### 1.1` headings parses to zero entries -> "unreadable".
  const mk = (withGotchas) => {
    const root = mkdtempSync(path.join(tmpdir(), "doctor-inert-"));
    writeFileSync(path.join(root, ".propagates.yml"), "workspace: true\nsources: {}\n");
    mkdirSync(path.join(root, "docs"), { recursive: true });
    writeFileSync(path.join(root, "docs", "PROPAGATION_LEDGER.jsonl"), "");
    if (withGotchas) writeFileSync(path.join(root, "docs", "GOTCHAS.md"), "# Gotchas\n\n### 1.1 A hazard\n\nSome prose, no trigger.\n");
    const r = spawnSync(process.execPath, [CLI, "doctor"], {
      cwd: root,
      encoding: "utf8",
      input: "",
      env: { ...process.env, PROPAGATE_SEARCH_ROOTS: root, PROPAGATE_STATE_DIR: root },
    });
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    return { status: r.status, out: (r.stdout + r.stderr).replace(/\x1B\[[0-9;]*m/g, "") };
  };
  const without = mk(false);
  const withInert = mk(true);
  assert.match(withInert.out, /^\s*! gotchas inert/m, withInert.out);
  assert.doesNotMatch(withInert.out, /^\s*· gotchas inert/m, "must no longer be an info line");
  assert.doesNotMatch(withInert.out, /✗ gotchas inert/, "and must not be a failure");
  assert.equal(withInert.status, without.status, "a warn must not change doctor's exit status");
});
