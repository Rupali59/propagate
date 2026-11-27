/**
 * lib/report/waiting.mjs — `propagate waiting` (#411): every merge, approval and decision that needs the maintainer,
 * in one list. Each row is {kind, what, url, recommendation, answer}, `answer` one of merge|approve|defer|lane|rater,
 * so the maintainer replies with one word and never reads a source.
 *
 * Sources: open PRs and `needs:`/`needs-` issues of every repo given (derived by the caller from remotes, never
 * hard-coded here), and kb reviews with disagreements nobody has adjudicated yet (#412).
 *
 * "Ready to merge" is NOT GitHub's `mergeable` flag. It is a recorded gate pass on the PR's exact `headRefOid`
 * (`<state>/gates/<sha>.json`, written by `waiting gate-pass --apply`). A pass on an older sha says nothing about the
 * current head, so it never counts.
 *
 * A source that could not be read is returned in `errors` and the CLI exits 2: it never reads as "nothing waiting"
 * (rule:discernment-checks §2). No label suffix is printed: a `needs:<x>` suffix can name a person.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readAgreement } from "../kb/review/agree.mjs";
import { compareRaters } from "../kb/review/disagree.mjs";
import { readJson as ghJson } from "../broadcast/gh.mjs";
import { unread } from "../core/unread.mjs";
import { noEvidenceRows, queueRows, readRuns } from "./test-queue.mjs";

export const ANSWERS = ["merge", "approve", "defer", "lane", "rater"];
/** A label that marks an item as waiting on the maintainer: `needs:x` or `needs-x`. */
export const NEEDS_LABEL = /^needs[:-]./i;
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const PR_FIELDS = "number,title,url,baseRefName,headRefName,headRefOid,mergeable,isDraft,labels";

// ── the gate-pass store ─────────────────────────────────────────────────────

export const gatesDir = (dir) => path.join(dir, "gates");

/** @returns {{ok:true,gate:object}|{ok:true,gate:null}|{ok:false,problem:string}} */
export function readGate(dir, sha) {
  if (!FULL_SHA.test(sha)) return { ok: true, gate: null };
  const file = path.join(gatesDir(dir), `${sha}.json`);
  if (!existsSync(file)) return { ok: true, gate: null };
  try {
    const g = JSON.parse(readFileSync(file, "utf8"));
    if (g?.schema_version !== 1 || g.sha !== sha || typeof g.suite !== "string") throw new Error("not a schema_version 1 gate record for this sha");
    return { ok: true, gate: g };
  } catch (e) {
    const problem = `gates/${sha}.json is not readable (${e.message})`;
    return { ok: false, problem, ...unread(problem) };
  }
}

/**
 * Blind-readers registry (#408): a gate record that does not parse must read as unread, never as "no gate yet".
 * The hostile input writes a junk record for a well-formed sha, so the reader reaches its parse.
 */
export const READER = {
  readGate: {
    hostile: (h) => {
      const sha = "a".repeat(40);
      mkdirSync(gatesDir(h.dir), { recursive: true });
      writeFileSync(path.join(gatesDir(h.dir), `${sha}.json`), "not json {");
      return [h.dir, sha];
    },
  },
};

/**
 * The only write here. `extra` carries the optional evidence fields (#428): run_id, run_tree, cpu_peak, no_run_evidence.
 * The record stays schema_version 1; a record without them (every one written before) still reads.
 * @returns {string} the file written
 */
export function writeGatePass(dir, sha, suite, now = Date.now(), extra = {}) {
  mkdirSync(gatesDir(dir), { recursive: true });
  const file = path.join(gatesDir(dir), `${sha}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ schema_version: 1, sha, suite, passed_at: new Date(now).toISOString(), ...extra }, null, 2)}\n`);
  renameSync(tmp, file);
  return file;
}

export const validGateSha = (sha) => FULL_SHA.test(String(sha ?? ""));

// ── PR rows ─────────────────────────────────────────────────────────────────

const short = (sha) => String(sha ?? "").slice(0, 7);

/** Group PRs of one repo into stacks: a PR whose base is another open PR's head sits above it. Pure. */
export function groupStacks(prs) {
  const byHead = new Map(prs.map((p) => [p.headRefName, p]));
  const kids = new Map();
  for (const p of prs) {
    const parent = byHead.get(p.baseRefName);
    if (parent && parent !== p) kids.set(parent.number, [...(kids.get(parent.number) ?? []), p]);
  }
  const isChild = (p) => byHead.has(p.baseRefName) && byHead.get(p.baseRefName) !== p;
  const walk = (p, seen = new Set()) => {
    if (seen.has(p.number)) return [];
    seen.add(p.number);
    return [p, ...(kids.get(p.number) ?? []).sort((a, b) => a.number - b.number).flatMap((k) => walk(k, seen))];
  };
  return prs.filter((p) => !isChild(p)).sort((a, b) => a.number - b.number).map((root) => walk(root));
}

function prRows(repo, prs, defaultBranch, gateOf) {
  const rows = [];
  const errors = [];
  const gated = (p) => {
    const g = gateOf(p.headRefOid);
    if (!g.ok) errors.push(`${repo}: ${g.problem}`);
    return g.ok ? g.gate : null;
  };
  for (const chain of groupStacks(prs.filter((p) => !p.isDraft))) {
    const bottom = chain[0];
    const tag = (p) => `${repo}#${p.number}`;
    if (chain.length > 1) {
      const bg = gated(bottom);
      const order = chain.map(tag).join(" -> ");
      const steps =
        `merge ${tag(bottom)} first; then retarget ${chain.slice(1).map(tag).join(", ")} to ${defaultBranch} one at a time, re-run the gate on each, and merge it. ` +
        `Never squash into a base other than ${defaultBranch}`;
      rows.push({
        kind: "pr-stack",
        what: `${chain.length} stacked PRs in ${repo}: ${order}`,
        url: bottom.url,
        prs: chain.map((p) => p.number),
        recommendation: bg ? `${steps} (gate passed on ${tag(bottom)} at ${short(bottom.headRefOid)})` : `needs gate on ${tag(bottom)} (head ${short(bottom.headRefOid)}) before the first merge; then ${steps}`,
        answer: bg && bottom.baseRefName === defaultBranch ? "merge" : "lane",
      });
      continue;
    }
    const p = bottom;
    const g = gated(p);
    let recommendation;
    let answer;
    if (p.baseRefName !== defaultBranch) {
      recommendation = `base is ${p.baseRefName}, not ${defaultBranch}, and no open PR heads it: retarget to ${defaultBranch} and re-gate before any merge`;
      answer = "lane";
    } else if (p.mergeable === "CONFLICTING") {
      recommendation = `conflicts with ${defaultBranch}: rebase it, then re-run the gate`;
      answer = "lane";
    } else if (!g) {
      recommendation = `needs gate: run the suite on head ${short(p.headRefOid)}, record it with \`propagate waiting gate-pass <full sha> --suite "<summary>" --apply\`, then merge`;
      answer = "lane";
    } else {
      recommendation = `gate passed on head ${short(p.headRefOid)} (${g.suite}): squash-merge`;
      answer = "merge";
    }
    rows.push({ kind: "pr", what: `${tag(p)} ${p.title}`, url: p.url, recommendation, answer });
  }
  return rows;
}

// ── review rows ─────────────────────────────────────────────────────────────

function reviewRows(reviewsRoot, stateDirPath, errors) {
  if (!reviewsRoot || !existsSync(reviewsRoot)) return { rows: [], read: !!reviewsRoot && existsSync(reviewsRoot) };
  const rows = [];
  for (const name of readdirSync(reviewsRoot).sort()) {
    const dir = path.join(reviewsRoot, name);
    const ag = readAgreement(dir);
    if (!ag.ok) {
      errors.push(`review ${name}: ${ag.problems.join("; ")}`);
      continue;
    }
    if (!ag.agreement?.rater_kind || existsSync(path.join(dir, "adjudication.json"))) continue;
    let brief;
    try {
      brief = JSON.parse(readFileSync(path.join(dir, "brief.json"), "utf8"));
    } catch (e) {
      errors.push(`review ${name}: brief.json is not readable (${e.message})`);
      continue;
    }
    let c;
    try {
      c = compareRaters(dir, brief, ag.agreement, { stateDirPath });
    } catch (e) {
      errors.push(`review ${name}: could not compare the raters (${e.message})`);
      continue;
    }
    const pending = c.lines.filter((l) => !l.adjudicated);
    if (!pending.length) continue;
    const rec = {
      within: ["answer lane or rater per line (recall misses are listed first; rater recovers a source): then adjudicate with --apply", "rater"],
      over: [`${c.d} disagreements exceed the tolerable ${c.tolerable}: re-run with a widened sample and a changed brief`, "lane"],
      stuck: [`stuck after ${c.reruns} re-runs (${c.d} > ${c.tolerable}): park the review or accept the lane's labels`, "defer"],
    }[c.status] ?? ["list the disagreements with `kb review agree <dir> --disagreements`", "defer"];
    rows.push({
      kind: "review",
      what: `review ${name}: ${pending.length} disagreement${pending.length === 1 ? "" : "s"} between the lane and the second rater`,
      url: dir,
      lines: pending.map((l) => ({ title: l.title, lane: l.lane, rater: l.rater })),
      recommendation: rec[0],
      answer: rec[1],
    });
  }
  return { rows, read: true };
}

// ── collect ─────────────────────────────────────────────────────────────────

/**
 * @param {{gh: Function, repos: string[], reviewsRoot?: string|null, stateDirPath: string, queueDirPath?: string|null}} a
 *   queueDirPath: the test-queue directory (#428); null (the default) reads none, so a caller that did not ask never reads the machine's
 * @returns {{rows: object[], errors: string[], sources: string[]}} sources names what was read, so 0 rows is attributable
 */
export function collectWaiting({ gh, repos, reviewsRoot = null, stateDirPath, queueDirPath = null, now = Date.now() }) {
  const rows = [];
  const errors = [];
  const sources = [];
  if (!repos.length) errors.push("no repo could be derived from the remotes or the hub config, so no PR or issue was read");
  const gateOf = (sha) => readGate(stateDirPath, sha);
  for (const repo of repos) {
    const def = ghJson(gh, ["repo", "view", repo, "--json", "defaultBranchRef"], `${repo} default branch`);
    const prs = ghJson(gh, ["pr", "list", "-R", repo, "--state", "open", "--limit", "200", "--json", PR_FIELDS], `${repo} open PRs`);
    const issues = ghJson(gh, ["issue", "list", "-R", repo, "--state", "open", "--limit", "500", "--json", "number,title,url,labels"], `${repo} open issues`);
    for (const r of [def, prs, issues]) if (!r.ok) errors.push(r.error);
    if (def.ok && prs.ok) {
      const branch = def.json?.defaultBranchRef?.name;
      if (!branch) errors.push(`${repo} default branch: gh returned no defaultBranchRef`);
      else {
        rows.push(...prRows(repo, prs.json, branch, gateOf).map((r) => r));
        sources.push(`${repo} PRs`);
      }
    }
    if (issues.ok) {
      sources.push(`${repo} issues`);
      for (const i of issues.json) {
        const hit = (i.labels ?? []).map((l) => l?.name ?? l).find((n) => NEEDS_LABEL.test(String(n)));
        if (!hit) continue;
        rows.push({
          kind: "issue",
          what: `${repo}#${i.number} ${i.title}`,
          url: i.url,
          recommendation: "carries a needs: label: answer approve to take the recommendation written in the issue, or defer to leave it",
          answer: "approve",
        });
      }
    }
  }
  if (reviewsRoot !== undefined) {
    const r = reviewRows(reviewsRoot, stateDirPath, errors);
    rows.push(...r.rows);
    if (r.read) sources.push("kb reviews");
  }
  if (queueDirPath) {
    const q = readRuns({ days: 7, dir: queueDirPath, now });
    if (!q.present) sources.push(`test-queue (${q.note})`);
    else {
      rows.push(...queueRows(q));
      if (q.unread) errors.push(`test-queue: ${q.reason}`);
      else sources.push("test-queue runs");
    }
  }
  if (queueDirPath) {
    const g = noEvidenceRows(stateDirPath, { days: 7, now });
    rows.push(...g.rows);
    errors.push(...g.errors);
  }
  return { rows, errors, sources };
}

// ── render ──────────────────────────────────────────────────────────────────

export function renderWaiting(r) {
  const L = [];
  if (!r.rows.length && !r.errors.length) return [`nothing waiting (sources checked: ${r.sources.join(", ")})`];
  L.push(`waiting on the maintainer: ${r.rows.length}`);
  r.rows.forEach((row, i) => {
    L.push(`${i + 1}. [${row.kind}] ${row.what}`);
    for (const l of row.lines ?? []) L.push(`     ${l.title} (lane ${l.lane}, second rater ${l.rater})`);
    L.push(`     recommend: ${row.recommendation}`);
    L.push(`     answer: ${row.answer}   ${row.url}`);
  });
  for (const e of r.errors) L.push(`COULD NOT READ: ${e}`);
  if (r.errors.length) L.push("the list is incomplete: a source failed, so this is not a clean result");
  return L;
}
