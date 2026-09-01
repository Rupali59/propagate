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

// N54: a relocation signpost is not an inert gotchas file. One predicate, one
// place — the same one `backlog` uses for the STATE.md case (N56).
import { isPointerStubText } from "../migrate/workspace.mjs";

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
/**
 * Could the guard ever be HANDED this string? — N45.
 *
 * `subjectOf` (hooks/gotcha-guard.mjs) passes the matcher exactly two kinds of
 * string: `input.command` for Bash, and `input.file_path` for Edit / Write /
 * NotebookEdit. It never passes the CONTENT being written. So a trigger
 * describing a code pattern matches its own example perfectly and can still
 * never fire, because no tool call delivers that example as a subject.
 *
 * Returns "command" | "path" | null. Null is the finding.
 *
 * HEURISTIC, AND DELIBERATELY NARROW. The alternative — "a Bash command can be
 * any string, so anything is reachable" — is technically true and useless: it
 * would clear all three known-dead entries. What is being asked is not "is this
 * string possible" but "is this string the KIND of thing a subject is", and the
 * `Fires on:` literal is the author's own declaration of that.
 */
export function deliverableAs(literal) {
  const s = String(literal ?? "").trim();
  if (!s) return null;

  // A path: one token, and either rooted/nested or carrying an extension.
  // `app/(site)/layout.tsx` and `tests/watcher/events.test.mjs` qualify;
  // `unstable_cache` does not.
  if (!/\s/.test(s) && (s.includes("/") || /\.[a-z0-9]+$/i.test(s))) return "path";

  // A command: a plausible program token, followed by an argument — or a token
  // that is itself a path (`./script.sh`). The trailing-argument requirement is
  // what keeps a bare identifier like `unstable_cache` from passing as a
  // command it will never be.
  const [head] = s.split(/\s+/);
  const headIsProgramLike = /^[A-Za-z_.~/][\w.\-/~]*$/.test(head);
  if (headIsProgramLike && (/\s/.test(s) || head.includes("/") || head.includes("."))) return "command";

  // A SHELL ASSIGNMENT IS A COMMAND LINE. `FOO=1 cmd args`, but also plain
  // `n=$(git cherry ... )` and `amodels="${6:-{}}"` — all three are things an
  // agent types into Bash, so all three are deliverable as `input.command`.
  //
  // This clause exists because the first version of the check did not have it
  // and produced TWO FALSE POSITIVES out of three findings on the real tree,
  // declaring two live entries dead. A wrong "this is dead" is worse than a
  // missed one: it invites deleting a trigger that works.
  if (/^[A-Za-z_][\w]*=/.test(s)) return "command";

  return null;
}

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

  // A POINTER STUB IS NOT AN INERT GOTCHAS FILE. This is N54, and it is N56's
  // failure one register over: the 2026-08-21/24 relocations left a 14-line
  // signpost at every old path, and a signpost has no entries because it has no
  // hazards — not because its hazards lack triggers.
  //
  // Measured 2026-09-01: all FOUR files this probe called inert were stubs —
  // Motherboard/docs, Tushar/docs, Keerti/keerti-job-radar/docs and
  // PanditPawanKaushik/docs/gemstone-storefront/shopify. Every one of those
  // projects has a POPULATED GOTCHAS.md at its new path (Motherboard 14 entries /
  // 11 triggers, Keerti 23/7, PPK 29/4, Tushar 3/2). So the headline "4 inert"
  // described a migration that had already succeeded, and acting on it would mean
  // writing triggers into signposts.
  //
  // `backlog` learned this for STATE.md when N56 was fixed by calling
  // `isPointerStubText` in the `state-live-sections` path. Same predicate, same
  // reason, applied here. Counted and reported separately — never silently
  // dropped, because "N stubs skipped" and "N files with no triggers" are
  // different facts and only one of them is a defect.
  const stubs = sources.filter((s) => {
    try {
      return isPointerStubText(readFileSync(s, "utf8"));
    } catch {
      return false; // unreadable is its own problem, reported elsewhere
    }
  });
  const live = sources.filter((s) => !stubs.includes(s));

  if (entries.length === 0 && live.length > 0) {
    problems.push(
      `${live.length} live source file(s) found but 0 carry a **Trigger:** line — ` +
        `the guard would run forever and never fire, which reads as "no hazards"` +
        (stubs.length > 0 ? ` (${stubs.length} pointer stub(s) skipped, not counted as inert)` : ""),
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
    // Reachability BEFORE match-ability: a trigger that matches an example the
    // guard is never handed is dead however well the regex works, and reporting
    // only the regex would call it healthy.
    if (deliverableAs(e.firesOn) === null) {
      problems.push(
        `${e.title} — its **Fires on:** literal (${JSON.stringify(e.firesOn)}) is UNREACHABLE: it is ` +
          `neither a file path nor a command, and those are the only subjects the guard is ever handed ` +
          `(Bash \`command\`, Edit/Write \`file_path\` — never file CONTENT). No tool call can deliver ` +
          `it, so this entry can never fire. Rewrite the trigger against the path or command that ` +
          `introduces the hazard, or drop the **Trigger:** line and let it be an ordinary entry.`,
      );
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
