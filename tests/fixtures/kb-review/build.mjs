/**
 * Builds a review fixture on disk, in a throwaway git repo and state dir. Derived rather than committed: the gate
 * reads `git hash-object` and commit dates, which a checked-in fixture directory cannot carry. Every commit uses a
 * fixed date, so the "protocol after search" check is deterministic.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderProtocolTemplate } from "../../../lib/kb/review/protocol.mjs";
import { drawSample } from "../../../lib/kb/review/agree.mjs";

export const COMMIT_DATE = "2026-11-20T10:00:00Z";
export const SEARCH_DATE = "2026-11-21";
export const BODY1 = "Intro text. The quick brown fox jumps over the lazy dog, as the old saying goes. More text.";
export const BODY2 = "Guide. Tests must exercise every path before the code ships to anyone. End.";
export const QUOTE1 = "The quick brown fox jumps over the lazy dog";
export const QUOTE2 = "Tests must exercise every path before the code ships";
const sha256 = (t) => createHash("sha256").update(t).digest("hex");
const git = (cwd, args, env = {}) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_DATE: COMMIT_DATE, GIT_COMMITTER_DATE: COMMIT_DATE, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", ...env } });

export const snapshot = (dir) => {
  if (!dir) return "";
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { out.push(`${p}/`); walk(p); } else out.push(`${p}\0${readFileSync(p, "utf8")}`);
    }
  };
  walk(dir);
  return out.join("\n");
};

/**
 * @param {object} o {into (a fixture to add a second review to, sharing its hub and state), slug, supersedes, approved, searchDate, tweakBrief(brief), tweakProtocol(text), editProtocolAfter,
 *   leaveUncommitted, agreement: "reliable"|"unreliable"|null, referencesYaml, tiersYaml, omitBody, tweakFetched(records)}
 * @returns {{root, reviews, dir, state, refs, tiers, protocolSha, brief, integrations}}
 */
export function buildReview(o = {}) {
  const root = o.into?.root ?? mkdtempSync(path.join(os.tmpdir(), "kb-rev-fx-"));
  const hub = path.join(root, "hub");
  const reviews = path.join(hub, "kb", "reviews");
  const state = path.join(root, "state");
  const slug = o.slug ?? "llm-screening";
  const dir = path.join(reviews, `2026-11-20-${slug}`);
  mkdirSync(dir, { recursive: true });
  mkdirSync(path.join(state, "kb", "fetched"), { recursive: true });
  if (!o.into) {
    git(hub, ["init", "-q"]);
    git(hub, ["config", "user.email", "t@example.com"]);
    git(hub, ["config", "user.name", "t"]);
  }

  let proto = renderProtocolTemplate({ slug, date: "2026-11-20", decision: "pick a screening method", decider: "owner" })
    .replace("questions: []", 'questions: [{id: RQ1, text: "which method?"}]')
    .replace("supersedes: null", `supersedes: ${o.supersedes ?? "null"}`)
    .replace("approved: {by: null, date: null}", o.approved === false ? "approved: {by: null, date: null}" : "approved: {by: owner, date: 2026-11-20}");
  if (o.tweakProtocol) proto = o.tweakProtocol(proto);
  writeFileSync(path.join(dir, "protocol.md"), proto);
  git(hub, ["add", "."]);
  git(hub, ["commit", "-q", "-m", "protocol"]);
  const protocolSha = git(dir, ["hash-object", "protocol.md"]).trim();

  const body1 = sha256(BODY1);
  const body2 = sha256(BODY2);
  if (!o.omitBody) {
    writeFileSync(path.join(state, "kb", "fetched", body1), BODY1);
    writeFileSync(path.join(state, "kb", "fetched", body2), BODY2);
  }
  let records = [
    { url: "https://example.com/a", final_url: "https://example.com/a", status: 200, type: "html", sha256: body1, date: SEARCH_DATE, classification: "ok" },
    { url: "https://docs.example.org/guide", final_url: "https://docs.example.org/guide", status: 200, type: "html", sha256: body2, date: SEARCH_DATE, classification: "ok" },
    { url: "https://example.com/c", final_url: null, status: 404, type: null, sha256: null, date: SEARCH_DATE, classification: "not_retrieved" },
  ];
  if (o.tweakFetched) records = o.tweakFetched(records);
  writeFileSync(path.join(dir, "fetched.json"), JSON.stringify({ schema_version: 1, records }, null, 2));
  const sdate = o.searchDate ?? SEARCH_DATE;
  writeFileSync(path.join(dir, "searches.json"), JSON.stringify([{ lane: "L1", engine: "openalex", query: "llm screening", date: sdate, hits: 5 }], null, 2));
  writeFileSync(path.join(dir, "discovered.json"), "[]\n");

  const brief = {
    schema_version: 1,
    review: slug,
    protocol_sha: protocolSha,
    ai_use: { models: [{ lane: "L1", model: "example-model", version: "1" }], prompt_sha: "ab12cd34", run_date: "2026-11-21T09:00:00Z", decided: ["screening", "extraction"] },
    searches: [{ lane: "L1", engine: "openalex", query: "llm screening", date: sdate, hits: 5 }],
    lanes: [{ id: "L1", model: "example-model" }],
    screened: [
      { url: "https://example.com/a", decision: "included", reason: "", lane: "L1" },
      { url: "https://docs.example.org/guide", decision: "included", reason: "", lane: "L1" },
      { url: "https://example.com/b", decision: "excluded", reason: "off topic", lane: "L1" },
      { url: "https://example.com/c", decision: "not_retrieved", reason: "404", retrieval_reason: "http_404", lane: "L1" },
      { url: "http://www.example.com/a/?utm_source=x#frag", decision: "included", reason: "", lane: "L1" },
    ],
    sources: [
      { id: "S1", url: "https://example.com/a", sha256: body1, secondary_review: false },
      { id: "S2", url: "https://docs.example.org/guide", sha256: body2, secondary_review: false },
    ],
    claims: [
      { id: "C1", rq: "RQ1", text: "foxes jump", source_ids: ["S1"], quotes: [{ source_id: "S1", text: QUOTE1 }] },
      { id: "C2", rq: "RQ1", text: "tests cover paths", source_ids: ["S2"], quotes: [{ source_id: "S2", text: QUOTE2 }] },
    ],
    disagreements: { RQ1: "none found" },
    proposals: [
      { target: "reference", claim_ids: ["C1"], ref_id: "example-a", text: "a page about foxes" },
      { target: "standard-row", claim_ids: ["C2"], std_page: "testing.md", text: "cover every path" },
    ],
  };
  const final = o.tweakBrief ? (o.tweakBrief(brief) ?? brief) : brief;
  writeFileSync(path.join(dir, "brief.json"), JSON.stringify(final, null, 2));

  if (o.editProtocolAfter) {
    writeFileSync(path.join(dir, "protocol.md"), `${readFileSync(path.join(dir, "protocol.md"), "utf8")} \n`);
    git(hub, ["add", "."]);
    git(hub, ["commit", "-q", "-m", "whitespace"]);
  }
  if (o.leaveUncommitted) writeFileSync(path.join(dir, "protocol.md"), `${readFileSync(path.join(dir, "protocol.md"), "utf8")}\n# note\n`);

  if (o.agreement) {
    const s = drawSample(final);
    const agent = new Map(final.screened.map((x) => [x.url, x.decision === "included" ? "include" : "exclude"]));
    const flip = o.agreement === "unreliable";
    writeFileSync(path.join(dir, "agreement.json"), JSON.stringify({
      schema_version: 1,
      protocol_sha: final.protocol_sha,
      screening: Object.fromEntries(s.screening.map((x) => [x.url, flip ? (agent.get(x.url) === "include" ? "exclude" : "include") : agent.get(x.url)])),
      support: Object.fromEntries(s.support.map((x) => [x.claim_id, "supports"])),
    }, null, 2));
  }

  const refs = path.join(root, "kb-references.yml");
  writeFileSync(refs, o.referencesYaml ?? "schema_version: 1\nreferences:\n  site-1:\n    kind: doc\n    url: https://example.com/existing\n    what: an existing thing\n    why: a reason\n    applies_to: [node]\n    verdict: adopt\n    checked: 2026-11-01\n    added: 2026-11-01\n");
  const tiers = path.join(root, "kb-tiers.yml");
  writeFileSync(tiers, o.tiersYaml ?? "schema_version: 1\ndomains:\n  arxiv.org: 2\n  example.com: 2\nofficial_docs:\n  - docs.example.org\n");
  return { root, hub, reviews, dir, state, refs, tiers, protocolSha, brief: final, integrations: { kbReferencesFile: refs, kbTiersFile: tiers, kbStandardsDir: path.join(hub, "kb", "standards") } };
}

/** Review dirs for a superseding pair: returns the second review built beside the first. */
export function addSiblingReview(fx, name, protocolText) {
  const d = path.join(fx.reviews, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, "protocol.md"), protocolText);
  git(fx.hub, ["add", "."]);
  git(fx.hub, ["commit", "-q", "-m", `sibling ${name}`]);
  return d;
}
