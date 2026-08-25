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

import { existsSync, globSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { loadSidecar, SidecarError } from "../../edges/frontmatter.mjs";
import { readLedgerWithStats } from "../../edges/ledger.mjs";
import { classifyDownstreamPath } from "../../edges/edges.mjs";

/**
 * @param {{
 *   ws: {name: string, root: string, ledgerJsonl: string, ledgerMd: string},
 *   sidecars: string[],
 *   reporter: import("./reporter.mjs").Reporter,
 * }} deps
 * @returns {Promise<{counts: object, details: object}>}
 */
export async function checkWorkspace({ ws, sidecars, reporter }) {
  const counts = {
    rowsOpen: 0,
    ledgerUnknownTypes: 0,
    sidecarsLoaded: 0,
    sidecarsRejected: 0,
    sidecarsProblems: 0,
  };
  const details = { ledgerUnknownTypes: [], sidecarsRejected: [] };

  reporter.check("ledger JSONL exists", existsSync(ws.ledgerJsonl));
  if (existsSync(ws.ledgerJsonl)) {
    try {
      const { rows, unknownTypes } = await readLedgerWithStats(ws.ledgerJsonl);
      const openCount = rows.filter((r) => r.status === "open").length;
      counts.rowsOpen += openCount;
      reporter.check("ledger JSONL parseable", true, `${rows.length} rows, ${openCount} open`);

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
          if (d?.kind === "code" && /[*?[\]]/.test(String(d.path ?? ""))) {
            reporter.info(
              `  ${rel}: ${srcKey} → ${d.path}`,
              "unenforced — glob kind:code downstreams are deferred, so this edge never fires (N6)",
            );
          }
        }
      }
      for (const srcKey of Object.keys(loaded.sources || {})) {
        if (!existsSync(path.resolve(path.dirname(sc), srcKey))) {
          reporter.check(
            `  ${rel}: source "${srcKey}"`,
            false,
            "does not exist — this edge can never fire (a source is not declare-ahead eligible)",
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

  // Path validation: every sidecar downstream target resolves on disk.
  // prose missing → problem (fail); code (declare-ahead) → warn; glob → need ≥1 match.
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
        if (/[*?[\]]/.test(d.path)) {
          let n = 0;
          try {
            n = globSync(d.path, { cwd: scDir }).filter((m) => !m.includes("node_modules/")).length;
          } catch {
            /* ignore */
          }
          if (n === 0) {
            reporter.warn(`${rel}: ${src} → ${d.path}`, "glob matched 0 files");
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
            // Warn-only: doctor is a cross-workspace health report — a stale edge
            // in one workspace must not red the aggregate exit code. Per-repo
            // enforcement lives in that repo's pre-commit (check-propagation.sh).
            // v1's prose/code distinction is intentional and unchanged here:
            // `kind: code` missing is declare-ahead, not a bug.
            reporter.warn(
              `${rel}: ${src} → ${d.path}`,
              kind === "code" ? "declare-ahead code, not on disk" : "prose downstream missing",
            );
            pathWarns++;
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
          reporter.warn(`  ${f.project}/${f.ref ?? "(project)"}`, f.why);
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
          reporter.warn(`  ${e.project}/${e.ref}`, `${e.work === "lost" ? "PRUNED CARRYING WORK" : "pruned, work status UNKNOWN"} — ${e.evidence ?? "no evidence recorded"}`);
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
