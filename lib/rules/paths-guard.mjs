/**
 * paths-guard.mjs — a `paths:` glob on a user-level rule that can never load it.
 *
 * WHY. A rule scoped with `paths:` is loaded only when a matching file is read in the
 * session's project. A glob with a typo (`*.tests.*`), a wrong prefix, or a target that
 * `permissions.deny` forbids Claude from reading means the rule silently never loads
 * again — no error, no warning, the rule just stops existing. Nothing else checks it
 * (rule:discernment-checks §1: a missing check leaves a hole nobody can see).
 *
 * WHAT IS CHECKED, for EVERY `.md` in the rules dir that has a `paths:` key — NOT gated
 * on `id`/`fingerprint` the way `loadRules` is, because a scoped companion file has
 * neither and is exactly the file this exists for:
 *
 *   1. `paths` is a non-empty array of non-empty strings.
 *   2. Every entry starts with `**\/`. User-level rules have no project root; the T1
 *      measurement (plan budget-1-rules-headroom, 2026-10-02) found globs resolve against
 *      the session's PROJECT, so an anchored `src/**` can only match by accident.
 *   3. Every entry matches at least one file under the search roots.
 *   4. Every entry matches at least one file that is not covered by a
 *      `permissions.deny` `Read(...)` pattern. A glob whose only targets are denied is
 *      dead by construction: Claude can never read them, so the trigger never fires.
 *
 * THE FLOOR. The walker skips heavy directories and caps depth, so a wrong root or a
 * broken walk would match nothing and "fail" every glob — or, worse, a bug that matched
 * everything would pass them. If fewer than `minFiles` files were walked the scan is
 * reported `blind`, never `pass` and never a per-glob verdict. "Matched nothing" and
 * "looked at nothing" are different facts (rule:derive-dont-curate, rule:discernment-checks §2).
 *
 * STATUS. `none` (no scoped rules) · `pass` · `fail` · `unknown` (a configured root is
 * missing or unreadable — the scan was incomplete, which is not a pass) · `blind`.
 *
 * KNOWN LIMIT, stated rather than closed over: this uses its own glob-to-regex, not
 * Claude Code's picomatch. Exotic syntax (extglobs, character classes) is treated
 * literally. A glob that matches a file here may still behave differently there.
 *
 * Read-only. Prints nothing.
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";

const SKIP = new Set([
  "node_modules", ".git", ".venv", "venv", "site-packages", ".next", "dist", "build", ".worktrees",
  ".turbo", ".vercel", "Library", "Trash",
]);

/** Fewer files than this means the walk went blind, not that globs are dead. */
export const DEFAULT_MIN_FILES = 100;

/** Glob -> RegExp over `/`-separated paths. `**\/` is zero or more directories. */
export function globToRegExp(glob) {
  let re = "";
  let i = 0;
  let braceDepth = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      re += "[^/]";
      i += 1;
    } else if (c === "{") {
      braceDepth += 1;
      re += "(?:";
      i += 1;
    } else if (c === "}" && braceDepth > 0) {
      braceDepth -= 1;
      re += ")";
      i += 1;
    } else if (c === "," && braceDepth > 0) {
      re += "|";
      i += 1;
    } else {
      re += c.replace(/[.+^$()|[\]\\{}]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp("^" + re + "$");
}

/** Every file under `root` as a root-relative `/` path, with the skip list and a depth cap. */
function walk(root, { maxDepth, maxFiles }) {
  const files = [];
  let truncated = false;
  const rec = (dir, rel, depth) => {
    if (truncated || depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP.has(e.name)) continue;
        rec(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name, depth + 1);
      } else if (e.isFile()) {
        if (files.length >= maxFiles) {
          truncated = true;
          return;
        }
        files.push(rel ? `${rel}/${e.name}` : e.name);
      }
    }
  };
  rec(root, "", 0);
  return { files, truncated };
}

/** `Read(...)` patterns from `permissions.deny`, as absolute-path regexes. Defensive. */
export function readDenyPatterns(settingsPaths, home = homedir()) {
  const patterns = [];
  const notes = [];
  for (const sp of settingsPaths) {
    if (!existsSync(sp)) continue;
    let j;
    try {
      j = JSON.parse(readFileSync(sp, "utf8"));
    } catch (err) {
      notes.push(`${sp} is not readable JSON (${err.message}) — deny rules from it were NOT applied`);
      continue;
    }
    const deny = j?.permissions?.deny;
    if (deny === undefined) continue;
    if (!Array.isArray(deny)) {
      notes.push(`${sp}: permissions.deny is not an array — deny rules from it were NOT applied`);
      continue;
    }
    for (const d of deny) {
      const m = typeof d === "string" ? /^Read\((.*)\)$/.exec(d) : null;
      if (!m) continue;
      let g = m[1];
      if (g.startsWith("//")) g = g.slice(1);
      else if (g.startsWith("~/")) g = path.join(home, g.slice(2));
      else if (!g.startsWith("/")) g = "**/" + g.replace(/^\.?\//, "");
      patterns.push({ glob: m[1], re: globToRegExp(g) });
    }
  }
  return { patterns, notes };
}

/** Frontmatter of one rule file: `{present, meta?, hasPathsKey, parseError?}`. */
function frontmatterOf(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!m) return { present: false, hasPathsKey: false };
  const hasPathsKey = /^paths\s*:/m.test(m[1]);
  try {
    const meta = parseYaml(m[1]);
    return { present: true, meta: meta && typeof meta === "object" ? meta : {}, hasPathsKey };
  } catch (err) {
    return { present: true, hasPathsKey, parseError: err.message };
  }
}

/**
 * @returns {{
 *   status: "none"|"pass"|"fail"|"unknown"|"blind",
 *   scoped: number, walked: number, missing: string[], reason: string,
 *   findings: Array<{file: string, entry?: string, problem: string}>,
 *   entries: Array<{file: string, entry: string, matched: number, readable: number}>,
 *   notes: string[]
 * }}
 */
export function checkRulePaths({
  rulesDir,
  roots,
  settingsPaths = [path.join(homedir(), ".claude", "settings.json")],
  minFiles = DEFAULT_MIN_FILES,
  maxDepth = 8,
  maxFiles = 600000,
} = {}) {
  const result = { status: "none", scoped: 0, walked: 0, missing: [], reason: "", findings: [], entries: [], notes: [] };

  let names;
  try {
    names = readdirSync(rulesDir).filter((f) => f.endsWith(".md")).sort();
  } catch (err) {
    return { ...result, status: "unknown", reason: `rules dir unreadable: ${err.message}` };
  }

  // Phase 1: shape. Needs no filesystem scan, so it runs even when roots are missing.
  const scopedRules = [];
  for (const f of names) {
    let raw;
    try {
      raw = readFileSync(path.join(rulesDir, f), "utf8");
    } catch (err) {
      result.notes.push(`${f}: unreadable (${err.message})`);
      continue;
    }
    const fm = frontmatterOf(raw);
    if (!fm.present) continue;
    if (fm.parseError) {
      // Cannot know its paths — but if the text says it has some, silence would hide a dead rule.
      if (fm.hasPathsKey) {
        result.scoped += 1;
        result.findings.push({ file: f, problem: `frontmatter does not parse (${fm.parseError}) and mentions paths: — scope unknowable` });
      }
      continue;
    }
    if (!("paths" in fm.meta) && !fm.hasPathsKey) continue;
    result.scoped += 1;
    const p = fm.meta.paths;
    if (!Array.isArray(p) || p.length === 0 || !p.every((e) => typeof e === "string" && e.trim() !== "")) {
      result.findings.push({ file: f, problem: "`paths` is not a non-empty array of non-empty strings" });
      continue;
    }
    const good = [];
    for (const entry of p) {
      if (!entry.startsWith("**/")) {
        result.findings.push({
          file: f, entry,
          problem: "does not start with `**/` — a user-level rule has no project root, globs resolve against the session's project",
        });
      } else good.push(entry);
    }
    if (good.length) scopedRules.push({ file: f, entries: good });
  }

  if (result.scoped === 0) return { ...result, status: "none", reason: "no rule declares paths:" };

  // Phase 2: reachability. Needs the tree.
  const rootList = Array.isArray(roots) ? roots : [];
  const present = [];
  for (const r of rootList) {
    if (existsSync(r)) present.push(r);
    else result.missing.push(r);
  }
  if (rootList.length === 0 || result.missing.length) {
    result.reason = rootList.length === 0 ? "no search roots configured" : `search root(s) missing: ${result.missing.join(", ")}`;
    result.status = "unknown";
    return finish(result, /* shapeOnlyFailures */ true);
  }

  const { patterns: deny, notes: denyNotes } = readDenyPatterns(settingsPaths);
  result.notes.push(...denyNotes);

  const compiled = scopedRules.flatMap((r) => r.entries.map((entry) => ({ file: r.file, entry, re: globToRegExp(entry), matched: 0, readable: 0 })));
  let truncated = false;
  for (const root of present) {
    const w = walk(root, { maxDepth, maxFiles });
    truncated ||= w.truncated;
    result.walked += w.files.length;
    for (const rel of w.files) {
      const abs = path.join(root, rel);
      let denied;
      for (const c of compiled) {
        if (!c.re.test(rel)) continue;
        c.matched += 1;
        denied ??= deny.some((d) => d.re.test(abs));
        if (!denied) c.readable += 1;
      }
    }
  }

  if (result.walked < minFiles) {
    result.status = "blind";
    result.reason = `only ${result.walked} file(s) walked under ${present.length} root(s) (floor ${minFiles}) — the scan has gone blind, it has not found nothing`;
    return finish(result, true);
  }

  for (const c of compiled) {
    result.entries.push({ file: c.file, entry: c.entry, matched: c.matched, readable: c.readable });
    if (c.matched === 0) {
      if (truncated) {
        result.notes.push(`${c.file}: ${c.entry} matched nothing but the walk hit the ${maxFiles}-file cap — unknown, not dead`);
      } else {
        result.findings.push({ file: c.file, entry: c.entry, problem: `matches 0 files under ${present.length} search root(s) (${result.walked} files walked) — the rule can never load` });
      }
    } else if (c.readable === 0) {
      result.findings.push({ file: c.file, entry: c.entry, problem: `matches ${c.matched} file(s), all covered by a permissions.deny Read pattern — Claude can never read them, so the rule can never load` });
    }
  }
  return finish(result, false);
}

function finish(result, incomplete) {
  if (result.findings.length) {
    // A shape failure is real even when the scan could not run.
    result.status = "fail";
    result.reason = `${result.findings.length} problem(s)` + (incomplete ? ` (reachability unchecked: ${result.reason})` : "");
  } else if (!incomplete) {
    result.status = "pass";
    result.reason = `${result.scoped} scoped rule(s), ${result.entries.length} glob(s), each matches a readable file (${result.walked} files walked)`;
  }
  return result;
}
