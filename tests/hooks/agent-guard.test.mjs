// agent-guard (propagate#251): the write path is UNREACHABLE for a read-only propagate agent
// (rule:safety-flag-needs-a-test), and nothing changes for the main session or any other agent.
// Inputs are literal payloads, never built through a helper that could only express valid ones.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { decide, READ_ONLY } from "../../hooks/agent-guard.mjs";

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "hooks", "agent-guard.mjs");
// Explicit arity: a default parameter would turn bash(cmd, undefined) back into the read-only agent.
const bash = (...a) => ({ agent_type: a.length > 1 ? a[1] : "propagate:edge-settler", tool_name: "Bash", tool_input: { command: a[0] } });

const WRITES = [
  "node cli.mjs verify --edge e1 --disposition propagated --reason x --apply",
  "propagate verify --edge e1 --disposition deferred --reason x --apply",
  "propagate declare src.md down.md",
  "propagate bootstrap --baseline-from-git --apply",
  "git commit -m x",
  "git -C /w/repo push origin main",
  "git add .",
  "git checkout -- file",
  "git reset --hard",
  "git stash",
  "git branch -D old",
  "git branch new-branch",
  "git remote add x y",
  "gh issue comment 1 --body x",
  "gh issue close 1",
  "gh pr merge 1",
  "gh project item-edit --id x",
  "gh api -X PATCH repos/o/r/issues/1 -f state=closed",
  "gh api repos/o/r/issues -f title=x",
  "gh api graphql -f query='mutation{addComment(input:{}){clientMutationId}}'",
  "echo x > notes.md",
  "cat a >> b",
  "ls | tee out.txt",
  "sed -i '' s/a/b/ f",
  "find . -name x -delete",
  "rm -f x",
  "mv a b",
  "npm install",
  "curl -X POST https://example.com",
  "git log && git commit -m sneaky",
  "git log; rm -rf /",
  "cat $(touch x)",
];

test("every write command is denied for each read-only agent, in both name forms", () => {
  assert.ok(READ_ONLY.length >= 3, `only ${READ_ONLY.length} read-only agents: the population has shrunk`);
  for (const name of READ_ONLY) {
    for (const t of [name, `propagate:${name}`]) {
      for (const cmd of WRITES) assert.equal(decide(bash(cmd, t)).deny, true, `${t}: must deny ${cmd}`);
      for (const tool of ["Write", "Edit", "NotebookEdit"]) {
        assert.equal(decide({ agent_type: t, tool_name: tool, tool_input: { file_path: "/x" } }).deny, true, `${t}: must deny ${tool}`);
      }
    }
  }
});

const READS = [
  "propagate settle docs/X.md --json",
  "node cli.mjs status",
  "node /abs/propagate/cli.mjs settle cli/settle.mjs --json",
  "propagate verify --edge e1 --disposition no-change-needed --reason 'down.md:3'",
  "git -C /w/repo log --format='%H %s' abc..HEAD -- src.md",
  "git show abc1234 -- src.md",
  "git diff abc..HEAD",
  "git branch --show-current",
  "git cat-file -e abc1234^{commit}",
  "gh issue view 12 --json body",
  "gh api graphql -f query='query{viewer{login}}'",
  "gh api repos/o/r/issues/1",
  "grep -n x file 2>&1 | head -5",
  "cat f >/dev/null",
  "rg --no-ignore -n pattern src </dev/null",
  "sed -n 1,20p file",
  "find . -name '*.md'",
];

test("read commands are allowed for a read-only agent (the guard does not block the agent's job)", () => {
  for (const cmd of READS) {
    const d = decide(bash(cmd));
    assert.equal(d.deny, false, `must allow ${cmd} (denied: ${d.reason})`);
  }
});

test("the main session and other agents are never touched, even for writes", () => {
  for (const agent_type of [undefined, null, "", "Explore", "general-purpose", "propagate:some-writer"]) {
    for (const cmd of ["git commit -m x", "rm -rf x", "propagate verify --edge e --disposition d --apply"]) {
      assert.equal(decide(bash(cmd, agent_type)).deny, false, `${agent_type}: must not deny ${cmd}`);
    }
    assert.equal(decide({ agent_type, tool_name: "Write", tool_input: {} }).deny, false);
  }
});

test("the real hook process: deny JSON for a read-only agent, silent exit 0 otherwise", () => {
  const run = (payload) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify(payload), encoding: "utf8" });
  const denied = run(bash("git push"));
  assert.equal(denied.status, 0);
  const out = JSON.parse(denied.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /git push/);

  for (const p of [bash("git log"), bash("git push", undefined)]) {
    const r = run(p);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "", `no output expected for ${JSON.stringify(p)}`);
  }
  const junk = spawnSync(process.execPath, [HOOK], { input: "not json", encoding: "utf8" });
  assert.equal(junk.status, 0);
  assert.equal(junk.stdout, "");
});
