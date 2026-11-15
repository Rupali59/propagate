/**
 * broadcast-index.test.mjs — the local broadcast index and the shown record (propagate#267 phase 2).
 * Literal fixtures, placeholder repo names, tmpdir state; the GraphQL fetcher is a stub and no gh runs.
 */
// @size small — pure, in-memory
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { appendShown, foldShown, indexPath, mergeParent, readIndex, refreshIndex, searchQuery, writeIndex } from "../../lib/broadcast/index.mjs";
import { broadcastCmd } from "../../cli/broadcast.mjs";

const NOW = Date.parse("2026-11-15T10:00:00Z");
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "bidx-"));
const sub = (repo, number, state = "OPEN", title = `child ${number}`) => ({ number, title, state, repository: { nameWithOwner: repo } });
const parent = (hub, number, title, subs, totalCount = subs.length) => ({ number, title, repository: { nameWithOwner: hub }, subIssues: { totalCount, nodes: subs } });
const search = (nodes, issueCount = nodes.length) => ({ search: { issueCount, nodes } });
/** A fetcher that records every query it is given. */
const fetcherOf = (data) => {
  const f = { queries: [], graphql: async (q) => { f.queries.push(q); if (data instanceof Error) throw data; return data; } };
  return f;
};

test("one stubbed GraphQL search over two hubs gives both parents, with ONE call and open children only", async () => {
  const f = fetcherOf(search([
    parent("acme/hub-a", 7, "Retro", [sub("acme/alpha", 11), sub("acme/beta", 12), sub("acme/gamma", 13, "CLOSED")]),
    parent("acme/hub-b", 3, "Audit", [sub("acme/delta", 21)]),
  ]));
  const r = await refreshIndex({ fetcher: f, owner: "acme", now: NOW });
  assert.equal(r.ok, true);
  assert.equal(f.queries.length, 1, "one call, whatever the number of broadcasts");
  assert.match(f.queries[0], /is:issue is:open label:broadcast user:acme/, "is:issue, so pull requests do not eat first:50");
  assert.deepEqual(Object.keys(r.index.parents).sort(), ["acme/hub-a#7", "acme/hub-b#3"]);
  assert.deepEqual(r.index.parents["acme/hub-a#7"].children.map((c) => c.repo), ["acme/alpha", "acme/beta"], "the closed child is not in the index");
  assert.equal(r.index.truncated, false);
  assert.equal(r.index.readStartedAt, "2026-11-15T10:00:00.000Z");
});

test("more than 100 sub-issues, or a search past 50 results, sets truncated: true", async () => {
  const big = await refreshIndex({ fetcher: fetcherOf(search([parent("acme/hub-a", 7, "Retro", [sub("acme/alpha", 1)], 101)])), owner: "acme", now: NOW });
  assert.equal(big.index.truncated, true);
  const wide = await refreshIndex({ fetcher: fetcherOf(search([parent("acme/hub-a", 7, "Retro", [sub("acme/alpha", 1)])], 51)), owner: "acme", now: NOW });
  assert.equal(wide.index.truncated, true);
});

test("a failed or unrecognised search is ok:false and writes nothing, so the old index stays", async () => {
  const dir = tmp();
  const old = { generatedAt: "2026-11-14T00:00:00.000Z", readStartedAt: "2026-11-14T00:00:00.000Z", truncated: false, parents: { "acme/hub-a#7": { title: "Retro", children: [{ repo: "acme/alpha", number: 11, title: "c", state: "open" }] } } };
  writeIndex(old, dir);
  const before = readFileSync(indexPath(dir), "utf8");
  for (const f of [fetcherOf(new Error("HTTP 502")), fetcherOf({ viewer: {} })]) {
    const r = await refreshIndex({ fetcher: f, owner: "acme", now: NOW });
    assert.equal(r.ok, false);
    assert.match(r.error, /search failed/);
  }
  assert.equal(readFileSync(indexPath(dir), "utf8"), before);
  assert.deepEqual(readdirSync(path.dirname(indexPath(dir))), ["index.json"], "no temp file is left behind");
});

test("an owner that is not a GitHub login is refused before it is spliced into the query", () => {
  assert.throws(() => searchQuery('acme" OR user:other'), /not a GitHub owner/);
});

test("a narrower status <n> merges its parent and never shrinks the index", async () => {
  const dir = tmp();
  const full = (await refreshIndex({ fetcher: fetcherOf(search([parent("acme/hub-a", 7, "Retro", [sub("acme/alpha", 11), sub("acme/beta", 12)]), parent("acme/hub-b", 3, "Audit", [sub("acme/delta", 21)])])), owner: "acme", now: NOW })).index;
  writeIndex(full, dir);
  // status 7 read only hub-a#7, and now sees one child closed.
  const merged = mergeParent(readIndex(dir), "acme/hub-a#7", { title: "Retro", children: [{ repo: "acme/alpha", number: 11, title: "c", state: "open" }, { repo: "acme/beta", number: 12, title: "c", state: "closed" }] }, NOW);
  assert.deepEqual(merged.parents["acme/hub-a#7"].children.map((c) => c.number), [11]);
  assert.deepEqual(merged.parents["acme/hub-b#3"], full.parents["acme/hub-b#3"], "the other hub's parent is untouched");
  assert.equal(merged.generatedAt, full.generatedAt, "a merge does not make the rest of the index look fresh");
  // all children closed: the parent leaves the index, the rest stays
  const gone = mergeParent(merged, "acme/hub-a#7", { title: "Retro", children: [] }, NOW);
  assert.deepEqual(Object.keys(gone.parents), ["acme/hub-b#3"]);
});

test("the CLI: status <n> and new --apply merge into the index; status with no number replaces it from ONE search", async () => {
  const dir = tmp();
  const full = (await refreshIndex({ fetcher: fetcherOf(search([parent("acme/hub-b", 3, "Audit", [sub("acme/delta", 21)])])), owner: "acme", now: NOW })).index;
  writeIndex(full, dir);
  const io = { log() {}, error() {} };
  const gh = (args) => {
    const route = args.find((x) => x.startsWith("repos/")) ?? "";
    if (/\/issues\/7\/sub_issues/.test(route)) return { status: 0, stdout: JSON.stringify([{ id: 1, number: 11, title: "child 11", state: "open", created_at: "2026-11-10T00:00:00Z", repository_url: "https://api.github.com/repos/acme/alpha" }]), stderr: "" };
    if (/\/issues\/7$/.test(route)) return { status: 0, stdout: JSON.stringify({ number: 7, title: "Retro", body: "", state: "open", labels: [{ name: "broadcast" }] }), stderr: "" };
    return { status: 1, stdout: "", stderr: `unexpected ${args.join(" ")}` };
  };
  const never = { graphql: async () => { throw new Error("status <n> must not search"); }, rateLimit: () => ({}) };
  assert.equal(await broadcastCmd(["status", "7", "--hub", "acme/hub-a"], { io, gh, stateDirPath: dir, fetcher: never, now: NOW }), 0);
  const after = readIndex(dir);
  assert.deepEqual(Object.keys(after.parents).sort(), ["acme/hub-a#7", "acme/hub-b#3"], "merged: hub-b's parent is still there");
  // no number: a full search replaces the file
  const f = fetcherOf(search([parent("acme/hub-c", 9, "Other", [sub("acme/eps", 5)])]));
  const list = (args) => (args[0] === "issue" ? { status: 0, stdout: "[]", stderr: "" } : gh(args));
  assert.equal(await broadcastCmd(["status", "--hub", "acme/hub-a"], { io, gh: list, stateDirPath: dir, fetcher: f, broadcastOwner: "acme", now: NOW }), 0);
  assert.equal(f.queries.length, 1);
  assert.deepEqual(Object.keys(readIndex(dir).parents), ["acme/hub-c#9"], "only the full search replaces");
});

test("pruning: a shown month with no open child left in the index is removed when a FULL read writes it", () => {
  const dir = tmp();
  const row = (ts, child) => ({ ts, session_id: "s1", source: "startup", repo: child.split("#")[0], child, listed: true, attended: true, entrypoint: "cli" });
  appendShown(dir, [row("2026-09-30T10:00:00.000Z", "acme/old#1")]);
  appendShown(dir, [row("2026-10-31T23:00:00.000Z", "acme/alpha#11")]);
  const idx = { generatedAt: "2026-11-15T10:00:00.000Z", readStartedAt: "2026-11-15T10:00:00.000Z", truncated: false, parents: { "acme/hub-a#7": { title: "R", children: [{ repo: "acme/alpha", number: 11, title: "c", state: "open" }] } } };
  assert.deepEqual(writeIndex(idx, dir), [], "a merge write never prunes");
  assert.deepEqual(writeIndex(idx, dir, { prune: true }), ["shown-2026-09.jsonl"]);
  assert.deepEqual(readdirSync(path.dirname(indexPath(dir))).sort(), ["index.json", "shown-2026-10.jsonl"]);
});

test("foldShown: startup then compact is 2 showings in 1 context; clear with a new id is 2 contexts; nothing shown is 0", () => {
  const dir = tmp();
  const row = (sid, source, attended = true, ts = "2026-11-15T10:00:00.000Z") => ({ ts, session_id: sid, source, repo: "acme/alpha", child: "acme/alpha#11", listed: true, attended, entrypoint: "cli" });
  appendShown(dir, [row("s1", "startup")]);
  appendShown(dir, [row("s1", "compact")]);
  let f = foldShown(dir).byChild.get("acme/alpha#11");
  assert.deepEqual({ showings: f.showings, contexts: f.contexts, attended: f.attended }, { showings: 2, contexts: 1, attended: 1 });
  appendShown(dir, [row("s2", "clear", false)]);
  f = foldShown(dir).byChild.get("acme/alpha#11");
  assert.deepEqual({ showings: f.showings, contexts: f.contexts, attended: f.attended }, { showings: 3, contexts: 2, attended: 1 }, "clear makes a new id: a second context");
  assert.equal(foldShown(tmp()).byChild.size, 0, "nothing shown gives 0 rows");
});

test("foldShown reads EVERY month, and skips a line it cannot parse", () => {
  const dir = tmp();
  const row = (ts, sid) => ({ ts, session_id: sid, source: "startup", repo: "acme/alpha", child: "acme/alpha#11", listed: true, attended: true, entrypoint: "cli" });
  appendShown(dir, [row("2026-10-31T23:59:00.000Z", "s1")]);
  appendShown(dir, [row("2026-11-01T00:01:00.000Z", "s2")]);
  writeFileSync(path.join(path.dirname(indexPath(dir)), "shown-2026-11.jsonl"), "garbage\n", { flag: "a" });
  const r = foldShown(dir);
  assert.equal(r.byChild.get("acme/alpha#11").contexts, 2, "a child shown on 31 Oct is still shown on 1 Nov");
  assert.equal(r.files, 2);
  assert.equal(r.malformed, 1);
});

test("appendShown writes all rows in one append and names the file from the row's UTC month", () => {
  const dir = tmp();
  const f = appendShown(dir, [{ ts: "2026-12-01T00:00:00.000Z", child: "a/b#1" }, { ts: "2026-12-01T00:00:00.000Z", child: "a/b#2" }]);
  assert.equal(path.basename(f), "shown-2026-12.jsonl");
  assert.equal(readFileSync(f, "utf8").trim().split("\n").length, 2);
  assert.equal(appendShown(dir, []), null);
  assert.ok(!existsSync(path.join(path.dirname(indexPath(dir)), "shown-2027-01.jsonl")));
  mkdirSync(path.join(dir, "x"), { recursive: true });
});

test("mixed-case keys are one parent: acme/hub#7 then Acme/Hub#7 merges, never duplicates", () => {
  const c = (n) => ({ repo: "acme/alpha", number: n, title: "c", state: "open" });
  const a = mergeParent(null, "acme/hub#7", { title: "R", children: [c(1)] }, NOW);
  const b = mergeParent(a, "Acme/Hub#7", { title: "R", children: [c(1), c(2)] }, NOW);
  assert.deepEqual(Object.keys(b.parents), ["acme/hub#7"]);
  assert.deepEqual(b.parents["acme/hub#7"].children.map((x) => x.number), [1, 2]);
});

test("goal rides the SAME single search: the board's Goal per child, null when none, kept across a merge that does not know it", async () => {
  const withGoal = (n, name) => ({ ...sub("acme/alpha", n), projectItems: { nodes: name ? [{ fieldValueByName: { name } }, { fieldValueByName: null }] : [{ fieldValueByName: null }] } });
  const f = fetcherOf(search([parent("acme/hub-a", 7, "Retro", [withGoal(11, "G3"), withGoal(12, null)])]));
  const r = await refreshIndex({ fetcher: f, owner: "acme", now: NOW });
  assert.equal(f.queries.length, 1);
  assert.match(f.queries[0], /fieldValueByName\(name:"Goal"\)/, "the Goal field is asked in the one query");
  assert.deepEqual(r.index.parents["acme/hub-a#7"].children.map((c) => c.goal), ["G3", null]);
  // a REST-style merge (no goal in the read) keeps what the index knew
  const merged = mergeParent(r.index, "acme/hub-a#7", { title: "Retro", children: [{ repo: "acme/alpha", number: 11, title: "c", state: "open" }, { repo: "acme/alpha", number: 12, title: "c", state: "open" }] }, NOW);
  assert.deepEqual(merged.parents["acme/hub-a#7"].children.map((c) => c.goal), ["G3", null]);
});

test("status <n> merges only an open issue labelled broadcast; otherwise it says why and leaves the index alone", async () => {
  for (const [issue, why] of [[{ state: "closed", labels: [{ name: "broadcast" }] }, /not open/], [{ state: "open", labels: [{ name: "bug" }] }, /no "broadcast" label/]]) {
    const dir = tmp();
    const io = { out: [], err: [], log() {}, error(m) { this.err.push(m); } };
    const gh = (args) => {
      const route = args.find((x) => x.startsWith("repos/")) ?? "";
      if (/sub_issues/.test(route)) return { status: 0, stdout: JSON.stringify([{ id: 1, number: 11, title: "c", state: "open", created_at: "2026-11-10T00:00:00Z", repository_url: "https://api.github.com/repos/acme/alpha" }]), stderr: "" };
      return { status: 0, stdout: JSON.stringify({ number: 7, title: "Not a broadcast", body: "", ...issue }), stderr: "" };
    };
    assert.equal(await broadcastCmd(["status", "7", "--hub", "acme/hub-a"], { io, gh, stateDirPath: dir, fetcher: { graphql: async () => { throw new Error("no"); } }, now: NOW }), 0);
    assert.equal(readIndex(dir), null, "nothing merged");
    assert.match(io.err.join("\n"), why);
  }
});
