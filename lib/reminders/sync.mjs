/**
 * sync.mjs — the orchestrator PR-021 asked for: decide which `new` routed
 * reminders become planned inserts into a project's register, and perform
 * them. `docs/plans/2026-09-23-reminders-todo-bridge.md` "Part 1 — the
 * inserter"; PR-021's DECISIONS.md entry (2026-09-25).
 *
 * `reconcile.mjs` IS NOT MODIFIED AND IS NOT CALLED WITH `apply: true` FROM
 * HERE. Its header states it never writes to a register and every row it
 * produces carries `writesToRegister: false` — true, and this module is why
 * it stays true. This is a SEPARATE composed stage: `reconcileReminders`
 * yields dispositioned, routed rows (always called with `apply: false` —
 * read-only, reused for its routing/disposition logic, nothing else); this
 * module owns 100% of the identity-map writes and the register writes for
 * a `sync` run, so there is exactly one writer of `identity-map.json`
 * per invocation and no ambiguity about write order.
 *
 * WRITE ORDER IS DECIDED (R3/D4): for a routed item that gets a register
 * insert, the sequence is REGISTER LINE FIRST, then `saveIdentityMap` with
 * `insertedAt`/`insertedInto`, then the insert-log row. A crash between the
 * register write and the map save leaves a DUPLICATE (visible in the file,
 * deletable by hand) — never a silent loss, because an item is never marked
 * `insertedAt` before its line exists on disk.
 *
 * IDEMPOTENCY (the load-bearing guarantee, not the dry-run checksum): an
 * identity whose map entry already carries `insertedAt` is reported
 * `already-inserted` and is never re-inserted, whatever `reconcileReminders`
 * would have called its disposition.
 *
 * REFUSALS ARE NAMED, NEVER SILENT. `held-no-register` (no TODOS.md/ISSUES.md
 * anywhere reachable for the routed project), `held-ambiguous-register` (the
 * canonical location is empty and a differently-shaped legacy file exists —
 * choosing between them is a decision about the tree, not a coding call),
 * `held-unrecognized-shape` (a register was found but its content does not
 * parse, OR it has no staging heading to insert under), `held-illegal-boundary`
 * (A2), `held-would-change-classification` (A3), `already-inserted` (the
 * idempotency hit).
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { readReminders } from "./read.mjs";
import { reconcileReminders } from "./reconcile.mjs";
import { resolveTag } from "./tags.mjs";
import { loadIdentityMap, saveIdentityMap, assignId, recordObservation, recordInsertion } from "./identity-map.mjs";
import { appendInsertLogEvent } from "./insert-log.mjs";
import { applyInsert } from "../registers/insert.mjs";
import { STATE_DIR } from "../core/config.mjs";
import { HOME } from "../core/paths.mjs";

const GITHUB_ROOT = path.join(HOME, "Documents/GitHub");

/**
 * The heading a staging entry lands under. Literal and exact, deliberately —
 * the plan's own worked example for the "reader's third state"
 * (`lib/report/backlog.mjs`'s `PROPOSED_SECTION_RE`, a companion change in a
 * separate lane) is this string. If that regex ships with different
 * wording, this heading and that pattern must be reconciled together — the
 * coupling is real even though the two lanes cannot see each other's code.
 */
export const STAGING_HEADING = "## From Reminders (unreviewed)";

/** Every disposition `syncReminders` can produce for a routed row, beyond
 *  what `reconcileReminders` already reports. Exported so a test can assert
 *  it looped over all of them. */
export const REFUSAL_DISPOSITIONS = Object.freeze([
  "held-no-register",
  "held-ambiguous-register",
  "held-unrecognized-shape",
  "held-would-change-classification",
  "held-illegal-boundary",
  "already-inserted",
]);

/**
 * A register's shape cannot be assumed (measured: 32 `TODOS.md` in the
 * tree, at least four conventions). Resolve which FILE a routed item's
 * project should insert into, conservatively: prefer the canonical
 * `propagation/state/<project>/TODOS.md` location
 * (`rule:state-and-decisions`); if that is absent and a differently-shaped
 * legacy repo-root `TODOS.md` exists instead, that is `held-ambiguous-register`
 * — deciding which one is canonical is a decision about the tree, not a
 * coding call (explicitly NOT in scope, plan "NOT in scope"). Absent both,
 * `held-no-register`.
 *
 * @param {{routePath: string}} args `routePath` is `route.path` from
 *   `normalize.mjs` — an absolute directory, either a workspace root
 *   (e.g. `.../Vipin Kaushik`) or a project nested one level under one
 *   (e.g. `.../Rupali/claude-usage-widget`).
 * @param {{githubRoot?: string, registerFileName?: string}} [opts]
 */
export function resolveRegisterCandidates({ routePath }, { githubRoot = GITHUB_ROOT, registerFileName = "TODOS.md" } = {}) {
  const rel = path.relative(githubRoot, routePath);
  const segments = rel.split(path.sep).filter(Boolean);
  const workspaceRoot = path.join(githubRoot, segments[0] ?? "");
  const isWorkspaceRootItself = segments.length <= 1;
  const canonicalDir = isWorkspaceRootItself
    ? path.join(workspaceRoot, "propagation", "state", "workspace")
    : path.join(workspaceRoot, "propagation", "state", segments[segments.length - 1]);
  const canonical = path.join(canonicalDir, registerFileName);
  const legacy = path.join(routePath, registerFileName);
  return { canonical, legacy };
}

/**
 * @param {{routePath: string}} args
 * @param {{githubRoot?: string, registerFileName?: string, exists?: (p: string) => boolean}} [opts]
 * @returns {{ok: true, registerPath: string} | {ok: false, code: "held-no-register"|"held-ambiguous-register", reason: string}}
 */
export function resolveRegisterTarget({ routePath }, { githubRoot = GITHUB_ROOT, registerFileName = "TODOS.md", exists = existsSync } = {}) {
  const { canonical, legacy } = resolveRegisterCandidates({ routePath }, { githubRoot, registerFileName });
  const canonicalExists = exists(canonical);
  const legacyExists = legacy !== canonical && exists(legacy);

  if (canonicalExists && !legacyExists) return { ok: true, registerPath: canonical };

  if (legacyExists) {
    return {
      ok: false,
      code: "held-ambiguous-register",
      reason: canonicalExists
        ? `both a canonical register (${canonical}) and a differently-shaped legacy one (${legacy}) exist`
        : `no canonical register at ${canonical}; a differently-shaped legacy one exists at ${legacy} — ` +
          "which one is canonical is a decision about the tree, not a coding call",
    };
  }

  return {
    ok: false,
    code: "held-no-register",
    reason: `no ${registerFileName} found at the canonical location (${canonical}) or the legacy repo-root location (${legacy})`,
  };
}

/**
 * Deriving todo-vs-issue: conservative and reported, never silent. Default
 * to `TODOS.md`; choose `ISSUES.md` only on a clear signal — a second tag
 * literally naming `bug` or `issue`. For the two live tags this branch has
 * no exercised target (per the plan, "folds into held-no-register").
 *
 * @param {{tags?: string[]}} item
 */
export function chooseRegisterFileName(item) {
  const extra = (item.tags ?? []).slice(1).map((t) => String(t).toLowerCase());
  if (extra.includes("bug") || extra.includes("issue")) return "ISSUES.md";
  return "TODOS.md";
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;

/**
 * Find a legal, existing anchor inside the staging section, or say why not.
 * The anchor is always the LAST line of the section body when that line is
 * blank (always A2-legal); when the section has no blank line, the anchor
 * is the section's last content line, legal only if a heading at or above
 * the staging heading's own level immediately follows (A2's other legal
 * shape). A staging section that is both blank-line-free AND runs to EOF
 * has no anchor this function can find safely — reported, not guessed.
 *
 * @param {string[]} lines 0-indexed `text.split("\n")`
 * @param {string} headingText exact heading line to find (`STAGING_HEADING`)
 * @returns {{ok: true, anchorLine: number, anchorText: string} | {ok: false, reason: string}}
 */
export function findStagingAnchor(lines, headingText = STAGING_HEADING) {
  const headingIdx = lines.findIndex((l) => l === headingText);
  if (headingIdx === -1) {
    return { ok: false, reason: `register has no staging heading ("${headingText}") — add one before inserting` };
  }
  const headingMatch = lines[headingIdx].match(HEADING_RE);
  const headingLevel = headingMatch[1].length;

  let sectionEnd = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i += 1) {
    const m = lines[i].match(HEADING_RE);
    if (m && m[1].length <= headingLevel) {
      sectionEnd = i;
      break;
    }
  }

  if (sectionEnd === headingIdx + 1) {
    // Empty section, no body at all — the heading line itself is a legal
    // anchor only if content is about to be inserted immediately before a
    // deeper or absent boundary; simplest and safest is to require at least
    // one blank line exist under the heading.
    return {
      ok: false,
      reason: `staging section ("${headingText}") is empty with no blank line under it — add one blank line first`,
    };
  }

  for (let i = sectionEnd - 1; i > headingIdx; i -= 1) {
    if (lines[i].trim() === "") {
      return { ok: true, anchorLine: i + 1, anchorText: lines[i] };
    }
  }

  // No blank line anywhere in the section body. The last content line is
  // still a legal anchor if a heading follows the section (A2's other legal
  // shape) — `applyInsert` will re-verify this itself; failing that here
  // early gives a clearer reason than A2's generic one.
  if (sectionEnd < lines.length) {
    return { ok: true, anchorLine: sectionEnd, anchorText: lines[sectionEnd - 1] };
  }

  return {
    ok: false,
    reason: `staging section ("${headingText}") has no blank line and is the last section in the file — cannot find a safe anchor`,
  };
}

/**
 * Compute the full sync plan for the current read, and — only when `apply`
 * is true — perform it. Every dry run (the default) touches neither the
 * register, the identity map, nor the insert log.
 *
 * @param {{
 *   readRemindersFn?: () => Promise<*>,
 *   stateDir?: string,
 *   apply?: boolean,
 *   now?: () => string,
 *   githubRoot?: string,
 *   readFileFn?: (p: string, enc: string) => Promise<string>,
 *   exists?: (p: string) => boolean,
 *   insertDeps?: object,
 *   saveIdentityMapFn?: (map: object, stateDir: string) => Promise<*>,
 *   resolveTagFn?: (tag: string) => {project: string, path: string} | null,
 * }} [opts]
 */
export async function syncReminders({
  readRemindersFn = readReminders,
  stateDir = STATE_DIR,
  apply = false,
  now = () => new Date().toISOString(),
  githubRoot = GITHUB_ROOT,
  readFileFn,
  exists = existsSync,
  insertDeps = {},
  saveIdentityMapFn = saveIdentityMap,
  resolveTagFn = resolveTag,
} = {}) {
  // Always a DRY read of reconcile — reconcile.mjs's own apply path is never
  // invoked here; this module owns every write for a sync run.
  const recon = await reconcileReminders({ readRemindersFn, stateDir, apply: false, now });
  if (!recon.ok) {
    return { ok: false, applied: false, reason: recon.reason, reasonDetail: recon.reasonDetail, code: recon.code };
  }

  // Re-read the raw items once more for `tags` (reconcile's rows carry only
  // the FIRST resolved tag, not the full list `chooseRegisterFileName`
  // needs). Cheap and read-only — the fixture/live read path is already
  // idempotent and this module makes no second osascript assumption: when a
  // fixture is in play (tests, or PROPAGATE_REMINDERS_FIXTURE), the same
  // fixture is read twice, deterministically.
  const raw = await readRemindersFn();
  const rawById = new Map((raw.ok ? raw.items : []).map((it) => [it.id, it]));

  let map = await loadIdentityMap(stateDir);
  const nowIso = now();
  const rows = [];
  // Deferred until the single, batched identity-map save below succeeds —
  // R3/D4's order (register -> map -> log) held over the WHOLE run: every
  // register write in this loop happens before the one map save, and every
  // log append happens strictly after it.
  const pendingLogEvents = [];

  for (const row of recon.rows) {
    if (row.disposition === "held-untagged" || row.disposition === "held-unknown-tag") {
      rows.push({ ...row });
      continue;
    }

    const priorEntry = map.entries[row.reminderId] ?? null;

    if (priorEntry?.insertedAt) {
      // IDEMPOTENCY. Never re-insert, never silently drop — reported like
      // no-change, per the plan's explicit instruction.
      const assigned = assignId(map, row.reminderId, nowIso);
      map = recordObservation(assigned.map, row.reminderId, { completed: row.completed, completedAt: row.completedAt });
      rows.push({
        ...row,
        disposition: "already-inserted",
        insertedAt: priorEntry.insertedAt,
        insertedInto: priorEntry.insertedInto,
      });
      continue;
    }

    if (row.disposition !== "new") {
      // A routed item this tool has already observed before, and never
      // inserted (e.g. it predates a register existing for its project).
      // Keep observation tracking current; not an insert candidate.
      const assigned = assignId(map, row.reminderId, nowIso);
      map = recordObservation(assigned.map, row.reminderId, { completed: row.completed, completedAt: row.completedAt });
      rows.push({ ...row });
      continue;
    }

    // A genuinely new routed item — a candidate for insertion.
    const assigned = assignId(map, row.reminderId, nowIso);
    map = assigned.map;
    map = recordObservation(map, row.reminderId, { completed: row.completed, completedAt: row.completedAt });

    const rawItem = rawById.get(row.reminderId);
    const tagEntry = resolveTagFn(row.tag);
    if (!tagEntry) {
      // Should not happen — reconcile already routed this row — but a
      // reader that cannot say "I did not understand this" invents an
      // answer (rule:discernment-checks §6); refuse attributably instead.
      rows.push({ ...row, disposition: "held-unrecognized-shape", reason: `tag "${row.tag}" no longer resolves` });
      continue;
    }

    const fileName = chooseRegisterFileName(rawItem ?? { tags: [row.tag] });
    const target = resolveRegisterTarget({ routePath: tagEntry.path }, { githubRoot, registerFileName: fileName, exists });
    if (!target.ok) {
      rows.push({ ...row, disposition: target.code, reason: target.reason });
      continue;
    }

    let fileText;
    try {
      fileText = readFileFn ? await readFileFn(target.registerPath, "utf8") : await readFile(target.registerPath, "utf8");
    } catch (err) {
      rows.push({ ...row, disposition: "held-unrecognized-shape", reason: `cannot read ${target.registerPath} — ${err.message}` });
      continue;
    }

    const lines = fileText.split("\n");
    const anchor = findStagingAnchor(lines);
    if (!anchor.ok) {
      rows.push({ ...row, disposition: "held-unrecognized-shape", reason: anchor.reason, registerPath: target.registerPath });
      continue;
    }

    const insertText = `### ${row.prId} · ${rawItem?.title ?? "(untitled)"}`;

    if (!apply) {
      // Plan only — never write. Still report exactly what WOULD happen,
      // via applyInsert's own A1/A2/A3 checks against the ACTUAL file
      // content, without persisting anything: the checks are pure over
      // `fileText`, so this reuses the same guards a real run would hit,
      // then reports "new" (would-insert) rather than performing it.
      const dryCheck = await applyInsert({
        file: target.registerPath,
        anchorLine: anchor.anchorLine,
        anchorExpected: anchor.anchorText,
        insertText,
        deps: { readFile: async () => fileText, writeFile: async () => {}, rename: async () => {} },
      });
      if (!dryCheck.ok) {
        rows.push({
          ...row,
          disposition: codeToDisposition(dryCheck.code),
          reason: dryCheck.error,
          registerPath: target.registerPath,
        });
      } else {
        rows.push({ ...row, disposition: "new", registerPath: target.registerPath, wouldInsert: insertText });
      }
      continue;
    }

    // APPLY — REGISTER WRITE FIRST (R3/D4). This lands on disk immediately;
    // the identity map is not touched here — it is batched into the single
    // save below, which runs strictly after every register write this run
    // makes. That ordering is what makes the silent-loss path unreachable:
    // no entry can be marked `insertedAt` before its register line exists.
    const inserted = await applyInsert({
      file: target.registerPath,
      anchorLine: anchor.anchorLine,
      anchorExpected: anchor.anchorText,
      insertText,
      deps: insertDeps,
    });
    if (!inserted.ok) {
      rows.push({
        ...row,
        disposition: codeToDisposition(inserted.code),
        reason: inserted.error,
        registerPath: target.registerPath,
      });
      continue;
    }

    map = recordInsertion(map, row.reminderId, { insertedAt: nowIso, insertedInto: target.registerPath });
    pendingLogEvents.push({
      ts: nowIso,
      reminderId: row.reminderId,
      prId: row.prId,
      registerFile: target.registerPath,
      anchorLine: inserted.anchorLine,
      anchorText: inserted.anchorText,
      insertedText: inserted.insertedText,
    });

    rows.push({ ...row, disposition: "new", registerPath: target.registerPath, inserted: insertText });
  }

  const summary = { total: rows.length, byDisposition: {} };
  for (const row of rows) summary.byDisposition[row.disposition] = (summary.byDisposition[row.disposition] ?? 0) + 1;

  if (apply) {
    // THEN the identity map — one save for the whole run, after every
    // register write above has already landed. If this fails, every
    // register write already on disk stands (a crash here leaves a
    // DUPLICATE on the next run, visible and human-deletable — the accepted
    // failure mode per R3 — never a silent loss), and no log row is
    // appended for an insertion the map does not yet know happened.
    try {
      await saveIdentityMapFn(map, stateDir);
    } catch (err) {
      return {
        ok: false,
        applied: false,
        reason: "identity-map-save-failed",
        reasonDetail:
          `register write(s) in this run succeeded and stand; the identity map failed to save — ${err.message}. ` +
          "A retry may insert a duplicate for the affected reminder(s); nothing was silently lost.",
        list: recon.list,
        rows,
        summary,
      };
    }

    // THEN the insert log — content-anchored, never by line number.
    for (const ev of pendingLogEvents) await appendInsertLogEvent(ev, stateDir);
  }

  return { ok: true, applied: apply, list: recon.list, rows, summary, writesToRegister: apply };
}

/** Map an `insert.mjs` refusal code onto this lane's disposition vocabulary.
 *  Exported so a test can assert the mapping directly. `anchor-moved` folds
 *  into `held-illegal-boundary` deliberately: by the time `sync.mjs` calls
 *  `applyInsert`, the anchor was already re-derived from a fresh read
 *  (`findStagingAnchor`) — a race at that point means the position this run
 *  planned is no longer a boundary this run can still vouch for, which is
 *  the same fact `held-illegal-boundary` names, not a new one. */
export function codeToDisposition(code) {
  if (code === "illegal-boundary" || code === "anchor-moved") return "held-illegal-boundary";
  if (code === "would-change-classification") return "held-would-change-classification";
  return "held-unrecognized-shape";
}
