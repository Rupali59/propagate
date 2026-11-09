/**
 * costs-window.test.mjs — `summarizeWindow`, `readCosts({lanesOnly})` and `costs window` (propagate#233).
 *
 * FIXTURES ARE LITERAL JSONL STRINGS, written out by hand and never produced by a builder: a builder
 * shares its assumptions with the code under test (here: "one line per message"), and the whole point
 * of trap 2 is that Claude Code writes ONE LINE PER CONTENT BLOCK under a shared message.id.
 *
 * Run with PROPAGATE_STATE_DIR set (G56): node --test tests/unit/costs-window.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { summarizeWindow, readCosts } from "../../lib/core/costs.mjs";
import { costsCmd } from "../../cli/costs.mjs";

const dir = mkdtempSync(path.join(os.tmpdir(), "costs-window-"));
function write(name, lines) {
  const p = path.join(dir, name);
  writeFileSync(p, lines.join("\n") + "\n");
  return p;
}

// m1 is ONE API call split over THREE lines (text, tool_use, tool_use carrying START-ANCHOR); each line
// repeats the same usage. m2 is one line. m3 carries END-ANCHOR. Totals per message:
//   m1 in 1 out 10 cc 100 cr 1000 = 1111;  m2 2/20/200/2000 = 2222;  m3 3/30/300/3000 = 3333.
const M1_A = '{"type":"assistant","timestamp":"2026-11-09T10:00:00.000Z","message":{"id":"m1","model":"claude-x","content":[{"type":"text","text":"working"}],"usage":{"input_tokens":1,"output_tokens":10,"cache_creation_input_tokens":100,"cache_read_input_tokens":1000}}}';
const M1_B = '{"type":"assistant","timestamp":"2026-11-09T10:00:01.000Z","message":{"id":"m1","model":"claude-x","content":[{"type":"tool_use","name":"Bash","input":{"command":"ls"}}],"usage":{"input_tokens":1,"output_tokens":10,"cache_creation_input_tokens":100,"cache_read_input_tokens":1000}}}';
const M1_C = '{"type":"assistant","timestamp":"2026-11-09T10:00:02.000Z","message":{"id":"m1","model":"claude-x","content":[{"type":"tool_use","name":"Bash","input":{"command":"echo START-ANCHOR"}}],"usage":{"input_tokens":1,"output_tokens":10,"cache_creation_input_tokens":100,"cache_read_input_tokens":1000}}}';
const M2 = '{"type":"assistant","timestamp":"2026-11-09T10:05:00.000Z","message":{"id":"m2","model":"claude-x","content":[{"type":"text","text":"middle"}],"usage":{"input_tokens":2,"output_tokens":20,"cache_creation_input_tokens":200,"cache_read_input_tokens":2000}}}';
const M3 = '{"type":"assistant","timestamp":"2026-11-09T10:10:00.000Z","message":{"id":"m3","model":"claude-x","content":[{"type":"tool_use","name":"Bash","input":{"command":"echo END-ANCHOR"}}],"usage":{"input_tokens":3,"output_tokens":30,"cache_creation_input_tokens":300,"cache_read_input_tokens":3000}}}';
// m5 is this command quoting both anchors, as it would sit in the transcript that is being costed.
const M5_SELF = '{"type":"assistant","timestamp":"2026-11-09T11:00:00.000Z","message":{"id":"m5","model":"claude-x","content":[{"type":"tool_use","name":"Bash","input":{"command":"propagate costs window --from anchor:START-ANCHOR --to anchor:END-ANCHOR"}}],"usage":{"input_tokens":5,"output_tokens":50,"cache_creation_input_tokens":500,"cache_read_input_tokens":5000}}}';

const BASE = [M1_A, M1_B, M1_C, M2, M3];
const WHOLE = 1111 + 2222 + 3333;

test("one message split across 3 lines counts once, and the anchor in its 3rd block is found", () => {
  const r = summarizeWindow(write("split.jsonl", BASE), { from: "anchor:START-ANCHOR", to: "anchor:END-ANCHOR" });
  assert.equal(r.error, undefined);
  assert.equal(r.api_calls, 3);
  assert.equal(r.total, WHOLE);
  assert.deepEqual(r.usage, { input: 6, output: 60, cache_create: 600, cache_read: 6000 });
  // The anchor matched m1, whose earliest line is 10:00:00 (not the 3rd block's 10:00:02).
  assert.equal(r.from_ts, "2026-11-09T10:00:00.000Z");
  assert.equal(r.minutes, 10);
  // An ISO window opening before the first line sees all three lines of m1; a per-line sum would triple it.
  const iso = summarizeWindow(write("split-iso.jsonl", BASE), { from: "2026-11-09T09:00:00Z", to: "2026-11-09T11:00:00Z" });
  assert.equal(iso.total, WHOLE);
  assert.match(r.from_anchor, /START-ANCHOR|working/);
});

test("two overlapping windows both include the shared messages, and the output says upper bound", async () => {
  const p = write("overlap.jsonl", BASE);
  const a = summarizeWindow(p, { from: "anchor:START-ANCHOR", to: "2026-11-09T10:05:00Z" });
  const b = summarizeWindow(p, { from: "2026-11-09T10:05:00Z", to: "anchor:END-ANCHOR" });
  assert.equal(a.total, 1111 + 2222);
  assert.equal(b.total, 2222 + 3333);
  assert.ok(a.total + b.total > WHOLE, "m2 is counted in both windows");
  const lines = [];
  const code = await costsCmd(["window", "--transcript", p, "--from", "anchor:START-ANCHOR", "--to", "anchor:END-ANCHOR"], {
    out: (s) => lines.push(s),
    err: () => {},
  });
  assert.equal(code, 0);
  assert.ok(lines.some((l) => l.includes("anything concurrent in it is counted, so this is an upper bound")));
});

test("a trailing `costs window` invocation quoting both anchors is excluded from the default window", () => {
  const p = write("self.jsonl", [...BASE, M5_SELF]);
  const r = summarizeWindow(p, { from: "anchor:START-ANCHOR", to: "anchor:END-ANCHOR" });
  assert.equal(r.error, undefined);
  assert.equal(r.total, WHOLE);
  assert.equal(r.to_ts, "2026-11-09T10:10:00.000Z");
  // An ISO `to` past the invocation: the default cutoff still keeps the invocation's own spend out.
  assert.equal(summarizeWindow(p, { from: "anchor:START-ANCHOR", to: "2026-11-09T12:00:00Z" }).total, WHOLE);
  assert.equal(r.until, "2026-11-09T11:00:00.000Z");
  // An explicit --until overrides the cutoff.
  const wide = summarizeWindow(p, { from: "anchor:START-ANCHOR", to: "2026-11-09T12:00:00Z", until: "2026-11-09T12:00:00Z" });
  assert.equal(wide.total, WHOLE + 5555);
  // No invocation present: until is null, said as such.
  assert.equal(summarizeWindow(write("noself.jsonl", BASE), { from: "anchor:START-ANCHOR", to: "anchor:END-ANCHOR" }).until, null);
});

test("an anchor matching nothing is an error, never zeros; the CLI exits non-zero and prints no numbers", async () => {
  const p = write("miss.jsonl", BASE);
  const r = summarizeWindow(p, { from: "anchor:NO-SUCH-THING", to: "anchor:END-ANCHOR" });
  assert.deepEqual({ error: r.error, which: r.which }, { error: "anchor-not-found", which: "from" });
  assert.equal(r.usage, undefined);
  assert.equal(summarizeWindow(p, { from: "anchor:START-ANCHOR", to: "anchor:NOPE" }).which, "to");
  const out = [];
  const err = [];
  const code = await costsCmd(["window", "--transcript", p, "--from", "anchor:NO-SUCH-THING", "--to", "anchor:END-ANCHOR"], {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
  });
  assert.equal(code, 2);
  assert.deepEqual(out, []);
  assert.match(err.join("\n"), /anchor-not-found/);
});

test("from resolving after to is an error", () => {
  const r = summarizeWindow(write("order.jsonl", BASE), { from: "anchor:END-ANCHOR", to: "anchor:START-ANCHOR" });
  assert.equal(r.error, "from-after-to");
});

test("ISO from/to boundaries are inclusive", () => {
  const r = summarizeWindow(write("iso.jsonl", BASE), { from: "2026-11-09T10:05:00.000Z", to: "2026-11-09T10:10:00.000Z" });
  assert.equal(r.api_calls, 2);
  assert.equal(r.total, 2222 + 3333);
  assert.equal(r.minutes, 5);
  const just = summarizeWindow(write("iso2.jsonl", BASE), { from: "2026-11-09T10:05:00.001Z", to: "2026-11-09T10:09:59.999Z" });
  assert.equal(just.api_calls, 0, "a window between messages holds none (and says 0 calls, with the timestamps resolved)");
});

// START-ANCHOR also appears on an EARLIER session-day (m0), the way `launchctl list | grep -i gbrain` did.
const M0_EARLY = '{"type":"assistant","timestamp":"2026-11-05T09:00:00.000Z","message":{"id":"m0","model":"claude-x","content":[{"type":"tool_use","name":"Bash","input":{"command":"echo START-ANCHOR"}}],"usage":{"input_tokens":9,"output_tokens":90,"cache_creation_input_tokens":900,"cache_read_input_tokens":9000}}}';

test("--since is a lower bound for anchor resolution and the window", async () => {
  const p = write("since.jsonl", [M0_EARLY, ...BASE]);
  const without = summarizeWindow(p, { from: "anchor:START-ANCHOR", to: "anchor:END-ANCHOR" });
  assert.equal(without.from_ts, "2026-11-05T09:00:00.000Z", "without since, the earlier day's match wins");
  assert.equal(without.total, WHOLE + 9999);
  const bounded = summarizeWindow(p, { since: "2026-11-09T00:00:00Z", from: "anchor:START-ANCHOR", to: "anchor:END-ANCHOR" });
  assert.equal(bounded.from_ts, "2026-11-09T10:00:00.000Z");
  assert.equal(bounded.total, WHOLE);
  const out = [];
  const code = await costsCmd(
    ["window", "--transcript", p, "--since", "2026-11-09T00:00:00Z", "--from", "anchor:START-ANCHOR", "--to", "anchor:END-ANCHOR", "--json"],
    { out: (s) => out.push(s), err: () => {} },
  );
  assert.equal(code, 0);
  assert.equal(JSON.parse(out.join("\n")).total, WHOLE);
});

test("readCosts({lanesOnly}) keeps the last of 3 cumulative rows per agent_id and reports superseded", () => {
  const state = mkdtempSync(path.join(os.tmpdir(), "costs-ledger-"));
  mkdirSync(path.join(state, "costs"));
  const row = (agent, end, total) =>
    JSON.stringify({ ts: end, kind: "lane", agent_id: agent, agent_type: "general-purpose", source: "subagent-stop", end, usage: { input: 0, output: 0, cache_create: 0, cache_read: total } });
  writeFileSync(
    path.join(state, "costs", "2026-11.jsonl"),
    [
      row("aaa", "2026-11-09T08:30:00.000Z", 9170000),
      row("bbb", "2026-11-09T08:40:00.000Z", 500),
      row("aaa", "2026-11-09T09:30:00.000Z", 11470000),
      row("aaa", "2026-11-09T10:30:00.000Z", 12920000),
      "",
    ].join("\n"),
  );
  const prev = process.env.PROPAGATE_STATE_DIR;
  process.env.PROPAGATE_STATE_DIR = state;
  try {
    const all = readCosts();
    assert.equal(all.rows.length, 4, "without lanesOnly every row is returned");
    const r = readCosts({ lanesOnly: true });
    assert.equal(r.superseded, 2);
    assert.equal(r.rows.length, 2);
    assert.equal(r.rows.find((x) => x.agent_id === "aaa").usage.cache_read, 12920000);
    assert.equal(r.rows.find((x) => x.agent_id === "bbb").usage.cache_read, 500);
  } finally {
    if (prev === undefined) delete process.env.PROPAGATE_STATE_DIR;
    else process.env.PROPAGATE_STATE_DIR = prev;
  }
});

// An EARLIER `costs window` run quoting anchor QQQ (trap 3, second form), then the real message holding QQQ,
// then a later real message, then the current invocation.
const Q_PRIOR = '{"type":"assistant","timestamp":"2026-11-09T09:00:00.000Z","message":{"id":"q0","model":"claude-x","content":[{"type":"tool_use","name":"Bash","input":{"command":"propagate costs window --from anchor:QQQ --to anchor:END-ANCHOR"}}],"usage":{"input_tokens":7,"output_tokens":70,"cache_creation_input_tokens":700,"cache_read_input_tokens":7000}}}';
const Q_REAL = '{"type":"assistant","timestamp":"2026-11-09T10:00:00.000Z","message":{"id":"q1","model":"claude-x","content":[{"type":"thinking","thinking":"","signature":"CAQSxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"},{"type":"tool_use","name":"Bash","input":{"command":"echo QQQ-real-start\\nls"}}],"usage":{"input_tokens":1,"output_tokens":10,"cache_creation_input_tokens":100,"cache_read_input_tokens":1000}}}';
const Q_CURRENT = '{"type":"assistant","timestamp":"2026-11-09T12:00:00.000Z","message":{"id":"q9","model":"claude-x","content":[{"type":"tool_use","name":"Bash","input":{"command":"propagate costs window --from anchor:QQQ --to anchor:END-ANCHOR"}}],"usage":{"input_tokens":5,"output_tokens":50,"cache_creation_input_tokens":500,"cache_read_input_tokens":5000}}}';

test("an EARLIER costs window invocation never satisfies an anchor, but its spend still counts", () => {
  const p = write("prior.jsonl", [Q_PRIOR, Q_REAL, M3, Q_CURRENT]);
  const r = summarizeWindow(p, { from: "anchor:QQQ", to: "anchor:END-ANCHOR" });
  assert.equal(r.error, undefined);
  assert.equal(r.from_ts, "2026-11-09T10:00:00.000Z", "from is the real message, not the 09:00 invocation");
  assert.equal(r.total, 1111 + 3333);
  // An ISO window covering the earlier invocation counts it (real cost).
  const wide = summarizeWindow(p, { from: "2026-11-09T08:00:00Z", to: "2026-11-09T11:00:00Z" });
  assert.equal(wide.total, 7777 + 1111 + 3333);
});

test("an anchor present ONLY inside an earlier invocation is anchor-not-found, and the real CLI exits 2", async () => {
  const p = write("only-prior.jsonl", [Q_PRIOR, M3, Q_CURRENT]);
  const r = summarizeWindow(p, { from: "anchor:QQQ", to: "anchor:END-ANCHOR" });
  assert.deepEqual({ error: r.error, which: r.which }, { error: "anchor-not-found", which: "from" });
  const { spawnSync } = await import("node:child_process");
  const res = spawnSync(process.execPath, ["cli.mjs", "costs", "window", "--transcript", p, "--from", "anchor:QQQ", "--to", "anchor:x"], {
    cwd: path.resolve(import.meta.dirname, "../.."),
    encoding: "utf8",
    env: { ...process.env, NODE_TEST_CONTEXT: "child" },
  });
  assert.equal(res.status, 2);
  assert.equal(res.stdout, "");
});

test("the matched excerpt is centred on the match, not the head of the JSON content", () => {
  const r = summarizeWindow(write("excerpt.jsonl", [Q_REAL, M3]), { from: "anchor:QQQ-real-start", to: "anchor:END-ANCHOR" });
  assert.match(r.from_anchor, /QQQ-real-start/);
  assert.doesNotMatch(r.from_anchor, /signature/);
  assert.ok(!r.from_anchor.includes("\\n"), "escaped newline flattened");
});

// A message quoting `anchor:QQQ` WITHOUT the words "costs window" (a direct costsCmd call), then a genuine QQQ.
const R_QUOTE = '{"type":"assistant","timestamp":"2026-11-09T09:00:00.000Z","message":{"id":"r0","model":"claude-x","content":[{"type":"tool_use","name":"Bash","input":{"command":"node -e \\"costsCmd([\'window\',\'--from\',\'anchor:QQQ\'])\\""}}],"usage":{"input_tokens":7,"output_tokens":70,"cache_creation_input_tokens":700,"cache_read_input_tokens":7000}}}';

test("a message quoting the anchor as typed (no 'costs window' wording) never satisfies it", () => {
  const only = summarizeWindow(write("typed-only.jsonl", [R_QUOTE, M3]), { from: "anchor:QQQ", to: "anchor:END-ANCHOR" });
  assert.deepEqual({ error: only.error, which: only.which }, { error: "anchor-not-found", which: "from" });
  const both = summarizeWindow(write("typed-both.jsonl", [R_QUOTE, Q_REAL, M3]), { from: "anchor:QQQ", to: "anchor:END-ANCHOR" });
  assert.equal(both.error, undefined);
  assert.equal(both.from_ts, "2026-11-09T10:00:00.000Z");
});

// SIGMARK occurs only in a thinking block's signature and thinking text; TOOLMARK only in a tool_use input.
const T_THINK = '{"type":"assistant","timestamp":"2026-11-09T10:00:00.000Z","message":{"id":"t1","model":"claude-x","content":[{"type":"thinking","thinking":"consider SIGMARK","signature":"dGOiSIGMARKxx"},{"type":"tool_use","name":"Bash","input":{"command":"echo TOOLMARK"}}],"usage":{"input_tokens":1,"output_tokens":10,"cache_creation_input_tokens":100,"cache_read_input_tokens":1000}}}';

test("anchors never match thinking text or signatures, only text and tool_use input", () => {
  const p = write("think.jsonl", [T_THINK, M3]);
  const sig = summarizeWindow(p, { from: "anchor:SIGMARK", to: "anchor:END-ANCHOR" });
  assert.deepEqual({ error: sig.error, which: sig.which }, { error: "anchor-not-found", which: "from" });
  const tool = summarizeWindow(p, { from: "anchor:TOOLMARK", to: "anchor:END-ANCHOR" });
  assert.equal(tool.error, undefined);
  assert.equal(tool.total, 1111 + 3333, "the thinking-bearing message still counts for usage");
});
