/**
 * lib/kb/review/cmd.mjs — `kb review new|assemble|check|agree|apply` (#325, #326, #327). Dispatched from cli/kb.mjs.
 *
 * EXIT CODES, for every subcommand. 0 ok; 1 refused or problems found (a refusal from the gate, an existing review
 * directory, an unreliable sample); 2 could not run (not configured, usage, missing directory, no tier table).
 * Every failure is `<CODE>: <what>. Next: <command>` on stderr, or `{ok:false, code, what, next}` with --json.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { stateDir } from "../../core/paths.mjs";
import { agreementProblem, drawSample, readAgreement, recordAgreement, scoreAgreement } from "./agree.mjs";
import { applyReview } from "./apply.mjs";
import { assembleBrief } from "./assemble.mjs";
import { checkReview, ReviewCannotRun } from "./check.mjs";
import { reviewDirName, reviewsDir } from "./paths.mjs";
import { newReview } from "./protocol.mjs";

export const REVIEW_USAGE = "usage: propagate kb review new <slug> --decision <text> --decider <name> | kb review assemble <dir> [--json] | kb review check <dir> [--refetch] [--json] | kb review agree <dir> [--record <file> --rater <name> --rater-kind human|model] [--apply] [--json] | kb review apply <dir> [--json]";
const fail = (code, what, next) => ({ ok: false, code, what, next });

function parseArgs(rest, valued, bools) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (valued.includes(a)) {
      const v = rest[i + 1];
      if (v === undefined || v.startsWith("--")) return { error: fail("KB_REVIEW_USAGE", `${a} needs a value`, REVIEW_USAGE) };
      flags[a] = v;
      i++;
    } else if (bools.includes(a)) flags[a] = true;
    else if (a.startsWith("--")) return { error: fail("KB_REVIEW_USAGE", `unknown argument ${a}`, REVIEW_USAGE) };
    else pos.push(a);
  }
  return { flags, pos };
}

/**
 * @param {string[]} rest everything after `review`
 * @param {object} ctx {io, integrations, inject}  inject: stateDirPath, run, now, refetch
 */
export async function reviewCmd(rest, { io, integrations, inject = {} }) {
  const asJson = rest.includes("--json");
  const emit = (f, code = 2) => {
    if (asJson) io.log(JSON.stringify(f, null, 2));
    else io.error(`${f.code}: ${f.what}. Next: ${f.next}`);
    return code;
  };
  const sub = rest[0];
  const table = {
    new: [["--decision", "--decider"], ["--json"]],
    assemble: [[], ["--json"]],
    check: [[], ["--refetch", "--json"]],
    agree: [["--record", "--rater", "--rater-kind"], ["--apply", "--json"]],
    apply: [[], ["--json"]],
  };
  if (!table[sub]) return emit(fail("KB_REVIEW_USAGE", sub === undefined ? "kb review needs a subcommand" : `unknown kb review subcommand ${JSON.stringify(sub)}`, REVIEW_USAGE));
  const p = parseArgs(rest.slice(1), table[sub][0], table[sub][1]);
  if (p.error) return emit(p.error);
  const { flags, pos } = p;
  if (pos.length !== 1) return emit(fail("KB_REVIEW_USAGE", `kb review ${sub} needs exactly one ${sub === "new" ? "<slug>" : "<dir>"}`, REVIEW_USAGE));
  const now = inject.now ?? Date.now;
  const stateDirPath = inject.stateDirPath ?? stateDir();
  const deps = { stateDirPath, integrations, run: inject.run, now };

  if (sub === "new") {
    if (!flags["--decision"] || !flags["--decider"]) return emit(fail("KB_REVIEW_USAGE", "kb review new needs --decision and --decider: a review without them has no decision to feed", REVIEW_USAGE));
    const root = reviewsDir(integrations);
    if (!root.ok) return emit(fail("KB_REVIEWS_NOT_CONFIGURED", root.reason, "set PROPAGATE_KB_REVIEWS_DIR (or kbReviewsDir under integrations: in config.yml), or configure kbStandardsDir"));
    const date = new Date(now()).toISOString().slice(0, 10);
    let name;
    try {
      name = reviewDirName(date, pos[0]);
    } catch (e) {
      return emit(fail(e.code ?? "KB_REVIEW_USAGE", e.message, REVIEW_USAGE));
    }
    const r = newReview(path.join(root.dir, name), { slug: pos[0], date, decision: flags["--decision"], decider: flags["--decider"] });
    if (!r.ok) return emit(r, 1);
    if (asJson) io.log(JSON.stringify({ ok: true, wrote: r.wrote }, null, 2));
    else io.log(`# kb review new\n  wrote ${r.wrote[0]}\n  next: fill in the protocol, get it approved (approved.by), commit it, then search`);
    return 0;
  }

  const dir = path.resolve(pos[0]);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return emit(fail("KB_REVIEW_DIR", `${dir} is not an existing review directory`, "pass the review folder, e.g. propagate kb review check <reviews>/<date>-<slug>"));

  try {
    if (sub === "check") {
      const r = checkReview(dir, deps);
      if (flags["--refetch"]) await refetchWarnings(dir, r, deps, inject);
      return report(io, asJson, r, "check");
    }
    if (sub === "assemble") return assembleCmd(dir, deps, io, asJson, emit);
    if (sub === "apply") {
      const r = applyReview(dir, deps);
      if (asJson) io.log(JSON.stringify(r, null, 2));
      else if (r.ok) io.log(`# kb review apply\n${r.wrote.map((f) => `  wrote ${f}`).join("\n")}`);
      else {
        io.error("# kb review apply refused; nothing was written");
        for (const x of r.refusals) io.error(`${x.code}: ${x.what}${x.where ? ` (${x.where})` : ""}`);
      }
      return r.ok ? 0 : 1;
    }
    return agreeCmd(dir, flags, io, asJson, emit, inject);
  } catch (e) {
    if (e instanceof ReviewCannotRun) return emit(fail(e.code, e.what, e.next));
    throw e;
  }
}

/** exit 0 written; 1 refused, nothing written; 2 an input could not be understood (a lane that is prose, an unreadable log). */
function assembleCmd(dir, deps, io, asJson, emit) {
  const r = assembleBrief(dir, deps);
  const where = (p) => (p.where ? ` (${p.where})` : "");
  if (r.cannotRun) {
    const code = r.problems[0].code;
    const f = fail(code, r.problems.map((p) => `${p.what}${where(p)}`).join("; "), "fix the named file (re-run the lane and save its JSON object alone), then run kb review assemble again");
    if (asJson) io.log(JSON.stringify({ ...f, problems: r.problems }, null, 2));
    else io.error(`${f.code}: ${f.what}. Next: ${f.next}`);
    return 2;
  }
  if (!r.ok) {
    if (asJson) io.log(JSON.stringify({ ok: false, wrote: null, problems: r.problems }, null, 2));
    else {
      io.error("# kb review assemble refused; nothing was written");
      for (const p of r.problems) io.error(`${p.code}: ${p.what}${where(p)}`);
    }
    return 1;
  }
  if (asJson) io.log(JSON.stringify({ ok: true, wrote: r.wrote, counts: r.counts, flags: r.flags }, null, 2));
  else {
    io.log(`# kb review assemble\n  wrote ${path.join(dir, r.wrote)}\n  ${r.counts.lanes} lanes, ${r.counts.sources} included sources, ${r.counts.claims} claims, ${r.counts.screened} screened rows`);
    for (const f of r.flags) io.log(`  FLAG ${f.tag} in lane ${f.lane}: ${f.url ?? f.sha256}: ${f.note}`);
    io.log("  next: kb review check <dir>");
  }
  return 0;
}

function report(io, asJson, r) {
  if (asJson) {
    io.log(JSON.stringify(r, null, 2));
    return r.ok ? 0 : 1;
  }
  io.log(`# kb review check  (${r.ok ? "ok" : `${r.refusals.length} refusal${r.refusals.length === 1 ? "" : "s"}`})`);
  for (const x of r.refusals) io.log(`  REFUSED ${x.code}: ${x.what}${x.where ? ` (${x.where})` : ""}`);
  for (const w of r.warnings) io.log(`  warning ${w.code}: ${w.what}${w.where ? ` (${w.where})` : ""}`);
  if (r.counts) io.log(`  counts: identified ${r.counts.identified}, duplicates ${r.counts.duplicates}, screened ${r.counts.screened}, excluded ${r.counts.excluded}, not retrieved ${r.counts.not_retrieved}, included ${r.counts.included}`);
  const why = Object.entries(r.derived?.not_retrieved_by_reason ?? {});
  if (why.length) io.log(`  not retrieved by reason: ${why.map(([k, n]) => `${k} ${n}`).join(", ")}`);
  for (const [id, t] of Object.entries(r.derived?.tiers ?? {})) io.log(`  tier ${id}: ${t.tier} (${t.basis})`);
  return r.ok ? 0 : 1;
}

/** --refetch: re-fetch each source into a throwaway directory and warn on drift. Never a refusal. */
async function refetchWarnings(dir, r, deps, inject) {
  if (!r.counts) return;
  const brief = JSON.parse(readFileSync(path.join(dir, "brief.json"), "utf8"));
  const tmp = mkdtempSync(path.join(os.tmpdir(), "kb-refetch-"));
  try {
    const records = inject.refetch
      ? await inject.refetch(brief.sources.map((s) => s.url))
      : (await (await import("../../research/fetch.mjs")).fetchAll({ dir: tmp, urls: brief.sources.map((s) => s.url), stateDirPath: deps.stateDirPath, now: deps.now })).records;
    for (const s of brief.sources) {
      const rec = records.find((x) => x.url === s.url);
      if (!rec || rec.classification !== "ok") r.warnings.push({ code: "REFETCH_FAILED", what: `${s.url} could not be re-fetched (${rec?.classification ?? "no record"}); drift is unknown`, where: "--refetch" });
      else if (rec.sha256 !== s.sha256) r.warnings.push({ code: "SOURCE_DRIFTED", what: `${s.url} now hashes to ${rec.sha256}, not the ${s.sha256} the review quoted`, where: "--refetch" });
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function agreeCmd(dir, flags, io, asJson, emit) {
  let brief;
  try {
    brief = JSON.parse(readFileSync(path.join(dir, "brief.json"), "utf8"));
  } catch (e) {
    return emit(fail("KB_REVIEW_BRIEF_UNREADABLE", `brief.json is not readable (${e.message})`, "write the brief first, then sample it"));
  }
  const out = (obj, text) => (asJson ? io.log(JSON.stringify(obj, null, 2)) : io.log(text));
  if (flags["--record"]) {
    let decisions;
    try {
      decisions = JSON.parse(readFileSync(flags["--record"], "utf8"));
    } catch (e) {
      return emit(fail("KB_REVIEW_USAGE", `${flags["--record"]} is not readable JSON (${e.message})`, REVIEW_USAGE));
    }
    const r = recordAgreement(dir, decisions, { apply: Boolean(flags["--apply"]), rater: flags["--rater"], raterKind: flags["--rater-kind"] });
    if (!r.ok) return emit(fail("KB_REVIEW_AGREEMENT_INVALID", r.problems.join("; "), "answer every sampled item; run kb review agree <dir> to see the sample"), 1);
    out(r, r.wrote.length ? `# kb review agree\n  wrote ${r.wrote[0]}` : `# kb review agree (dry run)\n  would write ${r.would_write}; re-run with --apply to record`);
    return 0;
  }
  const rd = readAgreement(dir);
  if (!rd.ok) return emit(fail("KB_REVIEW_AGREEMENT_UNREADABLE", rd.problems.join("; "), "fix or remove agreement.json"));
  if (!rd.agreement) {
    const s = drawSample(brief);
    out({ ok: true, sample: s }, [`# kb review agree: sample (${s.screening.length} screening, ${s.support.length} support; ${s.not_retrieved} not_retrieved, never sampled or scored)`, "  screening: answer include or exclude for each URL, blind to the agent's decision", ...s.screening.map((x) => `    ${x.url}`), "  support: does the quote support the claim? answer supports or does-not-support", ...s.support.map((x) => `    ${x.claim_id}: ${x.claim_text}\n      "${x.quote}" (${x.source_url})`), "  record with: kb review agree <dir> --record <file.json> --rater <name> --rater-kind human|model --apply"].join("\n"));
    return 0;
  }
  const why = agreementProblem(brief, rd.agreement);
  if (why) return emit(fail("KB_REVIEW_AGREEMENT_STALE", why, "re-record the answers against the current sample"), 1);
  const s = scoreAgreement(brief, rd.agreement);
  out({ ok: s.verdict === "reliable", ...s }, `# kb review agree: ${s.verdict}\n  sampled ${s.n}, raw agreement ${s.raw}, kappa ${s.kappa_defined ? s.kappa.toFixed(2) : s.note ?? "undefined"}${rd.agreement.rater ? `, rated by ${rd.agreement.rater} (${rd.agreement.rater_kind})` : ", rater unknown"}, support failures ${s.support_failures}`);
  return s.verdict === "reliable" ? 0 : 1;
}
