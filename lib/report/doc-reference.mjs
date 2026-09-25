/**
 * lib/report/doc-reference.mjs — derives the generated "Doc kind guidelines"
 * section of `docs/REFERENCE.md` from `KINDS` (`lib/report/doc-kind.mjs`),
 * plus a tier-precedence example VERIFIED live via `kindOf()` at generation
 * time rather than asserted from memory (plan
 * `~/.claude/plans/i-saw-it-what-starry-sparkle.md` §5).
 *
 * REUSE, NOT REBUILD (plan §5, "Reuse, rung 1"). `bodyHash`/`parseFooter`/
 * `compareInputs` are IMPORTED from `lib/report/rollup.mjs` verbatim — the
 * same scanning/hashing/diff logic ECOSYSTEM.md's generator already uses and
 * `tests/cli/rollup-exit-codes.test.mjs` / `tests/cli/rollup-dryrun.test.mjs`
 * already cover. `bodyHash`/`parseFooter` there were generalised to accept
 * the mark strings as parameters (defaulting to rollup's own marks, so every
 * existing zero-arg call site is unaffected) specifically so THIS module
 * could reuse them under its own marks instead of writing a second
 * hash-footer implementation — the exact G20 failure ("a second mechanism
 * duplicates the first unless you delete the first") this whole change
 * exists to prevent.
 *
 * WHY A MARKED SPAN AT END-OF-FILE, NOT A WHOLE FILE LIKE ECOSYSTEM.md.
 * `docs/REFERENCE.md` is a large hand-authored document; only one section of
 * it is generated. That section is always placed LAST, so "nothing may
 * legitimately follow the footer's closing `-->`" (the same posture
 * `commands/rollup.mjs`'s `detectHandEdit` uses for the whole file) still
 * means what it says here too — the check lives in `commands/docs.mjs`,
 * ported rather than imported because rollup's version is scoped to a
 * WHOLE-file artifact and takes no marks.
 *
 * WHAT COUNTS AS AN "INPUT". Unlike rollup's cross-workspace derivation
 * (dozens of STATE.md files), this generator has exactly one source of
 * truth: `lib/report/doc-kind.mjs` itself — both `KINDS` (the guideline
 * fields) and the tier functions (`kindOf`/`byFilename`/`byDirectory`, which
 * the rendered precedence example depends on). Hashing the whole FILE, not
 * just `JSON.stringify(KINDS)`, means a change to the precedence LOGIC also
 * invalidates the footer, not only a change to a guideline sentence.
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { bodyHash, parseFooter, compareInputs } from "./rollup.mjs";
import { KINDS, kindOf } from "./doc-kind.mjs";

// Re-exported so callers (commands/docs.mjs) never need their own import of
// rollup.mjs just to reuse the same functions this module already reuses —
// one seam, not two.
export { bodyHash, parseFooter, compareInputs };

const HERE = path.dirname(fileURLToPath(import.meta.url));
// lib/report/doc-reference.mjs -> propagate/ (two levels up), same
// derivation rollup.mjs uses for its own MODULE_ROOT.
const MODULE_ROOT = path.resolve(HERE, "../..");
const DOC_KIND_PATH = path.join(HERE, "doc-kind.mjs");

export const REFERENCE_ARTIFACT = path.join(MODULE_ROOT, "docs", "REFERENCE.md");

export const REFERENCE_BODY_MARK = "<!-- propagate:docs-reference:body:start -->";
export const REFERENCE_FOOTER_MARK = "<!-- propagate:docs-reference:inputs v1";
const INPUT_SEP = " :: ";

function sha256OfText(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function shortHash(hex64) {
  return typeof hex64 === "string" ? hex64.slice(0, 12) : hex64;
}

/** propagate's own VERSION file — cosmetic footer field only, never throws. */
function readVersion() {
  try {
    return readFileSync(path.join(MODULE_ROOT, "VERSION"), "utf8").trim();
  } catch {
    return "unknown";
  }
}

/**
 * The one declared input: `lib/report/doc-kind.mjs`'s own source, hashed
 * whole. `UNREADABLE:<reason>` rather than throwing — a broken source file
 * is a fact `--check` should report, not a crash (mirrors rollup's own
 * `ABSENT`/`UNREADABLE` vocabulary for the same reason:
 * `rule:discernment-checks` §2, absence must be attributable).
 */
export function currentInputs() {
  let value;
  try {
    value = shortHash(sha256OfText(readFileSync(DOC_KIND_PATH, "utf8")));
  } catch (err) {
    value = `UNREADABLE:${err.code || err.message}`;
  }
  return new Map([["lib/report/doc-kind.mjs", value]]);
}

function escapeCell(s) {
  return String(s).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function renderKindsTable() {
  const rows = Object.entries(KINDS).map(([name, k]) => {
    const maintain = `${k.maintain.rule} — ${k.maintain.why}`;
    return `| \`${name}\` | ${escapeCell(k.what)} | ${escapeCell(k.create)} | ${escapeCell(maintain)} | ${escapeCell(k.link)} | ${escapeCell(k.never)} |`;
  });
  return ["| kind | what | create | maintain | link | never |", "|---|---|---|---|---|---|", ...rows].join("\n");
}

/**
 * The precedence trap (plan §5): filename (tier 1) beats directory (tier 2),
 * so a doc's OWN filename can override the convention its directory implies.
 * Every row below is derived by calling `kindOf()` right now — never a
 * hardcoded claim about what it would do.
 */
function renderPrecedenceSection() {
  const examples = [
    "docs/design/README.md",
    "docs/design/TODOS.md",
    "docs/design/OVERVIEW.md",
  ];
  const verified = examples.map((p) => ({ p, ...kindOf(p) }));
  const width = Math.max(...examples.map((p) => p.length));
  const lines = [
    "`kindOf()` resolves a kind in tiers, and **frontmatter always wins** over both:",
    "",
    "1. **frontmatter** `kind:` declared in the doc itself — always wins; inference is a",
    "   default for docs nobody has classified, never an override of someone who did.",
    "2. **filename** (tier 1) — `DECISIONS.md`; `STATE.md`/`TODOS.md`/`TODO.md`/`CHANGELOG.md`;",
    "   `GOTCHAS.md`; `ISSUES.md`; a dated file under `plans/`; `README.md`.",
    "3. **directory** (tier 2) — `/content/`; `/design/` (or `/design-process/`, `/ia/`);",
    "   `/sdk/` or `/specs/`; a runbook/deploy/env/infra name.",
    "",
    "**Filename beats directory** — the trap. Putting a doc inside `docs/design/` does not",
    "make it a `design` doc if its own filename already resolves to something else:",
    "",
    "```",
    ...verified.map(({ p, kind, source }) => `${p.padEnd(width)}  ->  ${String(kind).padEnd(8)} (${source} tier)`),
    "```",
    "",
    "The rows above are computed by calling `kindOf()` at generation time, not typed by",
    "hand — `docs/design/README.md` resolves `router` and `docs/design/TODOS.md` resolves",
    "`state`, **not** `design`, which is the opposite of what \"put it in `docs/design/`\"",
    "implies.",
  ];
  return lines.join("\n");
}

/**
 * The generated section, complete with its own hash footer — the same
 * placeholder-then-rehash sequence `renderRollup` uses (`bodyHash` must be
 * called on the SAME draft a reader would later re-hash, never a
 * hand-derived slice computed a second, subtly different way).
 */
export function renderReferenceSection() {
  // THE HEADING LIVES INSIDE THE MARKED SPAN — deliberately, and it is the
  // fix for a real bug caught by re-running `--reference` twice in a row
  // during verification: `spliceReferenceDoc` preserves everything BEFORE
  // `REFERENCE_BODY_MARK` as "existing hand-authored prefix". Putting the
  // heading/intro paragraph before the mark meant it was captured into that
  // preserved prefix on regeneration N, then a SECOND copy was appended by
  // regeneration N+1 — an accumulating duplicate on every run. `BODY_MARK`
  // must be the very first byte of the whole generated section for the
  // prefix-preserving splice model to be idempotent.
  const body = [
    "## Doc kind guidelines (generated)",
    "",
    "Generated by `propagate docs --reference` from `KINDS` in " +
      "`lib/report/doc-kind.mjs` — the single source (plan " +
      "`i-saw-it-what-starry-sparkle.md` §5). **Do not hand-edit this section** — run " +
      "`propagate docs --reference` to regenerate, or `propagate docs --reference --check` " +
      "to verify this section still matches the tree without writing anything.",
    "",
    "### The ten kinds",
    "",
    renderKindsTable(),
    "",
    "### Tier precedence — a trap worth naming",
    "",
    renderPrecedenceSection(),
    "",
  ].join("\n");

  const preFooter = REFERENCE_BODY_MARK + "\n\n" + body + "\n\n";

  const inputLines = [...currentInputs()].map(([key, val]) => `  ${key}${INPUT_SEP}${val}`);
  const footerLines = [
    REFERENCE_FOOTER_MARK,
    "alg: sha256-12",
    `body: ${"0".repeat(12)}`, // placeholder — replaced below once bodyHash() can be computed
    `generator: propagate docs --reference v${readVersion()}`,
    "walk: n/a — single-source render, no tree walk",
    "inputs:",
    ...inputLines,
    "-->",
  ];
  const draft = preFooter + footerLines.join("\n") + "\n";

  // Compute the real hash by calling the SAME function a reader would call —
  // never hand-derive the slice a second, subtly different way.
  const hash = bodyHash(draft, REFERENCE_BODY_MARK, REFERENCE_FOOTER_MARK);
  const finalFooterLines = footerLines.map((l) =>
    l === `body: ${"0".repeat(12)}` ? `body: ${shortHash(hash)}` : l,
  );

  return preFooter + finalFooterLines.join("\n") + "\n";
}

/**
 * Splice a freshly rendered generated section into an existing
 * `docs/REFERENCE.md` text. Everything BEFORE the existing `REFERENCE_BODY_MARK`
 * (or the whole file, on a first run where no mark exists yet) is preserved
 * verbatim; the generated section always ends up last.
 */
export function spliceReferenceDoc(existingFullText) {
  const text = existingFullText ?? "";
  const idx = text.indexOf(REFERENCE_BODY_MARK);
  const prefix = idx === -1 ? text.replace(/\s*$/, "") + (text.trim() ? "\n\n" : "") : text.slice(0, idx);
  return prefix + renderReferenceSection();
}
