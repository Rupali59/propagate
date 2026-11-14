/**
 * new.mjs — `propagate broadcast new` (phase 1, propagate#267): plan, then apply.
 *
 * `planBroadcast` makes READS only (repo view, issue list). `applyBroadcast` is the only function that writes, and
 * the CLI reaches it solely behind --apply. Order: parent, children, sub-issue links, board fields, read-back.
 *
 * A public target goes through the identity-map scrub and the forbidden-literal gate (the same ones `tasks export`
 * uses); a body that still matches is HELD and named, never created.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { FORBIDDEN } from "../core/public-forbidden.mjs";
import { normalizeMap, scrub, scrubEntries } from "../core/public-scrub.mjs";
import { firstLine, makeGh, readJson } from "./gh.mjs";
import { childKeyOf, defaultModel, keyComment, keyOfBody, parentBody, parentKeyOf, slugOf } from "./model.mjs";

export const PARENT_LABELS = Object.freeze(["broadcast", "kind:handover"]);
const ISSUE_URL_RE = /https:\/\/github\.com\/([^\s/]+\/[^\s/]+)\/issues\/(\d+)/;

function loadIdentity(stateDirPath) {
  const p = path.join(stateDirPath ?? "", "identity-map.json");
  if (!stateDirPath || !existsSync(p)) return { error: `no identity map at ${p}` };
  try {
    const entries = scrubEntries(normalizeMap(JSON.parse(readFileSync(p, "utf8"))).names);
    return entries.length ? { entries } : { error: `identity map at ${p} is empty: nothing would be scrubbed` };
  } catch (err) {
    return { error: `identity map unreadable: ${err.message}` };
  }
}

export function forbiddenHits(text) {
  const hits = [];
  for (const p of FORBIDDEN) {
    p.re.lastIndex = 0;
    if (p.re.test(text)) hits.push(p.label);
    p.re.lastIndex = 0;
  }
  return hits;
}

/** Scrub and gate one issue for `info.isPublic`. Returns {title, body, held: string|null}. */
function gate({ title, body }, isPublic, getIdentity) {
  if (!isPublic) return { title, body, held: null };
  const id = getIdentity();
  if (id.error) return { title, body, held: `no-identity-map: ${id.error}` };
  const t = scrub(title, id.entries);
  const b = scrub(body, id.entries);
  const hits = forbiddenHits(`${t}\n${b}`);
  return { title: t, body: b, held: hits.length ? `forbidden: still matches after scrub: ${hits.join(", ")}` : null };
}

/**
 * @param {object} o
 * @param {string} o.title @param {string} o.goal @param {string} o.hub owner/repo
 * @param {{repo:string, body:string}[]} o.children @param {string} [o.stateDirPath]
 * @param {Function|string} [o.gh]
 * @returns {{ok:false,error:string}|{ok:true, slug, goal, parent, children}}
 */
export function planBroadcast({ title, goal, hub, children, stateDirPath, gh }) {
  const run = makeGh(gh);
  const slug = slugOf(title);
  if (!slug) return { ok: false, error: "the title has no letters or digits to build a key from" };
  let identity;
  const getIdentity = () => (identity ??= loadIdentity(stateDirPath));

  const repoCache = new Map();
  const repoInfo = (repo) => {
    if (repoCache.has(repo)) return repoCache.get(repo);
    const r = readJson(run, ["repo", "view", repo, "--json", "visibility,hasIssuesEnabled,owner"], `gh repo view ${repo}`);
    let info;
    if (!r.ok) info = { error: r.error };
    else {
      const vis = typeof r.json?.visibility === "string" ? r.json.visibility.toUpperCase() : null;
      info = !vis ? { error: `gh repo view ${repo}: output lacked visibility` } : { isPublic: vis === "PUBLIC", issues: r.json.hasIssuesEnabled !== false };
    }
    repoCache.set(repo, info);
    return info;
  };
  const keyCache = new Map();
  const findKey = (repo, key) => {
    if (!keyCache.has(repo)) {
      const r = readJson(run, ["issue", "list", "-R", repo, "--state", "all", "--limit", "1000", "--json", "number,url,body"], `gh issue list ${repo}`);
      if (!r.ok) keyCache.set(repo, { error: r.error });
      else if (!Array.isArray(r.json)) keyCache.set(repo, { error: `gh issue list ${repo}: output was not a list` });
      else if (r.json.length >= 1000) keyCache.set(repo, { error: `gh issue list ${repo} returned 1000 issues: the key match could be truncated, so nothing is created` });
      else {
        const m = new Map();
        for (const i of r.json) {
          const k = keyOfBody(i.body);
          if (k) m.set(k, { number: i.number, url: i.url });
        }
        keyCache.set(repo, { keys: m });
      }
    }
    const c = keyCache.get(repo);
    return c.error ? { error: c.error } : { existing: c.keys.get(key) ?? null };
  };

  const plan = { ok: true, slug, goal, hub, parent: null, children: [] };
  for (const c of children) {
    const info = repoInfo(c.repo);
    if (info.error) return { ok: false, error: info.error };
    const key = childKeyOf(slug, c.repo);
    const title_ = c.title;
    const g = gate({ title: title_, body: `${c.body}\n\n${keyComment(key)}` }, info.isPublic, getIdentity);
    const f = findKey(c.repo, key);
    if (f.error) return { ok: false, error: f.error };
    const held = g.held ?? (info.issues ? null : `issues-disabled: ${c.repo} has Issues disabled`);
    plan.children.push({ repo: c.repo, goal: c.goal ?? goal, key, title: g.title, body: g.body, existing: f.existing, held, model: defaultModel(null, null, c.body), isPublic: info.isPublic });
  }

  const hubInfo = repoInfo(hub);
  if (hubInfo.error) return { ok: false, error: hubInfo.error };
  const listed = plan.children.filter((c) => !c.held).map((c) => c.repo);
  const pg = gate({ title, body: parentBody({ parentTitle: title, goal, repos: listed, slug }) }, hubInfo.isPublic, getIdentity);
  const pf = findKey(hub, parentKeyOf(slug));
  if (pf.error) return { ok: false, error: pf.error };
  plan.parent = { repo: hub, key: parentKeyOf(slug), title: pg.title, body: pg.body, labels: [...PARENT_LABELS], existing: pf.existing, held: pg.held };
  return plan;
}

// ─────────────────────────────────────────────────────────────────────────────
// apply
// ─────────────────────────────────────────────────────────────────────────────

function createIssue(run, repo, title, body, labels) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "propagate-broadcast-"));
  try {
    const bodyFile = path.join(dir, "body.md");
    writeFileSync(bodyFile, body);
    const args = ["issue", "create", "-R", repo, "--title", title, "--body-file", bodyFile];
    if (labels?.length) args.push("--label", labels.join(","));
    const r = run(args);
    const m = r.status === 0 ? ISSUE_URL_RE.exec(r.stdout) : null;
    if (!m) return { error: `issue create in ${repo} failed: ${firstLine(r.stderr || r.stdout) || "no URL in output"}` };
    return { number: Number(m[2]), url: m[0] };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The numeric id sub_issues needs (not the node id, not the number). */
function numericId(run, repo, number) {
  const r = readJson(run, ["api", `repos/${repo}/issues/${number}`], `gh api ${repo}#${number}`);
  if (!r.ok) return { error: r.error };
  return Number.isInteger(r.json?.id) ? { id: r.json.id } : { error: `${repo}#${number}: response had no numeric id` };
}

function readSubIssues(run, hub, parentNumber) {
  const r = readJson(run, ["api", `repos/${hub}/issues/${parentNumber}/sub_issues?per_page=100`], `read back sub_issues of ${hub}#${parentNumber}`);
  if (!r.ok) return { error: r.error };
  return Array.isArray(r.json) ? { subs: r.json } : { error: `read back sub_issues of ${hub}#${parentNumber}: output was not a list` };
}

function ensureLabels(run, repo, labels) {
  const ll = readJson(run, ["label", "list", "-R", repo, "--limit", "200", "--json", "name"], `gh label list ${repo}`);
  if (!ll.ok) return ll.error;
  const have = new Set((ll.json ?? []).map((l) => String(l.name).toLowerCase()));
  for (const l of labels) {
    if (have.has(l.toLowerCase())) continue;
    const r = run(["label", "create", l, "-R", repo]);
    if (r.status !== 0 && !/already exists/i.test(`${r.stderr}${r.stdout}`)) return `label create ${l}: ${firstLine(r.stderr || r.stdout)}`;
  }
  return null;
}

/**
 * Put one child on its repo's board if the repo has exactly one open board. Returns {status, note?}.
 * Zero or several boards: named and skipped, never guessed.
 */
function placeOnBoard(run, child, url, goal) {
  const [owner, name] = child.repo.split("/");
  const q = `query{repository(owner:"${owner}",name:"${name}"){projectsV2(first:20){nodes{id number closed owner{... on User{login}... on Organization{login}}}}}}`;
  const pr = readJson(run, ["api", "graphql", "-f", `query=${q}`], `board lookup for ${child.repo}`);
  if (!pr.ok) return { status: "error", note: pr.error };
  const open = (pr.json?.data?.repository?.projectsV2?.nodes ?? []).filter((n) => n && !n.closed);
  if (open.length !== 1) return { status: "skipped", note: `${child.repo} has ${open.length} open board(s) (${open.map((b) => `#${b.number}`).join(", ") || "none"}): not placed, not guessed` };
  const board = open[0];
  const owner_ = board.owner?.login ?? owner;
  const add = readJson(run, ["project", "item-add", String(board.number), "--owner", owner_, "--url", url, "--format", "json"], `project item-add #${board.number}`);
  if (!add.ok) return { status: "error", note: add.error };
  const itemId = add.json?.id;
  if (!itemId) return { status: "error", note: `project item-add #${board.number}: no item id in output` };
  const fl = readJson(run, ["project", "field-list", String(board.number), "--owner", owner_, "--format", "json"], `project field-list #${board.number}`);
  if (!fl.ok) return { status: "error", note: fl.error };
  const fields = fl.json?.fields ?? [];
  const notes = [];
  for (const [fname, value] of [["Goal", goal], ["Priority", "P1"], ["Model", child.model]]) {
    const f = fields.find((x) => String(x.name).toLowerCase() === fname.toLowerCase());
    if (!f) { notes.push(`no ${fname} field`); continue; }
    let args;
    if (Array.isArray(f.options)) {
      const o = f.options.find((x) => String(x.name).toLowerCase() === String(value).toLowerCase());
      if (!o) { notes.push(`${fname} has no option ${value}`); continue; }
      args = ["--single-select-option-id", o.id];
    } else args = ["--text", String(value)];
    const r = run(["project", "item-edit", "--id", itemId, "--project-id", board.id, "--field-id", f.id, ...args]);
    if (r.status !== 0) notes.push(`${fname}: ${firstLine(r.stderr || r.stdout)}`);
  }
  return { status: notes.length ? "partial" : "placed", note: `board #${board.number}${notes.length ? `; ${notes.join("; ")}` : ""}` };
}

/**
 * @returns {{ok:boolean, parent, children:object[], problems:string[]}} ok is false on any problem, including a
 * read-back that lacks a child.
 */
export function applyBroadcast(plan, { gh } = {}) {
  const run = makeGh(gh);
  const problems = [];
  const out = { parent: null, children: [], problems };
  const fail = () => ({ ok: false, ...out });

  if (plan.parent.held) {
    problems.push(`parent HELD: ${plan.parent.held}`);
    return fail();
  }
  const lerr = ensureLabels(run, plan.hub, plan.parent.labels);
  if (lerr) {
    problems.push(lerr);
    return fail();
  }

  // 1. parent
  let pNum;
  let pUrl;
  if (plan.parent.existing) {
    ({ number: pNum, url: pUrl } = plan.parent.existing);
    out.parent = { number: pNum, url: pUrl, created: false };
  } else {
    const c = createIssue(run, plan.hub, plan.parent.title, plan.parent.body, plan.parent.labels);
    if (c.error) {
      problems.push(c.error);
      return fail();
    }
    pNum = c.number;
    pUrl = c.url;
    out.parent = { number: pNum, url: pUrl, created: true };
  }

  // 2. children
  const live = [];
  for (const ch of plan.children) {
    const rec = { repo: ch.repo, held: ch.held, created: false, number: null, url: null, id: null, linked: false, board: null };
    out.children.push(rec);
    if (ch.held) {
      problems.push(`${ch.repo}: HELD ${ch.held}`);
      continue;
    }
    if (ch.existing) {
      rec.number = ch.existing.number;
      rec.url = ch.existing.url;
    } else {
      const c = createIssue(run, ch.repo, ch.title, ch.body);
      if (c.error) {
        problems.push(c.error);
        continue;
      }
      rec.number = c.number;
      rec.url = c.url;
      rec.created = true;
    }
    const idr = numericId(run, ch.repo, rec.number);
    if (idr.error) {
      problems.push(idr.error);
      continue;
    }
    rec.id = idr.id;
    live.push({ ch, rec });
  }

  // 3. link as sub-issues. A failed POST is not assumed to mean "not linked": re-read.
  for (const { ch, rec } of live) {
    const r = run(["api", "-X", "POST", `repos/${plan.hub}/issues/${pNum}/sub_issues`, "-F", `sub_issue_id=${rec.id}`]);
    if (r.status !== 0) {
      const re = readSubIssues(run, plan.hub, pNum);
      if (re.error || !re.subs.some((s) => s.id === rec.id)) problems.push(`link ${ch.repo}#${rec.number}: ${firstLine(r.stderr || r.stdout)}`);
    }
  }

  // 4. board placement
  for (const { ch, rec } of live) {
    const b = placeOnBoard(run, ch, rec.url, ch.goal ?? plan.goal);
    rec.board = b;
    if (b.status === "error") problems.push(`board ${ch.repo}#${rec.number}: ${b.note}`);
  }

  // 5. read back: the parent's sub_issues must hold every child that was created or reused.
  const re = readSubIssues(run, plan.hub, pNum);
  if (re.error) problems.push(re.error);
  else {
    const have = new Set(re.subs.map((s) => s.id));
    for (const { ch, rec } of live) {
      rec.linked = have.has(rec.id);
      if (!rec.linked) problems.push(`read-back: ${ch.repo}#${rec.number} is not in ${plan.hub}#${pNum}'s sub_issues`);
    }
  }
  return { ok: problems.length === 0, ...out };
}
