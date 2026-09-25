/**
 * normalize.mjs — one raw JXA reminder record -> the shape the rest of this
 * lane and L5 (the mutable-store lane that consumes this read path) share.
 *
 * F5, `docs/plans/2026-09-23-reminders-todo-bridge.md:247-259`. `completed`
 * comes from Reminders' own boolean, and the ONLY field ever reported as a
 * completion timestamp is `completionDate`. `modificationDate` is read off
 * the raw record (osascript.mjs includes it) and is carried through
 * unchanged for callers that want "last touched", but it is NEVER consulted
 * to decide whether an item is complete or when — this session's own write
 * to the live list bumped `modificationDate` by editing a body to add a tag,
 * with no completion change, so treating it as a completion signal would
 * have reported a false completion.
 */
import { extractTags } from "./parse.mjs";
import { resolveTag } from "./tags.mjs";

/**
 * @param {{id: string, name: string, body: string, completed: boolean, completionDate: string|null, modificationDate: string|null}} raw
 * @returns {{
 *   id: string, title: string, body: string,
 *   completed: boolean, completedAt: string|null, modifiedAt: string|null,
 *   tags: string[],
 *   route: { kind: "held-untagged" } | { kind: "held-unknown-tag", tag: string } | { kind: "routed", tag: string, project: string, path: string },
 * }}
 */
export function normalizeRecord(raw) {
  const completed = Boolean(raw?.completed);
  const tags = extractTags(raw?.body ?? "");

  return {
    id: String(raw?.id ?? ""),
    title: String(raw?.name ?? ""),
    body: String(raw?.body ?? ""),
    completed,
    // Authoritative clock for "when was this finished": completionDate, and
    // ONLY when Reminders itself says the item is completed. A completed
    // item with no completionDate (should not happen, but the API contract
    // does not forbid it) reports null rather than fabricating a time.
    completedAt: completed ? (raw?.completionDate ?? null) : null,
    // Carried through for diagnostics / "last touched" displays. Never read
    // by anything in this lane to decide completion — see module doc.
    modifiedAt: raw?.modificationDate ?? null,
    tags,
    route: routeFor(tags),
  };
}

/**
 * @param {string[]} tags lowercase, no leading `#`, as extractTags() returns
 */
function routeFor(tags) {
  if (tags.length === 0) return { kind: "held-untagged" };
  // First recognized tag wins; the spec names the body hashtag as
  // authoritative singular, not a priority list — a reminder carrying two
  // tags is not a case this plan scopes, and inventing a merge rule for it
  // would be exactly the guessing F4 forbids for unknown tags.
  const tag = tags[0];
  const entry = resolveTag(tag);
  if (!entry) return { kind: "held-unknown-tag", tag };
  return { kind: "routed", tag, project: entry.project, path: entry.path };
}
