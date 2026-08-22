/**
 * Provenance for one document — what makes a triage decision possible in one line.
 *
 * The verdict this skill drives toward is never "add a link". It is "declare a state":
 * active, archived, or superseded. propagate/lib/docs.mjs argues the counter-case and is
 * right about it — "PRIVACY-CONTENT.md was reachable from STATE.md, DECISIONS.md and
 * docs/README.md, and was still not read. Reachable is not read." Manufacturing an index
 * entry turns the number green without anyone deciding whether the doc should exist. So
 * reachability is only the DETECTOR here; this module supplies what the decision needs.
 *
 * Every field is attributed. A lookup that could not run says so (`"no-git"`, `"unknown"`)
 * and never returns a bare null that reads as "nothing found" — rule:discernment-checks §2.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

function git(root, args) {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15000,
    }).trim();
  } catch {
    return null;
  }
}

export function isGitRepo(root) {
  return git(root, ["rev-parse", "--is-inside-work-tree"]) === "true";
}

/** The commit that ADDED the file — the closest thing to "why was this created". */
export function introducedBy(root, abs) {
  if (!isGitRepo(root)) return { status: "no-git" };
  const rel = path.relative(root, abs);
  const out = git(root, ["log", "--diff-filter=A", "--follow", "-1", "--format=%H%x00%aI%x00%an%x00%s", "--", rel]);
  if (!out) return { status: "untracked-or-unknown" };
  const [sha, date, author, subject] = out.split("\0");
  return { status: "ok", sha, date, author, subject };
}

export function lastTouched(root, abs) {
  const rel = path.relative(root, abs);
  const d = isGitRepo(root) ? git(root, ["log", "-1", "--format=%aI", "--", rel]) : null;
  if (d) return { status: "ok", date: d, via: "git" };
  try {
    return { status: "ok", date: new Date(statSync(abs).mtimeMs).toISOString(), via: "mtime" };
  } catch {
    return { status: "unreadable", date: null, via: "none" };
  }
}

/** Which branches contain the introducing commit. Reported, never used to infer merged-ness:
 *  repos here squash-merge, so `origin/main..<branch>` lies. Use `git cherry` for that. */
export function branchesContaining(root, sha) {
  if (!sha || !isGitRepo(root)) return { status: "unknown", branches: [] };
  const out = git(root, ["branch", "--all", "--contains", sha, "--format=%(refname:short)"]);
  if (out === null) return { status: "unknown", branches: [] };
  return { status: "ok", branches: out.split("\n").map((s) => s.trim()).filter(Boolean) };
}

/**
 * Is this document mentioned anywhere that declares intent about it?
 * Searches the propagation sidecars and ledgers that govern the tree, plus the repo's own
 * decision log. A hit is the answer to "why does this exist"; a miss is itself a finding.
 */
/**
 * Does this text mention this exact path?
 *
 * Tokenised, not regex-matched. Two boundary attempts failed first, and both failures are
 * the reason this is a token scan: a bare `includes` reported the root `README.md` as
 * declared in STATE.md (because "docs/README.md" ends with it), and a left-boundary regex
 * then rejected the true hit `./docs/README.md` (because the preceding char is the "/" of
 * "./"). Comparing whole normalised tokens has neither failure mode.
 */
const PATHISH = /[A-Za-z0-9_.][A-Za-z0-9_./()-]*\.[A-Za-z0-9]+/g;

function normalise(tok) {
  return tok.replace(/^\.\//, "").replace(/[)`,;:]+$/, "");
}

export function pathTokens(text) {
  return new Set([...text.matchAll(PATHISH)].map((m) => normalise(m[0])));
}

function mentions(tokens, needle) {
  if (tokens.has(needle)) return true;
  // A citation may be relative to a deeper directory: "../docs/DECISIONS.md" for
  // "docs/DECISIONS.md". Accept only when the remainder after "../" runs is an exact match.
  for (const t of tokens) {
    const stripped = t.replace(/^(\.\.\/)+/, "");
    if (stripped === needle) return true;
  }
  return false;
}

export function declaredIn(root, abs, extraRoots = []) {
  const rel = path.relative(root, abs);
  const base = path.basename(abs);
  const hits = [];
  const weak = [];
  const sources = [];
  for (const r of [root, ...extraRoots]) {
    for (const f of [
      ".propagates.yml", "docs/.propagates.yml", ".propagates-cross.yml",
      "docs/PROPAGATION_LEDGER.jsonl", "docs/DECISIONS.md", "DECISIONS.md", "STATE.md",
    ]) {
      const p = path.join(r, f);
      if (!existsSync(p)) continue;
      sources.push(p);
      let toks;
      try { toks = pathTokens(readFileSync(p, "utf8")); } catch { continue; }
      // A path match is evidence. A bare BASENAME match is not — "README.md" occurs inside
      // "docs/README.md", which reported every root README as declared in STATE.md. Kept as
      // a separate, weaker bucket rather than dropped, so a rename is still visible.
      // Both matches need a LEFT BOUNDARY. A bare `includes` reported the root README.md
      // as declared in STATE.md, because "docs/README.md" contains "README.md" — the
      // check fired on a different file and read as evidence.
      if (mentions(toks, rel)) hits.push({ where: path.relative(root, p) || f, match: "path" });
      else if (mentions(toks, base)) weak.push({ where: path.relative(root, p) || f, match: "basename" });
    }
  }
  return { status: sources.length ? "ok" : "no-sources-found", hits, weak, searched: sources.length };
}

/**
 * The marketing-intel invariant, generalised: "every non-reference file in docs/ is either
 * linked from STATE.md or sits in docs/archive/." For a `plan`, THIS is the staleness
 * question — age is not, because a plan going quiet is correct.
 */
export function declaredState(root, abs, graph) {
  const relPosix = path.relative(root, abs).split(path.sep).join("/");
  if (/(^|\/)(archive|_archive)\//.test(relPosix)) return { state: "archived", why: "lives under archive/" };
  const hub = graph.hub;
  if (hub && graph.nodes.get(abs)?.inbound.includes(hub)) {
    return { state: "active", why: `linked from ${path.basename(hub)}` };
  }
  return { state: "undeclared", why: `not linked from ${hub ? path.basename(hub) : "any hub"} and not archived` };
}

export function ageDays(iso, now = Date.now()) {
  if (!iso) return null;
  return Math.floor((now - Date.parse(iso)) / 86_400_000);
}

/** Everything a triage decision needs about one orphan, gathered before anything is asked. */
export function gather(root, abs, graph, opts = {}) {
  const intro = introducedBy(root, abs);
  return {
    path: path.relative(root, abs).split(path.sep).join("/"),
    introducedBy: intro,
    branches: branchesContaining(root, intro.sha),
    lastTouched: lastTouched(root, abs),
    declaredIn: declaredIn(root, abs, opts.extraRoots ?? []),
    declaredState: declaredState(root, abs, graph),
  };
}
