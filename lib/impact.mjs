/**
 * What breaks if this document goes away?
 *
 * This module exists because nothing answered that question, and the absence had a measured
 * cost: archiving one doc in a hub -> A -> {B,C} tree produced two new orphans and a dangling
 * citation, none attributed to the action. `impact` is the check you run BEFORE acting, so
 * the consequence is a decision rather than a discovery three findings later.
 *
 * The load-bearing set is `soleCallerOf`: documents whose ONLY inbound edge is this one.
 * Those are the docs that become orphans the moment this one stops citing them. Everything
 * else in the report is context.
 */

import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * @param {string} doc absolute path
 * @param {ReturnType<import("./link-graph.mjs").buildLinkGraph>} graph
 * @returns {{path:string, exists:boolean, status:string, callers:string[], reaches:string[],
 *            soleCallerOf:string[], alreadyReachedOtherwise:string[]}}
 */
export function impact(doc, graph) {
  const node = graph.nodes.get(doc);
  if (!node) return { path: doc, exists: false, status: "not-a-known-doc", callers: [], reaches: [], soleCallerOf: [], alreadyReachedOtherwise: [] };

  const soleCallerOf = [];
  const alreadyReachedOtherwise = [];
  for (const target of node.outbound) {
    const t = graph.nodes.get(target);
    if (!t) continue;
    // "Only inbound edge" means literally that: remove this doc and in-degree hits zero.
    if (t.inbound.length === 1 && t.inbound[0] === doc) soleCallerOf.push(target);
    else alreadyReachedOtherwise.push(target);
  }

  return {
    path: doc,
    exists: true,
    status: node.status,
    callers: [...node.inbound],
    reaches: [...node.outbound],
    soleCallerOf,
    alreadyReachedOtherwise,
  };
}

/**
 * Which NON-markdown files cite this document?
 *
 * The link graph is `.md` -> `.md` by design, so a doc cited only from code is invisible to
 * it and reads as a drainable orphan. Found on a real triage:
 * `docs/plans/2026-07-10-jyotish-entity-ontology.md` was cited by five `.ts` files as the
 * authority for a live resolver, and nothing in the graph could see it.
 *
 * Cheap: one `git grep` for the path and the basename. Absent git, returns `unknown` — which
 * `drainPrecheck` treats as a refusal, because "I could not check" must never read as "safe".
 */
export function citedFromCode(doc, root) {
  const rel = path.relative(root, doc).split(path.sep).join("/");
  const base = path.basename(doc);
  try {
    const out = execFileSync(
      "git", ["-C", root, "grep", "-l", "-F", "-e", rel, "-e", base, "--", ":!*.md"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return { status: "ok", files: out.split("\n").filter(Boolean) };
  } catch (e) {
    // git grep exits 1 when there are no matches — that is a real "no", not a failure.
    if (e.status === 1) return { status: "ok", files: [] };
    return { status: "unknown", files: [], why: "git unavailable — could not check code citations" };
  }
}

/**
 * May this document be drained (deleted)?
 *
 * TWO preconditions, ENFORCED rather than documented. You cannot delete what you have not
 * declared dead, and you cannot delete something another document depends on for its only
 * reachability. Ordering the pipeline is worth nothing if the tool does not hold the order.
 *
 * @returns {{ok:boolean, refusals:string[], impact:object}}
 */
export function drainPrecheck(doc, graph, root) {
  const rel = (p) => path.relative(root, p).split(path.sep).join("/");
  const i = impact(doc, graph);
  const refusals = [];

  if (!i.exists) {
    refusals.push(`${rel(doc)} is not among the discovered documents`);
    return { ok: false, refusals, impact: i };
  }
  if (!["archived", "superseded"].includes(i.status)) {
    refusals.push(
      `${rel(doc)} has status "${i.status}" — declare it archived or superseded first. ` +
        `Salvage happens between declaring and draining, and skipping it deletes content nobody read.`,
    );
  }
  const code = citedFromCode(doc, root);
  if (code.status === "unknown") {
    refusals.push(`could not check whether code cites ${rel(doc)} (${code.why}) — refusing rather than guessing`);
  } else if (code.files.length) {
    refusals.push(
      `${rel(doc)} is cited from code by ${code.files.length} file(s): ${code.files.slice(0, 6).join(", ")} — ` +
        `the .md graph cannot see those. Repoint or remove them first.`,
    );
  }
  if (i.soleCallerOf.length) {
    refusals.push(
      `${rel(doc)} is the only document citing ${i.soleCallerOf.length}: ` +
        `${i.soleCallerOf.map(rel).join(", ")} — draining it orphans them.`,
    );
  }
  return { ok: refusals.length === 0, refusals, impact: i, citedFromCode: code };
}
