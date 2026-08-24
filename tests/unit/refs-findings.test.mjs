/**
 * Live-state ref findings — the capability that had no equivalent in propagate.
 *
 * `classifyPruned` only fires when a ref DISAPPEARS. These four rules fire on
 * refs that still exist, and they are the thing `hygiene/branch-registry.sh`
 * computed 11 of on every commit while its caller filtered to RED and printed
 * nothing. Deleting the hook without porting them would have removed a
 * capability nobody knew was there — which is why the plan orders it
 * port-then-remove.
 *
 * The rules are ported from that lib's jq block (`:250-266`), NOT re-derived.
 * G27 records three separate bugs from re-deriving behaviour while porting
 * shape; this file exists so the fourth is caught by a test instead of by
 * production.
 *
 * THE `merged but ahead` RULE IS THE ONE WITH AN INCIDENT BEHIND IT.
 * `propagation/state/workspace/STATE.md` records `8ebd4e6`: a merged remote can
 * still carry an unpushed local commit, so "merged" alone is not "safe to
 * delete". Merging those two rules into one would lose exactly the distinction
 * that near-miss was about.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { refFindings } from "../../lib/refs/findings.mjs";

/** A snapshot in the v2 shape, with one project and the refs given. */
const snap = (refs, extra = {}) => ({
  schema_version: 2,
  projects: { p: { repo_root: "/p", base_ref: "origin/main", error: null, refs, detached_worktrees: [], ...extra } },
});

const ref = (o = {}) => ({
  head: "abc1234", kind: "branch", upstream: "origin/x", upstream_track: "",
  merge_state: "unmerged", is_active_line: false, last_commit_iso: null, worktrees: [], ...o,
});

test("no upstream is `unbacked` — the work exists only on this machine", () => {
  const { findings } = refFindings(snap({ solo: ref({ upstream: null }) }));
  assert.equal(findings.length, 1);
  assert.match(findings[0].why, /unbacked/);
  assert.equal(findings[0].level, "yellow");
  assert.equal(findings[0].ref, "solo");
});

test("merged and NOT ahead is prunable", () => {
  const { findings } = refFindings(snap({ done: ref({ merge_state: "merged" }) }));
  assert.equal(findings.length, 1);
  assert.match(findings[0].why, /prunable/);
});

test("merged AND ahead is NOT prunable — the 8ebd4e6 case", () => {
  // A merged remote with an unpushed local commit. Reporting this as `prunable`
  // is how the near-miss happened; the two rules must stay distinct.
  const { findings } = refFindings(snap({ risky: ref({ merge_state: "merged", upstream_track: "ahead 1" }) }));
  assert.equal(findings.length, 1);
  assert.match(findings[0].why, /do NOT prune/);
  assert.doesNotMatch(findings[0].why, /^fully merged/);
});

test("an UNMEASURED merge state is reported — never read as safe", () => {
  const { findings } = refFindings(snap({ far: ref({ merge_state: null }) }));
  assert.equal(findings.length, 1);
  assert.match(findings[0].why, /unmeasured/);
});

test("the active line is exempt from the unmeasured rule, but not from the others", () => {
  // `same` is not a defect, and the active line having no measurable base is
  // expected rather than notable. It having no upstream is still worth saying.
  const clean = refFindings(snap({ production: ref({ merge_state: null, is_active_line: true }) }));
  assert.equal(clean.findings.length, 0, `active line should be quiet, got ${JSON.stringify(clean.findings)}`);

  const unbacked = refFindings(snap({ production: ref({ merge_state: "same", is_active_line: true, upstream: null }) }));
  assert.equal(unbacked.findings.length, 1, "an unbacked active line is still unbacked");
});

test("`same` and a healthy `unmerged` produce NOTHING — the rules must be able to stay quiet", () => {
  // rule:discernment-checks §1 in the other direction: a rule set that flags
  // every ref is as useless as one that flags none.
  const { findings } = refFindings(snap({
    production: ref({ merge_state: "same", is_active_line: true }),
    "feat/x": ref({ merge_state: "unmerged" }),
  }));
  assert.equal(findings.length, 0, JSON.stringify(findings));
});

test("LOOKED AT NOTHING and FOUND NOTHING are different outputs", () => {
  // rule:discernment-checks §2 / §6. An empty findings array from an absent
  // snapshot must never render identically to a clean bill of health — that is
  // the `bootstrap printed 0 · 0 · 0` failure in rule:enforcement-watches-itself.
  const none = refFindings(null);
  assert.equal(none.findings.length, 0);
  assert.ok(none.reason, "an absent snapshot must carry a reason");
  assert.equal(none.scanned.refs, 0);

  const clean = refFindings(snap({ production: ref({ merge_state: "same", is_active_line: true }) }));
  assert.equal(clean.findings.length, 0);
  assert.equal(clean.reason, undefined, "a real scan that found nothing must NOT carry a reason");
  assert.equal(clean.scanned.refs, 1, "and must say how much it looked at");
});

test("a project that could not be read is a finding, not a silent skip", () => {
  const s = snap({});
  s.projects.p.error = "not a git repository";
  const { findings } = refFindings(s);
  assert.equal(findings.length, 1);
  assert.match(findings[0].why, /not a git repository/);
  assert.equal(findings[0].ref, null, "a project-level problem has no ref");
});

test("an unmeasurable base is surfaced ONCE per project, not once per ref", () => {
  // Otherwise a repo whose base does not resolve emits N identical yellows and
  // drowns the findings that name a specific branch.
  const s = snap({ a: ref({ merge_state: null }), b: ref({ merge_state: null }) });
  s.projects.p.merge_state_error = "base ref origin/main does not resolve in this repo";
  const { findings } = refFindings(s);
  const baseFindings = findings.filter((f) => /does not resolve/.test(f.why));
  assert.equal(baseFindings.length, 1, JSON.stringify(findings));
  assert.equal(baseFindings[0].ref, null);
  // …and the per-ref unmeasured rule must not ALSO fire, or every ref doubles up.
  assert.equal(findings.filter((f) => /unmeasured/.test(f.why)).length, 0);
});

/**
 * THE INSTRUMENT MUST DECLARE ITS OWN BLIND SPOT.
 *
 * `branch-registry.sh` emitted, on every run:
 *
 *   "blind_spot": "a ref created and deleted inside one window is invisible
 *                  to this instrument"
 *
 * propagate inherits that limitation exactly — it too derives lifecycle by
 * comparing two captures, so a branch that appears and disappears between them
 * leaves no trace. It did NOT inherit the sentence, which is the difference
 * between a known limitation and an unknown one.
 *
 * This is the SIXTH thing dropped by porting shape without behaviour (G27), and
 * the most quietly expensive kind: without it a reader treats lifecycle.jsonl as
 * complete history, which it is not and never was.
 */
import { buildWorkspaceSnapshot } from "../../lib/refs/snapshot.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("every snapshot declares the blind spot it inherited from the shell", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "blind-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const snap = await buildWorkspaceSnapshot(root, { now: "2026-08-24T00:00:00Z" });
  assert.match(
    snap.blind_spot ?? "",
    /created and deleted/,
    "a snapshot-diff instrument that does not say what it cannot see is read as complete",
  );
});
