/**
 * lib/claims/judge.mjs — hand out the blocks that need judging, and record the
 * answers. **This module contains no model and makes no network call.**
 *
 * THE PLAN SAID THIS WAS "the only place a model belongs" AND THAT WAS WRONG.
 * Checked before building: propagate's entire dependency list is `ajv`,
 * `proper-lockfile` and `yaml`, and no file under `lib/` makes a network call.
 * Adding an SDK here to classify prose would make every deterministic guarantee
 * in this codebase conditional on a remote service, for a step that a caller
 * already standing in an agent session can do better.
 *
 * So the boundary is not "inside vs outside this file" — it is **inside vs
 * outside the tool**. propagate poses the question and stores the answer; the
 * judge is whoever is calling. That keeps this module exactly as mechanical as
 * `check.mjs`, and it is why `tests/unit/claims-check-boundary.test.mjs`'s
 * assertion can be widened to this file rather than exempting it.
 *
 * WHAT UNJUDGED MEANS, AND WHY IT NEEDS NO BOOKKEEPING. A block is unjudged when
 * no verdict exists for its `block_sha`. Because identity IS the hash of the
 * normalised text, editing a block moves its hash and it becomes unjudged again
 * automatically — no staleness field, no invalidation pass, and no way to
 * silently inherit a judgment about text that no longer exists. A verdict whose
 * hash appears in no current file is ORPHANED, which is a third state and is
 * reported separately: it is neither judged-and-current nor awaiting judgment.
 *
 * AGENT DRAFTS, HUMAN CORRECTS. the constitution doc alone yields 151 judgeable blocks;
 * judging that interactively is a week's work and will not happen. The store is
 * append-only, so this needs no special support: an agent writes verdicts with
 * `by_kind: "agent"`, a human writes corrections later, and `latestByBlock`
 * makes the correction win because it is newer. The disagreement stays on the
 * record rather than being overwritten — which is the point of append-only, and
 * is also how a systematically wrong drafting pass becomes visible instead of
 * invisible.
 *
 * HONEST DEGRADATION (Phase 1). propagate never calls gbrain and never probes
 * whether a judge is alive (Premise 1) — so "no verdict" is structurally
 * ambiguous between "nobody has tried" and "something tried and could not
 * answer". This module resolves the ambiguity from its OWN stores only, never
 * by asking anything: `lib/claims/runs.mjs` records that an attempt happened,
 * separately from what it concluded, and `judgeStatus` folds that record in as
 * a FIFTH outcome:
 *
 *   `unanswerable` — the caller tried and could not (a run record says so)
 *
 * distinct from `unjudged` — no verdict AND no answering run was ever
 * recorded, or the most recent one completed with outcome "ok". A block does
 * not become `unanswerable` merely because a run somewhere succeeded; it
 * becomes `unanswerable` only when the LATEST run for its file crashed or
 * ended in "no-brain"/"error" — see `classifyUnjudged` below for exactly why.
 * The result: a client with no brain and no answering run ever attempted
 * reports "N unjudged, 0 runs", and NEVER "0 findings" — those are different
 * facts and conflating them is the exact failure this phase exists to stop.
 */
import { readTextSafe } from "../report/backlog.mjs";
import { splitBlocks } from "./blocks.mjs";
import { readClaims, latestByBlock } from "./store.mjs";
import { readRuns, summarizeRunsForFile } from "./runs.mjs";

/**
 * Decide, from a run summary alone, whether blocks with no verdict should
 * read as `unjudged` or `unanswerable`.
 *
 * `never` (0 runs) and `completed` with outcome `ok` both stay `unjudged` —
 * the first because nothing was ever attempted, the second because the
 * caller reports success and a lingering unjudged block is a fact about
 * COVERAGE (this run didn't reach every block), not about ANSWERABILITY. Only
 * a `crashed` run or a `completed` run that itself reports `no-brain`/`error`
 * says "I tried and could not" for anything still unjudged.
 */
export function classifyUnjudged(runSummary) {
  if (!runSummary || runSummary.status === "never") return "unjudged";
  if (runSummary.status === "crashed") return "unanswerable";
  if (runSummary.status === "completed" && (runSummary.outcome === "no-brain" || runSummary.outcome === "error")) {
    return "unanswerable";
  }
  return "unjudged";
}

/**
 * Partition one document's blocks against the verdict store.
 *
 * Five outcomes, never collapsed (`rule:discernment-checks` §2):
 *   `judged`       — a verdict exists for this exact text
 *   `unjudged`     — judgeable, and nothing has ruled on it, and no answering
 *                    run says otherwise (see `classifyUnjudged` above)
 *   `unanswerable` — judgeable, no verdict, and the latest recorded answering
 *                    run for this file crashed or ended in "no-brain"/"error"
 *   `structure`    — headings, fences, tables, rules: not claims, never
 *                    counted as pending work
 *   `orphaned`     — verdicts whose block_sha is in no block of this file any
 *                    more
 *
 * `orphaned` is the one a simpler design would drop. It is the store's decay
 * mode, and reporting it is how "judged 140 of 151" stays honest when 9 of those
 * verdicts describe paragraphs that were rewritten last month.
 *
 * `runs` is a THIRD input alongside the file text and the verdict store —
 * folded once per call via `summarizeRunsForFile`, never probed live (Premise
 * 1: propagate does not call out to check whether anything is alive). It
 * answers "how many attempts, and what did the most recent one conclude",
 * which is the only fact this module is allowed to know about *why* a block
 * has no verdict.
 *
 * @param {string} file absolute path
 * @param {{readFile?: (f:string)=>string, readRuns?: (filter:{file:string})=>Promise<{runs:Array<object>}>}} [opts]
 */
export async function judgeStatus(file, opts = {}) {
  const read = opts.readFile ?? ((f) => readTextSafe(f).text);
  const readRunsFn = opts.readRuns ?? readRuns;

  // RUNS ARE READ FIRST, BEFORE THE DOCUMENT, and that ordering is the fix for
  // a real collapse. A file can be deleted or become unreadable WHILE a run is
  // in flight; reading the text first and returning early on failure reported
  // `runs.status: "never"` for it — byte-identical to a file nobody ever
  // attempted. That is precisely the two-states-worn-as-one this module exists
  // to prevent (`rule:discernment-checks` §2), inside the module that claims to
  // prevent it. Found by the ship red-team pass and reproduced directly:
  // an unreadable file with a start-only run record reported "never".
  //
  // The run store is independent of the document, so it is always answerable
  // even when the document is not. A throw here degrades to "never" rather
  // than propagating, because a failed RUN read is not a failed DOCUMENT read.
  let runs;
  try {
    const { runs: runRecords } = await readRunsFn({ file });
    runs = summarizeRunsForFile(runRecords);
  } catch {
    runs = { count: 0, status: "never", outcome: null, runId: null };
  }

  const empty = { judged: [], unjudged: [], unanswerable: [], structure: [], orphaned: [], runs };
  let text;
  try {
    text = read(file);
  } catch (err) {
    return { file, error: `unreadable: ${err.message}`, ...empty };
  }
  if (text == null) {
    // Distinct from an empty file: "could not read" and "read, and it is empty"
    // are different facts and only one of them means there is nothing to judge.
    return { file, error: "unreadable: no content returned", ...empty };
  }

  const blocks = splitBlocks(text);
  // `opts.readClaims`, like `opts.readRuns` below, exists for BATCH callers.
  // `readClaims({file})` reads and parses EVERY shard and filters after the
  // parse, so calling it once per file is O(files x store-size): measured at
  // 754ms across 499 declared sources against a store of 152 claims, versus
  // 0ms to read the whole store once. doctor's tree-wide census is that batch
  // caller (`lib/report/claims.mjs`); single-file `claims judge` passes
  // nothing and keeps the simple path.
  const readClaimsFn = opts.readClaims ?? readClaims;
  const { claims, malformed, storeExists } = await readClaimsFn({ file });
  const latest = latestByBlock(claims);

  // `runs` was already resolved above, before the document read.
  const unjudgedKind = classifyUnjudged(runs);

  const judged = [];
  const unjudged = [];
  const unanswerable = [];
  const structure = [];
  const seen = new Set();

  for (const b of blocks) {
    if (!b.judgeable) { structure.push(b); continue; }
    seen.add(b.sha);
    const verdict = latest.get(b.sha);
    if (verdict) { judged.push({ ...b, verdict }); continue; }
    if (unjudgedKind === "unanswerable") unanswerable.push(b);
    else unjudged.push(b);
  }

  const orphaned = [...latest.values()].filter((c) => !seen.has(c.block_sha));

  return { file, error: null, storeExists, malformed, blocks, judged, unjudged, unanswerable, structure, orphaned, runs };
}

/**
 * The question set, in the shape a caller should answer.
 *
 * Deliberately carries the block TEXT, not a summary: a judge deciding "fact vs
 * impression" needs the sentence, and a truncated one invites the wrong call.
 * `sha` is what a verdict must be keyed to and is echoed back verbatim, so a
 * caller never has to recompute a hash and never has to normalise text the same
 * way this module does.
 *
 * INCLUDES `unanswerable` blocks, not just `unjudged` ones. A prior run that
 * crashed or reported "no-brain" did not resolve the block — it is still
 * awaiting a verdict, and a caller with a working brain right now should still
 * see it as a question. `prior_attempt` distinguishes the two populations in
 * the payload without dropping either from the set a caller can act on.
 */
export function asQuestions(status) {
  const rows = [
    ...(status.unjudged ?? []).map((b) => [b, false]),
    ...(status.unanswerable ?? []).map((b) => [b, true]),
  ];
  return rows.map(([b, priorAttempt]) => ({
    sha: b.sha,
    file: status.file,
    kind_hint: b.kind,
    startLine: b.startLine,
    text: b.text,
    prior_attempt: priorAttempt,
  }));
}
