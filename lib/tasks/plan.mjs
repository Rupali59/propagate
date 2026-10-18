/**
 * plan.mjs — `propagate tasks export`'s planner (R1): READ-ONLY, writes nothing.
 *
 * WHAT IT ANSWERS. "If open register entries moved to GitHub issues, which issue would each
 * become, where would it go, and what stops it?" It builds that plan from the same population
 * `backlog()` reports and prints every reason it would not move something. It never creates an
 * issue, a label or a project item, and never touches a register: R2 adds `--apply`.
 *
 * THE ONLY EXTERNAL CALLS are `git rev-parse` / `git remote get-url` / `git config`-free reads
 * and `gh repo view OWNER/NAME --json visibility,hasIssuesEnabled,owner`. The test asserts the
 * gh log contains ONLY `repo view` (an allowlist, not a write blocklist: `gh api -f` is a POST).
 *
 * HELD, NEVER DROPPED. Every reason an entry would not move is reported with the entry: a plan
 * that quietly omitted what it could not move would read as a smaller backlog
 * (`rule:discernment-checks` §2). "Nothing to export" and "could not look" are different
 * outputs here too: a file with no open items says `none open (<format>)`, an unreadable repo
 * says `repo-unreadable`.
 *
 * ENTRY BOUNDARIES are fence-aware (G77): a heading quoted inside a fenced block does not end
 * an entry, so boundaries come from `scanStructure(text)` and never from a `^##` regexp.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { scanStructure } from "../docs/tokens.mjs";
import { backlog, extractPriority } from "../report/backlog.mjs";
import { FORBIDDEN } from "../core/public-forbidden.mjs";
import { normalizeMap, scrub, scrubEntries } from "../core/public-scrub.mjs";

/** GitHub rejects an issue body over 65,536 characters. */
export const BODY_LIMIT = 65536;
/** GitHub's secondary content-write limit, per hour. */
export const WRITES_PER_HOUR = 500;

/** Every reason an entry or a file is held, in one place so a renderer can list them. */
export const HELD_REASONS = Object.freeze([
  "duplicate-id",
  "staged",
  "issues-disabled",
  "other-owner",
  "unknown-status",
  "oversize",
  "no-remote",
  "forbidden",
  "delegated",
  "no-identity-map",
  "repo-unreadable",
]);

// ─────────────────────────────────────────────────────────────────────────────
// git / gh (read-only)
// ─────────────────────────────────────────────────────────────────────────────

function git(dir, args) {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", timeout: 15000 });
  if (r.error || r.status !== 0) return null;
  return r.stdout.trim();
}

/** `https://github.com/O/N(.git)`, `git@github.com:O/N.git`, `ssh://git@github.com/O/N` -> `O/N`. */
export function parseGithubRemote(url) {
  const m = /github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(String(url ?? "").trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

function ownerOf(repo) {
  return repo ? repo.split("/")[0].toLowerCase() : null;
}

/** The repo a directory is committed in. Cached by toplevel by the caller. */
function repoOfDir(dir) {
  const top = git(dir, ["rev-parse", "--show-toplevel"]);
  if (!top) return { top: null, reason: "not inside a git repository" };
  const origin = git(top, ["remote", "get-url", "origin"]);
  if (!origin) return { top, reason: "git repo has no origin remote" };
  const repo = parseGithubRemote(origin);
  if (!repo) return { top, reason: `origin is not a github.com remote: ${origin}` };
  return { top, repo, head: git(top, ["rev-parse", "HEAD"]) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Entries
// ─────────────────────────────────────────────────────────────────────────────

// Mirrors backlog.mjs's ID_HEADING_RE / ID_HEADING_LEADING_RE / ID_BULLET_RE, which are not
// exported. Used ONLY to count how many entries claim one id (the duplicate-id hold); the
// items themselves come from the parser. A drift here can only miss or over-report a
// duplicate, and tests/unit/tasks-plan.test.mjs pins the duplicate case.
const ID_HEADING_RE = /^(#{2,6})\s+.*\b([A-Z]{2,6}-\d{2,4})\b.*$/;
const ID_HEADING_LEADING_RE = /^(#{2,6})\s+([A-Z]{1,3}\d{1,4})\s*[·:—–-]\s+(.*)$/;
const ID_BULLET_RE = /^\s*-\s*(~~)?\s*\*\*([A-Z]{2,6}-\d{2,4})\*\*/;

function entryIdOf(line) {
  const h = line.match(ID_HEADING_RE) || line.match(ID_HEADING_LEADING_RE);
  if (h) return h[2];
  const b = line.match(ID_BULLET_RE);
  return b ? b[2] : null;
}

function idCounts(struct) {
  const counts = new Map();
  struct.lines.forEach((line, i) => {
    if (struct.fenced.has(i + 1)) return;
    const id = entryIdOf(line);
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  });
  return counts;
}

export function shortHash(text) {
  const norm = String(text).toLowerCase().replace(/[*_`~]/g, "").replace(/\s+/g, " ").trim();
  return createHash("sha256").update(norm).digest("hex").slice(0, 10);
}

/** Last 1-indexed line of the heading-delimited block starting at `line`. */
function headingBlockEnd(struct, line, depth) {
  const next = struct.headings.find((h) => h.line > line && h.depth <= depth);
  let end = next ? next.line - 1 : struct.lines.length;
  while (end > line && struct.lines[end - 1].trim() === "") end--;
  return end;
}

/** A bullet / checkbox item's continuation: following blank or more-indented lines. */
function listItemEnd(struct, line) {
  const indent = /^\s*/.exec(struct.lines[line - 1])[0].length;
  let end = line;
  for (let i = line; i < struct.lines.length; i++) {
    const l = struct.lines[i];
    if (l.trim() === "") continue;
    if (/^#{1,6}\s/.test(l) && !struct.fenced.has(i + 1)) break;
    if (/^\s*/.exec(l)[0].length <= indent) break;
    end = i + 1;
  }
  return end;
}

/** Slice an entry out: the block lines, split into the heading-or-first line and the rest. */
export function entryBlock(struct, item) {
  const first = struct.lines[item.line - 1];
  const hm = /^(#{1,6})\s/.exec(first);
  const end = hm ? headingBlockEnd(struct, item.line, hm[1].length) : listItemEnd(struct, item.line);
  return { first, rest: struct.lines.slice(item.line, end), startLine: item.line, endLine: end, isHeading: Boolean(hm) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Body rewriting
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Relative markdown links -> absolute github.com blob links at the HEAD sha, so a link in an
 * issue still resolves once the text has left the file it was relative to. Links that leave the
 * repo, point at an anchor, or already carry a scheme are left alone. Fenced lines are not
 * touched: a link inside a code block is an illustration, not a link.
 */
function rewriteLinks(lines, firstLineNo, fenced, { fileDir, top, repo, sha }) {
  return lines.map((line, i) => {
    if (fenced.has(firstLineNo + i)) return line;
    return line.replace(/\]\(([^)\s]+)\)/g, (whole, target) => {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#") || target.startsWith("/")) return whole;
      const [pathPart, ...anchor] = target.split("#");
      if (!pathPart) return whole;
      const abs = path.resolve(fileDir, pathPart);
      const rel = path.relative(top, abs);
      if (rel.startsWith("..") || path.isAbsolute(rel)) return whole;
      const frag = anchor.length ? "#" + anchor.join("#") : "";
      return `](https://github.com/${repo}/blob/${sha}/${rel.split(path.sep).join("/")}${frag})`;
    });
  });
}

function homeToTilde(text, home) {
  return home && home.length > 1 ? text.split(home).join("~") : text;
}

// ─────────────────────────────────────────────────────────────────────────────
// Identity map
// ─────────────────────────────────────────────────────────────────────────────

/** `{entries}` or `{error}`. Never exits: the caller owns the report, here as in make-public. */
function loadIdentity(stateDirPath) {
  const p = path.join(stateDirPath, "identity-map.json");
  if (!existsSync(p)) return { error: `no identity map at ${p}` };
  let names;
  try {
    ({ names } = normalizeMap(JSON.parse(readFileSync(p, "utf8"))));
  } catch (err) {
    return { error: `identity map unreadable: ${err.message}` };
  }
  const entries = scrubEntries(names);
  return entries.length ? { entries } : { error: `identity map at ${p} is empty — nothing would be scrubbed` };
}

function forbiddenHits(text) {
  const hits = [];
  for (const p of FORBIDDEN) {
    p.re.lastIndex = 0;
    if (p.re.test(text)) hits.push(p.label);
    p.re.lastIndex = 0;
  }
  return hits;
}

// ─────────────────────────────────────────────────────────────────────────────
// The plan
// ─────────────────────────────────────────────────────────────────────────────

/** `<ws>/propagation/state/<project>/...` -> project; otherwise the repo directory name. */
function projectOf(file, top) {
  const m = /[\\/]propagation[\\/]state[\\/]([^\\/]+)[\\/]/.exec(file);
  return m ? m[1] : path.basename(top);
}

function priorityLabel(text) {
  const p = extractPriority(text);
  return p === null ? null : `priority:P${p}`;
}

function severityLabel(text) {
  const m = /\bS([0-4])\b/.exec(text);
  return m ? `severity:S${m[1]}` : null;
}

/**
 * Collect register files as uniform records: { file, kind, format, delegatedTo?, proposed, items }
 * where each item is a candidate: { id, line, titleText, headText, status, depth? }.
 */
function collect(result) {
  const out = [];
  for (const f of result.todoFiles ?? []) out.push({ kind: "todo", rec: f });
  for (const f of result.issueFiles ?? []) out.push({ kind: "issue", rec: f });
  for (const f of result.handovers?.files ?? []) out.push({ kind: "handover", rec: f });
  return out;
}

function realOr(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function sameFile(a, b) {
  if (path.resolve(a) === path.resolve(b)) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/**
 * @param {object} o
 * @param {string|null} [o.file]           plan this one register only
 * @param {boolean} [o.all]                plan every discovered register
 * @param {object} [o.backlogResult]       an existing backlog() result (tests, callers that have one)
 * @param {string[]} [o.searchRoots]
 * @param {string} [o.gh]                  gh binary; default $PROPAGATE_GH_BIN, else "gh"
 * @param {string|null} [o.hubRoot]        the hub repo whose origin owner defines "ours"
 * @param {string} o.stateDirPath          where identity-map.json lives
 * @param {string} [o.home]                the home dir rewritten to `~`
 * @param {string} [o.today]               YYYY-MM-DD for the footer
 * @param {Record<string,string>} [o.routes] explicit `OWNER/NAME -> OWNER/NAME` target overrides
 *                                         (config.yml `tasks.routes`). Never inferred.
 */
export function planExport({
  file = null,
  all = false,
  backlogResult = null,
  searchRoots,
  gh = process.env.PROPAGATE_GH_BIN || "gh",
  hubRoot = null,
  stateDirPath,
  home = os.homedir(),
  today = new Date().toISOString().slice(0, 10),
  routes = {},
} = {}) {
  const result = backlogResult ?? backlog(searchRoots ? { searchRoots } : undefined);
  let regs = collect(result);
  if (file) {
    regs = regs.filter((r) => sameFile(r.rec.file, file));
    if (!regs.length) {
      return { ok: false, error: `${file} is not a register propagate discovered (STATE.md bullets are not exported either)` };
    }
  } else if (!all) {
    return { ok: false, error: "name a population: --file <path> or --all" };
  }

  const hubRepo = hubRoot ? repoOfDir(realOr(hubRoot)).repo ?? null : null;
  const hubOwner = ownerOf(hubRepo);

  const dirCache = new Map();
  const repoOfFileDir = (dir) => {
    if (!dirCache.has(dir)) dirCache.set(dir, repoOfDir(dir));
    return dirCache.get(dir);
  };
  const ghCache = new Map();
  const ghRepoView = (repo) => {
    if (ghCache.has(repo)) return ghCache.get(repo);
    const r = spawnSync(gh, ["repo", "view", repo, "--json", "visibility,hasIssuesEnabled,owner"], { encoding: "utf8", timeout: 30000 });
    let info;
    if (r.error) info = { error: `${gh}: ${r.error.code || r.error.message}` };
    else if (r.status !== 0) info = { error: `gh exited ${r.status}: ${(r.stderr || r.stdout || "").trim().split("\n")[0]}` };
    else {
      try {
        const j = JSON.parse(r.stdout);
        const vis = typeof j.visibility === "string" ? j.visibility.toUpperCase() : null;
        if (!vis || typeof j.hasIssuesEnabled !== "boolean") info = { error: "gh repo view output lacked visibility/hasIssuesEnabled" };
        else info = { visibility: vis, isPublic: vis === "PUBLIC", hasIssuesEnabled: j.hasIssuesEnabled, owner: (j.owner && (j.owner.login ?? j.owner)) || null };
      } catch {
        info = { error: "gh repo view output was not JSON" };
      }
    }
    ghCache.set(repo, info);
    return info;
  };

  let identity; // loaded lazily: only a public target needs it
  const getIdentity = () => (identity ??= loadIdentity(stateDirPath));

  const routeMap = normalizeRoutes(routes);
  const files = regs.map(({ kind, rec }) => planFile({ kind, rec, repoOfFileDir, ghRepoView, getIdentity, hubOwner, home, today, routeMap }));

  // ── summary, per target repo ──
  const byRepo = new Map();
  for (const f of files) {
    const key = f.target?.repo ?? "(no target)";
    const s = byRepo.get(key) ?? { repo: key, items: 0, held: 0, planned: 0, labels: new Set(), notes: new Set() };
    for (const it of f.items) {
      s.items++;
      if (f.held.length || it.held.length) s.held++;
      else {
        s.planned++;
        for (const l of it.labels) s.labels.add(l);
      }
    }
    if (f.fallback) s.notes.add(`fallback target ${f.fallback.repo} (${f.fallback.reason})`);
    for (const n of f.notes ?? []) s.notes.add(n);
    byRepo.set(key, s);
  }
  const repos = [...byRepo.values()]
    .filter((r) => r.items > 0) // a file with nothing to move targets nothing; listing it would be noise
    .map((s) => ({
    repo: s.repo,
    items: s.items,
    held: s.held,
    planned: s.planned,
    labels: s.labels.size,
    // Upper bound: R1 does not list existing labels, so every distinct label is counted as a create.
    estimatedWrites: s.planned * 2 + s.labels.size,
    notes: [...s.notes],
  }));
  const totalWrites = repos.reduce((n, r) => n + r.estimatedWrites, 0);

  return {
    ok: true,
    mode: "dry-run",
    hubOwner,
    files,
    summary: {
      repos,
      totalItems: repos.reduce((n, r) => n + r.items, 0),
      totalHeld: repos.reduce((n, r) => n + r.held, 0),
      totalPlanned: repos.reduce((n, r) => n + r.planned, 0),
      totalEstimatedWrites: totalWrites,
      writesPerHour: WRITES_PER_HOUR,
      runsNeeded: Math.max(1, Math.ceil(totalWrites / WRITES_PER_HOUR)),
    },
  };
}

/**
 * `{ "Owner/Name": "Owner/Name" }` -> Map keyed by the lower-cased source (GitHub names are
 * case-insensitive). Anything that is not a well-formed pair is dropped here; the CLI refuses
 * a malformed table loudly BEFORE planning (`validateRoutes`), so a drop is only reachable by
 * a direct caller.
 */
function normalizeRoutes(routes) {
  const m = new Map();
  for (const [from, to] of Object.entries(routes ?? {})) {
    if (REPO_RE.test(from) && typeof to === "string" && REPO_RE.test(to)) m.set(from.toLowerCase(), to);
  }
  return m;
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Returns an error string for a malformed `tasks.routes` table, else null. */
export function validateRoutes(routes) {
  if (routes === undefined || routes === null) return null;
  if (typeof routes !== "object" || Array.isArray(routes)) return "tasks.routes must be a mapping of OWNER/NAME to OWNER/NAME";
  for (const [from, to] of Object.entries(routes)) {
    if (!REPO_RE.test(from) || typeof to !== "string" || !REPO_RE.test(to)) {
      return `tasks.routes entry ${JSON.stringify(from)}: ${JSON.stringify(to)} — both sides must be OWNER/NAME`;
    }
  }
  return null;
}

function planFile({ kind, rec, repoOfFileDir, ghRepoView, getIdentity, hubOwner, home, today, routeMap }) {
  const file = rec.file;
  const out = {
    file,
    kind,
    format: kind === "handover" ? "handover" : rec.format,
    project: null,
    repoRel: null,
    target: null,
    fallback: null,
    held: [], // file-level: { reason, detail }
    notes: [],
    textHash: null,
    skipped: {},
    items: [],
  };

  // delegated: already moved; show where, skip.
  if (rec.format === "delegated") {
    out.held.push({ reason: "delegated", detail: `already delegated to ${rec.delegatedTo}` });
    return out;
  }

  const candidates = candidatesOf(kind, rec, out);
  if (!candidates.length) {
    out.note = rec.format === "unreadable" || rec.format === "unrecognised" ? `could not read entries (${rec.format})` : `none open (${out.format})`;
    return out;
  }

  // ── target repo ──
  // git reports the REAL toplevel (macOS /var -> /private/var), so every relative path is taken
  // from the real file path; relative-to-a-symlinked path is `../../..` garbage.
  const realFile = realOr(file);
  const loc = repoOfFileDir(path.dirname(realFile));
  if (!loc.repo) {
    out.held.push({ reason: "no-remote", detail: loc.reason });
  } else {
    out.project = projectOf(realFile, loc.top);
    out.repoRel = path.relative(loc.top, realFile).split(path.sep).join("/");
    const routedTo = routeMap.get(loc.repo.toLowerCase()) ?? null;
    if (routedTo) {
      // An explicit table entry (config.yml tasks.routes), never a guess. The routed repo's own
      // state still counts: unreadable or Issues-off there is held. other-owner is NOT held:
      // routing to a repo of yours is the consent that check exists to ask for.
      const info = ghRepoView(routedTo);
      out.target = { repo: routedTo, routedFrom: loc.repo, head: loc.head, ...info };
      out.notes.push(`routed from ${loc.repo}`);
      if (info.error) out.held.push({ reason: "repo-unreadable", detail: info.error });
      else if (!info.hasIssuesEnabled) out.held.push({ reason: "issues-disabled", detail: `routed target ${routedTo} has Issues disabled` });
    } else {
      const info = ghRepoView(loc.repo);
      out.target = { repo: loc.repo, head: loc.head, ...info };
      if (info.error) out.held.push({ reason: "repo-unreadable", detail: info.error });
      else {
        if (!info.hasIssuesEnabled) {
          out.held.push({ reason: "issues-disabled", detail: `${loc.repo} has Issues disabled` });
          const up = repoOfFileDir(path.dirname(loc.top));
          if (up.repo && up.top !== loc.top) {
            out.fallback = { repo: up.repo, reason: `enclosing workspace repo above ${path.basename(loc.top)}` };
          } else {
            out.fallback = null;
          }
        }
        const owner = (info.owner ?? ownerOf(loc.repo) ?? "").toLowerCase();
        if (hubOwner && owner && owner !== hubOwner) {
          out.held.push({ reason: "other-owner", detail: `${loc.repo} is owned by ${owner}, not ${hubOwner}` });
        }
      }
    }
  }
  if (!out.project) out.project = path.basename(path.dirname(file));
  if (rec.proposed > 0) {
    out.held.push({ reason: "staged", detail: `${rec.proposed} proposed item(s) under a staging heading need triage first` });
  }

  const isPublic = Boolean(out.target?.isPublic);
  let idMap = null;
  if (isPublic) {
    idMap = getIdentity();
    if (idMap.error) out.held.push({ reason: "no-identity-map", detail: idMap.error });
  }

  // ── items ──
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    out.held.push({ reason: "repo-unreadable", detail: `register unreadable: ${err.message}` });
    return out;
  }
  out.textHash = createHash("sha256").update(text).digest("hex");
  const struct = scanStructure(text);
  const counts = idCounts(struct);
  const ctx = {
    fileDir: path.dirname(realFile),
    top: loc.top,
    repo: loc.repo,
    sha: loc.head || "HEAD",
  };

  for (const c of candidates) {
    const item = { id: c.id, line: c.line, title: c.title, key: null, labels: [], bodyLength: 0, body: null, held: [], scrub: null };
    out.items.push(item);

    if (c.unknownStatus) {
      item.held.push({ reason: "unknown-status", detail: "handover section has neither **Done when:** nor **Resolved:**" });
    }
    if (c.kind === "id-keyed" && (counts.get(c.id) ?? 0) > 1) {
      item.held.push({ reason: "duplicate-id", detail: `${c.id} heads ${counts.get(c.id)} entries in this file (open and closed)` });
    }

    if (c.kind === "checkbox" && candidates.filter((x) => x.id === c.id).length > 1) {
      item.held.push({ reason: "duplicate-id", detail: `two open checkbox items normalise to the same text hash ${c.id}` });
    }

    // labels
    const labels = ["task", `kind:${kind}`, `project:${out.project}`];
    const pl = priorityLabel(c.headText);
    if (pl) labels.push(pl);
    if (kind === "issue") {
      const sl = severityLabel(c.headText) || severityLabel(c.body.slice(0, 600));
      if (sl) labels.push(sl);
    }
    if (/\*\*Status:?\*\*:?\s*upstream/i.test(c.bodyText)) labels.push("upstream");
    item.labels = labels;

    // body
    if (!out.repoRel || !loc.repo) {
      item.bodyLength = c.bodyText.length;
      continue; // no target: nothing to rewrite links against; held at file level
    }
    const rewritten = rewriteLinks(c.body, c.bodyStartLine, struct.fenced, ctx).join("\n");
    // A routed file's key carries its ORIGIN repo: two origins can share a relative path
    // (`TODOS.md`) and land in one target repo, and a key two entries share makes the second
    // look already moved.
    const footerKey = `${out.target?.routedFrom ? `${out.target.routedFrom}:` : ""}${out.repoRel}#${c.id}`;
    let title = c.title;
    let body =
      homeToTilde(rewritten, home).replace(/\s+$/, "") +
      `\n\n---\n_Moved ${today} from \`${out.repoRel}\` entry ${c.id}; the register keeps a pointer line._\n` +
      `<!-- propagate-task key=${footerKey} -->`;
    title = homeToTilde(title, home);

    if (isPublic && idMap && !idMap.error) {
      const sTitle = scrub(title, idMap.entries);
      const sBody = scrub(body, idMap.entries);
      const sLabels = labels.map((l) => scrub(homeToTilde(l, home), idMap.entries));
      const diff = {};
      if (sTitle !== title) diff.title = { before: title, after: sTitle };
      if (sBody !== body) {
        const a = body.split("\n"), b = sBody.split("\n");
        diff.body = { changedLines: 0, samples: [] };
        for (let i = 0; i < Math.max(a.length, b.length); i++) {
          if (a[i] !== b[i]) {
            diff.body.changedLines++;
            if (diff.body.samples.length < 3) diff.body.samples.push({ line: i + 1, before: a[i], after: b[i] });
          }
        }
      }
      const lc = labels.map((l, i) => (sLabels[i] !== l ? { before: l, after: sLabels[i] } : null)).filter(Boolean);
      if (lc.length) diff.labels = lc;
      item.scrub = diff;
      title = sTitle;
      body = sBody;
      item.labels = sLabels;
      const hits = forbiddenHits([title, body, ...sLabels].join("\n"));
      if (hits.length) item.held.push({ reason: "forbidden", detail: `still matches after scrub: ${hits.join(", ")}` });
    }

    item.title = title;
    item.body = body;
    item.bodyLength = body.length;
    const km = /<!-- propagate-task key=(.+?) -->/.exec(body);
    item.key = km ? km[1] : footerKey;
    if (body.length > BODY_LIMIT) {
      item.held.push({ reason: "oversize", detail: `body is ${body.length} chars, GitHub's limit is ${BODY_LIMIT}` });
    }
  }
  // The key is meaningful even when the file is held at file level.
  for (const it of out.items) if (!it.key && out.repoRel) it.key = `${out.target?.routedFrom ? `${out.target.routedFrom}:` : ""}${out.repoRel}#${it.id}`;
  return out;
}

/** Normalise the three register shapes into candidate entries. Fills `out.skipped`. */
function candidatesOf(kind, rec, out) {
  const file = rec.file;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const struct = scanStructure(text);
  const cands = [];

  if (kind === "handover") {
    const seen = new Map();
    for (const s of rec.sections ?? []) {
      const n = (seen.get(s.date) ?? 0) + 1;
      seen.set(s.date, n);
      if (s.status !== "open" && s.status !== "unknown") {
        out.skipped[s.status] = (out.skipped[s.status] ?? 0) + 1;
        continue;
      }
      // Sequence within the date, NOT the heading's own ordinal: three sections of one real file
      // share `2`, and a key that two entries share would make the second one look already moved.
      const ord = n;
      const hm = /^(#{1,6})\s/.exec(struct.lines[s.line - 1] ?? "");
      const end = headingBlockEnd(struct, s.line, hm ? hm[1].length : 2);
      const body = struct.lines.slice(s.line, end);
      cands.push({
        kind: "handover",
        id: `${s.date ?? "undated"}-${ord}`,
        line: s.line,
        title: s.title || `handover ${s.date}`,
        headText: s.title || "",
        body,
        bodyStartLine: s.line + 1,
        bodyText: body.join("\n"),
        unknownStatus: s.status === "unknown",
      });
    }
    return cands;
  }

  for (const it of rec.items ?? []) {
    // The backlog parser is line-based and reads a heading QUOTED inside a fence as an item. A
    // fenced line is an illustration (G77); exporting it would create an issue for text that
    // is not an entry and cut a block out of the middle of a code sample.
    if (struct.fenced.has(it.line)) {
      out.skipped.fenced = (out.skipped.fenced ?? 0) + 1;
      continue;
    }
    const block = entryBlock(struct, it);
    const body = block.rest;
    const common = { line: it.line, body, bodyStartLine: block.startLine + 1, bodyText: body.join("\n"), headText: it.text };
    if (it.format === "id-keyed") {
      const id = it.id;
      cands.push({ ...common, kind: "id-keyed", id, title: it.text.replace(/\*\*/g, "").trim() });
    } else {
      // Checkbox: the item text IS the title; the key is a short hash of it.
      cands.push({ ...common, kind: "checkbox", id: shortHash(it.text), title: it.text.replace(/\*\*/g, "").trim() });
    }
  }
  return cands;
}
