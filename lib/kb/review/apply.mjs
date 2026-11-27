/**
 * lib/kb/review/apply.mjs — `kb review apply`: the ordered writes, behind the gate.
 *
 * It re-runs checkReview and refuses, writing NOTHING, on any refusal and also on SCREENING_UNSAMPLED (a warning in
 * `check`, so a brief can be gated before a person samples it, but a refusal here). Everything is computed before the
 * first write, so a refusal found late cannot leave a half-applied review. Writes, in order: brief.md, new reference
 * entries appended to kb-references.yml (verdict: evaluate, never higher), candidates.md, and, when `supersedes` is
 * set, the OLD review's `status.json` (superseded, by this review): the only write outside this review's directory.
 * An approved protocol.md is never edited; see status.mjs.
 */
import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { readAgreement } from "./agree.mjs";
import { applyAdjudication } from "./adjudicated.mjs";
import { checkReview, prismaCounts } from "./check.mjs";
import { parseProtocol } from "./protocol.mjs";
import { renderBrief, renderCandidates } from "./render.mjs";
import { writeStatus } from "./status.mjs";

const writeAtomic = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
};
const slugOf = (url) => {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, "")}${u.pathname}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "source";
  } catch {
    return "source";
  }
};
const q = (s) => JSON.stringify(String(s));

/** The text appended to kb-references.yml, and the ids it adds. Existing text is never rewritten. */
function referenceAppend({ brief, slug, date, existingIds }) {
  const sources = new Map(brief.sources.map((s) => [s.id, s]));
  const claims = new Map(brief.claims.map((c) => [c.id, c]));
  const ids = new Set(existingIds);
  const out = [];
  const added = [];
  for (const p of brief.proposals.filter((x) => x.target === "reference")) {
    const src = sources.get(claims.get(p.claim_ids[0])?.source_ids[0]);
    if (!src) continue;
    let id = p.ref_id || slugOf(src.url);
    for (let n = 2; ids.has(id); n++) id = `${p.ref_id || slugOf(src.url)}-${n}`;
    ids.add(id);
    added.push(id);
    out.push(`  ${id}:\n    kind: doc\n    url: ${q(src.url)}\n    what: ${q(p.text)}\n    why: ${q(`proposed by kb review ${slug}, claims ${p.claim_ids.join(", ")}`)}\n    applies_to: []\n    verdict: evaluate\n    checked: ${date}\n    added: {date: ${date}, by: "kb review apply", ask: ${q(slug)}}\n`);
  }
  return { text: out.join(""), added };
}

/**
 * @param {string} dir
 * @param {object} deps {stateDirPath, integrations, run, now}
 * @returns {{ok: boolean, wrote: string[], refusals: object[]}}
 */
export function applyReview(dir, deps = {}) {
  const check = checkReview(dir, deps);
  const refusals = [...check.refusals, ...check.warnings.filter((w) => w.code === "SCREENING_UNSAMPLED")];
  if (refusals.length) return { ok: false, wrote: [], refusals };

  const refuse = (code, what, where = "") => ({ ok: false, wrote: [], refusals: [{ code, what, where }] });
  const brief = JSON.parse(readFileSync(path.join(dir, "brief.json"), "utf8"));
  const protocol = parseProtocol(readFileSync(path.join(dir, "protocol.md"), "utf8")).fields;
  const agreement = readAgreement(dir).agreement;
  const date = new Date(deps.now ? deps.now() : Date.now()).toISOString().slice(0, 10);
  const slug = protocol.review;
  const refsFile = deps.integrations?.kbReferencesFile ?? null;

  let refsNext = null;
  const wantsRefs = brief.proposals.some((p) => p.target === "reference");
  if (wantsRefs) {
    if (!refsFile) return refuse("REFERENCES_NOT_CONFIGURED", "there are reference proposals but kb-references.yml is not configured", "proposals");
    const prior = existsSync(refsFile) ? readFileSync(refsFile, "utf8") : "schema_version: 1\nreferences:\n";
    const parsedPrior = YAML.parse(prior, { uniqueKeys: false });
    const priorRefs = parsedPrior && typeof parsedPrior.references === "object" && parsedPrior.references ? parsedPrior.references : null;
    if (!priorRefs) return refuse("REFERENCES_UNWRITABLE", `${refsFile} has no \`references:\` mapping to append to`, refsFile);
    const { text, added } = referenceAppend({ brief, slug, date, existingIds: Object.keys(priorRefs) });
    if (text) {
      const next = `${prior.endsWith("\n") ? prior : `${prior}\n`}${text}`;
      let parsed;
      try {
        parsed = YAML.parse(next, { uniqueKeys: false });
      } catch (e) {
        return refuse("REFERENCES_UNWRITABLE", `appending to ${refsFile} would not parse (${e.message.split("\n")[0]}); nothing was written`, refsFile);
      }
      const ok = Object.keys(priorRefs).every((k) => JSON.stringify(parsed.references?.[k]) === JSON.stringify(priorRefs[k])) && added.every((k) => parsed.references?.[k]?.verdict === "evaluate");
      if (!ok) return refuse("REFERENCES_UNWRITABLE", `appending to ${refsFile} would change or lose an entry (is \`references:\` the last key?); nothing was written`, refsFile);
      refsNext = next;
    }
  }

  const oldDir = protocol.supersedes ? path.join(path.dirname(path.resolve(dir)), String(protocol.supersedes)) : null;

  const wrote = [];
  const put = (file, text) => {
    writeAtomic(file, text);
    wrote.push(file);
  };
  // #412: the lane's decision stands unless the maintainer's adjudication says `rater`. kappa was scored on the
  // labels from before this, and brief.json is never edited: only what is rendered changes.
  const adj = applyAdjudication(brief, dir);
  const shown = adj.overrides.length ? { ...check, counts: prismaCounts(adj.brief.screened) } : check;
  put(path.join(dir, "brief.md"), renderBrief(protocol, adj.brief, shown, agreement, adj.overrides));
  if (refsNext) put(refsFile, refsNext);
  put(path.join(dir, "candidates.md"), renderCandidates(adj.brief, check));
  if (oldDir) wrote.push(writeStatus(oldDir, { status: "superseded", by: path.basename(path.resolve(dir)), date }));
  return { ok: true, wrote, refusals: [] };
}
