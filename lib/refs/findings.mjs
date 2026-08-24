/**
 * findings.mjs — what the LIVE ref state says, as opposed to what changed.
 *
 * `diffSnapshots` answers "what happened since last time"; `classifyPruned`
 * answers "did that deletion lose work". Neither answers "what is wrong right
 * now", and that gap is why this file exists.
 *
 * PORTED, NOT RE-DERIVED. The four rules below are
 * `Vipin Kaushik/scripts/hygiene/lib/branch-registry.sh:250-266`, jq for jq.
 * That lib computed 11 of these on every commit in that workspace while its
 * only caller filtered to RED and printed nothing — so they were correct,
 * live, and invisible. G27 records three bugs introduced by re-deriving
 * behaviour while porting shape, which is why this is a translation rather
 * than a rewrite.
 *
 * ONE MAPPING IS NOT LITERAL, and it matters: the shell writes the string
 * `"unmeasured"` where propagate writes `null`. Same fact, two spellings. A
 * port that compared against `"unmeasured"` would silently never fire.
 */

/** Does `upstream_track` say this ref has commits the remote does not have? */
const isAhead = (r) => /ahead/.test(r?.upstream_track ?? "");

/**
 * @param {object|null} snapshot a v2 workspace snapshot
 * @returns {{findings: Array<{level:string, project:string, ref:string|null, why:string}>,
 *            scanned: {projects:number, refs:number}, reason?: string}}
 *
 * `reason` is present ONLY when nothing could be scanned. An empty `findings`
 * with no `reason` means a real scan found nothing — which is a pass. An empty
 * `findings` WITH a reason means the scan did not happen, which is not.
 * rule:enforcement-watches-itself instance 8 is this exact confusion rendering
 * "I looked at nothing" identically to "everything is fine".
 */
export function refFindings(snapshot) {
  const findings = [];
  const projects = snapshot?.projects ?? null;
  if (!projects || Object.keys(projects).length === 0) {
    return {
      findings,
      scanned: { projects: 0, refs: 0 },
      reason: snapshot == null ? "no ref snapshot — run `propagate migrate-refs <workspace> --apply`" : "the snapshot declares no projects",
    };
  }

  let refCount = 0;
  for (const [project, p] of Object.entries(projects)) {
    // A project we could not read is a finding in its own right. Skipping it
    // silently would shrink the denominator and make the workspace look
    // healthier the more of it is broken.
    if (p?.error) {
      findings.push({ level: "yellow", project, ref: null, why: `project could not be read: ${p.error}` });
      continue;
    }

    // Reported ONCE per project. Per-ref it would emit N identical rows and
    // bury the findings that name a specific branch — and every one of those N
    // would be the same fact stated N times.
    const baseUnusable = Boolean(p?.merge_state_error);
    if (baseUnusable) {
      findings.push({ level: "yellow", project, ref: null, why: `merge state unmeasurable for every ref: ${p.merge_state_error}` });
    }

    for (const [ref, r] of Object.entries(p?.refs ?? {})) {
      refCount++;

      // 1 · No upstream. The commits exist on this disk and nowhere else.
      if (r?.upstream == null) {
        findings.push({ level: "yellow", project, ref, why: "unbacked — no upstream, work exists only on this machine" });
      }

      // 2 / 3 · Merged splits on ahead-ness, and MUST stay split.
      // `propagation/state/workspace/STATE.md` records `8ebd4e6`: a merged
      // remote can still carry an unpushed local commit. Collapsing these into
      // one "merged — prunable" row is the advice that near-miss followed.
      if (r?.merge_state === "merged") {
        findings.push(
          isAhead(r)
            ? { level: "yellow", project, ref, why: "merged but has unpushed commits — do NOT prune yet" }
            : { level: "yellow", project, ref, why: "fully merged — prunable" },
        );
      }

      // 4 · UNMEASURED. `null` here, `"unmeasured"` in the shell. Never read as
      // safe: absence must be attributable (rule:discernment-checks §2).
      //
      // The active line is exempt because it IS the base — there is nothing to
      // measure it against, which is expected rather than notable. And when the
      // base itself is unusable the per-project row above already said so, so
      // this would restate it once per ref.
      if (r?.merge_state == null && !r?.is_active_line && !baseUnusable) {
        findings.push({ level: "yellow", project, ref, why: "merge state unmeasured (no base ref, or beyond the cherry cap)" });
      }
    }
  }

  return { findings, scanned: { projects: Object.keys(projects).length, refs: refCount } };
}
