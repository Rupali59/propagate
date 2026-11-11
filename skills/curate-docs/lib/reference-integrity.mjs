/**
 * Reference integrity for design docs (propagate#242, step 9 of the design workflow).
 *
 * A design doc asserts that things exist: components, tokens, files. When the doc says
 * `GateOnlineGuard` and the code has no such name, the decided design never reached the
 * build, and nothing else notices. This resolves every NAME the doc asserts against the
 * repo the doc lives in.
 *
 * WHAT COUNTS AS AN ASSERTION. Only a backticked span in the body, in one of two strict
 * classes (multi-hump identifier, file path). Prose words, single words and hex colours
 * are never extracted: a loose extractor reports a hundred false names and the check gets
 * switched off. `blind` is the loud answer when NOTHING is extracted, so a doc the
 * extractor did not understand never reads as clean (rule:discernment-checks §6).
 *
 * WHAT COUNTS AS RESOLVING. An identifier resolves only as a whole word in COMMENT-STRIPPED
 * source. Sindhu's `GateOnlineGuard` was cited only in comments; a raw grep called it present.
 * A path resolves when it exists relative to the doc or the repo root, or matches a tracked
 * basename (docs cite `tokens.dart` without a directory).
 *
 * I/O is injected (`io`), so tests drive literal fixtures. `realIO(repoRoot)` is the
 * production reader.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

/** Multi-hump identifiers: UpperCamel with two humps, or lowerCamel. */
export const IDENTIFIER_CLASSES = [/^[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*$/, /^[a-z]+[A-Z][A-Za-z0-9]*$/];
/** File paths with a known extension. */
export const PATH_CLASS = /^[\w.\/-]+\.(dart|ts|tsx|js|jsx|mjs|css|scss|md|json|yaml|yml|sh|arb|png|svg)$/;
/** Source files an identifier may resolve in. Markdown is excluded on purpose: a doc
 *  citing another doc is not the build having received the name. */
export const SOURCE_EXTS = ["dart", "ts", "tsx", "js", "jsx", "mjs", "css", "scss"];
/** Directory segments never searched. */
export const EXCLUDE_DIRS = ["node_modules", "build", ".dart_tool", ".next", ".git", ".claude", ".worktrees"];

const MAX_NAMES_SHOWN = 5;

/** Split frontmatter from body. `designed-not-built` is read here, as a block or inline list. */
export function splitDoc(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) return { body: raw, exempt: [] };
  const exempt = [];
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const k = /^designed-not-built:\s*(.*)$/.exec(lines[i]);
    if (!k) continue;
    const inline = /^\[(.*)\]$/.exec(k[1].trim());
    if (inline) {
      for (const v of inline[1].split(",")) exempt.push(v.trim().replace(/^["'`]|["'`]$/g, ""));
    } else {
      for (let j = i + 1; j < lines.length; j++) {
        const item = /^\s*-\s*(.+?)\s*$/.exec(lines[j]);
        if (!item) break;
        exempt.push(item[1].replace(/^["'`]|["'`]$/g, ""));
      }
    }
  }
  return { body: raw.slice(m[0].length), exempt: exempt.filter(Boolean) };
}

/** Backticked spans of the body that fall in one of the two strict classes. Deduplicated. */
export function extractNames(body) {
  const identifiers = new Set();
  const paths = new Set();
  for (const m of body.matchAll(/`([^`\n]+)`/g)) {
    const span = m[1].trim();
    if (PATH_CLASS.test(span)) paths.add(span);
    else if (IDENTIFIER_CLASSES.some((rx) => rx.test(span))) identifiers.add(span);
  }
  return { identifiers: [...identifiers], paths: [...paths] };
}

/** Remove `//`, `///` and block comments, leaving string literals intact (so `"http://x"`
 *  survives). Quote strings end at a newline, bounding the damage of a regex literal. */
export function stripComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && src[i] !== "\n") i++;
    } else if (c === "/" && d === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) { if (src[i] === "\n") out += "\n"; i++; }
      i += 2;
    } else if (c === '"' || c === "'" || c === "`") {
      out += c;
      i++;
      while (i < n) {
        if (src[i] === "\\") { out += src[i] + (src[i + 1] ?? ""); i += 2; continue; }
        if (src[i] === c) { out += c; i++; break; }
        if (src[i] === "\n" && c !== "`") break;
        out += src[i++];
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const TOKEN = /[A-Za-z_$][A-Za-z0-9_$]*/g;

/**
 * @param {{docText: string, docDir: string, repoRoot: string, io: object}} a
 *   io.sources(): [{rel, text}] source files, unstripped
 *   io.exists(abs): boolean
 *   io.trackedBasenames(): Set<string>
 * @returns {{asserted: string[], unresolved: string[], staleExemptions: string[], blind: boolean}}
 */
export function checkReferences({ docText, docDir, repoRoot, io }) {
  const { body, exempt } = splitDoc(docText);
  const { identifiers, paths } = extractNames(body);
  const asserted = [...identifiers, ...paths];
  const exemptSet = new Set(exempt);

  let tokens = null;
  const hasToken = (name) => {
    if (!tokens) {
      tokens = new Set();
      for (const f of io.sources()) for (const t of stripComments(f.text).match(TOKEN) ?? []) tokens.add(t);
    }
    return tokens.has(name);
  };
  let basenames = null;
  const hasPath = (p) => {
    if (io.exists(path.resolve(docDir, p)) || io.exists(path.resolve(repoRoot, p))) return true;
    basenames ??= io.trackedBasenames();
    return basenames.has(path.basename(p));
  };
  const resolves = (name) => (PATH_CLASS.test(name) ? hasPath(name) : hasToken(name));

  const unresolved = asserted.filter((n) => !exemptSet.has(n) && !resolves(n));
  const staleExemptions = exempt.filter((n) => resolves(n));
  return { asserted, unresolved, staleExemptions, blind: asserted.length === 0 };
}

/** Production reader for one repo. `git ls-files` (tracked plus untracked-not-ignored) so
 *  uncommitted code counts; a filesystem walk when git is not there. */
export function realIO(repoRoot) {
  let files = null;
  const list = () => {
    if (files) return files;
    let rels;
    try {
      rels = execFileSync("git", ["-C", repoRoot, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
        encoding: "utf8", maxBuffer: 256 * 1024 * 1024,
      }).split("\0").filter(Boolean);
    } catch {
      rels = [];
      const walk = (dir) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          if (EXCLUDE_DIRS.includes(e.name)) continue;
          const abs = path.join(dir, e.name);
          if (e.isDirectory()) walk(abs);
          else rels.push(path.relative(repoRoot, abs).split(path.sep).join("/"));
        }
      };
      walk(repoRoot);
    }
    files = rels.filter((r) => !r.split("/").some((seg) => EXCLUDE_DIRS.includes(seg)));
    return files;
  };
  return {
    sources() {
      return list()
        .filter((r) => SOURCE_EXTS.includes(path.extname(r).slice(1)))
        .flatMap((rel) => {
          const abs = path.join(repoRoot, rel);
          try {
            if (!existsSync(abs) || statSync(abs).size > 2_000_000) return [];
            return [{ rel, text: readFileSync(abs, "utf8") }];
          } catch { return []; }
        });
    },
    exists: (abs) => existsSync(abs),
    trackedBasenames: () => new Set(list().map((r) => path.basename(r))),
  };
}

/** The git toplevel of a directory, or the given fallback. */
export function repoRootOf(dir, fallback) {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return fallback;
  }
}

/** One-line rendering of a name list, capped. */
export function nameList(names) {
  const shown = names.slice(0, MAX_NAMES_SHOWN).map((n) => `\`${n}\``).join(", ");
  return names.length > MAX_NAMES_SHOWN ? `${shown} (+${names.length - MAX_NAMES_SHOWN} more)` : shown;
}
