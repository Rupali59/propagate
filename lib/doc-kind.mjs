/**
 * What KIND of document is this, and how do we know?
 *
 * Kind matters because it sets the staleness rule. A `plan` going quiet is correct — it
 * describes a change that finished. A `page-spec` going quiet is a defect — it describes
 * a surface that still exists. Nothing in this tree distinguished them, so every doc was
 * judged by the same (absent) standard.
 *
 * Kind is INFERRED where a convention is reliable and DECLARED where it is not. Measured
 * across 7 projects / 262 docs: 97 inferrable by filename, 95 by directory, 70 residue.
 * So the migration is 70 declarations, not 262.
 *
 * Inference alone is not enough, and the failure is instructive: a first classifier put
 * 17 Motherboard docs in "unclassified", and that bucket contained
 * `docs/sdk/{auth-model,env-vars,compatibility,path-forwarding}.md` — the most valuable
 * backend specs in the repo, invisible because they match nobody's naming convention.
 *
 * `undeclared` is therefore a VALUE, never a silence (rule:discernment-checks §2). The
 * residue is exactly where the taxonomy is wrong, so it has to be countable.
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

/**
 * The kinds, with the lifecycle each implies. Seven, derived from what the tree already
 * contains — not invented. Adding an eighth should require finding docs that fit none.
 */
export const KINDS = {
  "decision-log": "append-only; never edit a past entry, supersede it",
  state: "what is true now; rots fastest, so name commands not counts",
  plan: "a change over time; STALE BY DESIGN once it lands or is superseded",
  "page-spec": "governs one rendered surface; must never go stale silently",
  "functionality-spec": "governs a service, endpoint or schema; must never go stale",
  design: "design/IA intent; follows its surface",
  ops: "environment and deploy; stale when the deploy changes",
  router: "routes to other docs and must not restate them",
};

const DATED = /\d{4}-\d{2}-\d{2}/;

/** Frontmatter reader — same shape as rules/_check.mjs:45-57, which is proven. */
export function frontmatter(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  return meta;
}

/** Tier 1 — unambiguous from the filename alone. */
function byFilename(p) {
  const n = path.basename(p);
  if (n === "DECISIONS.md" || p.includes(`${path.sep}decisions${path.sep}`)) return "decision-log";
  if (["STATE.md", "TODOS.md", "CHANGELOG.md"].includes(n)) return "state";
  if (p.includes(`${path.sep}plans${path.sep}`) && DATED.test(n)) return "plan";
  if (n === "README.md") return "router";
  return null;
}

/** Tier 2 — directory conventions. Weaker than tier 1, still better than guessing. */
function byDirectory(p) {
  const s = p.split(path.sep).join("/");
  const n = path.basename(p).toUpperCase();
  if (s.includes("/content/")) return "page-spec";
  if (s.includes("/design-process/") || s.includes("/design/") || s.includes("/ia/")) return "design";
  if (s.includes("/sdk/") || s.includes("/specs/")) return "functionality-spec";
  if (s.toLowerCase().includes("runbook") || n.startsWith("DEPLOY") || n.startsWith("ENV") || n.startsWith("INFRA"))
    return "ops";
  return null;
}

/**
 * Resolve a document's kind.
 *
 * Precedence is deliberate and must not reverse: **frontmatter always wins**. Inference
 * is a default for docs nobody has classified, never an override of someone who did.
 *
 * @returns {{kind: string|null, source: "frontmatter"|"filename"|"directory"|"undeclared", supersedes: string[]}}
 */
export function kindOf(filePath, readFile = (p) => readFileSync(p, "utf8")) {
  let meta = null;
  try {
    meta = frontmatter(readFile(filePath));
  } catch {
    meta = null; // unreadable is not undeclared, but the caller sees kind:null either way
  }

  const supersedes = parseSupersedes(meta?.supersedes);

  if (meta?.kind) {
    return { kind: meta.kind, source: "frontmatter", supersedes };
  }
  const f = byFilename(filePath);
  if (f) return { kind: f, source: "filename", supersedes };
  const d = byDirectory(filePath);
  if (d) return { kind: d, source: "directory", supersedes };
  return { kind: null, source: "undeclared", supersedes };
}

/** `supersedes: [a.md, b.md#section]` or a bare scalar. Always an array out. */
export function parseSupersedes(value) {
  if (!value) return [];
  const inner = /^\[(.*)\]$/.exec(value.trim());
  const raw = inner ? inner[1] : value;
  return raw
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

/**
 * Docs that CLAIM supersession in prose without declaring it.
 *
 * 75 of 105 supersession claims in this tree name no file — "supersedes v1 of the same
 * date", "Supersedes the 2026-06-14 Vipin lock". Unfollowable by machine, and one-way, so
 * the superseded document never learns. That is how `DECISIONS.md` 2026-06-21 still reads
 * as current after `PRIVACY-CONTENT.md:250` overruled it.
 */
export function proseOnlySupersession(filePath, readFile = (p) => readFileSync(p, "utf8")) {
  let raw;
  try {
    raw = readFile(filePath);
  } catch {
    return null; // unreadable — not a finding, and must not masquerade as clean
  }
  const meta = frontmatter(raw);
  if (parseSupersedes(meta?.supersedes).length > 0) return null; // declared
  const body = meta ? raw.slice(raw.indexOf("---", 3) + 3) : raw;
  const hits = body
    .split(/\r?\n/)
    .map((l, i) => ({ line: i + 1, text: l.trim() }))
    .filter((l) => /supersede/i.test(l.text));
  return hits.length ? { file: filePath, hits } : null;
}

/**
 * Invert declared supersessions: "what overrules THIS document?"
 *
 * This is the bidirectionality, derived rather than migrated — the superseded file never
 * has to be edited, which matters when the superseded thing is an append-only decision
 * log that must not be rewritten.
 */
export function buildSupersessionIndex(docPaths, readFile = (p) => readFileSync(p, "utf8")) {
  const overruledBy = new Map();
  for (const doc of docPaths) {
    const { supersedes } = kindOf(doc, readFile);
    for (const target of supersedes) {
      const [rel] = target.split("#");
      const abs = path.resolve(path.dirname(doc), rel);
      if (!overruledBy.has(abs)) overruledBy.set(abs, []);
      overruledBy.get(abs).push({ by: doc, anchor: target.includes("#") ? target.split("#")[1] : null });
    }
  }
  return overruledBy;
}

/**
 * Path citations in a doc that resolve nowhere.
 *
 * The naive version of this check is worse than useless. A first pass — "any backticked
 * string containing a slash" — reported **603 broken citations across 6 projects, 438 in
 * one**. Sampling the top offenders: `feat/hero-v4-rebuild` (a git branch),
 * `archive/main-2026-05-22` (a tag), `0.0.0.0/0` (a CIDR), `next/image` (a module
 * specifier), and `docs/constitution/VIPIN.md` (correct, but relative to the WORKSPACE
 * root, not the project root). Almost none were paths, and none of those were broken.
 *
 * So the rule is deliberately narrow:
 *   - must carry a known file extension, or end in `/` — this alone removes branches,
 *     tags, CIDRs and bare module specifiers
 *   - resolved against the doc's own directory, the project root, AND the workspace root
 *     before being called broken
 *
 * A check that fires 438 times gets ignored, and then it guards nothing (GOTCHAS G23).
 * Verified against sanskrit-texts, where all 11 `Hora/` citations are genuinely dead
 * after the 2026-08-12 recategorisation moved every text under
 * `Hora/{Jaimini,Nadi,Parashari,Prashna}/`.
 */
const CITED_PATH = /`([A-Za-z0-9_][A-Za-z0-9_./()-]*\/[A-Za-z0-9_./()-]+)`/g;
const FILE_EXT = /\.(md|ts|tsx|js|mjs|cjs|json|ya?ml|py|sh|css|txt|sql|toml)$/i;

export function brokenPathCitations(docPath, roots, readFile = (p) => readFileSync(p, "utf8"), opts = {}) {
  let raw;
  try {
    raw = readFile(docPath);
  } catch {
    return null; // unreadable — not a finding, and must not read as clean
  }
  const bases = [path.dirname(docPath), ...roots];
  const broken = [];

  // Citations appear in two forms. Backticked prose is the common one. The other is a
  // markdown TABLE CELL holding nothing but a path — `sanskrit-texts/CLAUDE.md` documents
  // its whole corpus that way, and all 11 of its `Hora/` rows went dead in one rename
  // without this check seeing a thing.
  //
  // Table cells are admitted only when the ENTIRE cell is the path: no spaces, no prose.
  // That, plus the same extension-or-trailing-slash rule, is what keeps the noise out —
  // the 603-finding version failed on branches and CIDRs, not on where it looked.
  const cited = [...raw.matchAll(CITED_PATH)].map((m) => m[1]);
  // OFF BY DEFAULT — measured, not assumed. See the note above `TABLE_CELLS_ARE_OPT_IN`.
  if (opts.tables) for (const line of raw.split(/\r?\n/)) {
    if (!line.trimStart().startsWith("|")) continue;
    for (const cell of line.split("|").map((c) => c.trim())) {
      if (!cell || /\s/.test(cell)) continue;
      // A leading "/" is a URL route, not a repo path ("/astrology/", "/api/x").
      if (cell.startsWith("/")) continue;
      if (cell.includes("/")) cited.push(cell.replace(/^`|`$/g, ""));
    }
  }

  for (const c of cited) {
    const cited_ = c;
    if (cited_.startsWith("http") || cited_.startsWith("~")) continue;
    // A directory reference ends in "/"; anything else must look like a file.
    if (!cited_.endsWith("/") && !FILE_EXT.test(cited_)) continue;
    const target = cited_.replace(/\/$/, "");
    if (bases.some((b) => existsSync(path.resolve(b, target)))) continue;
    if (!broken.includes(cited_)) broken.push(cited_);
  }
  return broken;
}
