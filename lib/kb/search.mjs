/**
 * lib/kb/search.mjs — `kb search`: one derived search over every entry the knowledge base holds (#323, epic #321 S2).
 *
 * No index. Every call re-reads three populations and ranks them:
 *   std:<row-id>   a standards row (registry -> page -> `### <id> · <title>` row)
 *   ref:<id>       an entry of kb-references.yml
 *   reg:<id>       a `### <id> · <title>` block in a `*.md` file of `registersDir` (evaluator's registers)
 * Each hit carries `path:line` and its checked date. Ranking is by field weight (id, then title, then the
 * descriptive fields, then body text), every term must match somewhere, and ties break on id so output is stable.
 *
 * The FLOOR: if no entry at all was parsed the scan reports `blind: true`; the caller turns that into exit 2. A search
 * over nothing must never read as "no results" (rule:discernment-checks §2, rule:derive-dont-curate).
 * It never throws: an unreadable source is a `problems` line naming it.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadReferences } from "./references.mjs";
import { loadRegistry } from "./standards/registry.mjs";
import { parsePage } from "./standards/parse.mjs";

const ROW_HEAD = /^###\s+(\S+)\s+·\s+(.*\S)\s*$/;
const CHECKED = /\*\*Checked:\*\*\s*(\d{4}-\d{2}-\d{2})/;
const W = { id: 5, title: 4, summary: 3, detail: 2, body: 1 };

/** Standards rows. @returns {{entries:object[], problems:string[]}} */
function standardEntries({ standardsFile, standardsDir }) {
  const entries = [];
  const problems = [];
  const reg = loadRegistry(standardsFile);
  if (!reg.ok) return { entries, problems: [reg.reason] };
  for (const [id, s] of Object.entries(reg.standards)) {
    if (!s.page || !standardsDir) continue;
    const file = path.join(standardsDir, s.page);
    if (!existsSync(file)) {
      problems.push(`standard ${id}: page not found: ${file}`);
      continue;
    }
    let page;
    try {
      page = parsePage(readFileSync(file, "utf8"), file);
    } catch (err) {
      problems.push(`standard ${id}: page unreadable: ${err.message} (${file})`);
      continue;
    }
    for (const r of page.rows) {
      entries.push({
        id: `std:${r.id}`,
        kind: "standard",
        title: r.title,
        path: file,
        line: r.line,
        checked: r.checked,
        fields: { id: [r.id], title: [r.title], summary: [r.apply, r.applies], detail: [r.failsWhen, r.source, r.version, id], body: [] },
      });
    }
  }
  return { entries, problems };
}

/** References. The line is that of the `  <id>:` key in the file. */
function referenceEntries(file) {
  const { references, problems } = loadReferences(file);
  const entries = [];
  if (references.length === 0) return { entries, problems };
  const lines = readFileSync(file, "utf8").split("\n");
  const lineOf = (id) => {
    const i = lines.findIndex((l) => new RegExp(`^\\s+${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*$`).test(l));
    return i === -1 ? null : i + 1;
  };
  for (const r of references) {
    entries.push({
      id: `ref:${r.id}`,
      kind: "reference",
      title: r.what ?? r.id,
      path: file,
      line: lineOf(r.id),
      checked: r.checked ? String(r.checked) : null,
      fields: { id: [r.id], title: [], summary: [r.what, r.kind], detail: [r.why, r.url, r.repo, r.verdict, ...[].concat(r.applies_to ?? [])], body: [] },
    });
  }
  return { entries, problems };
}

/** Registers: every `### <id> · <title>` block of each `*.md` file directly in `dir`. */
function registerEntries(dir) {
  const entries = [];
  const problems = [];
  if (!dir) return { entries, problems };
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  } catch (err) {
    return { entries, problems: [`registersDir unreadable: ${err.message}`] };
  }
  for (const f of files) {
    const file = path.join(dir, f);
    let lines;
    try {
      lines = readFileSync(file, "utf8").split("\n");
    } catch (err) {
      problems.push(`register unreadable: ${err.message} (${file})`);
      continue;
    }
    let cur = null;
    const flush = () => {
      if (!cur) return;
      const body = cur.body.join("\n");
      entries.push({
        id: `reg:${cur.id}`,
        kind: "register",
        title: cur.title,
        path: file,
        line: cur.line,
        checked: CHECKED.exec(body)?.[1] ?? null,
        fields: { id: [cur.id], title: [cur.title], summary: [], detail: [], body: [body] },
      });
      cur = null;
    };
    lines.forEach((raw, i) => {
      const line = raw.replace(/\r$/, "");
      const h = ROW_HEAD.exec(line);
      if (h) {
        flush();
        cur = { id: h[1], title: h[2], line: i + 1, body: [] };
      } else if (/^#{1,3}\s/.test(line)) flush();
      else if (cur) cur.body.push(line);
    });
    flush();
  }
  return { entries, problems };
}

/**
 * Every entry the knowledge base holds, plus the problems met reading it. `blind` is true when none parsed.
 * @returns {{entries:object[], problems:string[], blind:boolean}}
 */
export function collectEntries({ standardsFile, standardsDir, referencesFile, registersDir } = {}) {
  const parts = [standardEntries({ standardsFile, standardsDir }), referenceEntries(referencesFile ?? null), registerEntries(registersDir ?? null)];
  const entries = parts.flatMap((p) => p.entries);
  return { entries, problems: parts.flatMap((p) => p.problems), blind: entries.length === 0 };
}

/**
 * Rank `entries` against `terms` (all must match, case-insensitive substring). `kind` narrows to "standard" or "reference".
 * @returns {object[]} hits, best first: {id, kind, title, path, line, checked, score}
 */
export function rankEntries(entries, terms, { kind = null } = {}) {
  const ts = terms.map((t) => t.toLowerCase()).filter(Boolean);
  const hits = [];
  for (const e of entries) {
    if (kind && e.kind !== kind) continue;
    let score = 0;
    let all = true;
    for (const t of ts) {
      let best = 0;
      for (const [field, w] of Object.entries(W)) {
        const present = e.fields[field].some((v) => v != null && String(v).toLowerCase().includes(t));
        if (present) best += w;
      }
      if (best === 0) {
        all = false;
        break;
      }
      score += best;
    }
    if (all && ts.length) hits.push({ id: e.id, kind: e.kind, title: e.title, path: e.path, line: e.line, checked: e.checked, score });
  }
  return hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
