/**
 * lib/kb/review/rater.mjs — the model second rater (#412): its brief, and the label code derives from its answers.
 *
 * The rater answers each protocol criterion separately and backs every "met" with a 6-15 word quote. It never
 * decides: CODE derives include, exclude or `cannot-rate` from those answers, and a quote counts only when
 * `findQuote` finds it verbatim in the saved body. A rater that asserts a criterion without a findable quote has
 * said nothing code can check, so the item is `cannot-rate`, never a guess.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { findQuote } from "../../research/quotes.mjs";
import { parseProtocol } from "./protocol.mjs";

export const RATER_AGENT_FILE = path.join(import.meta.dirname, "..", "..", "..", "agents", "literature-rater.md");
export const RATER_FILE = "rater.json";
const ID = /^\s*([A-Za-z]+\d+)\s*:/;

/** @returns {{id: string, text: string}[]} ids from the leading `I1:` / `E2:` of each line, else positional I<n> / E<n> */
const listOf = (arr, prefix) => (Array.isArray(arr) ? arr : []).map((t, i) => ({ id: ID.exec(String(t))?.[1] ?? `${prefix}${i + 1}`, text: String(t) }));

export function criteriaOf(fields) {
  return { inclusion: listOf(fields?.inclusion, "I"), exclusion: listOf(fields?.exclusion, "E") };
}

export function readCriteria(dir) {
  try {
    const p = parseProtocol(readFileSync(path.join(dir, "protocol.md"), "utf8"));
    return p.fields ? { ok: true, ...criteriaOf(p.fields) } : { ok: false, problems: p.problems };
  } catch (e) {
    return { ok: false, problems: [`protocol.md is not readable (${e.message})`] };
  }
}

/** url -> {sha256, body_path} for every fetched record that holds a body. */
export function bodiesByUrl(dir, stateDirPath) {
  const out = new Map();
  try {
    const records = JSON.parse(readFileSync(path.join(dir, "fetched.json"), "utf8")).records ?? [];
    for (const r of records) if (r.classification === "ok" && typeof r.sha256 === "string") out.set(r.url, { sha256: r.sha256, body_path: path.join(stateDirPath, "kb", "fetched", r.sha256) });
  } catch {
    /* an unreadable fetched.json leaves every body_path null, which the brief states */
  }
  return out;
}

/**
 * What the rater is handed: each sampled item's url, saved-body path and the protocol's criteria verbatim.
 * NOTHING else, so the lane's decision, reason, lane id and the protocol's Quality text cannot reach it.
 */
export function raterBrief(dir, sample, { stateDirPath }) {
  const crit = readCriteria(dir);
  if (!crit.ok) return { ok: false, problems: crit.problems };
  const bodies = bodiesByUrl(dir, stateDirPath);
  return {
    ok: true,
    brief: {
      criteria: { inclusion: crit.inclusion, exclusion: crit.exclusion },
      items: sample.screening.map((s) => ({ url: s.url, body_path: bodies.get(s.url)?.body_path ?? null })),
    },
  };
}

/**
 * Derive one item's label from the rater's per-criterion answers.
 *   exclude     = an E-criterion marked met, with a quote found in the body
 *   include     = at least one I-criterion met, every met criterion has a found quote, and no E-criterion is met
 *   cannot-rate = anything else (nothing met, or a met criterion the body does not back)
 * @param {{inclusion: object[], exclusion: object[]}} crit
 * @param {{id: string, met: boolean, quote?: string, reason?: string}[]} answers
 * @returns {{label: string, why: string, criteria: object[]}}
 */
export function deriveLabel(crit, answers, bodyText) {
  const eIds = new Set(crit.exclusion.map((c) => c.id));
  const checked = answers.map((a) => {
    const f = a.met && typeof bodyText === "string" ? findQuote(bodyText, a.quote ?? "") : { found: false };
    return { id: a.id, met: Boolean(a.met), quote: a.quote ?? "", quote_found: Boolean(a.met && f.found), reason: a.reason ?? "" };
  });
  const metE = checked.filter((a) => a.met && eIds.has(a.id));
  const metI = checked.filter((a) => a.met && !eIds.has(a.id));
  const done = (label, why) => ({ label, why, criteria: checked });
  const hit = metE.find((a) => a.quote_found);
  if (hit) return done("exclude", `${hit.id} met, quote found`);
  if (metE.length) return done("cannot-rate", `${metE.map((a) => a.id).join(", ")} marked met but the quote is not in the saved text`);
  if (!metI.length) return done("cannot-rate", "no criterion marked met");
  const unbacked = metI.filter((a) => !a.quote_found);
  if (unbacked.length) return done("cannot-rate", `${unbacked.map((a) => a.id).join(", ")} marked met but the quote is not in the saved text`);
  return done("include", `${metI.map((a) => a.id).join(", ")} met, quote found`);
}

/**
 * Validate a model-referenced answer file against the sample and derive its labels.
 * @param {object} file {model, screening: {<url>: {criteria: [{id, met, quote?, reason?}], reason?}}, support}
 * @returns {{ok: true, screening: object, support: object, rater: object} | {ok: false, problems: string[]}}
 */
export function deriveFromFile(dir, sample, file, { stateDirPath, agentFile = RATER_AGENT_FILE, protocolSha, now }) {
  const crit = readCriteria(dir);
  if (!crit.ok) return { ok: false, problems: crit.problems };
  const problems = [];
  if (typeof file?.model !== "string" || !file.model.trim()) problems.push("model: name the model id that rated (a top-level `model` string)");
  if (!file?.screening || typeof file.screening !== "object") return { ok: false, problems: [...problems, "decisions must carry screening: {<url>: {criteria: [{id, met, quote, reason}]}}"] };
  const ids = [...crit.inclusion, ...crit.exclusion].map((c) => c.id);
  const bodies = bodiesByUrl(dir, stateDirPath);
  const labels = {};
  const items = {};
  for (const url of Object.keys(file.screening)) if (!sample.screening.some((s) => s.url === url)) problems.push(`screening: ${url} is not in the sample`);
  for (const { url } of sample.screening) {
    const item = file.screening[url];
    const list = item?.criteria;
    if (!Array.isArray(list)) {
      problems.push(`screening: no criteria answers for ${url}`);
      continue;
    }
    const seen = list.map((a) => a?.id);
    const missing = ids.filter((i) => !seen.includes(i));
    const unknown = seen.filter((i) => !ids.includes(i));
    const dup = seen.filter((i, n) => seen.indexOf(i) !== n);
    if (missing.length) problems.push(`screening: ${url} leaves criteria unanswered: ${missing.join(", ")}`);
    if (unknown.length) problems.push(`screening: ${url} answers criteria the protocol does not have: ${unknown.join(", ")}`);
    if (dup.length) problems.push(`screening: ${url} answers ${[...new Set(dup)].join(", ")} more than once`);
    if (list.some((a) => typeof a?.met !== "boolean")) problems.push(`screening: ${url} has a criterion whose \`met\` is not true or false`);
    if (missing.length || unknown.length || dup.length) continue;
    const b = bodies.get(url);
    const text = b && existsSync(b.body_path) ? readFileSync(b.body_path, "utf8") : null;
    const d = deriveLabel(crit, list, text);
    labels[url] = d.label;
    items[url] = { label: d.label, why: d.why, reason: String(item.reason ?? ""), criteria: d.criteria, body_found: text !== null };
  }
  if (problems.length) return { ok: false, problems };
  const agent = existsSync(agentFile) ? createHash("sha256").update(readFileSync(agentFile)).digest("hex") : null;
  const date = new Date(now ?? Date.now()).toISOString().slice(0, 10);
  return {
    ok: true,
    screening: labels,
    support: file.support ?? {},
    rater: { schema_version: 1, protocol_sha: protocolSha, model: file.model.trim(), agent_sha256: agent, date, items },
  };
}
