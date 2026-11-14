/**
 * model.mjs — the pure half of `propagate broadcast` (phase 1, propagate#267): keys, grouping, bodies, the Model rule.
 * No gh call and no file read lives here.
 */
import { hasDoneWhen } from "../report/day.mjs";

const KEY_RE = /<!-- propagate-broadcast key=(.+?) -->/;

export const parentKeyOf = (slug) => `${slug}:parent`;
export const childKeyOf = (slug, repo) => `${slug}:${repo}`;
export const keyComment = (key) => `<!-- propagate-broadcast key=${key} -->`;
export const keyOfBody = (body) => KEY_RE.exec(String(body ?? ""))?.[1] ?? null;

export function slugOf(title) {
  return String(title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * The Model board field, from the rule. CANONICAL COPY: `defaultModel` in scripts/board-goals.mjs in the hub (a
 * separate repo; not imported). Opus for an Epic or Feature or no stated Done when, Haiku for XS with one, else Sonnet.
 */
export function defaultModel(itemType, size, body = "") {
  const t = String(itemType || "").toLowerCase();
  if (["epic", "feature"].includes(t) || !hasDoneWhen(body)) return "Opus";
  if (size === "XS") return "Haiku";
  return "Sonnet";
}

/** `owner/repo#n` -> {repo, n}; null when the subject is not that shape. */
export function parseRef(subject) {
  const m = /^([^/\s]+\/[^#\s]+)#(\d+)$/.exec(String(subject ?? ""));
  return m ? { repo: m[1], n: Number(m[2]) } : null;
}

/**
 * Group `goals check --json` violations by repo. Only clause "item-fields" counts. A subject that is not
 * `owner/repo#n` is returned in `unparsed`, never dropped (rule:discernment-checks §2).
 * @returns {{groups: Map<string, {n:number, reason:string}[]>, unparsed: string[]}}
 */
export function groupItemFields(violations) {
  const groups = new Map();
  const unparsed = [];
  for (const v of violations ?? []) {
    if (v?.clause !== "item-fields") continue;
    const ref = parseRef(v.subject);
    if (!ref) {
      unparsed.push(String(v.subject));
      continue;
    }
    if (!groups.has(ref.repo)) groups.set(ref.repo, []);
    groups.get(ref.repo).push({ n: ref.n, reason: String(v.reason ?? "") });
  }
  return { groups, unparsed };
}

/**
 * The goal a child serves: the most common G-goal among its items, read from the dispatch snapshot that `day open`
 * writes (`{ "<owner/repo#n>": { goal } }`). A broadcast can span goals (grooming touches G1, G2 and G3 boards), so one
 * --goal stamped on every child would put a G1 item on a G2 board; found in the first live dry run, 2026-11-14.
 * Falls back to `fallback` when no item carries a G-goal (no snapshot, or items parked or goal-less). Ties go to the
 * fallback when it is among them, else to the lowest id, so the result never depends on map order.
 */
export function childGoal(repo, items, snapshotItems, fallback) {
  const tally = new Map();
  for (const it of items ?? []) {
    const g = snapshotItems?.[`${repo}#${it.n}`]?.goal;
    if (typeof g === "string" && /^G\d+$/.test(g)) tally.set(g, (tally.get(g) ?? 0) + 1);
  }
  if (!tally.size) return fallback;
  const max = Math.max(...tally.values());
  const top = [...tally].filter(([, c]) => c === max).map(([g]) => g).sort();
  return top.includes(fallback) ? fallback : top[0];
}

export function childTitle(parentTitle, repo) {
  return `${parentTitle} · ${repo.split("/")[1]}`;
}

export function groomingBody({ parentTitle, goal, repo, items }) {
  const lines = items.map((i) => `- #${i.n}: ${i.reason}`);
  return [
    `Part of the broadcast "${parentTitle}" (goal ${goal}).`,
    "",
    `Items in ${repo} that lack what makes them startable:`,
    ...lines,
    "",
    `Done when: \`propagate goals check\` reports no item-fields violation for ${repo}.`,
  ].join("\n");
}

export function parentBody({ parentTitle, goal, repos, slug }) {
  return [
    `Broadcast: ${parentTitle} (goal ${goal}).`,
    "",
    "Children, one per workspace:",
    ...repos.map((r) => `- ${r}`),
    "",
    keyComment(parentKeyOf(slug)),
  ].join("\n");
}

/** The repos a parent body names as children (the `- owner/repo` lines under "Children"). */
export function childReposOfParentBody(body) {
  const out = [];
  let inList = false;
  for (const line of String(body ?? "").split("\n")) {
    if (/^Children\b/.test(line)) {
      inList = true;
      continue;
    }
    if (!inList) continue;
    const m = /^-\s+([^/\s]+\/[^\s]+)\s*$/.exec(line);
    if (m) out.push(m[1]);
    else if (line.trim() !== "") break;
  }
  return out;
}
