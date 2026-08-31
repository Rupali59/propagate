/**
 * The SessionStart hook detects rule restatements — and says nothing when
 * there are none.
 *
 * `rules check` existed and worked for weeks while sitting in NO gate: not
 * doctor, not CI, not the release gates. A drift detector computed only when
 * someone asks is indistinguishable from one that does not exist
 * (rule:enforcement-watches-itself #5). It now runs from the one thing that
 * already walks the rules directory every session.
 *
 * THE SILENCE TEST IS THE LOAD-BEARING ONE. This hook's output lands in every
 * session's context. A detector that speaks when there is nothing to say
 * becomes the thing everyone scrolls past — which is exactly how the
 * monitor's `info` line went unread for hours while the agent was dead. So
 * "fires on a real restatement" and "silent on a clean tree" are equally
 * required, and the second is the one that would rot first.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = fileURLToPath(new URL("../../hooks/load-rules.mjs", import.meta.url));

const RULE = `---
id: fixture-rule
scope: global
status: active
fingerprint: "the sky is plaid on tuesdays"
supersedes: []
---

**the sky is plaid on tuesdays.** This is a fixture rule; its fingerprint is a
phrase no real file would contain by accident.
`;

/**
 * A scoped HOME (so RULES_DIR resolves into the fixture) plus a scoped search
 * root (so the detector scans only the fixture's CLAUDE.md files).
 */
async function withFixture(fn) {
  const home = await mkdtemp(path.join(tmpdir(), "load-rules-home-"));
  const roots = await mkdtemp(path.join(tmpdir(), "load-rules-roots-"));
  await mkdir(path.join(home, ".claude", "rules"), { recursive: true });
  await writeFile(path.join(home, ".claude", "rules", "fixture-rule.md"), RULE);
  try {
    return await fn({ home, roots });
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    await rm(roots, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

function runHook({ home, roots }) {
  const r = spawnSync(process.execPath, [HOOK], {
    encoding: "utf8",
    input: JSON.stringify({ hook_event_name: "SessionStart", source: "startup" }),
    env: {
      ...process.env,
      HOME: home,
      PROPAGATE_SEARCH_ROOTS: roots,
      PROPAGATE_STATE_DIR: path.join(home, ".propagate"),
    },
  });
  let ctx = "";
  try {
    ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  } catch {
    ctx = `((unparseable stdout: ${r.stdout.slice(0, 200)} stderr: ${r.stderr.slice(0, 200)}))`;
  }
  return { ...r, ctx };
}

test("SILENT when no CLAUDE.md restates a rule — the property that would rot first", async () => {
  await withFixture(async ({ home, roots }) => {
    await writeFile(path.join(roots, "CLAUDE.md"), "# A project\n\nNothing here restates anything.\n");
    const { ctx } = runHook({ home, roots });
    // Was `/Canonical rules/` — an assertion that the hook had emitted the rule
    // BODIES. It stopped doing that on 2026-08-29 (Claude Code loads
    // ~/.claude/rules/ natively; this hook was a second copy). The property that
    // replaced it is ATTRIBUTABILITY, not delivery: this hook cannot observe the
    // native memory load and must not assert one. What it must still do is say how
    // many rule files parsed and by what mechanism they arrive, so that "no bodies
    // visible, by design" cannot be mistaken for "the rules layer is broken".
    assert.match(ctx, /\b1 canonical rule file\(s\) parsed\b/, "must state how many rule files parsed");
    assert.match(ctx, /delivered natively/, "must name the delivery mechanism, not leave it implied");
    // And it must NOT go back to shipping bodies — this is the regression guard for
    // the 51,112-byte duplication, which was invisible for two weeks precisely
    // because nothing asserted its absence.
    assert.doesNotMatch(ctx, /^### rule:/m, `must not re-inject rule bodies:\n${ctx.slice(0, 300)}`);
    assert.doesNotMatch(ctx, /RESTATEMENT/, `must not speak when clean:\n${ctx.slice(-400)}`);
    assert.doesNotMatch(ctx, /did not run|could not run/, `the check must have actually run:\n${ctx.slice(-400)}`);
  });
});

test("FIRES on a real restatement, and names the file", async () => {
  await withFixture(async ({ home, roots }) => {
    await writeFile(
      path.join(roots, "CLAUDE.md"),
      "# A project\n\nRemember: the sky is plaid on tuesdays, always.\n",
    );
    const { ctx } = runHook({ home, roots });
    assert.match(ctx, /RESTATEMENT/, `must fire on a copied rule:\n${ctx.slice(-600)}`);
    // Must match the FINDING line, not the rules listing. `/fixture-rule/`
    // alone passes vacuously: this hook prints every rule body, so the id
    // appears whether or not a restatement was detected. That weak assertion
    // let a wrong field name (f.id, when the detector emits f.rule) survive
    // here and be caught only by the doctor test, which prints no bodies.
    assert.match(ctx, /restates rule:fixture-rule/, "must name WHICH rule, on the finding line");
    assert.match(ctx, /CLAUDE\.md/, "must name the offending file");
    // Attribution of scope, not just of the finding: "2 restatements" without
    // "across N files scanned" cannot be checked against later.
    assert.match(ctx, /file\(s\) scanned/);
  });
});

test("a DECLARED deviation is not a restatement", async () => {
  await withFixture(async ({ home, roots }) => {
    await writeFile(
      path.join(roots, "CLAUDE.md"),
      "# A project\n\n**`overrides: fixture-rule`** — this project genuinely differs, and says so.\n" +
        "the sky is plaid on tuesdays here for a stated reason.\n",
    );
    const { ctx } = runHook({ home, roots });
    assert.doesNotMatch(
      ctx,
      /RESTATEMENT/,
      `a declared deviation is the supported escape hatch, not drift:\n${ctx.slice(-600)}`,
    );
  });
});

test("a check that CANNOT run says so — it must never read as no-drift", async () => {
  await withFixture(async ({ home }) => {
    // A search root that does not EXIST -> `roots-missing`: the scan was
    // incomplete, which warns. Distinct from a root that exists and holds no
    // CLAUDE.md -> `no-files-scanned`, which is silent (next test). Collapsing
    // those two is what broke two doctor fixtures on this check's first run.
    const { ctx } = runHook({ home, roots: path.join(tmpdir(), "load-rules-absent-root-xyz") });
    assert.match(ctx, /could not run|did not run/, `absence must be attributable:\n${ctx.slice(-400)}`);
    assert.match(
      ctx,
      /scan was INCOMPLETE/i,
      "must say the scan was incomplete — 'roots-missing' is a DIFFERENT fact from having nothing to scan",
    );
  });
});

test("SILENT when a root exists but holds no CLAUDE.md — nothing to check is not a failure", async () => {
  // Every scoped test fixture and every fresh install looks like this. A
  // SessionStart warning here would train the reader to ignore the one that
  // matters, which is the failure mode this hook's silence exists to avoid.
  await withFixture(async ({ home, roots }) => {
    const { ctx } = runHook({ home, roots }); // roots exists, contains nothing
    assert.doesNotMatch(ctx, /RULES CHECK could not run/, `an empty root must be silent:\n${ctx.slice(-400)}`);
    assert.doesNotMatch(ctx, /RESTATEMENT/, "and must not claim findings either");
  });
});
