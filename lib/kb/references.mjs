/**
 * lib/kb/references.mjs — kb-references.yml, the registry of outside sources the knowledge base cites.
 *
 * Same contract as lib/kb/standards/registry.mjs: a null path reads as "references not configured", never as zero
 * references, and a file this reader cannot understand is a problem naming it, not an empty result
 * (rule:discernment-checks §6). It never throws. Ids are the mapping keys; `ref:<id>` is how output names one.
 */
import { readYamlSafe } from "../report/manifest.mjs";

const SCHEMA_VERSION = 1;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** @returns {{references: object[], problems: string[]}} */
export function loadReferences(file) {
  if (!file) return { references: [], problems: ["references not configured"] };
  const r = readYamlSafe(file);
  if (r.error) return { references: [], problems: [`kb-references.yml unreadable: ${r.error} (${file})`] };
  const doc = r.data;
  if (!isObj(doc)) return { references: [], problems: [`kb-references.yml unreadable: not a mapping (${file})`] };
  if (doc.schema_version !== SCHEMA_VERSION) {
    return { references: [], problems: [`unsupported schema_version ${JSON.stringify(doc.schema_version)}`] };
  }
  if (!isObj(doc.references) || Object.keys(doc.references).length === 0) {
    return {
      references: [],
      problems: [`kb-references.yml has no \`references:\` mapping — a file with nothing in it is a shape this reader does not recognise, not zero references (${file})`],
    };
  }
  const references = [];
  const problems = [];
  for (const [id, e] of Object.entries(doc.references)) {
    if (!isObj(e)) {
      problems.push(`reference ${id}: entry is not a mapping (${file})`);
      continue;
    }
    references.push({
      id,
      kind: e.kind ?? null,
      url: e.url ?? null,
      repo: e.repo ?? null,
      license: e.license ?? null,
      what: e.what ?? null,
      why: e.why ?? null,
      applies_to: e.applies_to ?? [],
      verdict: e.verdict ?? null,
      checked: e.checked ?? null,
      added: e.added ?? null,
    });
  }
  return { references, problems };
}
