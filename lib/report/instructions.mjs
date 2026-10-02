/**
 * instructions.mjs — the per-session instruction budget, modelled from what Claude Code
 * loads at session start.
 *
 * WHY. The harness prints a warning when a session's always-loaded memory is large, and the
 * number is per CWD, not per repo. Measured 2026-10-02: 57 of 57 directories that own a
 * CLAUDE.md put a session over 150k, worst ~228k. Nothing in this tree measured it; it was
 * found from the warning. This is the measurement, so the next regression is found by
 * `doctor` instead of by a session.
 *
 * WHAT IS MODELLED (T1 evidence, 2026-10-02, plan budget-1-rules-headroom §"T1 result": the
 * predicted Tathya total equalled the harness warning exactly, and the InstructionsLoaded log
 * was set-equal to the predicted file set):
 *
 *   - `~/.claude/CLAUDE.md`, and every `.md` under `~/.claude/rules` RECURSIVELY, except
 *     those matched by `claudeMdExcludes` and those with `paths:` frontmatter (loaded only
 *     on a main-session Read of a matching file, so not part of the session-start total);
 *   - for the cwd and every ancestor: `CLAUDE.md`, `CLAUDE.local.md`, `.claude/CLAUDE.md`,
 *     and `.claude/rules/**.md` without `paths:`;
 *   - `@import`s, recursively (max {@link MAX_IMPORT_DEPTH} hops), relative to the importing
 *     file;
 *   - chars = JS string length of the frontmatter-stripped, block-comment-stripped body.
 *
 * NOT IN THE TOTAL (measured): MEMORY.md. Not modelled: AGENTS.md (the harness reads
 * CLAUDE.md; AGENTS.md counts only when imported), subdirectory CLAUDE.md files (they load on
 * first Read inside them, `load_reason: nested_traversal`), managed-policy rules.
 *
 * UNVERIFIED, stated rather than closed over: whether ANCESTOR `.claude/rules` count at session
 * start (T1 had none to test); whether `claudeMdExcludes` applies to imported files (modelled as
 * no); the import hop limit (docs say five). `propagate instructions --calibrate` is the
 * instrument that settles these, by SET comparison against a real InstructionsLoaded log.
 *
 * "150,000" is the threshold the harness warning was OBSERVED to use, not a documented
 * constant. The gate is {@link DEFAULT_LIMIT} (145,000), 5k under it.
 *
 * Pure: every function takes its inputs (home, roots, settings paths) as arguments; reads
 * files, writes nothing, prints nothing.
 */

import { readdirSync, readFileSync, statSync, realpathSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { parse as parseYaml } from "yaml";

import { globToRegExp } from "../rules/paths-guard.mjs";
import { findCandidateFiles, stripFrontmatter } from "../rules/rules-check.mjs";

/** The gate: 5k under the observed harness warning threshold. */
export const DEFAULT_LIMIT = 145_000;
/** What the harness warning was observed to fire at (2026-10-02). Not a documented constant. */
export const HARNESS_OBSERVED = 150_000;
/** Documented import depth ("five hops"). Plan text said 4; no chain in the tree is deeper than 1. */
export const MAX_IMPORT_DEPTH = 5;
/** Fewer owning directories than this means the scan went blind, not that the tree is small. */
export const MIN_DIRS = 20;
/** Depth findCandidateFiles walks to, printed so a 56-vs-57 drift is attributable. */
export const SCAN_MAX_DEPTH = 6;

const MANAGED_DIR_DARWIN = "/Library/Application Support/ClaudeCode";

const posix = (p) => p.split(path.sep).join("/");

// ── text model ───────────────────────────────────────────────────────────────

/**
 * Remove block-level HTML comments (a comment that begins a line), outside fenced code.
 * Inline comments, and comments inside fences, are kept — that is what the docs say the
 * harness does, and over-stripping would understate the total.
 */
export function stripBlockComments(text) {
  const lines = text.split("\n");
  const out = [];
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = /^\s*(```+|~~~+)/.exec(line);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      out.push(line);
      continue;
    }
    if (!fence && /^\s*<!--/.test(line)) {
      // consume through the line that closes it
      let j = i;
      let closed = line.includes("-->", line.indexOf("<!--") + 4);
      while (!closed && j + 1 < lines.length) {
        j++;
        closed = lines[j].includes("-->");
      }
      const tail = lines[j].slice(lines[j].indexOf("-->", j === i ? line.indexOf("<!--") + 4 : 0) + 3);
      if (closed && tail.trim() === "") {
        i = j;
        continue; // whole comment dropped, including its newline
      }
    }
    out.push(line);
  }
  return out.join("\n");
}

/**
 * `@path` import tokens in a file's text. Skips fenced blocks and inline code spans, requires
 * the `@` to start a whitespace-delimited word (so `"@x"`, `a@b.com` are not imports), honours
 * `\ ` escaped spaces, and returns raw tokens — whether one is a real import is decided by
 * whether it resolves to a file (so `@scope/pkg` mentions are ignored, not flagged).
 */
export function extractImports(text) {
  const tokens = [];
  let fence = null;
  for (const rawLine of text.split("\n")) {
    const f = /^\s*(```+|~~~+)/.exec(rawLine);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const line = rawLine.replace(/(`+)[^`]*?\1/g, " ");
    const re = /(?:^|\s)@((?:\\ |[^\s])+)/g;
    let m;
    while ((m = re.exec(line))) tokens.push(m[1].replace(/\\ /g, " "));
  }
  return tokens;
}

/** `{scoped, yamlFailed}` — a rule whose YAML cannot be parsed counts as always-loaded. */
export function ruleScope(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!m) return { scoped: false, yamlFailed: false };
  let meta;
  try {
    meta = parseYaml(m[1]);
  } catch {
    return { scoped: false, yamlFailed: true };
  }
  const p = meta && typeof meta === "object" ? meta.paths : undefined;
  const scoped = Array.isArray(p) ? p.length > 0 : typeof p === "string" && p.trim() !== "";
  return { scoped, yamlFailed: false };
}

// ── model ────────────────────────────────────────────────────────────────────

function realOrSelf(p) {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Every `.md` under `dir`, following symlinks, cycle-safe. Returns `[]` when absent. */
function walkMarkdown(dir) {
  const out = [];
  const seen = new Set();
  const rec = (d) => {
    const real = realOrSelf(d);
    if (seen.has(real)) return;
    seen.add(real);
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of entries) {
      const p = path.join(d, e.name);
      let st;
      try {
        st = statSync(p); // follows symlinks, which Dirent.isFile() does not
      } catch {
        continue;
      }
      if (st.isDirectory()) rec(p);
      else if (st.isFile() && e.name.endsWith(".md")) out.push(p);
    }
  };
  rec(dir);
  return out;
}

function readJson(p) {
  if (!existsSync(p)) return { present: false, json: null };
  try {
    return { present: true, json: JSON.parse(readFileSync(p, "utf8")) };
  } catch (err) {
    return { present: true, json: null, error: err.message };
  }
}

/**
 * Build a model of what a session in a given directory loads.
 *
 * @param {{home?: string, settings?: {files?: string[]}, managedDir?: string|null}} [opts]
 *   `settings.files` replaces the default user + managed settings layer list (tests, other
 *   machines); project-layer settings (`<ancestor>/.claude/settings{,.local}.json`) are always
 *   derived per directory.
 */
export function createBudgetModel({ home = os.homedir(), settings = {}, managedDir } = {}) {
  const userClaudeDir = path.join(home, ".claude");
  const managed = managedDir === undefined ? (process.platform === "darwin" ? MANAGED_DIR_DARWIN : null) : managedDir;
  const baseSettingsFiles =
    settings.files ?? [path.join(userClaudeDir, "settings.json"), ...(managed ? [path.join(managed, "managed-settings.json")] : [])];

  const infoCache = new Map();
  /** Per-file facts, read once: chars, import tokens, scope. */
  const info = (abs) => {
    let v = infoCache.get(abs);
    if (v) return v;
    let raw = null;
    let error = null;
    try {
      raw = readFileSync(abs, "utf8");
    } catch (err) {
      error = err.message;
    }
    if (raw === null) {
      v = { abs, real: realOrSelf(abs), error, chars: 0, imports: [], scoped: false, yamlFailed: false };
    } else {
      const body = stripBlockComments(stripFrontmatter(raw));
      v = { abs, real: realOrSelf(abs), error: null, chars: body.length, imports: extractImports(body), ...ruleScope(raw) };
    }
    infoCache.set(abs, v);
    return v;
  };

  const settingsCache = new Map();
  const settingsAt = (p) => {
    if (!settingsCache.has(p)) settingsCache.set(p, readJson(p));
    return settingsCache.get(p);
  };

  /** Merged `claudeMdExcludes` for a directory: base layers + every ancestor's project layers. */
  const excludesFor = (dir) => {
    const files = [...baseSettingsFiles];
    for (const a of ancestors(dir)) {
      files.push(path.join(a, ".claude", "settings.json"), path.join(a, ".claude", "settings.local.json"));
    }
    const patterns = [];
    const layers = [];
    for (const f of [...new Set(files)]) {
      const s = settingsAt(f);
      const ex = s.json?.claudeMdExcludes;
      layers.push({ path: f, present: s.present, error: s.error ?? null, excludes: Array.isArray(ex) ? ex.length : 0 });
      if (Array.isArray(ex)) {
        for (const g of ex) if (typeof g === "string") patterns.push(g);
      }
    }
    const regs = patterns.map((g) => {
      let a = g;
      if (a.startsWith("~/")) a = path.join(home, a.slice(2));
      else if (!a.startsWith("/")) a = "**/" + a.replace(/^\.?\//, "");
      return globToRegExp(posix(a));
    });
    return { layers, test: (p) => regs.some((r) => r.test(posix(p)) || r.test(posix(realOrSelf(p)))) };
  };

  let userRulesCache = null;
  const userRules = () => (userRulesCache ??= walkMarkdown(path.join(userClaudeDir, "rules")));
  const projectRulesCache = new Map();
  const projectRules = (dir) => {
    if (!projectRulesCache.has(dir)) projectRulesCache.set(dir, walkMarkdown(path.join(dir, ".claude", "rules")));
    return projectRulesCache.get(dir);
  };

  /**
   * Everything a session started in `dir` loads.
   * @returns {{dir: string, files: Array<{file: string, chars: number, kind: string}>, total: number,
   *   excluded: Array<{file: string, chars: number}>, excluded_chars: number, notes: string[], settings: object[]}}
   */
  function loadSet(dir) {
    const files = [];
    const excluded = [];
    const notes = [];
    const visited = new Set();
    const ex = excludesFor(dir);

    const take = (abs, kind, depth, { excludable }) => {
      if (!isFile(abs)) return; // an absent candidate (no CLAUDE.local.md here) is not a finding
      const fi = info(abs);
      if (visited.has(fi.real)) return;
      if (fi.error) {
        notes.push(`unreadable ${abs}: ${fi.error}`);
        return;
      }
      if (excludable && ex.test(abs)) {
        visited.add(fi.real);
        excluded.push({ file: abs, chars: fi.chars });
        return;
      }
      if ((kind === "rule" || kind === "project-rule") && fi.scoped) return; // loads on Read, not at start
      visited.add(fi.real);
      if (fi.yamlFailed) notes.push(`rule frontmatter does not parse, counted as always-loaded: ${abs}`);
      files.push({ file: abs, chars: fi.chars, kind: depth === 0 ? kind : "import" });
      if (depth >= MAX_IMPORT_DEPTH) {
        if (fi.imports.length) notes.push(`import depth ${MAX_IMPORT_DEPTH} reached in ${abs}; deeper imports not followed`);
        return;
      }
      for (const tok of fi.imports) {
        let target;
        if (tok.startsWith("~/")) target = path.join(home, tok.slice(2));
        else if (path.isAbsolute(tok)) target = tok;
        else target = path.resolve(path.dirname(abs), tok);
        if (!isFile(target)) {
          // trailing sentence punctuation is the usual reason a real import fails to resolve
          const trimmed = target.replace(/[.,;:!?)\]}'"]+$/, "");
          if (trimmed !== target && isFile(trimmed)) target = trimmed;
          else {
            // `@scope/pkg` and `@someone` are mentions, not imports: ignored silently.
            // Only a token that LOOKS like a path (relative marker or an extension) is a missing import.
            if (/^(\.{1,2}\/|~\/|\/)/.test(tok) || /\.[A-Za-z0-9]{1,8}$/.test(tok)) {
              notes.push(`import not found: @${tok} (from ${abs})`);
            }
            continue;
          }
        }
        take(target, "import", depth + 1, { excludable: false });
      }
    };

    if (managed) {
      const m = path.join(managed, "CLAUDE.md");
      if (isFile(m)) take(m, "managed", 0, { excludable: false });
    }
    take(path.join(userClaudeDir, "CLAUDE.md"), "user", 0, { excludable: true });
    for (const r of userRules()) take(r, "rule", 0, { excludable: true });

    for (const a of ancestors(dir)) {
      take(path.join(a, "CLAUDE.md"), "claude-md", 0, { excludable: true });
      take(path.join(a, "CLAUDE.local.md"), "claude-local", 0, { excludable: true });
      take(path.join(a, ".claude", "CLAUDE.md"), "claude-md", 0, { excludable: true });
      for (const r of projectRules(a)) take(r, "project-rule", 0, { excludable: true });
    }

    const total = files.reduce((s, f) => s + f.chars, 0);
    return {
      dir,
      files,
      total,
      excluded,
      excluded_chars: excluded.reduce((s, f) => s + f.chars, 0),
      notes,
      settings: ex.layers,
    };
  }

  return {
    home,
    loadSet,
    describeInputs() {
      const userMd = path.join(userClaudeDir, "CLAUDE.md");
      const rules = userRules().map(info);
      return {
        home,
        userClaudeMd: { path: userMd, present: isFile(userMd) },
        rulesDir: {
          path: path.join(userClaudeDir, "rules"),
          present: existsSync(path.join(userClaudeDir, "rules")),
          files: rules.length,
          path_scoped: rules.filter((r) => r.scoped).length,
          yaml_failed: rules.filter((r) => r.yamlFailed).length,
        },
        settings: baseSettingsFiles.map((p) => {
          const s = settingsAt(p);
          return { path: p, present: s.present, error: s.error ?? null, excludes: Array.isArray(s.json?.claudeMdExcludes) ? s.json.claudeMdExcludes.length : 0 };
        }),
      };
    },
  };
}

/** `dir` and every parent up to the filesystem root. */
function ancestors(dir) {
  const out = [];
  let d = path.resolve(dir);
  for (;;) {
    out.push(d);
    const p = path.dirname(d);
    if (p === d) break;
    d = p;
  }
  return out;
}

/**
 * The population (D8): every directory that owns a CLAUDE.md, derived from the same walk
 * `rules check` uses. A `<dir>/.claude/CLAUDE.md` is attributed to `<dir>`.
 */
export function owningDirs(roots, { maxDepth = SCAN_MAX_DEPTH } = {}) {
  const found = findCandidateFiles(roots, { maxDepth });
  const dirs = new Set();
  for (const f of found.files) {
    let d = path.dirname(f);
    if (path.basename(d) === ".claude") d = path.dirname(d);
    dirs.add(d);
  }
  return { dirs: [...dirs].sort(), missing: found.missing, excludedWorktrees: found.excludedWorktrees };
}

/**
 * The budget for every directory owning a CLAUDE.md.
 *
 * @param {object} opts
 * @param {string} [opts.home]
 * @param {string[]} [opts.roots]      search roots for the walk
 * @param {string[]} [opts.dirs]       explicit population (bypasses the walk)
 * @param {{files?: string[]}} [opts.settings]
 * @param {string|null} [opts.managedDir]
 * @param {number} [opts.limit]
 * @param {number} [opts.minDirs]      the blind floor
 * @returns {object} see the field comments below
 */
export function instructionBudget({
  home = os.homedir(),
  roots = [],
  dirs,
  settings,
  managedDir,
  limit = DEFAULT_LIMIT,
  minDirs = MIN_DIRS,
  model,
} = {}) {
  const m = model ?? createBudgetModel({ home, settings, managedDir });
  let population = dirs;
  let missing = [];
  let excludedWorktrees = 0;
  if (!population) {
    const o = owningDirs(roots);
    population = o.dirs;
    missing = o.missing;
    excludedWorktrees = o.excludedWorktrees;
  }
  const inputs = m.describeInputs();
  const scan = {
    roots,
    missing,
    dirs: population.length,
    maxDepth: SCAN_MAX_DEPTH,
    excludedWorktrees,
    limits:
      `walk: CLAUDE.md only, depth ${SCAN_MAX_DEPTH}, skips node_modules/.git/.next/dist/build/.turbo/.vercel/Library/Trash, ` +
      `worktrees excluded (${excludedWorktrees} CLAUDE.md seen under them); a .claude/CLAUDE.md is attributed to its parent`,
  };

  const base = { limit, harness_observed: HARNESS_OBSERVED, unit: "chars", inputs, scan, notes: [] };

  let status = "ok";
  let reason = "";
  if (!population.length || population.length < minDirs) {
    status = missing.length && !population.length ? "roots-missing" : "blind";
    reason =
      `only ${population.length} director${population.length === 1 ? "y" : "ies"} owning a CLAUDE.md found (floor ${minDirs})` +
      (missing.length ? `; missing roots: ${missing.join(", ")}` : "") +
      " — the scan has gone blind, it has not found nothing";
  }
  if (!inputs.userClaudeMd.present) base.notes.push(`${inputs.userClaudeMd.path} not found — user-level memory is NOT in these totals`);
  if (!inputs.rulesDir.present) base.notes.push(`${inputs.rulesDir.path} not found — no user rules in these totals`);
  const userSettings = inputs.settings[0];
  if (userSettings && !userSettings.present) {
    base.notes.push(`${userSettings.path} not found — claudeMdExcludes NOT applied, totals may be overstated`);
  }
  for (const s of inputs.settings) if (s.error) base.notes.push(`${s.path} is not readable JSON (${s.error}) — its claudeMdExcludes were NOT applied`);

  const rows = population.map((dir) => {
    const ls = m.loadSet(dir);
    const biggest = ls.files.reduce((b, f) => (f.chars > (b?.chars ?? -1) ? f : b), null);
    return {
      dir,
      total: ls.total,
      over_by: Math.max(0, ls.total - limit),
      files: ls.files.length,
      biggest: biggest ? { file: biggest.file, chars: biggest.chars } : null,
      excluded_chars: ls.excluded_chars,
      notes: ls.notes,
    };
  });
  rows.sort((a, b) => b.total - a.total || (a.dir < b.dir ? -1 : 1));

  const userLevel = m.loadSet(path.join(home, "__no_such_dir__")); // user + managed layers only
  return {
    ...base,
    status,
    reason,
    dirs: rows,
    max: rows[0]?.total ?? 0,
    worst_dir: rows[0]?.dir ?? null,
    over: rows.filter((r) => r.total > limit).length,
    excluded_chars: userLevel.excluded_chars,
  };
}

// ── the exceptions registry ──────────────────────────────────────────────────

/**
 * Parse `scripts/execution/instruction-budget.yml`.
 *
 * Shape: `limit?: <n>` and `exceptions: { "<hub-relative dir>": {reason, ceiling} }`.
 * Returns `{entries, limit, problems}`; a malformed entry is a PROBLEM, never silently dropped
 * (a dropped exception would turn into an unexplained failure, or worse, a widened one).
 */
export function parseBudgetRegistry(text) {
  const problems = [];
  let doc;
  try {
    doc = parseYaml(text);
  } catch (err) {
    return { entries: new Map(), limit: null, problems: [`not valid YAML: ${err.message}`] };
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return { entries: new Map(), limit: null, problems: ["top level is not a mapping"] };
  }
  let limit = null;
  if (doc.limit !== undefined) {
    if (Number.isInteger(doc.limit) && doc.limit > 0) limit = doc.limit;
    else problems.push(`limit must be a positive integer, got ${JSON.stringify(doc.limit)}`);
  }
  const entries = new Map();
  const ex = doc.exceptions;
  if (ex !== undefined && (ex === null || typeof ex !== "object" || Array.isArray(ex))) {
    problems.push("`exceptions` is not a mapping");
  } else {
    for (const [dir, v] of Object.entries(ex ?? {})) {
      const reason = typeof v?.reason === "string" ? v.reason.trim() : "";
      const ceiling = v?.ceiling;
      if (!reason) problems.push(`${dir}: missing \`reason:\``);
      if (!Number.isInteger(ceiling) || ceiling <= 0) problems.push(`${dir}: \`ceiling:\` must be a positive integer`);
      if (reason && Number.isInteger(ceiling) && ceiling > 0) entries.set(dir, { reason, ceiling });
    }
  }
  return { entries, limit, problems };
}

/**
 * Apply the registry to a budget. Exceptions are SUBTRACTED visibly; inclusion is derived.
 *
 *   unexcepted_over  dirs over the limit and not listed                      -> fail
 *   stale            listed dirs now at/under the limit, or orphaned         -> fail (list must not outlive its reason)
 *   over_ceiling     listed dirs above their own ceiling                     -> fail (ceilings only ever lower)
 */
export function evaluateBudget(budget, entries, { hubRoot, limit = budget.limit } = {}) {
  const hub = hubRoot ? path.resolve(hubRoot) : null;
  const keyOf = (dir) => (hub ? path.relative(hub, dir) || "." : dir);
  const byKey = new Map(budget.dirs.map((r) => [keyOf(r.dir), r]));

  const unexcepted_over = [];
  const over_ceiling = [];
  const stale = [];
  let excepted = 0;

  for (const r of budget.dirs) {
    if (r.total <= limit) continue;
    const e = entries.get(keyOf(r.dir));
    if (!e) unexcepted_over.push({ dir: r.dir, total: r.total, over_by: r.total - limit });
    else {
      excepted++;
      if (r.total > e.ceiling) over_ceiling.push({ dir: r.dir, total: r.total, ceiling: e.ceiling, over_by: r.total - e.ceiling });
    }
  }
  for (const [key, e] of entries) {
    const r = byKey.get(key);
    if (!r) {
      const abs = hub ? path.resolve(hub, key) : key;
      stale.push({ key, reason: existsSync(abs) ? "orphan: no longer owns a CLAUDE.md in the scan" : "orphan: directory is gone" });
    } else if (r.total <= limit) {
      stale.push({ key, reason: `now ${r.total.toLocaleString("en-US")} <= ${limit.toLocaleString("en-US")} — remove the entry` });
    }
  }

  const unex = budget.dirs.filter((r) => !entries.has(keyOf(r.dir)));
  const worstUnexcepted = unex[0] ?? null;
  return {
    limit,
    unexcepted_over,
    stale,
    over_ceiling,
    excepted,
    over: budget.dirs.filter((r) => r.total > limit).length,
    worst_unexcepted: worstUnexcepted
      ? { dir: worstUnexcepted.dir, total: worstUnexcepted.total, headroom: limit - worstUnexcepted.total, biggest: worstUnexcepted.biggest }
      : null,
    worst: budget.dirs[0]
      ? { dir: budget.dirs[0].dir, total: budget.dirs[0].total, excepted: entries.has(keyOf(budget.dirs[0].dir)), biggest: budget.dirs[0].biggest }
      : null,
  };
}

// ── calibration against an InstructionsLoaded log ────────────────────────────

/** Largest slice of the log read; the tail is the recent data, and an unbounded log is the next unread store. */
export const CALIBRATE_MAX_BYTES = 32 * 1024 * 1024;
export const CALIBRATE_MAX_SESSIONS = 200;

/**
 * Compare the predicted session-start load set for each logged session cwd against what the
 * harness logged, as a SET comparison (a total can match while the files differ, and the files
 * are what `claudeMdExcludes`, `paths:` and `@import` change).
 *
 * Only `load_reason: session_start` records are compared — path_glob_match and
 * nested_traversal happen later in a session and are not part of the warning total.
 */
export function calibrate({ logPath, model, maxBytes = CALIBRATE_MAX_BYTES, maxSessions = CALIBRATE_MAX_SESSIONS }) {
  if (!existsSync(logPath)) return { status: "no-log", logPath, reason: `no log at ${logPath}` };
  let raw;
  let truncated = false;
  try {
    const size = statSync(logPath).size;
    if (size > maxBytes) {
      truncated = true;
      const fd = openSync(logPath, "r");
      try {
        const buf = Buffer.alloc(maxBytes); // bounded: only the tail is read
        readSync(fd, buf, 0, maxBytes, size - maxBytes);
        raw = buf.toString("utf8");
      } finally {
        closeSync(fd);
      }
      raw = raw.slice(raw.indexOf("\n") + 1); // drop the partial first line
    } else {
      raw = readFileSync(logPath, "utf8");
    }
  } catch (err) {
    return { status: "unreadable", logPath, reason: err.message };
  }

  let badLines = 0;
  let lines = 0;
  const sessions = new Map();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    lines++;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      badLines++;
      continue;
    }
    if (!r || typeof r.session_id !== "string" || typeof r.file_path !== "string") {
      badLines++;
      continue;
    }
    let s = sessions.get(r.session_id);
    if (!s) sessions.set(r.session_id, (s = { session_id: r.session_id, cwd: r.cwd ?? null, last: "", start: new Set(), later: 0 }));
    if (r.cwd && !s.cwd) s.cwd = r.cwd;
    if (typeof r.logged_at === "string" && r.logged_at > s.last) s.last = r.logged_at;
    if (r.load_reason === "session_start") s.start.add(realOrSelf(r.file_path));
    else s.later++;
  }
  if (lines === 0 || sessions.size === 0) {
    return { status: "empty", logPath, reason: `${lines} line(s), ${sessions.size} session(s) in ${logPath} — nothing to compare, which is not a match`, lines, badLines };
  }

  let list = [...sessions.values()].sort((a, b) => (a.last < b.last ? 1 : -1));
  const capped = list.length > maxSessions;
  if (capped) list = list.slice(0, maxSessions);

  const results = list.map((s) => {
    if (!s.cwd) return { session_id: s.session_id, cwd: null, error: "no cwd in the log records" };
    if (s.start.size === 0) return { session_id: s.session_id, cwd: s.cwd, error: "no session_start records for this session" };
    const predicted = new Set(m_loadReal(model, s.cwd));
    const missing = [...predicted].filter((f) => !s.start.has(f)).sort();
    const extra = [...s.start].filter((f) => !predicted.has(f)).sort();
    return { session_id: s.session_id, cwd: s.cwd, predicted: predicted.size, logged: s.start.size, missing, extra, match: !missing.length && !extra.length };
  });
  return {
    status: "ok",
    logPath,
    lines,
    badLines,
    truncated,
    capped,
    sessions: results.length,
    mismatches: results.filter((r) => r.error || r.match === false).length,
    results,
  };
}

function m_loadReal(model, cwd) {
  return model.loadSet(cwd).files.map((f) => realOrSelf(f.file));
}
