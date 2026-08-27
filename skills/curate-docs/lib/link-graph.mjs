/**
 * The inbound citation graph over a repo's markdown docs.
 *
 * The question is not "how central is this doc" but "does anything call it, and is the
 * caller itself reachable". PageRank was rejected and the rejection is in docs/DECISIONS.md:
 * one fan-out router linking 52 leaves hands every leaf a large inherited score while a
 * 478-line ARCHITECTURE.md with one inbound edge scores near zero — that ranks fan-out, not
 * importance.
 *
 * TWO MEASURES, both cheap and explainable:
 *   inDegree     does anything call it?                       0 -> ORPHAN
 *   hubDistance  minimum hops from ANY entry point            null -> DETACHED
 *
 * hubDistance is distance-from-seed, NOT out-depth. propagate GOTCHAS G45 records that exact
 * substitution as a defect in its own graph layer; the same error was available here.
 *
 * WHY THE EXTRACTOR IS NEW CODE. propagate's CITED_PATH matches BACKTICKED paths only,
 * requires an alphanumeric first character and requires a slash — so it cannot see
 * `[text](./a.md)`, `` `../TODOS.md` `` or `` `CLAUDE.md` ``. Measured on marketing-intel, the
 * narrow form produced 16 orphans of which 6 were false. It must stay narrow in propagate
 * (it admits .ts/.json/.sh/.yaml, where `feat/hero-v4-rebuild` and `0.0.0.0/0` produced 603
 * findings); anchored on `.md` and resolved against a path, these widenings cannot match those.
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { readStatus } from "./state.mjs";

/** Markdown inline links: [text](target). */
const MD_LINK = /\[[^\]\n]*\]\(\s*<?([^)>\s]+)>?(?:\s+"[^"]*")?\s*\)/g;
/** Backticked `.md` paths, with optional leading ./ or ../ and no slash required. */
const BACKTICKED = /`((?:\.{1,2}\/)*[A-Za-z0-9_][A-Za-z0-9_./()-]*\.md)`/g;

/** A file that declares itself machine-rendered. Kept narrow and anchored to the
 *  file HEAD so a doc merely discussing generated output is not swallowed. */
const GENERATED_RE = /\b(generated|derived on demand|auto-generated|do not hand-edit|do not edit)\b/i;

export function extractCitations(raw) {
  const cited = new Set();
  for (const m of raw.matchAll(MD_LINK)) cited.add(m[1]);
  // Backticks are scanned with markdown links REMOVED. STATE.md files here write their
  // linked-plan lists as [`2026-01-01-active.md`](./docs/plans/2026-01-01-active.md): the
  // label is a backticked basename that does not resolve from the citing doc's directory, so
  // scanning raw text reported the target as AMBIGUOUS while the link beside it resolved it.
  // One citation, two contradictory verdicts in one report.
  for (const m of raw.replace(MD_LINK, " ").matchAll(BACKTICKED)) cited.add(m[1]);
  return [...cited].filter((c) => {
    if (/^(https?:|mailto:|#|~)/.test(c)) return false;
    return c.split("#")[0].toLowerCase().endsWith(".md");
  });
}

/** macOS and Windows filesystems are case-insensitive; a JS Set is not. Without folding, a
 *  citation of `docs/README.md` when the file is `docs/Readme.md` misses the set, passes
 *  existsSync, and gets misfiled as external or dangling. */
const FOLD = process.platform === "darwin" || process.platform === "win32";
const key = (p) => (FOLD ? p.toLowerCase() : p);

/**
 * resolved | external | ambiguous | dangling.
 *
 * FOUR buckets, not two. A two-bucket version reported 23 "ambiguous" rows on
 * marketing-intel, most of them correct workspace-relative references such as CLAUDE.md
 * citing `../STATE.md`. A check that fires 23 times on correct input gets ignored, and then
 * it guards nothing (propagate GOTCHAS G23).
 *
 * There is deliberately NO unique-basename fallback: a basename match is reported as
 * `ambiguous`, never promoted to an edge. An exploratory pass that used one over-counted
 * `fixes.md` and `STATE.md`.
 */
function resolveCitation(cite, fromDir, root, index, byBasename, externalBases) {
  const target = cite.split("#")[0];
  const hits = [];
  for (const base of [fromDir, root]) {
    const abs = path.resolve(base, target);
    const found = index.get(key(abs));
    if (found && !hits.includes(found)) hits.push(found);
  }
  // Both bases resolving to DIFFERENT existing docs is genuine ambiguity, not a reason to
  // silently prefer whichever was tried first.
  if (hits.length === 1) return { status: "resolved", abs: hits[0] };
  if (hits.length > 1) return { status: "ambiguous", candidates: hits, reason: "resolves from two bases" };

  for (const base of [fromDir, root, ...externalBases]) {
    const abs = path.resolve(base, target);
    if (!abs.startsWith(root + path.sep) && existsSync(abs)) return { status: "external", abs };
  }
  const candidates = byBasename.get(path.basename(target).toLowerCase()) ?? [];
  if (candidates.length > 0) return { status: "ambiguous", candidates, reason: "basename exists at another path" };
  return { status: "dangling" };
}

/**
 * Entry points: opened directly, never cited. Zero in-degree is their normal state.
 *
 * They are BOTH orphan-exempt AND BFS seeds. Phase 1 made them exempt but not seeds, which
 * is why SSJK-mb (hub CLAUDE.md, no root README) and propagate (hub SKILL.md) would have
 * read as almost entirely detached. Measured across 7 repos, the hardcoded STATE.md hub was
 * correct in exactly one.
 */
function seedSet(root, docs, index, cfg) {
  if (cfg.hubSeeds === "none") return { seeds: [], reason: "hubSeeds: none" };
  if (Array.isArray(cfg.hubSeeds)) {
    const seeds = cfg.hubSeeds.map((s) => index.get(key(path.resolve(root, s)))).filter(Boolean);
    return { seeds, reason: `configured (${seeds.length}/${cfg.hubSeeds.length} present)` };
  }
  const candidates = [
    ...cfg.entryPoints.map((n) => path.join(root, n)),
    path.join(root, "docs/README.md"),
    path.join(root, "docs/index.md"),
  ];
  const seeds = [...new Set(candidates.map((c) => index.get(key(c))).filter(Boolean))];
  return { seeds, reason: seeds.length ? `auto (${seeds.map((s) => path.relative(root, s)).join(", ")})` : "auto" };
}

/** An Obsidian vault is a [[wikilink]] corpus this extractor cannot read. Analysing it would
 *  report a confident clean run over hundreds of invisible files — the exact failure this
 *  skill exists to catch. Refuse, and say why. */
export function detectVault(root) {
  return existsSync(path.join(root, ".obsidian"))
    ? { vault: true, why: "an .obsidian/ vault uses [[wikilink]] syntax, which this extractor cannot see" }
    : { vault: false };
}

export function buildLinkGraph(root, opts = {}) {
  const cfg = opts.cfg;
  const docs = opts.docs ?? [];
  const index = new Map(docs.map((d) => [key(d), d]));
  const byBasename = new Map();
  for (const d of docs) {
    const b = path.basename(d).toLowerCase();
    if (!byBasename.has(b)) byBasename.set(b, []);
    byBasename.get(b).push(d);
  }

  const nodes = new Map(
    docs.map((d) => {
      const st = readStatus(d, root, cfg);
      return [d, {
        path: d, inbound: [], outbound: [], inDegree: 0, hubDistance: null,
        unreadable: false, isEntryPoint: false, isSeed: false,
        status: st.status, statusSource: st.source, statusWhy: st.why, declared: st.declared,
      }];
    }),
  );
  const dangling = [], ambiguous = [], external = [];
  const externalBases = [path.dirname(root), ...(cfg.extraRoots ?? [])];

  for (const doc of docs) {
    let raw;
    try { raw = readFileSync(doc, "utf8"); } catch { nodes.get(doc).unreadable = true; continue; }
    // GENERATED ARTIFACTS are not authored documentation, so "nothing cites it"
    // is not a finding about them — they are re-rendered from state on every
    // tick and the only honest verdict is "regenerate it". Detected from the
    // file's OWN opening declaration, not a path list: a path rule must know
    // every generator's output location and goes stale the first time one
    // moves — which is exactly how a propagation edge ended up watching a
    // pointer stub. Head only, so prose ABOUT generated files is not caught.
    if (GENERATED_RE.test(raw.slice(0, 400))) nodes.get(doc).isGenerated = true;
    for (const cite of extractCitations(raw)) {
      const r = resolveCitation(cite, path.dirname(doc), root, index, byBasename, externalBases);
      if (r.status === "resolved") {
        if (r.abs === doc) continue; // a doc citing itself must not self-certify
        if (!nodes.get(r.abs).inbound.includes(doc)) nodes.get(r.abs).inbound.push(doc);
        if (!nodes.get(doc).outbound.includes(r.abs)) nodes.get(doc).outbound.push(r.abs);
      } else if (r.status === "external") external.push({ from: doc, cites: cite, resolvesTo: r.abs });
      else if (r.status === "ambiguous") ambiguous.push({ from: doc, cites: cite, candidates: r.candidates, reason: r.reason });
      else dangling.push({ from: doc, cites: cite });
    }
  }
  for (const n of nodes.values()) n.inDegree = n.inbound.length;

  const { seeds, reason: seedReason } = seedSet(root, docs, index, cfg);
  let allSeeds = [...seeds];
  // Under `auto`, a repo whose entry points link nothing still gets one chance: the doc that
  // actually routes. Without it, propagate-style repos (hub is docs/README.md) read as no-hub.
  if (cfg.hubSeeds === "auto" && !allSeeds.some((s) => nodes.get(s).outbound.length)) {
    const best = docs.filter((d) => nodes.get(d).outbound.length)
      .sort((a, b) => nodes.get(b).outbound.length - nodes.get(a).outbound.length)[0];
    if (best) allSeeds.push(best);
  }
  for (const s of allSeeds) nodes.get(s).isSeed = true;
  // Entry points are recognised by BASENAME AT ANY DEPTH, not only at the repo
  // root. `motherboard-api/CLAUDE.md` is found by exactly the same contract as
  // the root one — an agent walks UP from its working directory — so nothing
  // cites it and nothing should. Matching only `path.join(root, n)` reported 9
  // per-directory CLAUDE.md and 8 nested README.md as ORPHAN in Motherboard:
  // 17 of 30, every one a false positive, and the "fix" they invite is to add
  // fake citations to satisfy the metric.
  //
  // Deliberately basename-only. A path rule would need to know every nesting
  // convention in the tree; the filename IS the convention.
  // TWO CLASSES, and conflating them is a real bug the suite caught.
  //
  // AGENT-CONTEXT files are OPENED by tooling walking UP from a working
  // directory. That contract is identical at any depth, so
  // `motherboard-api/CLAUDE.md` is as much an entry point as the root one —
  // nothing cites it and nothing should. Matching these at root only reported 9
  // per-directory CLAUDE.md as ORPHAN in Motherboard, and the "fix" that invites
  // is to add fake citations to satisfy a metric.
  //
  // NAVIGATIONAL files (README.md, STATE.md, TODOS.md) stay ROOT-ONLY. A nested
  // `docs/README.md` is an INDEX, and "the index nobody links" is a true finding
  // — exempting it everywhere would swallow it, which is exactly what
  // tests/link-graph.test.mjs:162 asserts against. An earlier version of this
  // change did exactly that and went red there.
  const AGENT_CONTEXT = new Set(["CLAUDE.md", "AGENTS.md", "GEMINI.md"]);
  const rootEntry = new Set(cfg.entryPoints.map((n) => path.join(root, n)));
  for (const d of docs) {
    if (AGENT_CONTEXT.has(path.basename(d)) || rootEntry.has(d)) {
      nodes.get(d).isEntryPoint = true;
    }
  }


  // BFS from every seed at once. hubDistance = minimum hops from any of them.
  const queue = [];
  for (const s of allSeeds) { nodes.get(s).hubDistance = 0; queue.push(s); }
  while (queue.length) {
    const cur = queue.shift();
    const d = nodes.get(cur).hubDistance;
    for (const next of nodes.get(cur).outbound) {
      if (nodes.get(next).hubDistance === null) { nodes.get(next).hubDistance = d + 1; queue.push(next); }
    }
  }

  // A doc is GRADED unless it is an entry point, a seed, or declared not-live. An archived
  // doc is exempt from grading and NEVER from parsing — dropping it from the graph is what
  // removed its outbound edges and orphaned its children (the F1 cascade).
  const exempt = (d) => {
    const n = nodes.get(d);
    // NOTE: `isGenerated` is deliberately NOT consulted here. It is classified in
    // report.mjs:verdict(), which is the reader the CLI actually uses. Checking it
    // in both places is how the first attempt at this "worked" while changing
    // nothing — the flag was set, this predicate honoured it, and the classifier
    // never asked. One reader, or the next person debugs the same ghost.
    return n.isSeed || n.isEntryPoint || n.status === "archived" || n.status === "superseded";
  };
  const orphans = docs.filter((d) => !exempt(d) && nodes.get(d).inDegree === 0);
  const detached = docs.filter((d) => !exempt(d) && nodes.get(d).inDegree > 0 && nodes.get(d).hubDistance === null);
  const archived = docs.filter((d) => ["archived", "superseded"].includes(nodes.get(d).status));
  // A seed that nothing cites. Root entry points are excluded — CLAUDE.md is OPENED, not
  // navigated to. But a docs/README.md is an index, and "the index nobody links" is a real
  // finding that making it a seed would otherwise swallow: it works as a starting point only
  // for someone who already knows it exists.
  const unlinkedSeeds = allSeeds.filter(
    (s) => !nodes.get(s).isEntryPoint && nodes.get(s).inDegree === 0 && nodes.get(s).outbound.length > 0,
  );
  const unknownStatus = docs.filter((d) => nodes.get(d).status === "unknown");

  // A hub that reaches nothing is "abandoned automation reports healthy" in miniature: delete
  // the last hub link and a suppressing report goes quiet exactly when it matters most.
  const hubless = allSeeds.length === 0 || !allSeeds.some((s) => nodes.get(s).outbound.length);

  // An ambiguous citation whose basename resolves to exactly ONE doc is a LOST RELATIVE
  // PATH — the signature of a moved file. Reported as a repair suggestion, never promoted
  // to an edge: promoting it is the unique-basename fallback that over-counted `fixes.md`
  // and `STATE.md` in an earlier pass. Moving an archived doc breaks every relative link it
  // owns, which is why declaring `status:` is the archival act and the `git mv` is not.
  const relinkable = ambiguous
    .filter((a) => a.candidates.length === 1)
    .map((a) => ({ ...a, suggest: a.candidates[0] }));

  return {
    nodes, orphans, detached, archived, unknownStatus, unlinkedSeeds,
    dangling, ambiguous, external, relinkable,
    seeds: allSeeds, hubless,
    hubReason: hubless
      ? `none — ${allSeeds.length} candidate(s) present, none links another doc`
      : allSeeds.map((s) => path.relative(root, s)).join(", "),
    seedStrategy: seedReason,
  };
}
