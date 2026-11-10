/**
 * Rule load tiers (#218): every rule declares `load: always | scoped | companion`, and this checks the declaration
 * against what Claude Code will actually do with the file.
 *
 * What Claude Code does, from its own docs (code.claude.com/docs/en/memory.md, read 2026-11-10):
 *   - "Rules without paths frontmatter are loaded at launch"; a rule with `paths:` loads "when Claude uses the Read,
 *     Write, or Edit tool on a matching file".
 *   - "paths is the only field Claude Code reads from a rule; any other field is ignored without an error. Claude Code
 *     removes the frontmatter before loading the rule into context." So `load:` costs no context: it is propagate's
 *     declaration, and this module is what makes it true.
 *   - Malformed frontmatter: "Claude Code ignores the frontmatter and loads the rule as if it had no paths." A rule meant
 *     to be scoped whose YAML breaks becomes always-loaded, silently. That is the failure this catches first.
 *   - User-level rules' `paths:` are matched "relative to the session's primary working directory", so a glob without
 *     a leading `**` / matches only when the session starts in one place.
 *   - On-demand files are cut at a per-file limit (40,000 chars in a 200k-context session), with a note to Read the rest.
 *   - claudeMdExcludes skips files entirely; an excluded file has no tier and needs no `load:`.
 *
 * Precedence: when two rules conflict "Claude may pick one arbitrarily" and neither scope overrides the other. So a
 * precedence only works if it is written in the LOADED text of both rules. `conventions/PRECEDENCE.yml` (never loaded)
 * lists the pairs; this checks both bodies cite each other.
 *
 * Derived, never curated: the tier comes from the file (its paths: and its name); the declaration is checked against it.
 */
import { readdirSync, readFileSync, existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import { globToRegExp } from "./paths-guard.mjs";
import { stripFrontmatter } from "./rules-check.mjs";

export const TIERS = ["always", "scoped", "companion"];
export const ON_DEMAND_CHAR_LIMIT = 40_000; // the 200k-context floor in the docs; larger sessions allow more

const stripBlockComments = (s) => s.replace(/<!--[\s\S]*?-->/g, "");

/** claudeMdExcludes from the given settings files; a missing or unreadable file contributes nothing, and says so. */
export function readExcludes(settingsPaths = [path.join(homedir(), ".claude", "settings.json")]) {
  const patterns = [];
  const notes = [];
  for (const p of settingsPaths) {
    if (!existsSync(p)) continue;
    try {
      const s = JSON.parse(readFileSync(p, "utf8"));
      if (Array.isArray(s.claudeMdExcludes)) patterns.push(...s.claudeMdExcludes.map(String));
    } catch (err) {
      notes.push(`${p}: claudeMdExcludes not read (${err.message})`);
    }
  }
  return { patterns, notes };
}

function walk(dir, base = dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, base, out);
    else if (e.name.endsWith(".md")) out.push(path.relative(base, full));
  }
  return out;
}

/** The tier Claude Code will actually give this file's text, and why. */
export function actualTier(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!m) return { tier: "always", meta: null, yamlFailed: false, paths: [] };
  let meta;
  try {
    meta = parseYaml(m[1]);
  } catch {
    return { tier: "always", meta: null, yamlFailed: true, paths: [] };
  }
  if (!meta || typeof meta !== "object") return { tier: "always", meta: null, yamlFailed: true, paths: [] };
  const p = meta.paths;
  const paths = Array.isArray(p) ? p.map(String).filter(Boolean) : typeof p === "string" ? p.split(",").map((s) => s.trim()).filter(Boolean) : [];
  return { tier: paths.length ? "scoped" : "always", meta, yamlFailed: false, paths };
}

/** The tier a file SHOULD declare: a companion by name, otherwise what Claude Code does with it. */
export function expectedTier(rel, actual) {
  return /\.evidence\.md$/.test(rel) ? "companion" : actual.tier;
}

/**
 * @param {{rulesDir: string, excludes?: string[], headReader?: (rel: string) => string|null, precedencePath?: string}} o
 * @returns {{failures: string[], warnings: string[], rows: object[], promotions: string[], counts: object, notes: string[]}}
 */
export function checkLoadTiers({ rulesDir, excludes = [], headReader = null, precedencePath } = {}) {
  const failures = [];
  const warnings = [];
  const notes = [];
  const rows = [];
  const promotions = [];
  let realDir = rulesDir;
  try { realDir = realpathSync(rulesDir); } catch { /* keep as given */ }
  const excludeRes = excludes.map((g) => globToRegExp(g));
  const isExcluded = (rel) => {
    const cands = [path.join(rulesDir, rel), path.join(realDir, rel)];
    return excludeRes.some((re) => cands.some((c) => re.test(c)));
  };

  const files = walk(rulesDir).sort();
  if (files.length === 0) {
    failures.push(`load tiers: 0 rule files under ${rulesDir}; the scan is blind, it has not found nothing`);
    return { failures, warnings, rows, promotions, counts: { files: 0 }, notes };
  }

  const byBase = new Map();
  for (const rel of files) {
    if (isExcluded(rel)) {
      rows.push({ rel, tier: "excluded", declared: null, chars: 0 });
      continue;
    }
    const raw = readFileSync(path.join(rulesDir, rel), "utf8");
    const actual = actualTier(raw);
    const expect = expectedTier(rel, actual);
    const declared = actual.meta?.load ?? null;
    const chars = stripBlockComments(stripFrontmatter(raw)).length;
    rows.push({ rel, tier: actual.tier, expect, declared, chars, id: actual.meta?.id ?? null });
    byBase.set(rel.replace(/\.md$/, ""), { rel, actual, raw });

    if (actual.yamlFailed) {
      failures.push(`${rel}: frontmatter does not parse, so Claude Code loads it as if it had no paths (always-loaded)`);
      continue;
    }
    if (declared == null) failures.push(`${rel}: no \`load:\` declared; expected \`load: ${expect}\``);
    else if (!TIERS.includes(declared)) failures.push(`${rel}: \`load: ${declared}\` is not one of ${TIERS.join(", ")}`);
    else if (declared !== expect) {
      const why = expect === "always" ? "it has no paths:, so Claude Code loads it at every session start"
        : expect === "scoped" ? "it has paths:, so Claude Code loads it only on a matching Read/Write/Edit"
        : "an *.evidence.md file is a companion to its rule";
      failures.push(`${rel}: declares \`load: ${declared}\` but ${why} (expected \`load: ${expect}\`)`);
    }
    if (expect === "companion" && actual.tier !== "scoped") failures.push(`${rel}: a companion with no paths: is loaded at every session start, defeating the split`);
    for (const g of actual.paths) {
      if (!g.startsWith("**/") && !path.isAbsolute(g)) {
        failures.push(`${rel}: paths glob "${g}" does not start with **/; user-level rule globs match relative to the session's working directory, so it fires from one directory only`);
      }
    }
    if (actual.tier === "scoped" && chars > ON_DEMAND_CHAR_LIMIT) {
      warnings.push(`${rel}: ${chars} chars loads on demand, over the ${ON_DEMAND_CHAR_LIMIT}-char per-file limit of a 200k-context session; Claude gets only the start`);
    }
    if (headReader) {
      const prev = headReader(rel);
      const was = prev == null ? null : actualTier(prev).tier;
      if (actual.tier === "always" && was !== "always") {
        promotions.push(`${rel}: ${was == null ? "new always-loaded rule" : `promoted ${was} -> always`} (+${chars} chars at every session start)`);
      }
    }
  }

  // Companions name a real parent rule.
  for (const r of rows) {
    if (r.expect !== "companion") continue;
    const parentBase = r.rel.replace(/\.evidence\.md$/, "");
    const parent = byBase.get(parentBase);
    if (!parent) failures.push(`${r.rel}: companion without a parent rule (${parentBase}.md does not exist or is excluded)`);
    else if (!parent.actual.meta?.id) failures.push(`${r.rel}: its parent ${parent.rel} carries no id`);
  }

  // Precedence pairs: both loaded bodies state it.
  const precPath = precedencePath ?? path.join(rulesDir, "conventions", "PRECEDENCE.yml");
  if (!existsSync(precPath)) {
    warnings.push(`no precedence registry at ${precPath}; conflicting rules have no checked precedence`);
  } else {
    let pairs = [];
    try {
      const y = parseYaml(readFileSync(precPath, "utf8"));
      pairs = Array.isArray(y?.pairs) ? y.pairs : [];
    } catch (err) {
      failures.push(`precedence registry unreadable: ${err.message}`);
    }
    if (pairs.length === 0 && existsSync(precPath)) warnings.push("precedence registry lists 0 pairs");
    for (const p of pairs) {
      const a = byBase.get(String(p.winner));
      const b = byBase.get(String(p.loser));
      const label = `precedence ${p.winner} over ${p.loser}${p.when ? ` (${p.when})` : ""}`;
      if (!a || !b) { failures.push(`${label}: ${!a ? p.winner : p.loser}.md is not a loaded rule`); continue; }
      const bodyA = stripFrontmatter(a.raw);
      const bodyB = stripFrontmatter(b.raw);
      if (!bodyA.includes(`rule:${p.loser}`)) failures.push(`${label}: ${a.rel} does not cite rule:${p.loser}, so the precedence is not in the text Claude loads`);
      if (!bodyB.includes(`rule:${p.winner}`)) failures.push(`${label}: ${b.rel} does not cite rule:${p.winner}, so a reader of ${b.rel} alone never learns it yields`);
    }
  }

  const loaded = rows.filter((r) => r.tier !== "excluded");
  const counts = {
    files: rows.length,
    excluded: rows.length - loaded.length,
    always: loaded.filter((r) => r.tier === "always").length,
    scoped: loaded.filter((r) => r.tier === "scoped" && r.expect !== "companion").length,
    companion: loaded.filter((r) => r.expect === "companion").length,
    alwaysChars: loaded.filter((r) => r.tier === "always").reduce((n, r) => n + r.chars, 0),
  };
  return { failures, warnings, rows, promotions, counts, notes };
}
