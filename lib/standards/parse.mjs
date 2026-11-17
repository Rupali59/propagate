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
const KNOWN_FIELDS = new Set(["state", "source", "apply", "applies", "check", "fails when", "broadcast", "superseded by"]);
const ROW_LIKE = /^#{2,3}\s+[a-z][a-z0-9]*(-[a-z0-9]+)*-\d+\b/i;
const APPLIES_STD = /^std:([a-z][a-z0-9]*(?:-[a-z0-9]+)*)-(\d{3})$/;
const APPLIES_LOCAL = /^local-\d+$/;
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

function rowFrom(head, fields, line, problems, ctx) {
  for (const k of fields.keys()) {
    if (!k.startsWith("\0") && !KNOWN_FIELDS.has(k)) problems.push(`row ${head.id} (line ${line}): unknown field ${JSON.stringify(fields.get(`\0name:${k}`) ?? k)}`);
  }
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
    if (kind && CHECK_KINDS.includes(kind)) {
      check = { kind, target: m[2]?.trim() || null };
      if ((kind === "command" || kind === "test") && !check.target) problems.push(`row ${head.id}: check "${kind}" has no target`);
    }
    else problems.push(`row ${head.id} (line ${line}): unknown check kind ${JSON.stringify(m?.[1] ?? c.trim())}`);
  }

  // #290: `Applies:` is std:<id>-NNN (a row of an extended standard) or local-<n> (this project only).
  const applies = val("applies");
  if (applies !== null && !APPLIES_LOCAL.test(applies)) {
    const m = APPLIES_STD.exec(applies);
    if (!m) problems.push(`row ${head.id} (line ${line}): Applies ${JSON.stringify(applies)} is not std:<id>-NNN or local-<n>`);
    else if (!ctx.extends.includes(`std:${m[1]}`)) problems.push(`row ${head.id} (line ${line}): Applies ${applies} but the page does not extend std:${m[1]}`);
    else if (ctx.extendedRows?.[m[1]] && !ctx.extendedRows[m[1]].includes(`${m[1]}-${m[2]}`)) problems.push(`row ${head.id} (line ${line}): Applies ${applies} names no such row in std:${m[1]}`);
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
    applies,
    check,
    failsWhen: val("fails when"),
    broadcast: bc === "yes" || bc === "true",
    supersededBy: val("superseded by"),
    line,
  };
}

/**
 * `extendedRows` ({<std-id>: [row ids]}) lets a project page's `Applies:` be checked against the standard it
 * extends. Without it the existence of the named row is NOT checked (the caller has not said what exists).
 * @returns {{id,kind,authority,versionProbe,supersedes,extends:string[],rows:object[],problems:string[]}}
 */
export function parsePage(text, file = "", { extendedRows = null } = {}) {
  const problems = [];
  const { fm, body, bodyStartLine } = splitFrontmatter(String(text ?? "").replace(/^\uFEFF/, ""));
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

  const ext = [];
  for (const e of meta.extends == null ? [] : Array.isArray(meta.extends) ? meta.extends : [meta.extends]) {
    if (typeof e === "string" && /^std:[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(e)) ext.push(e);
    else problems.push(`${file || "page"}: frontmatter extends entry ${JSON.stringify(e)} is not std:<id>`);
  }
  const ctx = { extends: ext, extendedRows };
  const rows = [];
  let cur = null;
  const flush = () => {
    if (cur) rows.push(rowFrom(cur.head, cur.fields, cur.line, problems, ctx));
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
      if (ROW_LIKE.test(line)) problems.push(`line ${bodyStartLine + i}: heading "${line.replace(/^#+\s+/, "")}" looks like a row but is not "### <id> · <title>"`);
      flush();
      lastKey = null;
      continue;
    }
    const k = KEY_LINE.exec(line);
    if (!cur) {
      if (k) problems.push(`line ${bodyStartLine + i}: field "${k[1]}" outside any row`);
      continue;
    }
    if (k) {
      lastKey = k[1].toLowerCase();
      if (!cur.fields.has(lastKey)) {
        cur.fields.set(lastKey, k[2]);
        cur.fields.set(`\0name:${lastKey}`, k[1]);
      }
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
    extends: ext,
    rows,
    problems,
  };
}
