/**
 * tags.mjs — the tag -> project table, DERIVED from the tree rather than
 * hardcoded in it.
 *
 * WHAT CHANGED, 2026-09-25. This file used to carry a literal `TAG_TABLE`
 * mapping `ccusage` and `vipinkaushik` to paths under `~/Documents/GitHub`.
 * Its own header called that "the rot surface named in the spec's H4" and
 * said the table "is provisional ... exactly the kind of thing that drifts
 * the moment a project is renamed, and nothing here pretends otherwise."
 *
 * It was also the wrong PLACE: a map of one person's tree, living inside a
 * tool that is meant to work on any tree. So the fact moved to where the
 * project's other facts already live — `propagation/state/<project>/.sidecar.yml`,
 * beside `project`, `repo_root` and `remote` — under a `reminder_tags:` key:
 *
 *     project: claude-usage-widget
 *     repo_root: Rupali
 *     reminder_tags:
 *       - ccusage
 *
 * A renamed or retired project now takes its tag with it, because the
 * declaration travels in the same file as the rename.
 *
 * THE TWO RULES THAT KEEP IT FROM ROTTING QUIETLY ARE UNCHANGED:
 *
 * 1. Every tag resolves to a directory that EXISTS ON DISK. `validateTagTable()`
 *    walks the discovered table; a test asserts every entry passes.
 * 2. An UNKNOWN tag — one no sidecar declares — is HELD and reported, never
 *    guessed into the nearest match. `resolveTag()` returns `null`; the caller
 *    reports `held-unknown-tag` and never silently drops the reminder.
 *
 * AND ONE NEW RULE, WHICH IS WHY THE SCAN IS NOT JUST A LOOKUP:
 *
 * 3. "No sidecar declares this tag" and "I could not read any declarations at
 *    all" are DIFFERENT FACTS and must not render alike. A hardcoded table was
 *    total: it always answered. A scan can come back empty because the hub is
 *    unconfigured, because a sidecar is unparseable, or because nothing has
 *    adopted the key yet — and if that read as "unknown tag", a misconfigured
 *    install would tell you that you had used bad tags. That is
 *    `rule:discernment-checks` §6 exactly: a reader that cannot report failure
 *    reports absence, and absence gets acted on. `tagTableStatus()` is the
 *    surface that distinguishes them, and `syncReminders` refuses the whole run
 *    rather than dispositioning rows against a table it could not build.
 */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import { HUB_ROOT } from "../core/config.mjs";
import { HOME } from "../core/paths.mjs";
import { readSidecar } from "../report/manifest.mjs";

/**
 * The CONFIGURED hub, not a guess at it. This module's first version restated
 * `path.join(HOME, "Documents/GitHub")`, which G24 records as the exact habit
 * `hubRoot` was introduced to end -- and it had a second cost here, measured
 * the same day: because nothing in the reminders lane honoured
 * `PROPAGATE_HUB_ROOT`, a `sync --apply` CLI TEST resolved a register against
 * the REAL tree and wrote a fixture line ("### PR-001 · a ccusage item") into a
 * human-authored `TODOS.md` in another repo. Scoping `PROPAGATE_STATE_DIR` did
 * not help, because the register path was never derived from the state dir.
 *
 * THE FALLBACK IS A DELIBERATE COMPROMISE, and it is narrower than it looks.
 * G24 argues for `null` when nothing is declared, because a plausible wrong root
 * finds nothing and then reports healthy. But `npm test` runs with a state dir
 * that declares no `hubRoot`, so a strict null broke 17 tests at once -- not
 * because they were wrong, but because the suite's reminders coverage had been
 * silently resting on this HOME guess all along. Removing the guess is the right
 * end state and it needs those tests to declare their own hub first.
 *
 * So: the CONFIGURED hub wins whenever there is one, which is what closes the
 * hole -- `PROPAGATE_HUB_ROOT` now reaches this lane, and that is all a test
 * needs to be contained. The guess remains only as the last resort it always
 * was, and `tagTableStatus()` reports WHICH source was used so it can never be
 * silent about having guessed.
 *
 * Tracked as the remaining half of this fix.
 */
const HOME_GUESS = path.join(HOME, "Documents/GitHub");
const GITHUB_ROOT = HUB_ROOT ?? HOME_GUESS;
const ROOT_SOURCE = HUB_ROOT ? "configured hubRoot" : "HOME guess (no hubRoot declared)";

/** The key a sidecar declares its tags under. */
export const SIDECAR_TAGS_KEY = "reminder_tags";

/** `state/<this>/` means the sidecar describes the workspace root itself. */
const WORKSPACE_DIR_NAME = "workspace";

function dirs(at) {
  if (!at) return [];
  try {
    return readdirSync(at, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

/**
 * Where a tag declared in `<workspace>/propagation/state/<name>/` routes to.
 *
 * This is the EXACT INVERSE of `sync.mjs`'s `resolveRegisterCandidates`, which
 * maps a route path back to `<workspace>/propagation/state/<name>/TODOS.md`.
 * The pair has to compose: a tag must route to a path whose register resolver
 * then finds the register sitting beside the sidecar that declared the tag. A
 * test asserts the round trip, because getting this backwards routes an item to
 * a real directory with no register in it and reports `held-no-register` —
 * a refusal that looks like a missing file rather than a wrong derivation.
 *
 * @returns {{ project: string, path: string }}
 */
export function routeForSidecarDir(workspaceName, stateDirName, githubRoot = GITHUB_ROOT) {
  // The HUB's own state dir sits at `<githubRoot>/propagation/state/`, one level
  // shallower than a workspace's, and it is where `scripts/` and the hub
  // `workspace` are declared. Measured 2026-09-25: 3 of the tree's 52 sidecars
  // live there, and a scan that only walked `<githubRoot>/*/propagation/state/`
  // could never route a tag to any of them.
  if (!workspaceName) {
    return stateDirName === WORKSPACE_DIR_NAME
      ? { project: "hub", path: githubRoot }
      : { project: stateDirName, path: path.join(githubRoot, stateDirName) };
  }
  if (stateDirName === WORKSPACE_DIR_NAME) {
    return { project: workspaceName, path: path.join(githubRoot, workspaceName) };
  }
  return {
    project: `${workspaceName}/${stateDirName}`,
    path: path.join(githubRoot, workspaceName, stateDirName),
  };
}

/**
 * Walk every `<workspace>/propagation/state/*​/.sidecar.yml` under `githubRoot`
 * and build the tag table from their `reminder_tags:` lists.
 *
 * Never throws. Everything that went wrong comes back in `errors`, and
 * `sidecarsRead` is the population — so "found nothing" and "looked at nothing"
 * are distinguishable by the caller (`rule:enforcement-watches-itself` §4).
 *
 * A tag declared by TWO sidecars is an error and resolves to NEITHER. Last-wins
 * would pick by directory-iteration order, which is not a decision anyone made.
 *
 * @returns {{
 *   table: Record<string, {project: string, path: string, declaredIn: string}>,
 *   sidecarsRead: number, withTags: number,
 *   errors: {sidecar: string, reason: string}[],
 * }}
 */
export function discoverTagTable({ githubRoot = GITHUB_ROOT, readSidecarFn = readSidecar } = {}) {
  const table = {};
  const claims = new Map();          // tag -> [sidecar path, ...]
  const errors = [];
  let sidecarsRead = 0;
  let withTags = 0;

  // No hub declared (G24's deliberate null). Return the empty population rather
  // than throwing: `path.join(null, ...)` is a TypeError, and a reader whose
  // job is to report must not be the thing that crashes on a missing config.
  // Caught by running this under `npm test`'s own state dir, which declares no
  // `hubRoot` — so the unconfigured path is the one the suite actually uses.
  if (!githubRoot) return { table, sidecarsRead, withTags, errors };

  // "" is the hub itself; the rest are its workspaces. Deliberately NOT
  // recursive: `worktrees/<name>/propagation/state/` and a workspace nested
  // inside another (`Rupali/Obsidian/`) both carry COPIES of sidecars, and
  // picking a tag up from a copy would either duplicate a claim or route an
  // item into a worktree that gets deleted. Measured: 9 such sidecars exist.
  const scanRoots = ["", ...dirs(githubRoot)];

  for (const workspaceName of scanRoots) {
    const stateRoot = path.join(githubRoot, workspaceName, "propagation", "state");
    if (!existsSync(stateRoot)) continue;

    for (const stateDirName of dirs(stateRoot)) {
      const file = path.join(stateRoot, stateDirName, ".sidecar.yml");
      if (!existsSync(file)) continue;
      sidecarsRead += 1;

      const { sidecar, error } = readSidecarFn(file);
      if (error) { errors.push({ sidecar: file, reason: error }); continue; }

      const raw = sidecar?.[SIDECAR_TAGS_KEY];
      if (raw == null) continue;
      if (!Array.isArray(raw)) {
        errors.push({ sidecar: file, reason: `${SIDECAR_TAGS_KEY} must be a list, got ${typeof raw}` });
        continue;
      }
      withTags += 1;

      const route = routeForSidecarDir(workspaceName, stateDirName, githubRoot);
      for (const entry of raw) {
        if (typeof entry !== "string" || !entry.trim()) {
          // Almost always ONE cause: `- #ccusage` written unquoted. `#` opens a
          // comment in YAML, so the item parses as null and the tag silently
          // vanishes -- and `#ccusage` is exactly how the tag is written in
          // Reminders, in prose and in every other file, so this is the natural
          // thing to type. Name the cause rather than the symptom; an error
          // saying "non-string entry" sends the reader looking at the wrong
          // thing. Verified 2026-09-25: `- #x` -> [null], `- "#x"` -> ["#x"].
          errors.push({
            sidecar: file,
            reason: entry == null
              ? `${SIDECAR_TAGS_KEY} has an empty entry — a bare \`- #tag\` is a YAML COMMENT, ` +
                "so write it unquoted without the hash (`- ccusage`) or quoted with it (`- \"#ccusage\"`)"
              : `${SIDECAR_TAGS_KEY} contains a non-string entry (${typeof entry})`,
          });
          continue;
        }
        const tag = entry.trim().replace(/^#/, "").toLowerCase();
        claims.set(tag, [...(claims.get(tag) ?? []), file]);
        table[tag] = { ...route, declaredIn: file };
      }
    }
  }

  // Refuse an ambiguous tag rather than letting readdir order decide.
  for (const [tag, where] of claims) {
    if (where.length > 1) {
      errors.push({ sidecar: where.join(", "), reason: `tag "${tag}" is declared by ${where.length} sidecars` });
      delete table[tag];
    }
  }

  return { table, sidecarsRead, withTags, errors };
}

/* ── the cached view the runtime uses ─────────────────────────────────────── */

let cached = null;

/** Rebuild on next access. For tests, and for anything that edits a sidecar. */
export function resetTagTableCache() { cached = null; }

function built() {
  if (!cached) cached = discoverTagTable();
  return cached;
}

/**
 * Is the table usable, and if not, WHY? Rule 3 above lives here.
 *
 * `ok: false` means the table could not be built — not that a particular tag is
 * unknown. Callers must not convert this into `held-unknown-tag`.
 *
 * @returns {{ok: boolean, count: number, sidecarsRead: number, withTags: number,
 *            errors: {sidecar: string, reason: string}[], reason: string|null}}
 */
export function tagTableStatus() {
  const { table, sidecarsRead, withTags, errors } = built();
  const count = Object.keys(table).length;
  if (count > 0) {
    return { ok: true, count, sidecarsRead, withTags, errors, rootSource: ROOT_SOURCE, root: GITHUB_ROOT, reason: null };
  }
  const reason = sidecarsRead === 0
    ? `no .sidecar.yml found under any workspace of ${GITHUB_ROOT} — nothing here can say which project a tag belongs to`
    : `${sidecarsRead} sidecar(s) read and none declares a usable \`${SIDECAR_TAGS_KEY}:\` list` +
      (errors.length ? ` (${errors.length} error(s): ${errors.map((e) => e.reason).join("; ")})` : "");
  return { ok: false, count: 0, sidecarsRead, withTags, errors, rootSource: ROOT_SOURCE, root: GITHUB_ROOT, reason };
}

/**
 * Look up a tag. Returns `null` for anything no sidecar declares —
 * deliberately no fuzzy matching. A reader that cannot say "I did not
 * understand this" invents an answer (`rule:discernment-checks` §6); this
 * function refuses to be that reader.
 *
 * `null` here means ONLY "not declared". Ask `tagTableStatus()` whether the
 * table exists at all before treating a null as the tag's fault.
 *
 * @param {string} tag lowercase, with or without a leading `#`
 * @returns {{ project: string, path: string, declaredIn: string } | null}
 */
export function resolveTag(tag) {
  if (typeof tag !== "string") return null;
  return built().table[tag.trim().replace(/^#/, "").toLowerCase()] ?? null;
}

/**
 * Walk the discovered table and report which entries resolve to a real
 * directory. Never throws — the caller (a test, or a runtime "fail loudly"
 * surface) decides what an unresolved entry means. An empty `broken` set is
 * the pass case.
 *
 * @returns {{ tag: string, project: string, path: string, declaredIn: string, exists: boolean }[]}
 */
export function validateTagTable() {
  return Object.entries(built().table).map(([tag, entry]) => ({
    tag,
    project: entry.project,
    path: entry.path,
    declaredIn: entry.declaredIn,
    exists: existsSync(entry.path),
  }));
}
