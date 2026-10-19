/**
 * rollup-delegated.test.mjs — a register that delegates to GitHub is NOT "empty" (#104, R4).
 *
 * Until now the rollup classified a delegated register as `empty` ("register parsed, 0 open items"), the reading
 * that made ~300 open GitHub issues look like nothing to do. It now renders `[DELEGATED]` and names what the
 * tracker holds, or that it has not been read. A date is used, not an age, so the generated file does not change
 * wording between two renders of the same data.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { backlog } from "../../lib/report/backlog.mjs";
import { rollup, renderRollup } from "../../lib/report/rollup.mjs";

const ISSUES = "https://github.com/o/r/issues";
// realpathSync: see tests/unit/rollup-render.test.mjs -- macOS tmpdir is under a symlink and owner matching resolves it.
const ROOT = realpathSync(mkdtempSync(path.join(tmpdir(), "rollup-delegated-")));
const OWNER = path.join(ROOT, "D1-delegating");
mkdirSync(path.join(OWNER, ".git"), { recursive: true });
writeFileSync(path.join(OWNER, "TODOS.md"), `# TODOS\n\n**Open work lives in [GitHub issues](${ISSUES}), not in this file.**\n\nThis file was the ledger until 2026-09-18.\n`);
after(() => rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

const EMPTY_INVENTORY = { categories: { skills: [], plugins: [], repos: [], standalone: [] }, counts: {}, probeLimits: {}, dropped: [], budgetExceeded: false };
const cacheWith = (entry) => ({ path: "p", present: true, error: null, writtenAt: "2026-10-19T00:00:00.000Z", ageMs: 1000, entries: entry ? { "o/r|": entry } : {} });
const render = (trackerCache) => {
  const backlogResult = backlog({ searchRoots: [ROOT], trackerCache });
  return { backlogResult, rendered: renderRollup(rollup({ searchRoots: [ROOT], backlogResult, inventoryResult: EMPTY_INVENTORY })) };
};
const line = (rendered) => rendered.split("\n").find((l) => l.includes("[DELEGATED]")) ?? "";

test("a delegated register with a read tracker says how many are open on GitHub, as of a date -- and is not EMPTY", () => {
  const issues = [1, 2].map((n) => ({ number: n, title: "t" + n, url: `https://github.com/o/r/issues/${n}`, labels: [] }));
  const { rendered, backlogResult } = render(cacheWith({ status: "counted", issues, fetchedAt: "2026-10-19T10:00:00.000Z" }));
  assert.match(line(rendered), /delegated → 2 open on GitHub \(as of 2026-10-19\)/);
  assert.doesNotMatch(rendered, /\[EMPTY\].*TODOS\.md/, "the reading that hid 300 issues is gone");
  assert.equal(backlogResult.ranked.filter((i) => i.kind === "github").length, 2);
});

test("a tracker never read renders `not fetched … this is not 0`; an unreadable one says so, and a stale one names its last read", () => {
  const cold = render(cacheWith(null)).rendered;
  assert.match(line(cold), /not fetched yet \(run propagate backlog\); this is not 0/);
  assert.doesNotMatch(line(cold), /0 open/);

  const bad = render(cacheWith({ status: "unreadable", reason: "gh exited 1: HTTP 401", issues: [], stale: false })).rendered;
  assert.match(line(bad), /unreadable: gh exited 1: HTTP 401; this is not 0/);

  const stale = render(cacheWith({ status: "unreadable", reason: "timed out after 15s", stale: true, fetchedAt: "2026-10-18T09:00:00.000Z", issues: [{ number: 1, title: "t", url: "u", labels: [] }] })).rendered;
  assert.match(line(stale), /the last read, 1 open \(as of 2026-10-18\), is stale/);
});

test("the coverage invariant still holds with GitHub rows in `ranked`: every row counted once", () => {
  const issues = [1, 2, 3].map((n) => ({ number: n, title: "t" + n, url: "u", labels: [] }));
  const backlogResult = backlog({ searchRoots: [ROOT], trackerCache: cacheWith({ status: "counted", issues, fetchedAt: "2026-10-19T10:00:00.000Z" }) });
  const result = rollup({ searchRoots: [ROOT], backlogResult, inventoryResult: EMPTY_INVENTORY });
  assert.equal(result.coverage.ok, true);
  assert.equal(result.coverage.summedItems, backlogResult.ranked.length);
});
