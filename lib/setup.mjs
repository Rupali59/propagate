/**
 * setup.mjs — the install-time bootstrap.
 *
 * WHY THIS EXISTS. Installing the plugin and running `status` gave: zero
 * workspaces, no error, exit 0, nothing works. `lib/config.mjs` predicted exactly
 * that in prose ("discovery on another machine silently finds zero workspaces and
 * the watcher reports healthy forever, which is precisely the 'abandoned
 * automation reports itself healthy' failure this skill exists to catch") and
 * nothing detected it. This command is the detection, plus the fix it enables.
 *
 * WHY NOT `init` OR `bootstrap`. Both verbs are taken by unrelated commands —
 * `init <dir>` scaffolds a `.propagates.yml`, `bootstrap` baselines edges. Piling
 * "configure the whole install" onto either would make the dangerous reading the
 * plausible one, in a CLI whose own GOTCHAS record a flag that meant different
 * things in adjacent subcommands (G44) costing 11 spurious events.
 *
 * THE CONTRACT, and the only part that really matters:
 *
 *   setup NEVER reports success on an install where discovery finds nothing.
 *
 * A bootstrap that says "ready" over a silent-zero-discovery is that same failure
 * wearing the uniform of the fix. rule:safety-flag-needs-a-test: a command that
 * promises a working install is making a claim about another subsystem, and an
 * unverified claim is worse than no claim, because people act on it.
 *
 * HOW IT VERIFIES — and why it re-reads its own output. The check runs discovery
 * over the roots parsed back OUT of the config file just written, not over the
 * roots held in memory. Those differ exactly when the write is the thing that is
 * broken, which is the case worth catching: verifying the in-memory value would
 * confirm the intent and miss the artifact. `lib/config.mjs` evaluates at module
 * load, so the freshly-written file is NOT in force in this process — reading it
 * back is also the only way to see what the next invocation will see.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { parse as parseYaml } from "yaml";
import { discoverWorkspacesSync, DEFAULT_MAX_DEPTH } from "./discovery.mjs";

const HOME = os.homedir();

/**
 * Layouts probed when `--roots` is absent, in order.
 *
 * `~/Documents/GitHub` is this author's layout and is listed FIRST for continuity
 * on the machine that already runs this, not because it is more canonical than the
 * rest. A probe is a convenience; it never overrides an explicit `--roots`, and a
 * probe that finds nothing must ask rather than guess.
 */
export const PROBE_LAYOUTS = Object.freeze([
  path.join(HOME, "Documents", "GitHub"),
  path.join(HOME, "code"),
  path.join(HOME, "src"),
  path.join(HOME, "dev"),
  path.join(HOME, "projects"),
  path.join(HOME, "repos"),
  path.join(HOME, "git"),
  path.join(HOME, "workspace"),
]);

/** Directories that exist among the probe list. Separate from "has markers". */
export function probeRoots(layouts = PROBE_LAYOUTS) {
  return layouts.filter((p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  });
}

/** Split a PATH-style `--roots` value. Absent/blank yields []. */
export function parseRootsArg(raw) {
  if (typeof raw !== "string") return [];
  return raw
    .split(":")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => (p.startsWith("~/") ? path.join(HOME, p.slice(2)) : path.resolve(p)));
}

/**
 * Render config.yml.
 *
 * Hand-written by design — a generated file people are expected to edit needs to
 * explain itself, and the comments are the only documentation an operator gets at
 * the moment they open it. `scheduler` is emitted with the resolved platform
 * default rather than omitted, so a Linux install can SEE that nothing is
 * scheduled instead of inferring it from silence.
 */
export function renderConfig({ roots, scheduler }) {
  const lines = [
    "# propagate — install configuration.",
    "# Written by `propagate setup`. Safe to edit by hand; re-run setup --force to regenerate.",
    "#",
    "# Precedence is env > this file > built-in default, in that order and no other.",
    "# So PROPAGATE_SEARCH_ROOTS in your shell still wins over what is written here.",
    "",
    "# Roots discovery walks looking for `.propagates.yml` markers.",
    "searchRoots:",
    ...roots.map((r) => `  - ${r}`),
    "",
    "# launchd | systemd | none. `none` is fully supported, not degraded: the v1",
    "# watcher is retired and drift is derived from content on demand in ~1.2s.",
    "# Without a scheduler you lose proactive notification and nothing else.",
    `scheduler: ${scheduler}`,
    "",
  ];
  return lines.join("\n");
}

/**
 * Classify what discovery found. Kept separate from printing so the reason is a
 * value the caller can assert on — "absence must be attributable"
 * (rule:discernment-checks §2) is unenforceable when the reason exists only as an
 * English sentence inside a console.log.
 *
 * Three reasons, not two. `markers-rejected` is the case where discovery SAW
 * `.propagates.yml` files and produced no workspace from any of them — a schema or
 * `workspace: true` problem, fixed by editing a sidecar, whereas `no-markers` is
 * fixed by running `init <dir>`. Discovery already computes this as `degraded`;
 * collapsing it into "found nothing" would send the reader to the wrong fix.
 *
 * @returns {{ok: boolean, reason: "ok"|"roots-missing"|"no-markers"|"markers-rejected", missing: string[], present: string[], workspaces: object[], markersSeen: number, depth: number}}
 */
export function verifyDiscovery(roots, maxDepth) {
  // Resolve the sentinel HERE, once, so every consumer reports the same number as
  // the walk actually used. Passing `undefined` through to discovery and printing
  // `undefined` at the operator is two bugs sharing one variable.
  const depth = Number.isInteger(maxDepth) && maxDepth > 0 ? maxDepth : DEFAULT_MAX_DEPTH;
  const present = [];
  const missing = [];
  for (const r of roots) {
    try {
      if (statSync(r).isDirectory()) present.push(r);
      else missing.push(r);
    } catch {
      missing.push(r);
    }
  }
  const base = { missing, present, workspaces: [], markersSeen: 0, depth };
  if (present.length === 0) return { ...base, ok: false, reason: "roots-missing" };

  const found = discoverWorkspacesSync(present, depth);
  const workspaces = found?.workspaces ?? [];
  const markersSeen = found?.markersSeen ?? 0;
  if (workspaces.length === 0) {
    return { ...base, ok: false, reason: markersSeen > 0 ? "markers-rejected" : "no-markers", markersSeen };
  }
  return { ...base, ok: true, reason: "ok", workspaces, markersSeen };
}
