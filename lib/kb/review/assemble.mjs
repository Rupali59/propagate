/**
 * lib/kb/review/assemble.mjs — `kb review assemble`: merge the lane files with the search and fetch logs into
 * `brief.json`. Deterministic: no model writes the gated file, and the only thing this writes is `brief.json`.
 *
 * Reads `protocol.md`, `searches.json`, `fetched.json` and `lanes/*.json`; reads the saved bodies only to say which
 * of a claim's sources a quote came from (a quote found in none is still assigned its first source, so the gate
 * reports QUOTE_NOT_FOUND instead of this step hiding it). It never judges a quote: that is `kb review check`.
 *
 * Two outcomes besides success, kept apart (the CLI maps them to exit codes):
 *   - `cannotRun`: an input could not be understood (a lane that is prose or the wrong shape, an unreadable log, no
 *     lanes at all). "I did not understand this" is never reported as an empty or partial brief (discernment §6).
 *   - refused: every input was understood and one rule is broken (a sha a lane was never handed, a 4-word quote, a
 *     second snowball round). Nothing is written, and every problem is listed, so one run says what to fix.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findQuote } from "../../research/quotes.mjs";
import { defaultRun } from "./check.mjs";
import { validateLane } from "./lane-schema.mjs";
import { parseProtocol } from "./protocol.mjs";
import { BRIEF_SCHEMA_VERSION, validateBrief } from "./schema.mjs";

const AGENT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "agents", "literature-researcher.md");
const sha256 = (t) => createHash("sha256").update(t).digest("hex");

/**
 * @param {string} dir the review directory
 * @param {object} deps {stateDirPath, now, run, agentFile}
 * @returns {{ok: boolean, wrote?: string, cannotRun?: boolean, problems: {code: string, what: string, where: string}[], flags: object[], counts?: object}}
 */
export function assembleBrief(dir, deps = {}) {
  const problems = [];
  const add = (code, what, where = "") => problems.push({ code, what, where });
  const cannot = () => ({ ok: false, cannotRun: true, problems, flags: [] });
  const refused = () => ({ ok: false, problems, flags: [] });
  const run = deps.run ?? defaultRun;
  const now = deps.now ?? Date.now;

  if (!deps.stateDirPath) {
    add("KB_REVIEW_NO_STATE", "no state directory to read page bodies from");
    return cannot();
  }
  if (existsSync(path.join(dir, "brief.md"))) {
    add("ALREADY_APPLIED", "brief.md exists, so this review was applied: its brief.json is the record of what was applied and is not regenerated", path.join(dir, "brief.json"));
    return refused();
  }

  // ---- inputs that must be readable -------------------------------------------------------------------------
  const readJson = (file, label) => {
    if (!existsSync(file)) {
      add("INPUT_UNREADABLE", `${label} not found`, file);
      return null;
    }
    try {
      return { data: JSON.parse(readFileSync(file, "utf8")) };
    } catch (e) {
      add("INPUT_UNREADABLE", `${label} is not readable JSON (${e.message})`, file);
      return null;
    }
  };
  const protoFile = path.join(dir, "protocol.md");
  let fields = null;
  if (!existsSync(protoFile)) add("INPUT_UNREADABLE", "protocol.md not found", protoFile);
  else {
    const p = parseProtocol(readFileSync(protoFile, "utf8"));
    if (!p.fields) add("INPUT_UNREADABLE", `protocol.md: ${p.problems.join("; ")}`, protoFile);
    else fields = p.fields;
  }
  const sj = readJson(path.join(dir, "searches.json"), "searches.json");
  if (sj && !Array.isArray(sj.data)) {
    add("INPUT_UNREADABLE", "searches.json is not an array", path.join(dir, "searches.json"));
  }
  const fj = readJson(path.join(dir, "fetched.json"), "fetched.json");
  if (fj && !Array.isArray(fj.data?.records)) add("INPUT_UNREADABLE", "fetched.json has no records array", path.join(dir, "fetched.json"));
  const agentFile = deps.agentFile ?? AGENT_FILE;
  if (!existsSync(agentFile)) add("INPUT_UNREADABLE", "the researcher agent file is missing, so prompt_sha cannot be computed", agentFile);
  const lanesDir = path.join(dir, "lanes");
  const laneFiles = existsSync(lanesDir) ? readdirSync(lanesDir).filter((f) => f.endsWith(".json")).sort() : [];
  if (laneFiles.length === 0) add("LANES_MISSING", "no lanes/*.json: there is nothing to assemble", lanesDir);
  if (problems.length) return cannot();

  const hash = run(["hash-object", "protocol.md"], { cwd: dir });
  if (hash.status !== 0 || !/^[0-9a-f]{40}$/.test(hash.stdout.trim())) {
    add("KB_REVIEW_NO_GIT", `git hash-object could not read protocol.md (${String(hash.stderr).trim().split("\n")[0] || "git could not run"}), so brief.protocol_sha cannot be set`, protoFile);
    return cannot();
  }
  const protocolSha = hash.stdout.trim();

  const lanes = [];
  for (const f of laneFiles) {
    const file = path.join(lanesDir, f);
    try {
      lanes.push({ file, id: f.replace(/\.json$/, ""), obj: JSON.parse(readFileSync(file, "utf8")) });
    } catch (e) {
      add("LANE_UNREADABLE", `lane file is not JSON, so it was not understood (${String(e.message).split("\n")[0]}); a lane must return one JSON object and nothing else`, file);
    }
  }
  if (problems.length) return cannot();

  // ---- every lane, validated --------------------------------------------------------------------------------
  const records = fj.data.records;
  const okShas = new Set(records.filter((r) => r.classification === "ok" && typeof r.sha256 === "string").map((r) => r.sha256));
  const included = (o) => (Array.isArray(o?.screened) ? o.screened.filter((x) => x?.decision === "included").map((x) => x.sha256) : []);
  const round1Included = new Set(lanes.filter((l) => l.obj?.round === 1).flatMap((l) => included(l.obj)));
  const round2Included = new Set(lanes.filter((l) => Number.isInteger(l.obj?.round) && l.obj.round >= 2).flatMap((l) => included(l.obj)));
  const snowballRounds = Number.isInteger(fields.restrictions?.snowball_rounds) ? fields.restrictions.snowball_rounds : 1;
  const questionIds = new Set((Array.isArray(fields.questions) ? fields.questions : []).map((q) => q?.id).filter(Boolean));

  let malformed = false;
  for (const l of lanes) {
    const v = validateLane(l.obj, okShas, { round1Included, round2Included, snowballRounds });
    if (v.malformed) malformed = true;
    for (const p of v.problems) add(p.code, p.what, `${l.file}${p.where ? ` ${p.where}` : ""}`);
  }
  if (malformed) return cannot();
  const handedBy = new Map();
  for (const l of lanes) {
    if (l.obj.lane !== l.id) add("LANE_ID_MISMATCH", `the file is ${l.id}.json but it says lane ${JSON.stringify(l.obj.lane)}`, l.file);
    if (questionIds.size && !questionIds.has(l.obj.rq)) add("LANE_RQ_UNKNOWN", `lane ${l.id} answers ${JSON.stringify(l.obj.rq)}, which is not a question in the protocol (${[...questionIds].join(", ")})`, l.file);
    for (const sha of l.obj.handed) {
      if (handedBy.has(sha)) add("LANE_HANDED_TWICE", `${sha} was handed to lanes ${handedBy.get(sha)} and ${l.id}: a source is screened by one lane`, l.file);
      else handedBy.set(sha, l.id);
    }
  }
  const urlsBySha = new Map();
  for (const r of records) if (r.classification === "ok") (urlsBySha.get(r.sha256) ?? urlsBySha.set(r.sha256, []).get(r.sha256)).push(r.url);
  for (const sha of okShas) {
    if (!handedBy.has(sha)) add("SOURCE_UNSCREENED", `${urlsBySha.get(sha)?.[0] ?? sha} was fetched and handed to no lane, so no one screened it`, "fetched.json");
  }
  if (problems.length) return refused();

  // ---- the brief --------------------------------------------------------------------------------------------
  const body = (sha) => {
    const f = path.join(deps.stateDirPath, "kb", "fetched", sha);
    return existsSync(f) ? readFileSync(f, "utf8") : null;
  };
  const sources = [];
  const sourceId = new Map();
  const screened = [];
  const claims = [];
  const proposals = [];
  const flags = [];
  const disagreements = {};

  for (const l of lanes) {
    const o = l.obj;
    for (const s of o.screened) {
      const urls = urlsBySha.get(s.sha256);
      // A lane's `not_retrieved` (#388): the handed body held no readable text (a citation line, a stub). It is a
      // retrieval failure, never a screening decision, so it carries a retrieval_reason and is not counted excluded.
      const row = { url: urls[0], decision: s.decision, reason: s.reason, lane: l.id };
      if (s.decision === "not_retrieved") row.retrieval_reason = `lane: ${/^[A-Z]+\d*|^[a-z_]+/.exec(s.reason.trim())?.[0] ?? "unspecified"}`;
      screened.push(row);
      // Another URL with the same body is the same source: one row says so rather than counting it twice.
      for (const u of urls.slice(1)) screened.push({ url: u, decision: "duplicate", reason: `same saved body as ${urls[0]}`, lane: l.id });
      if (s.decision === "included") {
        sourceId.set(s.sha256, `S${sources.length + 1}`);
        sources.push({ id: sourceId.get(s.sha256), url: urls[0], sha256: s.sha256, secondary_review: (o.secondary_review ?? []).includes(s.sha256), ...(s.identified_as ? { identified_as: s.identified_as } : {}) });
      }
    }
  }
  const firstClaim = new Map();
  for (const l of lanes) {
    const o = l.obj;
    o.claims.forEach((c, i) => {
      const id = `C${claims.length + 1}`;
      firstClaim.set(`${l.id}:${i}`, id);
      const bodies = c.sha256s.map((sha) => ({ sha, text: body(sha) }));
      const quotes = c.quotes.map((q) => {
        const hit = bodies.find((b) => b.text !== null && findQuote(b.text, q).found);
        return { source_id: sourceId.get((hit ?? bodies[0]).sha), text: q };
      });
      claims.push({ id, rq: o.rq, text: c.text, source_ids: [...new Set(c.sha256s.map((sha) => sourceId.get(sha)))], quotes });
    });
    for (const p of o.proposals ?? []) {
      proposals.push({ target: p.target, claim_ids: p.claims.map((n) => firstClaim.get(`${l.id}:${n}`)), text: p.text, ...(p.ref_id ? { ref_id: p.ref_id } : {}), ...(p.std_page ? { std_page: p.std_page } : {}) });
    }
    for (const f of o.flags ?? []) flags.push({ lane: l.id, tag: f.tag, sha256: f.sha256, url: urlsBySha.get(f.sha256)?.[0], note: f.note });
    const found = (disagreements[o.rq] ??= []);
    for (const c of o.conflicts ?? []) found.push(`${l.id}: ${c}`);
  }
  for (const rq of Object.keys(disagreements)) if (disagreements[rq].length === 0) disagreements[rq] = "none found";

  // A fetch that did not yield a readable body is counted, never hidden: stale and hallucinated links included.
  for (const r of records) {
    if (r.classification === "ok") continue;
    if (screened.some((x) => x.url === r.url && x.decision === "not_retrieved")) continue;
    screened.push({ url: r.url, decision: "not_retrieved", reason: `${r.classification}${r.note ? `: ${r.note}` : ""}`, retrieval_reason: r.reason ?? "unrecorded", lane: "fetch" });
  }

  const laneBriefs = lanes.map((l) => `${l.id}\n${l.obj.brief ?? ""}`).join("\n\u0000");
  const brief = {
    schema_version: BRIEF_SCHEMA_VERSION,
    review: fields.review,
    protocol_sha: protocolSha,
    ai_use: {
      models: lanes.map((l) => ({ lane: l.id, model: l.obj.model, version: l.obj.model_version ?? "unreported" })),
      prompt_sha: sha256(`${readFileSync(agentFile, "utf8")}\n\u0000${laneBriefs}`),
      run_date: new Date(now()).toISOString(),
      decided: ["screening", "extraction"],
    },
    searches: sj.data.map((s) => ({ lane: s.lane ?? "coordinator", engine: s.engine, query: s.query, date: s.date, hits: s.hits })),
    lanes: lanes.map((l) => ({ id: l.id, model: l.obj.model })),
    screened,
    sources,
    claims,
    disagreements,
    proposals,
  };
  const v = validateBrief(brief);
  for (const pr of v.problems) add("BRIEF_INVALID", pr, "brief.json");
  if (problems.length) return refused();

  const file = path.join(dir, "brief.json");
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(brief, null, 2)}\n`);
  renameSync(tmp, file);
  return { ok: true, wrote: "brief.json", problems: [], flags, counts: { lanes: lanes.length, sources: sources.length, claims: claims.length, screened: screened.length } };
}
