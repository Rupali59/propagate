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
    `verify with: node "$CLAUDE_PLUGIN_ROOT/hooks/load-rules.mjs" | head -40` +
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

/**
 * RESTATEMENT DETECTION, run here because this is already the one thing that
 * walks the rules directory every session.
 *
 * `rules check` existed and worked for weeks while sitting in NO gate — not
 * doctor, not CI, not the release gates. It was computed only when someone
 * asked, which for a drift detector is indistinguishable from not existing.
 * That is rule:enforcement-watches-itself #5: "an update checker was written,
 * verified across five behaviours, and invoked by nothing."
 *
 * SILENT WHEN CLEAN. This is a SessionStart hook; anything it prints lands in
 * every session's context forever. A detector that speaks when there is
 * nothing to say becomes the thing everyone scrolls past, which is precisely
 * how the monitor's `info` line went unread while the agent was dead. Same
 * posture as gotcha-guard: fire at the moment of risk, otherwise nothing.
 *
 * Measured 2026-08-22: 98ms over 48 CLAUDE.md files, plus ~40ms of import.
 * That is affordable per session; if it ever is not, the fix is to move it,
 * not to make it quieter.
 *
 * A FAILURE HERE IS REPORTED, NEVER SWALLOWED. If the detector cannot run,
 * this says so — a rules layer that cannot be checked must not read as a
 * rules layer with nothing wrong.
 */
let drift = "";
try {
  const { checkRules } = await import("../lib/rules/rules-check.mjs");
  const { SEARCH_ROOTS } = await import("../lib/core/config.mjs");
  const r = checkRules({ rulesDir: RULES_DIR, roots: SEARCH_ROOTS });
  // `no-files-scanned` means the roots hold no CLAUDE.md. That is "nothing to
  // check", not "the check broke" — and staying silent for it is required, not
  // merely nice: this hook runs at EVERY session start, including sessions
  // opened anywhere without a CLAUDE.md, and a warning there would train the
  // reader to ignore the one that matters. `roots-missing` is different: a
  // configured root has vanished, so the scan was incomplete.
  if (r.diagnostic && r.diagnostic !== "ok" && r.diagnostic !== "no-files-scanned") {
    drift =
      `\n\n⚠️  RULES CHECK could not run: ${r.diagnostic}` +
      (r.missing?.length ? ` (missing roots: ${r.missing.join(", ")})` : "") +
      `. The scan was INCOMPLETE — this is not "no drift".`;
  } else if (r.diagnostic !== "no-files-scanned" && r.findings.length > 0) {
    const lines = r.findings
      .slice(0, 10)
      .map((f) => `  - ${f.file}${f.lines?.length ? `:${f.lines[0]}` : ""} restates rule:${f.rule}`);
    drift =
      `\n\n⚠️  ${r.findings.length} RESTATEMENT(S) of a canonical rule, across ` +
      `${r.filesScanned} file(s) scanned:\n${lines.join("\n")}` +
      (r.findings.length > 10 ? `\n  (+${r.findings.length - 10} more)` : "") +
      `\nReference the rule as \`rule:<id>\` instead, or declare a deviation in that ` +
      `file's own CLAUDE.md. Copying is what produced 9 divergent copies of ` +
      `tool-priority making 4 mutually exclusive claims.`;
  }
} catch (err) {
  drift = `\n\n⚠️  RULES CHECK did not run: ${err?.message ?? err}. Nothing was checked.`;
}

emit(`${header}\n${body}${warn}${drift}`);

function emit(text) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text },
  }));
}
