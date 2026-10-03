/**
 * workspaces.mjs — doctor's per-workspace section (`# Workspace: <name>`).
 *
 * ONE WORKSPACE PER CALL; the caller drives the loop. doctor prints a header
 * per iteration, and no module under lib/ prints — so the caller emits the
 * header and this returns everything under it.
 *
 * WHY `sidecars` IS A PARAMETER. A nested workspace (SSJK-mb under
 * PanditPawanKaushik under the hub) is found by every ancestor's walk, so one
 * sidecar appears in several workspaces' results.
 * `assignSidecarsToWorkspaces` collapses that to one validation per unique
 * sidecar, owned by its nearest (deepest) workspace — a decision across ALL
 * workspaces, which cannot be made from inside one of them. docs/ISSUES.md A2.
 *
 * COUNTS ARE PER-WORKSPACE AND THE CALLER SUMS THEM. In doctor these were `+=`
 * against run-global locals. Returning them is what makes a dropped
 * accumulator a missing property you can assert on, rather than a silent zero
 * in `# Metrics` (D4).
 *
 * WHAT IS DELIBERATELY NOT A FAILURE, each a judgement already made — do not
 * "tighten" these without reading the reason beside them in the code:
 *   - unknown ledger row types, rejected sidecars -> asserted once in
 *     EXPECTATIONS (G20), so one bad row prints one ✗ rather than one per
 *     workspace it happens to appear in
 *   - a missing `kind: code` downstream -> declare-ahead, warn only
 *   - every branch-registry finding -> a human's call about a branch; making
 *     them red would keep doctor permanently red on a healthy workspace, which
 *     trains people to ignore it
 *   - a snapshot that does not PARSE -> the one real failure in that block,
 *     because propagate wrote the file, so it is propagate's defect
 */

/**
 * Severity of what this section reports (N87 slice 2b).
 *
 * A rejected sidecar makes its edges INERT — declared, invisible, and
 * reporting nothing. N9: one bad path turned 40 edges across 10 sources
 * inert for ~2 hours with no signal (GOTCHAS G9). Silence is the symptom,
 * which is the S1 test.
 *
 *
 * Declared per SECTION, not per call site: doctor has 60 `reporter.check`
 * sites and 8 sections, and sixty judgements is a project nobody finishes. A
 * section whose checks genuinely span two severities should SPLIT — that is
 * normally a section doing two jobs.
 */
export const SEVERITY = "S1";

import { existsSync, globSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { loadSidecar, SidecarError } from "../../edges/frontmatter.mjs";
import { readLedgerWithStats } from "../../edges/ledger.mjs";
import { classifyDownstreamPath } from "../../edges/edges.mjs";
import { isGlobPattern, expandDownstream } from "../../edges/reconcile.mjs";

/**
 * @param {{
 *   ws: {name: string, root: string, ledgerJsonl: string, ledgerMd: string},
 *   sidecars: string[],
 *   reporter: import("./reporter.mjs").Reporter,
 * }} deps
 * @returns {Promise<{counts: object, details: object}>}
 */
/**
 * ISSUES N55. Two thresholds, because "has not run today" and "has stopped"
 * are different facts and only the second is worth a warning.
 *
 * The refresh rides the 09:00 digest, so anything under a couple of days is an
 * ordinary gap — a laptop that was closed. Past a week the schedule itself is
 * not running, which is the condition N55 is about: the registries sat 32 days
 * untouched and nothing said so.
 */
export const REFS_STALE_DAYS = 2;
export const REFS_STOPPED_DAYS = 7;

/** Whole days since `capturedAt`, or null when it cannot be read. Never guesses. */
export function registryAgeDays(capturedAt, now = Date.now()) {
  if (typeof capturedAt !== "string" || !capturedAt) return null;
  const t = Date.parse(capturedAt);
  if (!Number.isFinite(t)) return null;
  return Math.floor((now - t) / 86_400_000);
}

export async function checkWorkspace({ ws, sidecars, reporter }) {
  const counts = {
    rowsOpen: 0,
    ledgerUnknownTypes: 0,
    sidecarsLoaded: 0,
    sidecarsRejected: 0,
    sidecarsProblems: 0,
  };
  const details = { ledgerUnknownTypes: [], sidecarsRejected: [] };

  // A workspace that HOLDS state must be able to keep it. The v3 layout moved
  // STATE/DECISIONS/GOTCHAS out of each project and into the workspace, which
  // `rule:state-and-decisions` records as a deliberate trade: "a fresh clone of
  // a project repo gets a pointer stub". What it did not anticipate is a
  // workspace repo with NO REMOTE — there the trade stops being about
  // discoverability and becomes about durability.
  //
  // Measured 2026-08-26, before this check existed: 6 of 12 workspaces holding
  // propagation state had no remote, carrying 9 state files that existed on one
  // disk only. `Anushka/thesis-frontend` HAS a remote and its register had been
  // moved into `Anushka/`, which did not — so the migration moved that file
  // from backed storage into unbacked storage, silently.
  //
  // ANY remote counts, not `origin`: the first version of this measurement used
  // `git remote get-url origin` and would have reported a repo with a
  // differently-named remote as unbacked. Narrower instrument than the claim.
  if (existsSync(path.join(ws.root, "propagation", "state"))) {
    let remotes = null; // null = could not look, which is NOT the same as none
    try {
      remotes = execFileSync("git", ["-C", ws.root, "remote"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
        .split("\n")
        .filter((l) => l.trim());
    } catch {
      remotes = null;
    }
    if (remotes === null) {
      reporter.info("state durability", "not a git repo, or git could not run — state durability unknown here");
    } else {
      const stateFiles = globSync(path.join(ws.root, "propagation", "state", "**", "*.md")).length;
      // Only fires when there IS state to lose. The first version keyed on the
      // DIRECTORY existing, and flagged `Khushboo` and `Rishabh` — doc-only
      // husks carrying an empty `propagation/state/` — as durability risks with
      // nothing in them to risk. An empty holder is not an exposure, and a check
      // that cries wolf on two of three hits gets ignored, which costs the third.
      if (stateFiles > 0) reporter.check(
        "workspace holding state has a remote",
        remotes.length > 0,
        remotes.length > 0
          ? `${remotes.length} remote(s), ${stateFiles} state file(s)`
          : `NO REMOTE and ${stateFiles} state file(s) — this workspace's state exists on one disk only`,
      );
    }
  }

  reporter.check("ledger JSONL exists", existsSync(ws.ledgerJsonl));
  if (existsSync(ws.ledgerJsonl)) {
    try {
      const { rows, unknownTypes } = await readLedgerWithStats(ws.ledgerJsonl);
      const openCount = rows.filter((r) => r.status === "open").length;
      counts.rowsOpen += openCount;
      // RETIRED AS A CHECK 2026-09-24 (PR-009), now an `info`. It asserted `true`
      // unconditionally, so it reported success for a file that is created EMPTY
      // and never written to again: `ensureLedgerPair` does
      // `writeFileSync(ledgerJsonl, "")` and NOTHING in this repo appends a row to
      // any ledger file. Every in-tree ledger holds 0 rows (N84) because the real
      // events live in PROPAGATE_STATE_DIR, outside every git remote.
      //
      // So an empty in-tree ledger is not a defect — it is the only state the code
      // can produce, and making it fail or go inconclusive would have reddened
      // doctor permanently over a CORRECT condition. That is the inverse of the
      // G68 fix, not an instance of it.
      //
      // It was also already redundant: discovery.mjs's malformed-JSONL counter was
      // added precisely because "readLedger silently continues past unparseable
      // lines, so the existing `ledger JSONL parseable` check above is vacuous".
      // Two readers had reached that conclusion before this one.
      //
      // The COUNT is still worth printing — it is how a reader learns the in-tree
      // ledger is empty and where the events actually are.
      reporter.info(
        "ledger JSONL rows",
        rows.length === 0
          ? "0 rows — in-tree ledgers are v1 scaffolding; live events are in PROPAGATE_STATE_DIR (N84)"
          : `${rows.length} rows, ${openCount} open`,
      );

      // N1: readLedgerWithStats already counts row types the fold doesn't
      // know how to handle (e.g. hand-authored "manual" rows); readLedger
      // and every one of its callers throw that count away. This used to be
      // a per-workspace FAILURE naming the ledger and offending type
      // strings; the assertion now lives solely in EXPECTATIONS
      // ("ledger.unknown_types == 0", lib/metrics.mjs, GOTCHAS G20) so one
      // bad row prints one ✗, not one per workspace it happens to live in.
      // The path/type/count detail the old check named is preserved here
      // and handed to that single aggregate assertion via context.
      const unknownEntries = Object.entries(unknownTypes);
      const unknownCount = unknownEntries.reduce((sum, [, n]) => sum + n, 0);
      counts.ledgerUnknownTypes += unknownCount;
      if (unknownCount > 0) {
        details.ledgerUnknownTypes.push(
          `${ws.ledgerJsonl}: ${unknownEntries
            .map(([t, n]) => `"${t}"×${n}`)
            .join(", ")} — unknown to readLedger, silently dropped by the fold (docs/DATA_MODEL.md)`,
        );
      }
      reporter.info(
        "no row types unknown to the reader",
        unknownCount ? `${unknownCount} unknown — asserted in Metrics section` : "",
      );
    } catch (err) {
      reporter.check("ledger JSONL parseable", false, err.message);
    }
  }
  reporter.check("ledger MD exists", existsSync(ws.ledgerMd));

  // Sidecars: assigned to THIS workspace as nearest owner. Passed in, not
  // computed here — the assignment is a decision across ALL workspaces.
  reporter.note(`found ${sidecars.length} sidecar${sidecars.length === 1 ? "" : "s"}`);
  // PATH VALIDATION, both sides: a declared SOURCE and every downstream it names
  // must resolve on disk. MEASURED 2026-09-30, because this comment was wrong:
  // a missing downstream is a WARN for BOTH kinds — prose and declare-ahead code —
  // differing only in wording, and `pathWarns++` is the only counter either touches.
  // (It read "prose missing → problem (fail)" and had since before 2026-09-30; the
  // only downstream FAILURE is the directory-as-downstream case, `pathProblems`.)
  // A glob needs ≥1 match. A SOURCE is always a failure, never declare-ahead.
  //
  // IS THIS PATH A GLOB, OR A LITERAL THAT MERELY LOOKS LIKE ONE?
  //
  // Added 2026-09-30 after the new SOURCE check (below) reported
  // `Manav-portfolio: src/app/work/[slug]/page.tsx` as "glob matched 0 files"
  // for a file that is on disk. `[slug]` is a Next.js App Router dynamic
  // segment — a literal directory name — and `globSync` reads `[slug]` as a
  // character class, so it looks for `work/s/page.tsx` and finds nothing:
  //
  //   existsSync("src/app/work/[slug]/page.tsx")  -> true
  //   globSync(same)                              -> []
  //
  // The DOWNSTREAM check below had this same bug from the start and it was
  // never noticed, because no declared downstream happened to be a bracket
  // path. Defining the predicate ONCE is the point: two copies of this test
  // are two chances to disagree, which is what this file's own history with
  // source-versus-downstream asymmetry already cost (N8).
  //
  // Literal-first is the correct order. A path that exists is not a pattern,
  // whatever characters it contains.
  // AT FUNCTION SCOPE DELIBERATELY. The source check and the downstream check sit in
  // two separate `for (const sc of sidecars)` loops, so a predicate declared inside
  // either is a ReferenceError in the other — which is exactly what the first version
  // of this merge shipped: doctor died with `isGlob is not defined` on every
  // workspace, and `node --check` passed, because scope is not syntax.
  const isGlob = (rel, dir) => isGlobPattern(rel) && !existsSync(path.join(dir, rel));

  // N11 — DID THIS PATH EXIST, OR HAS IT NEVER BEEN WRITTEN?
  //
  // A missing downstream warns for both kinds, so a MOVE reads exactly like a
  // declare-ahead. N11 was hit twice in one day: `design/` → `docs/design/`, then the
  // `docs/` reorg. It prescribed a last-seen set in `state.json` — but that file is
  // RETIRED (`lib/core/setup.mjs`'s `retired:` array), and `doctor-snapshot.json`
  // records PROBLEMS rather than the declared set, so a path that was healthy at the
  // last run leaves no trace of itself to compare against. Both prescribed homes are
  // dead ends, which is why this sat open.
  //
  // git already remembers, so nothing here needs to. A deletion commit for the path
  // means it existed; NONE means it never did, and that negative control is what makes
  // this a discriminator rather than a guess. `rule:delegation-criteria` §2 — derive
  // on demand, never remember in background; the 4,420-run watcher this tree deleted
  // is the lesson, because a lost baseline does not lose drift, it INVENTS it.
  //
  // BOUNDED, because N16 is in this same register: an unbounded `execSync` in doctor
  // once cost 94% of the run and could hang it indefinitely. This has a 2s timeout and
  // is reached only once a path is already missing — measured 2026-09-30, that is
  // 0 of 589 declared downstream paths on the real tree.
  //
  // An unanswerable git — no repo, no binary, timeout — returns null and the verdict
  // stays the warn it is today. Absence of confirmation must never read as
  // confirmation (`rule:discernment-checks` §2).
  const deletedAt = (dir, rel) => {
    try {
      const out = execFileSync(
        "git",
        ["-C", dir, "log", "-1", "--format=%h %ad", "--date=short", "--diff-filter=D", "--", path.resolve(dir, rel)],
        { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
      return out || null;
    } catch {
      return null;
    }
  };

  for (const sc of sidecars) {
    const rel = path.relative(ws.root, sc);
    try {
      const loaded = await loadSidecar(sc);
      counts.sidecarsLoaded++;
      reporter.check(`  ${rel}`, true);
      // Per-entry problems (N9 fix): a bad downstream entry is pruned
      // rather than failing the whole sidecar, but must stay a loud
      // doctor FAILURE naming the sidecar, source key, and path — pruning
      // must not trade one silent failure for another.
      // N18 — SOURCE KEYS, not just downstream paths.
      //
      // A downstream may legitimately not exist yet: that is declare-ahead, and doctor
      // tolerates it on purpose. A SOURCE cannot. The edge fires when the source changes,
      // so a source key naming a renamed or deleted file is an edge that is already dead —
      // nothing to watch, nothing ever detected, and the sidecar still reads as a declared
      // coupling.
      //
      // Measured before this existed: a fixture declaring `does-not-exist.md` produced no
      // mention of it anywhere in doctor's output. The only line containing "source" was
      // `✓ no source open in more than one ledger` — worse than silence, because it reads
      // like a source check passing.
      // N6 — a glob `kind: code` downstream cannot be enforced, and must not read as if it
      // were. lib/edges/edges.mjs logs-and-skips these, and `check` passes a noop logger, so
      // the deferral reached nobody: the edge got ZERO coverage in both the watcher and the
      // gate while looking exactly like a working one. Self-documented in five places as "a
      // documented limitation, not a bug" — but a limitation nothing surfaces is
      // indistinguishable from a defect.
      //
      // Informational, not a failure: the declaration is legitimate and the operator may
      // want it. What was missing is knowing it does not fire. Only kind:code — glob PROSE
      // downstreams expand normally.
      for (const [srcKey, entry] of Object.entries(loaded.sources || {})) {
        for (const d of entry?.propagates_to || []) {
          // O9 — `exclude:` is an EXEMPTION, and an exemption that cannot fire is a check
          // that cannot fail. Two FAILURES: `exclude:` on a literal path (nothing to
          // subtract from, so it reads as a working opt-out and does nothing), and an
          // entry that matches none of the glob's matches (a stale exemption, e.g. the
          // stub it named was replaced by a real file or deleted).
          if (Array.isArray(d?.exclude) && d.exclude.length > 0) {
            if (!isGlobPattern(d.path)) {
              reporter.check(
                `  ${rel}: ${srcKey} → ${d.path}`,
                false,
                "`exclude:` on a literal path — it only applies to a glob `path`, so this exemption does nothing (O9)",
              );
            } else {
              const { staleExcludes } = expandDownstream(d.path, path.dirname(sc), d.exclude);
              for (const ex of staleExcludes) {
                reporter.check(
                  `  ${rel}: ${srcKey} → ${d.path}`,
                  false,
                  `stale \`exclude:\` entry ${JSON.stringify(ex)} — it matches none of the glob's matches, so it exempts nothing (O9); remove it`,
                );
              }
            }
          }
          if (d?.kind === "code" && isGlobPattern(d.path)) {
            reporter.info(
              `  ${rel}: ${srcKey} → ${d.path}`,
              "unenforced — glob kind:code downstreams are deferred, so this edge never fires (N6)",
            );
          }
        }
      }
      // THE SOURCE SIDE. A source that is not on disk means every edge under it is
      // dead, and unlike a downstream there is no declare-ahead reading of it.
      //
      // MADE GLOB-AWARE 2026-09-30, against a LATENT flaw: the original used a bare
      // `existsSync`, so a true glob source such as `notes/*.md` matching two real
      // files would read as `does not exist`. Measured on a fixture, and it had never
      // fired — derived the same day, 49 sidecars / 294 literal source keys / **0**
      // glob source keys. The one key with a metacharacter is Manav-portfolio's
      // `src/app/work/[slug]/page.tsx`, a literal that `existsSync` resolves fine.
      //
      // A SECOND, WARN-LEVEL COPY OF THIS CHECK WAS ADDED EARLIER THE SAME DAY AND HAS
      // BEEN REMOVED. It came from grepping for the label `source paths resolve`,
      // finding nothing, and concluding no check existed — measuring a label as a proxy
      // for a behaviour (rule:measure-the-claim-not-a-proxy). The result was one missing
      // source reported twice, which is G20's double-print. Its glob handling was the
      // one real contribution and is merged here.
      for (const [srcKey, srcEntry] of Object.entries(loaded.sources || {})) {
        const scDir = path.dirname(sc);
        let missing = false;
        let why = "does not exist — this edge can never fire (a source is not declare-ahead eligible)";
        if (isGlob(srcKey, scDir)) {
          let n = 0;
          try {
            n = globSync(srcKey, { cwd: scDir }).filter((m) => !m.includes("node_modules/")).length;
          } catch {
            /* an unparseable pattern is reported by the count being 0 */
          }
          missing = n === 0;
          // A pattern that matched nothing and a file that is gone are different facts
          // and lead to different fixes — widen the pattern, versus restore the path.
          why = "matched no files — this edge can never fire (widen the pattern, or the source is gone)";
        } else {
          missing = !existsSync(path.resolve(scDir, srcKey));
        }
        if (missing) {
          const n = (srcEntry?.propagates_to || []).length;
          reporter.check(
            `  ${rel}: source "${srcKey}"`,
            false,
            `${why} — declares ${n} downstream(s), see rule:refactor-updates-sidecar-same-commit`,
          );
        }
      }
      counts.sidecarsProblems += (loaded.problems || []).length;
      for (const p of loaded.problems || []) {
        reporter.check(
          `  ${rel}: source "${p.sourceKey}" propagates_to[${p.index}]${p.path ? ` (${p.path})` : ""}`,
          false,
          `pruned — ${p.message}`,
        );
      }
    } catch (err) {
      counts.sidecarsRejected++;
      const msg = err instanceof SidecarError ? err.message.split("] ").pop() : err.message;
      // Assertion moved to EXPECTATIONS ("sidecars.rejected == 0",
      // lib/metrics.mjs, GOTCHAS G20) so one bad sidecar doesn't print two
      // ✗ lines (one here, one in Metrics). Detail preserved for that
      // aggregate check via details.sidecarsRejected.
      details.sidecarsRejected.push(`${ws.name}/${rel}: ${msg}`);
      reporter.info(`  ${rel}`, `rejected — ${msg}`);
    }
  }

  let pathProblems = 0;
  let pathWarns = 0;
  for (const sc of sidecars) {
    const scDir = path.dirname(sc);
    let sidecar;
    try {
      sidecar = await loadSidecar(sc);
    } catch {
      continue;
    }
    const rel = path.relative(ws.root, sc);
    for (const [src, body] of Object.entries(sidecar.sources || {})) {
      for (const d of body.propagates_to || []) {
        const kind = d.kind || "prose";
        if (isGlob(d.path, scDir)) {
          let n = 0;
          try {
            n = globSync(d.path, { cwd: scDir }).filter((m) => !m.includes("node_modules/")).length;
          } catch {
            /* ignore */
          }
          if (n === 0) {
            // The detail WAS the kind and the label WAS the row — swapped, slice 3.
          reporter.warn("glob matched 0 files", `${rel}: ${src} → ${d.path}`);
            pathWarns++;
          }
        } else {
          // SPEC §3c bug B: stat the target so a directory-shaped downstream
          // (EISDIR at read time) is distinguished from one that's simply
          // absent. Different problems, different messages, different severities.
          const classification = await classifyDownstreamPath(scDir, d.path);
          if (classification === "is-directory") {
            // Always a FAILURE, never intentional — unlike a missing file,
            // there is no "declare-ahead" reading of "this is a directory".
            reporter.check(
              `${rel}: ${src} → ${d.path}`,
              false,
              "downstream is a directory, not a file — a downstream must be a file or a glob, never a bare directory (reads as EISDIR)",
            );
            pathProblems++;
          } else if (classification === "missing") {
            // THE WARN-ONLY RATIONALE BELOW IS PRESERVED, AND NARROWED TO THE CASE IT
            // WAS WRITTEN ABOUT. It reads: doctor is a cross-workspace health report,
            // so a stale edge in one workspace must not red the aggregate exit code,
            // and `kind: code` missing is declare-ahead rather than a bug. That is
            // right about a path nobody has written yet. It is wrong about a path that
            // USED TO RESOLVE — N11 (S1) says so directly: "existed at last run, now
            // missing is a break, not a warning". The source side already fails on the
            // same fact, so failing here makes doctor consistent about a dead edge
            // rather than newly strict.
            const gone = deletedAt(scDir, d.path);
            if (gone) {
              reporter.check(
                `${rel}: ${src} → ${d.path}`,
                false,
                `downstream EXISTED and is gone — deleted or moved at ${gone}. A declared path that once resolved is a break, not declare-ahead; the sidecar had to move with it (N11, rule:refactor-updates-sidecar-same-commit)`,
              );
              pathProblems++;
            } else {
              // Never in history, or git could not say — either way this is the
              // declare-ahead reading, and it keeps v1's prose/code wording.
              // Two stable kinds from the ternary; the path is the instance. Slice 3.
              reporter.warn(
                kind === "code" ? "declare-ahead code, not on disk" : "prose downstream missing",
                `${rel}: ${src} → ${d.path}`,
              );
              pathWarns++;
            }
          }
        }
      }
    }
  }
  if (pathProblems === 0) {
    // No per-entry failures fired above — this aggregate is the only signal,
    // so it still counts as a real check (today's behaviour, unchanged).
    reporter.check("sidecar downstream paths resolve", true, pathWarns ? `${pathWarns} warn` : "");
  } else {
    // Per-entry `reporter.check()` calls above already reported and counted each
    // directory-as-downstream failure individually. Restating the same
    // defect here as a second `✗` would count it twice for one underlying
    // bug (docs/ISSUES.md A2's "5th problem" note, now fixed) — so this is
    // a summary, informational only, not a vote.
    reporter.info(
      "sidecar downstream paths resolve",
      `${pathProblems} directory-as-downstream failure${pathProblems === 1 ? "" : "s"} (see above)${pathWarns ? `, ${pathWarns} warn` : ""}`,
    );
  }

  // BRANCH REGISTRY — live ref health.
  //
  // Ported from `hygiene/branch-registry.sh`, which computed these on every
  // commit in Vipin Kaushik while its only caller filtered to RED and so
  // printed NOTHING. Eleven correct, live findings that nobody had ever seen.
  // They are surfaced here because that hook is being removed, and removing a
  // detector without moving what it detected is how a capability disappears
  // without anyone noticing (rule:enforcement-watches-itself).
  //
  // INFORMATIONAL, never a doctor failure. Every one of these describes a
  // branch a human must decide about — "prunable", "do not prune yet",
  // "exists only on this machine". None is a defect in propagate, and making
  // them red would make `doctor` permanently red on a healthy workspace,
  // which trains people to ignore it.
  try {
    const snapPath = path.join(ws.root, "propagation", "refs", "snapshot.json");
    if (!existsSync(snapPath)) {
      // Attributable absence. Silence here would be indistinguishable from a
      // workspace whose refs are all healthy — the exact confusion that made
      // `bootstrap` print `0 · 0 · 0` next to `✗ no workspaces`.
      reporter.info("ref registry", "no snapshot — run `propagate migrate-refs <workspace> --apply`");
    } else {
      const { refFindings } = await import("../../refs/findings.mjs");
      let snap;
      try {
        snap = JSON.parse(await readFile(snapPath, "utf8"));
      } catch (err) {
        // THIS is the failing case, and it is a real one: propagate wrote
        // this file, so it being unreadable is propagate's defect, not a
        // branch a human must decide about. Everything else in this section
        // is informational precisely because it is somebody's judgement call;
        // this is not.
        //
        // Routing it to `info` alongside the rest would leave the whole
        // section unable to fail — a check that cannot fail reports success
        // forever (GOTCHAS G1), and the suite's own coverage ratchet catches
        // exactly that. It caught this.
        reporter.check("ref registry", false, `snapshot does not parse: ${err?.message ?? err}`);
        snap = undefined;
      }
      // ISSUES N55. HOW OLD is this registry? Until 2026-09-26 nothing asked.
      // `collect.sh` retired its branch-registry on 2026-08-24 because
      // propagate owns `propagation/refs/` now -- a correct handover whose
      // other half never landed: nothing invoked the new owner. Measured that
      // day, 11 of 12 registries were still frozen at the handover, 32 days
      // old, and one workspace alone had 32 unrecorded branch events.
      //
      // `lifecycle.jsonl` is an append-only HISTORY, so a branch created and
      // pruned between refreshes leaves no trace anywhere. Staleness here is
      // not cosmetic: it is silently lost history.
      //
      // INFO, not a failure. A stale registry is not a defect in propagate,
      // and the reasoning three blocks up applies -- a permanently-red doctor
      // trains people to ignore it. It escalates to `warn` only once the
      // refresh has plainly STOPPED rather than merely not run today.
      if (snap !== undefined) {
        const age = registryAgeDays(snap?.captured_at);
        if (age === null) {
          reporter.info("ref registry age", "snapshot carries no `captured_at` — cannot say how old it is");
        } else if (age >= REFS_STOPPED_DAYS) {
          reporter.warn(
            "ref registry age",
            `${age}d old (captured ${snap.captured_at}) — the daily refresh has stopped. ` +
            "Branch lifecycle between refreshes is not recoverable.",
          );
        } else if (age >= REFS_STALE_DAYS) {
          reporter.info("ref registry age", `${age}d old (captured ${snap.captured_at})`);
        }
      }

      const { findings, scanned, reason } = snap === undefined ? { findings: [], scanned: null, reason: null } : refFindings(snap);
      if (snap === undefined) {
        // already reported above
      } else if (reason) {
        reporter.info("ref registry", reason);
      } else if (findings.length === 0) {
        // "Found nothing" says what it looked at. "Looked at nothing" is the
        // branch above. They must not render the same.
        reporter.check("ref registry", true, `${scanned.refs} refs across ${scanned.projects} projects, nothing to flag`);
      } else {
        reporter.check("ref registry", true, `${scanned.refs} refs across ${scanned.projects} projects`);
        for (const f of findings) {
          // One kind. `f.why` is free-ish text from refFindings, so it stays in the
          // detail rather than becoming an unbounded label. Slice 3.
          reporter.warn("ref registry finding", `${f.project}/${f.ref ?? "(project)"} — ${f.why}`);
        }
      }

      // PRUNED REFS THAT MAY HAVE TAKEN WORK WITH THEM.
      //
      // This is the hook's RED rule, and it is the reason the hook could not
      // simply be deleted. The live-state findings above describe branches
      // that still exist; this describes branches that DO NOT, which is the
      // only alarm here that fires for something no longer available to
      // inspect. `classifyPruned` computes the verdict and `migrate-refs`
      // writes it — but until now nothing read it back, so the verdict was
      // recorded and never surfaced. A detector whose output nobody reads is
      // the same as no detector (rule:enforcement-watches-itself).
      //
      // `unknown` is shown alongside `lost` deliberately. "We could not
      // establish whether this ref's commits survive" is not reassurance;
      // treating unmeasured as safe is exactly what the shell lib refused to
      // do (rule:discernment-checks §2).
      const lifePath = path.join(ws.root, "propagation", "refs", "lifecycle.jsonl");
      if (existsSync(lifePath)) {
        const raw = await readFile(lifePath, "utf8");
        let unreadable = 0;
        const atRisk = [];
        for (const lineText of raw.split("\n")) {
          if (!lineText.trim()) continue;
          try {
            const e = JSON.parse(lineText);
            if (e.type === "pruned" && (e.work === "lost" || e.work === "unknown")) atRisk.push(e);
          } catch {
            // A malformed line is not zero lines. Counted, then reported —
            // an append-only log that silently drops rows would let the
            // count shrink without anyone noticing.
            unreadable++;
          }
        }
        if (unreadable) reporter.info("ref lifecycle", `${unreadable} unparseable line(s) in lifecycle.jsonl`);
        for (const e of atRisk) {
          // Two stable kinds; project/ref/evidence are the instance. Slice 3.
          reporter.warn(
            // The phrases are VERBATIM what they were in the detail. They are the
            // alarm someone greps for, and tests/portability/fresh-machine.test.mjs
            // matches them — moving a string is not licence to reword it.
            e.work === "lost" ? "PRUNED CARRYING WORK" : "pruned, work status UNKNOWN",
            `${e.project}/${e.ref} — ${e.evidence ?? "no evidence recorded"}`,
          );
        }
      }
    }
  } catch (err) {
    // Reaching here means something other than a parse failure — an
    // unreadable directory, an import error. Named, never silent, but not a
    // vote: it says the probe could not run, which is a third state distinct
    // from pass and fail (rule:discernment-checks §2).
    reporter.info("ref registry", `probe could not run: ${err?.message ?? err}`);
  }

  return { counts, details };
}
