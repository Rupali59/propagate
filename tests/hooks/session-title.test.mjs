// session-title (propagate#442): the UserPromptSubmit hook that prefixes the session title with the board item the
// session works on. Tested through the real hook process with a temp state dir (GOTCHAS G56).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "hooks", "session-title.mjs");

function sandbox(assoc) {
  const state = mkdtempSync(path.join(tmpdir(), "title-state-"));
  if (assoc) {
    mkdirSync(path.join(state, "sessions"), { recursive: true });
    const ev = { ts: "2026-11-28T10:00:00.000Z", event: "associate", rowKey: "session:sess-1", goal: null, item: assoc, source: "derived", row: { sessionId: "sess-1" } };
    writeFileSync(path.join(state, "sessions", "assoc.jsonl"), JSON.stringify(ev) + "\n");
  }
  return (payload) => spawnSync(process.execPath, [HOOK], { input: typeof payload === "string" ? payload : JSON.stringify(payload), encoding: "utf8", env: { ...process.env, PROPAGATE_STATE_DIR: state } });
}
const prompt = (title, extra = {}) => ({ session_id: "sess-1", hook_event_name: "UserPromptSubmit", session_title: title, prompt: "hi", ...extra });
const titleOf = (r) => JSON.parse(r.stdout).hookSpecificOutput;

test("with an association and the title `fix login`, it sets `o/r#5 · fix login`", () => {
  const r = sandbox("o/r#5")(prompt("fix login"));
  assert.equal(r.status, 0);
  const out = titleOf(r);
  assert.equal(out.hookEventName, "UserPromptSubmit");
  assert.equal(out.sessionTitle, "o/r#5 · fix login");
});

test("a title that already carries the item gives no output", () => {
  const r = sandbox("o/r#5")(prompt("o/r#5 · fix login"));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});

test("an older prefix is replaced, and the user's own name is kept", () => {
  const r = sandbox("o/r#9")(prompt("o/r#5 · fix login"));
  assert.equal(titleOf(r).sessionTitle, "o/r#9 · fix login");
});

test("an empty title gets the item alone", () => {
  assert.equal(titleOf(sandbox("o/r#5")(prompt(""))).sessionTitle, "o/r#5");
});

test("no association, a subagent payload, another session and junk give no output and exit 0", () => {
  for (const r of [
    sandbox(null)(prompt("fix login")),
    sandbox("o/r#5")(prompt("fix login", { agent_type: "general-purpose" })),
    sandbox("o/r#5")(prompt("fix login", { session_id: "other" })),
    sandbox("o/r#5")(prompt("fix login", { session_id: undefined })),
    sandbox("o/r#5")("junk"),
  ]) {
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
  }
});
