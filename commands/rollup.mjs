/**
 * commands/rollup.mjs — `propagate rollup [--check|--dry-run] [--force] [--json]`
 *
 * THE ONLY FILE IN THIS CODEBASE THAT MAY WRITE `ECOSYSTEM.md`, and there is
 * exactly ONE `writeFileSync` call in this whole file, gated on `!dryRun`
 * with `dryRun` threaded from argv all the way down to that call site. This
 * is the shape `rule:safety-flag-needs-a-test` names directly: the
 * 2026-08-14 `digest.mjs` defect was a flag honoured on one code path and
 * not a NESTED one — `dryRun` gated the top-level function while
 * `lifecycleSweep()` called `reap(candidates, { apply: true })`
 * unconditionally underneath it. There is no "underneath" here: `rollup()`
 * and `renderRollup()` (`lib/report/rollup.mjs`) are READ-ONLY BY
 * CONSTRUCTION — the module header there states it and contains zero
 * `writeFileSync` calls — so the only place a write can happen at all is
 * this file, and this file has exactly one.
 *
 * WHAT THIS FILE DOES NOT DO. It never re-walks the tree (that is
 * `backlog()`/`inventory()`, called once via `rollup()`), never invents a
 * freshness rule (that is `bodyHash`/`parseFooter`/`compareInputs`, all
 * imported), and never decides what "hand-edited" means beyond "recompute
 * the on-disk body hash and compare it to the footer's stored `body:`" —
 * the exact test the plan specifies, not a looser heuristic like a stored
 * byte length or a `Last-Modified` stamp (those rot the way
 * `rule:state-and-decisions` already named for counts).
 *
 * WHY THE ARTIFACT PATH IS `SEARCH_ROOTS[0]`, NOT SOME `HUB_ROOT`. Measured
 * this session: `~/.propagate/config.yml` has no `hubRoot` key at all — only
 * `searchRoots` and `scheduler`. `lib/core/config.mjs`'s `HUB_ROOT` is
 * *inferred* (from `PROPAGATE_HUB_ROOT`, then `config.yml`'s `hubRoot` if it
 * existed, then a declared `searchRoots[0]`) and is used for OTHER things
 * (`underHub()`), but `shortPath()` and `digest.mjs`'s own `GITHUB_ROOT`
 * both key off `SEARCH_ROOTS[0]` directly — so does this file, for the same
 * reason: it is the value that is actually always populated when discovery
 * runs at all, and using anything else would make this command able to
 * derive a rollup while being unable to say where to put it.
 *
 * STDOUT DISCIPLINE — THE N65 FIX, GENERALISED RATHER THAN REPEATED.
 * `cli.mjs:4311-4320` documents N65: an update notice reached stdout via
 * `console.log` AHEAD of `status`/`doctor`'s `--json` output, because the
 * notice was printed unconditionally and only the JSON payload itself was
 * gated on the flag. Conditionally routing "is this JSON mode" per print
 * site is exactly the kind of per-call-site discipline that flag-drift
 * defeats. This file does not repeat that shape: EVERY human-facing line —
 * progress, warnings, the hand-edit refusal, the check summary — goes to
 * `console.error` (stderr), UNCONDITIONALLY, never gated on `--json`.
 * `console.log` (stdout) is reserved for exactly two things: the JSON
 * payload when `--json` is passed, and the rendered Markdown body when
 * `--dry-run` is passed without `--json` (the one case where the "product"
 * itself, not a status line, belongs on stdout — it is what a human pipes
 * to a pager or diffs against the committed file). Because no human line
 * ever targets stdout in the first place, there is no per-call-site flag
 * check that a future edit can forget.
 *
 * Import prefix is `../lib/…` from here, matching every other file in this
 * directory — G60: a specifier copied out of `cli.mjs` is relative to the
 * repo root and resolves to a different, non-existent file from inside
 * `commands/`, failing only at runtime.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { RESET, RED, GREEN, YELLOW } from "./ansi.mjs";
import { SEARCH_ROOTS } from "../lib/core/config.mjs";
import { rollup, renderRollup, bodyHash, parseFooter, compareInputs } from "../lib/report/rollup.mjs";

export const ARTIFACT_NAME = "ECOSYSTEM.md";

/**
 * `SEARCH_ROOTS[0]` or `null` when discovery has no root at all (an
 * unconfigured machine — `HUB_ROOT_DIAGNOSTIC` already names the fix). A
 * `null` here is a could-not-run, never a crash: there is nowhere to derive
 * relative to and nowhere to write, and that is a fact about the install,
 * not a defect in this command.
 */
export function artifactPath() {
  return SEARCH_ROOTS[0] ? path.join(SEARCH_ROOTS[0], ARTIFACT_NAME) : null;
}

function printJson(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

function errLine(s = "") {
  console.error(s);
}

/**
 * exit 2, "could-not-run" — reusing `lib/core/release.mjs`'s three-state
 * vocabulary verbatim (its header states it first): "could-not-run" is not
 * a synonym for failure, so this command can join a release gate later
 * without a translation layer between the two vocabularies.
 */
function couldNotRun({ artifact, json }, reason) {
  if (json) {
    printJson({ ok: false, status: "could-not-run", path: artifact, reason });
  } else {
    errLine(`${RED}could-not-run:${RESET} ${reason}`);
  }
  return 2;
}

const handEditMessage = (artifact, reason) =>
  [
    `${RED}refusing to overwrite ${artifact}${RESET} — it has been hand-edited since it was last generated.`,
    `  ECOSYSTEM.md is a GENERATED view of the tree; a hand edit to it is never merged`,
    `  back in, and a normal regeneration would silently destroy it. Same posture as`,
    `  lib/migrate/workspace.mjs's sidecar writer: "never clobber a hand-written sidecar".`,
    `  If you want to write something by hand, put it in NORTH_STAR.md instead — see`,
    `  its "What is actually built" section, which is this file's authored counterpart.`,
    ``,
    `  reason: ${reason}`,
    ``,
    `  --force    discard the hand edit and regenerate from the tree`,
    `  --dry-run  preview what a regeneration would produce, without writing anything`,
  ].join("\n");

/**
 * Is `existingText` a file `propagate rollup` produced and nothing has
 * touched since? THE test is exactly the one the plan specifies: recompute
 * the on-disk body hash (the bytes strictly between the two markers, via
 * `bodyHash` — the SAME function `renderRollup` calls to write the footer in
 * the first place, never a second hand-derived slice) and compare its
 * shortened form to the footer's stored `body:` field. Three ways this can
 * fail short of a body edit, and all three are "hand-edited" for this
 * command's purposes because in every case the file is not something a
 * plain regeneration is safe to overwrite silently:
 *   - no footer at all (`parseFooter` returns `null`) — a foreign file, or
 *     one whose footer block was deleted by hand;
 *   - a footer that does not parse (`parsed.malformed`) — a partially
 *     hand-edited footer;
 *   - a footer that parses but whose recomputed body hash disagrees with
 *     the stored one — the generated section itself was edited.
 */
function detectHandEdit(existingText) {
  const parsed = parseFooter(existingText);
  if (parsed === null) {
    return {
      edited: true,
      reason:
        "no `propagate:rollup:inputs` footer found — this file was not generated by `propagate rollup`, or the footer block was removed",
    };
  }
  if (parsed.malformed) {
    return { edited: true, reason: `footer marker present but malformed: ${parsed.reason}` };
  }
  const actualFull = bodyHash(existingText);
  if (actualFull === null) {
    return {
      edited: true,
      reason: "body/footer markers missing or out of order — cannot verify this file was machine-generated",
    };
  }
  const actualShort = actualFull.slice(0, 12);
  if (actualShort !== parsed.body) {
    return {
      edited: true,
      reason: `stored body hash (${parsed.body}) does not match the file's current body (${actualShort}) — the generated section was edited by hand since it was last written`,
    };
  }
  return { edited: false, parsed };
}

/**
 * Stored inputs (from the existing file's footer, or an empty Map when the
 * file is absent/unparseable) vs. a freshly-derived input set, via
 * `compareInputs` — never a second, hand-rolled diff. An absent file
 * naturally reads as every input having `appeared` (before=ABSENT for every
 * key on the stored side), which is the correct answer for "--check on a
 * file that has never been generated": it is not current, and it is not a
 * hand-edit — it is stale in the most literal sense, nothing has been
 * written yet.
 */
function diffAgainstExisting(existingText, currentInputs) {
  const parsed = existingText ? parseFooter(existingText) : null;
  const storedInputs = parsed && !parsed.malformed ? parsed.inputs : new Map();
  return compareInputs(storedInputs, currentInputs);
}

function diffIsEmpty(diff) {
  return !diff.changed.length && !diff.appeared.length && !diff.vanished.length && !diff.becameUnreadable.length;
}

function formatDiffLines(diff) {
  const lines = [];
  for (const { key, before, after } of diff.becameUnreadable) {
    lines.push(`  became-unreadable  ${key}  (${before} -> ${after})`);
  }
  for (const { key, before } of diff.vanished) {
    lines.push(`  vanished            ${key}  (was ${before})`);
  }
  for (const { key, after } of diff.appeared) {
    lines.push(`  appeared            ${key}  (now ${after})`);
  }
  for (const { key, before, after } of diff.changed) {
    lines.push(`  changed             ${key}  (${before} -> ${after})`);
  }
  return lines;
}

function toDiffJson(diff) {
  return {
    changed: diff.changed,
    appeared: diff.appeared,
    vanished: diff.vanished,
    becameUnreadable: diff.becameUnreadable,
  };
}

/**
 * `--check` — read-only BY CONSTRUCTION: no branch in this function ever
 * reaches the module's one `writeFileSync` call site (that call site is not
 * even in scope here; it lives only in `runGenerate` below). Four exits:
 * `0` current, `1` stale (names every input via `compareInputs`), `2`
 * could-not-run, `3` hand-edited.
 */
async function runCheck({ artifact, json }) {
  let existingText;
  try {
    existingText = existsSync(artifact) ? readFileSync(artifact, "utf8") : null;
  } catch (err) {
    return couldNotRun({ artifact, json }, `could not read existing ${artifact}: ${err.message}`);
  }

  if (existingText !== null) {
    const edit = detectHandEdit(existingText);
    if (edit.edited) {
      if (json) {
        printJson({ ok: false, status: "hand-edited", path: artifact, reason: edit.reason });
      } else {
        errLine(handEditMessage(artifact, edit.reason));
      }
      return 3;
    }
  }

  let result;
  try {
    result = rollup({ searchRoots: SEARCH_ROOTS });
  } catch (err) {
    return couldNotRun({ artifact, json }, `derivation failed: ${err.message}`);
  }

  const diff = diffAgainstExisting(existingText, result.inputs);
  const current = diffIsEmpty(diff);

  if (json) {
    printJson({
      ok: current,
      status: current ? "current" : "stale",
      path: artifact,
      exists: existingText !== null,
      diff: toDiffJson(diff),
    });
  } else if (current) {
    errLine(`${GREEN}current${RESET} — ${artifact} matches the tree.`);
  } else {
    errLine(
      `${YELLOW}stale${RESET} — ${artifact} ${
        existingText === null ? "does not exist yet" : "no longer matches the tree"
      }:`,
    );
    for (const line of formatDiffLines(diff)) errLine(line);
    errLine("  run `propagate rollup` to regenerate.");
  }

  return current ? 0 : 1;
}

/**
 * Bare `rollup`, `--dry-run`, `--force`, `--json`, and their combinations —
 * everything that is NOT `--check`. Always fully re-derives and re-renders
 * (unlike `--check`, this path does not ask "did the inputs move" — a plain
 * `propagate rollup` regenerates unconditionally, the same way `render`
 * commands elsewhere in this tree do); the only questions are whether an
 * existing file may be overwritten (hand-edit refusal, bypassed by
 * `--force`) and whether the write actually happens (`--dry-run`).
 *
 * `dryRun` is threaded as a plain parameter from `rollupCmd`'s argv parse
 * all the way to the single guarded write below — no second flag, no
 * re-derivation of "are we in dry-run mode" partway through.
 */
async function runGenerate({ artifact, json, dryRun, force }) {
  let existingText;
  try {
    existingText = existsSync(artifact) ? readFileSync(artifact, "utf8") : null;
  } catch (err) {
    return couldNotRun({ artifact, json }, `could not read existing ${artifact}: ${err.message}`);
  }

  if (existingText !== null && !force) {
    const edit = detectHandEdit(existingText);
    if (edit.edited) {
      if (json) {
        printJson({ ok: false, action: "refused", path: artifact, reason: edit.reason });
      } else {
        errLine(handEditMessage(artifact, edit.reason));
      }
      return 3;
    }
  }

  let result;
  try {
    result = rollup({ searchRoots: SEARCH_ROOTS });
  } catch (err) {
    return couldNotRun({ artifact, json }, `derivation failed: ${err.message}`);
  }

  if (!result.coverage.ok) {
    // Non-blocking: the render still happens and still says so in its own
    // Coverage section (`rollup.mjs`'s own contract). This is a second,
    // louder surface for the same fact — `rule:discernment-checks` §2, an
    // invariant violation must never read as silence.
    errLine(
      `${YELLOW}warning:${RESET} coverage invariant violated — ${result.coverage.summedItems} item(s) summed ` +
        `across owner groups vs ${result.coverage.rankedLength} ranked item(s). Rendering anyway; see the ` +
        `rendered Coverage section for detail.`,
    );
  }

  const text = renderRollup(result);
  const forced = Boolean(force && existingText !== null);

  // ─────────────────────────────────────────────────────────────────────
  // THE ONLY writeFileSync IN THIS FILE, and it is INSIDE `if (!dryRun)` —
  // literally, not via an early-return that merely happens to skip past it.
  // An early-return reads identically at a glance but is exactly the shape
  // that let `digest.mjs`'s NESTED `reap(candidates, { apply: true })` go
  // unguarded on 2026-08-14: the guard lived on the outer function, the
  // effect on an inner one, and nothing forced the two to be read together.
  // Keeping the write physically inside the negated condition means there
  // is one block to read, not two functions to trace. See the file header
  // and rule:safety-flag-needs-a-test.
  // ─────────────────────────────────────────────────────────────────────
  if (!dryRun) {
    try {
      writeFileSync(artifact, text);
    } catch (err) {
      return couldNotRun({ artifact, json }, `could not write ${artifact}: ${err.message}`);
    }
  }

  if (dryRun) {
    if (json) {
      printJson({ ok: true, action: "would-write", path: artifact, bytes: Buffer.byteLength(text, "utf8"), forced });
    } else {
      // The one deliberate exception to "human lines go to stderr": this IS
      // the product, not commentary about it — the thing verification asked
      // to see pasted, and the thing a human pipes to a pager or a diff.
      console.log(text);
    }
    return 0;
  }

  if (json) {
    printJson({ ok: true, action: "written", path: artifact, bytes: Buffer.byteLength(text, "utf8"), forced });
  } else {
    errLine(`${GREEN}wrote${RESET} ${artifact} (${Buffer.byteLength(text, "utf8")} bytes)`);
  }
  return 0;
}

export async function rollupCmd(argv = []) {
  const json = argv.includes("--json");
  const dryRun = argv.includes("--dry-run");
  const force = argv.includes("--force");
  const checkMode = argv.includes("--check");

  const artifact = artifactPath();
  if (!artifact) {
    return couldNotRun(
      { artifact: null, json },
      "no search root configured — nothing to derive relative to and nowhere to write. " +
        "Set PROPAGATE_SEARCH_ROOTS, or add `searchRoots:` via `propagate setup`.",
    );
  }

  return checkMode ? runCheck({ artifact, json }) : runGenerate({ artifact, json, dryRun, force });
}
