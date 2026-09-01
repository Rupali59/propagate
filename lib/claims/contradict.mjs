/**
 * lib/claims/contradict.mjs — hold an AUTHORED claim against a DERIVED fact.
 *
 * This is the lane the whole two-file design was for. `NORTH_STAR.md` states what
 * the tree is building toward; `ECOSYSTEM.md` states what exists. Neither can
 * check the other on its own, and prose has no compiler — two sentences in two
 * files contradict each other indefinitely and both read as true
 * (`rule:adversarial-review-reads-the-ledger`). This pairs them so the
 * disagreement becomes a question somebody is asked.
 *
 * IT RUNS NO MODEL, same as every other file here. propagate's dependency list is
 * ajv, proper-lockfile, yaml. This module does the two mechanical halves —
 * deriving atomic facts, and pairing each claim with the facts it could possibly
 * be about — and hands the pairs out. Deciding whether a claim CONTRADICTS a fact
 * is judgment and belongs to the caller.
 *
 * FACTS ARE ATOMS, NOT SECTIONS. A fact is one checkable statement with its own
 * hash: "propagate: layout non-conformant, missing 4 of 5 required items", not
 * the whole rendered workspace section. Hashing a section would mean every fact
 * about a workspace changes whenever any one of them does, re-opening judgments
 * that were still correct — the same reason block identity is per-block and not
 * per-file.
 *
 * PAIRING IS BY OWNER, AND THAT BOUND IS LOAD-BEARING. `NORTH_STAR.md` has ~50
 * judgeable blocks and the rollup derives ~5 facts per workspace across 16
 * workspaces. All-pairs is ~4,000 judgments, which nobody will ever make, so the
 * feature would be built and unused — `rule:enforcement-watches-itself` lists
 * nine such mechanisms already. Pairing only a claim that NAMES a workspace with
 * facts ABOUT that workspace takes it to a few dozen. Claims naming no workspace
 * are reported as UNPAIRED rather than dropped: "this claim could not be checked
 * against anything" is a finding, not an omission.
 *
 * The verdict is stored by `against` + `finding` on an ordinary claim record, so
 * this needs no second store and no schema change — that is why those two fields
 * exist and travel together.
 */
import { createHash } from "node:crypto";

import { splitBlocks } from "./blocks.mjs";
import { readClaims, latestByBlock, canonicalFile } from "./store.mjs";

/** sha256 of a fact's canonical sentence — the same primitive block identity uses. */
export function factSha(text) {
  return createHash("sha256").update(String(text ?? "").replace(/\s+/gu, " ").trim(), "utf8").digest("hex");
}

/**
 * Turn one rollup result into atomic, checkable facts.
 *
 * Derived from the rollup's DATA, never from its rendered markdown. Parsing our
 * own output would make every cosmetic change to the render re-open every
 * judgment, and would couple this to a format that exists for humans.
 *
 * @returns {Array<{sha:string, owner:string, kind:string, text:string}>}
 */
export function deriveFacts(rollupResult) {
  const facts = [];
  const add = (owner, kind, text) => facts.push({ sha: factSha(text), owner, kind, text });

  for (const o of rollupResult?.perOwner ?? []) {
    const name = o.display ?? o.owner;

    if (o.layout) {
      add(
        name,
        "layout",
        o.layout.conforms
          ? `${name}: propagation layout is conformant.`
          : `${name}: propagation layout is NON-CONFORMANT, missing ${o.layout.missing.length} required item(s): ${o.layout.missing.join(", ")}.`,
      );
    }
    // Counts are facts here in a way they are NOT in a state file: this whole
    // structure is re-derived on every run, so `rule:state-and-decisions`'s "a
    // count rots faster than anything else" does not bite — nothing stores them.
    add(name, "open", `${name}: ${o.items?.length ?? 0} open item(s) in its own registers.`);
    add(name, "built", `${name}: ${o.built?.length ?? 0} built artifact(s) discovered.`);
    if ((o.crossFiled?.length ?? 0) > 0) {
      add(name, "cross-filed", `${name}: ${o.crossFiled.length} open item(s) filed elsewhere name it.`);
    }
    if (o.hasNoRegister) {
      add(name, "no-register", `${name}: has no STATE.md / TODOS.md / ISSUES.md register at all.`);
    }
  }
  return facts;
}

/**
 * Does this claim name this owner? Path-shaped OR a bare word.
 *
 * Deliberately LOOSER than `crossFiledByOwner`'s path-only test, and the
 * difference is principled. There, a loose match published a misleading count in
 * a generated file (Rupali 75, propagate 46) with nobody in the loop. Here every
 * pair becomes a QUESTION a human or agent answers, so a false pair costs one
 * "unrelated" verdict — recorded once, never asked again — while a missed pair
 * silently loses a real contradiction. The asymmetry runs the other way, so the
 * threshold should too.
 */
function claimNamesOwner(text, owner) {
  const t = String(text ?? "").toLowerCase();
  const o = String(owner ?? "").toLowerCase();
  if (!t || !o) return false;
  if (t.includes(`${o}/`)) return true;
  // Word-boundary-ish: avoid `Keerti` matching inside `Keerti-portfolio` only by
  // accident, while still catching prose that names the workspace plainly.
  return new RegExp(`(^|[^a-z0-9])${o.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i").test(t);
}

/**
 * Pair each authored claim with the derived facts it could be about.
 *
 * @returns {{pairs: Array<{claim:object, fact:object, pairSha:string}>,
 *            unpaired: Array<object>}}
 */
export function pairClaims(blocks, facts) {
  const pairs = [];
  const unpaired = [];
  for (const b of blocks) {
    if (!b.judgeable) continue;
    const matched = facts.filter((f) => claimNamesOwner(b.text, f.owner));
    if (matched.length === 0) {
      // Not a failure — most constitutional prose names no workspace. But it is
      // a state worth reporting: this claim cannot be checked against anything.
      unpaired.push(b);
      continue;
    }
    for (const f of matched) {
      // A VISIBLE separator, not the NUL that `edgeId` joins with. Both inputs are
      // fixed-width 64-hex so neither can collide either way, and a literal NUL in
      // source is what N33 exists about — three lib/*.mjs once carried one and were
      // invisible to code search until a portability test caught them. This line
      // had a NUL for about ten minutes for exactly that reason: reaching for
      // edgeId's idiom without noticing the idiom is about RUNTIME joining, not
      // about typing the byte into a file.
      pairs.push({ claim: b, fact: f, pairSha: factSha(`${b.sha}:${f.sha}`) });
    }
  }
  return { pairs, unpaired };
}

/**
 * Full status: which pairs are already judged, which are awaiting judgment.
 *
 * A pair is judged when a verdict exists whose `block_sha` is the claim and whose
 * `against` is the fact. Because both are content hashes, editing EITHER side
 * re-opens that pair and only that pair — an amended constitution does not
 * invalidate judgments about workspaces it did not mention, and a workspace
 * gaining an open item does not re-open judgments about its layout.
 */
export async function contradictStatus(authoredFile, rollupResult, opts = {}) {
  const read = opts.readFile;
  let text;
  try {
    text = read ? read(authoredFile) : (await import("../report/backlog.mjs")).readTextSafe(authoredFile).text;
  } catch (err) {
    return { file: authoredFile, error: `unreadable: ${err.message}` };
  }
  if (text == null) return { file: authoredFile, error: "unreadable: no content returned" };

  const facts = deriveFacts(rollupResult);
  const { pairs, unpaired } = pairClaims(splitBlocks(text), facts);

  const { claims, storeExists } = await readClaims({ file: canonicalFile(authoredFile) });
  const judgedPairs = new Set(
    claims.filter((c) => c.against).map((c) => `${c.block_sha}${c.against}`),
  );

  const judged = [];
  const unjudged = [];
  for (const p of pairs) {
    if (judgedPairs.has(`${p.claim.sha}${p.fact.sha}`)) judged.push(p);
    else unjudged.push(p);
  }

  return {
    file: authoredFile,
    error: null,
    storeExists,
    factCount: facts.length,
    judged,
    unjudged,
    unpaired,
  };
}

/**
 * KNOWN LIMIT, measured on first run and stated rather than hidden.
 *
 * Against the live tree: 64 derived facts, ~50 judgeable claims in NORTH_STAR.md,
 * **132 pairs** and 14 unpaired. Many of those pairs are semantically empty — a
 * DEFINITIONAL claim ("the ecosystem is Motherboard plus its clients") is paired
 * with a COUNT fact ("Motherboard: 1 built artifact discovered") because the claim
 * names that workspace. The only sane verdict is `unrelated`.
 *
 * It is deliberately NOT narrowed by a heuristic. Deciding "could this claim and
 * this fact plausibly interact" is judgment, and seven times in this work a
 * judgment call implemented as a matcher failed in one direction or the other:
 * N35 too narrow, N63 too broad, a date suppressor both, a -maxdepth 2, an
 * authority: counsel edge, a cross-filed substring match, and this. Guessing an
 * eighth time would produce a filter nobody trusts.
 *
 * The cost of the loose bound is bounded and one-time: a false pair costs one
 * `unrelated` verdict, recorded once and never asked again. The cost of a wrong
 * narrow bound is a contradiction that is never surfaced at all. Given that
 * asymmetry, loose is the right starting point — and if the `unrelated` verdicts
 * cluster by fact `kind`, that is EVIDENCE for a principled narrowing rather than
 * a guess at one.
 */
