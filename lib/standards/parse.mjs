/**
 * lib/standards/parse.mjs — read one standards page into rows.
 *
 * A page is YAML frontmatter plus `### <id> · <title>` rows whose fields are
 * bold-key lines (the gotchas house style). Parsing never throws on content:
 * every defect lands in `problems`, so a reader can report the page as broken
 * instead of failing, or worse, reporting zero rows (rule:discernment-checks §6).
 *
 * A duplicate row id is a problem and BOTH rows are kept — last-wins would hide
 * one of them.
 */
import yaml from "yaml";

export const STATES = ["draft", "adopted", "retired"];
export const CHECK_KINDS = ["command", "test", "propagate", "gate", "review", "none"];

const ROW_HEAD = /^###\s+(\S+)\s+·\s+(.*\S)\s*$/;
const KEY_LINE = /^\*\*([A-Za-z][A-Za-z ]*):\*\*\s*(.*)$/;
const EMPTY = new Set(["", "—", "-", "none"]);

function splitFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { fm: null, body: text, bodyStartLine: 1 };
  const consumed = m[0].split("\n").length - 1;
  return { fm: m[1], body: text.slice(m[0].length), bodyStartLine: consumed + 1 };
}

function authorityOf(v, problems) {
  if (v == null) return [];
  if (!Array.isArray(v)) {
    problems.push("frontmatter authority must be a list");
    return [];
  }
  return v.map((a) => ({ name: a?.name ?? null, url: a?.url ?? null, scope: a?.scope ?? null }));
}

function rowFrom(head, fields, line, problems) {
  const get = (k) => fields.get(k) ?? null;
  const val = (k) => {
    const v = get(k);
    return v === null || EMPTY.has(v.trim()) ? null : v.trim();
  };
  const state = (val("state") ?? "").toLowerCase() || null;
  if (state === null) problems.push(`row ${head.id} (line ${line}): no State`);
  else if (!STATES.includes(state)) problems.push(`row ${head.id} (line ${line}): unknown state ${JSON.stringify(state)}`);

  let source = null;
  let version = null;
  let checked = null;
  const src = get("source");
  if (src !== null) {
    const parts = src.split(/\s+·\s+/);
    source = parts[0].trim() || null;
    for (const p of parts.slice(1)) {
      const m = /^\*\*(Version|Checked):\*\*\s*(.*)$/.exec(p.trim());
      if (m?.[1] === "Version") version = m[2].trim() || null;
      else if (m?.[1] === "Checked") checked = m[2].trim() || null;
    }
  }

  let check = { kind: "none", target: null };
  const c = get("check");
  if (c !== null && c.trim() !== "") {
    const m = /^([A-Za-z]+)\s*(?::\s*(.*))?$/.exec(c.trim());
    const kind = m?.[1]?.toLowerCase();
    if (kind && CHECK_KINDS.includes(kind)) check = { kind, target: m[2]?.trim() || null };
    else problems.push(`row ${head.id} (line ${line}): unknown check kind ${JSON.stringify(m?.[1] ?? c.trim())}`);
  }

  const bc = (val("broadcast") ?? "no").toLowerCase();
  return {
    id: head.id,
    title: head.title,
    state,
    source,
    version,
    checked,
    apply: val("apply"),
    check,
    failsWhen: val("fails when"),
    broadcast: bc === "yes" || bc === "true",
    supersededBy: val("superseded by"),
    line,
  };
}

/**
 * @returns {{id,kind,authority,versionProbe,supersedes,rows:object[],problems:string[]}}
 */
export function parsePage(text, file = "") {
  const problems = [];
  const { fm, body, bodyStartLine } = splitFrontmatter(String(text ?? ""));
  let meta = {};
  if (fm === null) problems.push(`${file || "page"}: no frontmatter (expected a leading --- block)`);
  else {
    try {
      meta = yaml.parse(fm) ?? {};
    } catch (err) {
      problems.push(`${file || "page"}: frontmatter unparseable: ${err.message}`);
    }
    if (meta === null || typeof meta !== "object" || Array.isArray(meta)) {
      problems.push(`${file || "page"}: frontmatter is not a mapping`);
      meta = {};
    }
  }

  const rows = [];
  let cur = null;
  const flush = () => {
    if (cur) rows.push(rowFrom(cur.head, cur.fields, cur.line, problems));
    cur = null;
  };
  let lastKey = null;
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "");
    const h = ROW_HEAD.exec(line);
    if (h) {
      flush();
      cur = { head: { id: h[1], title: h[2] }, fields: new Map(), line: bodyStartLine + i };
      lastKey = null;
      continue;
    }
    if (/^#{1,3}\s/.test(line)) {
      flush();
      lastKey = null;
      continue;
    }
    if (!cur) continue;
    const k = KEY_LINE.exec(line);
    if (k) {
      lastKey = k[1].toLowerCase();
      if (!cur.fields.has(lastKey)) cur.fields.set(lastKey, k[2]);
    } else if (lastKey && line.trim() !== "" && cur.fields.has(lastKey)) {
      cur.fields.set(lastKey, `${cur.fields.get(lastKey)} ${line.trim()}`);
    }
  }
  flush();

  const seen = new Map();
  for (const r of rows) {
    if (!seen.has(r.id)) seen.set(r.id, []);
    seen.get(r.id).push(r.line);
  }
  for (const [id, ls] of seen) if (ls.length > 1) problems.push(`duplicate row id ${id} (lines ${ls.join(", ")})`);

  return {
    id: meta.id ?? null,
    kind: meta.kind ?? null,
    authority: authorityOf(meta.authority, problems),
    versionProbe: meta.version_probe ?? null,
    supersedes: Array.isArray(meta.supersedes) ? meta.supersedes : [],
    rows,
    problems,
  };
}
