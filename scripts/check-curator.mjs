#!/usr/bin/env node
/**
 * check-curator.mjs — the deterministic gate on doc-curator's claims (propagate#251).
 *
 * The agent judges only whether a doc's CONTENT is still true; structure (orphan, unlinked, broken link) is
 * computed by curate-docs and is refused here. A claim that passes is INFERRED: never applied, never written.
 * Rupali, 2026-11-12: "if we are replacing a functionality, it better have a deterministic check at the end".
 *
 * Exit: 0 every claim passed · 1 any refused, or no claims · 2 input unreadable or wrong shape.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STRUCTURAL = /\b(orphan(s|ed)?|unlinked|unreferenced|broken[ -]links?|dead[ -]links?|dangling|no inbound)\b/i;
const MAX_SPAN = 5;
// Absolute, from this file: the gate runs from any cwd (#253), and a repo-relative command would not.
const CURATE = `node ${JSON.stringify(path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "skills", "curate-docs", "cli.mjs"))} <orphans|detached|dangling|report> <dir>`;

/**
 * @param {unknown} proposals  {root, claims: [...]} or a bare claims array
 * @param {{readFile: (p: string) => string, exists: (p: string) => boolean}} io
 * @returns {{ok: boolean, inferred: object[], refused: {index: number, path: string|null, reasons: string[]}[], error?: string}}
 */
export function checkCurator(proposals, { readFile, exists }) {
  const out = { ok: false, inferred: [], refused: [] };
  const claims = Array.isArray(proposals) ? proposals : Array.isArray(proposals?.claims) ? proposals.claims : null;
  if (!claims) return { ...out, error: "input is not {root, claims: [...]} (nor an array of claims)" };
  if (!claims.length) return { ...out, error: "nothing proposed: an empty claims list is not a pass" };
  const root = typeof proposals?.root === "string" && proposals.root ? proposals.root : "";
  const at = (p) => (root ? path.resolve(root, p) : p);

  claims.forEach((c, index) => {
    const reasons = [];
    const docPath = typeof c?.path === "string" ? c.path : null;
    const ev = c?.evidence ?? {};

    if (c?.claim !== "stale" && c?.claim !== "current") reasons.push(`claim must be exactly "stale" or "current", got ${JSON.stringify(c?.claim)}`);

    if (typeof c?.statement !== "string" || !c.statement.trim()) reasons.push("no statement");
    else if (STRUCTURAL.test(c.statement) || STRUCTURAL.test(String(c?.claim ?? ""))) {
      reasons.push(`structural: re-derive with curate-docs (${CURATE})`);
    }

    if (!docPath || !exists(at(docPath))) reasons.push(`path does not exist: ${docPath}`);
    else if (typeof c?.statement === "string" && c.statement.trim() && !readFile(at(docPath)).includes(c.statement)) {
      reasons.push("statement is not found in the doc at path");
    }

    if (typeof ev.file !== "string" || !exists(at(ev.file))) reasons.push(`evidence.file does not exist: ${ev.file}`);
    else if (typeof ev.quote !== "string" || !ev.quote || !Number.isInteger(ev.line) || ev.line < 1) {
      reasons.push("evidence needs a quote and a 1-based integer line");
    } else {
      const lines = readFile(at(ev.file)).split("\n");
      const span = lines.slice(ev.line - 1, ev.line - 1 + MAX_SPAN).join("\n");
      if (!span.includes(ev.quote)) reasons.push(`evidence.quote is not on ${ev.file} at line ${ev.line} (within ${MAX_SPAN} lines)`);
    }

    if (reasons.length) out.refused.push({ index, path: docPath, reasons });
    else out.inferred.push({ ...c, status: "INFERRED" });
  });

  out.ok = out.refused.length === 0 && out.inferred.length > 0;
  return out;
}

export function main(argv) {
  const file = argv[2];
  if (!file) {
    console.error("usage: node scripts/check-curator.mjs <proposals.json>");
    return 2;
  }
  let input;
  try {
    input = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    console.error(`unreadable input ${file}: ${e.message}`);
    return 2;
  }
  const r = checkCurator(input, { readFile: (p) => readFileSync(p, "utf8"), exists: (p) => existsSync(p) });
  if (r.error) {
    console.error(r.error);
    return r.error.startsWith("nothing proposed") ? 1 : 2;
  }
  for (const c of r.inferred) console.log(`INFERRED ${c.claim} ${c.path}: ${c.statement}`);
  for (const x of r.refused) for (const why of x.reasons) console.log(`REFUSED  #${x.index} ${x.path ?? "?"}: ${why}`);
  return r.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv);
