// agent-nudge (propagate#251): the main session is told to dispatch edge-settler exactly when a settle worklist is
// big enough, and never otherwise (never inside a subagent, never for a small or all-NEVER_VERIFIED worklist).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
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
