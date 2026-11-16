#!/usr/bin/env node
/**
 * SessionStart hook (propagate#272, lane D): tells a session which folder, repos, goal and item it serves, and which
 * guidance files to read first.
 *
 * DEPENDENCY-FREE ON PURPOSE (node builtins only). `lib/sessions/resolve.mjs` imports `lib/core/config.mjs`, which runs
 * workspace discovery at module load, and `assoc.mjs` imports proper-lockfile: measured, importing resolve.mjs alone
 * adds about 0.2 s to a process whose bare start is about 0.08 s on this machine (re-measured 2026-11-15, propagate#267 review 6). The CEO review (S7) caps the hook,
 * so it re-implements the three small reads it needs; tests/hooks/session-guide.test.mjs asserts parity with
 * `readCheckouts`, `fold` and `folderOf`, so the copies cannot drift unnoticed.
 *
 * WHAT IT READS: `$STATE/sessions/checkouts.json` (the CLI refreshes it; the hook never builds it) and
 * `$STATE/sessions/assoc.jsonl`. It NEVER calls `claude`, `readLive`, the network, or git, except ONE
 * `git rev-parse --git-common-dir` when the cwd is inside `.claude/worktrees/`. Workspace and hub are found by reading
 * `.propagates.yml` markers on the ancestors of cwd and `hubRoot` (env or `$STATE/config.yml`), never by discovery.
 *
 * BROADCASTS (propagate#267 phase 2): it also reads `$STATE/broadcast/index.json` (the CLI writes it; the hook never builds
 * it) and adds one `Broadcast:` line for the open broadcast children in the repos the session works in. `readIndexCopy`
 * is pinned to lib/broadcast/index.mjs `readIndex` by a parity test. The broadcast read has its OWN try/catch: a failure
 * there drops only the broadcast line and logs one errors.log line; the session line still prints.
 *
 * WHAT IT WRITES: one append per injection to `$STATE/broadcast/shown-YYYY-MM.jsonl` (UTC month of the row), one row per
 * child the line COVERED, `{ts, session_id, source, repo, child, listed, attended, entrypoint}`. The hub session shows a
 * summary and records no rows. Contexts, not sessions: compact keeps the session id, clear and fork make a new one.
 *
 * THE GLANCE LINE (propagate#295): one line, at most 140 characters, from `$STATE/glance.json` (the CLI writes it; the
 * hook never computes it): at most 3 items plus the glance's age, ending `Run: propagate glance`. It is the LAST line of
 * the block and the last thing cut (its room is reserved before the cut order runs). It prints in unplaced folders and
 * with no checkouts cache too, as the whole output (ruling 2026-11-16): never silent. `readGlanceCopy` is pinned to
 * lib/glance/store.mjs `readGlance` by a parity test.
 *
 * FAILS OPEN: any error appends one line to `$STATE/sessions/errors.log` and exits 0, printing only the glance line.
 * Output is one `additionalContext` block of at most 2,000 characters (the platform ignores over 10,000).
 * Takes effect only after `/reload-plugins` or a new session.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { stateDir } from "../lib/core/paths.mjs";

export const CAP = 2000;

// The state dir comes from the path registry, never a literal (tests/portability/path-registry-literals). paths.mjs imports
// only node builtins, so this costs the hook nothing; config.mjs (discovery at load) stays out.
const stateDirOf = () => stateDir();

const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};
const within = (child, parent) => child === parent || child.startsWith(parent + path.sep);

/** null when absent or unreadable. Same contract as resolve.readCheckouts. */
function readCache(dir) {
  const m = JSON.parse(readFileSync(path.join(dir, "sessions", "checkouts.json"), "utf8"));
  if (!Array.isArray(m?.checkouts)) throw new Error("checkouts.json has no checkouts array");
  return m;
}

/** null when absent; THROWS when unreadable or malformed. Same contract as lib/broadcast/index.mjs readIndex. */
export function readIndexCopy(dir) {
  let text;
  try {
    text = readFileSync(path.join(dir, "broadcast", "index.json"), "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
  const m = JSON.parse(text);
  if (!m || typeof m !== "object" || !m.parents || typeof m.parents !== "object" || typeof m.generatedAt !== "string") throw new Error("index.json has no parents object / generatedAt");
  return m;
}

/**
 * null when absent; THROWS when unreadable, malformed, or of a newer major. Same contract as lib/glance/store.mjs
 * readGlance (parity-tested): change one, change both.
 */
export function readGlanceCopy(dir) {
  let text;
  try {
    text = readFileSync(path.join(dir, "glance.json"), "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
  const g = JSON.parse(text);
  if (!g || typeof g !== "object" || typeof g.schema_version !== "number") throw new Error("glance.json has no schema_version");
  if (g.schema_version > 1) throw new Error("glance format newer than this reader");
  if (typeof g.generatedAt !== "string" || Number.isNaN(Date.parse(g.generatedAt)) || !Array.isArray(g.items)) throw new Error("glance.json has no generatedAt / items");
  return g;
}

export const GLANCE_MAX = 140;
const GLANCE_TAIL = ". Run: propagate glance";
const hhmm = (ms) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/**
 * The session's glance line. Never throws: every failure is a line that says what to run.
 * Order and glyphs follow lib/glance/render.mjs: needs-you oldest first, then broken widest first; `!` needs you,
 * `x` broken, `?` unknown. Free text (`what`) is clipped; the line carries subjects and counts.
 */
export function glanceLine(dir, now = Date.now()) {
  let g;
  try {
    g = readGlanceCopy(dir);
  } catch (e) {
    return /newer than this reader/.test(e?.message ?? "") ? "glance format newer than this reader; run propagate glance" : "glance unavailable: run propagate glance";
  }
  if (!g) return "glance: not computed yet; run propagate glance";
  if (g.verdict === "blind") return "glance: nothing to read yet; run propagate glance";
  const ageMs = now - Date.parse(g.generatedAt);
  const age = ageMs > 3600000 ? `Glance ${Math.round(ageMs / 3600000)}h ago` : `Glance as of ${hhmm(Date.parse(g.generatedAt))}`;
  if (ageMs > (Number(g.stale_after_s) || 21600) * 1000) return `${age} (stale): unknown, recompute${GLANCE_TAIL}`;
  const since = (i) => Date.parse(i?.since ?? "") || 0;
  const items = g.items.filter((i) => i && typeof i === "object");
  const problems = [
    ...items.filter((i) => i.verdict === "needs_you").sort((a, b) => since(a) - since(b)),
    ...items.filter((i) => i.verdict === "broken").sort((a, b) => (b.count ?? 1) - (a.count ?? 1) || since(a) - since(b)),
  ];
  if (!problems.length) return `${age}: all clear, ${g.signals_checked ?? "?"} signals checked${GLANCE_TAIL}`;
  const shown = problems.slice(0, 3);
  const more = problems.length > 3 ? `; +${problems.length - 3} more` : "";
  const head = `${age}: `;
  const per = Math.floor((GLANCE_MAX - head.length - GLANCE_TAIL.length - more.length) / shown.length) - 2;
  const glyph = (i) => (i.flag === "unknown" ? "?" : i.verdict === "needs_you" ? "!" : "x");
  const one = (i) => {
    const lead = `${glyph(i)} ${clip(String(i.subject ?? i.signal ?? "?"), 20)}: `;
    return lead + clip(String(i.what ?? ""), Math.max(per - lead.length, 4));
  };
  return clip(`${head}${shown.map(one).join("; ")}${more}`, GLANCE_MAX - GLANCE_TAIL.length) + GLANCE_TAIL;
}

const DAY = 86400000;
const PTR = " · propagate broadcast status";
const short = (s) => String(s).split("/").pop();
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * What the session is told about broadcasts. `groups` are the parents with children in this session's repos (the hub
 * session matches every child). Returns null when there is nothing to say. `levels[i]` is the line at cut level i:
 * 0 lists items, 1 counts only, then no line at all.
 */
export function broadcastFor(folder, index, now = Date.now()) {
  if (!index) return null;
  const mine = new Set((folder.repos ?? []).map((r) => r.toLowerCase()));
  const byKey = new Map(); // keys compared case-insensitively: one parent seen twice is one group
  for (const [key, p] of Object.entries(index.parents)) {
    const kids = (Array.isArray(p?.children) ? p.children : []).filter((c) => c && c.state !== "closed" && (folder.all || mine.has(String(c.repo).toLowerCase())));
    if (!kids.length) continue;
    const g = byKey.get(key.toLowerCase()) ?? { key, title: String(p.title ?? ""), kids: [] };
    for (const c of kids) if (!g.kids.some((x) => `${x.repo}#${x.number}`.toLowerCase() === `${c.repo}#${c.number}`.toLowerCase())) g.kids.push(c);
    byKey.set(key.toLowerCase(), g);
  }
  const groups = [...byKey.values()];
  if (!groups.length) return null;
  const ageDays = Math.floor((now - Date.parse(index.generatedAt)) / DAY);
  const stale = Number.isFinite(ageDays) && ageDays >= 7;
  const warn = Number.isFinite(ageDays) && now - Date.parse(index.generatedAt) >= DAY ? ` may be stale (${ageDays}d)` : "";
  const trunc = index.truncated ? " (index truncated)" : "";
  if (stale) return { groups, coveredAt: () => [], levels: [`Broadcast: stale (${ageDays}d): items not shown${PTR}`] };
  if (folder.all) {
    const n = groups.reduce((a, g) => a + g.kids.length, 0);
    const m = new Set(groups.flatMap((g) => g.kids.map((c) => String(c.repo).toLowerCase()))).size;
    return { groups, coveredAt: () => [], levels: [`Broadcast: ${n} open across ${m} repos${warn}${trunc}${PTR}`] };
  }
  const label = (g) => `${short(g.key.split("#")[0])}#${g.key.split("#")[1]} "${clip(g.title, 60)}"`;
  const items = (g) => {
    const shownKids = g.kids.slice(0, 3).map((c) => `${short(c.repo)}#${c.number}${c.goal === null ? " (goal not set)" : ""}`);
    return shownKids.join(", ") + (g.kids.length > 3 ? `, +${g.kids.length - 3} more` : "");
  };
  const l0 = `Broadcast: ${groups.map((g) => `${label(g)} → ${g.kids.length} here: ${items(g)}`).join(" ; ")}${warn}${trunc}${PTR}`;
  const noGoal = (g) => g.kids.filter((c) => c.goal === null).length;
  const l1 = `Broadcast: ${groups.map((g) => `${label(g)} → ${g.kids.length} here${noGoal(g) ? `, ${noGoal(g)} goal not set` : ""}`).join(" ; ")}${warn}${trunc}${PTR}`;
  // Every child the line COVERED gets a row, listed or only counted (so "+N more" is not later reported as never shown).
  // One row per child even when two parents hold it (a double-write would double its showings).
  const coveredAt = (level) => {
    const seen = new Set();
    return groups.flatMap((g) => g.kids.map((c, i) => ({ repo: c.repo, child: `${c.repo}#${c.number}`, listed: level === 0 && i < 3 }))).filter((r) => !seen.has(r.child.toLowerCase()) && seen.add(r.child.toLowerCase()));
  };
  return { groups, coveredAt, levels: [l0, l1] };
}

/** The latest `associate` per rowKey not followed by `forgotten`; then the newest one whose row carries this session id. */
function associationFor(dir, sessionId) {
  let text;
  try {
    text = readFileSync(path.join(dir, "sessions", "assoc.jsonl"), "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
  const cur = new Map();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue; // an unreadable line is skipped, as fold() does
    }
    if (!ev || typeof ev.event !== "string" || typeof ev.rowKey !== "string") continue;
    if (ev.event === "associate") cur.set(ev.rowKey, ev);
    else if (ev.event === "forgotten") cur.set(ev.rowKey, null);
  }
  let best = null;
  for (const a of cur.values()) {
    if (a && a.row?.sessionId === sessionId && (!best || String(a.ts) > String(best.ts))) best = a;
  }
  return best;
}

/** A linked worktree's main checkout. Called only when cwd is inside `.claude/worktrees/`. */
function mainCheckout(cwd) {
  const r = spawnSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
  const common = r.status === 0 ? r.stdout.trim() : null;
  if (!common || path.basename(common) !== ".git") return cwd;
  return path.dirname(common);
}

const isWorkspaceDir = (dir) => {
  try {
    return /^workspace:\s*true\s*(#.*)?$/m.test(readFileSync(path.join(dir, ".propagates.yml"), "utf8"));
  } catch {
    return false;
  }
};

function hubRootOf(dir) {
  const env = process.env.PROPAGATE_HUB_ROOT;
  const raw = env && env.trim() ? env.trim() : (() => {
    try {
      return readFileSync(path.join(dir, "config.yml"), "utf8").match(/^hubRoot:\s*["']?([^"'#\n]+?)["']?\s*(#.*)?$/m)?.[1] ?? null;
    } catch {
      return null;
    }
  })();
  if (!raw) return null;
  return real(raw.startsWith("~") ? path.join(os.homedir(), raw.slice(1)) : raw);
}

/**
 * Same answer as resolve.folderOf, from the cache plus marker files. `{unplaced: true}` outside every workspace.
 * The owner is the nearest ancestor of cwd carrying `workspace: true`.
 */
export function placeOf(cwdIn, cache, dir) {
  const hub = hubRootOf(dir);
  const cwd = real(/[\\/]\.claude[\\/]worktrees[\\/]/.test(cwdIn) ? mainCheckout(cwdIn) : cwdIn);
  if (hub && cwd === hub) return { workspace: "hub", project: "(all)", repos: [], all: true, workspaceRoot: hub, cwd };
  let owner = null;
  for (let d = cwd; ; d = path.dirname(d)) {
    if (isWorkspaceDir(d)) {
      owner = d;
      break;
    }
    if (d === path.dirname(d)) break;
  }
  if (!owner) return { unplaced: true };
  const rel = path.relative(owner, cwd);
  const project = rel ? rel.split(path.sep)[0] : "(workspace root)";
  const repos = new Set();
  let containing = null;
  for (const c of cache.checkouts) {
    if (!c.repo) continue;
    const cp = real(c.path);
    if (within(cp, cwd)) repos.add(c.repo);
    else if (within(cwd, cp) && within(cp, owner) && (!containing || cp.length > containing.cp.length)) containing = { cp, repo: c.repo };
  }
  if (containing) repos.add(containing.repo);
  return { workspace: path.basename(owner), project, repos: [...repos].sort(), workspaceRoot: owner, cwd, hub };
}

/** The guidance files, same walk as show.guidanceFor. */
export function guidance(folder) {
  const top = folder.all ? folder.cwd : folder.hub && within(folder.cwd, folder.hub) ? folder.hub : folder.workspaceRoot;
  const out = [];
  for (let d = folder.cwd; ; d = path.dirname(d)) {
    const f = path.join(d, "CLAUDE.md");
    if (existsSync(f)) out.push(f);
    if (d === top || d === path.dirname(d)) break;
  }
  if (!folder.all && folder.project && !folder.project.startsWith("(")) {
    for (const base of new Set([folder.workspaceRoot, folder.hub].filter(Boolean))) {
      for (const name of ["STATE.md", "DECISIONS.md", "GOTCHAS.md"]) {
        const f = path.join(base, "propagation", "state", folder.project, name);
        if (existsSync(f)) out.push(f);
      }
    }
  }
  return out;
}

/**
 * Build the block, at most CAP characters. Repos are dropped from the end first ("+N more"), then guidance files.
 * @returns {string|null}
 */
export function buildBlock(args) {
  return compose(args).text;
}

/** buildBlock plus which broadcast cut level was used (0 items, 1 counts, -1 no line), so the shown rows match the text. */
export function compose({ folder, assoc, sessionId, files, broadcast = null, glance = null }) {
  // The glance line is LAST to be cut: its room comes off the cap before any other cut is considered (propagate#295).
  const cap = glance ? CAP - glance.length - 1 : CAP;
  const withGlance = (r) => (glance ? { ...r, text: `${r.text}\n${glance}` } : r);
  const sid = String(sessionId).slice(0, 8);
  const head = folder.all ? "Session: hub (all repos)" : `Session: ${folder.project} (${folder.workspace})`;
  const tail = assoc
    ? ` · goal ${assoc.goal ?? "-"} · item ${assoc.item ?? "-"}`
    : ` · unassociated: propagate sessions assoc ${sid} --from owner/repo#n`;
  const more = (n) => ` +${n} more: propagate sessions show ${sid}`;
  const reads = (fs) => (fs.length ? `. Read first: ${fs.join(", ")}.` : ".");
  const repos = folder.repos;
  // The pointer is the LAST thing in the block, so a cut list always ends by saying where the rest is.
  const line = (n, fs) => {
    const r = folder.all || n === 0 ? "" : ` · repos: ${repos.slice(0, n).join(", ")}`;
    return `${head}${r}${tail}${reads(fs)}${n < repos.length && !folder.all ? more(repos.length - n) : ""}`;
  };
  let n = repos.length;
  let fs = files;
  // Cut order within the cap: broadcast items, then the whole broadcast line, then repos, then guidance files.
  const levels = broadcast?.levels ?? [];
  for (let bl = 0; bl < levels.length; bl++) {
    const text = `${line(n, fs)}\n${levels[bl]}`;
    if (text.length <= cap) return withGlance({ text, level: bl });
  }
  let text = line(n, fs);
  while (text.length > cap && n > 0) text = line(--n, fs);
  while (text.length > cap && fs.length > 0) text = line(n, (fs = fs.slice(0, -1)));
  return withGlance({ text: text.length > cap ? text.slice(0, cap) : text, level: -1 });
}

function logError(dir, err) {
  try {
    const f = path.join(dir, "sessions", "errors.log");
    mkdirSync(path.dirname(f), { recursive: true });
    appendFileSync(f, `${new Date().toISOString()} session-guide: ${String(err?.message ?? err).replace(/\s+/g, " ").slice(0, 300)}\n`);
  } catch {
    // nothing left to try; the hook still exits 0
  }
}

/** @returns {string|null} the additionalContext text, or null for "inject nothing" */
export function run(payload, dir = stateDirOf()) {
  // The glance line prints in EVERY folder, placed or not, and with no checkouts cache (ruling 2026-11-16).
  const glance = glanceLine(dir);
  let cache;
  try {
    cache = readCache(dir);
  } catch (e) {
    if (e.code === "ENOENT") return glance; // no cache: the CLI has not run yet, so the glance is all there is to say
    throw e;
  }
  const cwd = payload?.cwd || process.env.CLAUDE_PROJECT_DIR;
  if (!cwd) return glance;
  const folder = placeOf(cwd, cache, dir);
  if (folder.unplaced) return glance;
  const sessionId = String(payload?.session_id ?? "");
  const assoc = sessionId ? associationFor(dir, sessionId) : null;
  // The broadcast read has its OWN try/catch: a failure drops only the broadcast line (propagate#267 review 4).
  let broadcast = null;
  const now = Date.now();
  try {
    broadcast = broadcastFor(folder, readIndexCopy(dir), now);
  } catch (e) {
    logError(dir, `broadcast: ${e?.message ?? e}`);
  }
  const { text, level } = compose({ folder, assoc, sessionId: sessionId || "<id>", files: guidance(folder), broadcast, glance });
  if (broadcast && level >= 0) {
    try {
      const attended = process.env.CLAUDE_CODE_SESSION_ATTENDED;
      const rows = broadcast.coveredAt(level).map((c) => JSON.stringify({ ts: new Date(now).toISOString(), session_id: sessionId, source: payload?.source ?? null, repo: c.repo, child: c.child, listed: c.listed, attended: attended === undefined ? null : attended === "1", entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT ?? null }));
      if (rows.length) {
        const f = path.join(dir, "broadcast", `shown-${new Date(now).toISOString().slice(0, 7)}.jsonl`);
        mkdirSync(path.dirname(f), { recursive: true });
        appendFileSync(f, rows.join("\n") + "\n");
      }
    } catch (e) {
      logError(dir, `broadcast shown record: ${e?.message ?? e}`);
    }
  }
  return text;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const dir = stateDirOf();
  try {
    let raw = "";
    try {
      raw = readFileSync(0, "utf8");
    } catch {
      raw = "";
    }
    const payload = raw.trim() ? JSON.parse(raw) : {};
    const text = run(payload, dir);
    if (text) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } }));
  } catch (e) {
    logError(dir, e);
    // Fail open, but never silent: the glance line alone, in its own try (glanceLine itself never throws).
    try {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: glanceLine(dir) } }));
    } catch {
      // nothing left to try
    }
  }
  process.exit(0);
}
