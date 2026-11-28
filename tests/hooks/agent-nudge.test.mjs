// agent-nudge (propagate#251): the main session is told to dispatch edge-settler exactly when a settle worklist is
// big enough, and never otherwise (never inside a subagent, never for a small or all-NEVER_VERIFIED worklist).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { nudge, NUDGE_AT } from "../../hooks/agent-nudge.mjs";

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "hooks", "agent-nudge.mjs");
const worklist = (n, extra = {}) => JSON.stringify({ file: "/w/r/a.md", fileShort: "a.md", items: Array.from({ length: n }, (_, i) => ({ edge_id: `e${i}` })), ...extra });
const payload = (stdout, extra = {}) => ({ tool_name: "Bash", tool_input: { command: "node cli.mjs settle a.md --json" }, tool_response: { stdout }, ...extra });

test(`${NUDGE_AT}+ edges in the main session: the nudge names the agent and the --check gate`, () => {
  const line = nudge(payload(worklist(NUDGE_AT)));
  assert.match(line, /propagate:edge-settler/);
  assert.match(line, /settle '\/w\/r\/a\.md' --check/);
});

test("no nudge: fewer edges, all NEVER_VERIFIED, inside a subagent, a --check run, non-JSON, another command", () => {
  assert.equal(nudge(payload(worklist(NUDGE_AT - 1))), null);
  assert.equal(nudge(payload(worklist(5, { allNeverVerified: true }))), null);
  assert.equal(nudge(payload(worklist(5), { agent_type: "propagate:edge-settler" })), null);
  assert.equal(nudge({ ...payload(worklist(5)), tool_input: { command: "node cli.mjs settle a.md --check p.json --json" } }), null);
  assert.equal(nudge(payload("settle: could not derive")), null);
  assert.equal(nudge({ ...payload(worklist(5)), tool_input: { command: "git log --json" } }), null);
});

test("the real hook process: JSON additionalContext when it nudges, silent exit 0 otherwise", () => {
  const run = (p) => spawnSync(process.execPath, [HOOK], { input: typeof p === "string" ? p : JSON.stringify(p), encoding: "utf8" });
  const yes = run(payload(worklist(4)));
  assert.equal(yes.status, 0);
  assert.equal(JSON.parse(yes.stdout).hookSpecificOutput.hookEventName, "PostToolUse");
  for (const p of [payload(worklist(1)), "junk"]) {
    const r = run(p);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
  }
});

test("a large output: truncated stdout plus persistedOutputPath is read from the file (the first live run)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "nudge-"));
  const full = worklist(10);
  const file = path.join(dir, "out.txt");
  writeFileSync(file, full);
  const truncated = full.slice(0, Math.floor(full.length / 2)); // what Claude Code puts in stdout
  const p = payload(truncated);
  assert.equal(nudge(p), null, "truncated JSON alone cannot parse");
  p.tool_response = { stdout: truncated, persistedOutputPath: file, persistedOutputSize: full.length };
  assert.match(nudge(p), /10 edges to settle/);
  p.tool_response.persistedOutputPath = path.join(dir, "gone.txt");
  assert.equal(nudge(p), null, "an unreadable persisted file falls back to stdout, which stays silent");
});

// ── the second job: derive the session's board item (propagate#442) ──────────
// Tested by EFFECT: the lines the real hook process appended to a temp state dir's assoc.jsonl (GOTCHAS G56).
const withState = () => {
  const state = mkdtempSync(path.join(tmpdir(), "nudge-state-"));
  const log = path.join(state, "sessions", "assoc.jsonl");
  const run = (p) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify(p), encoding: "utf8", env: { ...process.env, PROPAGATE_STATE_DIR: state } });
  const lines = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { run, lines };
};
const bash = (command, extra = {}) => ({ session_id: "sess-1", tool_name: "Bash", tool_input: { command }, tool_response: { stdout: "ok" }, cwd: tmpdir(), ...extra });

test("a gh issue close payload appends one derived association", () => {
  const s = withState();
  const r = s.run(bash("gh issue close 5 -R o/r"));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "", "the derive is silent");
  const l = s.lines();
  assert.equal(l.length, 1);
  assert.equal(l[0].event, "associate");
  assert.equal(l[0].rowKey, "session:sess-1");
  assert.equal(l[0].item, "o/r#5");
  assert.equal(l[0].source, "derived");
  assert.equal(l[0].signal, "gh issue close");
  assert.equal(l[0].goal, null);
  assert.equal(l[0].goal_source, "not in today's snapshot");
});

test("the same item again appends nothing; a different item appends a second line", () => {
  const s = withState();
  s.run(bash("gh issue comment 5 -R o/r --body x"));
  s.run(bash("gh issue close 5 -R o/r"));
  assert.equal(s.lines().length, 1);
  s.run(bash("gh issue comment 9 -R o/r --body x"));
  assert.deepEqual(s.lines().map((e) => e.item), ["o/r#5", "o/r#9"]);
});

test("reads, a subagent payload and a payload with no session id append nothing", () => {
  const s = withState();
  s.run(bash("gh issue view 5 -R o/r"));
  s.run(bash("gh issue list -R o/r"));
  s.run(bash("gh issue close 5 -R o/r", { agent_type: "general-purpose" }));
  s.run(bash("gh issue close 5 -R o/r", { session_id: undefined }));
  assert.deepEqual(s.lines(), []);
});

test("a derive that fails stays silent and exits 0", () => {
  const s = withState();
  const r = s.run({ session_id: "x", tool_name: "Bash", tool_input: { command: 7 }, tool_response: 3, cwd: null });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});
