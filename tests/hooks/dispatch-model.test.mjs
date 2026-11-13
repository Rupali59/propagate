// dispatch-model (propagate#265): a dispatch that disagrees with its issue's Model field is refused unless the
// prompt states a reason, and an allowed dispatch moves a Backlog / Ready item to In progress.
// Tested by EFFECT (rule:safety-flag-needs-a-test): a fake `gh` records every call, so "no write on deny" is a
// count of calls, not a read of the hook's own output. Snapshots and payloads are literals, never built through a
// helper that could only express valid ones (rule:mutate-behind-the-fixture-builder).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { extractRefs, decide } from "../../hooks/dispatch-model.mjs";

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "hooks", "dispatch-model.mjs");

const todayIso = () => new Date().toISOString();
const staleIso = () => new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();

const item = (model, status) => ({
  model,
  goal: "G1",
  status,
  projectId: "PVT_1",
  itemId: "PVTI_1",
  statusFieldId: "PVTSSF_1",
  inProgressOptionId: "opt-prog",
});

/** One sandbox per test: a state dir with an optional snapshot, and a fake gh that logs its calls. */
function sandbox({ snapshot, ghFails = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "dispatch-model-"));
  const state = path.join(root, "state");
  mkdirSync(path.join(state, "day"), { recursive: true });
  if (snapshot !== undefined) writeFileSync(path.join(state, "day", "items.json"), typeof snapshot === "string" ? snapshot : JSON.stringify(snapshot));
  const log = path.join(root, "gh.log");
  const gh = path.join(root, "gh");
  writeFileSync(gh, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\n${ghFails ? 'echo "HTTP 502 bad gateway" >&2\nexit 1' : "echo '{\"data\":{}}'"}\n`);
  chmodSync(gh, 0o755);
  const run = (payload, extraEnv = {}) => {
    const r = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      env: { ...process.env, PROPAGATE_STATE_DIR: state, PROPAGATE_GH_BIN: gh, ...extraEnv },
    });
    const out = r.stdout.trim() ? JSON.parse(r.stdout) : null;
    return {
      status: r.status,
      raw: r.stdout,
      ctx: out?.hookSpecificOutput?.additionalContext ?? "",
      deny: out?.hookSpecificOutput?.permissionDecision === "deny",
      reason: out?.hookSpecificOutput?.permissionDecisionReason ?? "",
    };
  };
  return {
    run,
    state,
    writes: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []),
    overrides: () => {
      const f = path.join(state, "day", "overrides.jsonl");
      return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    },
    snapshot: () => JSON.parse(readFileSync(path.join(state, "day", "items.json"), "utf8")),
  };
}

const dispatch = (prompt, model) => ({
  tool_name: "Agent",
  tool_input: { description: "x", subagent_type: "general-purpose", prompt, ...(model === undefined ? {} : { model }) },
});

const SNAP = (status = "Ready", model = "Sonnet") => ({ generatedAt: todayIso(), items: { "o/r#7": item(model, status) } });

test("a matching model is allowed and makes exactly one In progress write", () => {
  const sb = sandbox({ snapshot: SNAP("Ready", "Sonnet") });
  const r = sb.run(dispatch("Do o/r#7 now.", "sonnet"));
  assert.equal(r.status, 0);
  assert.equal(r.deny, false);
  assert.equal(sb.writes().length, 1, "one write");
  assert.match(sb.writes()[0], /updateProjectV2ItemFieldValue/);
  assert.match(sb.writes()[0], /PVTI_1/);
  assert.match(sb.writes()[0], /opt-prog/);
  assert.match(r.ctx, /o\/r#7 moved to In progress/);
});

test("an absent model is a mismatch: denied, naming the ref and both fixes, 0 writes", () => {
  const sb = sandbox({ snapshot: SNAP("Ready", "Sonnet") });
  const r = sb.run(dispatch("Do o/r#7 now."));
  assert.equal(r.deny, true);
  assert.match(r.reason, /o\/r#7/);
  assert.match(r.reason, /sonnet/);
  assert.match(r.reason, /inherit/);
  assert.match(r.reason, /model: "sonnet"/);
  assert.match(r.reason, /model_reason/);
  assert.equal(sb.writes().length, 0);
  assert.equal(sb.overrides().length, 0);
});

test("a mismatch with model_reason is allowed, records one override row and makes one write", () => {
  const sb = sandbox({ snapshot: SNAP("Backlog", "Sonnet") });
  const r = sb.run(dispatch("Do o/r#7 now.\nmodel_reason: the question is still undecided\n", "opus"));
  assert.equal(r.deny, false);
  const rows = sb.overrides();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ref, "o/r#7");
  assert.equal(rows[0].expected, "sonnet");
  assert.equal(rows[0].actual, "opus");
  assert.equal(rows[0].reason, "the question is still undecided");
  assert.equal(rows[0].subagent_type, "general-purpose");
  assert.ok(rows[0].ts);
  assert.equal(sb.writes().length, 1);
});

test("a mismatch without a reason is denied and makes 0 writes", () => {
  const sb = sandbox({ snapshot: SNAP("Ready", "Sonnet") });
  const r = sb.run(dispatch("Do o/r#7 now. model_reason: not at line start", "haiku"));
  assert.equal(r.deny, true);
  assert.match(r.reason, /uses haiku/);
  assert.equal(sb.writes().length, 0);
  assert.equal(sb.overrides().length, 0);
});

test("an empty model_reason does not count as a reason", () => {
  const sb = sandbox({ snapshot: SNAP("Ready", "Sonnet") });
  const r = sb.run(dispatch("Do o/r#7.\nmodel_reason:   \n", "haiku"));
  assert.equal(r.deny, true);
  assert.equal(sb.writes().length, 0);
});

test("with several refs, one mismatch refuses the dispatch and nothing is written", () => {
  const snapshot = { generatedAt: todayIso(), items: { "o/r#7": item("Sonnet", "Ready"), "o/r#8": item("Opus", "Ready") } };
  const sb = sandbox({ snapshot });
  const r = sb.run(dispatch("Do o/r#7 and o/r#8.", "sonnet"));
  assert.equal(r.deny, true);
  assert.match(r.reason, /o\/r#8/);
  assert.doesNotMatch(r.reason, /o\/r#7's/);
  assert.equal(sb.writes().length, 0);
});

test("a stale snapshot is allowed with 'not checked' and 0 writes", () => {
  const sb = sandbox({ snapshot: { generatedAt: staleIso(), items: { "o/r#7": item("Sonnet", "Ready") } } });
  const r = sb.run(dispatch("Do o/r#7 now.", "haiku"));
  assert.equal(r.deny, false);
  assert.match(r.ctx, /model not checked: no day snapshot from today \(run propagate day open\)/);
  assert.equal(sb.writes().length, 0);
});

test("a missing snapshot is allowed with 'not checked' and 0 writes", () => {
  const sb = sandbox();
  const r = sb.run(dispatch("Do o/r#7 now."));
  assert.equal(r.deny, false);
  assert.match(r.ctx, /model not checked: no day snapshot from today/);
  assert.equal(sb.writes().length, 0);
});

test("an unreadable snapshot is allowed with 'not checked'", () => {
  const sb = sandbox({ snapshot: "{not json" });
  const r = sb.run(dispatch("Do o/r#7 now."));
  assert.equal(r.deny, false);
  assert.match(r.ctx, /model not checked/);
  assert.equal(sb.writes().length, 0);
});

test("a ref that is not in the snapshot is allowed, named, and not written", () => {
  const sb = sandbox({ snapshot: SNAP() });
  const r = sb.run(dispatch("Do o/r#99 now.", "haiku"));
  assert.equal(r.deny, false);
  assert.match(r.ctx, /not checked: o\/r#99 is not on a board/);
  assert.equal(sb.writes().length, 0);
});

test("In progress, In review and Done items are allowed and never written", () => {
  for (const status of ["In progress", "In review", "Done"]) {
    const sb = sandbox({ snapshot: SNAP(status, "Sonnet") });
    const r = sb.run(dispatch("Do o/r#7 now.", "sonnet"));
    assert.equal(r.deny, false, status);
    assert.equal(sb.writes().length, 0, `${status}: no write`);
  }
});

test("gh exiting 1 still allows the dispatch and reports the failure", () => {
  const sb = sandbox({ snapshot: SNAP("Ready", "Sonnet"), ghFails: true });
  const r = sb.run(dispatch("Do o/r#7 now.", "sonnet"));
  assert.equal(r.status, 0);
  assert.equal(r.deny, false);
  assert.match(r.ctx, /could not move o\/r#7 to In progress/);
  assert.match(r.ctx, /502/);
  assert.equal(sb.writes().length, 1, "it tried once");
  assert.equal(sb.snapshot().items["o/r#7"].status, "Ready", "a failed write leaves the snapshot status alone");
});

test("a missing gh binary still allows the dispatch and reports it", () => {
  const sb = sandbox({ snapshot: SNAP("Ready", "Sonnet") });
  const r = sb.run(dispatch("Do o/r#7", "sonnet"), { PROPAGATE_GH_BIN: "/nonexistent/gh" });
  assert.equal(r.status, 0);
  assert.equal(r.deny, false);
  assert.match(r.ctx, /could not move/);
});

test("a second dispatch after a successful write makes 0 writes", () => {
  const sb = sandbox({ snapshot: SNAP("Ready", "Sonnet") });
  sb.run(dispatch("Do o/r#7 now.", "sonnet"));
  assert.equal(sb.writes().length, 1);
  assert.equal(sb.snapshot().items["o/r#7"].status, "In progress");
  const r = sb.run(dispatch("Again o/r#7.", "sonnet"));
  assert.equal(r.deny, false);
  assert.equal(sb.writes().length, 1, "still one");
});

test("no ref in the prompt: exit 0 with empty output, no write", () => {
  const sb = sandbox({ snapshot: SNAP() });
  const r = sb.run(dispatch("Review the diff and report.", "haiku"));
  assert.equal(r.status, 0);
  assert.equal(r.raw, "");
  assert.equal(sb.writes().length, 0);
});

test("a bare #n with two repos named matches no ref: exit 0, empty output", () => {
  const sb = sandbox({ snapshot: { generatedAt: todayIso(), items: { "a/b#5": item("Sonnet", "Ready") } } });
  const r = sb.run(dispatch("See github.com/a/b and github.com/c/d, fix #5.", "haiku"));
  assert.equal(r.status, 0);
  assert.equal(r.raw, "");
  assert.equal(sb.writes().length, 0);
});

test("a tool other than Agent or Task is ignored", () => {
  const sb = sandbox({ snapshot: SNAP() });
  const r = sb.run({ tool_name: "ExitPlanMode", tool_input: { plan: "o/r#7" } });
  assert.equal(r.status, 0);
  assert.equal(r.raw, "");
  assert.equal(sb.writes().length, 0);
});

test("Task is checked like Agent", () => {
  const sb = sandbox({ snapshot: SNAP("Ready", "Sonnet") });
  const r = sb.run({ tool_name: "Task", tool_input: { prompt: "o/r#7", model: "haiku" } });
  assert.equal(r.deny, true);
});

// ── ref extraction ──────────────────────────────────────────────────────────

test("extractRefs: owner/repo#n and issue URLs", () => {
  assert.deepEqual(extractRefs("see a/b#3 and https://github.com/c/d/issues/4"), ["a/b#3", "c/d#4"]);
});

test("extractRefs: a bare #n counts only when exactly one repo is named", () => {
  assert.deepEqual(extractRefs("fix a/b#3, then #5"), ["a/b#3", "a/b#5"]);
  assert.deepEqual(extractRefs("see github.com/a/b, fix #5"), ["a/b#5"]);
});

test("extractRefs: a bare #n with two repos named matches no ref", () => {
  assert.deepEqual(extractRefs("see github.com/a/b and github.com/c/d, fix #5"), []);
  assert.deepEqual(extractRefs("fix #5"), []);
});

test("extractRefs: a file path is not a ref, and duplicates collapse", () => {
  assert.deepEqual(extractRefs("edit hooks/rule-guard.mjs"), []);
  assert.deepEqual(extractRefs("a/b#3 a/b#3 https://github.com/a/b/issues/3"), ["a/b#3"]);
});

test("decide (pure): an absent model against a Model is a mismatch", () => {
  const d = decide(dispatch("o/r#7"), SNAP("Ready", "Haiku"), new Date());
  assert.match(d.deny, /haiku/);
  assert.deepEqual(d.moves, []);
});
