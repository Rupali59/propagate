/**
 * cli-flag-parity.test.mjs — every flag a command's handler READS is a flag its
 * allowlist ACCEPTS (ISSUES N120).
 *
 * The allowlist in lib/core/commands.mjs was built 2026-09-26 by "sweeping what
 * commands/*.mjs actually reads from argv". Commands implemented in cli.mjs were
 * outside that population, so their flags were never seen: `backlog --brief`,
 * `--verbose` and `--affects` were REFUSED for eight days, `monitor --install`
 * (the documented generator of an ARMED launchd agent's plist, docs/SYSTEMS.md)
 * and `migrate-refs --workspace` likewise. Nothing was silent — each exited 2
 * naming the flag — which is why it cost little and lasted long.
 *
 * So the population is DERIVED here, from the same source the flags live in: the
 * dispatch in cli.mjs, the handler each branch calls (in cli.mjs or in the
 * commands/*.mjs module it imports), and the `"--flag"` literals in that
 * handler's body. rule:derive-dont-curate — a derived population grows for free.
 *
 * LIMITS, stated rather than hidden:
 *   - A flag read by a HELPER the handler calls, not in the handler body, is not
 *     seen. The test can miss a refused flag; it cannot invent one.
 *   - A body ends at the first column-0 `}` after the function line. The first
 *     probe of this scan ran on to the NEXT top-level function instead, and since
 *     graphIndexCmd is the last one in cli.mjs it swallowed the dispatch block and
 *     reported `graph-index --since` — a false positive written into N120 and
 *     corrected the same day.
 *   - Dispatch is read ONLY from cli.mjs's top-level `if (_invokedDirectly) {`
 *     block. `mode === "…"` also appears INSIDE handlers (skillsLifecycleCmd
 *     branches on its own mode), and the second probe read those as dispatch, so
 *     one branch's "block" ran 900 lines and swallowed eight other handlers.
 *   - `"--x"` literals that are arguments to another program (git) are not CLI
 *     flags. They are exempted by name in EXEMPT — an exemption you must
 *     edit is the safe direction; a stale one fails the test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { COMMANDS } from "../../lib/core/commands.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = readFileSync(path.join(ROOT, "cli.mjs"), "utf8");

/**
 * Literals the scan sees in a handler that are NOT that mode's flags. Each entry
 * carries its reason; an exemption you must edit is the safe direction, and one no
 * handler reads any more fails the stale-exemption test.
 *
 * Two kinds, both from reading the code, not from the allowlist:
 *   - an argument to ANOTHER program the handler spawns;
 *   - a SHARED handler, where the flag is read only on a sibling mode's path.
 * (An earlier draft exempted four git arguments under `check`. The bounded scan
 * showed check's handler never reads them — they live in a helper — and the
 * stale-exemption test removed them.)
 */
const EXEMPT = {
  ui: { "--html": "argument to the spawned `cli.mjs graph --html <out>` (commands/ui.mjs); graph declares it" },
  "skills-promote": { "--apply": "skillsLifecycleCmd is shared; promote/demote return before :4094, so --apply is read on the skills-reap path only" },
  "skills-demote": { "--apply": "skillsLifecycleCmd is shared; promote/demote return before :4094, so --apply is read on the skills-reap path only" },
};

/** The body of top-level function `name` in `src`: its line through the first column-0 `}`. */
function bodyOf(src, name) {
  const lines = src.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^(?:export )?(?:async )?function ${name}\\b`).test(l));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && lines[end] !== "}") end++;
  if (end >= lines.length) return null;
  return lines.slice(start, end + 1).join("\n");
}

/** mode -> [{ name, body, where }] for every handler its dispatch branch calls. */
function handlersByMode() {
  const out = new Map();
  const at = CLI.indexOf("\nif (_invokedDirectly) {");
  if (at < 0) throw new Error("cli.mjs no longer has a top-level `if (_invokedDirectly) {` dispatch — this scan cannot find its population");
  const DISPATCH = CLI.slice(at);
  const marks = [...DISPATCH.matchAll(/mode === "([a-z][a-z0-9-]*)"/g)];
  for (let i = 0; i < marks.length; i++) {
    const mode = marks[i][1];
    // A branch's block runs from its condition to the first mode mark AFTER the
    // branch's opening `{`. Cutting at the next mark instead silently checked
    // nothing for the first mode of `mode === "a" || mode === "b"` — skills-promote
    // resolved to no handler at all, and only the negative control below saw it.
    const open = DISPATCH.indexOf("{", marks[i].index);
    const next = marks.find((m) => m.index > open);
    const block = DISPATCH.slice(marks[i].index, next ? next.index : open + 1500);
    const mod = /import\("\.\/(commands\/[a-z0-9-]+\.mjs)"\)/.exec(block);
    const modSrc = mod && existsSync(path.join(ROOT, mod[1])) ? readFileSync(path.join(ROOT, mod[1]), "utf8") : null;
    const found = out.get(mode) ?? [];
    for (const [, name] of block.matchAll(/\b([a-z][A-Za-z0-9]*Cmd)\(/g)) {
      if (found.some((h) => h.name === name)) continue;
      const body = (modSrc && bodyOf(modSrc, name)) ?? bodyOf(CLI, name);
      if (body) found.push({ name, body, where: modSrc && bodyOf(modSrc, name) ? mod[1] : "cli.mjs" });
    }
    if (found.length) out.set(mode, found);
  }
  return out;
}

test("every flag a command's handler reads is accepted by its allowlist (derived, N120)", () => {
  const handlers = handlersByMode();
  const checked = [...handlers.keys()].filter((m) => COMMANDS[m] && COMMANDS[m].flags !== null);
  // THE FLOOR. A scan that matches nothing passes by finding nothing; that is a
  // blind scan, not a clean result (rule:discernment-checks §2).
  assert.ok(checked.length >= 20, `only ${checked.length} handlers resolved — the scan has gone blind, it has not found nothing`);

  const refused = [];
  for (const mode of checked) {
    const declared = COMMANDS[mode].flags;
    const ignore = new Set(Object.keys(EXEMPT[mode] ?? {}));
    for (const { name, body, where } of handlers.get(mode)) {
      for (const [, flag] of body.matchAll(/["'](--[a-z][a-z-]*)["']/g)) {
        if (!Object.hasOwn(declared, flag) && !ignore.has(flag)) refused.push(`${mode}: ${flag} is read by ${name} (${where}) but refused by lib/core/commands.mjs`);
      }
    }
  }
  assert.deepEqual([...new Set(refused)], [], [...new Set(refused)].join("\n"));
});

test("every EXEMPT entry is still read by its handler — a stale exemption fails", () => {
  const handlers = handlersByMode();
  const stale = [];
  for (const [mode, byFlag] of Object.entries(EXEMPT)) {
    const bodies = (handlers.get(mode) ?? []).map((h) => h.body).join("\n");
    for (const f of Object.keys(byFlag)) if (!bodies.includes(`"${f}"`)) stale.push(`${mode}: ${f}`);
  }
  assert.deepEqual(stale, [], `exemptions no handler reads any more — delete them:\n${stale.join("\n")}`);
});

/* -- negative controls (GOTCHAS G71): the scan must read the RIGHT thing -- */

test("each handler body is exactly one top-level function — the scan does not run on into its neighbours", () => {
  const overlong = [];
  for (const [mode, hs] of handlersByMode()) {
    for (const h of hs) {
      const fns = h.body.match(/^(?:export )?(?:async )?function /gm) ?? [];
      if (fns.length !== 1) overlong.push(`${mode}: ${h.name} body spans ${fns.length} top-level functions`);
    }
  }
  assert.deepEqual(overlong, [], overlong.join("\n"));
});

test("the two false positives of the first probes cannot recur", () => {
  const h = handlersByMode();
  // Probe 1 ran graphIndexCmd (the last function in cli.mjs) into the dispatch block
  // and reported `graph-index --since` — doctor's flag. N120 said so; it was wrong.
  const gi = (h.get("graph-index") ?? []).map((x) => x.body).join("\n");
  assert.ok(gi.length > 0, "control: graph-index resolved to a handler");
  assert.ok(!gi.includes('"--since"'), "graph-index's handler must not be read as reading --since");
  // Probe 2 read `mode === …` inside skillsLifecycleCmd as dispatch and gave
  // skills-promote eight other commands' handlers.
  const sp = (h.get("skills-promote") ?? []).map((x) => x.name);
  assert.deepEqual(sp, ["skillsLifecycleCmd"], `skills-promote resolved to: ${sp.join(", ")}`);
});
