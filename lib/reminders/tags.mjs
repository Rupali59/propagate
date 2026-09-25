/**
 * tags.mjs — the tag -> project table, and the two rules that keep it from
 * rotting quietly (F4, `docs/plans/2026-09-23-reminders-todo-bridge.md:235-246`).
 *
 * 1. Every tag in this table resolves to a directory that EXISTS ON DISK —
 *    `validateTagTable()` walks it; a test asserts every entry passes, so a
 *    renamed or retired project breaks the build rather than routing into a
 *    path nobody reads.
 * 2. An UNKNOWN tag — one not in this table at all — is HELD and reported,
 *    never guessed into the nearest match. `resolveTag()` returns `null`
 *    rather than a fuzzy best-effort; the caller is responsible for reporting
 *    that as `held-unknown-tag`, never for silently dropping the reminder.
 *
 * This table is the rot surface named in the spec's H4, and it is
 * provisional in the same sense the identity map is (`Shape`, plan:271-273):
 * a normalization table that maps a nickname to a workspace is exactly the
 * kind of thing that drifts the moment a project is renamed, and nothing
 * here pretends otherwise.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { HOME } from "../core/paths.mjs";

const GITHUB_ROOT = path.join(HOME, "Documents/GitHub");

/**
 * tag (lowercase, no `#`) -> { project, path }.
 *
 * Sourced from the spec's own worked example (`plan:26-28`):
 * `#ccusage` -> `claude-usage-widget`, which lives under `Rupali/`;
 * `#vipinkaushik` -> `Vipin Kaushik`.
 */
export const TAG_TABLE = Object.freeze({
  ccusage: Object.freeze({
    project: "Rupali/claude-usage-widget",
    path: path.join(GITHUB_ROOT, "Rupali", "claude-usage-widget"),
  }),
  vipinkaushik: Object.freeze({
    project: "Vipin Kaushik",
    path: path.join(GITHUB_ROOT, "Vipin Kaushik"),
  }),
});

/**
 * Look up a tag. Returns `null` for anything not in the table — deliberately
 * no fuzzy matching. A reader that cannot say "I did not understand this"
 * invents an answer (`rule:discernment-checks` §6); this function refuses to
 * be that reader.
 *
 * @param {string} tag lowercase, no leading `#`
 * @returns {{ project: string, path: string } | null}
 */
export function resolveTag(tag) {
  if (typeof tag !== "string") return null;
  const entry = TAG_TABLE[tag.toLowerCase()];
  return entry ?? null;
}

/**
 * Walk the whole table and report which entries resolve to a real directory.
 * Never throws — the caller (a test, or a runtime "fail loudly" surface)
 * decides what an unresolved entry means. An empty `broken` array is the
 * pass case.
 *
 * @returns {{ tag: string, project: string, path: string, exists: boolean }[]}
 */
export function validateTagTable() {
  return Object.entries(TAG_TABLE).map(([tag, entry]) => ({
    tag,
    project: entry.project,
    path: entry.path,
    exists: existsSync(entry.path),
  }));
}
