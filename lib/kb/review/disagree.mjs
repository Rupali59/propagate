/**
 * lib/kb/review/disagree.mjs — `kb review agree --disagreements` and `--adjudicate` (#412).
 *
 * The maintainer must never be asked to read sources she has not read, so she sees only the lane-vs-rater
 * disagreements, and only up to a cap DERIVED from the sample itself (tolerableCount), never a fixed number.
 * Everything here except writeAdjudication is pure. Adjudication goes in its own `adjudication.json`;
 * `brief.screened` is never edited, so the sample is never redrawn and kappa stays scored on the labels from
 * BEFORE adjudication.
 */
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { KAPPA_THRESHOLD, scoreAgreement } from "./agree.mjs";
import { bodiesByUrl, RATER_FILE } from "./rater.mjs";

export const ADJUDICATION_FILE = "adjudication.json";
export const MAX_RERUNS = 2;
/** T4's recall floor (propagate DECISIONS, thresholds draft): our own number, reported, never silently enforced here. */
export const RECALL_FLOOR = 0.95;
const EPS = 1e-9;

/** Cohen's kappa for n paired labels from a 2x2 table; null when a class is empty on either side. */
function kappa2x2(n, laneIncl, bothIncl, raterIncl) {
  const po = (bothIncl + (n - laneIncl - raterIncl + bothIncl)) / n;
  const pe = (laneIncl / n) * (raterIncl / n) + ((n - laneIncl) / n) * ((n - raterIncl) / n);
  return pe >= 1 - EPS ? null : (po - pe) / (1 - pe);
}

/**
 * How many disagreements can this sample absorb and still score kappa >= 0.8 (T3)?
 *
 * Formula. The sample holds nExcl lane-excluded and nIncl lane-included rows, n = nExcl + nIncl. d disagreements split
 * as `a` (lane excluded, rater included) plus `b` (lane included, rater excluded), a + b = d, a <= nExcl, b <= nIncl.
 * With laneIncl = nIncl and raterIncl = nIncl - b + a, the table gives kappa(a, b) by the usual po / pe. The count is
 * the largest d for which EVERY split of d has kappa >= 0.8 (the worst case, since we do not know the split in
 * advance), and an undefined kappa (a class emptied) fails. Check: nExcl 25, nIncl 4 gives 1 (d=1: worst split b=1,
 * kappa 0.838; d=2: worst split a=1,b=1 or a=2, kappa 0.760 or lower).
 *
 * T4's recall floor 0.95 is NOT folded into this count: a recall miss is exactly a lane-excluded / rater-included row,
 * every one of which is always shown, and adjudicating `rater` recovers it. See recallIfAllReal.
 */
export function tolerableCount(nExcl, nIncl, threshold = KAPPA_THRESHOLD) {
  const n = nExcl + nIncl;
  let tolerable = 0;
  for (let d = 1; d <= n; d++) {
    let feasible = false;
    let ok = true;
    for (let a = 0; a <= d; a++) {
      const b = d - a;
      if (a > nExcl || b > nIncl) continue;
      feasible = true;
      const k = kappa2x2(n, nIncl, nIncl - b, nIncl - b + a);
      if (k === null || k < threshold - EPS) ok = false;
    }
    if (!feasible || !ok) break;
    tolerable = d;
  }
  return tolerable;
}

/** Recall if every lane-excluded / rater-included row is a real miss: lane-included total over itself plus the misses. */
export const recallIfAllReal = (laneIncluded, misses) => (laneIncluded + misses === 0 ? null : laneIncluded / (laneIncluded + misses));

function titles(dir, brief, stateDirPath) {
  const out = new Map();
  for (const s of brief.sources ?? []) if (s.identified_as?.title) out.set(s.url, s.identified_as.title);
  try {
    const byUrl = bodiesByUrl(dir, stateDirPath);
    const bySha = new Map();
    for (const f of readdirSync(path.join(dir, "lanes"))) {
      if (!f.endsWith(".json")) continue;
      for (const s of JSON.parse(readFileSync(path.join(dir, "lanes", f), "utf8")).screened ?? []) if (s.identified_as?.title) bySha.set(s.sha256, s.identified_as.title);
    }
    for (const [url, b] of byUrl) if (!out.has(url) && bySha.has(b.sha256)) out.set(url, bySha.get(b.sha256));
  } catch {
    /* no lane files: the url stands as the title */
  }
  return out;
}

const readJson = (file) => {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  } catch {
    return null;
  }
};
export const readAdjudication = (dir) => readJson(path.join(dir, ADJUDICATION_FILE));

/**
 * The lane-vs-rater comparison on the pre-adjudication labels. Pure.
 * @returns {{n, nExcl, nIncl, kappa, lines: object[], cannot_rate: object[], tolerable, d, a, b, laneIncluded, recall, status, reruns}}
 *   status: kappa-null | none | within | over | stuck
 */
export function compareRaters(dir, brief, agreement, { stateDirPath }) {
  const lane = new Map((brief.screened ?? []).filter((s) => s.decision === "included" || s.decision === "excluded").map((s) => [s.url, s]));
  const rater = readJson(path.join(dir, RATER_FILE));
  const adj = readAdjudication(dir);
  const title = titles(dir, brief, stateDirPath);
  const lines = [];
  const cannot_rate = [];
  let nExcl = 0;
  let nIncl = 0;
  for (const [url, h] of Object.entries(agreement.screening ?? {})) {
    const row = lane.get(url);
    if (!row) continue;
    const laneCall = row.decision === "included" ? "include" : "exclude";
    const item = rater?.items?.[url];
    const base = { url, title: title.get(url) ?? url, lane: laneCall, rater: h, lane_reason: row.reason ?? "", rater_reason: item?.reason ?? "", criterion: item?.why ?? "", adjudicated: adj?.answers?.[url]?.answer ?? null };
    if (h === "cannot-rate") {
      cannot_rate.push(base);
      continue;
    }
    if (laneCall === "include") nIncl++;
    else nExcl++;
    if (h !== laneCall) lines.push({ ...base, missed_include: laneCall === "exclude" });
  }
  // missed includes first: they are the ones that can lose a source
  lines.sort((x, y) => Number(y.missed_include) - Number(x.missed_include) || (x.url < y.url ? -1 : 1));
  const a = lines.filter((l) => l.missed_include).length;
  const b = lines.length - a;
  const score = scoreAgreement(brief, agreement);
  const laneIncluded = new Set([...lane.entries()].filter(([, r]) => r.decision === "included").map(([u]) => u)).size;
  const tolerable = tolerableCount(nExcl, nIncl);
  const reruns = Number.isInteger(agreement.reruns) ? agreement.reruns : 0;
  let status;
  if (score.kappa === null) status = "kappa-null";
  else if (lines.length === 0) status = "none";
  else if (lines.length <= tolerable) status = "within";
  else status = reruns >= MAX_RERUNS ? "stuck" : "over";
  return { n: nExcl + nIncl, nExcl, nIncl, kappa: score.kappa, kappa_reason: score.reason ?? null, lines, cannot_rate, tolerable, d: lines.length, a, b, laneIncluded, recall: recallIfAllReal(laneIncluded, a), status, reruns };
}

const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
export function renderDisagreements(c) {
  const out = [`# kb review agree --disagreements: ${c.n} rated, lane included ${c.nIncl} / excluded ${c.nExcl}, cannot-rate ${c.cannot_rate.length}`];
  out.push(`  kappa ${c.kappa === null ? "undefined" : c.kappa.toFixed(2)}; ${c.d} disagreement${c.d === 1 ? "" : "s"}; tolerable count ${c.tolerable} (kappa >= ${KAPPA_THRESHOLD} in the worst split of this sample)`);
  for (const l of c.lines) {
    out.push(`  ${l.missed_include ? "MISSED-INCLUDE " : ""}${oneLine(l.title)} | lane: ${l.lane} (${oneLine(l.lane_reason) || "no reason"}) | rater: ${l.rater} (${oneLine(l.criterion) || "no criterion"}) | rater reason: ${oneLine(l.rater_reason) || "none"}${l.adjudicated ? ` | answered: ${l.adjudicated}` : ""}`);
  }
  for (const l of c.cannot_rate) out.push(`  cannot-rate (not scored) ${oneLine(l.title)} | lane: ${l.lane} | ${oneLine(l.criterion)}`);
  if (c.a) out.push(`  recall if every MISSED-INCLUDE is real: ${c.recall.toFixed(3)} (T4 floor ${RECALL_FLOOR}${c.recall < RECALL_FLOOR ? ", below it" : ""}); adjudicating \`rater\` recovers the source`);
  const verdict = {
    "kappa-null": c.nIncl === 0 ? "sample has no inclusions to compare: kappa cannot be computed, which is not a low kappa. Next: widen the sample or add inclusions" : `kappa undefined (${c.kappa_reason}). Next: this is not a low kappa; look at the rater's labels`,
    none: "no disagreements: kb review apply",
    within: `within the tolerable count (${c.d} <= ${c.tolerable}): file these lines as one issue labelled needs:<maintainer>, one word each (lane or rater), then kb review agree <dir> --adjudicate <file> --apply`,
    over: `over the tolerable count (${c.d} > ${c.tolerable}): re-run with a widened sample (T7) and a changed brief (re-run ${c.reruns + 1} of ${MAX_RERUNS})`,
    stuck: `stuck after ${MAX_RERUNS} re-runs (${c.d} > ${c.tolerable}): put in the waiting digest with a recommendation`,
  }[c.status];
  out.push(`  ${c.status === "kappa-null" ? "KAPPA-NULL" : c.status === "stuck" ? "STUCK" : c.status === "over" ? "OVER-TOLERANCE" : "ok"}: ${verdict}`);
  return out.join("\n");
}

/** Validate adjudication answers against the listed disagreements. Pure. */
export function checkAdjudication(c, answers) {
  const problems = [];
  const listed = new Set(c.lines.map((l) => l.url));
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return ["adjudication must be a JSON object {<url>: lane|rater}"];
  for (const [u, v] of Object.entries(answers)) {
    if (!listed.has(u)) problems.push(`${u} is not a listed disagreement`);
    else if (v !== "lane" && v !== "rater") problems.push(`${u} must be lane or rater, got ${JSON.stringify(v)}`);
  }
  if (!Object.keys(answers).length) problems.push("no answers given");
  return problems;
}

/** The only write here. @returns {string} the file written */
export function writeAdjudication(dir, brief, answers, { now }) {
  const file = path.join(dir, ADJUDICATION_FILE);
  const prior = readAdjudication(dir)?.answers ?? {};
  const date = new Date(now ?? Date.now()).toISOString().slice(0, 10);
  const merged = { ...prior, ...Object.fromEntries(Object.entries(answers).map(([u, answer]) => [u, { answer, date }])) };
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ schema_version: 1, protocol_sha: brief.protocol_sha, answers: merged }, null, 2)}\n`);
  renameSync(tmp, file);
  return file;
}
