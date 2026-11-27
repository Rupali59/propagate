/**
 * lib/kb/review/adjudicated.mjs — what `apply` renders once the maintainer has adjudicated (#412). Pure.
 *
 * The lane's decision stands unless adjudication.json says `rater` for that url. The returned brief is a copy for
 * rendering only: brief.json is never edited, and kappa was scored before any of this.
 * - lane excluded, rater included: the row counts as included. No claims were extracted for it, so it is listed.
 * - lane included, rater excluded: the row counts as excluded, its source is dropped, and so are the claims and
 *   proposals that rest only on it.
 */
import { readAdjudication } from "./disagree.mjs";
import { readAgreement } from "./agree.mjs";

export function applyAdjudication(brief, dir) {
  const adj = readAdjudication(dir);
  const ag = readAgreement(dir).agreement;
  const overrides = [];
  if (!adj?.answers || !ag) return { brief, overrides };
  const flip = new Map();
  for (const [url, a] of Object.entries(adj.answers)) {
    if (a?.answer !== "rater") continue;
    const row = (brief.screened ?? []).find((s) => s.url === url && (s.decision === "included" || s.decision === "excluded"));
    const call = ag.screening?.[url];
    if (!row || (call !== "include" && call !== "exclude")) continue;
    const to = call === "include" ? "included" : "excluded";
    if (row.decision === to) continue;
    flip.set(url, to);
    overrides.push({ url, lane: row.decision === "included" ? "include" : "exclude", rater: call });
  }
  if (!flip.size) return { brief, overrides };
  const screened = brief.screened.map((s) => (flip.has(s.url) ? { ...s, decision: flip.get(s.url), reason: `adjudicated: the maintainer chose the second rater over the lane (${s.decision})` } : s));
  const droppedSources = new Set((brief.sources ?? []).filter((s) => flip.get(s.url) === "excluded").map((s) => s.id));
  const sources = (brief.sources ?? []).filter((s) => !droppedSources.has(s.id));
  const claims = (brief.claims ?? []).filter((c) => !c.source_ids.every((id) => droppedSources.has(id)));
  const kept = new Set(claims.map((c) => c.id));
  const proposals = (brief.proposals ?? []).filter((p) => p.claim_ids.every((id) => kept.has(id)));
  for (const o of overrides) o.note = flip.get(o.url) === "included" ? "now counted included; no claims were extracted from it" : "now counted excluded; its claims and proposals are withheld";
  return { brief: { ...brief, screened, sources, claims, proposals }, overrides };
}
