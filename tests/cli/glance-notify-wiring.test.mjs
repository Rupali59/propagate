/**
 * glance-notify-wiring.test.mjs — propagate#296: the REAL monitor and digest paths, with the notifier replaced by a
 * recorder (PROPAGATE_NOTIFIER), so what is asserted is the argv terminal-notifier would have received.
 *
 *   1. Every notification the monitor sends carries a click target: `-execute` runs widget/open-ui.sh with a route
 *      from the fixed vocabulary, and no item text (title, body) reaches that argument. (T-M6)
 *   2. The first run with no notify state seeds silently; a second run over the same state is silent. (T-M1, seeding)
 *   3. The digest notification's body is the glance verdict line, and it opens the glance route. (T-O2)
 *
 * HERMETIC: PROPAGATE_STATE_DIR, PROPAGATE_NOTIFIED, PROPAGATE_MONITOR_LOG and HOME are temp paths, the search root is
 * a temp tree with no edges, and gh is a script that fails. Names are synthetic.
 */
// @size medium — starts processes (CLI or script); run when affected
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CLI = path.join(ROOT, "cli.mjs");

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "glance-notify-wire-"));
  const ws = path.join(dir, "ws");
  const state = path.join(dir, "state");
  const rec = path.join(dir, "rec");
  const home = path.join(dir, "home");
  for (const d of [ws, state, rec, home]) mkdirSync(d, { recursive: true });
  const gh = path.join(dir, "gh");
  writeFileSync(gh, "#!/bin/sh\nexit 1\n");
  chmodSync(gh, 0o755);
  // The recorder: one file per call, argv NUL-separated (a body holds newlines).
  const notifier = path.join(dir, "notifier");
  writeFileSync(notifier, `#!/bin/sh\nf=$(mktemp "${rec}/call.XXXXXX")\nprintf '%s\\0' "$@" > "$f"\n`);
  chmodSync(notifier, 0o755);
  const env = { ...process.env, HOME: home, PROPAGATE_STATE_DIR: state, PROPAGATE_SEARCH_ROOTS: ws, PROPAGATE_GH_BIN: gh, PROPAGATE_NOTIFIER: notifier, PROPAGATE_NOTIFIED: path.join(dir, "notified.jsonl"), PROPAGATE_MONITOR_LOG: path.join(dir, "monitor.log"), NO_COLOR: "1" };
  const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: 240000, env });
  const calls = () => readdirSync(rec).sort().map((f) => {
    const argv = readFileSync(path.join(rec, f), "utf8").split("\0").slice(0, -1);
    const get = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
    return { argv, title: get("-title"), body: get("-message"), execute: get("-execute"), group: get("-group") };
  });
  const clear = () => { for (const f of readdirSync(rec)) rmSync(path.join(rec, f)); };
  return { dir, state, env, run, calls, clear };
}

const ROUTE = /'\/(glance|judge|backlog)(\/[A-Za-z0-9%._~-]+)?(\?edge=[A-Za-z0-9%._~-]+)?'$/;

test("monitor: the first run seeds silently, an addition notifies with a click target, a repeat is silent", () => {
  const f = fixture();
  try {
    const first = f.run(["monitor"]);
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(f.calls(), [], "first run after upgrade: seeded, nothing sent");
    const st = JSON.parse(readFileSync(path.join(f.state, "notify-state.json"), "utf8"));
    assert.ok(st.channels.edges && st.channels.glance, JSON.stringify(Object.keys(st.channels)));
    const seededGlance = Object.keys(st.channels.glance.ids);
    assert.ok(seededGlance.length > 0, "the temp tree has broken or unknown glance items to seed: " + JSON.stringify(seededGlance));

    // Forget the glance channel's memory: every present item is now an addition.
    st.channels.glance.ids = {};
    writeFileSync(path.join(f.state, "notify-state.json"), JSON.stringify(st));
    const second = f.run(["monitor"]);
    assert.equal(second.status, 0, second.stderr);
    const calls = f.calls();
    assert.ok(calls.length >= 1, "the additions notified: " + second.stdout + second.stderr);
    for (const c of calls) {
      assert.ok(c.execute, `every notification carries a click target: ${JSON.stringify(c.argv)}`);
      assert.match(c.execute, /\/bin\/bash '[^']*\/widget\/open-ui\.sh' /, c.execute);
      assert.match(c.execute, ROUTE, c.execute);
      assert.ok(c.execute.includes(`PROPAGATE_STATE_DIR='${f.state}'`), "the click reads this install's state dir");
      // The route is the only part of -execute built from the item; the rest is this install's paths.
      const route = /'([^']*)'$/.exec(c.execute)[1];
      for (const word of `${c.title} ${c.body}`.split(/[^A-Za-z]+/).filter((w) => w.length > 3)) {
        assert.ok(!route.toLowerCase().includes(word.toLowerCase()) || /^(glance|judge|backlog|edge|doctor|work|job)$/i.test(word), `item text ${JSON.stringify(word)} reached the route: ${route}`);
      }
    }
    assert.ok(calls.some((c) => c.group === "propagate-glance"), "the glance channel sent it");

    f.clear();
    const third = f.run(["monitor"]);
    assert.equal(third.status, 0, third.stderr);
    assert.deepEqual(f.calls().map((c) => c.title), [], "nothing new: silent");
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("monitor --dry-run sends nothing and writes no notify state", () => {
  const f = fixture();
  try {
    const r = f.run(["monitor", "--dry-run"]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(f.calls(), []);
    assert.equal(existsSync(path.join(f.state, "notify-state.json")), false);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("digest: the notification body is the glance verdict line and the click opens the glance", () => {
  const f = fixture();
  try {
    const now = new Date().toISOString();
    writeFileSync(path.join(f.state, "glance.json"), JSON.stringify({
      schema_version: 1, generatedAt: now, stale_after_s: 21600, verdict: "broken", signals_checked: 6, needs_you_ids: [], skipped: [],
      items: [{ id: "job:sample.collect", signal: "jobs", kind: "heartbeat", verdict: "broken", flag: null, owner: "you", subject: "job sample.collect", what: "last exit code 1", line: "x", why: "y", fix: { text: "propagate doctor --full", command: "propagate doctor --full" }, since: now, looked_at: 1, source: "doctor snapshot" }],
    }));
    const script = `import("${path.join(ROOT, "digest.mjs")}").then((m) => m.deliverDigest("## 2026-11-16T04:00:00.000Z\\n\\nsome digest text\\n")).then((c) => console.log(c))`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 120000, env: f.env });
    assert.equal(r.status, 0, r.stderr);
    const calls = f.calls();
    assert.equal(calls.length, 1, JSON.stringify(calls));
    assert.equal(calls[0].title, "propagate digest");
    assert.match(calls[0].body, /^\[BROKEN\] jobs: /, calls[0].body);
    assert.doesNotMatch(calls[0].body, /2026-11-16T04/, "never the timestamp heading");
    assert.match(calls[0].execute, /'\/glance'$/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
