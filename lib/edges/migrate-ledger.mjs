/**
 * migrate-ledger: roll a sub-project's PROPAGATION_LEDGER.jsonl into a parent
 * workspace's ledger. The tool `docs/DECISIONS.md` (2026-08-10, "the 69
 * misfiled hub rows are deferred") specifies: append-only close-and-re-emit
 * with a manifest and a rollback path — never an in-place rewrite.
 *
 * Four hazards this must handle (same DECISIONS entry):
 *  - ids are per-file `max+1` — never carry a source id across.
 *  - `source`/`downstream[].path` are workspace-relative — rewrite per dest.
 *  - `status_change` rows must be re-pointed to the new id, or the closure
 *    detaches from its row.
 *  - `markStatus` against the wrong file silently no-ops, so a half-applied
 *    migration is invisible — this module never uses `markStatus`.
 *
 * WHY THIS DOES NOT CALL `appendRow`/`appendRowWithId` FROM `lib/edges/ledger.mjs`:
 * both stamp `timestamp: new Date().toISOString()` unconditionally (see their
 * source — the object literal's `timestamp:` key always wins over whatever the
 * caller passed in the spread). That is correct for their normal callers, which
 * are recording an event as it happens. It is wrong here: step 3/4 of the spec
 * require preserving the ORIGINAL timestamp of the row being migrated. So this
 * module reimplements the same locking pattern (`acquireLock`, same retry
 * budgets) directly against `lib/core/lock.mjs`, and computes the next id by
 * scanning ALL raw parsed rows (not just `readLedger`'s folded Event map) —
 * deliberately wider than `nextId`/`appendRowWithId`'s fold-based max, which
 * excludes `manual` rows from the id space and can under-count it (see
 * `docs/DATA_MODEL.md` §7 — the `manual` id-collision case). `lib/edges/ledger.mjs`
 * is never imported by this module at all — it owns writing the live ledger
 * store and rendering its Markdown, neither of which this module does.
 *
 * BRANCH-AWARE EXTENSION (docs/ISSUES.md N25 — "a ledger is read from the
 * working tree, so its state is whatever branch is checked out"). Two new
 * source modes, on top of the original working-tree read:
 *
 *  - `fromRef: "<ref>"` — read the ledger as it exists at one ref via
 *    `git show <ref>:<path>`. NEVER `git checkout`.
 *  - `allRefs: true` — sweep EVERY local branch of the source repo
 *    (`enumerateRefs`, reused rather than re-implemented per the brief),
 *    read each one the same read-only way, and migrate the UNION.
 *
 * Sweeping introduces two new problems the single-source path never had:
 *
 *  1. Ledger ids are per-file `max+1` and MEANINGLESS across refs — the same
 *     logical row can carry a different id on every branch that has it.
 *     Identity across refs is therefore keyed on `(type, source, timestamp)`
 *     instead (`dedupeKey`), and a row seen on N branches migrates exactly
 *     ONCE, attributed to the first branch (in `orderBranches` order) that
 *     had it. The other N-1 sightings are recorded, not migrated.
 *  2. Idempotency across ref-mode re-runs needs a WIDER key than the
 *     single-source path's `(ledger, oldId)`, because two different branches
 *     can legitimately both have an id "001" that are NOT the same row. The
 *     migrated-index and in-run id map are keyed on `(ledger, ref, oldId)`
 *     whenever ref-mode is used; `ref` is omitted from the key (and from
 *     `migrated_from`) in the plain working-tree mode, so existing single-source
 *     behaviour and its manifest shape are byte-identical to before this change.
 */

import { readFile, appendFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { acquireLock } from "../core/lock.mjs";
import { enumerateRefs } from "./refs.mjs";
import { findRepoRoot } from "../core/git-context.mjs";

const ROW_OPENING_TYPES = new Set(["drift", "code_drift", "manual"]);

/** Parse a JSONL blob into rows, in file order. Malformed lines dropped —
 * same discipline as the live fold (`readLedgerWithStats`). */
function parseJsonlLines(text) {
  const lines = String(text ?? "").split("\n").filter((l) => l.trim().length > 0);
  const rows = [];
  for (const line of lines) {
    try {
      rows.push(JSON.parse(line));
    } catch {
      // malformed — not this tool's job to repair; skip it same as the fold does.
    }
  }
  return rows;
}

/** Read every physical line of a working-tree ledger, parsed, in file order. */
async function readRawRows(jsonlPath) {
  if (!existsSync(jsonlPath)) return [];
  const raw = await readFile(jsonlPath, "utf8");
  return parseJsonlLines(raw);
}

/** The widest id-space scan: any row (any type) carrying a numeric `id`. */
function maxIdAcrossRawRows(rows) {
  return rows.reduce((m, r) => {
    const n = parseInt(r?.id, 10);
    return Number.isFinite(n) && n > m ? n : m;
  }, 0);
}

/**
 * Derive the destination-relative prefix for a source workspace, from the two
 * ledger paths alone — never hardcoded. A ledger lives at
 * `<workspace-root>/<docsdir>/PROPAGATION_LEDGER.jsonl`, so the workspace root
 * is two `dirname()`s up from the ledger file.
 */
export function deriveRoots(fromPath, intoPath) {
  const sourceRoot = path.dirname(path.dirname(path.resolve(fromPath)));
  const destRoot = path.dirname(path.dirname(path.resolve(intoPath)));
  const prefix = path.relative(destRoot, sourceRoot);
  return { sourceRoot, destRoot, prefix };
}

/** Rewrite a workspace-relative path to be relative to the destination root. */
function relocatePath(oldPath, prefix) {
  if (!prefix || path.isAbsolute(oldPath)) return oldPath;
  return path.posix.join(prefix.split(path.sep).join("/"), oldPath);
}

function relocateRow(row, prefix) {
  const out = { ...row };
  delete out._ref;
  delete out._head;
  if (typeof out.source === "string") out.source = relocatePath(out.source, prefix);
  if (Array.isArray(out.downstream)) {
    out.downstream = out.downstream.map((d) =>
      d && typeof d.path === "string" ? { ...d, path: relocatePath(d.path, prefix) } : d,
    );
  }
  return out;
}

function gitHeadOf(root) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null; // not a git repo, or no commits yet — not this tool's job to fix
  }
}

/** Resolve `ref` (branch, tag, or sha) to a commit sha in `repoRoot`, read-only.
 * Returns null rather than throwing — a ref that doesn't resolve is reported
 * by the caller as a skipped ref, never a crash. */
function resolveRefHead(repoRoot, ref) {
  try {
    return execFileSync("git", ["rev-parse", ref], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** Read `relPath` as it exists AT `ref`, via `git show` — never `git checkout`.
 * Distinguishes "the ref just has no ledger there" (a normal, reportable
 * outcome) from other git failures, but both come back as `{content: null,
 * error}` — the caller's job is to report either as a skipped ref, never
 * silently. */
function gitShowAtRef(repoRoot, ref, relPath) {
  try {
    const out = execFileSync("git", ["show", `${ref}:${relPath}`], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { content: out, error: null };
  } catch (err) {
    const raw = (err && (err.stderr || err.message)) || String(err);
    return { content: null, error: String(raw).trim() || "git show failed" };
  }
}

/**
 * Order branch names deterministically: a default branch first (if one can
 * be identified), then the rest alphabetically. "Default" is resolved
 * read-only and in this priority: `main`, then `master`, then whatever is
 * currently checked out (if it's in the branch list), then no default at all
 * (pure alphabetical). This is a heuristic, not a git concept — there is no
 * single authoritative "default branch" for a local repo with no remote.
 */
export function orderBranches(repoRoot, names) {
  let def = null;
  if (names.includes("main")) def = "main";
  else if (names.includes("master")) def = "master";
  else {
    try {
      const cur = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (cur && cur !== "HEAD" && names.includes(cur)) def = cur;
    } catch {
      // detached HEAD, no commits yet, or repo error — no default, alphabetical only.
    }
  }
  const rest = names.filter((n) => n !== def).sort();
  return def ? [def, ...rest] : rest;
}

/** Composite id-map key. Ref-mode migrations key on `(ref, oldId)` because the
 * same bare id can legitimately mean two different rows on two branches;
 * plain working-tree mode keys on `oldId` alone, unchanged from before this
 * extension, so its manifests and idempotency behaviour are unaffected. */
function idKey(ref, oldId) {
  return ref ? `${ref}::${oldId}` : oldId;
}

/**
 * Build the index of already-migrated old ids, from a `migrated_from` field
 * on destination rows: `{ ledger: <absolute source path>, ref?: <branch>, id: <old id> }`.
 * Scans RAW rows (not folded) since `migrated_from` lives on Event rows and
 * a folded row keeps every field spread onto it (§4 of DATA_MODEL.md).
 */
function buildMigratedIndex(destRawRows, absoluteFromPath) {
  const idx = new Map(); // idKey(ref, oldId) -> newId
  for (const r of destRawRows) {
    if (
      ROW_OPENING_TYPES.has(r.type) &&
      r.migrated_from &&
      r.migrated_from.ledger === absoluteFromPath &&
      typeof r.migrated_from.id === "string"
    ) {
      idx.set(idKey(r.migrated_from.ref || null, r.migrated_from.id), r.id);
    }
  }
  return idx;
}

/** Content identity of a row AS IT WOULD LOOK IN THE DESTINATION: (type, source,
 * timestamp) — the same triple `dedupeKey`/`flattenAndDedupe` use for cross-ref
 * identity, but computed on the RELOCATED (destination-relative) `source` so a
 * destination row and an about-to-be-migrated row compare like with like. */
function destContentKeyOf(row) {
  return `${row.type}|${row.source ?? ""}|${row.timestamp ?? ""}`;
}

/**
 * Id-independent, mode-independent duplicate guard: a Map from a destination
 * row's content identity to its (destination) id.
 *
 * Why this exists alongside `buildMigratedIndex`, not instead of it: the
 * `(ledger, ref, oldId)` index only recognizes a row as already-migrated if a
 * PRIOR run wrote it with a matching `ref` in `migrated_from` (or no `ref`, in
 * plain working-tree mode). It is blind to the very common case this bug
 * report measured live — a row migrated earlier in PLAIN mode (`migrated_from`
 * has no `ref`) is invisible to a later `--all-refs` run's ref-keyed index,
 * because ref-mode's key always carries a `ref` and plain mode's never does.
 * Content identity has no such mode dependency: the same logical row has the
 * same `(type, source, timestamp)` regardless of which mode wrote it.
 */
function buildDestContentIndex(destRawRows) {
  const idx = new Map(); // destContentKeyOf(row) -> destination id
  for (const r of destRawRows) {
    if (ROW_OPENING_TYPES.has(r.type)) {
      const key = destContentKeyOf(r);
      if (!idx.has(key)) idx.set(key, r.id);
    }
  }
  return idx;
}

/** Content identity of a TRANSITION as it would look in the destination:
 * (destination id, status, timestamp). Guards `status_change` rows the same
 * way `destContentKeyOf`/`buildDestContentIndex` guard events, one level
 * down — a transition only has meaning attached to a specific destination
 * row, so this is keyed on the DESTINATION id (already resolved via idMap),
 * never the source's per-branch old id. */
function destTransitionKeyOf(destId, status, timestamp) {
  return `${destId}|${status}|${timestamp}`;
}

function buildDestTransitionIndex(destRawRows) {
  const idx = new Set();
  for (const r of destRawRows) {
    if (r.type === "status_change") {
      idx.add(destTransitionKeyOf(r.id, r.status, r.timestamp));
    }
  }
  return idx;
}

/**
 * Atomically mint the next id in `jsonlPath` and append `rowWithoutId` AS GIVEN
 * — including whatever `timestamp` it already carries. Mirrors
 * `appendRowWithId`'s locking contract (same retry budget) without its
 * timestamp-stomping behaviour.
 */
async function atomicAppendPreservingTimestamp(jsonlPath, rowWithoutId) {
  await mkdir(path.dirname(jsonlPath), { recursive: true });
  if (!existsSync(jsonlPath)) await writeFile(jsonlPath, "");
  const release = await acquireLock(jsonlPath, { retries: 50, minDelayMs: 20, maxDelayMs: 200 });
  if (!release) throw new Error(`migrate-ledger: could not lock ${jsonlPath}`);
  try {
    const rows = await readRawRows(jsonlPath);
    const id = String(maxIdAcrossRawRows(rows) + 1).padStart(3, "0");
    const stamped = { ...rowWithoutId, id };
    await appendFile(jsonlPath, JSON.stringify(stamped) + "\n");
    return id;
  } finally {
    await release();
  }
}

/** Append a fully-formed row (already carrying `id` and `timestamp`) as-is. */
async function appendVerbatim(jsonlPath, row) {
  await mkdir(path.dirname(jsonlPath), { recursive: true });
  if (!existsSync(jsonlPath)) await writeFile(jsonlPath, "");
  const release = await acquireLock(jsonlPath, { retries: 8 });
  if (!release) throw new Error(`migrate-ledger: could not lock ${jsonlPath}`);
  try {
    await appendFile(jsonlPath, JSON.stringify(row) + "\n");
  } finally {
    await release();
  }
}

/** Identity of a row across refs: ids are per-file and meaningless cross-ref,
 * so identity is (type, source, timestamp) instead. */
function dedupeKey(row) {
  return `${row.type}|${row.source ?? ""}|${row.timestamp ?? ""}`;
}

/**
 * Gather source rows for one migration run, from either the working tree
 * (legacy, single "ref" of `null`) or a ref sweep (`fromRef` / `allRefs`).
 *
 * Returns `{ branchSets, skippedRefs }` where `branchSets` is
 * `[{ ref, head, rows }]` in the order rows should be processed (canonical
 * ref first), and `skippedRefs` is `[{ ref, reason }]` for every ref that was
 * considered but had no readable ledger there — reported, never silent
 * (`rule:discernment-checks` §2).
 */
async function gatherSourceRowSets({ absFrom, allRefs, fromRef }) {
  if (!allRefs && !fromRef) {
    const rows = await readRawRows(absFrom);
    return { branchSets: [{ ref: null, head: null, rows }], skippedRefs: [] };
  }

  const repoRoot = findRepoRoot(absFrom);
  if (!repoRoot) {
    throw new Error(
      `migrate-ledger: --all-refs/--from-ref requires --from to be inside a git repo ` +
        `(no .git found above ${absFrom})`,
    );
  }
  const relPath = path.relative(repoRoot, absFrom);

  let refNames;
  if (allRefs) {
    const { refs, error } = await enumerateRefs(repoRoot);
    if (error) {
      throw new Error(`migrate-ledger: could not enumerate refs for ${repoRoot}: ${error}`);
    }
    const names = [...new Set(refs.filter((r) => r.kind === "branch" && r.ref).map((r) => r.ref))];
    refNames = orderBranches(repoRoot, names);
  } else {
    refNames = [fromRef];
  }

  const branchSets = [];
  const skippedRefs = [];
  for (const ref of refNames) {
    const head = resolveRefHead(repoRoot, ref);
    if (!head) {
      skippedRefs.push({ ref, reason: "ref does not resolve to a commit" });
      continue;
    }
    const shown = gitShowAtRef(repoRoot, ref, relPath);
    if (shown.error) {
      skippedRefs.push({ ref, reason: `no ledger at this ref: ${shown.error}` });
      continue;
    }
    branchSets.push({ ref, head, rows: parseJsonlLines(shown.content) });
  }
  return { branchSets, skippedRefs };
}

/**
 * Flatten `branchSets` into one processing list, deduping row-opening events
 * on `dedupeKey` (identity across refs) in `branchSets` order — the first
 * branch to have a given logical row is canonical; later sightings are
 * recorded in `appearances` but neither their event nor their status_change
 * rows are queued for migration (their transition history is assumed
 * identical to the canonical branch's — true whenever the branches are
 * append-only forks of each other, which is the case this tool exists for;
 * see docs/ISSUES.md N25's "byte-identical" divergence).
 *
 * Returns `{ processRows, appearances, duplicates }`:
 *  - `processRows`: flat list, each row tagged with `_ref`/`_head`, ready for
 *    the same per-row loop the single-source path always used.
 *  - `appearances`: Map<dedupeKey, ref[]> — every ref a logical row was seen
 *    on, canonical first.
 *  - `duplicates`: [{ ref, oldId, key }] — sightings that were NOT migrated
 *    because an earlier branch already claimed that logical row.
 */
function flattenAndDedupe(branchSets) {
  const claimedBy = new Map(); // dedupeKey -> ref (the canonical one)
  const appearances = new Map(); // dedupeKey -> ref[]
  const duplicates = [];
  const processRows = [];

  for (const { ref, head, rows } of branchSets) {
    const duplicateIdsThisBranch = new Set();
    for (const row of rows) {
      if (!ROW_OPENING_TYPES.has(row.type)) continue;
      const key = dedupeKey(row);
      if (!appearances.has(key)) appearances.set(key, []);
      appearances.get(key).push(ref);
      if (!claimedBy.has(key)) {
        claimedBy.set(key, ref);
      } else {
        duplicateIdsThisBranch.add(row.id);
        duplicates.push({ ref, oldId: row.id, key });
      }
    }
    for (const row of rows) {
      if (ROW_OPENING_TYPES.has(row.type)) {
        if (duplicateIdsThisBranch.has(row.id)) continue;
        processRows.push({ ...row, _ref: ref, _head: head });
      } else if (row.type === "status_change") {
        if (duplicateIdsThisBranch.has(row.id)) continue;
        processRows.push({ ...row, _ref: ref, _head: head });
      }
    }
  }

  return { processRows, appearances, duplicates };
}

/**
 * Migrate every row of `fromPath` into `intoPath`. Dry-run by default —
 * `apply: true` writes. Never touches `fromPath` (or, in ref-mode, any ref of
 * its repo — reads are `git show`, never `git checkout`).
 *
 * @param {object} opts
 * @param {string} opts.fromPath - source ledger (read-only, never written)
 * @param {string} opts.intoPath - destination ledger
 * @param {boolean} [opts.apply] - false = dry-run (default)
 * @param {boolean} [opts.allRefs] - sweep every local branch of the source repo
 * @param {string} [opts.fromRef] - read the source ledger at exactly this ref
 * @returns {Promise<object>} result — see fields below
 */
export async function migrateLedger({ fromPath, intoPath, apply = false, allRefs = false, fromRef = null }) {
  if (allRefs && fromRef) {
    throw new Error("migrate-ledger: --all-refs and --from-ref are mutually exclusive");
  }

  const absFrom = path.resolve(fromPath);
  const absInto = path.resolve(intoPath);
  const { sourceRoot, destRoot, prefix } = deriveRoots(absFrom, absInto);

  // Degenerate-input guard: `--from X --into X` (or two paths whose ledgers
  // resolve to the same workspace root) must be REFUSED, not silently
  // no-op'd. Before this it only "worked" by luck — the content-dedupe guard
  // below (`destContentIndex`) happens to skip every row because it's already
  // present at the destination it just read from, which is not the same
  // thing as detecting the degenerate case, and was untested. A same-root
  // migrate is never a real operation: there is no "into" distinct from the
  // "from".
  if (absFrom === absInto) {
    throw new Error(`migrate-ledger: --from and --into are the same path (${absFrom}) — refusing a no-op migration`);
  }
  if (sourceRoot === destRoot) {
    throw new Error(
      `migrate-ledger: --from and --into resolve to the same workspace root (${sourceRoot}) — refusing a same-workspace migration`,
    );
  }
  const refMode = allRefs || Boolean(fromRef);

  const { branchSets, skippedRefs } = await gatherSourceRowSets({ absFrom, allRefs, fromRef });
  const { processRows, appearances, duplicates } = flattenAndDedupe(branchSets);

  const destRawRowsBefore = await readRawRows(absInto);
  const migratedIndex = buildMigratedIndex(destRawRowsBefore, absFrom);
  // ADDITIONAL guard, not a replacement for migratedIndex (see
  // buildDestContentIndex's header comment) — catches a row already present
  // in the destination under a DIFFERENT mode's migrated_from shape.
  const destContentIndex = buildDestContentIndex(destRawRowsBefore);
  // Same idea, one level down: a status_change asserting a (destination id,
  // status, timestamp) already present must not be appended again, or a
  // second `--all-refs --apply` writes a counterfeit close-row every time.
  // Mutated as this run appends transitions, so a duplicate later in THIS
  // SAME run is caught too, not only reuse across separate invocations.
  const destTransitionIndex = buildDestTransitionIndex(destRawRowsBefore);

  // key (idKey(ref, oldId)) -> newId. Includes ids resolved via migratedIndex
  // on a re-run, so status_change rows can still be matched even when their
  // event was skipped as already-migrated.
  const idMap = new Map(migratedIndex);
  const newlyCreated = []; // { newId, oldId, ref, appearedOnRefs? }

  let migrated = 0; // events newly appended this run
  let skipped = 0; // events already migrated, skipped this run
  let transitionsMigrated = 0;
  let transitionsSkipped = 0;
  let orphanTransitions = 0;

  for (const row of processRows) {
    const ref = refMode ? row._ref : null;
    if (ROW_OPENING_TYPES.has(row.type)) {
      const oldId = row.id;
      const key = idKey(ref, oldId);
      if (migratedIndex.has(key)) {
        skipped++;
        continue;
      }
      const relocated = relocateRow(row, prefix);

      // Id-independent, mode-independent duplicate guard (compare like with
      // like: destContentIndex holds DESTINATION-shaped keys, so this must
      // use `relocated.source`, never the source-relative `row.source`).
      const contentKey = destContentKeyOf({ type: row.type, source: relocated.source, timestamp: row.timestamp });
      if (destContentIndex.has(contentKey)) {
        idMap.set(key, destContentIndex.get(contentKey));
        skipped++;
        continue;
      }

      const withoutId = { ...relocated };
      delete withoutId.id;
      withoutId.migrated_from = ref
        ? { ledger: absFrom, ref, id: oldId }
        : { ledger: absFrom, id: oldId };
      if (ref) {
        withoutId.source_worktree = { branch: ref, commit: row._head || null };
      }

      const appearedOnRefs = appearances.get(dedupeKey(row));
      const multiRef = refMode && appearedOnRefs && appearedOnRefs.length > 1;

      if (apply) {
        const newId = await atomicAppendPreservingTimestamp(absInto, withoutId);
        idMap.set(key, newId);
        newlyCreated.push({
          newId,
          oldId,
          ref: ref || null,
          ...(multiRef ? { appearedOnRefs: [...appearedOnRefs] } : {}),
        });
      } else {
        // Dry-run: simulate id allocation without writing. Compute against the
        // raw rows seen so far (destination-before + anything "written" so far
        // in this simulation) so sequential dry-run ids don't collide with
        // each other either.
        const simulatedRows = [...destRawRowsBefore, ...newlyCreated.map((c) => ({ id: c.newId }))];
        const newId = String(maxIdAcrossRawRows(simulatedRows) + 1).padStart(3, "0");
        idMap.set(key, newId);
        newlyCreated.push({
          newId,
          oldId,
          ref: ref || null,
          ...(multiRef ? { appearedOnRefs: [...appearedOnRefs] } : {}),
        });
      }
      migrated++;
    } else if (row.type === "status_change") {
      const oldId = row.id;
      const key = idKey(ref, oldId);
      const newId = idMap.get(key);
      if (!newId) {
        // Same fate as the live fold (`readLedgerWithStats`'s `if (existing)`
        // with no `else`, docs/DATA_MODEL.md §4.2): a status_change addressing
        // an id this migration never saw an Event for. Dropped, not thrown —
        // migrating dangling data as-is would just relocate the same silence.
        orphanTransitions++;
        continue;
      }
      // Id-independent, mode-independent duplicate guard — the transition
      // analogue of the event-level `destContentIndex` check above. Catches
      // BOTH the case `migratedIndex` used to (this exact ref/oldId's
      // transition already migrated in a prior run) AND the case it could
      // never see (the row it belongs to was skipped via `destContentIndex`
      // because an EARLIER, DIFFERENT-MODE migration already wrote it —
      // that row's `idMap` entry resolves to a real destination id, but
      // `migratedIndex` has no key for it, so without this check the
      // transition would be re-appended as a counterfeit close-row on every
      // `--all-refs --apply`, unbounded).
      const transitionKey = destTransitionKeyOf(newId, row.status, row.timestamp);
      if (destTransitionIndex.has(transitionKey)) {
        transitionsSkipped++;
        continue;
      }
      const relocatedTransition = { ...row, id: newId };
      delete relocatedTransition._ref;
      delete relocatedTransition._head;
      if (apply) {
        await appendVerbatim(absInto, relocatedTransition);
      }
      // Record immediately (dry-run included) so a second identical
      // transition later in THIS SAME run is also caught, not only reuse
      // across separate invocations.
      destTransitionIndex.add(transitionKey);
      transitionsMigrated++;
    }
    // any other row.type (malformed/unknown) is already dropped by readRawRows'
    // JSON.parse guard, or falls through here silently — same as the live fold.
  }

  let manifestPath = null;
  if (apply && newlyCreated.length > 0) {
    manifestPath = await writeManifest({
      destRoot,
      sourceRoot,
      absFrom,
      absInto,
      newlyCreated,
      counts: {
        sourceEvents: processRows.filter((r) => ROW_OPENING_TYPES.has(r.type)).length + duplicates.length,
        migrated,
        skipped,
        transitionsMigrated,
        transitionsSkipped,
        orphanTransitions,
        duplicateEventsCollapsed: duplicates.length,
      },
      refsSwept: refMode ? branchSets.map((b) => ({ ref: b.ref, head: b.head })) : null,
      skippedRefs,
    });
  }

  return {
    from: absFrom,
    into: absInto,
    apply,
    sourceRoot,
    destRoot,
    prefix,
    migrated,
    skipped,
    transitionsMigrated,
    transitionsSkipped,
    orphanTransitions,
    idMap: newlyCreated,
    manifestPath,
    refMode,
    refsSwept: refMode ? branchSets.map((b) => ({ ref: b.ref, head: b.head })) : [],
    skippedRefs,
    duplicateEventsCollapsed: duplicates.length,
    duplicates,
  };
}

async function writeManifest({
  destRoot,
  sourceRoot,
  absFrom,
  absInto,
  newlyCreated,
  counts,
  refsSwept,
  skippedRefs,
}) {
  const slug = path.basename(sourceRoot);
  const dateStr = new Date().toISOString().slice(0, 10);
  const archiveDir = path.join(path.dirname(absInto), "archive");
  await mkdir(archiveDir, { recursive: true });
  const manifestPath = path.join(archiveDir, `migration-${slug}-${dateStr}.json`);

  const manifest = {
    createdAt: new Date().toISOString(),
    from: absFrom,
    into: absInto,
    sourceRoot,
    destRoot,
    sourceGitHead: gitHeadOf(sourceRoot),
    destGitHead: gitHeadOf(destRoot),
    counts,
    idMap: newlyCreated,
    refsSwept,
    skippedRefs,
  };

  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return manifestPath;
}
