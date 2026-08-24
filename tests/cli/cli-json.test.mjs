import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  heartbeatState,
  findDuplicateOpenAcrossLedgers,
  parsePlistWatchPaths,
  expectedWatchPaths,
  nestedUnderOf,
} from "../../cli.mjs";

// ─────────────────────────────────────────────────────────────────────────────
// heartbeatState — boundaries only (69/70/300/301) + absent.
// Derives ONLY from heartbeat age; must never fold in ledger activity.
// 70s = StartInterval (60s) + slack.
// ─────────────────────────────────────────────────────────────────────────────

test("heartbeatState: 0s is alive", () => {
  assert.equal(heartbeatState(0), "alive");
});

test("heartbeatState: 69s (just under the 70s slack) is alive", () => {
  assert.equal(heartbeatState(69), "alive");
});

test("heartbeatState: 70s (exactly StartInterval + slack) is late, not alive", () => {
  assert.equal(heartbeatState(70), "late");
});

test("heartbeatState: 300s (upper edge of late) is still late", () => {
  assert.equal(heartbeatState(300), "late");
});

test("heartbeatState: 301s (just past late) is dead", () => {
  assert.equal(heartbeatState(301), "dead");
});

test("heartbeatState: null/undefined/non-finite age is never (no heartbeat file)", () => {
  assert.equal(heartbeatState(null), "never");
  assert.equal(heartbeatState(undefined), "never");
  assert.equal(heartbeatState(NaN), "never");
});

// ─────────────────────────────────────────────────────────────────────────────
// findDuplicateOpenAcrossLedgers — synthetic ledgers.
// ─────────────────────────────────────────────────────────────────────────────

test("findDuplicateOpenAcrossLedgers: same absolute source open in two ledgers is flagged", () => {
  const hubRoot = "/hub";
  const wsRoot = "/hub/Foo";
  const entries = [
    {
      workspaceRoot: hubRoot,
      ledgerPath: "/hub/.propagation/ledger.jsonl",
      rows: [{ id: "001", status: "open", source: "Foo/server/index.js" }],
    },
    {
      workspaceRoot: wsRoot,
      ledgerPath: "/hub/Foo/docs/PROPAGATION_LEDGER.jsonl",
      rows: [{ id: "004", status: "open", source: "server/index.js" }],
    },
  ];
  const result = findDuplicateOpenAcrossLedgers(entries);
  assert.equal(result.count, 1);
  assert.equal(result.examples[0].path, path.resolve(wsRoot, "server/index.js"));
  assert.deepEqual(
    result.examples[0].ledgers.sort(),
    ["/hub/.propagation/ledger.jsonl", "/hub/Foo/docs/PROPAGATION_LEDGER.jsonl"].sort(),
  );
});

test("findDuplicateOpenAcrossLedgers: same source but only open in one ledger is not flagged", () => {
  const hubRoot = "/hub";
  const wsRoot = "/hub/Foo";
  const entries = [
    {
      workspaceRoot: hubRoot,
      ledgerPath: "/hub/.propagation/ledger.jsonl",
      rows: [{ id: "001", status: "done", source: "Foo/server/index.js" }],
    },
    {
      workspaceRoot: wsRoot,
      ledgerPath: "/hub/Foo/docs/PROPAGATION_LEDGER.jsonl",
      rows: [{ id: "004", status: "open", source: "server/index.js" }],
    },
  ];
  const result = findDuplicateOpenAcrossLedgers(entries);
  assert.equal(result.count, 0);
});

test("findDuplicateOpenAcrossLedgers: distinct files across ledgers are not flagged", () => {
  const entries = [
    {
      workspaceRoot: "/hub",
      ledgerPath: "/hub/.propagation/ledger.jsonl",
      rows: [{ id: "001", status: "open", source: "Foo/server/a.js" }],
    },
    {
      workspaceRoot: "/hub/Foo",
      ledgerPath: "/hub/Foo/docs/PROPAGATION_LEDGER.jsonl",
      rows: [{ id: "004", status: "open", source: "server/b.js" }],
    },
  ];
  const result = findDuplicateOpenAcrossLedgers(entries);
  assert.equal(result.count, 0);
});

test("findDuplicateOpenAcrossLedgers: rows without a source are ignored, not crash", () => {
  const entries = [
    { workspaceRoot: "/hub", ledgerPath: "/hub/ledger.jsonl", rows: [{ id: "001", status: "open" }] },
  ];
  assert.doesNotThrow(() => findDuplicateOpenAcrossLedgers(entries));
  assert.equal(findDuplicateOpenAcrossLedgers(entries).count, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// parsePlistWatchPaths / expectedWatchPaths
// ─────────────────────────────────────────────────────────────────────────────

test("parsePlistWatchPaths extracts WatchPaths <string> entries in order", () => {
  const xml = `<plist><dict>
    <key>WatchPaths</key>
    <array>
      <string>/a/b</string>
      <string>/a/b/docs</string>
    </array>
  </dict></plist>`;
  assert.deepEqual(parsePlistWatchPaths(xml), ["/a/b", "/a/b/docs"]);
});

test("parsePlistWatchPaths returns [] when the key is absent", () => {
  assert.deepEqual(parsePlistWatchPaths("<plist><dict></dict></plist>"), []);
});

test("parsePlistWatchPaths unescapes XML entities", () => {
  const xml = `<key>WatchPaths</key><array><string>/a &amp; b</string></array>`;
  assert.deepEqual(parsePlistWatchPaths(xml), ["/a & b"]);
});

test("expectedWatchPaths includes root only when docs/ does not exist", () => {
  const set = expectedWatchPaths([{ root: "/nonexistent-ws-root-xyz" }]);
  assert.deepEqual([...set], ["/nonexistent-ws-root-xyz"]);
});

test("expectedWatchPaths includes the resolved ledger directory for a propagation/-layout workspace (the silent unwatched-ledger fix)", () => {
  // Before the fix, expectedWatchPaths rebuilt path.join(ws.root, "docs")
  // instead of reading ws.ledgerJsonl — a propagation/-layout (or legacy
  // .propagation/-layout) workspace's ledger dir was silently absent from
  // the watch set even though the workspace record has it right there.
  const set = expectedWatchPaths([
    { root: "/ws", ledgerJsonl: "/ws/propagation/ledger.jsonl" },
  ]);
  assert.ok(set.has("/ws"));
  assert.ok(set.has("/ws/propagation"), "the resolved ledger directory must be watched");
});

test("expectedWatchPaths includes the resolved ledger directory for a legacy .propagation/-layout workspace", () => {
  const set = expectedWatchPaths([
    { root: "/ws", ledgerJsonl: "/ws/.propagation/ledger.jsonl" },
  ]);
  assert.ok(set.has("/ws/.propagation"));
});

// ─────────────────────────────────────────────────────────────────────────────
// nestedUnderOf
// ─────────────────────────────────────────────────────────────────────────────

test("nestedUnderOf: nested workspace reports nearest ancestor root", () => {
  const hub = { root: "/hub" };
  const nested = { root: "/hub/Foo/Bar" };
  const mid = { root: "/hub/Foo" };
  const nestedUnder = nestedUnderOf(nested, [hub, mid, nested]);
  assert.equal(nestedUnder, "/hub/Foo", "nearest ancestor, not furthest");
});

test("nestedUnderOf: top-level workspace has no ancestor", () => {
  const hub = { root: "/hub" };
  assert.equal(nestedUnderOf(hub, [hub]), null);
});

/**
 * N46 — `WatchPaths` is dropped, and the monitor's plist is the one checked.
 *
 * `watchPathsFor` built `ws.root` plus `ws.root/docs`. Three measured facts, all
 * from the issue and re-verified 2026-08-24, say that mechanism should not exist:
 *
 * 1. **launchd `WatchPaths` is not recursive.** It fires on changes to entries
 *    IN the named directory, never deep beneath it — so `ws.root` never caught a
 *    nested source edit, and the real trigger has always been
 *    `StartInterval 1800`.
 * 2. **`docs/` stopped holding state on 2026-08-21**, and the v3 migration
 *    emptied it in all 13 workspaces. The installed plist watches 13 such
 *    directories.
 * 3. **It was stale in BOTH directions and nothing said so** — missing the six
 *    workspaces declared on 2026-08-24, while watching directories that no
 *    longer hold what they were watched for. A regeneration on 2026-08-22
 *    silently dropped 8 of 20 paths.
 *
 * The monitor also reads no ledger (`monitor.mjs:21`), so waking it on a ledger
 * change buys nothing; the job that reads ledgers is time-triggered.
 *
 * So: dropped, not widened. The issue says explicitly "do not simply add
 * `propagation/`" — that would keep a non-recursive mechanism alive and give it
 * a fresh directory to go stale against.
 *
 * AND THE CHECK NOW READS THE RIGHT FILE. `doctor`'s `plist WatchPaths` check
 * pointed at the RETIRED watcher's plist, which does not exist, so it reported
 * `n/a` forever while the monitor's plist — which does exist and was stale both
 * ways — was never examined. A check aimed at the wrong file is the same as no
 * check, and reads as a pass.
 */
test("N46: watchPathsFor returns nothing — the mechanism is retired, not widened", async () => {
  const { watchPathsFor } = await import("../../lib/core/plist.mjs");
  assert.deepEqual(
    watchPathsFor([{ root: "/tmp/ws-a" }, { root: "/tmp/ws-b" }]),
    [],
    "any non-empty return means the non-recursive mechanism is back",
  );
});

test("N46: a generated monitor plist declares no WatchPaths key at all", async () => {
  const { renderMonitorPlist } = await import("../../lib/core/plist.mjs");
  const xml = renderMonitorPlist({ stateDir: "/tmp/state" });
  assert.doesNotMatch(xml, /<key>WatchPaths<\/key>/, "an empty array would still be a key to go stale against");
  assert.match(xml, /StartInterval/, "the interval is the trigger, and must remain");
});
