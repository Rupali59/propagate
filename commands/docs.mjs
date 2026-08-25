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
 */

import { existsSync } from "node:fs";
import path from "node:path";

import { WORKSPACES } from "../lib/core/config.mjs";
import { RESET, DIM, GREEN, YELLOW, BOLD } from "./ansi.mjs";

/**
 * `docs` — the derive-on-demand half of doc authority.
 *
 *   docs <file>   what governs this file, and why
 *   docs --all    every declared authority edge in the tree
 *
 * The hook (`~/.claude/hooks/doc-authority.mjs`) is the same lookup at edit time. Both
 * render through `formatGoverned` so they can never disagree about what they found.
 */
export async function docsCmd() {
  const { buildAuthorityIndex, whatGoverns, formatGoverned, blocks } = await import("../lib/report/docs.mjs");
  const { findAllSidecarsRecursive } = await import("../lib/edges/edges.mjs");
  const os = await import("node:os");

  const sidecars = [];
  for (const ws of WORKSPACES) sidecars.push(...(await findAllSidecarsRecursive(ws.root)));
  const index = buildAuthorityIndex(sidecars);

  const args = process.argv.slice(3).filter((a) => !a.startsWith("--"));

  if (process.argv.includes("--structure")) {
    const { kindOf, brokenPathCitations } = await import("../lib/report/doc-kind.mjs");
    const { globSync } = await import("node:fs");
    // A CHANGELOG or a dated plan citing a since-moved file is CORRECT — it is a
    // historical record. Only live docs must resolve. Without this split the check
    // reported 603 findings across 6 projects; with it, 50.
    const HISTORICAL = new Set(["state", "plan", "decision-log"]);
    console.log(`${BOLD}# Doc structure${RESET}\n`);
    for (const ws of WORKSPACES) {
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
        const withTables = process.argv.includes("--tables");
        for (const d of docs) {
          const broken = brokenPathCitations(d, [root, ws.root], undefined, { tables: withTables }) ?? [];
          if (HISTORICAL.has(kindOf(d).kind)) hist += broken.length;
          else live += broken.length;
        }
        const router = existsSync(path.join(root, "docs", "README.md"));
        const decisions =
          existsSync(path.join(root, "docs", "DECISIONS.md")) || existsSync(path.join(root, "DECISIONS.md"));
        const flags = [router ? "" : "no-router", decisions ? "" : "no-DECISIONS"].filter(Boolean).join(" ");
        const mark = live > 0 ? YELLOW : GREEN;
        console.log(
          `  ${mark}${String(live).padStart(4)}${RESET} broken in live docs  ${DIM}(${hist} historical, expected)${RESET}  ${root.replace(os.homedir(), "~")}${flags ? `  ${YELLOW}[${flags}]${RESET}` : ""}`,
        );
      }
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
    return;
  }

  if (process.argv.includes("--kinds")) {
    const { kindOf, proseOnlySupersession } = await import("../lib/report/doc-kind.mjs");
    const { globSync } = await import("node:fs");
    const bySource = {};
    const byKind = {};
    const undeclared = [];
    let prose = 0;
    let scanned = 0;
    // Workspaces nest (VipinKaushik lives under "Vipin Kaushik"), so the same doc is
    // reachable twice. Counting it twice inflated this census from 1339 to 2219.
    const seen = new Set();
    for (const ws of WORKSPACES) {
      let docs = [];
      try {
        docs = globSync(path.join(ws.root, "**", "docs", "**", "*.md"));
      } catch {
        continue;
      }
      for (const d of docs) {
        if (d.includes("node_modules")) continue;
        const abs = path.resolve(d);
        if (seen.has(abs)) continue;
        seen.add(abs);
        scanned++;
        const k = kindOf(d);
        bySource[k.source] = (bySource[k.source] ?? 0) + 1;
        byKind[k.kind ?? "(none)"] = (byKind[k.kind ?? "(none)"] ?? 0) + 1;
        if (k.source === "undeclared") undeclared.push(d);
        if (proseOnlySupersession(d)) prose++;
      }
    }
    console.log(`${BOLD}# Doc kinds — ${scanned} scanned${RESET}\n`);
    for (const [k, n] of Object.entries(byKind).sort((a, b) => b[1] - a[1]))
      console.log(`  ${String(n).padStart(4)}  ${k}`);
    console.log(`\n  ${DIM}resolved by:${RESET} ${Object.entries(bySource).map(([k, v]) => `${k}=${v}`).join("  ")}`);
    // The residue is where the taxonomy is wrong, so it is reported, never silent.
    console.log(`  ${YELLOW}${undeclared.length}${RESET} undeclared — no convention matches; these need \`kind:\` frontmatter`);
    for (const u of undeclared.slice(0, 8)) console.log(`      ${DIM}${u.replace(os.homedir(), "~")}${RESET}`);
    if (undeclared.length > 8) console.log(`      ${DIM}… and ${undeclared.length - 8} more${RESET}`);
    console.log(`\n  ${YELLOW}${prose}${RESET} doc(s) claim supersession in prose with no \`supersedes:\` declaration`);
    return;
  }

  if (process.argv.includes("--superseded")) {
    const { buildSupersessionIndex } = await import("../lib/report/doc-kind.mjs");
    const { globSync } = await import("node:fs");
    let docs = [];
    for (const ws of WORKSPACES) {
      try {
        docs.push(...globSync(path.join(ws.root, "**", "docs", "**", "*.md")).filter((d) => !d.includes("node_modules")));
      } catch { /* unreadable workspace */ }
    }
    const idx = buildSupersessionIndex(docs);
    const target = args[0];
    if (!target) {
      console.log(`${BOLD}# Declared supersessions — ${idx.size}${RESET}`);
      for (const [doc, by] of idx) {
        console.log(`  ${doc.replace(os.homedir(), "~")}`);
        for (const b of by) console.log(`    ${DIM}overruled by${RESET} ${b.by.replace(os.homedir(), "~")}${b.anchor ? ` #${b.anchor}` : ""}`);
      }
      if (idx.size === 0) console.log(`  ${DIM}none declared yet — run \`docs --kinds\` for the prose-only count${RESET}`);
      return;
    }
    const hits = idx.get(path.resolve(target));
    if (!hits) {
      console.log(`${path.basename(target)}: nothing declares that it supersedes this`);
      return;
    }
    for (const h of hits) console.log(`${path.basename(target)} is overruled by ${h.by}${h.anchor ? ` #${h.anchor}` : ""}`);
    return;
  }

  if (process.argv.includes("--all") || args.length === 0) {
    if (index.size === 0) {
      // Absence must be attributable: no edges declared is a different fact from
      // "the scan failed" (rule:discernment-checks §2).
      console.log(
        `${BOLD}# Doc authority${RESET}\n  ${DIM}no edges declare \`authority:\` yet — ${sidecars.length} sidecar(s) scanned across ${WORKSPACES.length} workspace(s)${RESET}`,
      );
      return;
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
    return;
  }

  for (const f of args) console.log(formatGoverned(f, whatGoverns(f, index)));
}
