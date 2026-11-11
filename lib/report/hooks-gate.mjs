/**
 * hooks-gate.mjs — which repos commit instruction text, and is `instructions --gate` in their pre-commit?
 * (propagate#221, follow-up to #218.)
 *
 * WHY. `propagate instructions --gate` is a ratchet that only fires from a hook. Until #221 it ran from
 * propagate's own hook and the hub's; a CLAUDE.md, AGENTS.md or GEMINI.md committed in a workspace or
 * project repo was ungated.
 *
 * POPULATION, DERIVED (rule:derive-dont-curate). Every repo discovery finds (WORKSPACES) plus the nested-repo
 * census `listRepos` already walks for doctor's unrecorded-work check — no second walk — keeping those that
 * TRACK at least one instruction file (`git ls-files`, any depth). Linked worktrees are dropped: they share
 * the main checkout's hooks and config, so listing them would count one repository twice.
 * FLOOR: a scan that finds fewer than `minRepos` repos is blind, not clean, and says so.
 *
 * OWNERSHIP. This repo is public. A hook is written only into a repo whose `origin` owner is in an allowlist
 * the operator supplies (config `hooks.ownedRemotes`, env PROPAGATE_HOOKS_OWNED_REMOTES, or `--owned`).
 * Default empty: every repo reports "not owned: skipped" and an apply writes nothing. No account is named here.
 *
 * ACTIONS, and why each is conservative:
 *   - core.hooksPath set inside the repo  -> the gate goes into THAT directory's pre-commit; never repointed.
 *   - core.hooksPath set outside the repo -> skipped: it is a shared hook dir this repo does not own.
 *   - core.hooksPath unset, `.git/hooks/pre-commit` already a real hook -> the gate is appended THERE.
 *     Setting hooksPath would orphan it, and that hook was the author's, not ours.
 *   - core.hooksPath unset, nothing else -> create `.githooks/pre-commit` and set `core.hooksPath .githooks`.
 *   - the gate goes BEFORE the first column-0 `exit`, because text after an unconditional exit never runs.
 *
 * The hook finds propagate with no relative path: $PROPAGATE_CLI, else the propagate marketplace's directory
 * source (propagate loads in place; the cached installPath was a stale 0.15.28 copy with no --gate, so the first
 * real apply installed 36 gates that could never judge), else the installed plugin's `installPath`
 * read from ~/.claude/plugins/installed_plugins.json at commit time, else a printed skip notice and exit 0.
 * It never blocks a commit because propagate is missing.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { listRepos } from "./doctor/unrecorded.mjs";

export const INSTRUCTION_BASENAMES = Object.freeze(["CLAUDE.md", "AGENTS.md", "GEMINI.md"]);

/** What a pre-commit must contain, on a non-comment line, to count as calling the gate. */
export const GATE_COMMAND = "instructions --gate";

export const GATE_BEGIN = "# >>> propagate instructions-gate (propagate#221)";
export const GATE_END = "# <<< propagate instructions-gate";

/** The block written into a hook. POSIX sh; blocks only on exit 1. */
export const GATE_SNIPPET = `${GATE_BEGIN} - written by \`propagate hooks instructions-gate --apply\`
# Blocks a commit only when instructions --gate exits 1 (a folder would end over its limit AND this commit grew it).
# Exit 2 (could not judge) is printed and allowed. A missing propagate prints a notice and allows: this hook never
# blocks because the tool is absent. Bypass (printed, never silent): GSTACK_HYGIENE_BYPASS=1 git commit ...
_pg_cli="\${PROPAGATE_CLI:-}"
if [ -z "$_pg_cli" ] || [ ! -f "$_pg_cli" ]; then
  _pg_cli=$(node -e 'try{const os=require("os"),fs=require("fs"),d=os.homedir()+"/.claude/plugins/";const rd=(n)=>{try{return JSON.parse(fs.readFileSync(d+n,"utf8"))}catch(e){return null}};const m=(rd("known_marketplaces.json")||{}).propagate;const dir=m&&m.source&&m.source.source==="directory"&&m.source.path;if(dir&&fs.existsSync(dir+"/cli.mjs")){process.stdout.write(dir+"/cli.mjs");process.exit(0)}const j=rd("installed_plugins.json")||{};let p=(j.plugins||j)["propagate@propagate"]||[];if(!Array.isArray(p))p=[p];for(const e of p){const f=e.installPath+"/cli.mjs";if(fs.existsSync(f)){process.stdout.write(f);break}}}catch(e){}' 2>/dev/null)
fi
if [ -n "$_pg_cli" ]; then
  PROPAGATE_ORIGIN=hook node "$_pg_cli" instructions --gate; _pg_rc=$?
  if [ "$_pg_rc" -eq 1 ]; then exit 1; fi
  if [ "$_pg_rc" -eq 2 ]; then echo "instructions --gate could not judge (reason above): commit allowed, not passed" >&2; fi
else
  echo "instructions --gate skipped: propagate not found (set PROPAGATE_CLI, or install the propagate plugin)" >&2
fi
${GATE_END}
`;

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
}

/** The owner segment of an origin URL (https or scp-style), lowercased; null when it cannot be read. */
export function ownerOfRemote(url) {
  if (typeof url !== "string") return null;
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/[^/]+\/|[^@\s]+@[^:\s]+:|[^:\s]+:)([^/\s]+)\/[^/\s]+?(?:\.git)?\/?$/i.exec(url.trim());
  return m ? m[1].toLowerCase() : null;
}

/** Instruction files a repo tracks (repo-relative). Throws when git cannot answer. */
export function trackedInstructionFiles(root) {
  const raw = git(root, ["ls-files", "-z", "--", ...INSTRUCTION_BASENAMES, ...INSTRUCTION_BASENAMES.map((b) => `*/${b}`)]);
  return raw.split("\0").filter((f) => f && INSTRUCTION_BASENAMES.includes(path.basename(f)));
}

/** True for a linked worktree (its `.git` is a file pointing into `<common>/worktrees/`). */
function isLinkedWorktree(root) {
  const dotGit = path.join(root, ".git");
  try {
    if (statSync(dotGit).isDirectory()) return false;
    return /gitdir:\s*\S*[\\/]worktrees[\\/]/.test(readFileSync(dotGit, "utf8"));
  } catch {
    return false;
  }
}

function realOr(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Does this script call the gate on a non-comment line? A commented-out line is not a gate. */
export function scriptCallsGate(script) {
  return script.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n").includes(GATE_COMMAND);
}

/** The script with the gate inserted before its first column-0 `exit` (else at the end). */
export function insertGate(script) {
  const lines = script.split("\n");
  const at = lines.findIndex((l) => /^exit(\s|$)/.test(l));
  const block = GATE_SNIPPET.replace(/\n$/, "").split("\n");
  if (at === -1) {
    const body = script.endsWith("\n") || script === "" ? script : `${script}\n`;
    return `${body}\n${GATE_SNIPPET}`;
  }
  return [...lines.slice(0, at), ...block, "", ...lines.slice(at)].join("\n");
}

export function newHookScript() {
  return `#!/bin/sh\n# pre-commit created by \`propagate hooks instructions-gate --apply\` (propagate#221).\n\n${GATE_SNIPPET}\nexit 0\n`;
}

function shebangOk(script) {
  if (!script.startsWith("#!")) return true;
  return /^#!.*\b(sh|bash|zsh|dash|ksh)\b/.test(script.split("\n")[0]);
}

/**
 * Plan one repo. Never throws: a repo git cannot read becomes `unreadable`.
 * @returns {object} row: {repo, root, instructionFiles, origin, owner, owned, hooksPath, hookFile, hookExists, hasGate, config, action, detail}
 *   action: create | append | wire | none | skip-external | skip-shebang | unreadable
 *   config: set (core.hooksPath .githooks would be set) | keep
 */
export function planRepo(root, name, { owned = [] } = {}) {
  const row = { repo: name, root, instructionFiles: [], origin: null, owner: null, owned: false, hooksPath: null,
    hookFile: null, hookExists: false, hasGate: false, config: "keep", action: "none", detail: "" };
  try {
    row.instructionFiles = trackedInstructionFiles(root);
  } catch (e) {
    return { ...row, action: "unreadable", detail: `git ls-files failed: ${String(e.stderr || e.message || e).trim()}` };
  }
  try {
    row.origin = git(root, ["remote", "get-url", "origin"]).trim();
  } catch {
    row.origin = null;
  }
  row.owner = ownerOfRemote(row.origin);
  row.owned = row.owner !== null && owned.includes(row.owner);

  let hp = null;
  try {
    hp = git(root, ["config", "--get", "core.hooksPath"]).trim() || null;
  } catch {
    hp = null; // exit 1 = unset
  }
  row.hooksPath = hp;

  let dir;
  if (hp) {
    dir = path.isAbsolute(hp) ? hp : path.join(root, hp);
    // husky points core.hooksPath at the GENERATED `.husky/_` stubs; the authored hooks live one level up.
    if (path.basename(dir) === "_" && path.basename(path.dirname(dir)) === ".husky") dir = path.dirname(dir);
    const rel = path.relative(realOr(root), realOr(dir));
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      row.hookFile = path.join(dir, "pre-commit");
      return { ...row, action: "skip-external", detail: `core.hooksPath ${hp} is outside the repo: a shared hook directory this repo does not own` };
    }
  } else {
    const gitHook = path.join(root, ".git", "hooks", "pre-commit");
    // A real hook in the default dir would be orphaned by repointing core.hooksPath: use it instead.
    if (existsSync(gitHook) && statSync(gitHook).isFile()) dir = path.dirname(gitHook);
    else {
      dir = path.join(root, ".githooks");
      row.config = "set";
    }
  }
  row.hookFile = path.join(dir, "pre-commit");
  row.hookExists = existsSync(row.hookFile);
  if (!row.hookExists) {
    return { ...row, action: "create", detail: `create ${path.relative(root, row.hookFile)}${row.config === "set" ? " and set core.hooksPath .githooks" : ""}` };
  }
  let script;
  try {
    script = readFileSync(row.hookFile, "utf8");
  } catch (e) {
    return { ...row, action: "unreadable", detail: `cannot read ${row.hookFile}: ${e.message}` };
  }
  row.hasGate = scriptCallsGate(script);
  const bi = script.indexOf(GATE_BEGIN), ei = script.indexOf(GATE_END);
  if (row.hasGate && bi !== -1 && ei > bi) {
    const block = script.slice(bi, ei + GATE_END.length);
    if (block !== GATE_SNIPPET.replace(/\n$/, "")) {
      return { ...row, action: "update", detail: `${path.relative(root, row.hookFile)}: the propagate gate block is out of date; replace it` };
    }
  }
  if (row.hasGate) {
    // Gate present. If core.hooksPath is unset the file is not wired in: that is the one thing left to do.
    if (row.config === "set") return { ...row, action: "wire", detail: `${path.relative(root, row.hookFile)} calls the gate but core.hooksPath is unset: set core.hooksPath .githooks` };
    return { ...row, action: "none", detail: "already calls the gate" };
  }
  if (!shebangOk(script)) {
    return { ...row, config: "keep", action: "skip-shebang", detail: `${path.relative(root, row.hookFile)} is not a shell script (${script.split("\n")[0]})` };
  }
  return { ...row, action: "append", detail: `append the gate to ${path.relative(root, row.hookFile)}` };
}

/**
 * The population and its plan. `repos` may be injected (tests); otherwise derived from discovery + listRepos.
 * @returns {{rows: object[], excluded: number, scanned: number, blind: boolean, reason: string}}
 */
export function planInstructionGate({ roots, workspaces, owned = [], exclude = [], repos, minRepos = 1 } = {}) {
  // exclude: repo names (as listed) that are on an owned remote but are not ours to change, e.g. a fork kept to send
  // pull requests upstream. Config `hooks.excludeRepos`. An excluded repo is reported, never written.
  const ex = new Set(exclude.map((e) => String(e).trim().toLowerCase()).filter(Boolean));
  const candidates = repos ?? [
    ...new Map([...(workspaces ?? []).map((w) => ({ root: realOr(w.root), name: w.name })), ...listRepos(roots ?? [], workspaces ?? [])]
      .map((r) => [r.root, r])).values(),
  ];
  const own = owned.map((o) => String(o).trim().toLowerCase()).filter(Boolean);
  const real = candidates.filter((r) => existsSync(path.join(r.root, ".git")) && !isLinkedWorktree(r.root));
  if (real.length < minRepos) {
    return { rows: [], excluded: 0, scanned: real.length, blind: true,
      reason: `only ${real.length} repos found (floor ${minRepos}) — the scan has gone blind, it has not found nothing` };
  }
  const rows = [];
  let excluded = 0;
  for (const r of real) {
    const p = planRepo(r.root, r.name, { owned: own });
    if (ex.has(String(r.name).toLowerCase())) { p.owned = false; p.action = "excluded"; p.detail = "excluded by config hooks.excludeRepos"; }
    if (p.action !== "unreadable" && p.instructionFiles.length === 0) {
      excluded++;
      continue;
    }
    rows.push(p);
  }
  return { rows, excluded, scanned: real.length, blind: false, reason: "" };
}

/** What `--apply` would do to this row, given ownership. Pure: no I/O. */
export function willAct(row) {
  return row.owned && (row.action === "create" || row.action === "append" || row.action === "wire" || row.action === "update");
}

/**
 * Perform exactly the planned actions on owned rows. Never commits, never pushes.
 * @returns {{row: object, done: string}[]}
 */
export function applyPlan(rows) {
  const results = [];
  for (const row of rows) {
    if (!willAct(row)) continue;
    if (row.action === "create") {
      mkdirSync(path.dirname(row.hookFile), { recursive: true });
      writeFileSync(row.hookFile, newHookScript());
      chmodSync(row.hookFile, 0o755);
    } else if (row.action === "update") {
      const cur = readFileSync(row.hookFile, "utf8");
      const bi = cur.indexOf(GATE_BEGIN), ei = cur.indexOf(GATE_END);
      writeFileSync(row.hookFile, cur.slice(0, bi) + GATE_SNIPPET.replace(/\n$/, "") + cur.slice(ei + GATE_END.length));
    } else if (row.action === "append") {
      const next = insertGate(readFileSync(row.hookFile, "utf8"));
      writeFileSync(row.hookFile, next);
      chmodSync(row.hookFile, statSync(row.hookFile).mode | 0o111);
    }
    if (row.config === "set") git(row.root, ["config", "core.hooksPath", ".githooks"]);
    results.push({ row, done: row.detail });
  }
  return results;
}
