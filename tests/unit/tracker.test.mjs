/**
 * tracker.test.mjs — #104, R4: backlog reads the work that moved to GitHub back from GitHub.
 *
 * Two halves, and the line between them is the point:
 *   - `refreshTrackers` (lib/tasks/tracker.mjs) is ASYNC and talks to gh. It leaves a cache.
 *   - `backlog()` (lib/report/backlog.mjs) is SYNCHRONOUS and offline. It merges the cache.
 *
 * HERMETIC: every gh here is a fake (a function, or a script on PROPAGATE_GH_BIN), and every state
 * directory is a temp dir. `npm run test:propagate` also points PROPAGATE_GH_BIN at a stub that exits 1,
 * so a test that forgets its fake fails loudly instead of reaching GitHub.
 *
 * The real gh path is NOT executed by this file (rule:name-what-no-test-executes). The REST argv shape is
 * pinned instead (`ghArgsFor`), and the one real run is recorded by the release that ships this.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { refreshTrackers, readTrackerCache, ghArgsFor, parsePaginatedArrays, keyForDestination, formatAge } from "../../lib/tasks/tracker.mjs";
import { backlog, priorityFromLabels, mergeTrackerCache, groupForBrief, filterByAffects } from "../../lib/report/backlog.mjs";

const ISSUES = "https://github.com/o/r/issues";
const tmp = (p) => mkdtempSync(path.join(tmpdir(), p));
const done = (...dirs) => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); };

/** A REST issue as GitHub returns it. */
const issue = (number, over = {}) => ({
  number, title: `issue ${number}`, html_url: `https://github.com/o/r/issues/${number}`,
  labels: [{ name: "task" }], created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-02T00:00:00Z", ...over,
});
const ok = (value) => ({ status: 0, stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "" });

/** A gh that records its argv and answers by repo: `answers[repo]` is a gh result, or a function. */
function recordingGh(answers) {
  const calls = [];
  const gh = async (args) => {
    calls.push(args);
    const repo = /^repos\/([^/]+\/[^/?]+)\//.exec(args[1])?.[1];
    const a = answers[repo] ?? { status: 1, stdout: "", stderr: "HTTP 404: no such repo " + repo };
    return typeof a === "function" ? a(args) : a;
  };
  return { gh, calls };
}

/** A tree with one delegating register per entry: { name: destinationUrl }. */
function delegatingTree(registers) {
  const root = tmp("tracker-tree-");
  for (const [name, url] of Object.entries(registers)) {
    const dir = path.join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "TODOS.md"), `# TODOS\n\n**Open work lives in [GitHub issues](${url}), not in this file.**\n\nThis file was the ledger until 2026-09-18.\n`);
  }
  return root;
}
const delegatedOf = (root, urls) => Object.entries(urls).map(([name, delegatedTo]) => ({ file: path.join(root, name, "TODOS.md"), delegatedTo }));

/** A shell fake gh: appends argv to `log`, then runs `body`. */
function scriptGh(dir, body) {
  const bin = path.join(dir, "gh-" + Math.random().toString(36).slice(2));
  const log = bin + ".log";
  writeFileSync(bin, `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\n${body}\n`);
  chmodSync(bin, 0o755);
  return { bin, calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []) };
}

/* -- the REST shape ----------------------------------------------------------- */

test("the read goes through REST (`gh api … --paginate`), never `gh issue list`, which spends the GraphQL budget", () => {
  assert.deepEqual(ghArgsFor({ repo: "o/r" }), ["api", "repos/o/r/issues?state=open&per_page=100", "--paginate"]);
  assert.deepEqual(
    ghArgsFor({ repo: "o/r", labels: ["project:propagate", "two words"] }),
    ["api", "repos/o/r/issues?state=open&per_page=100&labels=project%3Apropagate,two%20words", "--paginate"],
    "label filters are URL-encoded, comma-joined (AND)",
  );
  for (const a of ghArgsFor({ repo: "o/r" })) assert.doesNotMatch(a, /^(issue|list|graphql)$/);
});

test("gh --paginate prints one array per page; the parser takes `[..][..]` and refuses anything that is not arrays", () => {
  assert.deepEqual(parsePaginatedArrays('[{"a":1}]\n[{"a":2},{"a":3}]'), [{ a: 1 }, { a: 2 }, { a: 3 }]);
  assert.deepEqual(parsePaginatedArrays('[{"t":"has ][ in a string"}][{"t":"and \\" a quote ]"}]').map((x) => x.t), ["has ][ in a string", 'and " a quote ]']);
  assert.deepEqual(parsePaginatedArrays("[]"), []);
  assert.throws(() => parsePaginatedArrays(""), /not JSON/, "empty output is not an empty list");
  assert.throws(() => parsePaginatedArrays("not json"), /not JSON/);
  assert.throws(() => parsePaginatedArrays("{}"), /not a JSON array/);
  assert.throws(() => parsePaginatedArrays("[{}] trailing"), /not JSON/);
});

/* -- refreshTrackers: the four states, never 0 --------------------------------- */

test("counted / unreadable / unsupported are recorded per tracker, and `not-fetched` is what backlog() says before any refresh", async () => {
  const stateDir = tmp("tracker-state-");
  const root = delegatingTree({ a: ISSUES, b: "https://github.com/other/repo/issues", c: "https://github.com/users/x/projects/3" });
  try {
    const { gh } = recordingGh({ "o/r": ok([issue(1), issue(2)]), "other/repo": { status: 4, stdout: "", stderr: "gh auth login required" } });
    const delegated = delegatedOf(root, { a: ISSUES, b: "https://github.com/other/repo/issues", c: "https://github.com/users/x/projects/3" });

    // BEFORE any refresh: nothing is "0 open" -- every GitHub tracker is not-fetched.
    const before = backlog({ searchRoots: [root], stateDir });
    const st0 = Object.fromEntries(before.totals.trackers.entries.map((e) => [path.basename(path.dirname(e.file)), e]));
    assert.equal(st0.a.status, "not-fetched");
    assert.equal(st0.a.open, undefined, "not-fetched carries no count at all");
    assert.match(st0.a.reason, /no tracker cache yet/);
    assert.equal(st0.c.status, "unsupported");
    assert.equal(before.totals.trackers.cache.present, false);

    const r = await refreshTrackers({ delegated, gh, stateDir });
    assert.equal(r.wrote, true);
    assert.deepEqual([r.fetched, r.failed, r.unsupported, r.ok], [1, 1, 1, false]);

    const after = backlog({ searchRoots: [root], stateDir });
    const st = Object.fromEntries(after.totals.trackers.entries.map((e) => [path.basename(path.dirname(e.file)), e]));
    assert.deepEqual([st.a.status, st.a.open], ["counted", 2]);
    assert.equal(st.b.status, "unreadable");
    assert.match(st.b.reason, /gh exited 4: gh auth login required/);
    assert.equal(st.b.open, undefined, "an unreadable tracker has no count, so it cannot read as 0");
    assert.equal(st.c.status, "unsupported");
    assert.match(st.c.reason, /not a GitHub issues URL/);
    assert.equal(after.ranked.filter((i) => i.kind === "github").length, 2);
  } finally { done(stateDir, root); }
});

test("a gh that never answers is killed: the tracker reads `unreadable: timed out`, and the refresh returns long before the child would have", async () => {
  const stateDir = tmp("tracker-state-");
  const dir = tmp("tracker-gh-");
  try {
    // exec: the shell becomes `sleep`, so the SIGKILL reaches the process that holds the pipe. 60 s is the SIGNAL:
    // a held bound costs well under a second, a broken one costs a minute (G53 -- widen the signal, not the budget).
    const slow = scriptGh(dir, "exec sleep 60");
    const t0 = Date.now();
    const r = await refreshTrackers({ delegated: [{ file: "f", delegatedTo: ISSUES }], gh: slow.bin, stateDir, perCallMs: 1200, deadlineMs: 20000 });
    const took = Date.now() - t0;
    assert.ok(took < 15000, `the refresh must not wait out the child (took ${took} ms)`);
    assert.equal(r.failed, 1);
    const c = readTrackerCache({ stateDir });
    const e = c.entries[keyForDestination(ISSUES).key];
    assert.equal(e.status, "unreadable");
    assert.match(e.reason, /^timed out after /);
    assert.ok(slow.calls().length <= 1, "one gh call, not a retry loop");
  } finally { done(stateDir, dir); }
});

test("the TOTAL deadline bounds the whole refresh: a tracker not reached is `not attempted`, and its previous rows stay (stale)", async () => {
  const stateDir = tmp("tracker-state-");
  const dir = tmp("tracker-gh-");
  try {
    const delegated = [{ file: "a", delegatedTo: "https://github.com/o/one/issues" }, { file: "b", delegatedTo: "https://github.com/o/two/issues" }];
    // Seed the cache with a good read of both, then break the network.
    await refreshTrackers({ delegated, stateDir, gh: recordingGh({ "o/one": ok([issue(1)]), "o/two": ok([issue(2)]) }).gh });
    const slow = scriptGh(dir, "exec sleep 60");
    const t0 = Date.now();
    // parallel 1 + deadline 500 ms: the first call burns the budget, the second never starts.
    const r = await refreshTrackers({ delegated, gh: slow.bin, stateDir, parallel: 1, perCallMs: 60000, deadlineMs: 1200 });
    assert.ok(Date.now() - t0 < 15000);
    assert.equal(r.deadlineHit, true);
    assert.equal(r.failed + r.skipped, 2);
    assert.equal(r.skipped, 1);
    // `skipped` above is the signal. The script's own log is a corroboration only: macOS can take several hundred ms to
    // exec a script it has just seen written, so the first call may be killed before it logs anything.
    assert.ok(slow.calls().length <= 1, "the second tracker was not even attempted");
    const c = readTrackerCache({ stateDir });
    for (const e of Object.values(c.entries)) {
      assert.equal(e.status, "unreadable");
      assert.equal(e.stale, true, "a failed read keeps the previous rows, marked stale");
      assert.equal(e.issues.length, 1);
    }
    assert.ok(Object.values(c.entries).some((e) => /not attempted/.test(e.reason)));
  } finally { done(stateDir, dir); }
});

test("pagination: two pages (100 + 30) are one tracker of 130, and the request asks for 100 per page with --paginate", async () => {
  const stateDir = tmp("tracker-state-");
  try {
    const page1 = Array.from({ length: 100 }, (_, i) => issue(i + 1));
    const page2 = Array.from({ length: 30 }, (_, i) => issue(i + 101));
    const { gh, calls } = recordingGh({ "o/r": ok(JSON.stringify(page1) + JSON.stringify(page2)) });
    await refreshTrackers({ delegated: [{ file: "f", delegatedTo: ISSUES }], gh, stateDir });
    assert.equal(calls.length, 1);
    assert.match(calls[0][1], /per_page=100/);
    assert.ok(calls[0].includes("--paginate"));
    const e = readTrackerCache({ stateDir }).entries[keyForDestination(ISSUES).key];
    assert.deepEqual([e.status, e.open, e.issues.length], ["counted", 130, 130]);
  } finally { done(stateDir); }
});

test("pull requests are not issues: the REST list includes them, and they are filtered out of the count and the rows", async () => {
  const stateDir = tmp("tracker-state-");
  try {
    const { gh } = recordingGh({ "o/r": ok([issue(1), issue(2, { pull_request: { url: "x" } }), issue(3)]) });
    await refreshTrackers({ delegated: [{ file: "f", delegatedTo: ISSUES }], gh, stateDir });
    const e = readTrackerCache({ stateDir }).entries[keyForDestination(ISSUES).key];
    assert.equal(e.open, 2);
    assert.deepEqual(e.issues.map((i) => i.number), [1, 3]);
  } finally { done(stateDir); }
});

test("dedupe per (repo, labels): three registers on two trackers run gh twice, and a tracker shared by two registers counts once", async () => {
  const stateDir = tmp("tracker-state-");
  const urls = { a: `${ISSUES}?q=label:project:p`, b: `${ISSUES}?q=label%3Aproject%3Ap`, c: `${ISSUES}?q=label:project:q` };
  const root = delegatingTree(urls);
  try {
    const { gh, calls } = recordingGh({ "o/r": (args) => ok(/project%3Ap(?!\w)/.test(args[1]) ? [issue(1), issue(2), issue(3)] : [issue(4)]) });
    await refreshTrackers({ delegated: delegatedOf(root, urls), gh, stateDir });
    assert.equal(calls.length, 2, "once per unique (repo, filter): a and b share one");
    const bl = backlog({ searchRoots: [root], stateDir });
    const summed = bl.totals.trackers.entries.filter((e) => e.status === "counted" && e.inSum !== false).reduce((n, e) => n + e.open, 0);
    assert.equal(summed, 4, "3 (p, once) + 1 (q); a per-register sum would say 7");
    assert.equal(bl.ranked.filter((i) => i.kind === "github").length, 4, "and the rows are not doubled either");
  } finally { done(stateDir, root); }
});

test("partial failure: a tracker that fails is recorded as such and the others' rows are untouched", async () => {
  const stateDir = tmp("tracker-state-");
  try {
    const delegated = [{ file: "a", delegatedTo: "https://github.com/o/good/issues" }, { file: "b", delegatedTo: "https://github.com/o/bad/issues" }];
    const { gh } = recordingGh({ "o/good": ok([issue(1)]), "o/bad": { status: 1, stdout: "", stderr: "HTTP 500" } });
    const r = await refreshTrackers({ delegated, gh, stateDir });
    assert.deepEqual([r.fetched, r.failed], [1, 1]);
    const c = readTrackerCache({ stateDir }).entries;
    assert.equal(c[keyForDestination("https://github.com/o/good/issues").key].status, "counted");
    const bad = c[keyForDestination("https://github.com/o/bad/issues").key];
    assert.equal(bad.status, "unreadable");
    assert.deepEqual(bad.issues, [], "never read, so no rows to keep -- and no count");
    assert.equal(bad.stale, false);
  } finally { done(stateDir); }
});

test("a failed refresh keeps the previous rows and marks them stale; they come back through backlog() as stale rows, not as 0", async () => {
  const stateDir = tmp("tracker-state-");
  const root = delegatingTree({ a: ISSUES });
  try {
    const delegated = delegatedOf(root, { a: ISSUES });
    await refreshTrackers({ delegated, stateDir, gh: recordingGh({ "o/r": ok([issue(7), issue(8)]) }).gh });
    await refreshTrackers({ delegated, stateDir, gh: recordingGh({ "o/r": { status: 1, stdout: "", stderr: "HTTP 502" } }).gh });
    const bl = backlog({ searchRoots: [root], stateDir });
    const [t] = bl.totals.trackers.entries;
    assert.equal(t.status, "unreadable");
    assert.equal(t.stale, true);
    assert.equal(t.lastOpen, 2);
    assert.equal(t.open, undefined);
    const rows = bl.ranked.filter((i) => i.kind === "github");
    assert.deepEqual(rows.map((r) => [r.id, r.stale]), [["#7", true], ["#8", true]]);
    assert.equal(bl.totals.trackers.stale, 1);
  } finally { done(stateDir, root); }
});

test("the cache is written atomically (tmp + rename): the directory holds only the cache afterwards, and an unwritable directory is reported, not thrown", async () => {
  const stateDir = tmp("tracker-state-");
  try {
    const delegated = [{ file: "f", delegatedTo: ISSUES }];
    const r = await refreshTrackers({ delegated, gh: recordingGh({ "o/r": ok([issue(1)]) }).gh, stateDir });
    assert.deepEqual(readdirSync(stateDir), ["tracker-cache.json"], "no *.tmp left behind");
    assert.equal(JSON.parse(readFileSync(r.path, "utf8")).version, 1);

    const blocker = path.join(stateDir, "a-file");
    writeFileSync(blocker, "x");
    const bad = await refreshTrackers({ delegated, gh: recordingGh({ "o/r": ok([issue(1)]) }).gh, stateDir: path.join(blocker, "sub") });
    assert.equal(bad.wrote, false);
    assert.match(bad.error, /could not write/);
    assert.equal(bad.ok, false);
  } finally { done(stateDir); }
});

test("a corrupt cache is `unreadable cache`, reported with its reason -- not an empty cache, and every tracker is not-fetched rather than 0", () => {
  const stateDir = tmp("tracker-state-");
  const root = delegatingTree({ a: ISSUES });
  try {
    writeFileSync(path.join(stateDir, "tracker-cache.json"), "{ truncated");
    const bl = backlog({ searchRoots: [root], stateDir });
    assert.match(bl.totals.trackers.cache.error, /could not be read/);
    assert.equal(bl.totals.trackers.entries[0].status, "not-fetched");
    assert.match(bl.totals.trackers.entries[0].reason, /could not be read/);
  } finally { done(stateDir, root); }
});

/* -- backlog(): offline, and what it merges ----------------------------------- */

test("backlog() never spawns gh: with a populated cache and a recording gh on PROPAGATE_GH_BIN, the recorder is never called", async () => {
  const stateDir = tmp("tracker-state-");
  const dir = tmp("tracker-gh-");
  const root = delegatingTree({ a: ISSUES });
  const was = process.env.PROPAGATE_GH_BIN;
  try {
    await refreshTrackers({ delegated: delegatedOf(root, { a: ISSUES }), stateDir, gh: recordingGh({ "o/r": ok([issue(1)]) }).gh });
    const spy = scriptGh(dir, "echo '[]'");
    process.env.PROPAGATE_GH_BIN = spy.bin;
    const bl = backlog({ searchRoots: [root], stateDir });
    assert.equal(bl.ranked.filter((i) => i.kind === "github").length, 1, "control: the cache WAS merged");
    assert.deepEqual(spy.calls(), [], "backlog() is offline: doctor, the monitor, digest and the dashboard all call it");
    // The same for an EMPTY cache and for one the cache cannot answer.
    backlog({ searchRoots: [root], stateDir: tmp("tracker-empty-") });
    assert.deepEqual(spy.calls(), []);
  } finally {
    if (was === undefined) delete process.env.PROPAGATE_GH_BIN; else process.env.PROPAGATE_GH_BIN = was;
    done(stateDir, dir, root);
  }
});

test("ranked rows for GitHub issues carry id, repo, url, text, the delegating register, line:null, kind:github and a priority from the label", async () => {
  const stateDir = tmp("tracker-state-");
  const root = delegatingTree({ a: ISSUES });
  try {
    const issues = [
      issue(11, { title: "urgent thing", labels: [{ name: "task" }, { name: "priority:P0" }] }),
      issue(12, { title: "middling", labels: [{ name: "priority:p2" }] }),
      issue(13, { title: "unranked", labels: [{ name: "task" }] }),
      issue(14, { title: "two labels, best wins", labels: [{ name: "priority:P3" }, { name: "priority:P1" }] }),
    ];
    await refreshTrackers({ delegated: delegatedOf(root, { a: ISSUES }), stateDir, gh: recordingGh({ "o/r": ok(issues) }).gh });
    const bl = backlog({ searchRoots: [root], stateDir });
    const rows = bl.ranked.filter((i) => i.kind === "github");
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    assert.deepEqual(by["#11"], {
      id: "#11", repo: "o/r", url: "https://github.com/o/r/issues/11", text: "urgent thing", priority: 0,
      file: path.join(root, "a", "TODOS.md"), line: null, kind: "github", labels: ["task", "priority:P0"],
      sources: [{ file: path.join(root, "a", "TODOS.md"), line: null }],
    });
    assert.deepEqual([by["#12"].priority, by["#13"].priority, by["#14"].priority], [2, null, 1], "label-derived, never invented");
    assert.deepEqual(bl.ranked.map((r) => r.id), ["#11", "#14", "#12", "#13"], "ranked by priority like every other row");
    assert.equal(bl.totals.parsedItems, 0, "the register itself still parses as 0: GitHub rows are not file items");
    assert.equal(priorityFromLabels(["priority:P4", "p1"]), null, "only priority:P0..P3");
  } finally { done(stateDir, root); }
});

test("kind:handover issues stay OUT of ranked and are counted in the handover summary instead", async () => {
  const stateDir = tmp("tracker-state-");
  const root = delegatingTree({ a: ISSUES });
  try {
    const issues = [issue(1), issue(2, { labels: [{ name: "kind:handover" }, { name: "task" }] }), issue(3, { labels: [{ name: "kind:handover" }] })];
    await refreshTrackers({ delegated: delegatedOf(root, { a: ISSUES }), stateDir, gh: recordingGh({ "o/r": ok(issues) }).gh });
    const bl = backlog({ searchRoots: [root], stateDir });
    assert.deepEqual(bl.ranked.filter((i) => i.kind === "github").map((i) => i.id), ["#1"]);
    assert.equal(bl.handovers.github.open, 2);
    assert.equal(bl.totals.trackers.handoverIssues, 2);
    assert.equal(bl.totals.trackers.entries[0].open, 3, "the tracker's own count is every open issue; only the ranked list leaves the briefings out");
  } finally { done(stateDir, root); }
});

test("a bare repo link and a filtered link on one repo overlap: each issue is ONE row, whichever register it is attributed to", async () => {
  const stateDir = tmp("tracker-state-");
  const urls = { bare: ISSUES, filt: `${ISSUES}?q=label:project:p` };
  const root = delegatingTree(urls);
  try {
    const { gh } = recordingGh({ "o/r": (args) => ok(/labels=/.test(args[1]) ? [issue(1)] : [issue(1), issue(2)]) });
    await refreshTrackers({ delegated: delegatedOf(root, urls), stateDir, gh });
    const bl = backlog({ searchRoots: [root], stateDir });
    assert.deepEqual(bl.ranked.filter((i) => i.kind === "github").map((i) => i.id).sort(), ["#1", "#2"]);
    const filt = bl.totals.trackers.entries.find((e) => e.labels);
    assert.equal(filt.inSum, false);
    assert.equal(bl.totals.trackers.openIssues, 2);
  } finally { done(stateDir, root); }
});

test("a GitHub row's brief text leads with its number, and --affects matches it on repo and labels without reading a register file", () => {
  const row = { id: "#5", repo: "o/r", url: "u", text: "do the thing", priority: null, file: "/x/ws/TODOS.md", line: null, kind: "github", labels: ["project:alpha"], sources: [{ file: "/x/ws/TODOS.md", line: null }] };
  const { groups } = groupForBrief([row], { workspaceOf: () => "ws" });
  assert.equal(groups.get("ws")[0].briefText, "#5 do the thing");
  const result = { ranked: [row], totals: {}, handovers: { files: [] } };
  const stats = filterByAffects(result, "alpha", () => { throw new Error("a GitHub row has no body on disk to read"); });
  assert.equal(stats.filedElsewhere, 1, "found by its label, from outside its own register's tree");
  assert.equal(stats.bodylessItems, 0);
});

test("mergeTrackerCache: an issue without a number is its own row, never collapsed into its neighbours", () => {
  const cache = { path: "p", present: true, error: null, writtenAt: null, ageMs: 0, entries: { "o/r|": { status: "counted", issues: [{ title: "a" }, { title: "b" }], fetchedAt: "2026-10-19T00:00:00Z" } } };
  const m = mergeTrackerCache([{ file: "/x/TODOS.md", delegatedTo: ISSUES }], cache);
  assert.equal(m.rows.length, 2);
});

test("mergeTrackerCache: when no tracker was read, openIssues is null — 'nobody answered' never reads as '0 open'", () => {
  // Found by the R4 network-off check (2026-10-19): with every tracker unreadable the summary summed nothing and
  // said 0, which doctor printed as "0 across 0 tracker(s)". A counted tracker still sums normally.
  const unread = { path: "p", present: true, error: null, writtenAt: null, ageMs: 0, entries: { "o/r|": { status: "unreadable", reason: "gh exited 1", issues: [{ number: 1, title: "a" }], stale: true, fetchedAt: "2026-10-19T00:00:00Z" } } };
  assert.equal(mergeTrackerCache([{ file: "/x/TODOS.md", delegatedTo: ISSUES }], unread).summary.openIssues, null);
  const none = { path: "p", present: false, error: null, writtenAt: null, ageMs: null, entries: {} };
  assert.equal(mergeTrackerCache([{ file: "/x/TODOS.md", delegatedTo: ISSUES }], none).summary.openIssues, null, "never fetched is not 0 either");
  const read = { ...unread, entries: { "o/r|": { status: "counted", issues: [{ number: 1, title: "a" }, { number: 2, title: "b" }], fetchedAt: "2026-10-19T00:00:00Z" } } };
  assert.equal(mergeTrackerCache([{ file: "/x/TODOS.md", delegatedTo: ISSUES }], read).summary.openIssues, 2);
  assert.equal(mergeTrackerCache([], none).summary.openIssues, 0, "no delegated register at all is a real 0");
});

test("formatAge words an age the same way for every reader, and says so when there is none", () => {
  assert.equal(formatAge(5_000), "5 s ago");
  assert.equal(formatAge(10 * 60_000), "10 min ago");
  assert.equal(formatAge(2 * 3_600_000), "2 h ago");
  assert.equal(formatAge(3 * 86_400_000), "3 d ago");
  assert.equal(formatAge(null), "unknown age");
});
