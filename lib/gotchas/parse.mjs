/**
 * lib/gotchas/parse.mjs — reading GOTCHAS files, and judging whether their
 * entries can actually fire.
 *
 * WHY THIS IS IN `lib/` AND NOT IN THE HOOK. It used to live inside
 * `hooks/gotcha-guard.mjs`, which made it unreachable from anything else. The
 * first attempt at a gotchas census therefore imported the HOOK from `lib/` —
 * the only `lib -> hooks` edge in the repo, and backwards: hooks are entry
 * points the harness calls, `lib/` is the shared core, and every other hook
 * here already depends downward (`hooks/load-rules.mjs` -> `lib/rules/`).
 *
 * `hooks/doc-authority.mjs` records what the wrong direction costs: it "exited
 * 0 on every edit from 2026-08-20 to 2026-08-22 because lib/ was reorganised
 * into subdirectories and the old flat paths threw — indistinguishable from
 * 'not installed', so nothing reported it."
 *
 * ONE PARSER, DELIBERATELY. The hook and the reconcile/census path must agree
 * about how many entries a file has and which of them are live, because that
 * count is what the census reports. Two parsers would drift, and the drift
 * would look like a finding.
 *
 * Consumers:
 *   hooks/gotcha-guard.mjs   delivers a matching hazard at the moment of risk
 *   the reconcile/doctor path  reports presence AND trigger-liveness
 */

import { readFileSync, existsSync, appendFileSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

export const HOME = os.homedir();

/**
 * Overridable so the mutation checks can prove this guard is able to fail
 * without editing the live index — same reasoning as propagate's
 * PROPAGATE_STATE_DIR, and for the same reason: a check you can only exercise
 * by breaking production is a check nobody exercises.
 */
export const GLOBAL_INDEX = process.env.GOTCHA_GUARD_GLOBAL || path.join(HOME, ".claude", "gotchas-global.md");
export const LOG = process.env.GOTCHA_GUARD_LOG || path.join(HOME, ".claude", "gotcha-guard.log");

/** Stop the upward walk here; tests point it at a fixture tree. */
export const CEILING = process.env.GOTCHA_GUARD_CEILING || HOME;

// ---------------------------------------------------------------------------
// logging — so "never fired" and "never ran" are different facts
// ---------------------------------------------------------------------------

export function logLine(msg) {
  try {
    appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* logging must never be the thing that breaks the guard */
  }
}

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
export function parseEntries(file) {
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

/**
 * A project's own directory under `<ancestor>/propagation/state/`, or null.
 *
 * Exact match first — one `existsSync`, which is the overwhelmingly common case
 * and keeps this cheap on a hot path. The case-insensitive `readdirSync` is a
 * FALLBACK only, and only when `propagation/state` exists at all.
 *
 * That fallback is not defensive padding: `Motherboard/` is the repo directory
 * and `propagation/state/motherboard/` is its project directory. macOS matches
 * those two case-insensitively and hides the mismatch entirely, so an
 * exact-match-only resolver passes every test on this machine and silently
 * delivers nothing on Linux.
 */
function stateDirFor(ancestor, projectName) {
  if (!projectName) return null;
  const stateRoot = path.join(ancestor, "propagation", "state");
  const exact = path.join(stateRoot, projectName);
  if (existsSync(exact)) return exact;
  if (!existsSync(stateRoot)) return null;
  try {
    const want = projectName.toLowerCase();
    for (const name of readdirSync(stateRoot)) {
      if (name.toLowerCase() === want) return path.join(stateRoot, name);
    }
  } catch {
    /* unreadable state dir is not the editor's problem — fall through to null */
  }
  return null;
}

/**
 * Every GOTCHAS file governing `startDir`, nearest first, plus the global index.
 *
 * TWO LAYOUTS, BOTH LIVE. The legacy one is `<repo>/docs/GOTCHAS.md`. The current
 * one puts a project's files in its WORKSPACE — `<ws>/propagation/state/<project>/`
 * — alongside the `STATE.md` and `DECISIONS.md` that moved there 2026-08-21.
 * Both resolve, because the migration is partial by design: 2 of 9 files can move
 * today and the rest are blocked on their workspace gaining a `propagation/state/`.
 * A resolver that understood only one layout would drop half the tree's hazards.
 *
 * ORDER IS THE CONTRACT. `render()` truncates to MAX_SHOWN, so position decides
 * which hazard a person actually reads. Within one ancestor:
 *
 *   1. propagation/state/<child>/   the project you are standing in — most specific
 *   2. docs/GOTCHAS.md, GOTCHAS.md  this ancestor's own, legacy location
 *   3. propagation/state/workspace/ this ancestor's own, current location
 *
 * `child` is the directory we ascended FROM, which is how a workspace knows which
 * of its projects you are in without reading any sidecar.
 */
export function sourcesFor(startDir) {
  const found = [];
  let dir = path.resolve(startDir);
  let child = null;
  const root = path.parse(dir).root;
  const push = (p) => {
    if (p && existsSync(p) && !found.includes(p)) found.push(p);
  };
  for (;;) {
    // 1 — the project directory belonging to the child we came from.
    const projState = stateDirFor(dir, child && path.basename(child));
    if (projState) push(path.join(projState, "GOTCHAS.md"));
    // 2 — this directory's own, legacy location.
    for (const rel of [path.join("docs", "GOTCHAS.md"), "GOTCHAS.md"]) push(path.join(dir, rel));
    // 3 — this directory's own, current location.
    push(path.join(dir, "propagation", "state", "workspace", "GOTCHAS.md"));
    if (dir === root || dir === CEILING) break;
    child = dir;
    dir = path.dirname(dir);
  }
  if (existsSync(GLOBAL_INDEX)) found.push(GLOBAL_INDEX);
  return found;
}

/**
 * The pure half of the probe: given a set of GOTCHAS files, what is wrong?
 *
 * Split out of `selftest()` so the gotchas CENSUS can apply the same
 * validation to each repo it discovers. The probe only ever looked at the
 * sources above `cwd` — 2 files here — so "the guard can fire" was a claim
 * about this directory, not about the tree. Counting files without checking
 * their entries can fire is the same defect one level up, so the census reuses
 * THIS function rather than reimplementing the rules and drifting from them.
 *
 * Returns problems; never prints, never exits.
 */
export function selftestProblems(sources) {
  const problems = [];

  if (sources.length === 0) problems.push("no GOTCHAS source found — the guard can never fire here");

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

  return problems;
}
