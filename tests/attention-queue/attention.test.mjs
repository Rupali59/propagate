// propagate#445: the attention queue. The osascript and ps binaries are stubs; the real ones never run.
// @size small
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { append, markHandled, pending, pop, queueFile, readEvents } from "../../scripts/attention-queue/queue.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HOOK = path.join(ROOT, "scripts/attention-queue/hook.mjs");
const CLI = path.join(ROOT, "cli.mjs");
const tmp = () => mkdtempSync(path.join(tmpdir(), "attn-"));

/** An osascript stub: lists terminals for `ttys` and records each focus call (its last -e script) in focus.log. */
function osaStub(dir, ttys, { fail } = {}) {
  const bin = path.join(dir, "osa.sh");
  const rows = ttys.map((t, i) => `T${i}-${t}\t/dev/${t}`).join("\\n");
  writeFileSync(bin, `#!/bin/sh
${fail ? `echo "${fail}" >&2; exit 1` : ""}
case "$*" in
  *"focus term"*) echo "$*" | grep -o 'id is "[^"]*"' >> "${dir}/focus.log"; exit 0;;
  *) printf '${rows}\\n';;
esac
`);
  chmodSync(bin, 0o755);
  return bin;
}
const psStub = (dir, tty) => {
  const bin = path.join(dir, "ps.sh");
  writeFileSync(bin, `#!/bin/sh\necho "  1 ${tty}"\n`);
  chmodSync(bin, 0o755);
  return bin;
};
const cli = (args, env, dir) =>
  spawnSync("node", [CLI, "attention", ...args], { encoding: "utf8", env: { ...process.env, PROPAGATE_STATE_DIR: dir, ...env }, timeout: 30000 });
const entry = (id, tty) => ({ session_id: id, tty, cwd: "/w/proj", message: "needs input" });
const at = (n) => new Date(Date.UTC(2026, 0, 1, 0, 0, n));

test("queue: A, B, C come out in the order they were queued, a repeat does not duplicate, handled stays in the file", () => {
  const f = queueFile(tmp());
  append(f, entry("a", "ttys001"), at(1));
  append(f, entry("b", "ttys002"), at(2));
  assert.equal(append(f, entry("a", "ttys001"), at(3)), false, "a repeat of a pending session is not queued");
  append(f, entry("c", "ttys003"), at(4));
  assert.deepEqual(pending(readEvents(f)).map((e) => e.session_id), ["a", "b", "c"]);
  const live = ["ttys001", "ttys002", "ttys003"];
  const order = [];
  for (;;) {
    const { entry: e } = pop(pending(readEvents(f)), live);
    if (!e) break;
    order.push(e.session_id);
    markHandled(f, e.session_id, "focused", at(10));
  }
  assert.deepEqual(order, ["a", "b", "c"]);
  assert.equal(readEvents(f).length, 3 + 3, "no line was removed or edited");
  assert.equal(append(f, entry("a", "ttys001"), at(20)), true, "a handled session queues again");
});

test("queue: pop skips an entry whose tty is not live and reports it", () => {
  const { entry: e, skipped } = pop([entry("a", "ttys001"), entry("b", "ttys002")], ["/dev/ttys002"]);
  assert.equal(e.session_id, "b");
  assert.deepEqual(skipped.map((s) => s.session_id), ["a"]);
});

test("hook: a Notification payload appends one entry with the tty from ps; agent_type and garbage append nothing", () => {
  const dir = tmp();
  const env = { ...process.env, PROPAGATE_STATE_DIR: dir, PROPAGATE_PS_BIN: psStub(dir, "ttys007") };
  const run = (stdin) => spawnSync("node", [HOOK], { input: stdin, encoding: "utf8", env, timeout: 15000 });
  const base = { session_id: "s1", hook_event_name: "Notification", message: "needs input", notification_type: "idle_prompt", cwd: "/w/proj" };
  assert.equal(run(JSON.stringify(base)).status, 0);
  const evs = readEvents(queueFile(dir));
  assert.equal(evs.length, 1);
  assert.equal(evs[0].tty, "ttys007");
  assert.equal(evs[0].session_id, "s1");
  assert.equal(run(JSON.stringify({ ...base, session_id: "s2", agent_type: "x" })).status, 0);
  const g = run("not json {{");
  assert.equal(g.status, 0);
  assert.equal(g.stdout + g.stderr, "");
  assert.equal(readEvents(queueFile(dir)).length, 1, "the subagent payload and the garbage appended nothing");
});

test("next: skips a closed tab with the stated reason, focuses the next live one, and records both", () => {
  const dir = tmp();
  const f = queueFile(dir);
  append(f, entry("a", "ttys001"), at(1));
  append(f, entry("b", "ttys002"), at(2));
  const r = cli(["next"], { PROPAGATE_OSASCRIPT_BIN: osaStub(dir, ["ttys002"]) }, dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /skipped a \(tab closed\)/);
  assert.match(readFileSync(path.join(dir, "focus.log"), "utf8"), /T0-ttys002/);
  const handled = readEvents(f).filter((e) => e.event === "handled");
  assert.deepEqual(handled.map((e) => [e.session_id, e.reason]), [["a", "stale"], ["b", "focused"]]);
});

test("next: empty queue exits 1 and says so, without running osascript", () => {
  const dir = tmp();
  const r = cli(["next"], { PROPAGATE_OSASCRIPT_BIN: path.join(dir, "absent") }, dir);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /nothing waiting/);
});

test("next: a missing osascript exits 2 with the reason", () => {
  const dir = tmp();
  append(queueFile(dir), entry("a", "ttys001"), at(1));
  const r = cli(["next"], { PROPAGATE_OSASCRIPT_BIN: path.join(dir, "absent") }, dir);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /osascript could not run/);
  assert.equal(pending(readEvents(queueFile(dir))).length, 1, "the entry stays queued");
});

test("next: osascript failing (Automation denied) exits 2 and prints its stderr", () => {
  const dir = tmp();
  append(queueFile(dir), entry("a", "ttys001"), at(1));
  const r = cli(["next"], { PROPAGATE_OSASCRIPT_BIN: osaStub(dir, [], { fail: "Not authorized to send Apple events" }) }, dir);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Not authorized to send Apple events/);
});

test("list is oldest first; clear without --apply leaves the queue file byte-identical", () => {
  const dir = tmp();
  const f = queueFile(dir);
  append(f, entry("a", "ttys001"), at(1));
  append(f, entry("b", "ttys002"), at(2));
  const l = cli(["list"], {}, dir);
  assert.equal(l.status, 0);
  assert.ok(l.stdout.indexOf(" a ") < l.stdout.indexOf(" b "), l.stdout);
  const before = readFileSync(f);
  const d = cli(["clear"], {}, dir);
  assert.equal(d.status, 0);
  assert.match(d.stdout, /dry run/);
  assert.deepEqual(readFileSync(f), before, "clear without --apply must not touch the queue file");
  assert.equal(cli(["list"], {}, dir).stdout, l.stdout, "list is read-only");
  assert.equal(cli(["clear", "--apply"], {}, dir).status, 0);
  assert.equal(pending(readEvents(f)).length, 0);
  assert.ok(existsSync(f));
});
