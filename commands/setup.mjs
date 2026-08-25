/**
 * setup.mjs — the `propagate setup` command.
 *
 * FIRST MODULE OF THE COMMANDS LAYER (#31 T5). The split it completes is:
 *
 *   lib/**        subject modules. Take input, return data, print NOTHING.
 *                 Measured: 0 of 58 contain an ANSI escape.
 *   commands/**   command implementations. They exist to produce human output,
 *                 so they print, and they own their own exit codes.
 *   cli.mjs       argument dispatch, and the shared renderers doctor's sections
 *                 hand their collected entries to.
 *
 * WHY THE LAYER EXISTS AT ALL. doctor's four sections could be extracted into
 * `lib/` because their output was already structured — every line went through
 * one of three closures carrying (label, ok, detail), so the modules could
 * return entries and let cli.mjs render them. These commands are not like that:
 * measured across the four, **72 `console.log` calls and 177 ANSI references**
 * emitting free-form prose. Forcing them through a data-returning interface
 * would be a rewrite of what they say, not a move of where they live — and
 * putting them in `lib/` would erode the one property that made the doctor
 * split testable.
 *
 * NOTE ON THE DIRECTORY. `commands/` also holds the plugin's slash-command docs
 * (`propagate-*.md`). Claude Code discovers those by extension, so `.mjs`
 * beside them is inert to the loader; the two are unrelated and deliberately
 * co-located rather than given two near-identical directory names.
 *
 * The pure logic this orchestrates already lives in `lib/core/setup.mjs`
 * (probeRoots, parseRootsArg, renderConfig, verifyDiscovery, migrateLegacyState)
 * and is unchanged — this is the wrapper that reads argv, decides, and prints.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import YAML from "yaml";

import { RESET, DIM, RED, GREEN, YELLOW } from "./ansi.mjs";
import {
  CONFIG_PATH,
  STATE_DIR as CONFIG_ROOT_DIR,
  MAX_DEPTH,
  SCHEDULER,
  SKILL_DIR,
} from "../lib/core/config.mjs";
import {
  parseRootsArg,
  probeRoots,
  renderConfig,
  verifyDiscovery,
  migrateLegacyState,
  PROBE_LAYOUTS,
} from "../lib/core/setup.mjs";

const HOME_DIR = homedir();

/**
 * `setup` — install-time bootstrap. See lib/setup.mjs for the full rationale.
 *
 * The one thing this must never do is report success on an install where
 * discovery finds nothing: that is the exact failure this skill exists to catch,
 * and a bootstrap that says "ready" over it is that failure wearing the uniform
 * of the fix. So the order is deliberate — write, then re-read what was written,
 * then verify, then report. Never report from intent.
 *
 * The config file is still written when verification fails, and the output says
 * so in those words. Rolling it back would leave the operator with nothing to
 * edit; the honest state is "written, and not yet working", which is one line to
 * say and impossible to mistake for success.
 */
export async function setupCmd(argv = []) {
  const flags = argv.filter((a) => a.startsWith("--"));
  const asJson = flags.includes("--json");
  const force = flags.includes("--force");
  const rootsIdx = argv.indexOf("--roots");
  const rootsArg = rootsIdx >= 0 ? argv[rootsIdx + 1] : undefined;
  // `--hub` is the ONE declared fact. searchRoots, marketplaceDir and portsFile
  // all derive from it, so a hub that moves is a one-line change rather than a
  // hunt for four restatements of the same path (which is how portsFile went
  // stale twice on 2026-08-23).
  const hubIdx = argv.indexOf("--hub");
  const hubArg = hubIdx >= 0 ? argv[hubIdx + 1] : undefined;

  const emit = (payload, lines, code) => {
    if (asJson) console.log(JSON.stringify(payload, null, 2));
    else for (const l of lines) console.log(l);
    process.exit(code);
  };

  // --- 1. roots: explicit, else probe, else refuse to guess ------------------
  let roots = parseRootsArg(rootsArg);
  let rootsFrom = "--roots";
  if (roots.length === 0) {
    roots = probeRoots();
    rootsFrom = "probe";
  }
  if (roots.length === 0) {
    emit(
      { ok: false, reason: "no-roots", probed: PROBE_LAYOUTS },
      [
        `${RED}setup failed:${RESET} no code root found, and none given.`,
        `${DIM}probed: ${PROBE_LAYOUTS.join(", ")}${RESET}`,
        ``,
        `Tell it where your repos live:`,
        `  node ${path.join(SKILL_DIR, "cli.mjs")} setup --roots ~/path/to/code`,
      ],
      1,
    );
  }

  // --- 1b. the hub ----------------------------------------------------------
  // Explicit --hub wins. Otherwise, when exactly ONE root was found, that root
  // IS the hub — inferring from two or more would be a guess, and a guessed hub
  // silently mis-derives three other paths.
  let hub = null;
  let hubFrom = null;
  if (hubArg && !hubArg.startsWith("--")) {
    hub = path.resolve(hubArg.replace(/^~(?=$|\/)/, HOME_DIR));
    hubFrom = "--hub";
  } else if (roots.length === 1) {
    hub = roots[0];
    hubFrom = `inferred from the single root (${rootsFrom})`;
  }
  if (hub && !existsSync(hub)) {
    emit(
      { ok: false, reason: "hub-missing", hub },
      [
        `${RED}setup failed:${RESET} hub root does not exist: ${hub}`,
        `${DIM}A declared hub that is not on disk mis-derives searchRoots, marketplaceDir and portsFile at once.${RESET}`,
      ],
      1,
    );
  }
  if (!hub) {
    console.log(`${YELLOW}note:${RESET} ${roots.length} roots found — the hub is ambiguous, so none was recorded.`);
    console.log(`${DIM}Declare it: setup --hub <path>. Without it, hub-derived paths stay unset rather than guessed.${RESET}`);
  }

  // --- 2. write config.yml (never clobber silently) --------------------------
  const existed = existsSync(CONFIG_PATH);
  let wrote = false;
  if (existed && !force) {
    console.log(`${YELLOW}kept:${RESET} ${CONFIG_PATH} already exists — not overwriting.`);
    console.log(`${DIM}re-run with --force to regenerate it from --roots.${RESET}`);
  } else {
    mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    writeFileSync(CONFIG_PATH, renderConfig({ roots, scheduler: SCHEDULER, hub }), "utf8");
    wrote = true;
    console.log(`${existed ? "overwrote" : "wrote"}: ${CONFIG_PATH}`);
  }

  // --- 2b. relocate anything the old default left beside the code -----------
  // The default moved from SKILL_DIR to ~/.propagate on 2026-08-20. GOTCHAS G12 does
  // not forbid that; it requires the move not to lose what was already written.
  const mig = migrateLegacyState(SKILL_DIR, CONFIG_ROOT_DIR);
  if (mig.moved.length) console.log(`moved into ${CONFIG_ROOT_DIR}: ${mig.moved.join(", ")}`);
  for (const c of mig.conflicts) {
    console.log(`${YELLOW}conflict:${RESET} ${c} exists in both places — left as-is, yours to resolve.`);
  }

  // --- 3. verify what is ON DISK, not what is in memory ---------------------
  // These differ exactly when the write is the broken thing, which is the case
  // worth catching. It is also what the NEXT invocation will read: config.mjs
  // evaluated at module load, so the file just written is not in force here.
  let effectiveRoots = roots;
  try {
    const onDisk = YAML.parse(readFileSync(CONFIG_PATH, "utf8"));
    if (Array.isArray(onDisk?.searchRoots) && onDisk.searchRoots.length) {
      effectiveRoots = onDisk.searchRoots.map((r) =>
        typeof r === "string" && r.startsWith("~/") ? path.join(HOME_DIR, r.slice(2)) : r,
      );
    }
  } catch (err) {
    emit(
      { ok: false, reason: "config-unreadable", configPath: CONFIG_PATH, error: String(err?.message ?? err) },
      [`${RED}setup failed:${RESET} wrote ${CONFIG_PATH} but cannot read it back (${err?.message ?? err}).`],
      1,
    );
  }

  const v = verifyDiscovery(effectiveRoots, MAX_DEPTH);
  const payload = {
    ok: v.ok,
    reason: v.reason,
    configPath: CONFIG_PATH,
    configWritten: wrote,
    rootsFrom,
    roots: effectiveRoots,
    rootsPresent: v.present,
    rootsMissing: v.missing,
    workspaces: v.workspaces.length,
    depth: v.depth,
    scheduler: SCHEDULER,
  };

  if (v.ok) {
    emit(
      payload,
      [
        `roots (${rootsFrom}): ${v.present.join(", ")}`,
        `scheduler: ${SCHEDULER}${SCHEDULER === "none" ? `  ${DIM}nothing is scheduled; \`reconcile\` derives drift on demand${RESET}` : ""}`,
        `${GREEN}✓${RESET} discovery finds ${v.workspaces.length} workspace${v.workspaces.length === 1 ? "" : "s"}`,
        ``,
        `Next: node ${path.join(SKILL_DIR, "cli.mjs")} status`,
      ],
      0,
    );
  }

  // --- 4. failure: name the cause and the fix, and never claim success -------
  const fixes = {
    "roots-missing": [
      `${RED}setup incomplete:${RESET} configured root does not exist.`,
      ...v.missing.map((m) => `  ${m} — does not exist`),
      `${DIM}This is a config error. Re-run with a path that exists:${RESET}`,
      `  node ${path.join(SKILL_DIR, "cli.mjs")} setup --force --roots <dir>`,
    ],
    "no-markers": [
      `${RED}setup incomplete:${RESET} no-markers — walked the roots and found no \`.propagates.yml\`.`,
      ...v.present.map((m) => `  ${m} — exists, no markers under it (depth ${v.depth})`),
      `${DIM}This is an onboarding step, not a config error. Declare a first workspace:${RESET}`,
      `  node ${path.join(SKILL_DIR, "cli.mjs")} init <dir> --workspace`,
    ],
    "markers-rejected": [
      `${RED}setup incomplete:${RESET} found ${v.markersSeen} marker file(s), and none produced a workspace.`,
      ...v.present.map((m) => `  ${m}`),
      `${DIM}The markers exist but were rejected — schema, or a missing \`workspace: true\`.${RESET}`,
      `  node ${path.join(SKILL_DIR, "cli.mjs")} doctor`,
    ],
  };
  emit(
    payload,
    [
      ...(fixes[v.reason] ?? [`${RED}setup incomplete:${RESET} ${v.reason}`]),
      ``,
      wrote
        ? `${DIM}${CONFIG_PATH} was written and is not yet working. Fix the above, then re-run.${RESET}`
        : `${DIM}${CONFIG_PATH} was left as it was.${RESET}`,
    ],
    1,
  );
}
