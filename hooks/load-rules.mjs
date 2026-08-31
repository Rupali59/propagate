#!/usr/bin/env node
/**
 * SessionStart hook — RESTATEMENT DETECTOR for the canonical rules in ~/.claude/rules/.
 *
 * THIS NO LONGER DELIVERS RULE BODIES, as of 2026-08-29. It parses them, and it
 * reports drift. Claude Code delivers them.
 *
 * WHY THE CHANGE. `.claude/rules/` is a NATIVE Claude Code memory directory —
 * verified against the CLI binary (2.1.236), which documents it as: "organizing
 * instructions into `.claude/rules/` as separate focused files ... These are
 * loaded automatically alongside CLAUDE.md", walked "including nested
 * directories", scopable with `paths` frontmatter. `~/.claude/rules` is the
 * User-scope instance, so every file under it was ALREADY in every session's
 * context, labelled "(user's private global instructions for all projects)".
 *
 * This hook was written 2026-08-14 to close a gap the platform had already closed,
 * so from then until now the same 16 rule bodies arrived TWICE — measured
 * 2026-08-29 at 51,112 bytes of duplication per session. propagate's own STATE.md
 * carried "confirm rules are injected once, not twice" as an open question. The
 * answer was twice.
 *
 * WHAT WAS DELIBERATELY KEPT, and why deleting this file would have been wrong.
 * Injection was never its only job. It also runs the restatement scan below — the
 * detector for the 9-divergent-copies failure the whole rules layer exists to
 * prevent — and that has no native equivalent. Delivery moved to the platform;
 * detection stayed here.
 *
 * WHAT WAS GIVEN UP. `applies(r, cwd)` still filters what this file COUNTS, but it
 * can no longer filter what the session RECEIVES: the native loader has no concept
 * of `scope:`, so a `scope: next-projects` rule reaches every session regardless.
 * Measured cost: one rule (`nextjs-dev-server-port`, 53 lines). The native
 * equivalent is `paths:` frontmatter, which is finer-grained — it scopes on the
 * files being touched rather than on cwd. Converting that rule is the fix;
 * re-adding body injection here is not.
 *
 * G2 IS STILL HONOURED, AND ITS SCOPE IS NOW NARROWER — read this before
 * "restoring" anything. Emitting zero rules is still a LOUD failure. But the
 * guarantee is now "the rule FILES are present and parseable", NOT "the session
 * received them": this hook cannot observe the native memory load and must not
 * claim to. That is why the summary line names the mechanism — a reader seeing a
 * count but no rule bodies must be able to tell that this is by design.
 *
 * TO REVERT: restore `header`/`body` and the old `emit(...)` at the foot of this
 * file, and drop `claudeMdExcludes` from ~/.claude/settings.json. One edit each.
 *
 * Only files with an `id:` in frontmatter are counted. Note that `paths:` is the
 * NATIVE scoping key, not a legacy format — the three files this comment used to
 * call "legacy `paths:`-format drafts" were written for the real mechanism and
 * judged non-conforming by this one.
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

/**
 * ONE LINE, where this used to emit 51,112 bytes of rule bodies.
 *
 * Claude Code has already placed every `.md` under ~/.claude/rules/ into this
 * session's context as user memory; re-emitting them here is what produced the
 * duplication. What this line buys is ATTRIBUTABILITY (rule:discernment-checks
 * §2): once the bodies stop appearing under a "## Canonical rules" heading, a
 * reader has no way to tell "delivered natively, by design" from "the rules layer
 * is broken" — and those two must not look the same. So the count and the
 * mechanism are stated, every session, in one line.
 *
 * It is NOT silent-when-clean like the drift block below, and the asymmetry is
 * deliberate: a finding should speak only when there is a finding, but a delivery
 * mechanism that has gone quiet must still say it is alive.
 */
const summary =
  `_Rules: ${loaded.length} canonical rule file(s) parsed in ~/.claude/rules/ and ` +
  `delivered natively by Claude Code as user memory — this hook stopped injecting ` +
  `bodies on 2026-08-29 (they were arriving twice). Reference a rule as ` +
  `\`rule:<id>\`; never restate one in a CLAUDE.md. Restating is what produced 9 ` +
  `divergent copies of the tool-priority rule making 4 mutually exclusive claims._`;

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

/**
 * ECOSYSTEM — one line when the derived rollup has moved. Phase 1 Task F.
 *
 * WHY THIS BLOCK EXISTS AT ALL. The whole point of `ECOSYSTEM.md` is that agents
 * read FILES and do not run commands nobody pointed them at. This is the one place
 * an agent — rather than a human reading DAILY.md — is told the file exists, where
 * it is, and that `NORTH_STAR.md` is its authored counterpart. It converts a
 * command-shaped capability into a file pointer, which is the thing agents act on.
 *
 * IT MUST NOT WALK, AND THAT IS THE WHOLE DESIGN OF IT. This hook states its own
 * budget: 98ms over 48 CLAUDE.md files plus ~40ms of import, "affordable per
 * session; if it ever is not, the fix is to move it, not to make it quieter."
 * `rollup()`'s backlog walk alone has a 20-SECOND budget — 200x that, on every
 * `startup|resume|clear|compact`. So this block derives NOTHING. It reads one small
 * JSON file the digest already wrote (~1ms) and reports what the digest last saw.
 *
 * THE DATE IN THE TEXT IS LOAD-BEARING, not decoration. This line is only as fresh
 * as the last digest run, which is daily. Without the date an agent reads it as
 * live, and acts on a picture up to 24h old believing it is current.
 *
 * AND A MISSING STATE FILE GETS ITS OWN LINE, never silence. Silence would mean
 * "nothing changed" — the ambiguous-absence failure (`rule:discernment-checks` §2,
 * and G2). "The digest has not run, so nothing is known" is a different fact from
 * "the digest ran and found nothing", and only the second is a pass.
 *
 * SILENT WHEN CLEAN otherwise, matching this file's stated posture: "a detector
 * that speaks when there is nothing to say becomes the thing everyone scrolls past."
 */
let ecosystem = "";
try {
  const { readFileSync: rf, existsSync: ex } = await import("node:fs");
  const os = await import("node:os");
  const p = `${os.homedir()}/.claude/propagate-digest-state.json`;
  if (ex(p)) {
    const st = JSON.parse(rf(p, "utf8"));
    const r = st?.rollup;
    if (!r) {
      // The digest has run, but not since the rollup section shipped. Distinct
      // from "never ran" and from "ran and found nothing" — three states.
      ecosystem =
        `\n\n📊  ECOSYSTEM.md status is UNKNOWN — the digest has run but carries no rollup` +
        ` record yet. Do not read that as "nothing changed".`;
    } else {
      const moved =
        (r.inputsChanged?.length ?? 0) + (r.inputsAppeared?.length ?? 0) +
        (r.inputsVanished?.length ?? 0) + (r.becameUnreadable?.length ?? 0);
      const when = st.lastRunAt ? String(st.lastRunAt).slice(0, 10) : "an unknown date";
      if (r.handEdited) {
        ecosystem =
          `\n\n📊  ECOSYSTEM.md was HAND-EDITED (as of the ${when} digest). It is generated;` +
          ` the edit belongs in ~/Documents/GitHub/NORTH_STAR.md.`;
      } else if (r.fileStale || moved > 0) {
        ecosystem =
          `\n\n📊  ECOSYSTEM.md is stale as of the ${when} digest` +
          (moved > 0 ? ` — ${moved} input(s) changed` : "") +
          `.\n    ~/Documents/GitHub/ECOSYSTEM.md — what exists across the tree.` +
          `\n    ~/Documents/GitHub/NORTH_STAR.md — what we are building toward.` +
          `\n    \`propagate rollup\` refreshes it; \`rollup --check\` confirms it.`;
      }
    }
  } else {
    ecosystem =
      `\n\n📊  The propagate digest has not run, so nothing is known about ECOSYSTEM.md.` +
      ` This is not "no change".`;
  }
} catch (err) {
  // Fails LOUD, unlike the loader's other blocks, because the failure mode here is
  // reporting "no change" for a tree that moved.
  ecosystem = `\n\n📊  ECOSYSTEM status unreadable: ${err?.message ?? err}. Nothing was checked.`;
}

emit(`${summary}${warn}${drift}${ecosystem}`);

function emit(text) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text },
  }));
}
