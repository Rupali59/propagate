/**
 * status.mjs — `propagate broadcast status` (phase 1, propagate#267): the GitHub fold, derived on every run.
 *
 * Nothing is stored as a counter. The header counts come from the parent's `sub_issues_summary`; a child the parent
 * body names but the sub_issues list lacks is "missing child" and is never counted. A GitHub read that fails is exit
 * 2, never 0: "could not read" and "nothing to report" are different facts (rule:discernment-checks §2).
 */
import { makeGh, readJson } from "./gh.mjs";
import { childReposOfParentBody } from "./model.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

const repoOfUrl = (u) => /\/repos\/([^/]+\/[^/]+)$/.exec(String(u ?? ""))?.[1] ?? null;

/**
 * @returns {{ok:false, error:string}|{ok:true, broadcasts:object[]}}
 */
export function readStatus({ hub, number = null, gh, now = Date.now() }) {
  const run = makeGh(gh);
  let numbers;
  if (number !== null) numbers = [number];
  else {
    const l = readJson(run, ["issue", "list", "-R", hub, "--state", "open", "--label", "broadcast", "--limit", "200", "--json", "number,title"], `gh issue list ${hub}`);
    if (!l.ok) return { ok: false, error: l.error };
    if (!Array.isArray(l.json)) return { ok: false, error: `gh issue list ${hub}: output was not a list` };
    numbers = l.json.map((i) => i.number);
  }

  const broadcasts = [];
  for (const n of numbers) {
    const p = readJson(run, ["api", `repos/${hub}/issues/${n}`], `gh api ${hub}#${n}`);
    if (!p.ok) return { ok: false, error: p.error };
    const s = p.json?.sub_issues_summary;
    if (!s || !Number.isInteger(s.total) || !Number.isInteger(s.completed)) {
      return { ok: false, error: `${hub}#${n}: the response has no sub_issues_summary, so progress cannot be derived` };
    }
    const subs = readJson(run, ["api", `repos/${hub}/issues/${n}/sub_issues?per_page=100`], `gh api ${hub}#${n} sub_issues`);
    if (!subs.ok) return { ok: false, error: subs.error };
    if (!Array.isArray(subs.json)) return { ok: false, error: `${hub}#${n} sub_issues: output was not a list` };

    const children = subs.json.map((c) => ({
      ref: `${repoOfUrl(c.repository_url) ?? "unknown-repo"}#${c.number}`,
      repo: repoOfUrl(c.repository_url),
      state: c.state === "closed" ? "closed" : "open",
      ageDays: Number.isFinite(Date.parse(c.created_at)) ? Math.floor((now - Date.parse(c.created_at)) / DAY_MS) : null,
      boardStatus: "status not read",
    }));
    const present = new Set(children.map((c) => c.repo));
    const missing = childReposOfParentBody(p.json.body).filter((r) => !present.has(r));
    broadcasts.push({ number: n, title: p.json.title, completed: s.completed, total: s.total, children, missing });
  }
  return { ok: true, broadcasts };
}

export function renderStatus(res, hub) {
  const lines = [];
  if (!res.broadcasts.length) lines.push(`no open broadcast in ${hub} (the label "broadcast" was read: this is a result, not a blind read)`);
  for (const b of res.broadcasts) {
    lines.push(`${b.title}: ${b.completed}/${b.total} closed`);
    for (const c of b.children) lines.push(`  ${c.ref}  ${c.state}  ${c.boardStatus}  ${c.ageDays === null ? "age unknown" : `${c.ageDays}d`}`);
    for (const m of b.missing) lines.push(`  ${m}  missing child (named in the parent, not in its sub-issues; not counted)`);
  }
  return lines;
}
