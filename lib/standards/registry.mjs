/**
 * lib/standards/registry.mjs — standards.yml (the registry) and its pages.
 *
 * Mirrors loadServices: a null path reads as "standards not configured", never
 * as zero standards, and an empty registry is a shape this reader does not
 * recognise rather than a result (rule:discernment-checks §6).
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { readYamlSafe } from "../report/manifest.mjs";
import { parsePage } from "./parse.mjs";

const SCHEMA_VERSION = 1;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** @returns {{ok:true, standards:object}|{ok:false, reason:string}} */
export function loadRegistry(file) {
  if (!file) return { ok: false, reason: "standards not configured" };
  const r = readYamlSafe(file);
  if (r.error) return { ok: false, reason: `standards.yml unreadable: ${r.error}` };
  const doc = r.data;
  if (!isObj(doc)) return { ok: false, reason: "standards.yml unreadable: not a mapping" };
  if (doc.schema_version !== SCHEMA_VERSION) {
    return {
      ok: false,
      reason: `standards.yml unreadable: schema_version is ${JSON.stringify(doc.schema_version)}, this reader understands ${SCHEMA_VERSION}`,
    };
  }
  if (!isObj(doc.standards) || Object.keys(doc.standards).length === 0) {
    return {
      ok: false,
      reason: "standards.yml has no `standards:` mapping — a registry with nothing in it is a shape this reader does not recognise, not zero standards",
    };
  }
  const standards = {};
  for (const [id, s] of Object.entries(doc.standards)) {
    if (!isObj(s)) continue;
    standards[id] = {
      kind: s.kind ?? null,
      page: s.page ?? null,
      authority: s.authority ?? [],
      detect: s.detect ?? null,
      service: s.service ?? null,
      probe: s.probe ?? null,
      pointer_globs: s.pointer_globs ?? [],
    };
  }
  return { ok: true, standards };
}

/**
 * Registry joined to its parsed pages. A broken or missing page is a problem
 * naming the file; the other standards still load.
 * @returns {{ok:true, standards:object[], problems:string[]}|{ok:false, reason:string, problems:string[]}}
 */
export function loadStandards({ standardsFile, standardsDir } = {}) {
  const reg = loadRegistry(standardsFile);
  if (!reg.ok) return { ok: false, reason: reg.reason, problems: [] };
  const problems = [];
  if (!standardsDir) {
    return { ok: false, reason: "standards not configured", problems };
  }
  const standards = [];
  for (const [id, entry] of Object.entries(reg.standards)) {
    let page = null;
    const pageFile = entry.page ? path.join(standardsDir, entry.page) : null;
    if (!pageFile) problems.push(`standard ${id}: registry entry has no page`);
    else if (!existsSync(pageFile)) problems.push(`standard ${id}: page not found: ${pageFile}`);
    else {
      try {
        page = parsePage(readFileSync(pageFile, "utf8"), pageFile);
        for (const p of page.problems) problems.push(`${id}: ${p}`);
        if (page.id !== id) problems.push(`standard ${id}: page frontmatter id ${JSON.stringify(page.id)} differs from registry key ${JSON.stringify(id)} (${pageFile})`);
      } catch (err) {
        problems.push(`standard ${id}: page unreadable: ${err.message} (${pageFile})`);
      }
    }
    standards.push({ id, ...entry, page });
  }
  return { ok: true, standards, problems };
}
