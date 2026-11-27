// agent-guard, literature-researcher policy (propagate#327): Read is confined to the saved-source store, every other
// tool is denied, and nothing changes for the main session or any other agent. Paths are literal, built in a temp
// state dir; the escape cases are the point (rule:safety-flag-needs-a-test): each constructs the path that would
// leave the store and asserts it is denied.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { decide, RESEARCH_READ_ONLY, READ_ONLY } from "../../hooks/agent-guard.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
let tmp;
let store;
let body;
let hubFile;
const prevState = process.env.PROPAGATE_STATE_DIR;

before(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "agent-guard-research-"));
  process.env.PROPAGATE_STATE_DIR = path.join(tmp, "state");
  store = path.join(tmp, "state", "kb", "fetched");
  mkdirSync(store, { recursive: true });
  body = path.join(store, "a".repeat(64));
  writeFileSync(body, "saved source text");
  hubFile = path.join(tmp, "hub-secret.md");
  writeFileSync(hubFile, "hub text");
  mkdirSync(path.join(tmp, "state", "kb", "fetched-evil"));
  writeFileSync(path.join(tmp, "state", "kb", "fetched-evil", "x"), "sibling");
  symlinkSync(hubFile, path.join(store, "link-out"));
  symlinkSync(path.join(tmp, "state", "kb", "fetched-evil"), path.join(store, "dir-link-out"));
});
after(() => {
  if (prevState === undefined) delete process.env.PROPAGATE_STATE_DIR;
  else process.env.PROPAGATE_STATE_DIR = prevState;
  rmSync(tmp, { recursive: true, force: true });
});

// Explicit arity: a default parameter would turn read(p, undefined) back into the researcher.
const read = (...a) => ({ agent_type: a.length > 1 ? a[1] : "literature-researcher", tool_name: "Read", tool_input: { file_path: a[0] } });

test("RESEARCH_READ_ONLY names the researcher and the rater (#412), and is not the READ_ONLY list", () => {
  assert.deepEqual([...RESEARCH_READ_ONLY], ["literature-researcher", "literature-rater"]);
  assert.ok(!READ_ONLY.includes("literature-researcher"), "the researcher has its own policy, not the Bash allowlist");
  assert.ok(!READ_ONLY.includes("literature-rater"), "the rater has its own policy, not the Bash allowlist");
});

for (const t of ["literature-researcher", "propagate:literature-researcher", "literature-rater", "propagate:literature-rater"]) {
  test(`${t}: Read of a saved source is allowed`, () => {
    assert.equal(decide(read(body, t)).deny, false);
  });

  test(`${t}: every Read that leaves the store is denied`, () => {
    const cases = {
      "a hub file": hubFile,
      "../ traversal": `${store}/../../../hub-secret.md`,
      "traversal to a dotfile": `${store}/../../../../.ssh/id_rsa`,
      "a symlink inside the store pointing at a file outside": path.join(store, "link-out"),
      "a symlink inside the store pointing at a sibling directory": path.join(store, "dir-link-out", "x"),
      "the store as a prefix of a sibling (fetched-evil)": path.join(tmp, "state", "kb", "fetched-evil", "x"),
      "a missing path in the store": path.join(store, "b".repeat(64)),
      "the store directory itself": store,
      "a relative path": "kb/fetched/" + "a".repeat(64),
      "an empty path": "",
    };
    for (const [why, p] of Object.entries(cases)) {
      const d = decide(read(p, t));
      assert.equal(d.deny, true, `${t}: must deny ${why} (${p})`);
    }
    assert.match(decide(read(path.join(store, "b".repeat(64)), t)).reason, /not a saved source/);
  });

  test(`${t}: a Read with no file_path is denied`, () => {
    assert.equal(decide({ agent_type: t, tool_name: "Read", tool_input: {} }).deny, true);
    assert.equal(decide({ agent_type: t, tool_name: "Read" }).deny, true);
  });

  test(`${t}: every other tool is denied`, () => {
    const others = [
      { tool_name: "WebFetch", tool_input: { url: "https://example.com", prompt: "x" } },
      { tool_name: "WebSearch", tool_input: { query: "x" } },
      { tool_name: "Bash", tool_input: { command: `cat ${body}` } },
      { tool_name: "Grep", tool_input: { pattern: "x", path: store } },
      { tool_name: "Glob", tool_input: { pattern: "*" } },
      { tool_name: "Write", tool_input: { file_path: path.join(tmp, "x"), content: "x" } },
      { tool_name: "Edit", tool_input: { file_path: body } },
      { tool_name: "NotebookEdit", tool_input: {} },
    ];
    for (const o of others) {
      const d = decide({ agent_type: t, ...o });
      assert.equal(d.deny, true, `${t}: must deny ${o.tool_name}`);
      assert.match(d.reason, new RegExp(`literature-researcher may only Read saved sources; ${o.tool_name} is not allowed`));
    }
  });
}

test("guard scope: the main session and other agents are untouched, Read of a hub file included", () => {
  for (const agent_type of [undefined, null, "", "Explore", "general-purpose", "propagate:some-writer"]) {
    assert.equal(decide(read(hubFile, agent_type)).deny, false, `${agent_type}: Read of a hub file must stay allowed`);
    assert.equal(decide({ agent_type, tool_name: "WebFetch", tool_input: {} }).deny, false);
    assert.equal(decide({ agent_type, tool_name: "Grep", tool_input: {} }).deny, false);
  }
  for (const agent_type of READ_ONLY) {
    for (const t of [agent_type, `propagate:${agent_type}`]) {
      assert.equal(decide(read(hubFile, t)).deny, false, `${t}: the old policy never covered Read`);
      assert.equal(decide({ agent_type: t, tool_name: "Bash", tool_input: { command: "git log" } }).deny, false);
      assert.equal(decide({ agent_type: t, tool_name: "Bash", tool_input: { command: "git push" } }).deny, true);
    }
  }
});

test("hooks.json: the agent-guard matcher covers Read and WebFetch (a matcher narrower than the policy never fires)", () => {
  const cfg = JSON.parse(readFileSync(path.join(ROOT, "hooks", "hooks.json"), "utf8"));
  const group = cfg.hooks.PreToolUse.find((g) => g.hooks.some((h) => /agent-guard\.mjs/.test(h.command)));
  assert.ok(group, "no PreToolUse group registers agent-guard.mjs");
  const tools = group.matcher.split("|");
  for (const t of ["Read", "Grep", "Glob", "WebFetch", "WebSearch", "Bash", "Write", "Edit", "NotebookEdit"]) {
    assert.ok(tools.includes(t), `agent-guard matcher lacks ${t}: ${group.matcher}`);
  }
});
