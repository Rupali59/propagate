/**
 * Doc authority — which document GOVERNS a file, resolved at the moment of editing.
 *
 * Propagate answers "A changed, so B must change". That is drift, and it is derived on
 * demand: you run it. This module answers a different question — "you are about to edit
 * X; what governs X?" — and it has to answer BEFORE the edit, not after.
 *
 * It exists because linkage was never the problem. Measured 2026-08-15: only 4 of 79
 * VipinKaushik docs are referenced by nothing. `PRIVACY-CONTENT.md` was reachable from
 * STATE.md, DECISIONS.md and docs/README.md — and was still not read before its renderer
 * was rewritten, because nobody was looking for an index. Reachable is not read.
 *
 * An edge carries `authority` when the source is not merely coupled to the downstream but
 * governs it:
 *
 *   counsel   — the source's wording is authoritative and not the downstream editor's to
 *               change (legal copy, pricing). The hook BLOCKS.
 *   spec      — the source defines intended behaviour. Advisory.
 *   reference — useful background. Advisory.
 *
 * Deliberately three levels. A taxonomy nobody maintains decays into noise, and noise is
 * a hiding place (docs/GOTCHAS.md G23).
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import yaml from "yaml";

/** Authority levels, most binding first. Order is meaningful — `blocks()` uses it. */
export const AUTHORITY_LEVELS = ["counsel", "spec", "reference"];

/** Only `counsel` stops an edit. Being wrong elsewhere is cheap enough to warn about. */
export function blocks(level) {
  return level === "counsel";
}

/**
 * Build the authority index for one workspace: downstream path -> governing sources.
 *
 * Reads the same `.propagates.yml` sidecars propagate already uses — there is no second
 * declaration format, deliberately (docs/GOTCHAS.md G20: a second mechanism duplicates
 * the first unless you delete the first).
 *
 * @param {string[]} sidecarPaths absolute paths to `.propagates.yml` files
 * @returns {Map<string, Array<{source:string, authority:string, why:string, sidecar:string}>>}
 *          keyed by ABSOLUTE downstream path
 */
export function buildAuthorityIndex(sidecarPaths) {
  const index = new Map();
  for (const sidecar of sidecarPaths) {
    if (!existsSync(sidecar)) continue;
    let doc;
    try {
      doc = yaml.parse(readFileSync(sidecar, "utf8"));
    } catch {
      continue; // a malformed sidecar is doctor's problem, not the hook's
    }
    const base = path.dirname(sidecar);
    for (const [sourceRel, spec] of Object.entries(doc?.sources ?? {})) {
      for (const edge of spec?.propagates_to ?? []) {
        if (!edge?.authority || !edge?.path) continue;
        // Downstream paths resolve against the SIDECAR's directory, not the source's
        // dirname. Getting this backwards produced 216 phantom rows once.
        const abs = path.resolve(base, edge.path);
        if (!index.has(abs)) index.set(abs, []);
        index.get(abs).push({
          source: path.resolve(base, sourceRel),
          authority: edge.authority,
          why: edge.why ?? "",
          sidecar,
        });
      }
    }
  }
  return index;
}

/**
 * What governs `filePath`?
 *
 * Returns `{ governed: false, reason }` rather than an empty array when nothing does —
 * "no governing doc" and "I could not tell" are different facts and must not look alike
 * (rule:discernment-checks §2).
 */
export function whatGoverns(filePath, index) {
  const abs = path.resolve(filePath);
  const hits = index.get(abs);
  if (!hits || hits.length === 0) {
    return { governed: false, reason: "no declared authority edge names this file", hits: [] };
  }
  const order = (h) => AUTHORITY_LEVELS.indexOf(h.authority);
  return { governed: true, reason: null, hits: [...hits].sort((a, b) => order(a) - order(b)) };
}

/**
 * Coverage: code artifacts a governing doc ought to mention and does not.
 *
 * The shape that motivated this is not drift between two docs. `TurnstileWidget.tsx` is
 * live, wired into the booking form, and receives visitor IP — and `PRIVACY-CONTENT.md`,
 * the document that must disclose processors, never mentions Turnstile at all. Neither
 * file changed, so no drift check could ever fire. The doc was simply never written to
 * cover it.
 *
 * @param {Array<{name:string, artifacts:string[], doc:string}>} rules
 *        `name` is the thing to look for in `doc`; `artifacts` are the files proving it
 *        is live. Both sides are explicit — guessing which identifier "means" a processor
 *        is how false positives are made.
 * @returns {Array<{name:string, doc:string, artifacts:string[], covered:boolean, docExists:boolean}>}
 */
export function checkCoverage(rules, readFile = (p) => readFileSync(p, "utf8")) {
  const out = [];
  for (const rule of rules) {
    const live = (rule.artifacts ?? []).filter((a) => existsSync(a));
    if (live.length === 0) continue; // not in use — nothing to disclose
    let docExists = existsSync(rule.doc);
    let covered = false;
    if (docExists) {
      try {
        covered = readFile(rule.doc).toLowerCase().includes(rule.name.toLowerCase());
      } catch {
        docExists = false;
      }
    }
    out.push({ name: rule.name, doc: rule.doc, artifacts: live, covered, docExists });
  }
  return out;
}

/** One-line rendering shared by the CLI and the hook, so they cannot drift apart. */
export function formatGoverned(filePath, result) {
  if (!result.governed) {
    return `${path.basename(filePath)}: ungoverned — ${result.reason}`;
  }
  const lines = [`${path.basename(filePath)} is governed by:`];
  for (const h of result.hits) {
    const mark = blocks(h.authority) ? "BLOCKING" : "advisory";
    lines.push(`  [${h.authority}/${mark}] ${h.source}`);
    if (h.why) lines.push(`      ${h.why}`);
  }
  return lines.join("\n");
}
