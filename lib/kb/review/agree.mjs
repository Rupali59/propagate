/**
 * lib/kb/review/agree.mjs — the agreement sample (S5b): a reproducible blind sample of the agent's screening
 * decisions and claim-support judgements for a person to check, and Cohen's kappa over her answers.
 *
 * Seeded by `protocol_sha`, so a second run draws the same sample and the recorded answers stay valid. The sample
 * NEVER carries the agent's decision. `agreement.json` is written only behind `apply`, and carries who rated and of
 * what kind (`rater`, `rater_kind`), so check can tell a human second reviewer from a second model (#376).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { compareRaters } from "./disagree.mjs";
import { deriveFromFile, RATER_FILE } from "./rater.mjs";

export const AGREEMENT_FILE = "agreement.json";
/** Our own threshold, stated as a choice (Revision 3 §2); Cochrane's rapid-review rule is the sample, not this number. */
export const KAPPA_THRESHOLD = 0.8;
const SAMPLE_FRACTION = 0.2;
const EPS = 1e-9;
/** `cannot-rate` is a rater answer, listed and never scored as include or exclude (#412). */
export const SCREEN_VALUES = ["include", "exclude", "cannot-rate"];
const SUPPORT_VALUES = ["supports", "does-not-support"];
/** `model-referenced`: a model that answers per criterion with quotes, whose label code derives (rater.mjs, #412). */
export const RATER_KINDS = ["human", "model", "model-referenced"];
export const MODEL_KINDS = ["model", "model-referenced"];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const seedOf = (sha) => parseInt(String(sha ?? "").slice(0, 8).padEnd(8, "0"), 16) || 1;
function shuffled(items, rand) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const byKey = (k) => (x, y) => (x[k] < y[k] ? -1 : x[k] > y[k] ? 1 : 0);
const take = (n) => Math.max(1, Math.ceil(n * SAMPLE_FRACTION));

/**
 * The screening sample is every excluded row plus 20% of the INCLUDED rows (at least 1 when any exist): the human
 * check exists to catch a wrong include as well as a wrong exclude. `not_retrieved` rows are not screening decisions
 * (no one read the source), so they are never drawn and never scored; they are returned as a count only (#377).
 * `widen` (T7, after a failed check) draws every included row too.
 * @returns {{screening: {url: string}[], support: {claim_id: string, claim_text: string, quote: string, source_url: string}[], not_retrieved: number}}
 */
export function drawSample(brief, { widen = false } = {}) {
  const rand = mulberry32(seedOf(brief.protocol_sha));
  const screened = [...(brief.screened ?? [])].sort(byKey("url"));
  const excluded = screened.filter((s) => s.decision === "excluded");
  const included = screened.filter((s) => s.decision === "included");
  const not_retrieved = screened.filter((s) => s.decision === "not_retrieved").length;
  const pickedIncluded = included.length ? shuffled(included, rand).slice(0, widen ? included.length : take(included.length)) : [];
  const screening = shuffled([...excluded, ...pickedIncluded], rand).map((s) => ({ url: s.url }));
  const claims = [...(brief.claims ?? [])].sort(byKey("id"));
  const sources = new Map((brief.sources ?? []).map((s) => [s.id, s]));
  const support = (claims.length ? shuffled(claims, rand).slice(0, take(claims.length)) : []).map((c) => {
    const q = c.quotes?.[0] ?? {};
    return { claim_id: c.id, claim_text: c.text, quote: q.text ?? "", source_url: sources.get(q.source_id)?.url ?? "" };
  });
  return { screening, support, not_retrieved };
}

export function readAgreement(dir) {
  const file = path.join(dir, AGREEMENT_FILE);
  if (!existsSync(file)) return { ok: true, agreement: null };
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    if (!j || typeof j !== "object" || Array.isArray(j) || typeof j.screening !== "object" || typeof j.support !== "object") throw new Error("not an agreement record");
    return { ok: true, agreement: j };
  } catch (e) {
    return { ok: false, problems: [`${AGREEMENT_FILE} is not readable (${e.message})`] };
  }
}

const sha256 = (t) => createHash("sha256").update(t).digest("hex");
const writeAtomic = (file, text) => {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
};

/**
 * Validate `decisions` against the drawn sample and (only with `apply`) write agreement.json.
 *
 * `raterKind: "model-referenced"` takes the rater's per-criterion answers instead of labels: code derives each label
 * (rater.mjs) and `rater.json` records the answers, quotes, model id and the rater agent file's sha256. An `override`
 * (a DECISIONS entry id) lets a model rater stand where the protocol still names a person (#412); it is written into
 * agreement.json as `override: {by, decision, why, date}` and check turns the refusal into a warning.
 * A record made after an over-tolerance one counts as a re-run (T7): the sample widens, and the brief must have changed.
 * @returns {{ok: boolean, wrote?: string[], problems?: string[], would_write?: string}}
 */
export function recordAgreement(dir, decisions, { apply = false, rater, raterKind, now, override, stateDirPath = "", agentFile, protocolDecider } = {}) {
  const briefFile = path.join(dir, "brief.json");
  let briefText;
  let brief;
  try {
    briefText = readFileSync(briefFile, "utf8");
    brief = JSON.parse(briefText);
  } catch (e) {
    return { ok: false, problems: [`brief.json is not readable (${e.message}): record agreement after the brief exists`] };
  }
  const problems = [];
  if (typeof rater !== "string" || !rater.trim()) problems.push("rater: say who rated (--rater <name>)");
  if (!RATER_KINDS.includes(raterKind)) problems.push(`rater kind: must be ${RATER_KINDS.join(" or ")} (--rater-kind), got ${JSON.stringify(raterKind)}`);
  if (override !== undefined && (typeof override !== "string" || !override.trim())) problems.push("override: name the DECISIONS entry that allows a model rater (--override <decision-id>)");
  if (override !== undefined && !MODEL_KINDS.includes(raterKind)) problems.push("override: only a model rater needs one (--rater-kind model or model-referenced)");
  const prior = readAgreement(dir);
  const priorOver = prior.ok && prior.agreement?.over_tolerance === true;
  const briefSha = sha256(briefText);
  if (priorOver && prior.agreement.brief_sha === briefSha) problems.push("the recorded sample was over tolerance and the brief has not changed: re-running the same lanes is not a re-run (T7); change the brief first");
  const d = decisions && typeof decisions === "object" && !Array.isArray(decisions) ? decisions : null;
  if (!d || typeof d.screening !== "object" || !d.screening || (raterKind !== "model-referenced" && (typeof d.support !== "object" || !d.support))) {
    return { ok: false, problems: [...problems, "decisions must be {screening: {<url>: include|exclude}, support: {<claim_id>: supports|does-not-support}}"] };
  }
  const widen = priorOver;
  const sample = drawSample(brief, { widen });
  let screening = d.screening;
  let support = d.support;
  let raterRecord = null;
  if (raterKind === "model-referenced" && !problems.length) {
    const r = deriveFromFile(dir, sample, d, { stateDirPath, agentFile, protocolSha: brief.protocol_sha, now });
    if (!r.ok) return { ok: false, problems: [...problems, ...r.problems] };
    screening = r.screening;
    support = r.support;
    raterRecord = r.rater;
  }
  if (!support || typeof support !== "object") return { ok: false, problems: [...problems, "support: must be {<claim_id>: supports|does-not-support}"] };
  const inScreen = new Set(sample.screening.map((s) => s.url));
  const inSupport = new Set(sample.support.map((s) => s.claim_id));
  for (const [k, v] of Object.entries(screening)) {
    if (!inScreen.has(k)) problems.push(`screening: ${k} is not in the sample`);
    else if (!SCREEN_VALUES.includes(v)) problems.push(`screening: ${k} must be ${SCREEN_VALUES.join(" or ")}, got ${JSON.stringify(v)}`);
  }
  for (const [k, v] of Object.entries(support)) {
    if (!inSupport.has(k)) problems.push(`support: ${k} is not in the sample`);
    else if (!SUPPORT_VALUES.includes(v)) problems.push(`support: ${k} must be ${SUPPORT_VALUES.join(" or ")}, got ${JSON.stringify(v)}`);
  }
  for (const u of inScreen) if (!(u in screening)) problems.push(`screening: no decision for ${u}`);
  // The rater brief carries criteria only (#412), so a model-referenced record answers screening alone; the gate still
  // checks every quote is in its saved body, and brief.md reports how many claims had their support sampled.
  if (raterKind !== "model-referenced") for (const c of inSupport) if (!(c in support)) problems.push(`support: no decision for ${c}`);
  if (problems.length) return { ok: false, problems };
  const file = path.join(dir, AGREEMENT_FILE);
  if (!apply) return { ok: true, wrote: [], would_write: file };
  const date = new Date(now ?? Date.now()).toISOString().slice(0, 10);
  const record = {
    schema_version: 2,
    protocol_sha: brief.protocol_sha,
    rater: rater.trim(),
    rater_kind: raterKind,
    date,
    ...(override !== undefined ? { override: { by: protocolDecider ?? "the maintainer", decision: override.trim(), why: "a model second rater stands where the protocol names a person", date } } : {}),
    screening,
    support,
    brief_sha: briefSha,
    reruns: priorOver ? (prior.agreement.reruns ?? 0) + 1 : (prior.ok ? (prior.agreement?.reruns ?? 0) : 0),
    ...(widen ? { widened: true } : {}),
  };
  const wrote = [];
  if (raterRecord) {
    writeAtomic(path.join(dir, RATER_FILE), `${JSON.stringify(raterRecord, null, 2)}\n`);
    wrote.push(path.join(dir, RATER_FILE));
  }
  const cmp = compareRaters(dir, brief, record, { stateDirPath });
  record.over_tolerance = cmp.status === "over" || cmp.status === "stuck";
  writeAtomic(file, `${JSON.stringify(record, null, 2)}\n`);
  wrote.push(file);
  return { ok: true, wrote };
}

/**
 * Cohen's kappa over the screening decisions, binary (include | exclude), scored only over rows the agent
 * `included` or `excluded`: a `not_retrieved` row is no one's screening decision and is skipped (#377).
 * When either rater's labels are all one class, kappa is undefined and is reported as `{kappa: null, reason}`,
 * never as 0, and the verdict is "undefined", which is not a pass (check refuses it under its own code).
 */
export function scoreAgreement(brief, agreement) {
  const agent = new Map((brief.screened ?? []).filter((s) => s.decision === "included" || s.decision === "excluded").map((s) => [s.url, s.decision === "included" ? "include" : "exclude"]));
  const rated = Object.entries(agreement?.screening ?? {}).filter(([u]) => agent.has(u));
  const cannot_rate = rated.filter(([, h]) => h === "cannot-rate").length; // listed by --disagreements, never scored
  const pairs = rated.filter(([, h]) => h === "include" || h === "exclude").map(([u, h]) => [agent.get(u), h]);
  const n = pairs.length;
  const claims = new Set((brief.claims ?? []).map((c) => c.id));
  const support_failures = Object.entries(agreement?.support ?? {}).filter(([c, v]) => claims.has(c) && v === "does-not-support").length;
  if (n === 0) return { raw: null, kappa: null, kappa_defined: false, n, cannot_rate, support_failures, verdict: "undefined", reason: "no screening decisions were recorded", note: "κ undefined: no screening decisions were recorded" };
  const po = pairs.filter(([a, h]) => a === h).length / n;
  const oneClass = (i) => new Set(pairs.map((p) => p[i])).size < 2;
  if (oneClass(0) || oneClass(1)) {
    const who = oneClass(0) && oneClass(1) ? "both raters" : oneClass(0) ? "the agent" : "the second rater";
    const reason = `${who} gave every sampled item the same label, so chance agreement cannot be separated from agreement`;
    return { raw: po, kappa: null, kappa_defined: false, n, cannot_rate, support_failures, verdict: "undefined", reason, note: `κ undefined: ${reason}` };
  }
  let pe = 0;
  for (const c of SCREEN_VALUES) pe += (pairs.filter(([a]) => a === c).length / n) * (pairs.filter(([, h]) => h === c).length / n);
  const kappa = (po - pe) / (1 - pe);
  return { raw: po, kappa, kappa_defined: true, n, cannot_rate, support_failures, verdict: kappa >= KAPPA_THRESHOLD - EPS ? "reliable" : "unreliable" };
}

/** Is `agreement` a complete, current answer to the sample drawn from `brief`? @returns {string|null} why not */
export function agreementProblem(brief, agreement) {
  if (agreement.protocol_sha !== brief.protocol_sha) return "agreement.json was recorded for a different protocol_sha, so it answers a different sample";
  const s = drawSample(brief, { widen: agreement.widened === true });
  const supportMiss = agreement.rater_kind === "model-referenced" ? 0 : s.support.filter((x) => !(x.claim_id in agreement.support)).length;
  const miss = s.screening.filter((x) => !(x.url in agreement.screening)).length + supportMiss;
  return miss ? `agreement.json leaves ${miss} sampled item${miss === 1 ? "" : "s"} undecided` : null;
}
