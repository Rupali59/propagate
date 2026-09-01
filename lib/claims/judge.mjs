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
 * AGENT DRAFTS, HUMAN CORRECTS. `VIPIN.md` alone yields 151 judgeable blocks;
 * judging that interactively is a week's work and will not happen. The store is
 * append-only, so this needs no special support: an agent writes verdicts with
 * `by_kind: "agent"`, a human writes corrections later, and `latestByBlock`
 * makes the correction win because it is newer. The disagreement stays on the
 * record rather than being overwritten — which is the point of append-only, and
 * is also how a systematically wrong drafting pass becomes visible instead of
 * invisible.
 */
import { readTextSafe } from "../report/backlog.mjs";
import { splitBlocks } from "./blocks.mjs";
import { readClaims, latestByBlock } from "./store.mjs";

/**
 * Partition one document's blocks against the verdict store.
 *
 * Four outcomes, never collapsed (`rule:discernment-checks` §2):
 *   `judged`    — a verdict exists for this exact text
 *   `unjudged`  — judgeable, and nothing has ruled on it
 *   `structure` — headings, fences, tables, rules: not claims, never counted as
 *                 pending work
 *   `orphaned`  — verdicts whose block_sha is in no block of this file any more
 *
 * `orphaned` is the one a simpler design would drop. It is the store's decay
 * mode, and reporting it is how "judged 140 of 151" stays honest when 9 of those
 * verdicts describe paragraphs that were rewritten last month.
 *
 * @param {string} file absolute path
 * @param {{readFile?: (f:string)=>string}} [opts]
 */
export async function judgeStatus(file, opts = {}) {
  const read = opts.readFile ?? ((f) => readTextSafe(f).text);
  let text;
  try {
    text = read(file);
  } catch (err) {
    return { file, error: `unreadable: ${err.message}`, judged: [], unjudged: [], structure: [], orphaned: [] };
  }
  if (text == null) {
    // Distinct from an empty file: "could not read" and "read, and it is empty"
    // are different facts and only one of them means there is nothing to judge.
    return { file, error: "unreadable: no content returned", judged: [], unjudged: [], structure: [], orphaned: [] };
  }

  const blocks = splitBlocks(text);
  const { claims, malformed, storeExists } = await readClaims({ file });
  const latest = latestByBlock(claims);

  const judged = [];
  const unjudged = [];
  const structure = [];
  const seen = new Set();

  for (const b of blocks) {
    if (!b.judgeable) { structure.push(b); continue; }
    seen.add(b.sha);
    const verdict = latest.get(b.sha);
    if (verdict) judged.push({ ...b, verdict });
    else unjudged.push(b);
  }

  const orphaned = [...latest.values()].filter((c) => !seen.has(c.block_sha));

  return { file, error: null, storeExists, malformed, blocks, judged, unjudged, structure, orphaned };
}

/**
 * The question set, in the shape a caller should answer.
 *
 * Deliberately carries the block TEXT, not a summary: a judge deciding "fact vs
 * impression" needs the sentence, and a truncated one invites the wrong call.
 * `sha` is what a verdict must be keyed to and is echoed back verbatim, so a
 * caller never has to recompute a hash and never has to normalise text the same
 * way this module does.
 */
export function asQuestions(status) {
  return (status.unjudged ?? []).map((b) => ({
    sha: b.sha,
    file: status.file,
    kind_hint: b.kind,
    startLine: b.startLine,
    text: b.text,
  }));
}
