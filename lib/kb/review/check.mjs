/**
 * lib/kb/review/check.mjs — the gate. `checkReview(dir, deps)` reads a review directory and the recorded fetch and
 * search logs and decides. It is PURE in effect: it writes nothing and touches no network (`--refetch` is the CLI's,
 * and only ever warns). Every check runs and every refusal is collected, so one run lists everything to fix.
 *
 * Refusals are `{code, what, where}`; `warnings` use the same shape. A thing this gate cannot read at all (no tier
 * table, no git) throws ReviewCannotRun, which the CLI turns into exit 2: "could not decide" is not "refused".
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { findQuote } from "../../research/quotes.mjs";
import { canonicalUrl } from "../../research/fetch.mjs";
import { loadReferences } from "../references.mjs";
import { agreementProblem, RATER_KINDS, readAgreement, scoreAgreement } from "./agree.mjs";
import { parseProtocol, requiresHumanSecondReviewer } from "./protocol.mjs";
import { validateBrief } from "./schema.mjs";
import { readStatus } from "./status.mjs";
import { deriveTier, loadTierTable } from "./tier.mjs";

export class ReviewCannotRun extends Error {
  constructor(code, what, next) {
    super(what);
    this.code = code;
    this.what = what;
    this.next = next;
  }
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const HEX64 = /^[0-9a-f]{64}$/i;

/** The key two spellings of one source share: https, no www., no fragment, no utm_*, no trailing slash. */
export function normalizeUrl(raw) {
  try {
    const u = new URL(canonicalUrl(raw));
    if (u.protocol === "http:") u.protocol = "https:";
    u.hostname = u.hostname.replace(/^www\./, "");
    const p = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : u.pathname;
    return `${u.protocol}//${u.host}${p}${u.search}`;
  } catch {
    return String(raw).trim();
  }
}

export const defaultRun = (args, { cwd }) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { status: r.status ?? 2, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error };
};

function readJson(file) {
  if (!existsSync(file)) return { ok: false, why: "not found" };
  try {
    return { ok: true, data: JSON.parse(readFileSync(file, "utf8")) };
  } catch (e) {
    return { ok: false, why: `unreadable JSON (${e.message})` };
  }
}

/** PRISMA counts over normalised URLs. identified - duplicates = screened = excluded + not_retrieved + included. */
export function prismaCounts(screened) {
  const groups = new Map();
  for (const s of screened) {
    const k = normalizeUrl(s.url);
    (groups.get(k) ?? groups.set(k, []).get(k)).push(s);
  }
  const c = { excluded: 0, not_retrieved: 0, included: 0 };
  let onlyDuplicate = 0;
  for (const rows of groups.values()) {
    const rep = rows.find((r) => r.decision !== "duplicate");
    if (!rep) onlyDuplicate += 1;
    else c[rep.decision] += 1;
  }
  return { identified: screened.length, duplicates: screened.length - groups.size + onlyDuplicate, screened: groups.size - onlyDuplicate, ...c };
}

/**
 * The not_retrieved count split by why the fetch failed (#367), over the same representatives prismaCounts counts, so
 * the parts add up to `counts.not_retrieved`. A row with no recorded reason (a lane's own decision, or a brief made
 * before the fetch recorded one) is counted as `unrecorded`, never dropped.
 * @returns {Object<string, number>} reason to count, most frequent first
 */
export function notRetrievedByReason(screened) {
  const groups = new Map();
  for (const s of screened) {
    const k = normalizeUrl(s.url);
    (groups.get(k) ?? groups.set(k, []).get(k)).push(s);
  }
  const by = {};
  for (const rows of groups.values()) {
    const rep = rows.find((r) => r.decision !== "duplicate");
    if (rep?.decision === "not_retrieved") by[rep.retrieval_reason ?? "unrecorded"] = (by[rep.retrieval_reason ?? "unrecorded"] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(by).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

/**
 * @param {string} dir the review directory
 * @param {object} deps {stateDirPath, run, integrations: {kbTiersFile, kbReferencesFile}}
 * @returns {{ok: boolean, refusals: object[], warnings: object[], counts: object|null, derived: object}}
 */
export function checkReview(dir, deps = {}) {
  const run = deps.run ?? defaultRun;
  const integrations = deps.integrations ?? {};
  const refusals = [];
  const warnings = [];
  const refuse = (code, what, where = "") => refusals.push({ code, what, where });
  const warn = (code, what, where = "") => warnings.push({ code, what, where });

  const tiers = loadTierTable(integrations.kbTiersFile);
  if (!tiers.ok) throw new ReviewCannotRun(tiers.code, tiers.what, tiers.next);
  if (!deps.stateDirPath) throw new ReviewCannotRun("KB_REVIEW_NO_STATE", "no state directory to read page bodies from", "set PROPAGATE_STATE_DIR");
  const probe = run(["--version"], { cwd: dir });
  if (probe.status !== 0) throw new ReviewCannotRun("KB_REVIEW_NO_GIT", "git could not run, so the protocol cannot be checked against its commit", "install git, or run from a machine that has it");

  const protoFile = path.join(dir, "protocol.md");
  const empty = { tiers: {}, screening: null, support: null };

  // ---- the protocol -----------------------------------------------------------------------------------------
  let fields = null;
  if (!existsSync(protoFile)) refuse("PROTOCOL_INVALID", "protocol.md not found", protoFile);
  else {
    const p = parseProtocol(readFileSync(protoFile, "utf8"));
    if (!p.fields) refuse("PROTOCOL_INVALID", p.problems.join("; "), protoFile);
    else {
      fields = p.fields;
      for (const pr of p.problems) refuse("PROTOCOL_INVALID", pr, protoFile);
      if (!fields.approved?.by) refuse("PROTOCOL_UNAPPROVED", "approved.by is empty: a person approves the protocol before the search", protoFile);
    }
  }

  // This review's own live status: an old review stays checkable, with a warning naming its replacement.
  const own = readStatus(dir);
  if (!own.ok) warn("STATUS_UNREADABLE", own.problem, "status.json");
  else if (own.status.status !== "current") warn("REVIEW_NOT_CURRENT", `this review is ${own.status.status}${own.status.by ? `, replaced by ${own.status.by}` : ""}${own.status.date ? ` (${own.status.date})` : ""}`, "status.json");

  // ---- the brief --------------------------------------------------------------------------------------------
  const bj = readJson(path.join(dir, "brief.json"));
  let brief = null;
  if (!bj.ok) refuse("BRIEF_INVALID", `brief.json ${bj.why}`, path.join(dir, "brief.json"));
  else {
    const v = validateBrief(bj.data);
    for (const pr of v.problems) refuse("BRIEF_INVALID", pr, "brief.json");
    if (v.ok) brief = bj.data;
  }

  // protocol against git
  if (existsSync(protoFile)) {
    const status = run(["status", "--porcelain", "--", "protocol.md"], { cwd: dir });
    if (status.status !== 0) refuse("PROTOCOL_UNCOMMITTED", `protocol.md is not in a git repository (${String(status.stderr).trim().split("\n")[0]})`, protoFile);
    else if (status.stdout.trim() !== "") refuse("PROTOCOL_UNCOMMITTED", `protocol.md has uncommitted changes or is untracked (git status: ${status.stdout.trim()})`, protoFile);
    else if (brief) {
      const earliest = [...brief.searches.map((s) => s.date)].filter(Boolean).sort()[0];
      const log = run(["log", "-1", "--format=%cs", "--", "protocol.md"], { cwd: dir });
      const committed = log.stdout.trim();
      if (earliest && committed && committed > earliest) {
        refuse("PROTOCOL_AFTER_SEARCH", `protocol.md was last committed ${committed}, after the earliest search ${earliest}: the protocol must be fixed before the search`, protoFile);
      }
    }
    if (brief) {
      const h = run(["hash-object", "protocol.md"], { cwd: dir });
      const sha = h.stdout.trim();
      if (h.status !== 0) refuse("PROTOCOL_SHA_MISMATCH", "git hash-object could not read protocol.md", protoFile);
      else if (sha !== brief.protocol_sha) refuse("PROTOCOL_SHA_MISMATCH", `brief.protocol_sha is ${brief.protocol_sha} but protocol.md hashes to ${sha}: the protocol changed after the brief was written (whitespace counts)`, protoFile);
    }
  }

  // supersedes
  if (fields?.supersedes) {
    const reviewsRoot = path.dirname(path.resolve(dir));
    const self = path.basename(path.resolve(dir));
    const target = String(fields.supersedes);
    const targetDir = path.join(reviewsRoot, target);
    if (target.includes("/") || target === self || !existsSync(path.join(targetDir, "protocol.md"))) {
      refuse("SUPERSEDES_INVALID", `supersedes names ${JSON.stringify(target)}, which is not a sibling review directory with a protocol.md`, protoFile);
    } else {
      const ts = readStatus(targetDir);
      if (!ts.ok) refuse("SUPERSEDES_INVALID", `${target}: ${ts.problem}`, protoFile);
      else if (ts.status.status === "superseded" && ts.status.by !== self) refuse("SUPERSEDES_INVALID", `${target} is already superseded by ${ts.status.by}: two reviews would claim to be current`, protoFile);
    }
  }

  if (!brief) {
    return { ok: false, refusals, warnings, counts: null, derived: empty };
  }

  // ---- logged searches --------------------------------------------------------------------------------------
  const sj = readJson(path.join(dir, "searches.json"));
  const logged = sj.ok && Array.isArray(sj.data) ? sj.data : [];
  if (!sj.ok || !Array.isArray(sj.data)) warn("SEARCHES_UNREADABLE", `searches.json ${sj.ok ? "is not an array" : sj.why}: every brief search reads as unlogged`, "searches.json");
  const key = (s) => `${s.engine}\u0000${s.query}\u0000${s.date}`;
  const loggedKeys = new Set(logged.map(key));
  brief.searches.forEach((s, i) => {
    if (!loggedKeys.has(key(s))) refuse("SEARCH_UNLOGGED", `no (engine, query, date) row for ${s.engine} / ${JSON.stringify(s.query)} / ${s.date} in searches.json`, `searches[${i}]`);
  });

  // ---- sources and quotes -----------------------------------------------------------------------------------
  const fj = readJson(path.join(dir, "fetched.json"));
  const fetched = fj.ok && Array.isArray(fj.data?.records) ? fj.data.records : [];
  if (!fj.ok || !Array.isArray(fj.data?.records)) warn("FETCHED_UNREADABLE", `fetched.json ${fj.ok ? "has no records array" : fj.why}: every source reads as not fetched`, "fetched.json");
  const dj = readJson(path.join(dir, "discovered.json"));
  const discovered = dj.ok && Array.isArray(dj.data) ? dj.data : [];
  const bodies = new Map();
  brief.sources.forEach((s, i) => {
    const where = `sources[${i}]`;
    const rec = HEX64.test(s.sha256) ? fetched.find((r) => r.sha256 === s.sha256 && r.classification === "ok") : null;
    const file = HEX64.test(s.sha256) ? path.join(deps.stateDirPath, "kb", "fetched", s.sha256) : null;
    if (!rec) {
      const other = fetched.find((r) => r.sha256 === s.sha256);
      refuse("SOURCE_NOT_FETCHED", `${s.url}: no fetched.json record with classification ok for sha256 ${s.sha256}${other ? ` (it is ${other.classification})` : ""}`, where);
    } else if (!file || !existsSync(file) || !statSync(file).isFile()) {
      refuse("SOURCE_NOT_FETCHED", `${s.url}: the body for sha256 ${s.sha256} is missing from the store`, where);
    } else bodies.set(s.id, readFileSync(file, "utf8"));
  });
  const byId = new Map(brief.sources.map((s) => [s.id, s]));
  brief.claims.forEach((c, ci) => {
    c.quotes.forEach((q, qi) => {
      const where = `claims[${ci}].quotes[${qi}]`;
      if (!byId.has(q.source_id) || !c.source_ids.includes(q.source_id)) {
        refuse("CITATION_MISMATCH", `claim ${c.id} quotes source ${q.source_id}, which is not one of its source_ids or not a source`, where);
        return;
      }
      if (!bodies.has(q.source_id)) return; // SOURCE_NOT_FETCHED already says why
      const f = findQuote(bodies.get(q.source_id), q.text);
      if (f.refused) refuse("QUOTE_NOT_FOUND", `claim ${c.id}: ${f.refused}`, where);
      else if (!f.found) refuse("QUOTE_NOT_FOUND", `claim ${c.id}: the quote does not occur in the saved source ${byId.get(q.source_id).url}`, where);
    });
    c.source_ids.forEach((id) => { if (!byId.has(id)) refuse("CITATION_MISMATCH", `claim ${c.id} cites unknown source ${id}`, `claims[${ci}].source_ids`); });
  });

  // included <-> cited
  // A source counts as included when its group's representative row (the first non-"duplicate" one) says so,
  // the same rule the PRISMA counts use, so the two cannot disagree.
  const reps = new Map();
  for (const s of brief.screened) {
    const k = normalizeUrl(s.url);
    if (s.decision !== "duplicate" && !reps.has(k)) reps.set(k, s);
  }
  const includedKeys = new Set([...reps].filter(([, s]) => s.decision === "included").map(([k]) => k));
  const citedKeys = new Set(brief.claims.flatMap((c) => c.source_ids).filter((id) => byId.has(id)).map((id) => normalizeUrl(byId.get(id).url)));
  for (const k of includedKeys) if (!citedKeys.has(k)) refuse("CITATION_MISMATCH", `${k} is included but cited by no claim`, "screened");
  for (const k of citedKeys) if (!includedKeys.has(k)) refuse("CITATION_MISMATCH", `${k} is cited by a claim but is not an included source`, "claims");

  // ---- tiers, proposals -------------------------------------------------------------------------------------
  const derivedTiers = {};
  for (const s of brief.sources) derivedTiers[s.id] = deriveTier(s, { discovered, fetched, table: tiers.table });
  const refsFile = integrations.kbReferencesFile;
  const refsLoad = refsFile && existsSync(refsFile) ? loadReferences(refsFile) : null;
  if (!refsLoad) warn("REFERENCES_NOT_CONFIGURED", "kb-references.yml is not configured or absent: the duplicate-reference check did not run", "proposals");
  else if (refsLoad.problems.length) warn("REFERENCES_PROBLEMS", `the duplicate-reference check ran over a partly unreadable file: ${refsLoad.problems.join("; ")}`, refsFile);
  // An entry THIS review's own apply wrote (stamped added.by "kb review apply", added.ask this slug) is not a
  // duplicate of it: otherwise every applied review would fail its own re-check. Any other match still refuses.
  const slug = fields?.review ?? brief.review;
  const isOwn = (r) => r.added?.by === "kb review apply" && r.added?.ask === slug;
  const others = (refsLoad?.references ?? []).filter((r) => !isOwn(r));
  const existing = new Map(others.filter((r) => r.url).map((r) => [normalizeUrl(r.url), r.id]));
  const existingIds = new Set(others.map((r) => r.id));
  const claimById = new Map(brief.claims.map((c) => [c.id, c]));
  brief.proposals.forEach((p, i) => {
    const where = `proposals[${i}]`;
    const claims = p.claim_ids.map((id) => claimById.get(id));
    if (claims.some((c) => !c)) {
      refuse("CITATION_MISMATCH", `proposal names a claim id that is not in claims[]: ${p.claim_ids.join(", ")}`, where);
      return;
    }
    const srcs = [...new Set(claims.flatMap((c) => c.source_ids))].filter((id) => byId.has(id));
    if (p.target === "standard-row") {
      if (!srcs.some((id) => derivedTiers[id]?.tier === 1)) refuse("STANDARD_ROW_TIER", `no tier-1 source behind claims ${p.claim_ids.join(", ")} (tiers: ${srcs.map((id) => `${id}=${derivedTiers[id]?.tier}`).join(", ") || "none"})`, where);
    } else {
      for (const id of srcs) {
        const dupe = existing.get(normalizeUrl(byId.get(id).url));
        if (dupe) refuse("DUPLICATE_REFERENCE", `${byId.get(id).url} already exists as ref:${dupe}`, where);
      }
      if (p.ref_id && existingIds.has(p.ref_id)) refuse("DUPLICATE_REFERENCE", `ref:${p.ref_id} already exists`, where);
    }
  });

  // ---- screening agreement ----------------------------------------------------------------------------------
  let screening = null;
  let support = null;
  const ag = readAgreement(dir);
  if (!ag.ok) refuse("SCREENING_UNSAMPLED", ag.problems.join("; "), "agreement.json");
  else if (!ag.agreement) warn("SCREENING_UNSAMPLED", "no agreement.json: the screening sample has not been checked by a person (a refusal in apply)", "agreement.json");
  else {
    // Who rated (#376). A model rater passes only where the protocol itself allows one; a record that does not say
    // who rated is unknown and is never assumed human. Each case has its own code and is a refusal, not a warning.
    const { rater, rater_kind: kind } = ag.agreement;
    if (typeof rater !== "string" || !rater.trim() || !RATER_KINDS.includes(kind)) {
      refuse("SCREENING_RATER_UNKNOWN", `agreement.json does not say who rated (rater ${JSON.stringify(rater ?? null)}, rater_kind ${JSON.stringify(kind ?? null)}); re-record with --rater and --rater-kind`, "agreement.json");
    } else if (kind === "model" && existsSync(protoFile) && requiresHumanSecondReviewer(readFileSync(protoFile, "utf8"))) {
      refuse("SCREENING_RATER_NOT_HUMAN", `the second rater is a model (${rater}), but the protocol requires a person as second reviewer: model-model agreement is not the human check`, "agreement.json");
    }
    const why = agreementProblem(brief, ag.agreement);
    if (why) warn("SCREENING_UNSAMPLED", why, "agreement.json");
    else {
      screening = scoreAgreement(brief, ag.agreement);
      support = { n: Object.keys(ag.agreement.support).length, failures: screening.support_failures };
      if (screening.verdict === "undefined") refuse("SCREENING_KAPPA_UNDEFINED", `screening agreement cannot be scored: ${screening.reason}; raw agreement ${screening.raw}`, "agreement.json");
      else if (screening.verdict === "unreliable") refuse("SCREENING_UNRELIABLE", `screening agreement is unreliable: raw ${screening.raw}, κ ${screening.kappa_defined ? screening.kappa.toFixed(2) : "undefined"} (threshold 0.8)`, "agreement.json");
    }
  }

  return { ok: refusals.length === 0, refusals, warnings, counts: prismaCounts(brief.screened), derived: { tiers: derivedTiers, screening, support, not_retrieved_by_reason: notRetrievedByReason(brief.screened) } };
}
