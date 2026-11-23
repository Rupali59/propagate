/**
 * lib/kb/review/schema.mjs — validate a review's brief.json. Pure: no I/O, never throws.
 *
 * A value that is not a brief at all is ONE problem ("not a brief"), never zero problems and never a field-by-field
 * list: a reader that cannot recognise its input must say so (rule:discernment-checks §6).
 */
export const BRIEF_SCHEMA_VERSION = 1;

const DECISIONS = ["included", "excluded", "duplicate", "not_retrieved"];
const TARGETS = ["reference", "standard-row"];
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v) => typeof v === "string" && v.length > 0;
const hex = (v, n) => typeof v === "string" && (n ? v.length === n : v.length > 0) && /^[0-9a-f]+$/i.test(v);

/** @returns {{ok: boolean, problems: string[]}} */
export function validateBrief(obj) {
  if (!isObj(obj)) {
    return { ok: false, problems: [`not a brief: expected a JSON object, got ${obj === null ? "null" : Array.isArray(obj) ? "an array" : typeof obj}`] };
  }
  const problems = [];
  const bad = (p, m) => problems.push(`${p}: ${m}`);
  const arr = (key) => {
    if (!Array.isArray(obj[key])) {
      bad(key, "required array is missing or not an array");
      return [];
    }
    return obj[key];
  };
  const each = (key, fn) => arr(key).forEach((x, i) => (isObj(x) ? fn(x, `${key}[${i}]`) : bad(`${key}[${i}]`, "not an object")));

  if (obj.schema_version !== BRIEF_SCHEMA_VERSION) {
    bad("schema_version", `${JSON.stringify(obj.schema_version)} is unsupported; this reader understands ${BRIEF_SCHEMA_VERSION}`);
  }
  if (!str(obj.review)) bad("review", "required non-empty string");
  if (!hex(obj.protocol_sha, 40)) bad("protocol_sha", "must be 40 hex characters");

  if (!isObj(obj.ai_use)) bad("ai_use", "required object is missing");
  else {
    const a = obj.ai_use;
    if (!Array.isArray(a.models)) bad("ai_use.models", "required array");
    else a.models.forEach((m, i) => {
      if (!isObj(m) || !str(m.lane) || !str(m.model) || !str(m.version)) bad(`ai_use.models[${i}]`, "needs lane, model and version");
    });
    if (!hex(a.prompt_sha)) bad("ai_use.prompt_sha", "must be a hex string");
    if (!str(a.run_date) || Number.isNaN(Date.parse(a.run_date))) bad("ai_use.run_date", "must be an ISO date");
    if (!Array.isArray(a.decided) || !a.decided.every(str)) bad("ai_use.decided", "must be an array of strings");
  }

  each("searches", (s, p) => {
    for (const k of ["lane", "engine", "query", "date"]) if (!str(s[k])) bad(`${p}.${k}`, "required non-empty string");
    if (!Number.isInteger(s.hits) || s.hits < 0) bad(`${p}.hits`, "must be a non-negative integer");
  });
  each("lanes", (l, p) => {
    if (!str(l.id)) bad(`${p}.id`, "required non-empty string");
    if (!str(l.model)) bad(`${p}.model`, "required non-empty string");
  });
  each("screened", (s, p) => {
    if (!str(s.url)) bad(`${p}.url`, "required non-empty string");
    if (!DECISIONS.includes(s.decision)) bad(`${p}.decision`, `${JSON.stringify(s.decision)} is not one of ${DECISIONS.join(" | ")}`);
    if (typeof s.reason !== "string") bad(`${p}.reason`, "required string");
    else if (s.decision === "excluded" && s.reason.trim() === "") bad(`${p}.reason`, "an excluded entry must say why");
    if (!str(s.lane)) bad(`${p}.lane`, "required non-empty string");
  });
  each("sources", (s, p) => {
    if (!str(s.id)) bad(`${p}.id`, "required non-empty string");
    if (!str(s.url)) bad(`${p}.url`, "required non-empty string");
    if (!hex(s.sha256)) bad(`${p}.sha256`, "must be a hex string");
    if (typeof s.secondary_review !== "boolean") bad(`${p}.secondary_review`, "must be a boolean");
  });
  const rqs = new Set();
  each("claims", (c, p) => {
    if (!str(c.id)) bad(`${p}.id`, "required non-empty string");
    if (!str(c.rq)) bad(`${p}.rq`, "required non-empty string");
    else rqs.add(c.rq);
    if (!str(c.text)) bad(`${p}.text`, "required non-empty string");
    if (!Array.isArray(c.source_ids) || c.source_ids.length === 0 || !c.source_ids.every(str)) bad(`${p}.source_ids`, "needs at least one source id");
    if (!Array.isArray(c.quotes) || c.quotes.length === 0) bad(`${p}.quotes`, "a claim needs at least one quote");
    else c.quotes.forEach((q, i) => {
      if (!isObj(q) || !str(q.source_id) || !str(q.text)) bad(`${p}.quotes[${i}]`, "needs source_id and text");
    });
  });
  if (!isObj(obj.disagreements)) bad("disagreements", "required object is missing");
  else {
    for (const rq of rqs) if (!(rq in obj.disagreements)) bad(`disagreements.${rq}`, "missing: say what the sources disagree on, or \"none found\"");
    for (const [rq, v] of Object.entries(obj.disagreements)) {
      if (v !== "none found" && !(Array.isArray(v) && v.every(str))) bad(`disagreements.${rq}`, 'must be an array of strings or "none found"');
    }
  }
  each("proposals", (x, p) => {
    if (!TARGETS.includes(x.target)) bad(`${p}.target`, `${JSON.stringify(x.target)} is not one of ${TARGETS.join(" | ")}`);
    if (!Array.isArray(x.claim_ids) || x.claim_ids.length === 0 || !x.claim_ids.every(str)) bad(`${p}.claim_ids`, "needs at least one claim id");
    if (!str(x.text)) bad(`${p}.text`, "required non-empty string");
    for (const k of ["ref_id", "std_page"]) if (k in x && !str(x[k])) bad(`${p}.${k}`, "when present, must be a non-empty string");
  });
  return { ok: problems.length === 0, problems };
}
