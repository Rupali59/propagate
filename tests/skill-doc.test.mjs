/**
 * Doc invariants: the docs must not be able to lie.
 *
 * WHY THIS EXISTS. On 2026-08-13 SKILL.md's install, doctor and disable blocks
 * all named the launchd label `com.rupali.propagate`, which had not existed for
 * some time -- the live agents are `com.tathya.propagate.watcher` and
 * `com.tathya.propagate.digest`. Every `launchctl` line a reader could copy out
 * of the entry doc failed. The code had handled the rename correctly
 * (lib/plist.mjs exports LABEL, deliberately env-overridable "so a rename does
 * not silently break doctor's own checks"); only the prose missed it, because
 * prose had no owner and no check. This file is the check.
 *
 * The same audit found SKILL.md documenting `drain` and `declare` as if they
 * were CLI commands -- cli.mjs registers neither -- and STATE.md claiming a
 * 116-test suite against an actual 194.
 *
 * DESIGN NOTE on the launchd assertion. It reads the live system rather than
 * importing LABEL from lib/plist.mjs, because the question being asked is "do
 * the docs match what is actually installed on this machine", not "do the docs
 * match a constant". The cost is that it cannot run on linux CI, so it skips
 * there -- and a skip MUST announce itself. A silently-skipped assertion reads
 * as a pass, which is SPEC.md I1 ("no silent no-op") reproduced inside the test
 * written to enforce it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");

/** Every prose doc that a reader can land on. Keep in sync with docs/README.md. */
function docFiles() {
  const files = [path.join(ROOT, "SKILL.md"), path.join(ROOT, "STATE.md")];
  const docsDir = path.join(ROOT, "docs");
  if (existsSync(docsDir)) {
    for (const f of readdirSync(docsDir).filter((f) => f.endsWith(".md"))) {
      files.push(path.join(docsDir, f));
    }
  }
  return files.filter(existsSync);
}

const read = (f) => readFileSync(f, "utf8");
const rel = (f) => path.relative(ROOT, f);

// ─────────────────────────────────────────────────────────────────────────────
// 1 · Every relative link resolves
// ─────────────────────────────────────────────────────────────────────────────

test("every relative markdown link resolves on disk", () => {
  const broken = [];
  for (const file of docFiles()) {
    const dir = path.dirname(file);
    for (const m of read(file).matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const target = m[1];
      // External and in-page links are out of scope for a filesystem check.
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const withoutAnchor = target.split("#")[0];
      if (!withoutAnchor) continue;
      // `${CLAUDE_PLUGIN_ROOT}` is resolved by the harness, not by us.
      if (withoutAnchor.includes("${")) continue;
      if (!existsSync(path.resolve(dir, withoutAnchor))) {
        broken.push(`${rel(file)} -> ${target}`);
      }
    }
  }
  assert.deepEqual(broken, [], `broken relative links:\n  ${broken.join("\n  ")}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2 · Launchd labels named in prose are actually installed
// ─────────────────────────────────────────────────────────────────────────────

test("every launchd label named in the docs is installed", (t) => {
  const agentsDir = path.join(os.homedir(), "Library", "LaunchAgents");
  if (os.platform() !== "darwin" || !existsSync(agentsDir)) {
    // Announce, do not swallow. See DESIGN NOTE at the top of this file.
    console.warn(
      `[skill-doc] SKIPPED launchd label check: platform=${os.platform()}, ` +
        `LaunchAgents=${existsSync(agentsDir)}. Label correctness is unverified on this host.`,
    );
    t.skip("launchd is macOS-only; label correctness is a local-only check");
    return;
  }

  const installed = new Set(
    readdirSync(agentsDir)
      .filter((f) => f.endsWith(".plist"))
      .map((f) => f.replace(/\.plist$/, "")),
  );

  // Only flag a label in an EXECUTABLE context: a line invoking `launchctl` or
  // naming a path under `LaunchAgents/`. That is where a wrong label actually
  // costs someone something -- they copy the line and it fails.
  //
  // Prose that merely MENTIONS a label is allowed on purpose. The docs have to
  // be able to describe the bug (ISSUES.md N10 is literally the sentence
  // "SKILL.md says com.rupali.propagate") and to flag the stale
  // com.rupali.propagate-digest.plist (SYSTEMS.md). A check that forbids naming
  // a wrong value is a check that forbids reporting it.
  //
  // That plist was DELETED 2026-08-19. It was committed with /Users/rupali.b and
  // /opt/homebrew/bin/node baked in, under a label (com.rupali.propagate-digest)
  // that does not match the job actually loaded on this machine
  // (com.tathya.propagate.digest, installed from ~/Library/LaunchAgents). It was
  // a stale artifact shipping a personal path to every install, referenced by no
  // code. Generating the digest plist the way lib/plist.mjs already generates the
  // monitor one is Phase 3 — see docs/plans/2026-08-19-portability-and-rules.md.
  const unknown = [];
  for (const file of docFiles()) {
    read(file)
      .split("\n")
      .forEach((line, i) => {
        if (!/launchctl|LaunchAgents\//.test(line)) return;
        for (const m of line.matchAll(/\bcom\.[a-z0-9]+\.propagate[a-z0-9.\-]*/gi)) {
          const label = m[0].replace(/\.plist$/, "").replace(/[.,)]+$/, "");
          if (!installed.has(label)) unknown.push(`${rel(file)}:${i + 1}: ${label}`);
        }
      });
  }

  assert.deepEqual(
    unknown,
    [],
    `docs name launchd labels that are not installed:\n  ${unknown.join("\n  ")}\n` +
      `installed: ${[...installed].join(", ")}`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 3 + 4 · The documented CLI surface matches the real one
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Commands cli.mjs actually dispatches.
 *
 * Read from the `mode === "..."` chain (cli.mjs ~:1111), NOT from the usage
 * string. The usage string is prose: its nested `[--a|--b]` option groups
 * contain pipes, so splitting it on `|` invents commands like `--staged] [--strict`
 * and loses real ones. The dispatch chain is what actually runs.
 */
function registeredCommands() {
  const cli = read(path.join(ROOT, "cli.mjs"));
  const found = [...cli.matchAll(/mode === "([a-z][a-z0-9-]*)"/g)].map((m) => m[1]);
  assert.ok(
    found.length > 0,
    "no `mode === \"...\"` dispatch found in cli.mjs — update this parser if the shape changed",
  );
  return new Set(found);
}

/** Every `cli.mjs <word>` the docs tell a reader to run. */
function documentedCommands() {
  const found = [];
  for (const file of docFiles()) {
    for (const m of read(file).matchAll(/cli\.mjs\s+([a-z][a-z0-9-]*)/g)) {
      found.push({ file: rel(file), cmd: m[1] });
    }
  }
  return found;
}

test("every CLI command the docs name is registered in cli.mjs", () => {
  const registered = registeredCommands();
  const bogus = documentedCommands()
    .filter(({ cmd }) => !registered.has(cmd))
    .map(({ file, cmd }) => `${file}: cli.mjs ${cmd}`);

  assert.deepEqual(
    bogus,
    [],
    `docs invoke commands cli.mjs does not register:\n  ${bogus.join("\n  ")}\n` +
      `registered: ${[...registered].join(", ")}`,
  );
});

test("declare is never presented as a CLI command", () => {
  // `declare` is a prose procedure an agent walks through -- there is no
  // `cli.mjs declare`, and documenting one would send a reader to a command
  // that does not exist.
  //
  // NOTE: `drain` was in this assertion until 2026-08-13, when `cli drain`
  // shipped (SPEC.md §6, "new, and required"). It is now a real subcommand and
  // is covered by the registered-commands test above instead. The narrowing is
  // deliberate: the invariant is "docs must not name commands that do not
  // exist", not "drain must never exist".
  const offenders = documentedCommands()
    .filter(({ cmd }) => cmd === "declare")
    .map(({ file, cmd }) => `${file}: cli.mjs ${cmd}`);

  assert.deepEqual(
    offenders,
    [],
    `declare documented as a CLI command:\n  ${offenders.join("\n  ")}`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 5 · The premise exists once, and its copy matches
// ─────────────────────────────────────────────────────────────────────────────

/**
 * SKILL.md is canonical: it is the only file the agent loads, so the premise
 * has to live there. SPEC.md quotes it so the spec opens from the same words.
 * Both are fenced with markers so this check never has to guess.
 */
function extractPremise(file) {
  const text = read(file);
  const m = text.match(/<!--\s*premise:start\s*-->([\s\S]*?)<!--\s*premise:end\s*-->/);
  return m
    ? m[1]
        .replace(/^\s*>\s?/gm, "") // strip blockquote markers (SPEC.md quotes it)
        .replace(/\s+/g, " ")      // wrapping is not meaning
        .trim()
    : null;
}

test("SKILL.md carries the canonical premise and SPEC.md quotes it verbatim", () => {
  const skill = extractPremise(path.join(ROOT, "SKILL.md"));
  const spec = extractPremise(path.join(ROOT, "docs", "SPEC.md"));

  assert.ok(skill, "SKILL.md is missing its <!-- premise:start/end --> block");
  assert.ok(spec, "docs/SPEC.md §1 is missing its <!-- premise:start/end --> block");
  assert.equal(spec, skill, "SPEC.md's premise quote has drifted from SKILL.md (canonical)");
});

// ─────────────────────────────────────────────────────────────────────────────
// 6 · No hardcoded test counts
// ─────────────────────────────────────────────────────────────────────────────

test("no doc hardcodes an unqualified test count", () => {
  // STATE.md said "116/116 tests pass" against an actual 194. Rather than
  // chase the number, forbid the shape: a count with no date is a claim that
  // rots by construction. Historical notes must carry their date, e.g.
  // "116/116 as of 2026-08-10".
  // Scoped to the current-status surfaces only. docs/DECISIONS.md is an
  // append-only log whose entries are dated by their headings, and
  // docs/ISSUES.md states test counts as facts about subsystems -- neither is
  // claiming "this is the suite size right now", which is the rot being killed.
  const currentStatusDocs = [path.join(ROOT, "STATE.md"), path.join(ROOT, "SKILL.md")].filter(
    existsSync,
  );

  const offenders = [];
  for (const file of currentStatusDocs) {
    read(file)
      .split("\n")
      .forEach((line, i) => {
        if (!/\b\d+\s*(?:\/\s*\d+)?\s+tests?\b/i.test(line)) return;
        if (/\b\d{4}-\d{2}-\d{2}\b/.test(line)) return; // dated = historical, allowed
        offenders.push(`${rel(file)}:${i + 1}: ${line.trim()}`);
      });
  }
  assert.deepEqual(
    offenders,
    [],
    `undated test-count claims (add a date or drop the number):\n  ${offenders.join("\n  ")}`,
  );
});
