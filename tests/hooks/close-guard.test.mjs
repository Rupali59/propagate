// close-guard (propagate#280): rule:record-completion-cost as a PreToolUse check on the close path.
// Payloads are literal; the board read is injected (decide) or a stub binary behind PROPAGATE_GH_BIN (the spawn tests).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { decide, REQUIRED } from "../../hooks/close-guard.mjs";

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "hooks", "close-guard.mjs");
const bash = (command) => ({ tool_name: "Bash", tool_input: { command } });

// A board item as the GraphQL read returns it. `drop` names the fields to leave unset.
const node = (drop = []) => {
  const all = {
    Size: { name: "M", field: { name: "Size" } },
    Finished: { date: "2026-11-26", field: { name: "Finished" } },
    Minutes: { number: 42, field: { name: "Minutes" } },
    Tokens: { number: 90000, field: { name: "Tokens" } },
  };
  return {
    id: "PVTI_item1",
    project: { number: 7, title: "propagate", fields: { nodes: [{ name: "Status", options: [{ id: "opt_todo", name: "Todo" }, { id: "opt_done", name: "Done" }] }] } },
    fieldValues: { nodes: [{ name: "Done", field: { name: "Status" } }, ...REQUIRED.filter((f) => !drop.includes(f)).map((f) => all[f])] },
  };
};
const issueAnswer = (...nodes) => ({ data: { repository: { issue: { projectItems: { nodes } } } } });
const nodeAnswer = (n) => ({ data: { node: n } });
const reader = (answer) => { const calls = []; const fn = (args) => { calls.push(args); if (answer instanceof Error) throw answer; return answer; }; fn.calls = calls; return fn; };

const CLOSE = "gh issue close 123 -R o/r";
const EDIT = "gh project item-edit --project-id P --id PVTI_item1 --field-id F --single-select-option-id opt_done";
const GQL = `gh api graphql -f query='mutation{updateProjectV2ItemFieldValue(input:{projectId:"P",itemId:"PVTI_item1",fieldId:"F",value:{singleSelectOptionId:"opt_done"}}){projectV2Item{id}}}'`;

test("the required-field list has a floor (a blind list denies nothing)", () => {
  assert.deepEqual([...REQUIRED], ["Size", "Finished", "Minutes", "Tokens"]);
});

for (const [form, command, ans] of [["gh issue close", CLOSE, issueAnswer], ["gh project item-edit to Done", EDIT, nodeAnswer], ["GraphQL Done write", GQL, nodeAnswer]]) {
  for (const missing of REQUIRED) {
    test(`${form}: missing ${missing} is denied, naming ${missing} and the command that fills it`, () => {
      const d = decide(bash(command), { read: reader(ans(node([missing]))) });
      assert.equal(d.deny, true, `${form} with ${missing} unset must be denied`);
      assert.match(d.reason, new RegExp(`missing ${missing}\\b`));
      assert.match(d.reason, missing === "Minutes" || missing === "Tokens" ? /propagate costs window.*propagate costs lanes/ : /board/);
      for (const other of REQUIRED.filter((f) => f !== missing)) assert.doesNotMatch(d.reason, new RegExp(`missing[^:]*\\b${other}\\b`));
    });
  }
  test(`${form}: all four fields set is allowed, with no warning`, () => {
    const d = decide(bash(command), { read: reader(ans(node())) });
    assert.deepEqual(d, { deny: false });
  });
}

test("item-edit to a status that is not Done is allowed without judging fields", () => {
  const todo = EDIT.replace("opt_done", "opt_todo");
  assert.deepEqual(decide(bash(todo), { read: reader(nodeAnswer(node(["Size", "Tokens"]))) }), { deny: false });
});

test("unrelated gh and non-gh commands are allowed and never read the board", () => {
  const read = reader(issueAnswer(node(["Size"])));
  for (const c of ["gh issue view 1", "gh issue list -R o/r", "gh pr close 5", "npm test", "git commit -m 'run gh issue close 9 later'", "echo gh issue close 9"]) {
    assert.deepEqual(decide(bash(c), { read }), { deny: false }, c);
  }
  assert.equal(read.calls.length, 0, "no board read for an unrelated command");
});

test("a heredoc body that mentions the close forms does not trigger", () => {
  const c = "git commit -F - <<'EOF'\nuse gh issue close 5 -R o/r after the record\nEOF";
  assert.deepEqual(decide(bash(c), { read: reader(issueAnswer(node(["Size"]))) }), { deny: false });
});

test("an issue on two boards is denied when either board item is incomplete", () => {
  const d = decide(bash(CLOSE), { read: reader(issueAnswer(node(), node(["Minutes"]))) });
  assert.equal(d.deny, true);
  assert.match(d.reason, /missing Minutes/);
});

test("the escape comment is honoured, and an empty reason is not", () => {
  const read = reader(issueAnswer(node(["Size"])));
  assert.deepEqual(decide(bash(`${CLOSE} # close-ok: duplicate of 99, no work done`), { read }), { deny: false });
  assert.equal(read.calls.length, 0);
  assert.equal(decide(bash(`${CLOSE} # close-ok:`), { read }).deny, true);
});

// a failed read: allow, and say so
for (const [why, answer, re] of [
  ["offline", new Error("error connecting to api.github.com"), /board read failed \(error connecting to api\.github\.com\)/],
  ["issue on no board", issueAnswer(), /is on no board/],
  ["an answer of the wrong shape", { data: { oops: 1 } }, /not found in the answer/],
  ["a GraphQL error", { errors: [{ message: "Could not resolve to an Issue" }] }, /Could not resolve to an Issue/],
]) {
  test(`board read fails (${why}): allowed with a warning naming the failure`, () => {
    const d = decide(bash(CLOSE), { read: reader(answer) });
    assert.equal(d.deny, false);
    assert.match(d.warn, re);
    assert.match(d.warn, /NOT checked/);
  });
}

// the real entry point, with a stub gh behind PROPAGATE_GH_BIN
const dir = mkdtempSync(path.join(tmpdir(), "close-guard-"));
const stub = (name, body) => { const p = path.join(dir, name); writeFileSync(p, `#!/usr/bin/env node\n${body}\n`); chmodSync(p, 0o755); return p; };
let n = 0;
const answering = (answer) => stub(`gh-${n++}`, `process.stdout.write(${JSON.stringify(JSON.stringify(answer))});`);
const failing = stub("gh-fail", `process.stderr.write("could not resolve host: api.github.com\\n"); process.exit(1);`);
const run = (command, bin) => {
  const r = spawnSync("node", [HOOK], { input: JSON.stringify(bash(command)), encoding: "utf8", env: { ...process.env, PROPAGATE_GH_BIN: bin } });
  return { status: r.status, out: r.stdout.trim() ? JSON.parse(r.stdout)?.hookSpecificOutput : null };
};

test("entry point: close with a missing field is denied; complete is allowed; item-edit is judged; unrelated is silent", () => {
  const d = run(CLOSE, answering(issueAnswer(node(["Minutes"]))));
  assert.equal(d.status, 0);
  assert.equal(d.out.permissionDecision, "deny");
  assert.match(d.out.permissionDecisionReason, /missing Minutes/);
  assert.equal(run(CLOSE, answering(issueAnswer(node()))).out, null);
  const e = run(EDIT, answering(nodeAnswer(node(["Tokens"]))));
  assert.equal(e.out.permissionDecision, "deny");
  assert.match(e.out.permissionDecisionReason, /missing Tokens/);
  assert.equal(run("gh issue view 1", answering(issueAnswer(node(["Size"])))).out, null);
});

test("entry point: a gh that fails gives allow plus a warning, never a silent pass or a deny", () => {
  const r = run(CLOSE, failing);
  assert.equal(r.status, 0);
  assert.equal(r.out.permissionDecision, undefined);
  assert.match(r.out.additionalContext, /WARNING.*could not resolve host/);
  const missing = run(CLOSE, path.join(dir, "no-such-gh"));
  assert.match(missing.out.additionalContext, /WARNING.*not installed/);
});

test("entry point: garbage on stdin exits 0 silently", () => {
  const r = spawnSync("node", [HOOK], { input: "not json", encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});
