/**
 * status.mjs — `propagate broadcast status` (phase 1, propagate#267): the GitHub fold, derived on every run.
 *
 * Nothing is stored as a counter. The header is COUNTED FROM THE CHILDREN'S STATES (the sub-issue list is the source of
 * truth, not `sub_issues_summary`). The phase 1 "missing child" check compared the parent body, which a public hub's
 * identity scrub rewrites, against the real repo names and printed false lines (review 21), so it is dropped; the apply
 * read-back already proves linking. A GitHub read that fails is exit 2, never 0: "could not read" and "nothing to
 * report" are different facts (rule:discernment-checks §2). Each child carries its title (this changes the --json shape).
 */
import { makeGh, readJson } from "./gh.mjs";

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
    if (typeof p.json?.title !== "string") return { ok: false, error: `${hub}#${n}: the response has no title` };
    const subs = readJson(run, ["api", `repos/${hub}/issues/${n}/sub_issues?per_page=100`], `gh api ${hub}#${n} sub_issues`);
    if (!subs.ok) return { ok: false, error: subs.error };
    if (!Array.isArray(subs.json)) return { ok: false, error: `${hub}#${n} sub_issues: output was not a list` };

    const children = subs.json.map((c) => ({
      ref: `${repoOfUrl(c.repository_url) ?? "unknown-repo"}#${c.number}`,
      repo: repoOfUrl(c.repository_url),
      number: c.number,
      title: String(c.title ?? ""),
      state: c.state === "closed" ? "closed" : "open",
      ageDays: Number.isFinite(Date.parse(c.created_at)) ? Math.floor((now - Date.parse(c.created_at)) / DAY_MS) : null,
      boardStatus: "status not read",
    }));
    broadcasts.push({ number: n, title: p.json.title, completed: children.filter((c) => c.state === "closed").length, total: children.length, children });
  }
  return { ok: true, broadcasts };
}

const ago = (ms) => (ms < 3600000 ? "<1h" : ms < 86400000 ? `${Math.floor(ms / 3600000)}h` : `${Math.floor(ms / 86400000)}d`);

/** The shown fact for one child, or null. `shown` is `foldShown().byChild`. */
export function shownOf(shown, c) {
  return (c.repo && c.number != null ? shown?.get(`${c.repo}#${c.number}`.toLowerCase()) : null) ?? null;
}

export function shownText(c, sh, now) {
  if (sh) return `shown ${sh.lastTs ? ago(now - Date.parse(sh.lastTs)) : "?"} (${sh.contexts} contexts, ${sh.attended} attended)`;
  if (c.state === "open" && c.ageDays !== null && c.ageDays > 2) return `not shown (${c.ageDays}d): no session with the hook has started in a folder holding this repo`;
  return c.state === "open" ? "not shown" : "";
}

export function renderStatus(res, hub, { shown = null, now = Date.now() } = {}) {
  const lines = [];
  if (!res.broadcasts.length) lines.push(`no open broadcast in ${hub} (the label "broadcast" was read: this is a result, not a blind read)`);
  for (const b of res.broadcasts) {
    lines.push(`${b.title}: ${b.completed}/${b.total} closed`);
    for (const c of b.children) lines.push(`  ${c.ref}  ${c.state}  ${c.boardStatus}  ${c.ageDays === null ? "age unknown" : `${c.ageDays}d`}${shownText(c, shownOf(shown, c), now) ? `  ${shownText(c, shownOf(shown, c), now)}` : ""}`);
  }
  return lines;
}
