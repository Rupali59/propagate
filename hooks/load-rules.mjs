#!/usr/bin/env node
/**
 * SessionStart hook — deliver canonical rules from ~/.claude/rules/ to the session.
 *
 * Why this exists: rules were being restated inline in 49 CLAUDE.md files, which
 * produced 9 copies of one rule making 4 contradictory claims. The fix is
 * single-source + reference. That only works if the single source actually
 * reaches the session, which is this file's whole job.
 *
 * DESIGN NOTE — the failure this is built against. `~/.claude/rules/` sat with
 * three rule files for months and nothing loaded them; the directory looked
 * populated and delivered nothing. A loader that silently emits zero rules
 * recreates that exact state while appearing to work. So: emitting zero rules is
 * treated as a LOUD failure, never as "nothing applied here". Silence must never
 * be indistinguishable from success (propagate GOTCHAS.md G2).
 *
 * Only files with an `id:` in frontmatter are loaded. That deliberately excludes
 * `_TODO.md` and the three legacy `paths:`-format drafts, without needing a
 * denylist that would go stale.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const RULES_DIR = path.join(os.homedir(), ".claude", "rules");

/** Minimal frontmatter reader. Returns null when there is no `id:` — not a rule file. */
function parse(file) {
  const raw = readFileSync(file, "utf8");
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  if (!meta.id) return null;
  return { ...meta, body: m[2].trim(), file: path.basename(file) };
}

/** Does this rule's scope apply to cwd? Unknown scopes load — failing open is
 *  correct here, because a dropped rule is worse than an extra one. */
function applies(rule, cwd) {
  const scope = (rule.scope || "global").trim();
  if (scope === "global") return true;
  if (scope === "next-projects") {
    for (let d = cwd; d !== path.dirname(d); d = path.dirname(d)) {
      const pkg = path.join(d, "package.json");
      if (existsSync(pkg)) {
        try {
          const j = JSON.parse(readFileSync(pkg, "utf8"));
          return !!(j.dependencies?.next || j.devDependencies?.next);
        } catch { return false; }
      }
    }
    return false;
  }
  // Otherwise treat scope as a workspace/directory name.
  return cwd.split(path.sep).includes(scope);
}

const cwd = process.cwd();
let files = [];
try {
  files = readdirSync(RULES_DIR).filter((f) => f.endsWith(".md"));
} catch {
  emit(`⚠️  RULES NOT LOADED: ${RULES_DIR} is unreadable or missing. Every global rule is absent from this session.`);
  process.exit(0);
}

const problems = [];
const loaded = [];
for (const f of files) {
  let r;
  try { r = parse(path.join(RULES_DIR, f)); }
  catch (e) { problems.push(`${f}: ${e.message}`); continue; }
  if (!r) continue;                                   // not a rule file
  if (r.status === "obsolete") continue;              // retired on purpose
  if (!applies(r, cwd)) continue;
  loaded.push(r);
}

if (loaded.length === 0) {
  // The state this hook exists to prevent. Say so; do not fall silent.
  emit(
    `⚠️  RULES LOADED: 0 of ${files.length} file(s) in ~/.claude/rules/.\n` +
    `No canonical rule applied to this session. Either no rule matches cwd (${cwd}) ` +
    `or the rule files lost their frontmatter \`id:\`. Do NOT assume "no rules apply" — ` +
    `verify with: node ~/.claude/hooks/load-rules.mjs | head -40` +
    (problems.length ? `\nParse failures: ${problems.join("; ")}` : ""),
  );
  process.exit(0);
}

const header =
  `## Canonical rules (${loaded.length} loaded from ~/.claude/rules/)\n\n` +
  `These are the single source for the rules below. **Do not restate them in any ` +
  `CLAUDE.md** — reference them as \`rule:<id>\`. Restating is what produced 9 ` +
  `divergent copies of the tool-priority rule. A genuine per-repo deviation must ` +
  `be declared, not written as if it were the rule.\n`;

const body = loaded
  .map((r) => `### rule:${r.id}${r.scope !== "global" ? `  _(scope: ${r.scope})_` : ""}\n\n${r.body}`)
  .join("\n\n---\n\n");

const warn = problems.length
  ? `\n\n⚠️  ${problems.length} rule file(s) failed to parse and were skipped: ${problems.join("; ")}`
  : "";

emit(`${header}\n${body}${warn}`);

function emit(text) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text },
  }));
}
