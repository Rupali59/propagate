/**
 * lib/kb/review/render.mjs — the text of brief.md and candidates.md. Pure: no I/O, no clock.
 *
 * Claim status is `quote_verified` everywhere: the quote exists in the saved source. Nothing here says a claim is
 * "verified" on its own, because the gate checked a quote, not the truth of the claim (design §S5).
 */

const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

function restrictionLines(r = {}) {
  const out = [];
  if (r.languages) out.push(`Only sources in ${[].concat(r.languages).join(", ")} were searched.`);
  if (r.date_window) {
    const { from, to } = r.date_window;
    out.push(from || to ? `Sources were limited to the period ${from ?? "the start"} to ${to ?? "today"}.` : "No date window was applied.");
  }
  if (r.tiers_searched) out.push(`Only tier ${[].concat(r.tiers_searched).join(", ")} sources were searched.`);
  if (r.lane_tool_calls != null) out.push(`Each search lane was limited to ${r.lane_tool_calls} tool calls.`);
  if (r.snowball_rounds != null) out.push(`Citation snowballing ran for ${r.snowball_rounds} round${r.snowball_rounds === 1 ? "" : "s"}.`);
  return out;
}

/** @param {object} protocol parsed front-matter fields */
export function renderBrief(protocol, brief, checkResult, agreement) {
  const tiers = checkResult.derived?.tiers ?? {};
  const sources = new Map(brief.sources.map((s) => [s.id, s]));
  const lines = [`# ${protocol.review}`, "", `Decision: ${oneLine(protocol.decision)} (decider: ${oneLine(protocol.decider)})`, ""];

  for (const q of protocol.questions ?? []) {
    lines.push(`## ${q.id}: ${oneLine(q.text)}`, "");
    const claims = brief.claims.filter((c) => c.rq === q.id);
    if (!claims.length) lines.push("No claim answers this question.", "");
    for (const c of claims) {
      lines.push(`- **${c.id}** (quote_verified): ${oneLine(c.text)}`);
      for (const qt of c.quotes) {
        const s = sources.get(qt.source_id);
        const t = tiers[qt.source_id];
        lines.push(`  > "${oneLine(qt.text)}" ([${s?.url ?? qt.source_id}](${s?.url ?? ""}), tier ${t?.tier ?? "?"}: ${t?.basis ?? "unknown"})`);
      }
    }
    lines.push("");
  }

  lines.push("## Disagreements", "");
  for (const [rq, v] of Object.entries(brief.disagreements)) {
    lines.push(Array.isArray(v) ? `- ${rq}:` : `- ${rq}: ${v}`);
    if (Array.isArray(v)) for (const d of v) lines.push(`  - ${oneLine(d)}`);
  }
  lines.push("");

  const sample = checkResult.derived?.support;
  lines.push("## Limitations", "");
  for (const l of restrictionLines(protocol.restrictions)) lines.push(`- ${l}`);
  lines.push(`- This is a ${protocol.type} review.`);
  lines.push(`- Claims are quote_verified: the quote exists in the saved source; support was sampled for ${sample ? sample.n : 0} claims, ${sample ? sample.failures : 0} failed.`);
  lines.push("");

  const c = checkResult.counts;
  lines.push("## Counts", "", `- Identified: ${c.identified}`, `- Duplicates removed: ${c.duplicates}`, `- Screened: ${c.screened}`, `- Excluded: ${c.excluded}`, `- Not retrieved: ${c.not_retrieved}`, `- Included: ${c.included}`, "");

  const sc = checkResult.derived?.screening;
  lines.push("## Screening agreement", "");
  if (!sc || !agreement) lines.push("Not sampled.");
  else {
    lines.push(`- Sampled decisions: ${sc.n}`, `- Raw agreement: ${sc.raw}`, `- Cohen's kappa: ${sc.kappa_defined ? sc.kappa.toFixed(2) : sc.note} (threshold 0.8, our own choice)`, `- Verdict: ${sc.verdict}`);
  }
  lines.push("");

  const ai = brief.ai_use;
  lines.push("## AI use", "", `- Models: ${ai.models.map((m) => `${m.model} ${m.version} (lane ${m.lane})`).join("; ")}`, `- Prompt hash: ${ai.prompt_sha}`, `- Run date: ${ai.run_date}`, `- Decided by the model: ${ai.decided.join(", ") || "nothing"}`, "");
  return lines.join("\n");
}

export function renderCandidates(brief, checkResult) {
  const tiers = checkResult.derived?.tiers ?? {};
  const sources = new Map(brief.sources.map((s) => [s.id, s]));
  const claims = new Map(brief.claims.map((c) => [c.id, c]));
  const lines = ["# Candidates", "", "Not adopted: a candidate becomes a row only through a PR Rupali merges.", ""];
  const rows = brief.proposals.filter((p) => p.target === "standard-row");
  if (!rows.length) lines.push("No standard-row candidates.", "");
  rows.forEach((p, i) => {
    lines.push(`## Candidate ${i + 1}${p.std_page ? ` (${p.std_page})` : ""}`, "", oneLine(p.text), "");
    const t1 = new Set();
    for (const id of p.claim_ids) {
      const c = claims.get(id);
      if (!c) continue;
      lines.push(`- ${c.id}: ${oneLine(c.text)}`);
      for (const q of c.quotes) {
        lines.push(`  > "${oneLine(q.text)}" (${sources.get(q.source_id)?.url ?? q.source_id})`);
        if (tiers[q.source_id]?.tier === 1) t1.add(`${sources.get(q.source_id)?.url} (${tiers[q.source_id].basis})`);
      }
    }
    lines.push("", `Tier-1 basis: ${[...t1].join("; ") || "none"}`, "");
  });
  return lines.join("\n");
}
