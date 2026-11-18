/**
 * lib/kb/standards/adopt.mjs — the adoption record in a project's `.sidecar.yml` `standards:` block (design §2.2).
 *
 * Detection proposes, adoption decides, and the adoption stays. This module reads the block, PLANS a change to it
 * (pure: before and after text, nothing written) and APPLIES a plan. Nothing here guesses a sidecar path: the CLI
 * resolves it through discovery's workspace roots.
 *
 * BYTE SAFETY. Only the `standards:` pair is rewritten. Every other byte of the sidecar (`credentials:`, comments,
 * spacing) is kept as written: a missing block is appended, an existing one is replaced in place by its source
 * range. A YAML round trip of the whole document would normalise spacing in keys it does not own.
 * The cost: comments INSIDE the `standards:` block are regenerated away.
 *
 * Only `adopt` may be applied in this increment. `decline` and `remove` need approval (D3), built in slice S4.
 */
import { readFileSync, writeFileSync } from "node:fs";
import yaml from "yaml";
import { readSidecar } from "../../report/manifest.mjs";

export const APPROVAL_UNAVAILABLE = "approvals are built in standards slice S4; record this decline/removal then";
// `reviews` (Task 6b, `standards review <row> --apply`) is read and kept now, so adding the command needs no schema change.
const LISTS = ["adopted", "overrides", "declined", "removed", "reviews"];
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** @returns {{adopted:any[],overrides:any[],declined:any[],removed:any[],reviews:any[],local_page:string|null}|{error:string}} */
export function readAdoptions(sidecarFile) {
  const { sidecar, error } = readSidecar(sidecarFile);
  if (error) return { error: `unreadable sidecar ${sidecarFile}: ${error}` };
  const block = sidecar?.standards;
  const empty = { adopted: [], overrides: [], declined: [], removed: [], reviews: [], local_page: null };
  if (block === undefined || block === null) return empty;
  if (typeof block !== "object" || Array.isArray(block)) return { error: `${sidecarFile}: \`standards:\` must be a mapping` };
  const out = { ...empty };
  for (const k of LISTS) {
    if (block[k] === undefined || block[k] === null) continue;
    if (!Array.isArray(block[k])) return { error: `${sidecarFile}: \`standards.${k}:\` must be a list` };
    out[k] = block[k];
  }
  if (block.local_page !== undefined && block.local_page !== null) out.local_page = String(block.local_page);
  const extra = Object.fromEntries(Object.entries(block).filter(([k]) => !LISTS.includes(k) && k !== "local_page"));
  return Object.keys(extra).length ? { ...out, _extra: extra } : out;
}

/** Replace (or append) the top-level `standards:` pair, leaving every other byte alone. */
function spliceStandards(before, block) {
  const text = yaml.stringify({ standards: block });
  const doc = yaml.parseDocument(before);
  const pair = doc.contents?.items?.find((p) => p.key?.value === "standards");
  if (!pair) return `${before}${before === "" || before.endsWith("\n") ? "" : "\n"}${text}`;
  const start = pair.key.range[0];
  const end = pair.value?.range ? pair.value.range[2] : pair.key.range[2];
  const tail = before.slice(end);
  return `${before.slice(0, start)}${text}${tail.startsWith("\n") || tail === "" ? tail : `\n${tail}`}`;
}

/**
 * @param {object} a
 * @param {"adopt"|"decline"|"remove"} [a.kind]
 * @param {string} a.std standard id
 * @param {string} a.project
 * @param {string} a.sidecarFile resolved by the caller through discovery
 * @param {string[]} [a.units] unit paths to record
 * @param {string|null} [a.evidence]
 * @param {string|null} a.by gh login; null is allowed only for a dry run
 * @param {number} a.now
 * @param {string|null} [a.verifiedOn] "<probe> <version>", or a reason it was not read
 * @param {string|null} [a.reason]
 * @param {{id:string,status:string}[]} [a.rows]
 * @param {{row:string,kind:string,target:string}[]} [a.checksToRun]
 * @returns {{kind,sidecarFile,before:string,after:string,entry:object,refresh:boolean,rows:object[],checksToRun:object[]}|{error:string}}
 */
export function planAdopt({ kind = "adopt", std, project, sidecarFile, units = [], evidence = null, by = null, now, verifiedOn = null, reason = null, rows = [], checksToRun = [] }) {
  const cur = readAdoptions(sidecarFile);
  if (cur.error) return { error: cur.error };
  const before = readFileSync(sidecarFile, "utf8");
  const { _extra, ...lists } = cur;
  const next = { ...(_extra ?? {}) };
  for (const k of LISTS) if (lists[k].length) next[k] = lists[k].map((x) => ({ ...x }));
  if (lists.local_page) next.local_page = lists.local_page;
  let entry;
  let refresh = false;
  if (kind === "adopt") {
    const list = (next.adopted ??= []);
    const i = list.findIndex((a) => a?.standard === std);
    refresh = i >= 0;
    // Re-adopting keeps who and when it began; it refreshes the verification and, when given, the units and evidence.
    entry = refresh
      ? { ...list[i], ...(units.length ? { units } : {}), verified_on: verifiedOn, ...(evidence !== null ? { evidence } : {}) }
      : { standard: std, units, since: isoDay(now), by, verified_on: verifiedOn, ...(evidence !== null ? { evidence } : {}) };
    if (refresh) list[i] = entry;
    else list.push(entry);
  } else if (kind === "decline") {
    entry = { standard: std, reason };
    (next.declined ??= []).push(entry);
  } else if (kind === "remove") {
    entry = { standard: std, on: isoDay(now), by, reason, approved_pr: null };
    (next.removed ??= []).push(entry);
  } else return { error: `unknown plan kind ${kind}` };
  return { kind, std, project, sidecarFile, before, after: spliceStandards(before, next), entry, refresh, rows, checksToRun };
}

/** Write a plan. Only `adopt` can be applied until approvals exist (S4). Refuses a changed file: the plan was made from `before`. */
export function applyPlan(plan) {
  if (plan.kind !== "adopt") return { written: false, error: APPROVAL_UNAVAILABLE };
  if (readFileSync(plan.sidecarFile, "utf8") !== plan.before) return { written: false, error: `${plan.sidecarFile} changed since the plan was made; re-run` };
  writeFileSync(plan.sidecarFile, plan.after);
  return { written: true };
}
