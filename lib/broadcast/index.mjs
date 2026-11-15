/**
 * index.mjs — the local broadcast index and the shown record (propagate#267 phase 2, delivery).
 *
 * `$STATE/broadcast/index.json` holds the OPEN children of every open broadcast, so a SessionStart hook can tell a
 * session about them without a network call. `$STATE/broadcast/shown-YYYY-MM.jsonl` records each showing.
 *
 * ONE writer rule: only a FULL read (`refreshIndex`: one GraphQL search over every hub of an owner) replaces the file.
 * A narrower read (`status <n>`, `new --apply`) goes through `mergeParent`, which touches only its own parent and never
 * shrinks the rest (review 1, 2). A failed read writes nothing, so the old index stays.
 *
 * hooks/session-guide.mjs carries a dependency-free copy of `readIndex` (it must not import this module's tree);
 * tests/hooks/session-guide.test.mjs pins the copy to this one.
 */
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { stateDir } from "../core/paths.mjs";

export const SEARCH_FIRST = 50;
export const SUB_FIRST = 100;
const OWNER_RE = /^[A-Za-z0-9_.-]+$/;
const SHOWN_RE = /^shown-(\d{4}-\d{2})\.jsonl$/;

export const broadcastDir = (dir = stateDir()) => path.join(dir, "broadcast");
export const indexPath = (dir = stateDir()) => path.join(broadcastDir(dir), "index.json");
export const shownFileForTs = (ts) => `shown-${String(ts).slice(0, 7)}.jsonl`;

/** The one search. `owner` is derived from the hub's origin, never hard-coded; it is validated before it is spliced in. */
export function searchQuery(owner) {
  if (!OWNER_RE.test(String(owner ?? ""))) throw new Error(`not a GitHub owner: ${JSON.stringify(owner)}`);
  return `query{search(type:ISSUE,query:"is:open label:broadcast user:${owner}",first:${SEARCH_FIRST}){issueCount nodes{... on Issue{number title repository{nameWithOwner} subIssues(first:${SUB_FIRST}){totalCount nodes{number title state repository{nameWithOwner}}}}}}}`;
}

const childOf = (n) => ({ repo: n.repository.nameWithOwner, number: n.number, title: String(n.title ?? ""), state: String(n.state).toLowerCase() === "closed" ? "closed" : "open" });

/**
 * Turn the search data into parents of OPEN children. Throws on a shape it does not recognise: a reader that cannot
 * report failure invents an answer (rule:discernment-checks §6).
 * @returns {{parents: object, truncated: boolean}}
 */
export function normalizeSearch(data) {
  const s = data?.search;
  if (!s || !Array.isArray(s.nodes) || !Number.isInteger(s.issueCount)) throw new Error("the search response has no search.nodes / issueCount");
  let truncated = s.issueCount > SEARCH_FIRST;
  const parents = {};
  for (const n of s.nodes) {
    if (!n || !n.repository?.nameWithOwner || !Number.isInteger(n.number)) continue; // a non-issue node
    const subs = n.subIssues;
    if (!subs || !Array.isArray(subs.nodes)) throw new Error(`${n.repository.nameWithOwner}#${n.number}: no subIssues in the response`);
    if (Number.isInteger(subs.totalCount) && subs.totalCount > SUB_FIRST) truncated = true;
    const children = subs.nodes.filter((c) => c?.repository?.nameWithOwner && Number.isInteger(c.number)).map(childOf).filter((c) => c.state === "open");
    if (children.length) parents[`${n.repository.nameWithOwner}#${n.number}`] = { title: String(n.title ?? ""), children };
  }
  return { parents, truncated };
}

/**
 * ONE GraphQL call, whatever the number of broadcasts. Never writes.
 * @returns {Promise<{ok:true, index:object}|{ok:false, error:string}>}
 */
export async function refreshIndex({ fetcher, owner, now = Date.now() }) {
  const started = new Date(now).toISOString();
  try {
    const { parents, truncated } = normalizeSearch(await fetcher.graphql(searchQuery(owner)));
    return { ok: true, index: { generatedAt: started, readStartedAt: started, truncated, parents } };
  } catch (e) {
    return { ok: false, error: `broadcast index search failed: ${e.message}` };
  }
}

/** Replace one parent's entry and keep the rest. A parent with no open child is removed. Pure. */
export function mergeParent(index, key, entry, now = Date.now()) {
  const base = index ?? { generatedAt: new Date(now).toISOString(), readStartedAt: new Date(now).toISOString(), truncated: false, parents: {} };
  const parents = { ...base.parents };
  const open = (entry?.children ?? []).filter((c) => c.state === "open");
  if (open.length) parents[key] = { title: String(entry.title ?? ""), children: open.map((c) => ({ repo: c.repo, number: c.number, title: String(c.title ?? ""), state: "open" })) };
  else delete parents[key];
  return { ...base, parents };
}

/** null when absent; THROWS when unreadable or malformed (the caller says which, never guesses). */
export function readIndex(dir = stateDir()) {
  let text;
  try {
    text = readFileSync(indexPath(dir), "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
  const m = JSON.parse(text);
  if (!m || typeof m !== "object" || !m.parents || typeof m.parents !== "object" || typeof m.generatedAt !== "string") throw new Error("index.json has no parents object / generatedAt");
  return m;
}

/** Atomic, through a per-process temp file. `prune` (full reads only) also drops shown months with no open child left. */
export function writeIndex(index, dir = stateDir(), { prune = false } = {}) {
  const target = indexPath(dir);
  const tmp = `${target}.${process.pid}.tmp`;
  mkdirSync(path.dirname(target), { recursive: true });
  try {
    writeFileSync(tmp, JSON.stringify(index, null, 2));
    renameSync(tmp, target);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return prune ? pruneShown(dir, index) : [];
}

const childRefs = (index) => new Set(Object.values(index?.parents ?? {}).flatMap((p) => p.children.map((c) => `${c.repo}#${c.number}`.toLowerCase())));

/** Every row of every shown-*.jsonl file; a line that does not parse is counted, not thrown. */
function readShownFiles(dir) {
  const d = broadcastDir(dir);
  let names = [];
  try {
    names = readdirSync(d).filter((f) => SHOWN_RE.test(f)).sort();
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const files = [];
  for (const name of names) {
    const rows = [];
    let malformed = 0;
    for (const line of readFileSync(path.join(d, name), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (r && typeof r.child === "string") rows.push(r);
        else malformed++;
      } catch {
        malformed++;
      }
    }
    files.push({ name, rows, malformed });
  }
  return files;
}

/** Remove the shown months in which no row names a child still open in `index`. Returns the removed file names. */
export function pruneShown(dir, index) {
  const open = childRefs(index);
  const removed = [];
  for (const f of readShownFiles(dir)) {
    if (f.rows.some((r) => open.has(String(r.child).toLowerCase()))) continue;
    rmSync(path.join(broadcastDir(dir), f.name), { force: true });
    removed.push(f.name);
  }
  return removed;
}

/**
 * Fold every month: per child, how many showings, in how many CONTEXTS, and how many of those contexts were attended.
 * A context is a session id: compact keeps the id, while clear and fork make a new one, so this is not a count of
 * sessions and never says so.
 * @returns {{byChild: Map<string, {showings:number, contexts:number, attended:number, lastTs:string|null}>, malformed:number, files:number}}
 */
export function foldShown(dir = stateDir()) {
  const acc = new Map();
  let malformed = 0;
  const files = readShownFiles(dir);
  for (const f of files) {
    malformed += f.malformed;
    for (const r of f.rows) {
      const k = String(r.child).toLowerCase();
      const a = acc.get(k) ?? { showings: 0, ctx: new Set(), att: new Set(), lastTs: null };
      a.showings++;
      const sid = String(r.session_id ?? "");
      a.ctx.add(sid);
      if (r.attended === true) a.att.add(sid);
      if (typeof r.ts === "string" && (!a.lastTs || r.ts > a.lastTs)) a.lastTs = r.ts;
      acc.set(k, a);
    }
  }
  const byChild = new Map([...acc].map(([k, a]) => [k, { showings: a.showings, contexts: a.ctx.size, attended: a.att.size, lastTs: a.lastTs }]));
  return { byChild, malformed, files: files.length };
}

/** Append rows in ONE write (O_APPEND keeps a whole write intact). The month comes from the row's UTC ts. */
export function appendShown(dir, rows) {
  if (!rows.length) return null;
  const f = path.join(broadcastDir(dir), shownFileForTs(rows[0].ts));
  mkdirSync(path.dirname(f), { recursive: true });
  appendFileSync(f, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return f;
}
