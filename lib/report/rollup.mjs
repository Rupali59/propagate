/**
 * lib/report/rollup.mjs — the upstream view: "what have we built" and "what
 * is open", across every workspace, in one derivation.
 *
 * READ-ONLY, exactly like `backlog.mjs`'s own header: no migration, no edits
 * to any source file, ever, and — the constraint specific to THIS module —
 * **no `writeFileSync` anywhere in this file, not even a debug one.** A
 * later lane (`commands/rollup.mjs`) owns the only file in this codebase
 * allowed to write `ECOSYSTEM.md`. Threading a write in here would mean two
 * places can produce the artifact, which is exactly the two-ledger problem
 * `backlog.mjs:836-846` already refused in writing for a different pair of
 * files ("would create a second register to keep in sync").
 *
 * WHAT THIS MODULE IS, IN ONE LINE: a VIEW over two walks that already
 * exist (`backlog()` and `inventory()`), plus a render and a freshness
 * footer. It never re-walks the tree itself, never copies an item into a
 * second store, and never invents a status vocabulary — `STATUS` is
 * `inventory.mjs`'s, reused verbatim.
 *
 * WHY A CONTENT-HASH FOOTER AND NOT A TIMESTAMP: `rule:state-and-decisions`
 * — "a count in a state file rots faster than anything else in it" — applies
 * one layer up here: a `Last updated:` stamp records when the WRITER ran,
 * which tells a reader nothing about whether the tree has since moved. A
 * footer that names every INPUT and its hash lets a reader (or `rollup
 * --check` in the command layer) answer "is this still true" by re-deriving,
 * never by trusting a date.
 *
 * THE LOAD-BEARING DESIGN CHOICE IN THE FOOTER: the input set is the
 * EXPECTED set — every discovered owner's canonical
 * `propagation/state/workspace/STATE.md` path — not merely the set of files
 * the walk happened to find. A footer that only lists files that exist can
 * never notice a NEW file appearing (nothing to compare it against); it is a
 * check that cannot fail in exactly the case that matters
 * (`rule:discernment-checks` §1). So every owner gets a row, and the row's
 * value is one of a 12-hex hash, the literal `ABSENT`, or `UNREADABLE:<reason>`
 * — three distinguishable facts, never collapsed (§2: absence must be
 * attributable).
 *
 * ATTRIBUTION IS `nearestOwner`, NOT A STRING PREFIX. `groupForBrief`'s own
 * DEFAULT `workspaceOf` is `String(f).split("/")[0]` — a bare string-prefix
 * split that attributes `Keerti/Keerti-portfolio/…` to `Keerti` and makes
 * the nested workspace vanish (F7 in the rollup plan; the A2/A4 upward-
 * multiplication bug in latent form). This module NEVER uses that default —
 * every call into `groupForBrief` passes an explicit `workspaceOf` backed by
 * `lib/core/discovery.mjs`'s `nearestOwner`, and the coverage invariant
 * (`sum(perOwnerItemCount) === backlogResult.ranked.length`, no item in two
 * groups) is computed and returned, never merely assumed.
 *
 * THE OWNER SET IS WIDER THAN `discoverWorkspacesSync`'S MARKER-BASED
 * WORKSPACES, AND THAT IS DELIBERATE (`rule:enforcement-watches-itself`).
 * `discoverWorkspacesSync` only returns a directory as an "owner" if it (or
 * an ancestor before it, recursively) carries a `.propagates.yml` with
 * `workspace: true` — a LEDGER-BOUNDARY concept. propagate's OWN repo root
 * carries no such marker (verified 2026-08-31: `WORKSPACES` from
 * `lib/core/config.mjs` resolves to 14 entries and none of their roots ends
 * in `/propagate`; every file under this very repo would otherwise be
 * attributed to the hub workspace, and propagate — the tool that exists to
 * catch exactly this shape of blind spot — would be invisible in its own
 * rollup). `buildOwnerCandidates` below widens the candidate set to include
 * every depth-1 directory under each search root that is independently
 * version-controlled (`.git` present), which is the more honest predicate
 * for "is this a distinct, attributable thing" — and, as a second,
 * unconditional belt-and-suspenders layer, always includes THIS MODULE'S
 * OWN repo root, computed from `import.meta.url` rather than from any
 * config key (so it cannot be silently unconfigured the way `hubRoot`'s
 * removal nulled two integrations — G24 — because there is no key to omit).
 */

import { existsSync, readdirSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SEARCH_ROOTS, shortPath } from "../core/config.mjs";
import { discoverWorkspacesSync, nearestOwner } from "../core/discovery.mjs";
// Layout conformance is imported rather than reimplemented. `V3_REQUIRED` lives in
// exactly one place and `conformance()` already answers the question; restating the
// five required items here would be the ninth copy of a fact this tree has already
// paid for once (rule:tool-priority's nine divergent copies).
//
// This exists because of `rule:enforcement-watches-itself`. Measured 2026-08-31:
// `propagate/propagation/` holds `state/` and NOTHING ELSE — 1 of the 5 required
// items — so the tool that enforces this layout is the tree's least conformant
// workspace. The first render of ECOSYSTEM.md must say so. A render that reports
// propagate as conformant means this check is wrong, not that the tool is clean.
import { conformance, V3_REQUIRED } from "../core/v3-layout.mjs";
import {
  backlog,
  backlogDefects,
  groupForBrief,
  readTextSafe,
  affectsMatcher,
  bodiesByItem,
} from "./backlog.mjs";
import { inventory } from "./inventory.mjs";

// ─────────────────────────────────────────────────────────────────────────────
// Constants — the two walks' bounds, restated here (not imported) because
// `backlog.mjs`'s MAX_WALK_DEPTH/WALK_BUDGET_MS and `inventory.mjs`'s
// MAX_REPO_DEPTH/REPO_WALK_BUDGET_MS are module-private. Restated as a
// LITERAL rather than re-exported because they are display facts ("the two
// walks have different depth bounds, print both") — if either source module
// ever changes its bound, this being wrong is a visible, checkable
// discrepancy in the rendered Coverage section, not a silent one.
// ─────────────────────────────────────────────────────────────────────────────

const BACKLOG_WALK_DEPTH = 6;
const BACKLOG_WALK_BUDGET_MS = 20_000;
const INVENTORY_WALK_DEPTH = 3;
const INVENTORY_WALK_BUDGET_MS = 20_000;

const HERE = path.dirname(fileURLToPath(import.meta.url));
// lib/report/rollup.mjs -> propagate/ (two levels up).
const MODULE_ROOT = path.resolve(HERE, "../..");

export const ROLLUP_BODY_MARK = "<!-- propagate:rollup:body:start -->";
export const ROLLUP_FOOTER_MARK = "<!-- propagate:rollup:inputs v1";
const INPUT_SEP = " :: ";

function sha256OfText(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function shortHash(hex64) {
  return typeof hex64 === "string" ? hex64.slice(0, 12) : hex64;
}

/** propagate's own VERSION file, read directly — this module lives inside
 *  the repo it is describing, so there is no IO cost to reading one more
 *  three-byte file. Never throws: an unreadable VERSION reports "unknown"
 *  rather than crashing the whole rollup over a cosmetic footer field. */
function readVersion() {
  const { text, error } = readTextSafe(path.join(MODULE_ROOT, "VERSION"));
  return error ? "unknown" : text.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Owner candidates — see module header for why this is wider than
// `discoverWorkspacesSync`'s marker-based WORKSPACES.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `nearestOwner` (`lib/core/discovery.mjs`) ALWAYS resolves the file it is
 * given through `realpathSync` before comparing prefixes — its own doc
 * comment says why: "symlinks and worktree checkouts make the same file
 * reachable via more than one path." An owner root that is NOT equally
 * resolved silently fails to match on any machine where a path component is
 * a symlink — macOS is the concrete case: `/var` -> `/private/var`, so
 * `os.tmpdir()`-based paths (every test fixture in this file's own test
 * suite) never match a raw, un-resolved owner root. Caught by this module's
 * own test suite: a nested-owner fixture under a temp dir attributed BOTH
 * levels to "(outside any known root)" until this resolution was added.
 * `discoverWorkspacesSync` itself does NOT resolve its returned `root`
 * values (verified 2026-08-31) — a latent version of the same gap one layer
 * down, out of scope here since `discovery.mjs` is Lane A's and frozen for
 * this lane, but resolving on THIS side is sufficient: only one side of a
 * `startsWith` comparison needs to be canonical for both to agree, and
 * `nearestOwner` already canonicalises the other side.
 */
function resolveOwnerRoot(p) {
  try {
    return realpathSync(p);
  } catch {
    return p; // vanished between discovery and here -- fall back, never throw
  }
}

function buildOwnerCandidates(roots, discoveredWorkspaces) {
  const byRoot = new Map();
  const add = (w) => {
    const real = resolveOwnerRoot(w.root);
    if (!byRoot.has(real)) byRoot.set(real, { ...w, root: real });
  };

  for (const w of discoveredWorkspaces) add(w);

  for (const root of roots) {
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const full = path.join(root, e.name);
      if (existsSync(path.join(full, ".git"))) add({ root: full, name: e.name });
    }
  }
  // Unconditional self-inclusion. See module header — this is the mechanical
  // form of rule:enforcement-watches-itself, not dependent on the depth-1
  // scan above happening to reach this exact directory.
  add({ root: MODULE_ROOT, name: path.basename(MODULE_ROOT) });

  return [...byRoot.values()];
}

function ownerKeyFn(owners) {
  return (file) => {
    if (!file) return "(unknown)";
    const owner = nearestOwner(file, owners);
    return owner ? shortPath(owner.root) : "(outside any known root)";
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Register classification — the five renderings that must never collapse.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One discovered STATE.md/TODOS.md/ISSUES.md record (from `backlog()`'s
 * `stateFiles`/`todoFiles`/`issueFiles`) -> one of exactly five renderings.
 * `unreadable` and `unparsed` are kept as DIFFERENT renderings — collapsing
 * them is the exact mistake `backlogDefects`'s own comment names ("would
 * send someone to fix the wrong thing"): one is a permissions/IO problem,
 * the other is a format nothing recognises.
 */
function classifyRegister(f, registerKind) {
  if (f.error || f.format === "unreadable") {
    return { rendering: "unreadable", file: f.file, registerKind, detail: f.error || f.unparsed || "unreadable" };
  }
  if (f.format === "pointer-stub") {
    return { rendering: "pointer-stub", file: f.file, registerKind, detail: f.detail || f.stubReason || "pointer stub" };
  }
  if (f.format === "unrecognised") {
    return { rendering: "unparsed", file: f.file, registerKind, detail: f.unparsed || "format not recognised" };
  }
  // Remaining formats: state-live-sections (STATE.md), checkbox / id-keyed /
  // stub (TODOS.md, ISSUES.md). Each carries either `items` (STATE.md) or
  // `open` (the generic parser) as its count.
  const count = f.format === "state-live-sections" ? f.items.length : (f.open ?? f.items?.length ?? 0);
  if (f.stub || count === 0) {
    return { rendering: "empty", file: f.file, registerKind, detail: f.stubReason || "register parsed, 0 open items" };
  }
  return { rendering: "items-found", file: f.file, registerKind, count };
}

function registersByOwner(backlogResult, owners) {
  const map = new Map();
  const all = [
    ...backlogResult.stateFiles.map((f) => [f, "STATE.md"]),
    ...backlogResult.todoFiles.map((f) => [f, "TODOS.md"]),
    ...backlogResult.issueFiles.map((f) => [f, "ISSUES.md"]),
  ];
  for (const [f, kind] of all) {
    const owner = nearestOwner(f.file, owners);
    const key = owner ? shortPath(owner.root) : "(outside any known root)";
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(classifyRegister(f, kind));
  }
  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// The footer's expected-input value for one owner's canonical STATE.md.
// ─────────────────────────────────────────────────────────────────────────────

function canonicalStatePath(owner) {
  return path.join(owner.root, "propagation", "state", "workspace", "STATE.md");
}

/**
 * The footer's whole point is to notice a file the WALK's own bounds might
 * miss — so this checks the discovered `backlogResult.stateFiles` FIRST (to
 * avoid a second read of a file the walk already read), but falls back to a
 * direct `existsSync`/`readTextSafe` when the canonical path is not in that
 * list. That fallback is not a hypothetical: `backlog()`'s walk is bounded
 * by MAX_WALK_DEPTH/WALK_BUDGET_MS, and a canonical path deeper than the
 * bound, or reached after the budget expired, would otherwise read as
 * ABSENT when it is not.
 */
function inputValueFor(canonicalPath, backlogResult) {
  const found = (backlogResult.stateFiles ?? []).find((f) => f.file === canonicalPath);
  if (found) {
    if (found.error) return `UNREADABLE:${found.error}`;
    if (found.sha256) return shortHash(found.sha256);
  }
  if (!existsSync(canonicalPath)) return "ABSENT";
  const { text, error } = readTextSafe(canonicalPath);
  if (error) return `UNREADABLE:${error}`;
  return shortHash(sha256OfText(text));
}

// ─────────────────────────────────────────────────────────────────────────────
// rollup() — the derivation.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} [opts]
 * @param {string[]} [opts.searchRoots] — defaults to the live SEARCH_ROOTS.
 * @param {object} [opts.backlogResult] — pre-computed `backlog()` output, so
 *   a caller that already walked (notably `digest.mjs`, whose
 *   `buildSnapshot()` already calls `inventory()`) does not walk twice.
 * @param {object} [opts.inventoryResult] — pre-computed `inventory()` output.
 */
// ─────────────────────────────────────────────────────────────────────────────
// CROSS-FILED WORK — the blind spot this file otherwise has, in the exact shape
// this file exists to fix.
//
// Attribution everywhere else here is `nearestOwner`, which keys on the item's
// FILE PATH. That is right for "whose register is this" and wrong for "who is this
// ABOUT": an issue concerning `Vipin Kaushik/scripts/hygiene/lib/size-caps.sh`
// filed in propagate's own ISSUES.md is attributed to propagate, so nobody
// standing in Vipin Kaushik sees it. Measured 2026-09-01: 39 references to other
// repos across propagate's 41 entries, and `--affects "Vipin Kaushik"` finds 24
// items filed elsewhere about it.
//
// NOTHING IS COPIED. `lib/report/backlog.mjs` records the refusal that governs
// this — "Copying issues downward would create a second register to keep in sync
// — the two-ledger problem already filed as A2" — and it still holds. This is a
// DERIVED view, recomputed on every regeneration of a file that is itself derived.
// It never becomes a thing to keep in sync, and deleting it loses nothing. The
// difference from the thing A2 forbids is not cosmetic: a copy has to be closed
// twice, this cannot be closed at all.
//
// What changes is only REACH. `backlog --affects` already answered this question
// perfectly and was command-shaped, so the answer never arrived anywhere. Same
// defect as the one ECOSYSTEM.md exists to fix, one level down.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Open items filed in SOMEONE ELSE'S register that name this owner.
 *
 * One bodies pass for the whole tree (`bodiesByItem` caches by file), then
 * owners x items matching — never one re-walk per owner.
 *
 * Body matching is required, not belt-and-braces: `bodiesByItem`'s own header
 * records that heading-only matching found 2 cross-filed items for Vipin Kaushik
 * where bodies find 24, because an issue titled "N53 · The size-cap check reads
 * STATE.md at the pre-move path" never says whose size-cap check it is.
 */
/**
 * Does `text` refer to `name` as a PATH — `Vipin Kaushik/scripts/…` — rather than
 * merely containing the word?
 *
 * `affectsMatcher`'s `inText` is a bare lowercase substring test. That is right for
 * `backlog --affects`, which is opt-in: you type a name, you read the hits, you
 * judge. It is wrong here, because this lands in a GENERATED FILE that everyone
 * reads, where a loose count reads as authoritative.
 *
 * Measured 2026-09-01 with the loose matcher, on the live tree:
 *
 *   Rupali 75 · propagate 46 · Tathya 39 · Motherboard 35 · Vipin Kaushik 24
 *
 * "Rupali" is the author's name and appears in nearly every entry ("Rupali's
 * call", "Rupali asked"); "propagate" is both the tool and an ordinary verb;
 * "Tathya" is the org. Those three counts are close to pure noise, and publishing
 * them would make the rollup's least reliable number its most prominent one.
 *
 * This is the sixth over-broad matcher measured in two days — N35's fingerprint
 * (too narrow), N63's bucket (too broad), a date suppressor, a `-maxdepth 2`, an
 * `authority: counsel` edge, and now this. The pattern is always the same: a
 * coarse instrument asserting a fine-grained claim. The fix is never a cleverer
 * regex; it is matching the thing that actually carries the meaning.
 *
 * What carries the meaning is a PATH. The motivating case, N53, says
 * `Vipin Kaushik/scripts/hygiene/lib/size-caps.sh` — a cross-repo reference is
 * almost always a path, because that is how you name someone else's file. A
 * trailing slash is cheap, precise, and cannot match prose.
 */
function mentionsAsPath(text, name) {
  const t = String(text ?? "").toLowerCase();
  const n = String(name ?? "").toLowerCase();
  if (!t || !n) return false;
  return t.includes(`${n}/`);
}

export function crossFiledByOwner(backlogResult, owners, readFile) {
  const out = new Map(owners.map((o) => [o.key, []]));
  const ranked = backlogResult?.ranked ?? [];
  if (ranked.length === 0 || owners.length === 0) return out;

  let bodies;
  try {
    bodies = bodiesByItem(ranked, readFile);
  } catch {
    // A body read failing must not take down the whole rollup. Path matching
    // still works; the count is then a FLOOR, and the render says so.
    bodies = new Map();
  }

  for (const o of owners) {
    const { inPath, inText } = affectsMatcher(o.name || o.key);
    const hits = [];
    for (const it of ranked) {
      // "Elsewhere" is the whole point: an item living in this owner's own tree is
      // filed HERE and is already counted in its Open items list above. Sources are
      // checked too, matching `filterByAffects` — an item can be surfaced from a
      // file other than the one it lives in.
      const paths = [it.file, ...(it.sources ?? []).map((s) => s.file)];
      if (paths.some((pp) => inPath(pp))) continue;
      // `bodiesByItem` keys on the ITEM OBJECT, not on any id field — see its own
      // `bodies.set(items[i], …)`. Keying on `it.id` yields undefined for every
      // item, which silently reports "nothing filed elsewhere" for the entire tree.
      const body = bodies.get(it) ?? it.text ?? "";
      if (mentionsAsPath(body, o.name || o.key) || mentionsAsPath(it.text, o.name || o.key)) {
        hits.push(it);
      }
    }
    out.set(o.key, hits);
  }
  return out;
}

/**
 * Recently RESOLVED entries in someone else's register that name this owner.
 *
 * The gap this closes: propagate resolves an issue about another repo and that
 * repo learns nothing. `backlog()` cannot answer it — it returns OPEN items only
 * (`closedSectionLines` strips the rest), which is correct for a backlog and
 * useless here. So this reads the issue registers directly.
 *
 * A resolved entry naming your repo is NEWS in both directions: either a hazard
 * you carried is gone, or a fix landed elsewhere that your repo must now follow.
 * Neither reaches you today by any mechanism.
 *
 * WINDOW, and why there is one. Without a bound this grows forever and becomes
 * the thing nobody reads. 30 days is the shortest window that still spans the
 * cadence these registers are actually triaged at — the last full triage pass was
 * 2026-08-20, 12 days before this was written. Entries whose heading carries no
 * date are reported SEPARATELY rather than dropped or assumed recent: undated and
 * out-of-window are different facts (`rule:discernment-checks` §2).
 */
export const RESOLVED_WINDOW_DAYS = 30;

export function resolvedElsewhereByOwner(backlogResult, owners, now = new Date(), readFile) {
  const out = new Map(owners.map((o) => [o.key, { dated: [], undated: [] }]));
  const files = (backlogResult?.issueFiles ?? []).map((f) => f.file).filter(Boolean);
  if (files.length === 0 || owners.length === 0) return out;

  const read = readFile ?? ((f) => readTextSafe(f).text ?? "");
  // `now` is injected so this is deterministic under test — the module must not
  // reach for the wall clock, or the window silently moves under the fixtures.
  const cutoff = new Date(now).getTime() - RESOLVED_WINDOW_DAYS * 86_400_000;

  // One pass per register file: collect its finished headings and their bodies.
  const entries = [];
  for (const file of files) {
    let text;
    try { text = read(file); } catch { continue; }
    if (!text) continue;
    const lines = String(text).split("\n");
    let cur = null;
    for (const line of lines) {
      if (/^#{2,4} /.test(line)) {
        if (cur) entries.push(cur);
        // Same finished vocabulary as lib/report/registers.mjs, matched on the
        // HEADING only. Deliberately not re-stated as a new list: if that module
        // widens its vocabulary this must widen with it, and a second copy is one
        // edit from being the copy that disagrees.
        const finished = /\b(RESOLVED|MOOT|CLOSED|SUPERSEDED|WONTFIX)\b/.test(line);
        cur = finished ? { file, heading: line.trim(), body: "" } : null;
      } else if (cur) {
        cur.body += line + "\n";
      }
    }
    if (cur) entries.push(cur);
  }

  for (const o of owners) {
    const { inPath, inText } = affectsMatcher(o.name || o.key);
    for (const e of entries) {
      if (inPath(e.file)) continue; // filed here, not elsewhere
      // Path-shaped, same reason as crossFiledByOwner — see mentionsAsPath.
      const nm = o.name || o.key;
      if (!mentionsAsPath(e.heading, nm) && !mentionsAsPath(e.body, nm)) continue;
      const m = e.heading.match(/(20\d{2})-(\d{2})-(\d{2})/);
      const bucket = out.get(o.key);
      if (!m) { bucket.undated.push(e); continue; }
      const when = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      if (when >= cutoff) bucket.dated.push({ ...e, resolvedISO: `${m[1]}-${m[2]}-${m[3]}` });
    }
  }
  return out;
}

export function rollup({ searchRoots, backlogResult, inventoryResult } = {}) {
  const roots = searchRoots ?? SEARCH_ROOTS;
  const backlogRes = backlogResult ?? backlog({ searchRoots: roots });
  const inventoryRes = inventoryResult ?? inventory({ searchRoots: roots });

  const discovery = discoverWorkspacesSync(roots);
  const owners = buildOwnerCandidates(roots, discovery.workspaces);
  const workspaceOf = ownerKeyFn(owners);

  // ---- Backlog attribution + the coverage invariant -----------------------
  const brief = groupForBrief(backlogRes.ranked, { workspaceOf });

  const summedItems = [...brief.groups.values()].reduce((n, g) => n + g.length, 0);
  const seen = new Set();
  let duplicateAssignment = false;
  for (const group of brief.groups.values()) {
    for (const item of group) {
      if (seen.has(item)) duplicateAssignment = true;
      seen.add(item);
    }
  }
  const coverage = {
    rankedLength: backlogRes.ranked.length,
    listed: brief.listed,
    summedItems,
    duplicateAssignment,
    // `listed` is groupForBrief's OWN loss detector ("`listed` MUST equal
    // `ranked.length`" — its doc comment); `summedItems` is this module's
    // independent recount from the groups it actually returned. Both must
    // hold, and neither is trusted on the other's say-so.
    ok: brief.listed === backlogRes.ranked.length && summedItems === backlogRes.ranked.length && !duplicateAssignment,
  };

  // ---- Registers (renderings 1-5) ------------------------------------------
  const registers = registersByOwner(backlogRes, owners);
  const defects = backlogDefects(backlogRes);

  // ---- "What was built" (inventory) attribution ----------------------------
  const builtByOwner = new Map();
  const builtUnscoped = [];
  const allInvItems = [
    ...inventoryRes.categories.skills,
    ...inventoryRes.categories.plugins,
    ...inventoryRes.categories.repos,
    ...inventoryRes.categories.standalone,
  ];
  for (const item of allInvItems) {
    const owner = item.artifacts ? nearestOwner(item.artifacts, owners) : null;
    if (!owner) {
      builtUnscoped.push(item);
      continue;
    }
    const key = shortPath(owner.root);
    if (!builtByOwner.has(key)) builtByOwner.set(key, []);
    builtByOwner.get(key).push(item);
  }

  // ---- Per-owner assembly ---------------------------------------------------
  // Union of every key that appears ANYWHERE, union every discovered owner's
  // own key — so an owner with zero backlog items, zero registers and zero
  // built items still gets a printed, empty row (rendering #2/#5), never a
  // silently omitted one. "Found nothing" and "looked at nothing" are
  // different facts and only the former belongs here.
  const allOwnerKeys = new Set([
    ...owners.map((o) => shortPath(o.root)),
    ...brief.groups.keys(),
    ...registers.keys(),
    ...builtByOwner.keys(),
  ]);

  // key -> the owner's absolute root, so the renderer can show a NAME rather than a
  // machine-specific absolute path. `shortPath` cannot shorten SEARCH_ROOTS[0] itself
  // — it only strips a `root + "/"` prefix — so the hub was rendering as
  // `### /Users/<name>/Documents/GitHub`, the one row leaking a local path into a
  // TRACKED file. Every other row was already a name.
  // Computed once for the whole tree, before the per-owner map is built.
  const ownerRefs = owners.map((o) => ({ key: shortPath(o.root), name: o.name }));
  const crossFiled = crossFiledByOwner(backlogRes, ownerRefs);
  const resolvedElsewhere = resolvedElsewhereByOwner(backlogRes, ownerRefs, new Date());

  const rootByKey = new Map(owners.map((o) => [shortPath(o.root), o.root]));
  const nameByKey = new Map(owners.map((o) => [shortPath(o.root), o.name]));

  const perOwner = [...allOwnerKeys].sort().map((key) => {
    const ownerRegisters = registers.get(key) ?? [];
    const root = rootByKey.get(key) ?? null;
    return {
      owner: key,
      // Display name, never an absolute path. Falls back to the key for a group that
      // came from the brief/registers rather than from a discovered workspace.
      display: nameByKey.get(key) || (root ? path.basename(root) : key),
      items: brief.groups.get(key) ?? [],
      registers: ownerRegisters,
      hasNoRegister: ownerRegisters.length === 0,
      built: builtByOwner.get(key) ?? [],
      // Work filed in someone ELSE'S register that names this owner, and recently
      // resolved work likewise. Derived every run, never copied — see the
      // CROSS-FILED WORK block above for why that distinction is load-bearing.
      crossFiled: crossFiled.get(key) ?? [],
      resolvedElsewhere: resolvedElsewhere.get(key) ?? { dated: [], undated: [] },
      // Three states, never two: conformant / non-conformant with the missing items
      // named / `null` meaning NOT A DISCOVERED WORKSPACE so the question does not
      // apply. `rule:enforcement-watches-itself` §4 — "found nothing" and "looked at
      // nothing" must render differently, and "the question does not apply" is a
      // third fact again.
      layout: root ? conformance(root) : null,
    };
  });

  // ---- Footer inputs: the EXPECTED set, sorted for a stable render --------
  const inputs = new Map(
    owners
      .map((o) => {
        const canonical = canonicalStatePath(o);
        return [shortPath(canonical), inputValueFor(canonical, backlogRes)];
      })
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
  );

  return {
    generatedAt: new Date().toISOString(),
    generator: `propagate ${readVersion()}`,
    owners: owners.map((o) => ({ root: o.root, key: shortPath(o.root), name: o.name })),
    perOwner,
    coverage,
    defects,
    builtUnscoped,
    inventoryCounts: inventoryRes.counts,
    inventoryProbeLimits: inventoryRes.probeLimits,
    mergedCount: backlogRes.mergedCount,
    walks: {
      backlog: {
        depth: BACKLOG_WALK_DEPTH,
        budgetMs: BACKLOG_WALK_BUDGET_MS,
        dropped: backlogRes.dropped,
        budgetExceeded: backlogRes.budgetExceeded,
      },
      inventory: {
        depth: INVENTORY_WALK_DEPTH,
        budgetMs: INVENTORY_WALK_BUDGET_MS,
        dropped: inventoryRes.dropped,
        budgetExceeded: inventoryRes.budgetExceeded,
      },
    },
    inputs,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// renderRollup() — pure. Everything the CLI/tests see comes from this
// function's return value; no decision that could LOSE an item lives outside
// it (same discipline as `groupForBrief`'s own header note).
// ─────────────────────────────────────────────────────────────────────────────

function walkStatusLine(walks) {
  const b = walks.backlog;
  const i = walks.inventory;
  const bStatus = b.budgetExceeded ? "BUDGET-EXCEEDED" : "ok";
  const iStatus = i.budgetExceeded ? "BUDGET-EXCEEDED" : "ok";
  return `backlog depth=${b.depth} budget=${b.budgetMs}ms ${bStatus} · inventory depth=${i.depth} budget=${i.budgetMs}ms ${iStatus}`;
}

// How many open items to list per owner before naming the command that derives
// the rest. NOT a hidden truncation: the remainder is always counted and the
// command printed. propagate alone listed 75 here, which turned a rollup into a
// dump — 1,116 lines for a file whose entire premise is that opening it teaches
// you what exists.
const ITEM_CAP = 8;

/**
 * `groupForBrief` truncates to BRIEF_TRUNC (90) chars on a raw slice, which lands
 * mid-word and — measured on the live tree — often mid-clause on a colon:
 *   "**P1 · gate-4 ledger creation.** doctor never reached clean on a fresh workspace:"
 * A fragment ending on a dangling separator is worse than a shorter clean one: the
 * reader cannot tell whether the thought was cut or the sentence was simply odd.
 * Trim trailing separators and mark the elision explicitly.
 */
function trimFragment(text) {
  if (typeof text !== "string") return String(text ?? "");
  const trimmed = text.replace(/[\s\u2014\u2013:;,-]+$/u, "");
  return trimmed.length < text.length ? trimmed + " …" : trimmed;
}

const RENDERING_LABEL = {
  "items-found": "OPEN",
  empty: "EMPTY",
  "pointer-stub": "POINTER STUB",
  unreadable: "UNREADABLE",
  unparsed: "UNPARSED",
};

export function renderRollup(result) {
  const header = [
    "# ECOSYSTEM.md",
    "",
    "GENERATED by `propagate rollup`. **Do not hand-edit.** A hand edit is detected via",
    "the footer's `body:` hash and the next run REFUSES — exit 3, nothing written —",
    "rather than clobbering it. If you have something to say here, it belongs in",
    "`NORTH_STAR.md`: that file is authored and states what we are building TOWARD;",
    "this one is derived and states only what EXISTS.",
    "",
    "No number below was typed. To check this file is current without re-reading it:",
    "",
    "    propagate rollup --check   # 0 current · 1 stale · 2 could-not-run · 3 hand-edited",
  ];

  // Coverage is PROVENANCE, not content, so it renders after the answer rather than
  // in front of it. It used to occupy lines 11-95 — 85 lines of "max depth 6 reached"
  // before a reader saw a single fact, in a file whose entire premise is that opening
  // it teaches you what exists. Nothing is dropped or truncated here: "never silently
  // omitted" still holds. It is only MOVED.
  // The answer.
  const content = [];

  const coverage = [];
  coverage.push("## Coverage — what this walk saw, and did not");
  coverage.push("");
  coverage.push(
    `- Backlog walk: depth=${result.walks.backlog.depth}, budget=${result.walks.backlog.budgetMs}ms, ` +
      `${result.walks.backlog.budgetExceeded ? "BUDGET EXCEEDED" : "completed within budget"}, ` +
      `${result.walks.backlog.dropped.length} path(s) dropped.`,
  );
  coverage.push(
    `- Inventory walk: depth=${result.walks.inventory.depth}, budget=${result.walks.inventory.budgetMs}ms, ` +
      `${result.walks.inventory.budgetExceeded ? "BUDGET EXCEEDED" : "completed within budget"}, ` +
      `${result.walks.inventory.dropped.length} path(s) dropped.`,
  );
  coverage.push(
    "- These two walks have DIFFERENT depth bounds (backlog 6, inventory 3) and are " +
      "never silently reconciled into one number — a register nested deeper than 3 " +
      "can appear in Per-workspace below and be absent from a workspace's Built list, " +
      "and that is a fact about the walk's bound, not a bug in this render.",
  );
  if (result.walks.backlog.dropped.length || result.walks.inventory.dropped.length) {
    coverage.push("");
    coverage.push("Dropped paths — never walked, not silently omitted:");
    for (const d of result.walks.backlog.dropped) coverage.push(`  - [backlog] ${d.path} — ${d.reason}`);
    for (const d of result.walks.inventory.dropped) coverage.push(`  - [inventory] ${d.path} — ${d.reason}`);
  }
  coverage.push("");
  coverage.push(
    `- Coverage invariant: ${result.coverage.summedItems} item(s) summed across ` +
      `${result.perOwner.length} owner group(s) == ${result.coverage.rankedLength} ranked item(s) ` +
      `— ${result.coverage.ok ? "HOLDS" : "VIOLATED"}.`,
  );
  if (result.defects.length > 0) {
    coverage.push("");
    coverage.push(`- ${result.defects.length} defect(s) (registers the tool cannot see into): ${result.defects.map((d) => `${d.kind}:${shortPath(d.file)}`).join(", ")}`);
  }
  coverage.push("");

  content.push("## Per-workspace");
  content.push("");
  for (const o of result.perOwner) {
    content.push(`### ${o.display ?? o.owner}`);
    content.push("");
    // Layout conformance, three-state. `null` means "not a discovered workspace, so
    // the question does not apply" — a THIRD fact, never rendered as a pass.
    if (o.layout) {
      if (o.layout.conforms) {
        content.push("**Layout** — conformant.");
      } else {
        content.push(
          `**Layout** — NON-CONFORMANT. Missing ${o.layout.missing.length} of ` +
            `${V3_REQUIRED.length} required items: ` +
            `${o.layout.missing.map((m) => `\`${m}\``).join(", ")}. ` +
            "Required by `docs/REFERENCE.md` §\"Propagation layout\".",
        );
      }
      content.push("");
    }
    if (o.hasNoRegister) {
      // Rendering #5 — no register at all.
      content.push(
        "_NO REGISTER — this owner is in the discovered set but appears in none of the " +
          "STATE.md / TODOS.md / ISSUES.md files either walk found._",
      );
    } else {
      for (const r of o.registers) {
        const label = RENDERING_LABEL[r.rendering];
        if (r.rendering === "items-found") {
          content.push(`- **${r.registerKind}** [${label}] \`${shortPath(r.file)}\` — ${r.count} open item(s).`);
        } else {
          content.push(`- **${r.registerKind}** [${label}] \`${shortPath(r.file)}\` — ${r.detail}`);
        }
      }
    }
    if (o.items.length > 0) {
      content.push("");
      content.push(`Open items (${o.items.length}):`);
      // CAP, and SAY SO. propagate alone listed 75 here, which turned a rollup into
      // a dump: 1,116 lines for a file whose whole premise is that opening it teaches
      // you what exists. A silent truncation would be worse than a long list — it
      // reads as "that is all there is", which is the exact failure this file exists
      // to prevent — so the remainder is counted and the command that derives the
      // full set is named, per the house rule in the hub STATE.md ("name the command
      // that derives the number, not the number").
      for (const it of o.items.slice(0, ITEM_CAP)) content.push(`  - ${trimFragment(it.briefText)}`);
      if (o.items.length > ITEM_CAP) {
        content.push(
          `  - _+${o.items.length - ITEM_CAP} more, not listed. Full set:` +
            ` \`propagate backlog --affects "${o.display ?? o.owner}"\`_`,
        );
      }
    }
    // Filed elsewhere — the answer `backlog --affects` already gave, moved onto the
    // read path. Rendered even at zero, because "nobody else has work about you" is
    // a fact worth stating and is not the same as "we did not look".
    const cf = o.crossFiled ?? [];
    content.push("");
    if (cf.length > 0) {
      content.push(
        `**Filed elsewhere about this workspace** — ${cf.length} open item(s), in someone ` +
          `else's register. None appear in the Open items above, which are this workspace's own.`,
      );
      for (const it of cf.slice(0, ITEM_CAP)) {
        content.push(`  - ${trimFragment(it.briefText ?? it.text ?? "")}  _(${shortPath(it.file)})_`);
      }
      if (cf.length > ITEM_CAP) {
        content.push(
          `  - _+${cf.length - ITEM_CAP} more. Full set:` +
            ` \`propagate backlog --affects "${o.display ?? o.owner}"\`_`,
        );
      }
    } else {
      content.push("**Filed elsewhere about this workspace** — none.");
    }

    // Recently resolved elsewhere. A resolved entry naming your repo is news in
    // both directions: a hazard you carried is gone, or a fix landed that you must
    // now follow. Nothing else in the tree tells you.
    const re = o.resolvedElsewhere ?? { dated: [], undated: [] };
    if (re.dated.length > 0 || re.undated.length > 0) {
      content.push("");
      content.push(
        `**Resolved elsewhere, last ${RESOLVED_WINDOW_DAYS} days** — ${re.dated.length} item(s)` +
          (re.undated.length > 0
            ? `, plus ${re.undated.length} finished but UNDATED (window could not be applied — not the same as out of window)`
            : "") +
          ".",
      );
      for (const e of re.dated.slice(0, ITEM_CAP)) {
        content.push(`  - ${e.resolvedISO} · ${trimFragment(e.heading.replace(/^#+\s*/, ""))}`);
      }
      if (re.dated.length > ITEM_CAP) {
        content.push(`  - _+${re.dated.length - ITEM_CAP} more._`);
      }
    }

    if (o.built.length > 0) {
      content.push("");
      content.push(`Built (${o.built.length}):`);
      for (const b of o.built) content.push(`  - [${b.status}] ${b.kind} — ${b.id}`);
    }
    content.push("");
  }

  if (result.builtUnscoped.length > 0) {
    content.push("## Tooling not attributable to any owner root");
    content.push("");
    content.push(
      "_Skills and plugins live under `~/.claude/`, outside every discovered owner root — " +
        "listed here rather than dropped._",
    );
    content.push("");
    for (const b of result.builtUnscoped) content.push(`- [${b.status}] ${b.kind} — ${b.id}`);
    content.push("");
  }

  // Provenance last — see the comment where `coverage` is declared. Nothing is
  // dropped or shortened by moving it; it is only no longer in front of the answer.
  content.push(...coverage);

  const preFooter =
    header.join("\n") + "\n\n" + ROLLUP_BODY_MARK + "\n\n" + content.join("\n") + "\n\n";

  const inputLines = [...result.inputs].map(([key, val]) => `  ${key}${INPUT_SEP}${val}`);
  const footerLines = [
    ROLLUP_FOOTER_MARK,
    "alg: sha256-12",
    `body: ${"0".repeat(12)}`, // placeholder — replaced below once bodyHash() can be computed
    `generator: ${result.generator}`,
    `walk: ${walkStatusLine(result.walks)}`,
    "inputs:",
    ...inputLines,
    "-->",
  ];
  const draft = preFooter + footerLines.join("\n") + "\n";

  // Compute the real hash by calling the SAME function a reader would call —
  // never hand-derive the slice a second, subtly different way. `bodyHash`
  // only reads text BETWEEN the two markers, so the footer's own (placeholder)
  // body value plays no part in what gets hashed.
  const hash = bodyHash(draft);
  const finalFooterLines = footerLines.map((l) =>
    l === `body: ${"0".repeat(12)}` ? `body: ${shortHash(hash)}` : l,
  );

  return preFooter + finalFooterLines.join("\n") + "\n";
}

// ─────────────────────────────────────────────────────────────────────────────
// bodyHash / parseFooter / compareInputs — the freshness mechanism.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * sha256 (full 64-hex) of the bytes strictly between the opening
 * `ROLLUP_BODY_MARK` and the start of the footer block. Returns `null` if
 * either marker is missing or out of order — a caller must not treat that
 * as a zero-length body.
 */
export function bodyHash(text) {
  const startIdx = text.indexOf(ROLLUP_BODY_MARK);
  const footerIdx = text.indexOf(ROLLUP_FOOTER_MARK);
  if (startIdx === -1 || footerIdx === -1 || footerIdx <= startIdx) return null;
  const body = text.slice(startIdx + ROLLUP_BODY_MARK.length, footerIdx);
  return sha256OfText(body);
}

/**
 * Parse the footer block. THREE outcomes, deliberately not two:
 *   - `null`                     — no footer marker anywhere in the text (ABSENT)
 *   - `{ malformed: true, ... }` — a footer marker exists but its body does
 *                                  not parse (MALFORMED)
 *   - `{ alg, body, generator, walk, inputs }` — parsed cleanly
 *
 * The task brief's own prose line for this function ("or null if
 * absent/malformed") collapses the second and third cases into `null`; this
 * implementation deliberately does NOT follow that line, because the same
 * brief's Task 3 requires a malformed footer to be "a distinguishable
 * 'malformed' result, NOT null-as-absent and NOT a throw" — and collapsing
 * "the marker is there but broken" into "the marker isn't there" is the
 * exact class of bug `rule:discernment-checks` §2/§6 exists to name: a
 * reader that cannot report ITS OWN failure reports absence instead, and
 * absence is the reading someone acts on. Flagged in the delivery report as
 * a place the brief and the shipped code disagree, per instruction.
 */
export function parseFooter(text) {
  const idx = typeof text === "string" ? text.indexOf(ROLLUP_FOOTER_MARK) : -1;
  if (idx === -1) return null;

  const end = text.indexOf("-->", idx);
  if (end === -1) {
    return { malformed: true, reason: "footer opening marker found but no closing '-->'" };
  }

  const block = text.slice(idx + ROLLUP_FOOTER_MARK.length, end);
  const lines = block.split("\n").map((l) => l.replace(/\r$/, ""));

  const algMatch = block.match(/^\s*alg:\s*(\S+)/m);
  const bodyMatch = block.match(/^\s*body:\s*([0-9a-f]+)\s*$/m);
  const generatorMatch = block.match(/^\s*generator:\s*(.+)$/m);
  const walkMatch = block.match(/^\s*walk:\s*(.+)$/m);
  const inputsHeaderIdx = lines.findIndex((l) => /^\s*inputs:\s*$/.test(l));

  if (!algMatch || !bodyMatch || !generatorMatch || !walkMatch || inputsHeaderIdx === -1) {
    return {
      malformed: true,
      reason:
        "footer block is missing one or more required fields (alg/body/generator/walk/inputs) — " +
        `found: alg=${Boolean(algMatch)} body=${Boolean(bodyMatch)} generator=${Boolean(generatorMatch)} ` +
        `walk=${Boolean(walkMatch)} inputsHeader=${inputsHeaderIdx !== -1}`,
    };
  }

  const inputs = new Map();
  for (let i = inputsHeaderIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const sepIdx = line.indexOf(INPUT_SEP);
    // Split on the LAST occurrence of the separator is wrong when a path
    // could contain it; splitting on the FIRST is correct here because the
    // key (a shortened path) may itself contain spaces (`Vipin Kaushik/…`)
    // but never contains the literal " :: " sequence, which is why that
    // string — not whitespace — is the delimiter.
    if (sepIdx === -1) continue; // tolerate a stray line rather than throw
    const key = line.slice(0, sepIdx).trim();
    const value = line.slice(sepIdx + INPUT_SEP.length).trim();
    if (key) inputs.set(key, value);
  }

  if (inputs.size === 0) {
    return { malformed: true, reason: "footer declared an 'inputs:' section with zero parsed rows" };
  }

  return {
    alg: algMatch[1],
    body: bodyMatch[1],
    generator: generatorMatch[1].trim(),
    walk: walkMatch[1].trim(),
    inputs,
  };
}

/**
 * Compare a stored input map (from a previous `parseFooter(...).inputs`)
 * against a freshly computed one. Exhaustive over EVERY key in either map —
 * a key present in only one side is treated as `ABSENT` on the other,
 * exactly like a fresh footer would report it.
 *
 * Four named buckets, chosen to answer the two questions that matter most:
 * "did something that already worked change" (`changed`), "did something
 * start existing" (`appeared`), "did something stop existing" (`vanished`),
 * and — the one a plain diff would bury — "did something that used to work
 * break" (`becameUnreadable`, checked FIRST so it always wins the
 * classification regardless of what the prior state was).
 *
 * Not every one of the nine possible (ABSENT|HASH|UNREADABLE) x
 * (ABSENT|HASH|UNREADABLE) transitions maps cleanly onto one of the four
 * names (e.g. UNREADABLE -> ABSENT, or UNREADABLE -> a new HASH). Those are
 * reported as `changed` rather than silently dropped — a comparator that
 * only names four of nine transitions and drops the rest is the same "check
 * that cannot fail" shape one level up (`rule:discernment-checks` §1).
 */
export function compareInputs(stored, current) {
  const out = { changed: [], appeared: [], vanished: [], becameUnreadable: [] };
  const storedMap = stored instanceof Map ? stored : new Map();
  const currentMap = current instanceof Map ? current : new Map();
  const keys = new Set([...storedMap.keys(), ...currentMap.keys()]);

  for (const key of keys) {
    const before = storedMap.has(key) ? storedMap.get(key) : "ABSENT";
    const after = currentMap.has(key) ? currentMap.get(key) : "ABSENT";
    if (before === after) continue;

    const beforeUnreadable = /^UNREADABLE:/.test(before);
    const afterUnreadable = /^UNREADABLE:/.test(after);
    const beforeAbsent = before === "ABSENT";
    const afterAbsent = after === "ABSENT";

    if (afterUnreadable && !beforeUnreadable) {
      out.becameUnreadable.push({ key, before, after });
    } else if (beforeAbsent && !afterAbsent && !afterUnreadable) {
      out.appeared.push({ key, before, after });
    } else if (!beforeAbsent && !beforeUnreadable && afterAbsent) {
      out.vanished.push({ key, before, after });
    } else {
      // Covers: both HASH but different (the common case); and every
      // transition out of a prior UNREADABLE that isn't "became unreadable"
      // again (UNREADABLE -> ABSENT, UNREADABLE -> HASH, or the UNREADABLE
      // reason string itself changing). See doc comment above.
      out.changed.push({ key, before, after });
    }
  }
  return out;
}
