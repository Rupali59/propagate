/**
 * docs.mjs — the `propagate docs` command.
 *
 * Second module of the commands layer (#31 T5). Clean to extract because it
 * needs nothing that lives in cli.mjs: every helper it calls is already a
 * dynamic import of a lib module, and its only shared constant is WORKSPACES.
 *
 * Its siblings are not like that, and the difference is worth recording rather
 * than discovering twice:
 *   `status`      pulls statusJson, relToWs, coverageFrom and ACTIONABLE_STATES,
 *                 which are its own, PLUS currentWorkspace, which three other
 *                 commands also call. It is a command family, not a function.
 *   `drainClose`  shares drainScope and openRowsForWorkspace with drainList.
 *                 Same shape.
 * Extracting either means moving the whole family and relocating
 * currentWorkspace first — not a bigger version of this move, a different one.
 *
 * NOTE THE IMPORT PREFIX. From here it is `../lib/…`; from
 * lib/report/doctor/ it is `../../…`. A specifier copied out of cli.mjs
 * (`./lib/…`) is wrong in both and wrong DIFFERENTLY in each — G60, and why
 * tests/unit/doctor-module-imports.test.mjs now resolves specifiers in both
 * layers rather than grepping for one spelling.
 *
 * ARGV IS PASSED IN, never read from `process.argv` here — `cli.mjs` hands us
 * `process.argv.slice(3)`. The previous version read `process.argv` directly
 * through five `includes()` checks, which meant (a) the module could not be
 * unit-tested without mutating global state and (b) `--json` was silently
 * accepted and ignored: nothing ever read it. Both are fixed in this pass.
 *
 * `--json`: ONLY JSON on stdout, same rule `commands/claims.mjs` states at its
 * own top. N65 (`propagation/state/workspace/STATE.md`) was filed for exactly
 * the opposite mistake in a sibling command — a human-facing notice printed to
 * stdout ahead of the JSON broke every `--json` consumer with `Unexpected
 * token`. Every human-facing line here goes to `console.error` (stderr) when
 * `--json` is set; in JSON mode nothing but the `console.log(JSON...)` call
 * touches stdout.
 *
 * WORKSPACES IS INJECTABLE (second parameter), defaulting to the real,
 * process-wide list. Tests pass a small fixture list so the suite never pays
 * for the real tree: `docs --kinds` over the real ~1513 docs measured 21.03s
 * (dominated by `proseOnlySupersession` opening every file), which is not a
 * cost a test file gets to add per case.
 */

import { existsSync, globSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { WORKSPACES } from "../lib/core/config.mjs";
import { RESET, DIM, RED, GREEN, YELLOW, BOLD } from "./ansi.mjs";

/**
 * Best-guess kind for a doc `kindOf()` could not classify.
 *
 * Deliberately NOT `lib/report/doc-kind.mjs`'s job: that module's tiers
 * (frontmatter / filename / directory) are precedence-ordered and
 * conservative on purpose — a doc that matches nothing is `undeclared`
 * rather than mis-filed. This is the opposite posture: a loose, best-effort
 * hint for a human triaging the worklist, never fed back into `kindOf()` and
 * never treated as a classification. NOT in scope: backfilling the 988
 * undeclared docs — this only makes the worklist triageable (plan D4).
 */
const GUESS_HINTS = [
  [/decision/i, "decision-log"],
  [/\b(todo|backlog|status)\b/i, "state"],
  [/\bplans?\b/i, "plan"],
  [/\b(spec|sdk|schema|endpoint|api)\b/i, "functionality-spec"],
  [/\b(design|\bia\b|wireframe|figma)\b/i, "design"],
  [/\b(deploy|infra|\benv\b|ops|runbook)\b/i, "ops"],
  [/\b(route|index|overview|readme)\b/i, "router"],
  [/\bgotcha/i, "gotchas"],
  [/\bissues?\b/i, "issues"],
  [/\b(content|copy|\bpage\b)\b/i, "page-spec"],
];

export function guessKind(filePath) {
  const s = filePath.replace(/\\/g, "/").toLowerCase();
  for (const [re, kind] of GUESS_HINTS) if (re.test(s)) return kind;
  return null;
}

/**
 * Every doc under every workspace's `docs/`, deduped by resolved absolute
 * path. Workspaces nest (VipinKaushik lives under "Vipin Kaushik"), so the
 * same doc is reachable twice — counting it twice inflated an earlier
 * version of this census from 1339 to 2219.
 */
function scanWorkspaceDocs(workspaces) {
  const seen = new Set();
  const docs = [];
  for (const ws of workspaces) {
    let found = [];
    try {
      found = globSync(path.join(ws.root, "**", "docs", "**", "*.md"));
    } catch {
      continue;
    }
    for (const d of found) {
      if (d.includes("node_modules")) continue;
      const abs = path.resolve(d);
      if (seen.has(abs)) continue;
      seen.add(abs);
      docs.push(abs);
    }
  }
  return docs;
}

function fail(json, msg, extra = {}) {
  // could-not-run / usage error, never "nothing found" — same posture
  // commands/claims.mjs uses throughout.
  if (json) console.log(JSON.stringify({ error: msg, ...extra }));
  else console.error(msg);
  return 2;
}

/**
 * `docs --doctrine [kind]` — the per-kind guideline table, rendered from
 * `KINDS` (the single source: `lib/report/doc-kind.mjs`). No argument prints
 * every kind's `what`; a kind prints all five fields. An unknown kind is a
 * usage error (exit 2, named reason) — never a silent empty print. "No
 * result" and "no result because —" are different facts
 * (`rule:discernment-checks` §2).
 */
async function doctrineCmd(argv, json) {
  const { KINDS } = await import("../lib/report/doc-kind.mjs");
  const kindArg = argv.find((a) => !a.startsWith("--") && a !== "docs");
  const names = Object.keys(KINDS);

  if (!kindArg) {
    if (json) {
      console.log(JSON.stringify({ kinds: KINDS }, null, 2));
      return 0;
    }
    console.log(`${BOLD}# Doc kind guidelines — ${names.length} kinds${RESET}\n`);
    for (const name of names) {
      console.log(`  ${BOLD}${name}${RESET}`);
      console.log(`    ${KINDS[name].what}`);
    }
    console.log(`\n  ${DIM}run \`docs --doctrine <kind>\` for a kind's full guidance (create/maintain/link/never)${RESET}`);
    return 0;
  }

  const entry = KINDS[kindArg];
  if (!entry) {
    return fail(
      json,
      `docs --doctrine: unknown kind "${kindArg}" — known kinds: ${names.join(", ")}`,
      { knownKinds: names },
    );
  }

  if (json) {
    console.log(JSON.stringify({ kind: kindArg, ...entry }, null, 2));
    return 0;
  }
  console.log(`${BOLD}# doctrine: ${kindArg}${RESET}\n`);
  console.log(`  ${DIM}what${RESET}      ${entry.what}`);
  console.log(`  ${DIM}create${RESET}    ${entry.create}`);
  console.log(`  ${DIM}maintain${RESET}  ${entry.maintain.rule} — ${entry.maintain.why}`);
  console.log(`  ${DIM}link${RESET}      ${entry.link}`);
  console.log(`  ${DIM}never${RESET}     ${entry.never}`);
  return 0;
}

/**
 * `docs --reference [--check|--dry-run] [--force] [--json]` — regenerate or
 * verify the generated "Doc kind guidelines" section of THIS repo's own
 * `docs/REFERENCE.md` (plan §5, T5).
 *
 * REUSE, NOT REBUILD (G20). Every piece of the hash-footer guard and the
 * four exit codes below — `0` current · `1` stale · `2` could-not-run ·
 * `3` hand-edited — is `lib/report/rollup.mjs`'s own `bodyHash`/`parseFooter`/
 * `compareInputs`, imported via `lib/report/doc-reference.mjs` (which also
 * derives the rendered content). This function is deliberately the SAME
 * shape as `commands/rollup.mjs`'s `runCheck`/`runGenerate` — read-only
 * `--check` never reaches the one `writeFileSync` call site below, which is
 * gated on `!dryRun` exactly the way `rule:safety-flag-needs-a-test` requires.
 *
 * WHY THE HAND-EDIT CHECK IS PORTED, NOT IMPORTED. `commands/rollup.mjs`'s
 * `detectHandEdit` is scoped to a WHOLE-file artifact (ECOSYSTEM.md) and
 * takes no marks — reusing it here would mean either hardcoding rollup's own
 * marks into REFERENCE.md (wrong artifact) or extracting a new shared
 * module for a four-line function, which is exactly the "no new helper, no
 * extraction" the plan asks to avoid. The scanning primitives it calls
 * (`bodyHash`, `parseFooter`) ARE imported; only this thin wrapper is local.
 */
/**
 * THREE outcomes, not two — `docs/REFERENCE.md` is mostly hand-authored
 * prose that this generator never touches, so "no generated section exists
 * yet" and "the generated section was hand-edited" must not collapse into
 * one "refuse" verdict the way rollup's whole-file `detectHandEdit` collapses
 * them (there, ANY file at the artifact path with no footer is foreign and
 * unsafe to overwrite, because a plain regenerate there replaces the WHOLE
 * file). Here a plain regenerate only ever APPENDS/REPLACES the marked span
 * — it is always safe to create that span for the first time, so a file
 * with real prose and no marker yet is `ungenerated`, never `edited`.
 *   - `{ state: "ungenerated" }`         — no `REFERENCE_BODY_MARK` anywhere in the text
 *   - `{ state: "edited", reason }`      — a footer exists but is broken, or the body/
 *                                          trailing content disagrees with it
 *   - `{ state: "clean", parsed }`       — generated before, untouched since
 */
async function detectReferenceHandEdit(existingText, { bodyHash, parseFooter, BODY_MARK, FOOTER_MARK }) {
  if (!existingText.includes(BODY_MARK)) {
    return { state: "ungenerated" };
  }
  const parsed = parseFooter(existingText, FOOTER_MARK);
  if (parsed === null) {
    // BODY_MARK is present but FOOTER_MARK is not — a broken/partial
    // generated span, not merely "never generated". Genuinely unsafe.
    return {
      state: "edited",
      reason: "a `propagate:docs-reference:body:start` marker is present with no matching footer — the generated span was partially removed by hand",
    };
  }
  if (parsed.malformed) {
    return { state: "edited", reason: `footer marker present but malformed: ${parsed.reason}` };
  }
  const actualFull = bodyHash(existingText, BODY_MARK, FOOTER_MARK);
  if (actualFull === null) {
    return {
      state: "edited",
      reason: "body/footer markers missing or out of order — cannot verify the generated section",
    };
  }
  const actualShort = actualFull.slice(0, 12);
  if (actualShort !== parsed.body) {
    return {
      state: "edited",
      reason: `stored body hash (${parsed.body}) does not match the current body (${actualShort}) — the generated section was edited by hand since it was last written`,
    };
  }
  // The generator always places the generated section LAST — nothing may
  // legitimately follow the footer's closing "-->" but the trailing
  // newline the generator itself appends. Same posture and same reasoning
  // as commands/rollup.mjs's own trailing-content check (see that file's
  // header: appending after the footer is invisible to the body hash and
  // was silently destroyed by an earlier version with no warning).
  const closeIdx = existingText.lastIndexOf("-->");
  if (closeIdx !== -1) {
    const trailing = existingText.slice(closeIdx + 3);
    if (trailing.trim().length > 0) {
      return {
        state: "edited",
        reason: `${trailing.trim().split("\n").length} line(s) of content follow the footer — appended by hand`,
      };
    }
  }
  return { state: "clean", parsed };
}

/**
 * `artifactOverride` is injectable (third parameter) for exactly the reason
 * `docsCmd`'s own `workspaces` parameter is — see this file's top docstring.
 * `REFERENCE_ARTIFACT` always resolves to THIS repo's own
 * `docs/REFERENCE.md`, so a test asserting the four exit codes without an
 * override would read and write the real file on every run. Tests pass a
 * tmpdir path instead; `cli.mjs` and every real invocation pass nothing, so
 * production always targets the real file.
 */
async function referenceCmd(argv, json, artifactOverride) {
  const {
    REFERENCE_ARTIFACT,
    REFERENCE_BODY_MARK,
    REFERENCE_FOOTER_MARK,
    renderReferenceSection,
    spliceReferenceDoc,
    currentInputs,
    bodyHash,
    parseFooter,
    compareInputs,
  } = await import("../lib/report/doc-reference.mjs");

  const artifact = artifactOverride ?? REFERENCE_ARTIFACT;
  const checkMode = argv.includes("--check");
  const dryRun = argv.includes("--dry-run");
  const force = argv.includes("--force");
  const marks = { bodyHash, parseFooter, BODY_MARK: REFERENCE_BODY_MARK, FOOTER_MARK: REFERENCE_FOOTER_MARK };

  const couldNotRun = (reason) => {
    if (json) console.log(JSON.stringify({ ok: false, status: "could-not-run", path: artifact, reason }));
    else console.error(`${RED}could-not-run:${RESET} ${reason}`);
    return 2;
  };

  let existingText;
  try {
    existingText = existsSync(artifact) ? readFileSync(artifact, "utf8") : null;
  } catch (err) {
    return couldNotRun(`could not read ${artifact}: ${err.message}`);
  }

  if (checkMode) {
    if (existingText === null) {
      return couldNotRun(`${artifact} does not exist — nothing to check.`);
    }
    const edit = await detectReferenceHandEdit(existingText, marks);
    if (edit.state === "ungenerated") {
      return couldNotRun(
        `${artifact} exists but has no generated section yet — nothing to check. Run \`propagate docs --reference\` to create it.`,
      );
    }
    if (edit.state === "edited") {
      if (json) {
        console.log(JSON.stringify({ ok: false, status: "hand-edited", path: artifact, reason: edit.reason }));
      } else {
        console.error(
          `${RED}refusing to treat ${artifact} as current${RESET} — it has been hand-edited since it was last generated.\n  reason: ${edit.reason}\n  --force to discard the hand edit and regenerate; --dry-run to preview.`,
        );
      }
      return 3;
    }
    const diff = compareInputs(edit.parsed.inputs, currentInputs());
    const current = !diff.changed.length && !diff.appeared.length && !diff.vanished.length && !diff.becameUnreadable.length;
    if (json) {
      console.log(JSON.stringify({
        ok: current,
        status: current ? "current" : "stale",
        path: artifact,
        diff: { changed: diff.changed, appeared: diff.appeared, vanished: diff.vanished, becameUnreadable: diff.becameUnreadable },
      }));
    } else if (current) {
      console.error(`${GREEN}current${RESET} — ${artifact} matches the tree.`);
    } else {
      console.error(`${YELLOW}stale${RESET} — ${artifact} no longer matches the tree; run \`propagate docs --reference\` to regenerate.`);
    }
    return current ? 0 : 1;
  }

  // Generate (default), --dry-run, --force. `ungenerated` is NOT a refusal
  // here — see detectReferenceHandEdit's header: a plain regenerate only
  // ever touches the marked span, so creating it for the first time inside
  // an otherwise hand-authored file is always safe, with or without --force.
  if (existingText !== null && !force) {
    const edit = await detectReferenceHandEdit(existingText, marks);
    if (edit.state === "edited") {
      if (json) {
        console.log(JSON.stringify({ ok: false, action: "refused", path: artifact, reason: edit.reason }));
      } else {
        console.error(
          `${RED}refusing to overwrite ${artifact}${RESET} — it has been hand-edited since it was last generated.\n  reason: ${edit.reason}\n  --force discards the hand edit and regenerates; --dry-run previews without writing.`,
        );
      }
      return 3;
    }
  }

  const newFullText = spliceReferenceDoc(existingText);

  if (dryRun) {
    if (json) {
      console.log(JSON.stringify({ ok: true, action: "would-write", path: artifact, bytes: Buffer.byteLength(newFullText, "utf8") }));
    } else {
      // The one deliberate exception to "human lines go to stderr", same as
      // commands/rollup.mjs: this IS the product, not commentary about it.
      console.log(renderReferenceSection());
    }
    return 0;
  }

  try {
    writeFileSync(artifact, newFullText);
  } catch (err) {
    return couldNotRun(`could not write ${artifact}: ${err.message}`);
  }

  if (json) {
    console.log(JSON.stringify({ ok: true, action: "written", path: artifact, bytes: Buffer.byteLength(newFullText, "utf8") }));
  } else {
    console.error(`${GREEN}wrote${RESET} ${artifact} (${Buffer.byteLength(newFullText, "utf8")} bytes)`);
  }
  return 0;
}

async function structureCmd(argv, json, workspaces) {
  const { kindOf, brokenPathCitations } = await import("../lib/report/doc-kind.mjs");
  const os = await import("node:os");
  // A CHANGELOG or a dated plan citing a since-moved file is CORRECT — it is a
  // historical record. Only live docs must resolve. Without this split the check
  // reported 603 findings across 6 projects; with it, 50.
  const HISTORICAL = new Set(["state", "plan", "decision-log"]);
  const withTables = argv.includes("--tables");
  const rows = [];
  for (const ws of workspaces) {
    const projects = new Set();
    for (const d of globSync(path.join(ws.root, "**", "docs"))) {
      if (d.includes("node_modules")) continue;
      projects.add(path.dirname(d));
    }
    for (const root of [...projects].sort()) {
      const docs = [
        ...globSync(path.join(root, "*.md")),
        ...globSync(path.join(root, "docs", "**", "*.md")),
      ].filter((d) => !d.includes("node_modules"));
      if (docs.length === 0) continue;
      let live = 0;
      let hist = 0;
      for (const d of docs) {
        const broken = brokenPathCitations(d, [root, ws.root], undefined, { tables: withTables }) ?? [];
        if (HISTORICAL.has(kindOf(d).kind)) hist += broken.length;
        else live += broken.length;
      }
      const router = existsSync(path.join(root, "docs", "README.md"));
      const decisions =
        existsSync(path.join(root, "docs", "DECISIONS.md")) || existsSync(path.join(root, "DECISIONS.md"));
      rows.push({ root, live, historical: hist, router, decisions });
    }
  }

  if (json) {
    console.log(JSON.stringify({ tables: withTables, rows }, null, 2));
    return 0;
  }

  console.log(`${BOLD}# Doc structure${RESET}\n`);
  for (const r of rows) {
    const flags = [r.router ? "" : "no-router", r.decisions ? "" : "no-DECISIONS"].filter(Boolean).join(" ");
    const mark = r.live > 0 ? YELLOW : GREEN;
    console.log(
      `  ${mark}${String(r.live).padStart(4)}${RESET} broken in live docs  ${DIM}(${r.historical} historical, expected)${RESET}  ${r.root.replace(os.homedir(), "~")}${flags ? `  ${YELLOW}[${flags}]${RESET}` : ""}`,
    );
  }
  console.log(
    `\n  ${DIM}"live" = every kind except state/plan/decision-log, which cite moved files by design.${RESET}`,
  );
  console.log(
    `  ${DIM}Backticked citations only. --tables also reads whole-cell table paths: it catches${RESET}`,
  );
  console.log(
    `  ${DIM}sanskrit-texts' 11 dead Hora/ rows, and takes the tree-wide count ~50 -> 2325.${RESET}`,
  );
  return 0;
}

async function kindsCmd(_argv, json, workspaces) {
  const { kindOf, proseOnlySupersession } = await import("../lib/report/doc-kind.mjs");
  const os = await import("node:os");
  const bySource = {};
  const byKind = {};
  const undeclared = [];
  let prose = 0;
  const docs = scanWorkspaceDocs(workspaces);
  for (const d of docs) {
    const k = kindOf(d);
    bySource[k.source] = (bySource[k.source] ?? 0) + 1;
    byKind[k.kind ?? "(none)"] = (byKind[k.kind ?? "(none)"] ?? 0) + 1;
    if (k.source === "undeclared") undeclared.push(d);
    if (proseOnlySupersession(d)) prose++;
  }

  if (json) {
    console.log(JSON.stringify({
      scanned: docs.length,
      byKind,
      bySource,
      undeclaredCount: undeclared.length,
      proseOnlySupersessionCount: prose,
    }, null, 2));
    return 0;
  }

  console.log(`${BOLD}# Doc kinds — ${docs.length} scanned${RESET}\n`);
  for (const [k, n] of Object.entries(byKind).sort((a, b) => b[1] - a[1]))
    console.log(`  ${String(n).padStart(4)}  ${k}`);
  console.log(`\n  ${DIM}resolved by:${RESET} ${Object.entries(bySource).map(([k, v]) => `${k}=${v}`).join("  ")}`);
  // The residue is where the taxonomy is wrong, so it is reported, never silent.
  console.log(`  ${YELLOW}${undeclared.length}${RESET} undeclared — no convention matches; these need \`kind:\` frontmatter`);
  for (const u of undeclared.slice(0, 8)) console.log(`      ${DIM}${u.replace(os.homedir(), "~")}${RESET}`);
  if (undeclared.length > 8) console.log(`      ${DIM}… and ${undeclared.length - 8} more${RESET}`);
  if (undeclared.length > 0) console.log(`      ${DIM}run \`docs --undeclared\` for the full worklist, one row per doc${RESET}`);
  console.log(`\n  ${YELLOW}${prose}${RESET} doc(s) claim supersession in prose with no \`supersedes:\` declaration`);
  return 0;
}

/**
 * `docs --undeclared` — the FULL worklist, not 8-of-988. Each row carries a
 * best-effort guess (`guessKind`, never `kindOf`'s own tiers — see that
 * function's docstring) so a human triaging the list has a starting point
 * per row instead of an undifferentiated pile.
 */
async function undeclaredCmd(_argv, json, workspaces) {
  const { kindOf } = await import("../lib/report/doc-kind.mjs");
  const os = await import("node:os");
  const docs = scanWorkspaceDocs(workspaces);
  const undeclared = [];
  for (const d of docs) {
    if (kindOf(d).source !== "undeclared") continue;
    undeclared.push({ path: d, guess: guessKind(d) });
  }

  if (json) {
    console.log(JSON.stringify({ scanned: docs.length, count: undeclared.length, undeclared }, null, 2));
    return 0;
  }

  console.log(`${BOLD}# Undeclared docs — ${undeclared.length} of ${docs.length} scanned${RESET}\n`);
  if (undeclared.length === 0) {
    // Absence must be attributable: 0 undeclared after a real scan reads
    // differently from 0 because the scan found nothing to look at.
    console.log(`  ${DIM}none — every scanned doc resolves to a kind${RESET}`);
    return 0;
  }
  for (const u of undeclared) {
    console.log(`  ${u.path.replace(os.homedir(), "~")}`);
    console.log(`    ${DIM}guess:${RESET} ${u.guess ?? `${DIM}(none)${RESET}`}`);
  }
  console.log(`\n  ${DIM}guesses are heuristic, never authoritative — declare \`kind:\` in frontmatter to fix one${RESET}`);
  return 0;
}

async function supersededCmd(argv, json, workspaces) {
  const { buildSupersessionIndex } = await import("../lib/report/doc-kind.mjs");
  const docs = scanWorkspaceDocs(workspaces);
  const idx = buildSupersessionIndex(docs);
  const target = argv.find((a) => !a.startsWith("--"));

  if (!target) {
    if (json) {
      console.log(JSON.stringify({
        count: idx.size,
        supersessions: [...idx].map(([doc, by]) => ({ doc, overruledBy: by })),
      }, null, 2));
      return 0;
    }
    console.log(`${BOLD}# Declared supersessions — ${idx.size}${RESET}`);
    for (const [doc, by] of idx) {
      console.log(`  ${doc}`);
      for (const b of by) console.log(`    ${DIM}overruled by${RESET} ${b.by}${b.anchor ? ` #${b.anchor}` : ""}`);
    }
    if (idx.size === 0) console.log(`  ${DIM}none declared yet — run \`docs --kinds\` for the prose-only count${RESET}`);
    return 0;
  }

  const hits = idx.get(path.resolve(target));
  if (!hits) {
    if (json) {
      console.log(JSON.stringify({ file: path.resolve(target), overruledBy: [] }, null, 2));
      return 0;
    }
    console.log(`${path.basename(target)}: nothing declares that it supersedes this`);
    return 0;
  }
  if (json) {
    console.log(JSON.stringify({ file: path.resolve(target), overruledBy: hits }, null, 2));
    return 0;
  }
  for (const h of hits) console.log(`${path.basename(target)} is overruled by ${h.by}${h.anchor ? ` #${h.anchor}` : ""}`);
  return 0;
}

async function authorityCmd(argv, json, workspaces) {
  const { buildAuthorityIndex, whatGoverns, formatGoverned, blocks } = await import("../lib/report/docs.mjs");
  const { findAllSidecarsRecursive } = await import("../lib/edges/edges.mjs");
  const os = await import("node:os");

  const sidecars = [];
  for (const ws of workspaces) sidecars.push(...(await findAllSidecarsRecursive(ws.root)));
  const index = buildAuthorityIndex(sidecars);
  const args = argv.filter((a) => !a.startsWith("--"));

  if (argv.includes("--all") || args.length === 0) {
    if (index.size === 0) {
      // Absence must be attributable: no edges declared is a different fact from
      // "the scan failed" (rule:discernment-checks §2).
      if (json) {
        console.log(JSON.stringify({ governed: 0, sidecarsScanned: sidecars.length, workspaces: workspaces.length }, null, 2));
        return 0;
      }
      console.log(
        `${BOLD}# Doc authority${RESET}\n  ${DIM}no edges declare \`authority:\` yet — ${sidecars.length} sidecar(s) scanned across ${workspaces.length} workspace(s)${RESET}`,
      );
      return 0;
    }
    if (json) {
      console.log(JSON.stringify({
        governed: index.size,
        edges: [...index.entries()].map(([downstream, hits]) => ({
          downstream,
          sources: hits.map((h) => ({ source: h.source, authority: h.authority, blocks: blocks(h.authority) })),
        })),
      }, null, 2));
      return 0;
    }
    let blocking = 0;
    console.log(`${BOLD}# Doc authority — ${index.size} governed file(s)${RESET}\n`);
    for (const [downstream, hits] of [...index.entries()].sort()) {
      for (const h of hits) {
        if (blocks(h.authority)) blocking++;
        const tag = blocks(h.authority) ? `${YELLOW}counsel/blocks${RESET}` : `${DIM}${h.authority}${RESET}`;
        console.log(`  ${downstream.replace(os.homedir(), "~")}`);
        console.log(`    ${DIM}←${RESET} ${h.source.replace(os.homedir(), "~")}  [${tag}]`);
      }
    }
    console.log(`\n  ${blocking} edge(s) would block an edit; ${index.size - blocking} advisory`);
    return 0;
  }

  if (json) {
    console.log(JSON.stringify(
      args.map((f) => ({ file: f, governs: whatGoverns(f, index) })),
      null, 2,
    ));
    return 0;
  }
  for (const f of args) console.log(formatGoverned(f, whatGoverns(f, index)));
  return 0;
}

/**
 * `docs` — the derive-on-demand half of doc authority.
 *
 *   docs <file>          what governs this file, and why
 *   docs --all           every declared authority edge in the tree
 *   docs --kinds         census of doc kinds across the tree
 *   docs --undeclared    the full worklist of docs with no resolvable kind
 *   docs --doctrine [k]  the per-kind guideline table (or one kind's full guidance)
 *   docs --structure     broken-citation census per project
 *   docs --superseded    declared supersession index
 *   docs --reference     regenerate the generated section of THIS file's own docs/REFERENCE.md
 *   docs --reference --check   verify it without writing (0 current/1 stale/2 could-not-run/3 hand-edited)
 *
 * The hook (`~/.claude/hooks/doc-authority.mjs`) is the same lookup at edit time. Both
 * render through `formatGoverned` so they can never disagree about what they found.
 *
 * @param {string[]} argv — everything after `docs` (cli.mjs passes `process.argv.slice(3)`).
 * @param {{workspaces?: Array, referenceArtifact?: string}} [opts] — injectable
 *   workspace list and `--reference` target path, for tests. `referenceArtifact`
 *   defaults to `lib/report/doc-reference.mjs`'s `REFERENCE_ARTIFACT` (this repo's
 *   own `docs/REFERENCE.md`) — a test overriding it never touches the real file.
 * @returns {Promise<number>} exit code — 0 on success, 2 on a usage/could-not-run error.
 */
export async function docsCmd(argv = [], { workspaces = WORKSPACES, referenceArtifact } = {}) {
  const json = argv.includes("--json");

  // `--doctrine` is checked FIRST and reads nothing but KINDS — it must stay
  // O(10) and free, never paying for a workspace scan the way every other
  // mode below does.
  if (argv.includes("--doctrine")) return doctrineCmd(argv, json);
  if (argv.includes("--reference")) return referenceCmd(argv, json, referenceArtifact);

  if (argv.includes("--structure")) return structureCmd(argv, json, workspaces);
  if (argv.includes("--kinds")) return kindsCmd(argv, json, workspaces);
  if (argv.includes("--undeclared")) return undeclaredCmd(argv, json, workspaces);
  if (argv.includes("--superseded")) return supersededCmd(argv, json, workspaces);

  return authorityCmd(argv, json, workspaces);
}
