#!/usr/bin/env node
/**
 * PreToolUse (Bash) — enforces rule:background-long-runs and rule:delegation-criteria §3 (propagate#224).
 *
 * WHY A HOOK. The rule was flouted "nearly every session" (Rupali, 2026-11-15) on commands that looked short: a
 * foreground `timeout: 500000` journey, a slow `doctor`, and `npm test > log &`, whose shell `&` hides the job from the
 * harness so no completion notice ever arrives. Prose failed four times; this is the mechanical check.
 *
 * MAIN SESSION VS SUBAGENT. The discriminator is `agent_id`, NOT `agent_type`. Hooks docs, "Common input fields"
 * (https://code.claude.com/docs/en/hooks, fetched 2026-11-15):
 *   agent_id:   "Unique identifier for the subagent or in-process teammate the hook fires in."
 *   agent_type: "Present when the session uses `--agent` or the hook fires inside a subagent."
 * `agent_type` also appears in a main session started with `--agent`, so keying on it would exempt that session.
 * VERIFIED: the two doc lines above. INFERRED, not captured: that `agent_id` is absent in a main session. propagate
 * logs no PreToolUse payload, so no real one was read; the docs imply the absence and do not state it.
 *
 * THE FOUR RULES (a Bash call is judged in this order)
 *   2. Any session: a shell `&` that backgrounds a command, or `nohup`. Deny: use run_in_background.
 *   3. Subagent with run_in_background true. Deny: a backgrounded subagent has ended, not paused.
 *   1. Main session, not run_in_background, and timeout >= 120000 or the command matches HEAVY. Deny: re-run in the
 *      background.
 *   5. Subagent running `test-queue run --profile gate|full`. Deny: gates run only in the main session (#428).
 *   4. Subagents are exempt from rule 1 (they must stay foreground, with a timeout).
 * TEST QUEUE (#428): `test-queue run --profile gate|full` and `scripts/test.sh|tool/test.sh gate|full` are HEAVY; lane
 * profiles are not. A bare vitest / `node --test` / `flutter test` outside `test-queue run`, in a project with a
 * `.test-queue` file at its git root, is allowed with an additionalContext warning (see `optedIn`). G56 still fires first.
 * Not a background `&`: `&&`, `2>&1`, `>&2`, `&>`, and anything inside quotes.
 *
 * THE TWO ENFORCED GOTCHAS (propagate#410). G56 and G72 used to be warnings in gotcha-guard.mjs; a warning was read and
 * the command run anyway, so both are denies here (gotcha-guard skips them now). Any session, main or subagent.
 *   G72: `git push` after a `git commit` / `node --test` / `npm test` step whose failure would not stop it. Unsafe: a `;`
 *        or newline after the step (unless `set -e` / `set -o errexit` came BEFORE it), or an `&&` that follows a pipe
 *        (unless `set -o pipefail` came before). Safe: a plain `&&` chain, `|| exit N` on the step.
 *   G56: `node --test` where the cwd or a path argument sits in a propagate checkout (nearest package.json `name` is
 *        "claude-propagate"; read from disk, never a hard-coded path) without a NON-EMPTY PROPAGATE_STATE_DIR in the same
 *        command (an empty one falls back to the production store, lib/core/paths.mjs).
 *   Escape: a `# G72-ok: <reason>` or `# G56-ok: <reason>` comment, reason non-empty.
 *   Heredoc bodies (`$(cat <<'EOF' ... EOF)`, `-F - <<EOF`) are dropped before parsing, so a commit message holding a
 *   newline or `;` cannot trigger. VERIFIED by tests: both denies and the allows. INFERRED: the payload carries `cwd`
 *   (hooks docs "Common input fields"); absent, process.cwd() is used.
 *
 * FAILS OPEN. An unreadable payload, or any bug here, exits 0 silently: a guard must not wedge the session.
 *
 * THE GUARD LOG (propagate#294). One row per `deny` and per `allow-bg` (a backgrounded main-session call that rule 1
 * would have denied in the foreground), appended to `$PROPAGATE_STATE_DIR/guard/YYYY-MM.jsonl` (UTC month of `ts`):
 *   {ts, session, event, rule, label, program, command_hash, timeout_ms}
 * NEVER COMMAND TEXT. `label` comes from the fixed HEAVY or network table (or `&`/`nohup`), `program` is the bare first
 * word after every NAME=value prefix, and `command_hash` is 16 hex of the sha256 of the whitespace-normalised command. A
 * `SECRET=x npm test` or a `Bearer` header therefore never reaches disk.
 * ORDER: the decision goes to stdout FIRST, then the append runs in its own try. A failed append never changes the
 * decision. `mkdirSync` runs only on that logging path, so an install without `guard/` gets it on its first logged event.
 * The hook never prunes: `lib/guard/log.mjs` does, from the CLI (`day open`).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { stateDir as defaultStateDir } from "../lib/core/paths.mjs";

export const TIMEOUT_MS = 120000;

const START = String.raw`^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*`; // optional VAR=x prefixes
// propagate#300: `propagate` by any path whose basename is exactly `propagate` (`/abs/bin/propagate`, `./bin/propagate`).
// The basename must end at whitespace, so `/x/propagate-notes.sh` is not matched.
const PROPAGATE = String.raw`(?:(?:\S*/)?propagate\s+|node\s+\S*cli\.mjs\s+)`;
const escapeRe = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * DERIVED: every COMMANDS entry marked `network: true` (it reaches GitHub, so it takes minutes). A new network command
 * is covered by marking it in lib/core/commands.mjs; nothing here is edited (propagate#224, rule:derive-dont-curate).
 * `offline` flags (backlog --offline) exempt a call. The test asserts a floor and that every module calling gh is marked.
 */
export const networkFrom = (commands) => Object.freeze(
  Object.entries(commands)
    .filter(([, c]) => c.network === true)
    .map(([name, c]) => {
      const off = (c.offline ?? []).map(escapeRe);
      const guard = off.length ? String.raw`(?!.*(?:${off.join("|")})(?:\s|$))` : "";
      const words = name.split(" ").map(escapeRe).join(String.raw`\s+`);
      // propagate#434: the LONGEST registered name wins. A longer registered command that extends this one (`waiting gate-pass`
      // under `waiting`) is its own entry, so its class comes from that entry; a pattern matching only the parent made it network.
      const longer = Object.keys(commands).filter((k) => k.startsWith(name + " ")).map((k) => k.slice(name.length + 1).split(" ").map(escapeRe).join(String.raw`\s+`));
      const ext = longer.length ? String.raw`(?!\s+(?:${longer.join("|")})(?:\s|$))` : "";
      return {
        label: `${name} (reaches GitHub)`,
        re: new RegExp(START + PROPAGATE + words + String.raw`(?=\s|$)` + ext + guard),
        example: `propagate ${name}`,
      };
    }),
);

/**
 * LAZY: the hook runs on every Bash call and importing COMMANDS cost ~57 ms, so it is imported only when the command text
 * could name a propagate command. `load` is injectable so a test can prove a plain command never triggers it.
 */
const NAMES_PROPAGATE = /\b(?:propagate|cli\.mjs)\b/;
let cached;
const defaultLoad = async () => (await import("../lib/core/commands.mjs")).COMMANDS;
export async function networkPatterns(load = defaultLoad) {
  if (load === defaultLoad) return (cached ??= networkFrom(await load()));
  return networkFrom(await load());
}

// propagate#428 (E3). A GATE run is `test-queue run --profile gate|full` (the profile may sit anywhere after `run`, as
// `--profile gate` or `--profile=gate`) or a project's wrapper `scripts/test.sh gate|full` / `tool/test.sh gate|full`.
// Lane profiles are NOT heavy: they stay foreground, in a main session and in a subagent.
const TEST_QUEUE_GATE = String.raw`(?:${PROPAGATE})?(?:\S*/)?test-queue\s+run\b(?=.*--profile[=\s]+(?:gate|full)\b)`;
const gateRunRe = new RegExp(START + TEST_QUEUE_GATE);

/**
 * The EXPLICIT EXCEPTIONS: heavy commands that are not a network `propagate` subcommand, so COMMANDS cannot express
 * them. `example` is a command that must match, so a test can iterate the list and assert the floor.
 */
const EXCEPTIONS = [
  { label: "npm test", re: new RegExp(START + String.raw`npm\s+(?:run\s+)?test(?:\s|$)`), example: "npm test" },
  { label: "npm run test:record", re: new RegExp(START + String.raw`npm\s+run\s+test:record\b`), example: "npm run test:record" },
  { label: "release --check", re: new RegExp(START + PROPAGATE + String.raw`release\b.*--check\b`), example: "node cli.mjs release --check" },
  { label: "doctor (without --quick)", re: new RegExp(START + PROPAGATE + String.raw`doctor\b(?!.*--quick)`), example: "propagate doctor" },
  { label: "test-queue run (gate/full profile)", re: gateRunRe, example: "test-queue run --profile gate -- npm test", gate: true },
  { label: "test.sh gate/full wrapper", re: new RegExp(START + String.raw`(?:(?:bash|sh)\s+)?(?:\S*/)?(?:scripts|tool)/test\.sh\s+(?:gate|full)\b`), example: "scripts/test.sh gate" },
  { label: "make-public --check", re: new RegExp(START + String.raw`.*\bmake-public\b.*--check\b`), example: "node cli.mjs make-public repo --check" },
];

/** The literal exceptions only; the derived network patterns come from `networkPatterns()`. */
export const HEAVY = Object.freeze(EXCEPTIONS);

const stripQuotes = (s) => s.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, " ");

/** A shell `&` that backgrounds, or nohup. Quotes, `&&`, `2>&1`, `>&2` and `&>` are removed first. */
function shellBackground(command) {
  // A heredoc body is ONE literal argument, so an `&` in it ("Elevation & shape") backgrounds nothing (propagate#420).
  // `$&` is a regex or sed match reference, never a background: a background `&` follows whitespace, `;`, `)` or the
  // end of a command word, never a `$`. Unquoted `$&` is stripped for that reason; a quoted one is already gone.
  const bare = stripQuotes(dropHeredocs(command))
    .replace(/\$&/g, " ")
    .replace(/&&/g, " ")
    .replace(/\d*>&\d*-?/g, " ")
    .replace(/&>>?/g, " ");
  if (/(^|[\s;|&(])nohup(\s|$)/.test(bare)) return "nohup";
  return bare.includes("&") ? "&" : null;
}


// ── propagate#410: G72 and G56 as denies ─────────────────────────────────────────────────────────────────────────────
const PROPAGATE_PKG_NAME = "claude-propagate"; // package.json `name`: the real field, so a rename is a one-line change here

/** Heredoc bodies and terminators removed: the body is ONE argument, whatever it contains (newlines, `;`, `&&`). */
export function dropHeredocs(command) {
  const lines = String(command).split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    // the delimiter may be written plain, 'EOF', "EOF", or with the idiom `'"'"'EOF'"'"'` (a quoted delimiter inside bash -c '...')
    const m = [...lines[i].matchAll(/<<-?\s*(?:'"'"'|['"])?([A-Za-z_][A-Za-z0-9_]*)(?:'"'"'|['"])?/g)].map((x) => x[1]);
    out.push(lines[i]);
    if (!m.length) continue;
    for (const id of m) {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== id) j++;
      if (j >= lines.length) return out.join("\n"); // unterminated: leave the rest as written
      i = j; // body and terminator are consumed
      // a continuation line that only closes the substitution or chains on (`)" && git push`) belongs on the opener's line
      if (i + 1 < lines.length && /^\s*(?:\)|&&|\|\||\|)/.test(lines[i + 1])) { out[out.length - 1] += " " + lines[i + 1]; i++; }
    }
  }
  return out.join("\n");
}

const escapeOk = (command, id) => new RegExp(String.raw`#\s*${id}-ok:\s*\S`).test(command);
const STEP = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:git\s+(?:-C\s+\S+\s+)?commit\b|node\s+(?:\S+\s+)*?--test\b|npm\s+(?:run\s+)?test\b)/;
const PUSH = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*git\s+(?:-C\s+\S+\s+)?push\b/;
const ERREXIT = /^\s*set\s+(?:.*\s)?(?:-[A-Za-z]*e[A-Za-z]*|-o\s+errexit)(?:\s|$)/;
const PIPEFAIL = /^\s*set\s+(?:.*\s)?-[A-Za-z]*o\s+pipefail(?:\s|$)/;

/** G72. Returns a reason or null. `bare` is the heredoc-free, quote-free command. */
function g72(bare) {
  const parts = bare.split(/(&&|\|\||;|\n|\|)/); // [seg, sep, seg, sep, ...]
  let errexit = false, pipefail = false, pending = null;
  for (let i = 0; i < parts.length; i += 2) {
    const seg = parts[i], before = i > 0 ? parts[i - 1] : "";
    if (!seg.trim()) continue;
    if (ERREXIT.test(seg)) errexit = true;
    if (/^\s*set\s+(?:.*\s)?-[A-Za-z]*e[A-Za-z]*o\s+pipefail/.test(seg) || PIPEFAIL.test(seg)) pipefail = true;
    if (before === "||" && /^\s*(?:exit|return)\b/.test(seg)) { pending = null; continue; }
    if (pending && before) {
      if (before === ";" || before === "\n") { if (!pending.errexit) pending.semi = true; }
      else if (before === "|") pending.pipe = true;
      else if (before === "||") pending.orElse = true;
    }
    if (PUSH.test(seg)) {
      if (pending && ((pending.pipe && !pending.pipefail) || pending.semi || pending.orElse)) {
        const sep = pending.semi ? "';'/newline" : pending.orElse ? "'||'" : "&& after a pipe";
        return pending.semi || pending.orElse
          ? `G72: a push after a ${sep} runs even if the commit/test failed; chain with && or start with set -e (escape: # G72-ok: why)`
          : `G72: '&&' after a pipe tests the LAST command's status, so the push runs on a red test; add set -o pipefail first (escape: # G72-ok: why)`;
      }
      pending = null;
    } else if (STEP.test(seg)) pending = { errexit, pipefail, semi: false, pipe: false, orElse: false };
  }
  return null;
}

/** The nearest package.json `name` at or above `p` (an existing file's directory, or the nearest existing ancestor). */
function packageName(p) {
  let d = p;
  for (let n = 0; n < 40; n++) {
    try {
      const f = path.join(d, "package.json");
      if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8")).name ?? null;
    } catch { return null; }
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
  return null;
}
const dirOf = (p) => { try { return statSync(p).isDirectory() ? p : path.dirname(p); } catch { return path.dirname(p); } };

/** G56. Returns a reason or null. */
function g56(raw, bare, cwd) {
  if (!/(^|[\s;&|(])node\s+(?:\S+\s+)*?--test\b/.test(bare)) return null;
  const set = /PROPAGATE_STATE_DIR=(?:"([^"]*)"|'([^']*)'|(\S*))/.exec(raw);
  if (set && (set[1] ?? set[2] ?? set[3] ?? "").length > 0) return null;
  let at = cwd;
  const roots = new Set();
  for (const seg of bare.split(/&&|\|\||;|\n|\|/)) {
    const cd = /^\s*cd\s+(\S+)/.exec(seg);
    if (cd) { at = path.resolve(at, cd[1]); continue; }
    if (!/node\s+(?:\S+\s+)*?--test\b/.test(seg)) continue;
    roots.add(at);
    for (const t of seg.split(/\s+/).slice(1)) if (t && !t.startsWith("-") && /[\/.]/.test(t) && !t.includes("=")) roots.add(path.resolve(at, t));
  }
  for (const r of roots) {
    if (packageName(dirOf(r)) === PROPAGATE_PKG_NAME) {
      return `G56: node --test in a propagate checkout writes the PRODUCTION ledger unless PROPAGATE_STATE_DIR is set to a non-empty temp dir; use PROPAGATE_STATE_DIR=$(mktemp -d) node --test ... or npm run test:propagate (escape: # G56-ok: why)`;
    }
  }
  return null;
}

/** The script of a whole-command `bash|sh|zsh -c '...'`, with the `'"'"'` idiom turned back into `'`; else null. */
function bashDashC(command) {
  const m = /^\s*(?:bash|sh|zsh)\s+-[A-Za-z]*c\s+'([\s\S]*)'\s*$/.exec(command);
  return m ? m[1].replace(/'"'"'/g, "'") : null;
}

/** The two enforced gotchas. FAILS OPEN: any exception allows. @returns {{rule: string, reason: string}|null} */
export function gotchaDeny(input) {
  try {
    const raw = dropHeredocs(String(input?.tool_input?.command ?? ""));
    const bare = stripQuotes(raw);
    const inner = bashDashC(raw);
    const cwd = typeof input?.cwd === "string" && input.cwd ? input.cwd : process.cwd();
    if (!escapeOk(raw, "G72")) {
      // the script of `bash -c '...'` is judged as a script: its own `set -e` guards its own push (propagate#420)
      const r = g72(bare) ?? (inner === null ? null : g72(stripQuotes(dropHeredocs(inner))));
      if (r) return { rule: "g72", reason: r };
    }
    if (!escapeOk(raw, "G56")) { const r = g56(raw, bare, cwd); if (r) return { rule: "g56", reason: r }; }
  } catch {
    // fail open: not ours to judge
  }
  return null;
}

// propagate#428: a bare test runner that is not wrapped in `test-queue run`. A WARNING, never a deny (the deny is decided
// after a week of records, plan E finding 4).
const BARE_RUNNER = new RegExp(START + String.raw`(?:npx\s+)?(?:vitest(?:\s|$)|node\s+(?:\S+\s+)*?--test\b|flutter\s+test\b)`);
export const TEST_QUEUE_WARNING = "run tests through test-queue (#428); unwrapped runs collide with gates";

/**
 * OPT-IN MARKER (propagate#428): a project has opted in when the root of the git checkout that holds the cwd (the
 * nearest ancestor with a `.git` entry, a directory or a worktree's file) contains a file named `.test-queue`. Derived
 * from the cwd each call; no path is hard-coded. A `package.json` key was the other candidate: it needs a JSON read on
 * every Bash call, and a Flutter or Go project has no package.json to carry it.
 */
export function optedIn(cwd) {
  let d = path.resolve(cwd);
  for (let n = 0; n < 40; n++) {
    if (existsSync(path.join(d, ".git"))) return existsSync(path.join(d, ".test-queue"));
    const up = path.dirname(d);
    if (up === d) return false;
    d = up;
  }
  return false;
}

const bareRunnerWarning = (command, cwd) => {
  const segs = stripQuotes(dropHeredocs(command)).split(/&&|\|\||;|\||\n/).map((s) => s.trim());
  if (!segs.some((s) => BARE_RUNNER.test(s) && !/\btest-queue\b/.test(s))) return null;
  return optedIn(cwd) ? TEST_QUEUE_WARNING : null;
};

const segmentsOf = (command) => stripQuotes(command).split(/&&|\|\||;|\||\n/).map((s) => s.trim());
const heavyMatch = async (command, load) => {
  const segs = segmentsOf(command);
  const hit = (list) => list.find((h) => segs.some((s) => h.re.test(s)));
  return hit(HEAVY) ?? (NAMES_PROPAGATE.test(command) ? hit(await networkPatterns(load)) : undefined);
};

/**
 * The full judgement: the decision plus what the log needs. `event` is "deny", "allow-bg" or null (nothing to log);
 * `rule` is timeout | heavy | shell-bg | sub-bg; `label` is a fixed-table label or null. Never any command text.
 * @returns {Promise<{deny: boolean, reason?: string, event: string|null, rule?: string, label?: string|null}>}
 */
export async function judge(input, load = defaultLoad) {
  if (input?.tool_name !== "Bash") return { deny: false, event: null };
  const ti = input.tool_input ?? {};
  const command = String(ti.command ?? "");
  const bg = ti.run_in_background === true;
  const isSub = typeof input.agent_id === "string" && input.agent_id.length > 0;

  const sh = shellBackground(command);
  if (sh) return { deny: true, event: "deny", rule: "shell-bg", label: sh, reason: `a shell \`${sh}\` backgrounds the command out of the harness's sight: use run_in_background, not \`${sh}\`; a shell \`&\` gets no completion notice` };

  const gd = gotchaDeny(input);
  if (gd) return { deny: true, event: "deny", rule: gd.rule, label: null, reason: gd.reason };

  // propagate#428: gates run in the coordinator's main session only, so two subagents never queue for the same lock
  if (isSub && segmentsOf(command).some((x) => gateRunRe.test(x))) return { deny: true, event: "deny", rule: "sub-gate", label: null, reason: "gates run only in the coordinator's main session (#428); a subagent runs a lane profile" };

  if (isSub && bg) return { deny: true, event: "deny", rule: "sub-bg", label: null, reason: "a subagent runs long commands in the FOREGROUND with an explicit timeout; a backgrounded subagent command has ended, not paused, because its completion notice routes to the parent (rule:delegation-criteria §3)" };

  if (!isSub) {
    // A backgrounded call is matched too (still lazy behind NAMES_PROPAGATE), so the log can show the rule being followed.
    const event = bg ? "allow-bg" : "deny";
    const timeout = Number(ti.timeout);
    if (timeout >= TIMEOUT_MS) {
      const r = { event, rule: "timeout", label: null };
      return bg ? { deny: false, ...r } : { deny: true, ...r, reason: `a foreground timeout of ${timeout} ms (>= ${TIMEOUT_MS}) holds the turn: re-run with run_in_background: true (rule:background-long-runs)` };
    }
    const h = await heavyMatch(command, load);
    if (h) {
      const r = { event, rule: "heavy", label: h.label };
      return bg ? { deny: false, ...r } : { deny: true, ...r, reason: `\`${h.label}\` takes minutes: re-run with run_in_background: true and keep working; the harness re-invokes you on exit (rule:background-long-runs)` };
    }
  }
  let warn = null;
  try {
    warn = bareRunnerWarning(command, typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd());
  } catch {
    // fail open: a warning is optional
  }
  return warn ? { deny: false, event: null, warn } : { deny: false, event: null };
}

/** @returns {Promise<{deny: boolean, reason?: string}>} the decision only, the shape this hook has always returned. */
export async function decide(input, load = defaultLoad) {
  const j = await judge(input, load);
  return j.deny ? { deny: true, reason: j.reason } : { deny: false };
}

/**
 * The bare program: the BASENAME of the first word after every NAME=value token, kept only if it is a plain name.
 * Never a value, and never a path: `/home/<name>/bin/x` would carry a home directory and a username into the log.
 */
export function programOf(command) {
  const words = String(command ?? "").trim().split(/\s+/).filter(Boolean);
  const first = words.find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
  const base = first?.slice(first.lastIndexOf("/") + 1);
  return base && /^[\w.-]{1,32}$/.test(base) ? base : null;
}

/** One log row. The only derivatives of the command text are its program name and a truncated hash. */
export function guardRow(input, j, now = new Date()) {
  const ti = input?.tool_input ?? {};
  const command = String(ti.command ?? "");
  const timeout = Number(ti.timeout);
  return {
    ts: now.toISOString(),
    session: typeof input?.session_id === "string" ? input.session_id : null,
    event: j.event,
    rule: j.rule,
    label: j.label ?? null,
    program: programOf(command),
    command_hash: createHash("sha256").update(command.trim().replace(/\s+/g, " ")).digest("hex").slice(0, 16),
    timeout_ms: Number.isFinite(timeout) ? timeout : null,
  };
}

/** ONE write per row (O_APPEND keeps a whole write intact). The directory is created here, on the first logged event. */
export function appendGuardRow(row, dir = defaultStateDir()) {
  const d = path.join(dir, "guard");
  mkdirSync(d, { recursive: true });
  appendFileSync(path.join(d, `${row.ts.slice(0, 7)}.jsonl`), JSON.stringify(row) + "\n");
}

const denyJson = (reason) => JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: `propagate background-guard: ${reason}.`,
  },
});

/**
 * Decide, write the decision, THEN log. The order is the contract: the append is attempted only after the deny is on
 * stdout, in its own try, so a full disk or an unwritable state dir can never turn a deny into an allow.
 * Every dependency is injectable for the tests; the defaults are the real stdout, the real append and the clock.
 */
export async function respond(input, { load = defaultLoad, write = (s) => process.stdout.write(s), append = appendGuardRow, stateDir, now = () => new Date() } = {}) {
  const j = await judge(input, load);
  if (j.deny) write(denyJson(j.reason));
  else if (j.warn) write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: `propagate background-guard: ${j.warn}.` } }));
  if (j.event) {
    try {
      append(guardRow(input, j, now()), stateDir ?? defaultStateDir());
    } catch {
      // the log is evidence, never a gate: a failed append leaves the decision as written
    }
  }
  return j;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const input = JSON.parse(readFileSync(0, "utf8") || "{}");
    await respond(input);
  } catch {
    // unreadable payload or a bug here: not ours to judge
  }
  process.exit(0);
}
