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

import { readFileSync, existsSync, appendFileSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const HOME = os.homedir();

/**
 * Overridable so the mutation checks can prove this guard is able to fail
 * without editing the live index — same reasoning as propagate's
 * PROPAGATE_STATE_DIR, and for the same reason: a check you can only exercise
 * by breaking production is a check nobody exercises.
 */
const GLOBAL_INDEX = process.env.GOTCHA_GUARD_GLOBAL || path.join(HOME, ".claude", "gotchas-global.md");
const LOG = process.env.GOTCHA_GUARD_LOG || path.join(HOME, ".claude", "gotcha-guard.log");

/** Stop the upward walk here; tests point it at a fixture tree. */
const CEILING = process.env.GOTCHA_GUARD_CEILING || HOME;

/** Cap on entries shown at once. Noise is a hiding place (propagate GOTCHAS G23). */
const MAX_SHOWN = 3;

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

/**
 * Extract triggered entries from one GOTCHAS-style file.
 *
 * An entry is a `### ` heading and everything up to the next `##`. Only entries
 * carrying a **Trigger:** line participate — silence for the rest is correct,
 * since most gotchas have no mechanical trigger and inventing one would fire
 * them constantly.
 *
 * @returns {{entries: object[], bad: {source: string, pattern: string, error: string}[]}}
 */
function parseEntries(file) {
  const bad = [];
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { entries: [], bad };
  }
  const out = [];
  // Split on ### headings, keeping the heading with its block.
  const blocks = text.split(/\n(?=### )/);
  for (const block of blocks) {
    const m = block.match(/^### (.+)/);
    if (!m) continue;
    const trig = block.match(/\*\*Trigger:\*\*\s*`([^`]+)`/);
    if (!trig) continue;
    // An optional literal that this entry's trigger MUST match. See selftest:
    // synthesising a matching string from a regex does not work in general
    // (stripping metachars from `^\s*(grep|rg|ugrep)\s` yields "xgreprgugrepx",
    // which matches nothing), and a probe that fails for the wrong reason is
    // no better than one that cannot fail.
    const fires = block.match(/\*\*Fires on:\*\*\s*`([^`]+)`/);
    let re;
    try {
      re = new RegExp(trig[1], "i");
    } catch (err) {
      // A malformed trigger regex must not take the guard down, and must not
      // vanish either.
      //
      // Reported, not merely logged. A regex that fails to compile drops its
      // entry, and an entry that silently stops firing while the probe stays
      // green is precisely the G1 failure this guard exists to prevent — the
      // first version of this code logged it and reported "✓ the guard can
      // fire" with one fewer hazard than the file declares.
      logLine(`bad-trigger ${file} :: ${trig[1]}`);
      bad.push({ source: file, pattern: trig[1], error: String(err && err.message) });
      continue;
    }
    // Body: the lines that carry the hazard and its cost, trigger line removed.
    // Body, with the REMEDY guaranteed present.
    //
    // The first version did `.slice(0, 6)`, which cut G-A mid-sentence and
    // dropped its `**Instead:**` line entirely — so the guard delivered the
    // hazard and the cost but not what to do, which is the only actionable part.
    // A truncation that removes the remedy is worse than no truncation: it
    // spends the interruption and withholds the payoff.
    const lines = block
      .replace(/^### .+\n/, "")
      .replace(/\*\*Trigger:\*\*.*\n?/, "")
      .replace(/\*\*Fires on:\*\*.*\n?/, "")
      .split("\n")
      .filter((l) => l.trim());
    // The remedy is a BLOCK, not a line. Markdown wraps, so `**Instead:** …`
    // routinely spans two or three lines; filtering line-by-line put the
    // continuation of G-G's remedy *above* its own heading and dropped half of
    // G-A's. Everything from the first remedy marker to the end of the entry
    // belongs together, in order.
    const isRemedyStart = (l) => /^\*\*(Instead|Do|Fix|Use)\b/i.test(l.trim());
    const cut = lines.findIndex(isRemedyStart);
    const rest = cut === -1 ? lines : lines.slice(0, cut);
    const remedy = cut === -1 ? [] : lines.slice(cut);

    const KEEP = 8;
    const kept = rest.slice(0, KEEP);
    if (rest.length > KEEP) kept.push(`… (${rest.length - KEEP} more line(s) — see the entry)`);
    const body = [...kept, ...remedy].join("\n");
    out.push({ title: m[1].trim(), trigger: re, firesOn: fires ? fires[1] : null, body, source: file });
  }
  return { entries: out, bad };
}

/** Every GOTCHAS file governing `startDir`, nearest first, plus the global index. */
function sourcesFor(startDir) {
  const found = [];
  let dir = path.resolve(startDir);
  const root = path.parse(dir).root;
  for (;;) {
    for (const rel of [path.join("docs", "GOTCHAS.md"), "GOTCHAS.md"]) {
      const p = path.join(dir, rel);
      if (existsSync(p)) found.push(p);
    }
    if (dir === root || dir === CEILING) break;
    dir = path.dirname(dir);
  }
  if (existsSync(GLOBAL_INDEX)) found.push(GLOBAL_INDEX);
  return found;
}

// ---------------------------------------------------------------------------
// logging — so "never fired" and "never ran" are different facts
// ---------------------------------------------------------------------------

function logLine(msg) {
  try {
    appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* logging must never be the thing that breaks the guard */
  }
}

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

function selftest() {
  const problems = [];

  const sources = sourcesFor(process.cwd());
  if (sources.length === 0) problems.push("no GOTCHAS source found from cwd — the guard can never fire here");

  const parsed = sources.map(parseEntries);
  const entries = parsed.flatMap((r) => r.entries);
  const bad = parsed.flatMap((r) => r.bad);

  for (const b of bad) {
    problems.push(
      `${b.source.replace(HOME, "~")} — trigger \`${b.pattern}\` does not compile (${b.error}), so that entry ` +
        `is silently absent from every match. A dropped hazard must never leave the probe green.`,
    );
  }

  if (entries.length === 0) {
    problems.push(
      `${sources.length} source file(s) found but 0 carry a **Trigger:** line — ` +
        `the guard would run forever and never fire, which reads as "no hazards"`,
    );
  }

  // Per-entry proof that the trigger can fire, using the literal the entry
  // itself declares. This is the G1 discipline applied once per hazard rather
  // than once for the file: a single synthesised sample only ever proves that
  // *one* regex works, and the first version of this probe did not even manage
  // that — it stripped metachars off `^\s*(grep|rg|ugrep)\s` into
  // "xgreprgugrepx" and reported the matcher broken when the matcher was fine.
  //
  // An entry with no **Fires on:** is reported, not silently tolerated: it is
  // an untested trigger, which is the thing this whole file exists to prevent.
  for (const e of entries) {
    if (!e.firesOn) {
      problems.push(`${e.title} — has a **Trigger:** but no **Fires on:** literal, so nothing proves it can fire`);
      continue;
    }
    if (!e.trigger.test(e.firesOn)) {
      problems.push(
        `${e.title} — its own **Fires on:** literal (${JSON.stringify(e.firesOn)}) does NOT match its trigger ` +
          `${e.trigger}. Either the regex is wrong or the example is; this entry would never fire.`,
      );
    }
  }

  // The converse of "can it fire": no single trigger may match EVERY declared
  // example. One that does is not a hazard filter, it is an always-on banner —
  // and a guard that fires on everything is one nobody reads (G23).
  //
  // Checked PER TRIGGER, not "do all entries match this example". The first
  // version asked the latter and let a `.` trigger through, because only two of
  // four entries happened to match the sample it was given.
  const examples = entries.map((e) => e.firesOn).filter(Boolean);
  if (examples.length > 1) {
    for (const e of entries) {
      if (examples.every((x) => e.trigger.test(x))) {
        problems.push(
          `${e.title} — its trigger ${e.trigger} matches all ${examples.length} declared examples. ` +
            `That is an always-on banner, not a hazard filter.`,
        );
      }
    }
  }

  console.log(`gotcha-guard selftest`);
  console.log(`  sources : ${sources.length}`);
  for (const s of sources) console.log(`            ${s.replace(HOME, "~")} (${parseEntries(s).entries.length} triggered)`);
  console.log(`  entries : ${entries.length} with a **Trigger:** line`);
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

try {
  main();
} catch (err) {
  logLine(`ERROR ${err && err.message}`);
  process.exit(0); // fail open — never block a tool call on this guard's bug
}
