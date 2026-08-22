/**
 * A document's lifecycle state, declared IN the document.
 *
 * WHY IN THE FILE. State inferred from a directory desyncs the moment the file moves, and
 * that is not a cosmetic problem — it is the S1 cascade. Proven on a temp repo: hub -> A,
 * A -> {B,C}; archiving A by moving it out of the graded set silently removed A's OUTBOUND
 * edges, so B and C became orphans. One action, three findings, none attributed. Next round
 * B and C get archived, and it compounds.
 *
 * Put `status:` in the file and state travels with the content. A move, rename or copy
 * cannot desync it, and an archived doc stays in the graph contributing its edges.
 *
 * `active` IS THE DEFAULT AND CARRIES NO KEY. Measured: 3,750 .md in this tree, 17 with any
 * `status:` at all. Writing `status: active` into every doc would be 3,750 one-line diffs to
 * say nothing; only non-default states are recorded, which in Vipin Kaushik is ~28 files.
 *
 * PRECEDENCE mirrors propagate/lib/doc-kind.mjs, which is proven and deliberate:
 * frontmatter > filename suffix > directory. Inference is a default for docs nobody has
 * classified, never an override of someone who did.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Writable states. `active` is included so the gate test can loop every disposition. */
export const STATUSES = ["active", "archived", "superseded"];

/** Why a doc stopped being live. Free text is refused — a taxonomy nobody maintains decays. */
export const REASONS = ["shipped", "dropped", "superseded", "merged-forward"];

/**
 * The live convention this tree already uses, encoded in FILENAMES and applied by `git mv`.
 * Real examples from `git log --diff-filter=R`:
 *   2026-06-14-pr-drafts-shipped-2026-06-15.md
 *   2026-04-XX-astroclarity-unified-spec-superseded-2026-05-05.md
 *   INFORMATION_ARCHITECTURE_stale-2026-06-28-endpoints.md
 * propagate's doc-kind.mjs already strips these, so reading them is not a new mechanism.
 */
const SUFFIX = /[-_](shipped|superseded|stale|archived|deprecated)-(\d{4}-\d{2}-\d{2})/i;
const SUFFIX_STATUS = { shipped: "archived", superseded: "superseded", stale: "archived", archived: "archived", deprecated: "archived" };

/** Same shape as doc-kind.mjs:43, which is proven. Deliberately not a full YAML parse — a
 *  reader that reformats what it reads produces diffs nobody asked for. */
export function frontmatterBlock(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) return null;
  const keys = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (kv) keys[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  return { raw: m[0], inner: m[1], keys, end: m[0].length };
}

/**
 * @returns {{status:string, source:"frontmatter"|"filename"|"directory"|"default",
 *            declared?:string, why?:string, supersededBy?:string, on?:string, because?:string}}
 */
export function readStatus(file, root, cfg, read = (p) => readFileSync(p, "utf8")) {
  let raw = "";
  try { raw = read(file); } catch { /* unreadable is handled by the caller, not silently clean */ }
  const fm = frontmatterBlock(raw);

  if (fm?.keys.status) {
    const declared = fm.keys.status;
    if (!STATUSES.includes(declared)) {
      // A value outside the taxonomy is a REPORTED value, never coerced to active
      // (rule:discernment-checks §2). Coercing it would hide a typo as a healthy doc.
      return {
        status: "unknown", declared, source: "frontmatter",
        why: `declared status "${declared}" is not one of ${STATUSES.join(", ")}`,
      };
    }
    return {
      status: declared, source: "frontmatter",
      supersededBy: fm.keys.superseded_by, on: fm.keys.archived_on, because: fm.keys.archived_because,
    };
  }

  const m = SUFFIX.exec(path.basename(file));
  if (m) return { status: SUFFIX_STATUS[m[1].toLowerCase()], source: "filename", on: m[2], because: m[1].toLowerCase() };

  const relPosix = path.relative(root, file).split(path.sep).join("/");
  const dirs = relPosix.split("/").slice(0, -1);
  if (dirs.some((d) => cfg.archiveDirs.includes(d))) return { status: "archived", source: "directory" };

  return { status: "active", source: "default" };
}

/** Splice keys into an existing frontmatter block, or create a minimal one. Existing keys
 *  are preserved verbatim — a writer that reformats turns a one-key change into a whole-file
 *  diff, and then nobody reviews it. */
function withKeys(raw, keys) {
  const fm = frontmatterBlock(raw);
  const set = new Set(Object.keys(keys));
  const rendered = Object.entries(keys).map(([k, v]) => `${k}: ${v}`);

  if (!fm) return `---\n${rendered.join("\n")}\n---\n${raw}`;

  const kept = fm.inner.split(/\r?\n/).filter((line) => {
    const kv = /^(\w+):/.exec(line);
    return !(kv && set.has(kv[1]));
  });
  // New keys lead, so `status` is the first thing a reader sees on an archived doc.
  const inner = [...rendered, ...kept].filter((l) => l.length).join("\n");
  return `---\n${inner}\n---\n${raw.slice(fm.end)}`;
}

/**
 * Declare a document's state. Writes ONLY frontmatter keys.
 *
 * `apply` is the gate, and `tests/state.test.mjs` asserts the unsafe path is UNREACHABLE
 * without it by snapshotting every byte of the tree across every disposition — not "the flag
 * is read" (rule:safety-flag-needs-a-test; three separate incidents in this tree came from a
 * gate that existed on one code path and not the adjacent one).
 *
 * @returns {{applied:boolean, changed:boolean, before:string, after:string, path:string}}
 */
export function setStatus(file, { status, because, supersededBy, on }, opts = {}) {
  // Validation happens BEFORE any read or write, so a bad argument cannot half-apply.
  if (!STATUSES.includes(status)) {
    throw new Error(`status "${status}" is not one of ${STATUSES.join(", ")}`);
  }
  if (status === "superseded" && !supersededBy) {
    throw new Error(
      "superseded requires superseded_by naming the replacement — " +
        "75 of 105 supersession claims in this tree name no file, and the superseded document never learns",
    );
  }
  if (because && !REASONS.includes(because)) {
    throw new Error(`because "${because}" is not one of ${REASONS.join(", ")}`);
  }

  const before = readFileSync(file, "utf8");

  // `active` is the default and carries no key: setting it REMOVES the markers.
  const keys = status === "active"
    ? {}
    : {
        status,
        ...(supersededBy ? { superseded_by: supersededBy } : {}),
        ...(on ? { archived_on: on } : {}),
        ...(because ? { archived_because: because } : {}),
      };

  let after;
  if (status === "active") {
    const fm = frontmatterBlock(before);
    if (!fm) after = before;
    else {
      const drop = new Set(["status", "superseded_by", "archived_on", "archived_because"]);
      const kept = fm.inner.split(/\r?\n/).filter((l) => {
        const kv = /^(\w+):/.exec(l);
        return !(kv && drop.has(kv[1]));
      }).filter((l) => l.length);
      after = kept.length ? `---\n${kept.join("\n")}\n---\n${before.slice(fm.end)}` : before.slice(fm.end);
    }
  } else {
    after = withKeys(before, keys);
  }

  const changed = after !== before;
  if (opts.apply && changed) writeFileSync(file, after);
  return { applied: Boolean(opts.apply) && changed, changed, before, after, path: file };
}

/**
 * Turn `git log --diff-filter=R` pairs into status declarations.
 *
 * The tree's existing lifecycle information is in filenames and nowhere else, and git already
 * knows every rename with its date. So the initial `status:` values are DERIVED, not typed —
 * which matters, because a migration nobody can afford to do by hand does not happen.
 *
 * A plain move with no lifecycle suffix (`design/design-spec.md` -> `docs/design/design-spec.md`)
 * yields NOTHING. Inferring `archived` from "it moved" is the directory inference that caused
 * the cascade in the first place.
 */
export function backfillFromRenames(pairs, cfg) {
  const out = [];
  for (const { to } of pairs) {
    const m = SUFFIX.exec(path.basename(to));
    if (!m) continue;
    const word = m[1].toLowerCase();
    out.push({
      path: to,
      status: SUFFIX_STATUS[word],
      because: word === "shipped" ? "shipped" : word === "superseded" ? "superseded" : "dropped",
      on: m[2],
    });
  }
  return out;
}
