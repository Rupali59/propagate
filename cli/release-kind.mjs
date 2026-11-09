/**
 * release-kind.mjs (command layer) — two entry points for #234:
 *
 *   commitMsgHook(msgFile)  the body of `.githooks/commit-msg`. BLOCKING, and only when VERSION is staged: the
 *                           release commit's own type exists only here, so this is where a patch bump over a `feat:`
 *                           is refused. Bypass: PROPAGATE_SKIP_RELEASE_KIND=1 (said in the refusal).
 *   releaseNotesCmd(args)   `propagate release notes [--since <tag>] [--write] [--version X]`.
 *
 * The classification is lib/core/release-kind.mjs (pure); the git reads are lib/core/release-git.mjs.
 * Run as a script (`node cli/release-kind.mjs hook <msgfile>`) it is the hook's entry.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

import { checkBump, renderBody, groupNotes, applyToChangelog, CHANGELOG_HEADER } from "../lib/core/release-kind.mjs";
import { lastTag, messagesSince, showAt } from "../lib/core/release-git.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const BYPASS = "PROPAGATE_SKIP_RELEASE_KIND=1";

/** Strip git's `#` comment lines from the commit-msg file. */
function ownMessage(msgFile) {
  if (!msgFile || !existsSync(msgFile)) return "";
  return readFileSync(msgFile, "utf8").split("\n").filter((l) => !l.startsWith("#")).join("\n").trim();
}

/**
 * @param {string} msgFile path git passes as $1
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv, out?: (s: string) => void, err?: (s: string) => void}} [inject]
 * @returns {number} exit code: 0 allow, 1 refuse
 */
export function commitMsgHook(msgFile, { cwd = process.cwd(), env = process.env, out = console.log, err = console.error } = {}) {
  const staged = spawnSync("git", ["diff", "--cached", "--name-only", "--", "VERSION"], { cwd, encoding: "utf8" });
  if (staged.status !== 0) { err(`release-kind: could not read the staged diff (${(staged.stderr ?? "").trim()}); not checked`); return 0; }
  if (!staged.stdout.trim()) return 0; // VERSION not staged: not a release commit, nothing is read

  if (env.PROPAGATE_SKIP_RELEASE_KIND) {
    err(`release-kind: BYPASSED via PROPAGATE_SKIP_RELEASE_KIND=${env.PROPAGATE_SKIP_RELEASE_KIND} — the bump was not checked against the commit types`);
    return 0;
  }

  const prev = showAt(cwd, "HEAD:VERSION");
  const next = showAt(cwd, ":VERSION");
  if (prev == null) { err("release-kind: VERSION has no previous version at HEAD (first commit?); not checked"); return 0; }
  if (next == null) { err("release-kind: VERSION is staged but unreadable from the index; not checked"); return 0; }

  const t = lastTag(cwd);
  if (!t.tag) { err(`release-kind: no v* tag reachable from HEAD (${t.reason}); not checked`); return 0; }
  const log = messagesSince(cwd, t.tag);
  if (!log.ok) { err(`release-kind: could not read commits since ${t.tag} (${log.reason}); not checked`); return 0; }

  const own = ownMessage(msgFile);
  const result = checkBump(prev, next, [...log.messages, own], { since: t.tag });
  if (!result.ok) {
    err(`release-kind: REFUSED — ${result.why}`);
    err(`  Bump VERSION (and the manifests it fans out to) to ${result.requiredVersion ?? "a valid version"} or higher, or change the commit type.`);
    err(`  Bypass, knowingly: ${BYPASS} git commit ...`);
    return 1;
  }
  out(`release-kind: ok — ${result.why}`);
  return 0;
}

function flag(args, name) {
  const i = args.indexOf(name);
  return i === -1 ? null : (args[i + 1] ?? null);
}

/**
 * `propagate release notes [--since <tag>] [--write] [--version X]` — a Keep a Changelog draft from the commits
 * since the tag. Read-only without --write. Exit 0 printed/written; 2 could not run (no tag, duplicate version).
 */
export function releaseNotesCmd(args, { root = REPO_ROOT, date = new Date().toISOString().slice(0, 10), out = console.log, err = console.error } = {}) {
  const write = args.includes("--write");
  const version = flag(args, "--version");
  if (args.includes("--version") && !version) { err("release notes: --version needs a value"); return 2; }
  if (version && !/^\d+\.\d+\.\d+/.test(version)) { err(`release notes: --version ${JSON.stringify(version)} is not a version`); return 2; }

  let since = flag(args, "--since");
  if (args.includes("--since") && !since) { err("release notes: --since needs a tag"); return 2; }
  if (!since) {
    const t = lastTag(root);
    if (!t.tag) { err(`release notes: no v* tag reachable (${t.reason}); pass --since <tag>`); return 2; }
    since = t.tag;
  }
  const log = messagesSince(root, since);
  if (!log.ok) { err(`release notes: could not read commits since ${since} (${log.reason})`); return 2; }

  const body = renderBody(log.messages);
  const { cls } = groupNotes(log.messages);
  const heading = version ? `## [${version}] — ${date}` : "## [Unreleased]";
  out(`# release notes: ${log.messages.length} commit(s) since ${since}; required bump pre-1.0: ${cls.required}${cls.breaking ? " (breaking)" : ""}`);
  if (cls.unknown.length) out(`# unprefixed, not classified: ${cls.unknown.map((s) => JSON.stringify(s)).join("; ")}`);

  if (!write) {
    out("");
    out(heading + (body ? `\n\n${body}` : ""));
    return 0;
  }
  const file = path.join(root, "CHANGELOG.md");
  const text = existsSync(file) ? readFileSync(file, "utf8") : CHANGELOG_HEADER;
  const res = applyToChangelog(text, { body, version, date });
  if (!res.ok) { err(`release notes: ${res.reason}`); return 2; }
  writeFileSync(file, res.text);
  out(`wrote ${file}: ${res.action}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2] === "hook") {
  process.exitCode = commitMsgHook(process.argv[3]);
}
