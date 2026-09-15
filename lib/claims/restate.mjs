/**
 * lib/claims/restate.mjs — hold a RESTATED copy of a canonical rule against the
 * rule's own text. Phase 2a of the gbrain-as-judge design (see the plan's
 * "Phase 2 (A)" — "the excused set. Bounded, known, ship this first").
 *
 * SAME MOULD AS `contradict.mjs`, AND THAT IS DELIBERATE. That module's own
 * header states the architecture this repeats: "derive atomic facts, pair each
 * claim with the facts it could possibly be about, and hand the pairs out.
 * Deciding whether a claim CONTRADICTS a fact is judgment and belongs to the
 * caller." Every word of that applies here with one substitution: the DERIVED
 * fact is not a rollup count, it is a rule's own canonical text, read from its
 * `.md` file and stripped of frontmatter; the AUTHORED claim is the block of a
 * `CLAUDE.md` that restates it.
 *
 * PAIRING NEEDS NO BOUND HERE, AND THAT IS THE WHOLE POINT OF 2a. `contradict.mjs`
 * spends most of its header justifying an owner-name filter because its candidate
 * space is ~4,000 pairs nobody asked for. This lane has no such problem: the
 * corpus is HANDED TO US by `rules-check.mjs`'s `referencedRestatements` — files
 * that already match a rule's fingerprint AND cite it, which is precisely the
 * population the parent detector excuses and never checks further. No search, no
 * ranking, no threshold: each entry already names the exact (rule, file) pair.
 * The silent set (files that restate without citing) is Phase 2b and is NOT
 * this module's job — ranking that population by embedding similarity is
 * exactly the kind of mechanical pre-filter this phase's sibling explicitly
 * refuses to shortcut.
 *
 * IT RUNS NO MODEL, same as every file in this directory. No fetch, no SDK
 * import, no subprocess. `tests/unit/claims-check-boundary.test.mjs` asserts
 * this for every module under `lib/claims/`, this one included.
 *
 * A PAIR THAT CANNOT BE FORMED IS UNPAIRED, NEVER DROPPED. Three ways that
 * happens, each with its own reason string so a reader is told which:
 *   - the rule or its file is missing/unreadable (a corpus entry naming a rule
 *     that no longer exists, or a rule file this process cannot read);
 *   - the restating file is unreadable;
 *   - the recorded line does not fall inside a JUDGEABLE block of that file
 *     (structure, not a claim — see `blocks.mjs`), or the rule's own fingerprint
 *     no longer matches that block's text. The second case is the one Phase 2a's
 *     verification explicitly requires: a corpus entry can be stale (the file was
 *     edited between when the corpus was computed and when this pairs it, or a
 *     citation exists with no restatement nearby) and reporting it as UNPAIRED —
 *     rather than silently skipping it or pairing it against text that is not
 *     actually a restatement — is what makes "could not be checked" a finding
 *     instead of an omission.
 */
import { stripFrontmatter } from "../rules/rules-check.mjs";
import { splitBlocks } from "./blocks.mjs";
import { factSha } from "./contradict.mjs";
import { readClaims, canonicalFile } from "./store.mjs";
import { readTextSafe } from "../report/backlog.mjs";

/**
 * Derive the one atomic fact a rule contributes: its own canonical text.
 *
 * Not split further into sentences — unlike `contradict.mjs`'s rollup-derived
 * facts, a rule body has no structured data to extract atoms from, and
 * inventing a sentence-splitter here would be exactly the kind of judgment call
 * `rule:discernment-checks` warns implementing as a regex (seven prior
 * instances, per `contradict.mjs`'s own "KNOWN LIMIT" note). The whole
 * (frontmatter-stripped) body is the fact; the question a caller answers is
 * "does the copy still match THIS", not "does it match this one sentence of
 * this".
 *
 * @param {{id:string, __file:string}} rule
 * @param {{readFile?: (f:string)=>string}} [opts]
 * @returns {{sha:string, owner:string, kind:string, text:string, file:string}|null}
 *   null when the rule's own file cannot be read or is empty after stripping —
 *   the caller reports that as UNPAIRED, never silently.
 */
export function deriveRuleFact(rule, opts = {}) {
  const read = opts.readFile ?? ((f) => readTextSafe(f).text);
  let raw;
  try {
    raw = read(rule.__file);
  } catch {
    raw = null;
  }
  if (raw == null) return null;
  const body = stripFrontmatter(raw).trim();
  if (!body) return null;
  return { sha: factSha(body), owner: rule.id, kind: "rule-body", text: body, file: rule.__file };
}

/**
 * Find the judgeable block of `fileText` that contains `line` (1-indexed, as
 * reported by `rules-check.mjs`).
 *
 * Returns null for every reason a pair cannot be formed at that line: no block
 * covers it (line is out of range), the covering block is structure rather than
 * a claim (`blocks.mjs`'s `JUDGEABLE` set), or the caller-supplied fingerprint
 * regex no longer matches that block's actual text.
 *
 * @param {string} fileText
 * @param {number} line
 * @param {RegExp} fingerprintRe
 * @returns {{block:object}|{reason:string}}
 */
function findClaimBlock(fileText, line, fingerprintRe) {
  const blocks = splitBlocks(fileText);
  const block = blocks.find((b) => line >= b.startLine && line <= b.endLine);
  if (!block) return { reason: `no block covers line ${line} — the file may have changed since the corpus was computed` };
  if (!block.judgeable) {
    return { reason: `line ${line} falls inside a "${block.kind}" block, which is structure, not a claim` };
  }
  if (!fingerprintRe.test(block.text)) {
    return {
      reason:
        `the rule's fingerprint no longer matches the block at line ${line} — ` +
        `a citation can exist with no restatement nearby, or the corpus entry is stale`,
    };
  }
  return { block };
}

/**
 * Turn the handed-to-us corpus into pairs, or say why a given entry could not
 * be paired.
 *
 * @param {Array<{rule:string, file:string, line:number}>} corpus
 *   `referencedRestatements` from `checkRules` (`lib/rules/rules-check.mjs`).
 * @param {Array<{id:string, fingerprint:string, __file:string}>} rules
 *   `loadRules`'s output — must include every rule id named in `corpus`.
 * @param {{readFile?: (f:string)=>string}} [opts]
 * @returns {{pairs: Array<{claim:object, fact:object, file:string, rule:string, pairSha:string}>,
 *            unpaired: Array<{rule:string, file:string, line:number, reason:string}>}}
 */
/**
 * Identity for a corpus entry that could NOT be paired.
 *
 * WHY UNPAIRED NEEDS A HASH AT ALL. Reporting an unpaired entry and leaving it
 * unrecordable means it re-reports on every run forever, with no way to say
 * "checked, this is a false positive". That is the lane failing to converge:
 * 10 of the 15 handed-to-us entries are unpairable because the fingerprint
 * matched a filename or a heading rather than a restatement, and without an
 * identity none of those 10 can ever be dispositioned. `unrelated` is exactly
 * the CLAIM_FINDINGS value for them, and a verdict needs something to key to.
 *
 * THE LINE NUMBER IS DELIBERATELY EXCLUDED. Lines move when anything above them
 * is edited, and "this corpus entry is not a restatement" does not stop being
 * true because a paragraph was inserted earlier in the file. The rule's FACT
 * hash IS included, so changing the rule's own text re-opens the judgment —
 * the same property `pairSha` has, for the same reason.
 */
export function unpairedSha(entry, fact) {
  return factSha(`unpaired:${entry.rule}:${canonicalFile(entry.file)}:${fact?.sha ?? "no-fact"}`);
}

export function restatementPairs(corpus, rules, opts = {}) {
  const read = opts.readFile ?? ((f) => readTextSafe(f).text);
  const byId = new Map(rules.map((r) => [r.id, r]));
  const factCache = new Map(); // rule id -> fact|null, so an 11-file rule reads its own body once

  const pairs = [];
  const unpaired = [];

  for (const entry of corpus ?? []) {
    const rule = byId.get(entry.rule);
    if (!rule) {
      unpaired.push({ ...entry, pairSha: unpairedSha(entry, null), against: null, reason: `rule "${entry.rule}" is not among the loaded rules` });
      continue;
    }

    if (!factCache.has(rule.id)) factCache.set(rule.id, deriveRuleFact(rule, { readFile: read }));
    const fact = factCache.get(rule.id);
    if (!fact) {
      unpaired.push({ ...entry, pairSha: unpairedSha(entry, null), against: null, reason: `rule file unreadable or empty: ${rule.__file}` });
      continue;
    }

    let fileText;
    try {
      fileText = read(entry.file);
    } catch {
      fileText = null;
    }
    if (fileText == null) {
      unpaired.push({ ...entry, pairSha: unpairedSha(entry, fact), against: fact.sha, reason: `restating file unreadable: ${entry.file}` });
      continue;
    }

    let re;
    try {
      re = new RegExp(rule.fingerprint, "i");
    } catch (err) {
      unpaired.push({ ...entry, pairSha: unpairedSha(entry, fact), against: fact.sha, reason: `rule fingerprint does not compile: ${err.message}` });
      continue;
    }

    const found = findClaimBlock(fileText, entry.line, re);
    if (!found.block) {
      unpaired.push({ ...entry, pairSha: unpairedSha(entry, fact), against: fact.sha, reason: found.reason });
      continue;
    }

    pairs.push({
      claim: found.block,
      fact,
      file: entry.file,
      rule: rule.id,
      pairSha: factSha(`${found.block.sha}:${fact.sha}`),
    });
  }

  return { pairs, unpaired };
}

/**
 * Full status over the whole handed-to-us corpus: which pairs already carry a
 * verdict, which are awaiting one, and which entries could not be paired at
 * all.
 *
 * A verdict is looked up by `(file, block_sha, against)` rather than by
 * `block_sha` alone, because this lane spans MANY files (tool-priority alone
 * has 11) and two different files could in principle carry byte-identical
 * restated text — the store's `file` field disambiguates them, same as
 * `contradictStatus` gets for free by scoping its `readClaims` call to one
 * file. Here the store is read once, unscoped, because the corpus is
 * many-files-at-once by construction; scoping per file would mean re-reading
 * every shard once per file, which `judge.mjs`'s own batch-caller note already
 * measured as the expensive path (754ms vs 0ms for 499 files).
 *
 * @param {Array<{rule:string, file:string, line:number}>} corpus
 * @param {Array<{id:string, fingerprint:string, __file:string}>} rules
 * @param {{readFile?: (f:string)=>string, readClaims?: (filter:object)=>Promise<object>}} [opts]
 */
export async function restateStatus(corpus, rules, opts = {}) {
  const { pairs, unpaired } = restatementPairs(corpus, rules, opts);
  const readClaimsFn = opts.readClaims ?? readClaims;

  const { claims, storeExists } = await readClaimsFn({});
  // Latest verdict per (file, block_sha, against) — append-only store, so a
  // re-judgment is a newer record, never an edit. Same tie-break as
  // `latestByBlock`: ts, then claim_id (ULIDs sort lexicographically by mint
  // time within a millisecond).
  const sorted = [...claims]
    .filter((c) => c.against)
    .sort((a, b) => (a.ts === b.ts ? (a.claim_id < b.claim_id ? -1 : 1) : a.ts < b.ts ? -1 : 1));
  const judgedByKey = new Map();
  for (const c of sorted) judgedByKey.set(`${canonicalFile(c.file)}|${c.block_sha}|${c.against}`, c);

  const judged = [];
  const unjudged = [];
  for (const p of pairs) {
    const key = `${canonicalFile(p.file)}|${p.claim.sha}|${p.fact.sha}`;
    const verdict = judgedByKey.get(key);
    if (verdict) judged.push({ ...p, verdict });
    else unjudged.push(p);
  }

  // UNPAIRED ENTRIES ARE LOOKED UP TOO, AND THIS IS THE HALF OF THE FIX THAT
  // WAS MISSING. `unpairedSha` was added so an unpairable entry could carry a
  // verdict, and its unit test asserts the hash is "a valid block_sha, so a
  // verdict can key to it" — but nothing ever keyed one. This function built
  // `judgedByKey` and consulted it for `pairs` ONLY, returning `unpaired`
  // verbatim, so writing the 10 verdicts the lane exists to collect was inert
  // and the same 10 re-reported on every run. Identity built, tests green,
  // no consumer: `rule:enforcement-watches-itself`.
  //
  // THREE BUCKETS, NOT TWO (`rule:discernment-checks` §2). An entry with no
  // derived fact cannot be dispositioned at all — `validateClaim` refuses a
  // `finding` without an `against`, and there is no fact to be against when
  // the rule itself is missing or unreadable. That is a broken RULE, not an
  // unjudged claim, and folding it into "awaiting judgment" would advertise
  // work nobody can do. It gets its own bucket and its own name.
  const unpairedJudged = [];
  const unpairedAwaiting = [];
  const unpairedUndispositionable = [];
  for (const u of unpaired) {
    if (!u.against) { unpairedUndispositionable.push(u); continue; }
    const verdict = judgedByKey.get(`${canonicalFile(u.file)}|${u.pairSha}|${u.against}`);
    if (verdict) unpairedJudged.push({ ...u, verdict });
    else unpairedAwaiting.push(u);
  }

  return {
    storeExists,
    corpusCount: (corpus ?? []).length,
    factCount: new Set(pairs.map((p) => p.fact.sha)).size,
    pairs,
    judged,
    unjudged,
    // `unpaired` stays the FULL set: it is the answer to "what could not be
    // paired", which did not change. The three buckets answer the different
    // question of what is left to do about them.
    unpaired,
    unpairedJudged,
    unpairedAwaiting,
    unpairedUndispositionable,
  };
}

/**
 * The question set, in the shape a caller answers: does the claim still match
 * the fact it cites? Mirrors `judge.mjs`'s `asQuestions` — full text, not a
 * summary, and the sha a verdict must be keyed to, echoed back verbatim.
 */
export function asQuestions(status) {
  return status.unjudged.map((p) => ({
    pair_sha: p.pairSha,
    rule: p.rule,
    file: p.file,
    block_sha: p.claim.sha,
    against: p.fact.sha,
    startLine: p.claim.startLine,
    claim: p.claim.text,
    fact: p.fact.text,
  }));
}
