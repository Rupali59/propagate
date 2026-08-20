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
