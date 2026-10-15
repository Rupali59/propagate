/**
 * health-exceptions.mjs — the declared-exceptions registry for doctor's permanent reds.
 *
 * WHY. Some doctor failures are deliberate, permanent decisions by the owner: a fork whose
 * CLAUDE.md restates a canonical rule because it is not ours to edit, a doc-only husk whose
 * state folder is empty because it holds no state. A red that can never go green trains the
 * reader to ignore red. This registry lets the owner ACCEPT one exact finding, with a reason
 * and a date, without weakening the check for everything else.
 *
 * SAME SHAPE AND DISCIPLINE AS `instruction-budget.yml` (lib/report/instructions.mjs
 * `parseBudgetRegistry` / `evaluateBudget`):
 *   - an unlisted failing finding stays a failure;
 *   - a listed finding that fails is ACCEPTED (counted and shown with its reason, not a failure);
 *   - a listed finding that NO LONGER fails is a STALE exception and IS a failure — the list may
 *     not outlive its reason;
 *   - a missing or unparseable registry is an attributable failure, never silently "no
 *     exceptions" (rule:discernment-checks §2).
 *
 * KEYS are `<check-id>:<subject>`, naming the exact failing finding. The check ids are the
 * closed set in KNOWN_CHECKS; a key for any other id is a registry problem, not an ignored line.
 * This file is pure (no I/O besides `loadHealthExceptions`); the doctor wiring is
 * lib/report/doctor/health-exceptions.mjs.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * The checks that can be excepted, and what a `subject` means for each.
 *  v3-layout-empty  subject = workspace name        (state/ present but holds no state)
 *  rules-restated   subject = `<rule>@<hub-relative path>` of the restating file
 */
export const KNOWN_CHECKS = Object.freeze(["v3-layout-empty", "rules-restated"]);

export const exceptionKey = (checkId, subject) => `${checkId}:${subject}`;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @param {string} text registry file contents
 * @returns {{entries: Map<string, {reason: string, since: string}>, problems: string[]}}
 */
export function parseHealthExceptions(text) {
  let doc;
  try {
    doc = parseYaml(text);
  } catch (err) {
    return { entries: new Map(), problems: [`not valid YAML: ${err.message}`] };
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return { entries: new Map(), problems: ["top level is not a mapping"] };
  }
  const problems = [];
  const entries = new Map();
  const ex = doc.exceptions;
  if (ex === undefined) {
    // An absent key is not "no exceptions" — it is a file that does not say. An EMPTY mapping
    // (`exceptions: {}`) is the explicit way to declare none.
    return { entries, problems: ["no `exceptions:` mapping (write `exceptions: {}` to declare none)"] };
  }
  if (ex === null || typeof ex !== "object" || Array.isArray(ex)) {
    return { entries, problems: ["`exceptions` is not a mapping"] };
  }
  for (const [key, v] of Object.entries(ex)) {
    const colon = key.indexOf(":");
    const checkId = colon === -1 ? "" : key.slice(0, colon);
    const subject = colon === -1 ? "" : key.slice(colon + 1);
    if (!KNOWN_CHECKS.includes(checkId) || !subject) {
      problems.push(`${key}: key must be \`<check-id>:<subject>\` with check-id one of ${KNOWN_CHECKS.join(", ")}`);
      continue;
    }
    const reason = typeof v?.reason === "string" ? v.reason.trim() : "";
    const sinceRaw = v?.since instanceof Date ? v.since.toISOString().slice(0, 10) : v?.since;
    const since = typeof sinceRaw === "string" ? sinceRaw.trim() : "";
    if (!reason) problems.push(`${key}: missing \`reason:\``);
    if (!ISO_DAY.test(since)) problems.push(`${key}: \`since:\` must be a YYYY-MM-DD date`);
    if (reason && ISO_DAY.test(since)) entries.set(key, { reason, since });
  }
  return { entries, problems };
}

/**
 * Read the registry from disk, naming WHY when it cannot be used.
 * `hub` is derived the way the instruction budget derives it: the directory holding
 * `scripts/execution/`, so subjects can be hub-relative paths.
 *
 * @param {string|null|undefined} file
 * @returns {{state: "ok"|"missing"|"broken", file: string|null, hub: string|null, entries: Map, problems: string[]}}
 */
export function loadHealthExceptions(file) {
  if (!file) {
    return { state: "missing", file: null, hub: null, entries: new Map(), problems: ["not configured (set PROPAGATE_HEALTH_EXCEPTIONS_FILE or integrations.healthExceptionsFile)"] };
  }
  const hub = path.resolve(path.dirname(file), "..", "..");
  if (!existsSync(file)) {
    return { state: "missing", file, hub, entries: new Map(), problems: [`${file} does not exist`] };
  }
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    return { state: "broken", file, hub, entries: new Map(), problems: [`unreadable: ${err.message}`] };
  }
  const parsed = parseHealthExceptions(text);
  if (parsed.problems.length) return { state: "broken", file, hub, entries: new Map(), problems: parsed.problems };
  return { state: "ok", file, hub, entries: parsed.entries, problems: [] };
}

/**
 * Split findings of ONE check into failing and accepted.
 *
 * @param {Map<string, {reason: string, since: string}>} entries
 * @param {string} checkId
 * @param {Array<{subject: string}>} findings
 * @returns {{failing: object[], accepted: Array<{finding: object, key: string, reason: string, since: string}>}}
 */
export function adjudicate(entries, checkId, findings) {
  const failing = [];
  const accepted = [];
  for (const f of findings) {
    const key = exceptionKey(checkId, f.subject);
    const e = entries.get(key);
    if (e) accepted.push({ finding: f, key, reason: e.reason, since: e.since });
    else failing.push(f);
  }
  return { failing, accepted };
}

/**
 * Entries whose finding no longer fails. An entry is only judged when its check was actually
 * EVALUATED this run: a check that could not run says nothing about its exceptions, and calling
 * them stale then would send someone to delete a still-valid decision.
 *
 * @param {Map<string, object>} entries
 * @param {Set<string>} evaluated check ids that ran to a verdict
 * @param {Set<string>} seenFailing keys of every finding that failed (accepted or not)
 * @returns {{stale: string[], unjudged: string[]}}
 */
export function staleExceptions(entries, evaluated, seenFailing) {
  const stale = [];
  const unjudged = [];
  for (const key of entries.keys()) {
    const checkId = key.slice(0, key.indexOf(":"));
    if (!evaluated.has(checkId)) unjudged.push(key);
    else if (!seenFailing.has(key)) stale.push(key);
  }
  return { stale, unjudged };
}
