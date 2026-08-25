/**
 * discovery.mjs — doctor's `# Discovery integrity` section.
 *
 * THE LARGEST SECTION (495 lines, 41 reporter calls) and, deliberately, the
 * least topically cohesive: it covers the launchd WatchPaths comparison, ledger
 * integrity, lifecycle/freeze events, v3 layout conformance, canonical-rule
 * restatement, and skill frontmatter.
 *
 * IT IS GROUPED BY ACCUMULATOR OWNERSHIP, NOT BY TOPIC, and that is the property
 * that makes the split safe rather than a matter of taste. Of doctor's 17
 * run-global accumulators exactly two are written here — `ledger.malformed` and
 * `plist.watchpaths` — and nothing else touches them. Splitting further along
 * topic lines is easy from here (each concern is already a self-contained
 * block, and the Reporter shape carries over unchanged); it was not done in
 * this pass because the approved plan called for grouped modules, and a split
 * that changes what is asserted is no longer a refactor.
 *
 * EVERY DYNAMIC IMPORT HERE IS `../../`, NOT `./lib/` — G60. Five specifiers
 * moved with this code, all of them written relative to cli.mjs at the repo
 * root. From here `./lib/x` resolves to lib/report/doctor/lib/x, which does not
 * exist, and the section's own try/catch would report the failure as an
 * informational "probe could not run" line while its entire output vanished and
 * doctor still exited 0. That is not hypothetical: it happened during the
 * previous extraction and cost 224 lines of silent output loss.
 * tests/unit/doctor-module-imports.test.mjs resolves all of them now.
 */

import { existsSync, statSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";

import {
  WORKSPACES,
  SEARCH_ROOTS,
  SUSPICIOUS_MARKERS,
  DISCOVERY_DEGRADED,
  CROSS_LEDGER_JSONL,
  searchRootsExplain,
  shortPath,
} from "../../core/config.mjs";
import { isWorkspaceMarker, liveLedgerCandidates, sweepMarkers } from "../../core/discovery.mjs";
import { parsePlistWatchPaths, expectedWatchPaths, PLIST_PATH } from "../../core/plist.mjs";
import {
  readLedgerWithStats,
  LEDGER_SCHEMA,
  readLedgerByEra,
  findUnownedLedgers,
  classifyUnownedLedger,
  findDuplicateOpenAcrossLedgers,
} from "../../edges/ledger.mjs";

// Same value cli.mjs computes; plain os.homedir(), no override.
const HOME_DIR = homedir();

/**
 * @param {{reporter: import("./reporter.mjs").Reporter}} deps
 * @returns {Promise<{counts: {ledgerMalformed: number, plistWatchpaths: number}}>}
 */
export async function checkDiscovery({ reporter }) {
  const counts = { ledgerMalformed: 0, plistWatchpaths: 0 };

// N7: zero discovered workspaces must fail, not pass. DISCOVERY_DEGRADED
// only trips when markers were seen on disk but none opted into
// `workspace: true` (lib/discovery.mjs: `markersSeen > 0 && found.length
// === 0`). It stays false when SEARCH_ROOTS itself is wrong and zero
// markers are seen at all — e.g. PROPAGATE_SEARCH_ROOTS pointing outside
// the real tree — and in that case the per-workspace loop below simply runs
// zero times, every check in it trivially "passes" by not running, and
// doctor reports healthy. That is precisely the "abandoned automation
// reports itself healthy" failure lib/config.mjs's own comment names.
// Assertion moved to EXPECTATIONS ("workspaces.discovered >= 1",
// lib/metrics.mjs, GOTCHAS G20) — this was an exact duplicate (same bound,
// same fact), so it's informational here and asserted once, in Metrics.
reporter.info(
  "at least one workspace discovered",
  WORKSPACES.length === 0
    ? `${searchRootsExplain()} — every per-workspace check below silently did not run`
    : `${WORKSPACES.length} found`,
);
if (DISCOVERY_DEGRADED) {
  reporter.check(
    "discovery not degraded",
    false,
    "markers found on disk but none opted into workspace: true — discovery is silently swallowing every workspace",
  );
} else {
  reporter.check("discovery not degraded", true);
}

// Partial-loss signal (distinct from total-collapse DISCOVERY_DEGRADED
// above): one marker among several silently dropping out — corrupted YAML,
// `workspace: "true"` typo'd as a string, or a throw while building its
// workspace record — while the rest of discovery still succeeds.
reporter.check(
  "no suspicious workspace markers",
  SUSPICIOUS_MARKERS.length === 0,
  SUSPICIOUS_MARKERS.length
    ? SUSPICIOUS_MARKERS.map((m) => `${m.path}: ${m.reason}`).join("; ")
    : "",
);

// (a) plist WatchPaths vs currently-discovered workspace roots + docs dirs.
// GOTCHAS G20: this is the one EXPECTATIONS-adjacent subject that stays
// inline on purpose, not an oversight. This does exact set-equality
// (missing/extra paths named individually); EXPECTATIONS only ever held a
// count floor (`plist.watchpaths >= workspaces.discovered`, N14's
// zero-collapse regression). The floor is strictly weaker — a wrong-but-
// same-sized set passes it while failing here — so it was removed from
// EXPECTATIONS rather than kept as a second, redundant vote alongside this
// richer check. One fact, one assertion; this one just isn't a duplicate.
try {
  if (existsSync(PLIST_PATH)) {
    const xml = await readFile(PLIST_PATH, "utf8");
    const actual = new Set(parsePlistWatchPaths(xml));
    counts.plistWatchpaths = actual.size;
    const expected = expectedWatchPaths(WORKSPACES);
    const missing = [...expected].filter((p) => !actual.has(p));
    const extra = [...actual].filter((p) => !expected.has(p));
    reporter.check(
      "plist WatchPaths matches discovered workspaces",
      missing.length === 0 && extra.length === 0,
      missing.length || extra.length
        ? `missing: ${missing.join(", ") || "(none)"}; stale: ${extra.join(", ") || "(none)"}`
        : "",
    );
  } else {
    // The watcher was retired 2026-08-14 and its plist deleted on purpose, so
    // "no plist" is the expected state, not a fault. This check stayed armed
    // through the retirement and failed every run afterwards — a red check for
    // a component that no longer exists is exactly how a real red check becomes
    // background noise (G20). Informational, never ✗; per G2 it still says
    // *why* it is absent rather than falling silent.
    reporter.info(
      "plist WatchPaths — n/a",
      `${PLIST_PATH} does not exist; the watcher was retired 2026-08-14 (docs/DECISIONS.md). Its replacement's health is asserted under "v2 replacement" below.`,
    );
  }

  // THE MONITOR'S plist, which is the one that exists. N46: the check above
  // reads the RETIRED watcher's path, so it reported `n/a` forever while the
  // live monitor's plist went stale in BOTH directions — watching 13 `docs/`
  // directories the v3 migration had emptied, and missing the six workspaces
  // declared on 2026-08-24. A check aimed at the wrong file reads as a pass.
  //
  // WatchPaths are retired (lib/core/plist.mjs watchPathsFor), so the correct
  // content is NONE. Any entry is stale by construction, and saying which
  // makes the fix obvious rather than mysterious.
  const { MONITOR_PLIST_PATH } = await import("../../core/plist.mjs");
  if (existsSync(MONITOR_PLIST_PATH)) {
    const mxml = await readFile(MONITOR_PLIST_PATH, "utf8");
    const stale = parsePlistWatchPaths(mxml);
    reporter.check(
      "monitor plist declares no WatchPaths",
      stale.length === 0,
      stale.length
        ? `${stale.length} stale path(s) — WatchPaths were retired 2026-08-24 (N46): launchd never ` +
          `watched them recursively, and \`docs/\` stopped holding state on 2026-08-21. ` +
          `Regenerate the plist to clear them.`
        : "",
    );
  } else {
    reporter.info("monitor plist", `${MONITOR_PLIST_PATH} does not exist — the monitor was never armed here`);
  }
} catch (err) {
  reporter.check("plist WatchPaths matches discovered workspaces", false, err.message);
}

// (b) same absolute source open in more than one ledger (see DECISIONS.md
// "the 69 misfiled hub rows are deferred" — this is that deferral's expiry signal).
try {
  const ledgerEntries = [];
  for (const ws of WORKSPACES) {
    if (!existsSync(ws.ledgerJsonl)) continue;
    const { rows } = await readLedgerWithStats(ws.ledgerJsonl);
    ledgerEntries.push({ workspaceRoot: ws.root, ledgerPath: ws.ledgerJsonl, rows });
  }
  const dup = findDuplicateOpenAcrossLedgers(ledgerEntries);
  reporter.check(
    "no source open in more than one ledger",
    dup.count === 0,
    dup.count
      ? `${dup.count} source path(s) open in >1 ledger, e.g. ${dup.examples
          .map((e) => `${e.path} [${e.ledgers.join(", ")}]`)
          .join("; ")}`
      : "",
  );
} catch (err) {
  reporter.check("no source open in more than one ledger", false, err.message);
}

// (b2) more than one live ledger FILE under one workspace root — the
// phantom-ledger hazard from a half-finished propagation/ migration: a
// `git mv` that moved the .jsonl but not the .md, or that ran before the
// discovery cascade knew about propagation/, leaves a real ledger at one
// path and a fresh empty pair minted at another. Loud, naming both, rather
// than silently reading whichever one discovery happens to pin.
try {
  const multi = [];
  for (const ws of WORKSPACES) {
    const candidates = liveLedgerCandidates(ws.root);
    if (candidates.length > 1) multi.push(`${ws.name}: ${candidates.join(", ")}`);
  }
  reporter.check(
    "at most one live ledger file per workspace",
    multi.length === 0,
    multi.length ? multi.join("; ") : "",
  );
} catch (err) {
  reporter.check("at most one live ledger file per workspace", false, err.message);
}

// (c) malformed JSONL lines per ledger — readLedger silently `continue`s
// past unparseable lines, so the existing "ledger JSONL parseable" check
// above is vacuous; this makes a non-zero count a real problem.
try {
  let totalMalformed = 0;
  const perLedger = [];
  for (const ws of WORKSPACES) {
    if (!existsSync(ws.ledgerJsonl)) continue;
    const { malformed } = await readLedgerWithStats(ws.ledgerJsonl);
    totalMalformed += malformed;
    if (malformed > 0) perLedger.push(`${ws.name}: ${malformed}`);
  }
  counts.ledgerMalformed = totalMalformed;
  reporter.check(
    "no malformed ledger lines",
    totalMalformed === 0,
    totalMalformed ? perLedger.join(", ") : "",
  );
} catch (err) {
  reporter.check("no malformed ledger lines", false, err.message);
}

// (d) `.propagates.yml` markers carrying workspace: true that discovery did
// NOT return — silently dropping a workspace is the exact failure this
// fix exists to prevent. Sweeps deeper (depth 5) than discovery (depth 2).
try {
  const markers = await sweepMarkers(SEARCH_ROOTS, 5);
  const discoveredRoots = new Set(WORKSPACES.map((ws) => ws.root));
  const unreachable = [];
  for (const markerPath of markers) {
    if (!isWorkspaceMarker(markerPath)) continue;
    const dir = path.dirname(markerPath);
    if (!discoveredRoots.has(dir)) unreachable.push(dir);
  }
  reporter.check(
    "no unreachable workspace markers",
    unreachable.length === 0,
    unreachable.length ? unreachable.join(", ") : "",
  );

  // Discovery walks with readdirSync().filter(e => e.isDirectory()), and a Dirent for a
  // SYMLINKED directory answers isSymbolicLink() instead — so the walk never descends
  // into one. Today that costs nothing: the only symlinked dir in a search root is
  // `propagate-skill` -> this repo, which carries no `.propagates.yml` and has never
  // asked to be a workspace. But a symlinked repo that DID declare one would be dropped
  // in silence, and silence is what let 14 commits/day go uncounted for two days.
  // Report what was not descended into; do not fail on it (rule:discernment-checks §2).
  try {
    const skipped = [];
    for (const root of SEARCH_ROOTS) {
      let entries = [];
      try {
        entries = readdirSync(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isSymbolicLink()) continue;
        const full = path.join(root, e.name);
        try {
          if (!statSync(full).isDirectory()) continue;
        } catch {
          continue; // broken link — not a workspace question
        }
        const marker = existsSync(path.join(full, ".propagates.yml"));
        // N29 fixed 2026-08-17: a MARKERED symlink is now descended by both
        // walks (lib/discovery.mjs's listDirs and lib/edges.mjs's
        // findAllSidecarsRecursive). So a marker means "followed", not
        // "ignored" — this line asserted the opposite for as long as the fix
        // took to land, which is the class of defect the fix was about.
        skipped.push(
          `${full.replace(HOME_DIR, "~")}${marker ? "  (declares .propagates.yml — followed, N29)" : " (no marker — nothing lost)"}`,
        );
      }
    }
    if (skipped.length) {
      reporter.info("symlinked dirs seen", skipped.join("; "));
    }
  } catch {
    /* reporting must never break doctor */
  }

  // A ledger can be real, non-empty and owned by nobody — below the discovery
  // depth limit, or beside a sidecar that never set `workspace: true`. Such a
  // ledger contributes 0 to every total while looking exactly like "no drift".
  // Report it as unreachable rather than dropping it (rule:discernment-checks §2).
  // .filter(Boolean): CROSS_LEDGER_JSONL is null when no hub is configured (see
  // the sibling site above). Unfiltered, findUnownedLedgers threw on it.
  const ownedLedgers = [...WORKSPACES.map((w) => w.ledgerJsonl), CROSS_LEDGER_JSONL].filter(Boolean);
  const unowned = await findUnownedLedgers(SEARCH_ROOTS, ownedLedgers);
  const orphans = [];
  const snapshots = [];
  for (const p of unowned) {
    const c = await classifyUnownedLedger(p, ownedLedgers);
    (c.kind === "snapshot" ? snapshots : orphans).push({ p, ...c });
  }
  // A branch-time copy of an owned ledger is not a second source of truth, and
  // its stale `open` rows must not be counted (see classifyUnownedLedger).
  // Still reported — invisible-but-harmless is how the original hole formed.
  for (const s of snapshots) {
    reporter.info(
      "branch-snapshot ledger (not counted)",
      `${s.p} — all ${s.ids} ids present in ${path.basename(path.dirname(path.dirname(s.of)))}'s ledger; ${s.openRows} row(s) still marked open here are stale branch state`,
    );
  }
  reporter.check(
    "no unowned ledger files",
    orphans.length === 0,
    orphans.length
      ? `${orphans.length} ledger file(s) on disk that no workspace owns — their rows are invisible to status/reconcile: ${orphans.map((o) => `${o.p} (${o.openRows} open)`).join("; ")}`
      : "",
  );
} catch (err) {
  // PROPAGATE_DEBUG_STACK exists because this catch reported a null-path
  // TypeError from three frames down under the label "no unreachable workspace
  // markers" — a config fault wearing a marker fault's name. err.message alone
  // cost two wrong guesses at the source; the stack named it immediately.
  reporter.check("no unreachable workspace markers", false, process.env.PROPAGATE_DEBUG_STACK ? err.stack : err.message);
}

// INFORMATIONAL, never a doctor failure — see undiscoverableLedgersReport's
// header comment for why this is a separate mechanism from the hard-failing
// "no unowned ledger files" check above, and rule:discernment-checks §2 for
// why every non-finding case is named rather than left blank.
// ── v3 layout conformance ────────────────────────────────────────────────
//
// THE RATCHET for docs/plans/2026-08-22-v3-one-propagation-standard.md. Every
// later phase of that plan claims to bring a workspace to the standard; this
// is the only thing that can contradict the claim.
//
// Measured the day it was written: 1 of 7 conforming. That number is the
// point — a conformance check green before the conforming work has happened
// is not checking anything (rule:discernment-checks §1), so it was run
// against the live tree BEFORE any workspace was migrated and seen to fail on
// six of them.
//
// ONE label, not one per workspace: doctor-check-coverage.test.mjs parses
// literal reporter.check("...") strings out of this file, so a label templated with a
// workspace name would be invisible to that ratchet on every machine.
// The DETAIL carries the per-workspace attribution instead.
try {
  const { conformanceReport } = await import("../../core/v3-layout.mjs");
  const rep = conformanceReport(WORKSPACES);
  // FAILS only for STARTED-but-incomplete. A workspace nobody has begun
  // migrating is informational — see hasStartedV3 for why, and
  // tests/cli/stranger-install.test.mjs for the run that caught the
  // alternative within a minute of it being written.
  // LIFECYCLE ERA CENSUS. Reads every workspace's refs/lifecycle.jsonl and
  // says which schema era its lines belong to. Wired here on the day
  // readLifecycle was written, because a reader nobody calls is
  // indistinguishable from one that was never built — the F3 defect this same
  // session already paid for once (rule:enforcement-watches-itself §2).
  //
  // The FAILING condition is `refused`, not the presence of v1 lines. v1 is
  // frozen history and legitimately sits there forever; a line declaring
  // neither era is a shape nobody can account for.
  try {
    const { readLifecycle } = await import("../../refs/snapshot.mjs");
    let cur = 0, v1 = 0, refused = [], scanned = 0;
    for (const ws of WORKSPACES) {
      const r = readLifecycle(ws.root);
      if (r.reason === "absent") continue; // never registered — not a defect
      scanned++;
      cur += r.current.length;
      v1 += r.v1.length;
      for (const x of r.refused) refused.push(`${shortPath(r.file)}: ${x.reason}`);
    }
    if (scanned === 0) {
      reporter.info("lifecycle events", "no workspace has a refs/lifecycle.jsonl yet — not scanned, not zero");
    } else {
      reporter.check(
        "lifecycle lines are all accountable",
        refused.length === 0,
        refused.length ? `${refused.length} line(s) declare no schema: ${refused.slice(0, 3).join("; ")}` : "",
      );
      reporter.info("lifecycle events", `${cur} current (schema 2) · ${v1} frozen v1 · across ${scanned} workspace(s)`);
    }
  } catch (err) {
    // Absence must be attributable: a failed census is UNKNOWN, not clean.
    reporter.info("lifecycle events", `not scanned — ${err.message}`);
  }

  // LEDGER ERA CENSUS — the same shape, for the other append-only store.
  // The FAILING condition is `refused`, not the presence of v1: v1 is frozen
  // history and legitimately sits in archive/ forever. A line in the LIVE
  // ledger declaring no schema is a writer that bypassed appendRow, or a
  // workspace whose freeze has not run — either way a shape nobody can
  // account for, and calling it "history" would hide it.
  try {
    let cur = 0, v1 = 0, bypassed = 0, pending = 0, scanned = 0;
    const offenders = [];
    for (const ws of WORKSPACES) {
      const r = await readLedgerByEra(ws.ledgerJsonl);
      if (r.reason === "absent" || r.reason === "unconfigured") continue;
      scanned++;
      cur += r.current.length;
      v1 += r.v1.length;
      if (!r.refused.length) continue;
      // WHICH FAILURE THIS IS depends on whether the freeze has run here, and
      // conflating the two would assert something unknowable. A ledger with no
      // archive/ has not been frozen yet, so its unstamped lines are v1
      // history awaiting Phase D — a named pending state, not a defect. Once
      // an archive EXISTS, every v1 line is in it, so an unstamped line in the
      // live ledger has exactly one meaning: a writer that bypassed appendRow.
      if (r.archives.length > 0) {
        bypassed += r.refused.length;
        offenders.push(`${shortPath(ws.ledgerJsonl)}: ${r.refused.length}`);
      } else {
        pending += r.refused.length;
      }
    }
    if (scanned === 0) {
      reporter.info("ledger events", "no workspace has a ledger.jsonl yet — not scanned, not zero");
    } else {
      reporter.check(
        "no ledger line bypassed appendRow",
        bypassed === 0,
        bypassed
          ? `${bypassed} unstamped line(s) in a FROZEN ledger (${offenders.slice(0, 3).join("; ")}) — written by something that skipped appendRow`
          : "",
        `${scanned} ledger(s) scanned`,
      );
      reporter.info("ledger events", `${cur} current (schema ${LEDGER_SCHEMA}) · ${v1} frozen v1 · across ${scanned} workspace(s)`);
      if (pending > 0) {
        reporter.info("ledger freeze", `${pending} line(s) not yet frozen — run \`freeze-ledger --workspace <ws> --apply\``);
      }
    }
  } catch (err) {
    reporter.info("ledger events", `not scanned — ${err.message}`);
  }

  reporter.check(
    "workspaces conform to the v3 propagation layout",
    rep.offenders.length === 0,
    rep.offenders.length
      ? `${rep.offenders.length} half-migrated — ` +
        rep.offenders.map((o) => `${o.name} lacks ${o.missing.join(", ")}`).join("; ") +
        `. A partial migration is the state that loses data. See docs/REFERENCE.md ` +
        `§"Propagation layout".`
      : `${rep.conforming}/${rep.total} conform`,
  );
  // Three states, not two: conforming / half-migrated / not begun. Collapsing
  // the third into either of the others is what makes a migration report
  // itself complete halfway through (rule:discernment-checks §2).
  if (rep.notStarted.length > 0) {
    reporter.info(
      "v3 migration",
      `${rep.conforming}/${rep.total} conform; ${rep.notStarted.length} not begun — ` +
        rep.notStarted.map((o) => o.name).join(", "),
    );
  }
} catch (err) {
  // Named, never swallowed: a conformance check that cannot run must not read
  // as a conformance check that passed.
  reporter.check("workspaces conform to the v3 propagation layout", false, `could not evaluate: ${err.message}`);
}

// ── canonical rules ──────────────────────────────────────────────────────
//
// `rules check` worked for weeks while sitting in NO gate -- not here, not
// CI, not the release gates. A drift detector computed only on request is
// indistinguishable from one that does not exist
// (rule:enforcement-watches-itself #5). It now has TWO callers: the
// SessionStart hook detects silently and automatically; this reports on
// demand. Same division as gotchas -- the guard pushes, a census reports.
//
// GATED ON THE RULES LAYER BEING INSTALLED, like the v3 and monitor checks:
// ~/.claude/rules present is the "armed" signal. A machine that never
// installed it must reach doctor-clean.
try {
  const rulesDir = path.join(HOME_DIR, ".claude", "rules");
  if (!existsSync(rulesDir)) {
    reporter.info("canonical rules", `not installed — no ${rulesDir.replace(HOME_DIR, "~")}`);
  } else {
    const { checkRules } = await import("../../rules/rules-check.mjs");
    const r = checkRules({ rulesDir, roots: SEARCH_ROOTS });
    // THREE outcomes, not two — the third time this session that collapsing
    // "not applicable" into "broken" produced a wrong failure (Phase A's
    // conformance check and the monitor probe were the other two).
    //
    //   no-files-scanned : the roots hold no CLAUDE.md. Nothing to check is
    //                      not a failure -- every scoped test fixture and
    //                      every fresh install looks like this.
    //   roots-missing    : a CONFIGURED root has vanished, so the scan was
    //                      incomplete. That is a real problem and a
    //                      different fact from having nothing to scan.
    if (r.diagnostic === "no-files-scanned") {
      reporter.info("canonical rules", `nothing to check — no CLAUDE.md under ${SEARCH_ROOTS.length} search root(s)`);
    } else if (r.diagnostic && r.diagnostic !== "ok") {
      reporter.check(
        "canonical rules are not restated",
        false,
        `check could not run: ${r.diagnostic}` +
          (r.missing?.length ? ` (missing roots: ${r.missing.join(", ")})` : "") +
          ` — the scan was incomplete, which is NOT the same as finding nothing`,
      );
    } else {
      reporter.check(
        "canonical rules are not restated",
        r.findings.length === 0,
        r.findings.length
          ? `${r.findings.length} restatement(s) across ${r.filesScanned} file(s): ` +
            r.findings
              .slice(0, 5)
              .map((f) => `${f.file}${f.lines?.length ? `:${f.lines[0]}` : ""} (rule:${f.rule})`)
              .join("; ") +
            (r.findings.length > 5 ? ` (+${r.findings.length - 5} more)` : "")
          : `${r.rules.length} rule(s), ${r.filesScanned} file(s) scanned, ${r.overrides.length} declared deviation(s)`,
      );
    }
  }
} catch (err) {
  reporter.check("canonical rules are not restated", false, `could not evaluate: ${err.message}`);
}

// ── skill frontmatter (INFORMATIONAL, deliberately) ──────────────────────
//
// scanSkills() already computes both predicates -- `frontmatter` and
// `descriptionStatesWhen` are two of its eight completeness fields. Nothing
// surfaced them, which is why three skills once sat unused across 3,755
// sessions purely for want of a `description:`.
//
// NOT a reporter.check(), and the measurement is why. Of 45 installed skills, 35
// have a description that is not WHEN-phrased and 2 have no frontmatter at
// all -- and BOTH of the latter are symlinks into ~/.agents/skills, i.e.
// third-party. Failing doctor for a description someone else wrote is a
// check the operator cannot act on, which is how a gate becomes noise.
// The two counts are reported separately because they are different facts:
// no description means the skill cannot autotrigger AT ALL; a non-WHEN
// description merely matches requests less well.
try {
  const { scanSkills } = await import("../../skills/skills-scan.mjs");
  const scan = await scanSkills({ withTests: false });
  const list = scan.skills ?? scan;
  const noFm = list.filter((sk) => sk?.completeness?.frontmatter === false).map((sk) => sk.id);
  const notWhen = list.filter((sk) => sk?.completeness?.descriptionStatesWhen === false).length;
  reporter.info(
    "skill frontmatter",
    `${list.length} scanned; ${noFm.length} with no name+description (cannot autotrigger)` +
      (noFm.length ? `: ${noFm.join(", ")}` : "") +
      `; ${notWhen} whose description is not WHEN-phrased`,
  );
} catch (err) {
  reporter.info("skill frontmatter", `not evaluated: ${err.message}`);
}


  return { counts };
}
