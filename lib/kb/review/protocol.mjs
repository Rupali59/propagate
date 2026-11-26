/**
 * lib/kb/review/protocol.mjs — the review protocol: its template, its parse, and `newReview`.
 *
 * `parseProtocol` never throws and names what it cannot read; an empty `approved.by` is not its problem, the gate's
 * (check.mjs) — a protocol is parseable before anyone approves it.
 */
import { mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";

export const TYPES = ["rapid-multivocal", "scoping", "systematic", "living"];
export const STATUSES = ["current", "superseded", "retired"];
const CADENCE = /^(none|on-trigger|[1-9]\d*d)$/;
export const REQUIRED_KEYS = [
  "review", "type", "status", "supersedes", "decision", "decider", "questions", "restrictions",
  "stopping", "inclusion", "exclusion", "sources", "upkeep", "approved",
];
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export function renderProtocolTemplate({ slug, date, decision = "", decider = "" }) {
  return `---
review: ${slug}
type: rapid-multivocal        # or: scoping, systematic, living — declared, never implied
status: current               # current | superseded | retired
supersedes: null              # a sibling review dir name, or null
decision: ${JSON.stringify(decision)}                  # the decision this review feeds
decider: ${JSON.stringify(decider)}                    # who makes it
questions: []                 # [{id: RQ1, text: ""}]
restrictions: {languages: [en], date_window: {from: null, to: null}, tiers_searched: [1, 2, 3], lane_tool_calls: 15, snowball_rounds: 1}
stopping: {effort_tool_calls: 15, saturation_k: 3}
inclusion: []
exclusion: []
sources: {}                   # {RQ1: [openalex, arxiv, docs]}
upkeep: {last_search: null, cadence: none, trigger: null, retire_when: [no-longer-decision-priority, certainty-not-low, no-new-evidence-expected], reassess: yearly}
approved: {by: null, date: null}
---

# Protocol: ${slug} (${date})

## Background

Why this review exists, and what is already known. One paragraph.

## Research questions

One row per question in \`questions:\` above. Each must be answerable from sources, not from opinion.

## Search strategy

Engines per question, search strings, the tiers searched and why, and when the lanes stop.

## Selection

The inclusion and exclusion criteria, in words, and how a borderline source is decided.

## Quality

How a source's trustworthiness is judged: its tier, its venue, and whether a second reviewer checks it.

## Extraction

What is pulled from each included source, and the verbatim-quote rule (6-15 words per quote).

## Synthesis

How claims are combined across sources, and how a disagreement between sources is reported.
`;
}

/** @returns {{ok: boolean, fields: object|null, problems: string[]}} */
export function parseProtocol(text) {
  const fail = (m) => ({ ok: false, fields: null, problems: [m] });
  if (typeof text !== "string") return fail("protocol is not text");
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!m) return fail("protocol has no front matter: expected a `---` block at the top");
  let fields;
  try {
    fields = YAML.parse(m[1]);
  } catch (e) {
    return fail(`protocol front matter is not valid YAML: ${String(e.message).split("\n")[0]}`);
  }
  if (!isObj(fields)) return fail("protocol front matter is not a mapping, so none of its keys could be read");
  const problems = [];
  for (const k of REQUIRED_KEYS) if (!(k in fields)) problems.push(`missing key: ${k}`);
  if ("type" in fields && !TYPES.includes(fields.type)) {
    problems.push(`type ${JSON.stringify(fields.type)} is not one of ${TYPES.join(" | ")}`);
  }
  if ("status" in fields && !STATUSES.includes(fields.status)) {
    problems.push(`status ${JSON.stringify(fields.status)} is not one of ${STATUSES.join(" | ")}`);
  }
  if ("upkeep" in fields) {
    if (!isObj(fields.upkeep)) problems.push("upkeep is not a mapping");
    else if (!("cadence" in fields.upkeep)) problems.push("missing key: upkeep.cadence");
    else if (typeof fields.upkeep.cadence !== "string" || !CADENCE.test(fields.upkeep.cadence)) {
      problems.push(`upkeep.cadence ${JSON.stringify(fields.upkeep.cadence)} is not none | <N>d | on-trigger`);
    }
  }
  if ("approved" in fields && !isObj(fields.approved)) problems.push("approved is not a mapping");
  return { ok: problems.length === 0, fields, problems };
}

/**
 * Does the protocol require a PERSON as second reviewer? (#376) One deterministic rule: yes, unless its `## Quality`
 * section declares a line `second reviewer: model` (or `ai` / `llm`). The default is a person because every approved
 * protocol already names one (`approved.by` and `decider` are people), so a protocol that wants a model rater must say
 * so in words, and silence never lets a model stand in for the human check.
 */
export function requiresHumanSecondReviewer(text) {
  const m = /^##\s+Quality\s*\r?\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m.exec(String(text ?? ""));
  return !(m && /second reviewer\W{0,4}\s*(?:a |an |the )?(?:second )?(?:model|ai|llm)\b/i.test(m[1]));
}

/**
 * Create `dir` with a fresh protocol.md. Refuses an existing directory, whatever is in it.
 * @returns {{ok: true, wrote: string[]} | {ok: false, code: string, what: string, next: string}}
 */
export function newReview(dir, opts) {
  const file = path.join(dir, "protocol.md");
  try {
    mkdirSync(path.dirname(dir), { recursive: true });
    mkdirSync(dir); // non-recursive: EEXIST is the refusal, and it is atomic
  } catch (e) {
    if (e.code === "EEXIST") {
      return {
        ok: false,
        code: "KB_REVIEW_EXISTS",
        what: `${dir} already exists; a review is never overwritten`,
        next: "choose a different slug, or supersede it with a new review whose protocol sets `supersedes:`",
      };
    }
    return { ok: false, code: "KB_REVIEW_WRITE", what: `could not create ${dir}: ${e.message}`, next: "check the path and its permissions" };
  }
  const tmp = `${file}.tmp`;
  try {
    writeFileSync(tmp, renderProtocolTemplate(opts));
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    return { ok: false, code: "KB_REVIEW_WRITE", what: `could not write ${file}: ${e.message}`, next: `remove ${dir} and retry` };
  }
  return { ok: true, wrote: [file] };
}
