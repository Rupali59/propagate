/**
 * lib/kb/review/lane-schema.mjs — validate one lane file, `<dir>/lanes/<id>.json`. Pure: no I/O, never throws.
 *
 * A lane file is the researcher's returned JSON with three fields written AROUND it by the coordinator: `model`,
 * `round`, and `handed` (the shas it gave that lane). `handed` is the coordinator's record, not the lane's claim, so a
 * lane cannot widen its own source set: every sha it screens or cites must be in `handed`, and every handed sha must be
 * a fetched body with classification ok.
 *
 * Two kinds of problem, kept apart. A lane of the wrong SHAPE (prose, a missing field, a field of the wrong type) is
 * `malformed`: the reader did not understand its input, which the CLI reports as "could not run", never as a lane with
 * zero claims (rule:discernment-checks §6). A well-formed lane that breaks a rule (a sha it was not handed, a 4-word
 * quote) is a refusal. Problems are `{code, what, where}`, the shape the gate uses.
 */
import { checkQuoteLength } from "../../research/quotes.mjs";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v) => typeof v === "string" && v.length > 0;
const hex64 = (v) => typeof v === "string" && /^[0-9a-f]{64}$/i.test(v);
const strings = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");
const DECISIONS = ["included", "excluded", "not_retrieved"];
const KINDS = ["query", "doi"];
const TARGETS = ["reference", "standard-row"];
/** The identity key two files are compared on: case, punctuation and spacing do not make two papers different. */
export const normaliseTitle = (t) => String(t).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * @param {unknown} obj the parsed lane file
 * @param {Set<string>|string[]} fetchedShas shas of fetched.json records with classification ok
 * @param {object} [ctx] cross-lane facts, supplied by assembleBrief:
 *   `round1Included` / `round2Included` (Sets of shas other lanes included), `snowballRounds` (protocol restrictions)
 * @returns {{ok: boolean, malformed: boolean, problems: {code: string, what: string, where: string}[]}}
 */
export function validateLane(obj, fetchedShas, ctx = {}) {
  const problems = [];
  const add = (code, where, what) => problems.push({ code, what, where });
  if (!isObj(obj)) {
    add("LANE_SHAPE", "", `not a lane: expected a JSON object, got ${obj === null ? "null" : Array.isArray(obj) ? "an array" : typeof obj}`);
    return { ok: false, malformed: true, problems };
  }
  const shape = (where, what) => add("LANE_SHAPE", where, what);

  // ---- shape ------------------------------------------------------------------------------------------------
  for (const k of ["lane", "model", "rq"]) if (!str(obj[k])) shape(k, "required non-empty string");
  if (!Number.isInteger(obj.round) || obj.round < 1) shape("round", "must be a positive integer (1 is the first pass, 2 the snowball round)");
  if (!Array.isArray(obj.handed) || !obj.handed.every(hex64)) shape("handed", "required array of 64-hex sha256 strings, written by the coordinator");
  if (!Array.isArray(obj.screened)) shape("screened", "required array");
  else obj.screened.forEach((s, i) => {
    if (!isObj(s)) return shape(`screened[${i}]`, "not an object");
    if (!hex64(s.sha256)) shape(`screened[${i}].sha256`, "must be 64 hex characters");
    if (!DECISIONS.includes(s.decision)) shape(`screened[${i}].decision`, `${JSON.stringify(s.decision)} is not one of ${DECISIONS.join(" | ")}`);
    if (typeof s.reason !== "string") shape(`screened[${i}].reason`, "required string");
    // identified_as is optional here (an excluded row may omit it); an included row without one is a refusal below.
    if ("identified_as" in s) {
      const id = s.identified_as;
      if (!isObj(id) || !str(id.title) || id.title.trim() === "") shape(`screened[${i}].identified_as`, "when present, must be {title, authors?} with a non-empty title read from the file");
      else if ("authors" in id && !(strings(id.authors) || typeof id.authors === "string")) shape(`screened[${i}].identified_as.authors`, "when present, must be a string or an array of strings");
    }
  });
  if (!Array.isArray(obj.claims)) shape("claims", "required array");
  else obj.claims.forEach((c, i) => {
    if (!isObj(c)) return shape(`claims[${i}]`, "not an object");
    if (!str(c.text)) shape(`claims[${i}].text`, "required non-empty string");
    if (!Array.isArray(c.quotes) || c.quotes.length === 0 || !c.quotes.every((q) => typeof q === "string")) shape(`claims[${i}].quotes`, "needs at least one quote string");
    if (!Array.isArray(c.sha256s) || c.sha256s.length === 0 || !c.sha256s.every(hex64)) shape(`claims[${i}].sha256s`, "needs at least one 64-hex sha256");
  });
  if (!strings(obj.gaps)) shape("gaps", "required array of strings (an empty array says there were none)");
  if (!Array.isArray(obj.suggestions)) shape("suggestions", "required array");
  else obj.suggestions.forEach((s, i) => {
    if (!isObj(s)) return shape(`suggestions[${i}]`, "not an object");
    if (!KINDS.includes(s.kind)) shape(`suggestions[${i}].kind`, `${JSON.stringify(s.kind)} is not one of ${KINDS.join(" | ")}`);
    if (!str(s.value)) shape(`suggestions[${i}].value`, "required non-empty string");
    if (!hex64(s.from_sha256)) shape(`suggestions[${i}].from_sha256`, "must be 64 hex characters");
  });
  for (const k of ["inferences", "conflicts"]) if (k in obj && !strings(obj[k])) shape(k, "when present, must be an array of strings");
  if ("from" in obj && !(Array.isArray(obj.from) && obj.from.every(hex64))) shape("from", "when present, must be an array of 64-hex sha256 strings");
  if ("secondary_review" in obj && !(Array.isArray(obj.secondary_review) && obj.secondary_review.every(hex64))) shape("secondary_review", "when present, must be an array of 64-hex sha256 strings");
  for (const k of ["model_version", "brief"]) if (k in obj && typeof obj[k] !== "string") shape(k, "when present, must be a string");
  if ("proposals" in obj) {
    if (!Array.isArray(obj.proposals)) shape("proposals", "when present, must be an array");
    else obj.proposals.forEach((p, i) => {
      if (!isObj(p)) return shape(`proposals[${i}]`, "not an object");
      if (!TARGETS.includes(p.target)) shape(`proposals[${i}].target`, `${JSON.stringify(p.target)} is not one of ${TARGETS.join(" | ")}`);
      if (!Array.isArray(p.claims) || p.claims.length === 0 || !p.claims.every(Number.isInteger)) shape(`proposals[${i}].claims`, "needs at least one claim index (0-based, into this lane's claims)");
      if (!str(p.text)) shape(`proposals[${i}].text`, "required non-empty string");
      for (const k of ["ref_id", "std_page"]) if (k in p && !str(p[k])) shape(`proposals[${i}].${k}`, "when present, must be a non-empty string");
    });
  }
  if ("flags" in obj) {
    if (!Array.isArray(obj.flags)) shape("flags", "when present, must be an array");
    else obj.flags.forEach((f, i) => {
      if (!isObj(f) || !str(f.tag) || !hex64(f.sha256) || typeof f.note !== "string") shape(`flags[${i}]`, "needs tag, a 64-hex sha256 and a note string");
    });
  }
  if (problems.length) return { ok: false, malformed: true, problems };

  // ---- rules ------------------------------------------------------------------------------------------------
  const lane = obj.lane;
  const fetched = new Set(fetchedShas ?? []);
  const handed = new Set(obj.handed);
  for (const sha of handed) {
    if (!fetched.has(sha)) add("LANE_NOT_FETCHED", "handed", `lane ${lane} was handed ${sha}, which is not a fetched.json record with classification ok`);
  }
  const decided = new Map();
  obj.screened.forEach((s, i) => {
    const where = `screened[${i}]`;
    if (!handed.has(s.sha256)) add("LANE_NOT_HANDED", where, `lane ${lane} screened ${s.sha256}, which the coordinator never handed it`);
    if (decided.has(s.sha256)) add("LANE_DUPLICATE", where, `lane ${lane} decided ${s.sha256} twice`);
    decided.set(s.sha256, s.decision);
    if (s.reason.trim() === "") add("REASON_MISSING", where, `lane ${lane}: the ${s.decision} decision on ${s.sha256} has no reason; every screening decision carries one`);
  });
  // File identity (#368): the lane names each included file by the title it READ in that file, so a mix-up of two
  // files read in parallel is visible. Two different shas with one title in a lane cannot both be right.
  const titleOf = new Map();
  obj.screened.forEach((s, i) => {
    const where = `screened[${i}]`;
    if (!s.identified_as) {
      if (s.decision === "included") add("LANE_IDENTITY_MISSING", where, `lane ${lane} included ${s.sha256} without identified_as: name each included file by the title and authors read from that file's own text, never from the order of the reads`);
      return;
    }
    const key = normaliseTitle(s.identified_as.title);
    if (titleOf.has(key) && titleOf.get(key) !== s.sha256) add("LANE_IDENTITY_COLLISION", where, `lane ${lane}: ${titleOf.get(key)} and ${s.sha256} are both identified as ${JSON.stringify(s.identified_as.title)}: two files cannot be one paper, so at least one was identified from something other than its own text`);
    else titleOf.set(key, s.sha256);
  });
  for (const sha of handed) {
    if (!decided.has(sha)) add("LANE_UNSCREENED", "screened", `lane ${lane} was handed ${sha} and returned no decision on it: a source is never silently dropped`);
  }
  obj.claims.forEach((c, i) => {
    c.sha256s.forEach((sha) => {
      if (!handed.has(sha)) add("LANE_NOT_HANDED", `claims[${i}].sha256s`, `lane ${lane} cites ${sha}, which the coordinator never handed it`);
      else if (decided.get(sha) !== "included") add("LANE_CLAIM_SOURCE", `claims[${i}].sha256s`, `lane ${lane} cites ${sha}, which it did not include`);
    });
    c.quotes.forEach((q, j) => {
      const len = checkQuoteLength(q);
      if (!len.ok) add("QUOTE_LENGTH", `claims[${i}].quotes[${j}]`, `lane ${lane}: ${len.reason}`);
    });
  });
  obj.suggestions.forEach((s, i) => {
    if (decided.get(s.from_sha256) !== "included") add("LANE_SUGGESTION_SOURCE", `suggestions[${i}]`, `lane ${lane} suggests from ${s.from_sha256}, which it did not include: snowballing starts only from included sources`);
  });
  (obj.proposals ?? []).forEach((p, i) => {
    if (p.claims.some((n) => n < 0 || n >= obj.claims.length)) add("LANE_PROPOSAL", `proposals[${i}]`, `lane ${lane}: proposal names a claim index outside its ${obj.claims.length} claims`);
    if (p.target === "standard-row" && !p.std_page) add("LANE_PROPOSAL", `proposals[${i}]`, `lane ${lane}: a standard-row proposal needs std_page`);
  });
  (obj.flags ?? []).forEach((f, i) => {
    if (!handed.has(f.sha256)) add("LANE_NOT_HANDED", `flags[${i}]`, `lane ${lane} flags ${f.sha256}, which the coordinator never handed it`);
  });
  (obj.secondary_review ?? []).forEach((sha) => {
    if (decided.get(sha) !== "included") add("LANE_CLAIM_SOURCE", "secondary_review", `lane ${lane} marks ${sha} for secondary review but did not include it`);
  });

  // ---- the snowball round -----------------------------------------------------------------------------------
  // Wohlin 2014: one snowball round, started from sources already included. Round 1 is the first pass, so round N is
  // snowball round N-1. A second round is a protocol violation, not a bonus, and so is one that starts from a
  // source a lane excluded.
  const allowed = 1 + (Number.isInteger(ctx.snowballRounds) ? ctx.snowballRounds : 1);
  if (obj.round > allowed) {
    add("SNOWBALL_EXCEEDED", "round", `lane ${lane} is round ${obj.round}; the protocol allows ${allowed - 1} snowball round${allowed - 1 === 1 ? "" : "s"} after the first pass`);
  } else if (obj.round >= 2 && ctx.round1Included) {
    const from = obj.from ?? [];
    if (from.length === 0) add("SNOWBALL_SOURCE_EXCLUDED", "from", `lane ${lane} is a snowball lane but names no origin: \`from\` must list the round-1 included sources it was started from`);
    for (const sha of from) {
      if (ctx.round2Included?.has(sha)) add("SNOWBALL_EXCEEDED", "from", `lane ${lane} was started from ${sha}, a source included in a snowball lane: that is a second snowball round`);
      else if (!ctx.round1Included.has(sha)) add("SNOWBALL_SOURCE_EXCLUDED", "from", `lane ${lane} was started from ${sha}, which no round-1 lane included`);
    }
  }
  return { ok: problems.length === 0, malformed: false, problems };
}
