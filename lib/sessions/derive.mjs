/**
 * Derive the board item a session is working on from a Bash command it just ran (propagate#442).
 *
 * `deriveItem(command, cwd) -> {item: "owner/repo#n", signal} | null`. Pure and dependency-free (node builtins only):
 * the PostToolUse hook runs it on every Bash call. It reads no network and spawns no process; the repo comes from
 * `-R`/`--repo`, else from the cwd's git origin read out of `.git/config` (following a worktree's `commondir`).
 *
 * SIGNALS are writes or starts of work. A read never counts: reading an issue is not working on it.
 *   issue write  gh issue close|comment|edit|reopen|develop <n>
 *   PR write     gh pr create|merge, with `Closes|Fixes|Resolves #n` in its arguments, else the branch's <n>
 *   branch start git switch -c, git checkout -b, git worktree add -b, scripts/worktree-new.sh, with <type>/<n>-<slug>
 * Commands are split on && ; || and newlines; heredoc bodies and quoted text are not commands, so `echo gh issue close 9`
 * and a commit message mentioning one count for nothing. In a compound command the last signal wins.
 * `gh project item-edit` is not a signal: its PVTI_ id needs the network to resolve.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const TYPES = "feat|fix|perf|refactor|docs|test|chore";
const BRANCH = new RegExp(`^(?:${TYPES})/(\\d+)-[a-z0-9][a-z0-9-]*$`);
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ISSUE_WRITES = new Set(["close", "comment", "edit", "reopen", "develop"]);
// gh flags that take a value, so the value is not mistaken for the issue number.
const VALUE_FLAGS = new Set(["-R", "--repo", "-b", "--body", "-F", "--body-file", "-t", "--title", "-a", "--add-assignee", "-l", "--add-label", "-m", "--milestone", "-r", "--reason", "-c", "--comment", "-B", "--base", "-H", "--head", "-p", "--project", "-n", "--name"]);

/** Drop heredoc bodies (`<<EOF` ... `EOF`), keeping the command line that opens them. */
function dropHeredocs(text) {
  const out = [];
  let end = null;
  for (const line of String(text).split("\n")) {
    if (end !== null) {
      if (line.trim() === end) end = null;
      continue;
    }
    out.push(line);
    const m = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line);
    if (m) end = m[2];
  }
  return out.join("\n");
}

/** Replace the characters inside quotes by NUL, keeping offsets, so a split never lands inside a quoted string. */
function maskQuotes(text) {
  let out = "";
  let q = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === q && text[i - 1] !== "\\") {
        q = null;
        out += c;
      } else out += "\0";
    } else {
      if (c === '"' || c === "'") q = c;
      out += c;
    }
  }
  return out;
}

/** @returns {string[]} the commands of a line, original text, split outside quotes. */
function segments(text) {
  const body = dropHeredocs(text);
  const masked = maskQuotes(body);
  const parts = [];
  let last = 0;
  for (const m of masked.matchAll(/&&|\|\||;|\n/g)) {
    parts.push(body.slice(last, m.index));
    last = m.index + m[0].length;
  }
  parts.push(body.slice(last));
  return parts.map((s) => s.trim()).filter(Boolean);
}

/** Whitespace tokens of a segment, outside quotes; a quoted token keeps its quotes and its text. */
function tokens(seg) {
  const masked = maskQuotes(seg);
  const out = [];
  for (const m of masked.matchAll(/\S+/g)) out.push(seg.slice(m.index, m.index + m[0].length));
  return out;
}

const unquote = (t) => t.replace(/^(["'])(.*)\1$/s, "$2");

/** `owner/repo` from a git remote url, or null. */
export function repoFromUrl(url) {
  const m = /github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(String(url).trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/** The `.git` entry above `cwd`, as {gitDir, commonDir}; follows a worktree's `gitdir:` file and its `commondir`. */
function findGit(cwd) {
  let dir = path.resolve(String(cwd || "."));
  for (let i = 0; i < 40; i++) {
    const dotgit = path.join(dir, ".git");
    if (existsSync(dotgit)) {
      try {
        if (statSync(dotgit).isDirectory()) return { gitDir: dotgit, commonDir: dotgit };
        const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotgit, "utf8"));
        if (!m) return null;
        const gitDir = path.resolve(dir, m[1].trim());
        let commonDir = gitDir;
        try {
          commonDir = path.resolve(gitDir, readFileSync(path.join(gitDir, "commondir"), "utf8").trim());
        } catch {
          /* not a linked worktree */
        }
        return { gitDir, commonDir };
      } catch {
        return null;
      }
    }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

/** The `owner/repo` of the cwd's `origin` remote, read from `.git/config`; null when there is none. */
export function originRepo(cwd) {
  const g = findGit(cwd);
  if (!g) return null;
  try {
    const cfg = readFileSync(path.join(g.commonDir, "config"), "utf8");
    const sec = /\[remote "origin"\]([^[]*)/.exec(cfg);
    const url = sec && /^\s*url\s*=\s*(.+)$/m.exec(sec[1]);
    return url ? repoFromUrl(url[1]) : null;
  } catch {
    return null;
  }
}

/** The checked-out branch name of the cwd, read from HEAD; null when detached or unreadable. */
export function currentBranch(cwd) {
  const g = findGit(cwd);
  if (!g) return null;
  try {
    const m = /^ref:\s*refs\/heads\/(.+)$/m.exec(readFileSync(path.join(g.gitDir, "HEAD"), "utf8"));
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

/** `-R o/r`, `--repo o/r` or `--repo=o/r` among the tokens, or null. */
function repoFlag(toks) {
  for (let i = 0; i < toks.length; i++) {
    const t = unquote(toks[i]);
    if ((t === "-R" || t === "--repo") && toks[i + 1]) {
      const v = unquote(toks[i + 1]);
      if (REPO.test(v)) return v;
    }
    const m = /^--repo=(.+)$/.exec(t) ?? /^-R(.+\/.+)$/.exec(t);
    if (m && REPO.test(m[1])) return m[1];
  }
  return null;
}

/** The first positional token after `from` that is an issue number: `5`, `#5`, or an issues URL. */
function issueArg(toks, from) {
  for (let i = from; i < toks.length; i++) {
    const t = unquote(toks[i]);
    if (t.startsWith("-")) {
      if (VALUE_FLAGS.has(t)) i++;
      continue;
    }
    const url = /github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/(\d+)/.exec(t);
    if (url) return { n: Number(url[2]), repo: url[1] };
    const m = /^#?(\d+)$/.exec(t);
    if (m) return { n: Number(m[1]), repo: null };
    return null; // a positional that is not a number (a branch, a title): not an issue write we can read
  }
  return null;
}

const branchIssue = (name) => {
  const m = name ? BRANCH.exec(name) : null;
  return m ? Number(m[1]) : null;
};

/** The signal of ONE command, or null. `ctx` carries cwd and the origin reader. */
function signalOf(seg, ctx) {
  const toks = tokens(seg);
  while (toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[0])) toks.shift(); // leading VAR=value
  if (!toks.length) return null;
  const head = unquote(toks[0]);
  const repo = () => repoFlag(toks) ?? ctx.readOrigin(ctx.cwd);
  const make = (n, signal, repoName) => {
    const r = repoName ?? repo();
    return r && Number.isInteger(n) && n > 0 ? { item: `${r}#${n}`, signal } : null;
  };

  if (head === "gh" && unquote(toks[1] ?? "") === "issue" && ISSUE_WRITES.has(unquote(toks[2] ?? ""))) {
    const a = issueArg(toks, 3);
    return a ? make(a.n, `gh issue ${unquote(toks[2])}`, repoFlag(toks) ?? a.repo) : null;
  }

  if (head === "gh" && unquote(toks[1] ?? "") === "pr" && ["create", "merge"].includes(unquote(toks[2] ?? ""))) {
    const sub = unquote(toks[2]);
    const closes = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/i.exec(seg);
    if (closes) return make(Number(closes[1]), `gh pr ${sub}`);
    let branch = null;
    for (let i = 3; i < toks.length; i++) {
      const t = unquote(toks[i]);
      if ((t === "--head" || t === "-H") && toks[i + 1]) branch = unquote(toks[i + 1]).replace(/^[^:]+:/, "");
    }
    if (!branch && sub === "merge") {
      const pos = toks.slice(3).map(unquote).find((t) => !t.startsWith("-"));
      if (pos && BRANCH.test(pos)) branch = pos;
    }
    return make(branchIssue(branch ?? ctx.branch(ctx.cwd)), `gh pr ${sub}`);
  }

  if (head === "git") {
    const rest = toks.slice(1).map(unquote);
    let name = null;
    let sig = null;
    const sub = rest[0];
    if (sub === "switch" || sub === "checkout") {
      const i = rest.findIndex((t) => (sub === "switch" ? ["-c", "-C", "--create"] : ["-b", "-B"]).includes(t));
      if (i > 0) {
        name = rest[i + 1];
        sig = `git ${sub} ${rest[i]}`;
      }
    } else if (sub === "worktree" && rest[1] === "add") {
      const i = rest.findIndex((t) => t === "-b" || t === "-B");
      if (i > 0) {
        name = rest[i + 1];
        sig = "git worktree add -b";
      }
    }
    return name ? make(branchIssue(name), sig) : null;
  }

  if (/(^|\/)worktree-new\.sh$/.test(head)) {
    const name = toks.slice(1).map(unquote).find((t) => !t.startsWith("-"));
    return make(branchIssue(name), "worktree-new.sh");
  }
  return null;
}

/**
 * @param {string} command
 * @param {string} cwd
 * @param {{readOrigin?: (cwd: string) => string|null, readBranch?: (cwd: string) => string|null}} [opts]
 * @returns {{item: string, signal: string}|null}
 */
export function deriveItem(command, cwd, { readOrigin = originRepo, readBranch = currentBranch } = {}) {
  const ctx = { cwd, readOrigin, branch: readBranch };
  let found = null;
  for (const seg of segments(command)) {
    const s = signalOf(seg, ctx);
    if (s) found = s; // the last signal wins
  }
  return found;
}
