#!/usr/bin/env node
/**
 * gotcha-guard — deliver the relevant gotcha at the moment of risk.
 *
 * WHY THIS EXISTS. `STATE.md` and `docs/DECISIONS.md` are pull artifacts: you
 * read them because you asked a question. `docs/GOTCHAS.md` is not — you need
 * it *before* a mistake you do not know you are about to make, which is exactly
 * when you do not think to open it. Measured 2026-08-17: 1 of 45 projects has a
 * GOTCHAS.md, and nothing in this install loads one.
 *
 * Loading is necessary and NOT sufficient. `rule:discernment-checks` §4 is
 * injected into every session and still records the ugrep `--ignore-files`
 * hazard firing a SECOND time, saying so out loud: "knowing about it does not
 * stop you reaching for grep." The failure is recognition, not knowledge. So
 * this fires on the literal act, not on the reader.
 *
 * WORKED EXAMPLE, the day this landed: `verify` had no dry run, the hazard was
 * filed as N27 on 2026-08-16, and a session hit it on 2026-08-17 anyway —
 * 11 events asserting verifications nobody performed, 3 worklist items falsely
 * closed. The entry existed and was correct. It was three files away.
 *
 * HOW TRIGGERS ARE DECLARED. In the gotcha entry itself, so a project that
 * writes one gets delivery for free — the incentive to adopt is the mechanism,
 * not a rule telling you to:
 *
 *     ### G3 · Deleting gitignored build output breaks a loaded extension
 *     **Trigger:** `rm .*dist/|npm run build`
 *     Chrome binds content scripts at extension load ...
 *     **Cost:** an evening, green suite, silent console.
 *
 * Sources, nearest first: every `docs/GOTCHAS.md` / `GOTCHAS.md` from cwd up to
 * $HOME, plus the cross-cutting `~/.claude/gotchas-global.md`.
 *
 * NEVER BLOCKS. A gotcha is information, not a veto — it prints to stderr and
 * exits 0. `doc-authority.mjs` blocks (exit 2) because counsel-owned wording is
 * genuinely not the editor's to change; a hazard note has no such standing, and
 * a guard that blocks on a regex would be trained around within a week.
 *
 * FAILS OPEN, LOUDLY. Any internal error exits 0 so the tool call proceeds, but
 * is recorded in the log — a guard that silently stops working is the G2/N7
 * failure this whole ecosystem is about. Every invocation appends one line, so
 * "never fired" is distinguishable from "never ran". Probe with --selftest.
 */

import { readFileSync, existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The parser lives in lib/ so the reconcile path can reuse it — see that file's
// header for why the dependency points this way and not the other.
import {
  HOME,
  LOG,
  logLine,
  parseEntries,
  selftestProblems,
  sourcesFor,
} from "../lib/gotchas/parse.mjs";

/** Cap on entries shown at once. Noise is a hiding place (propagate GOTCHAS G23). */
const MAX_SHOWN = 3;

// ---------------------------------------------------------------------------
// matching
// ---------------------------------------------------------------------------

/** The string a tool call is "about" — what a trigger regex is matched against. */
function subjectOf(payload) {
  const tool = payload?.tool_name;
  const input = payload?.tool_input || {};
  if (tool === "Bash") return input.command || "";
  if (tool === "Edit" || tool === "Write" || tool === "NotebookEdit") return input.file_path || "";
  return "";
}

function render(hits) {
  const lines = [];
  for (const h of hits.slice(0, MAX_SHOWN)) {
    const where = h.source.replace(HOME, "~");
    lines.push(`gotcha · ${h.title}`);
    for (const l of h.body.split("\n")) lines.push(`  ${l.trim()}`);
    lines.push(`  — ${where}`);
    lines.push("");
  }
  if (hits.length > MAX_SHOWN) {
    lines.push(`  (+${hits.length - MAX_SHOWN} more matched; showing the ${MAX_SHOWN} nearest)`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// selftest — the liveness probe (docs/SYSTEMS.md requires one from day one)
// ---------------------------------------------------------------------------

/** The CLI probe: derive sources from cwd, print, and set an exit code. */
function selftest() {
  const sources = sourcesFor(process.cwd());
  const problems = selftestProblems(sources);
  // Parse once per source and reuse. The split into selftestProblems briefly made
  // this three passes over every file — once inside the probe, once for the total,
  // once per line of the listing. Nobody would have noticed, which is the point:
  // work that only shows up as a slightly slower probe never gets attributed.
  const parsed = sources.map((s) => ({ source: s, count: parseEntries(s).entries.length }));
  const entryCount = parsed.reduce((n, p) => n + p.count, 0);

  console.log(`gotcha-guard selftest`);
  console.log(`  sources : ${sources.length}`);
  for (const p of parsed) console.log(`            ${p.source.replace(HOME, "~")} (${p.count} triggered)`);
  console.log(`  entries : ${entryCount} with a **Trigger:** line`);
  console.log(`  log     : ${existsSync(LOG) ? `${readFileSync(LOG, "utf8").split("\n").filter(Boolean).length} invocations recorded` : "never run"}`);
  if (problems.length) {
    console.log(`\n${problems.length} problem(s):`);
    for (const p of problems) console.log(`  ✗ ${p}`);
    process.exit(1);
  }
  console.log(`\n✓ the guard can fire`);
  process.exit(0);
}

// ---------------------------------------------------------------------------

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function main() {
  if (process.argv.includes("--selftest")) return selftest();

  let payload;
  try {
    payload = JSON.parse(readStdin());
  } catch {
    process.exit(0); // unparseable payload is not this guard's problem
  }

  const subject = subjectOf(payload);
  if (!subject) process.exit(0);

  const sources = sourcesFor(process.cwd());
  const parsedAll = sources.map(parseEntries);
  const entries = parsedAll.flatMap((r) => r.entries);
  // A bad trigger at RUNTIME is logged (below) but never blocks the call; the
  // selftest is where it becomes a visible problem.
  const badCount = parsedAll.reduce((n, r) => n + r.bad.length, 0);
  const hits = entries.filter((e) => e.trigger.test(subject));

  logLine(`tool=${payload?.tool_name || "?"} sources=${sources.length} entries=${entries.length} bad=${badCount} hits=${hits.length}`);

  if (hits.length === 0) process.exit(0); // silence is correct: most calls are not hazardous

  // DELIVERY CHANNEL — measured 2026-08-17, do not "simplify" back to stderr.
  //
  // The first version wrote to stderr and exited 0, copying doc-authority.mjs's
  // `note:` path. It fired correctly and the model saw NOTHING: the log recorded
  // `tool=Bash entries=4 hits=1` for a call whose output never appeared. A guard
  // that matches perfectly into a channel nobody reads is the exact
  // "reports success while doing nothing" failure this whole thing exists to
  // catch — and it is invisible, because the log looks healthy.
  //
  // `hookSpecificOutput.additionalContext` on stdout is the documented way to
  // put text in front of the model, and is what load-rules.mjs uses at
  // SessionStart. `systemMessage` shows the same text to the human, so a hazard
  // is not delivered to one party only.
  //
  // Still exit 0 and still no permissionDecision: this informs, never blocks.
  const text = render(hits);
  process.stdout.write(
    JSON.stringify({
      systemMessage: text,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: text,
      },
    }),
  );
  process.exit(0);
}

/**
 * Run ONLY when executed directly.
 *
 * Without this, `import`ing the module to reuse `parseEntries` /
 * `selftestProblems` would run the guard: it reads stdin (blocking, since an
 * importer has no hook payload to send) and calls `process.exit`, which would
 * take the importing process down. The census imports this file precisely so
 * there is ONE parser rather than two that disagree about the entry count —
 * which is the number the census exists to report.
 */
/**
 * realpathSync on BOTH sides, and that is the whole fix. Node's ESM loader
 * realpaths `import.meta.url`; `process.argv[1]` is left as typed. So invoking
 * through a symlink made the two disagree and this guard silently decided it
 * was an import — no hook ran, no selftest printed, exit 0.
 *
 * That is not hypothetical here: `skills-marketplace/propagate` IS a symlink to
 * `../propagate` (the hub CLAUDE.md documents it as how the plugin is served),
 * and hooks.json invokes `${CLAUDE_PLUGIN_ROOT}/hooks/gotcha-guard.mjs`. So on
 * the served path the guard AND its liveness probe were both dead, reporting
 * success — a check that cannot fire, in the check whose job is to fire.
 *
 * realpathSync throws on a missing path; argv[1] always exists when set, but the
 * try/catch keeps a deleted-mid-run script from bricking the hook.
 */
const isDirectRun = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
})();

if (isDirectRun) {
  try {
    main();
  } catch (err) {
    logLine(`ERROR ${err && err.message}`);
    process.exit(0); // fail open — never block a tool call on this guard's bug
  }
}
