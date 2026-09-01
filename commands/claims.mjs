/**
 * claims.mjs — `propagate claims check` (Phase 2, lane 1: the deterministic
 * half only — `claims scan`/`judge`/`render`/`contradict` are later lanes
 * and NOT implemented here).
 *
 * Rendering only. All derivation lives in `lib/claims/check.mjs`, which
 * takes the tree as input and returns structured findings — this file is
 * the only place in the `claims` command surface allowed to print, per
 * `commands/ansi.mjs`'s own rule ("zero of 58 lib/ modules contain an ANSI
 * escape, and none of them print").
 *
 * `--json`: ONLY JSON on stdout. N65 (`propagation/state/workspace/STATE.md`)
 * was filed the same day this lane was written, for exactly the opposite
 * mistake in a sibling command — a human-facing notice printed to stdout
 * ahead of the JSON broke every `--json` consumer with `Unexpected token`.
 * Every human-facing line here goes to `console.error` (stderr) when
 * `--json` is set; in JSON mode nothing but the `console.log(JSON...)` call
 * touches stdout.
 *
 * Import prefix is `../lib/…` from here, not `./lib/…` — G60: a specifier
 * copied out of cli.mjs is relative to the repo root and resolves to a
 * different, non-existent file from inside `commands/`.
 */

import path from "node:path";
import { RESET, DIM, RED, YELLOW, GREEN, BOLD } from "./ansi.mjs";
import { claimsCheck } from "../lib/claims/check.mjs";
import { judgeStatus, asQuestions } from "../lib/claims/judge.mjs";
import { renderStatus } from "../lib/claims/render.mjs";
import { contradictStatus } from "../lib/claims/contradict.mjs";
import { rollup } from "../lib/report/rollup.mjs";
import { WORKSPACES, SEARCH_ROOTS, shortPath } from "../lib/core/config.mjs";

const CHECK_LABELS = {
  "expired-date": "expired date",
  "footer-stale": "footer date is behind the newest inline date",
  "rotted-citation": "rotted internal citation",
  "dead-concept-token": "concepts: token can never fire",
  "price-literal-drift": "literal not found in its declared downstream",
};

function describe(f) {
  switch (f.check) {
    case "expired-date":
      return `"${f.marker}${f.approx ? " ~" : " "}${f.dateText}" expired ${f.expiredISO} (${f.daysExpired}d ago) — ${f.snippet}`;
    case "footer-stale":
      return `footer says "Last amended: ${f.footer}" but the body carries a newer marker dated ${f.newestInline}`;
    case "rotted-citation":
      if (f.subtype === "self-line") return `cites its own line ${f.citedLine} — ${f.reason} — "${f.context}"`;
      if (f.subtype === "dead-branch") return `cites branch \`${f.branch}\`, absent from ${f.repoRoot} (local + origin) — "${f.context}"`;
      return `cites path \`${f.citedPath}\`, which does not exist — "${f.context}"`;
    case "dead-concept-token":
      return `${f.sourceKey} concepts["${f.section}"] token "${f.token}" — not a substring of ${f.sourceKey}'s own text (sidecar: ${f.sidecar})`;
    case "price-literal-drift":
      return f.direction === "doc-not-in-code"
        ? `doc row "${f.label}" has no match in ${f.downstream}`
        : `${f.downstream} identifier "${f.label}" has no match in the doc`;
    default:
      return JSON.stringify(f);
  }
}

export async function claimsCmd(argv = []) {
  const json = argv.includes("--json");
  const sub = argv[0] === "check" ? "check" : argv[0];

  if (sub === "judge") return judgeSub(argv.slice(1), json);
  if (sub === "render") return renderSub(argv.slice(1), json);
  if (sub === "contradict") return contradictSub(argv.slice(1), json);

  if (sub !== "check") {
    const msg =
      `unknown claims subcommand: ${sub ?? "(none)"}\n` +
      `usage: propagate claims check [--json]\n` +
      `       propagate claims judge <file> [--json]\n` +
      `       propagate claims render <file> [--apply] [--json]\n` +
      `       propagate claims contradict <authored-file> [--json]`;
    if (json) console.log(JSON.stringify({ error: msg }));
    else console.error(msg);
    return 2;
  }

  const result = await claimsCheck({ workspaces: WORKSPACES });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return result.files.unreadable.length > 0 || result.sidecars.unreadable.length > 0 ? 1 : 0;
  }

  console.log(`${BOLD}# claims check${RESET}  ${DIM}(deterministic only — no model, no network)${RESET}`);
  console.log(
    `  ${result.coverage.sidecarsChecked} sidecar(s) · ${result.coverage.sourceEdges} declared source(s) · ` +
      `${result.coverage.filesChecked} file(s) checked`,
  );

  // Absence must be attributable (`rule:discernment-checks` §2): a
  // zero-finding run still states what was and was not looked at, so
  // "found nothing" never reads the same as "looked at nothing".
  if (result.sidecars.unreadable.length > 0) {
    console.log(`\n  ${RED}unreadable sidecars (${result.sidecars.unreadable.length})${RESET}`);
    for (const s of result.sidecars.unreadable) console.log(`    ${s.sidecar} — ${s.reason}`);
  }
  if (result.files.unreadable.length > 0) {
    console.log(`\n  ${RED}unreadable files (${result.files.unreadable.length})${RESET}`);
    for (const f of result.files.unreadable) console.log(`    ${f.file} — ${f.reason}`);
  }
  if (result.globsSkipped.length > 0) {
    console.log(
      `\n  ${DIM}skipped (glob downstream, not expanded): ${result.globsSkipped.length}${RESET}`,
    );
  }

  if (result.findings.length === 0) {
    console.log(`\n  no findings — ${result.coverage.filesChecked} file(s) checked, 0 flagged`);
    return 0;
  }

  const byCheck = new Map();
  for (const f of result.findings) {
    if (!byCheck.has(f.check)) byCheck.set(f.check, []);
    byCheck.get(f.check).push(f);
  }

  for (const [check, items] of byCheck) {
    console.log(`\n  ${YELLOW}${CHECK_LABELS[check] ?? check} (${items.length})${RESET}`);
    for (const f of items) {
      console.log(`    ${f.file}${f.owner ? ` ${DIM}[${f.owner}]${RESET}` : ""}`);
      console.log(`      ${describe(f)}`);
    }
  }

  console.log(`\n  ${result.findings.length} finding(s) total`);
  return 1;
}


/**
 * `claims judge <file>` — pose the questions, and say what is already settled.
 *
 * PRINTS AND RECORDS; IT DOES NOT DECIDE. propagate carries no model and makes no
 * network call (dependencies: ajv, proper-lockfile, yaml), and adding one here to
 * classify prose would make every deterministic guarantee in this codebase
 * conditional on a remote service. The judge is the caller — an agent session, or
 * a person. This hands out the blocks and stores the answers.
 *
 * `--json` is the agent-facing surface: the question set, verbatim block text,
 * each keyed by the sha a verdict must be recorded against. Nothing about the
 * shape asks the caller to recompute a hash or re-normalise text, because a judge
 * that normalises differently from the store writes verdicts that never match.
 */
async function judgeSub(rest, json) {
  const file = rest.find((a) => !a.startsWith("--"));
  if (!file) {
    const msg = "usage: propagate claims judge <file> [--json]";
    if (json) console.log(JSON.stringify({ error: msg }));
    else console.error(msg);
    return 2;
  }
  const abs = path.resolve(file);
  const status = await judgeStatus(abs);

  if (status.error) {
    // could-not-run, not "nothing to judge" — the two must never share an exit code.
    const msg = `${abs}: ${status.error}`;
    if (json) console.log(JSON.stringify({ error: msg, file: abs }));
    else console.error(msg);
    return 2;
  }

  if (json) {
    console.log(JSON.stringify({
      file: abs,
      storeExists: status.storeExists,
      counts: {
        judged: status.judged.length,
        unjudged: status.unjudged.length,
        structure: status.structure.length,
        orphaned: status.orphaned.length,
      },
      questions: asQuestions(status),
    }, null, 2));
    return 0;
  }

  console.log(`${BOLD}# claims judge${RESET}  ${DIM}${shortPath(abs)}${RESET}`);
  console.log(
    `  ${status.judged.length} judged · ${status.unjudged.length} unjudged · ` +
      `${status.structure.length} structure (not claims) · ${status.orphaned.length} orphaned verdict(s)`,
  );
  if (!status.storeExists) {
    // Distinct from an empty store. Nothing has ever been judged anywhere, which
    // is a different fact from "this file has not been judged".
    console.log(`  ${DIM}no verdict store yet — nothing has been judged anywhere${RESET}`);
  }
  if (status.orphaned.length > 0) {
    console.log(
      `\n  ${YELLOW}orphaned (${status.orphaned.length})${RESET} ${DIM}— verdicts whose block no longer exists in this file; re-judge or drop, never archive${RESET}`,
    );
  }
  if (status.unjudged.length === 0) {
    console.log(`\n  nothing awaiting judgment in this file.`);
    return 0;
  }
  console.log(`\n  ${YELLOW}awaiting judgment (${status.unjudged.length})${RESET}`);
  for (const b of status.unjudged.slice(0, 20)) {
    const oneLine = b.text.replace(/\s+/gu, " ").trim();
    console.log(`    ${DIM}${b.sha.slice(0, 12)} L${b.startLine}${RESET}  ${oneLine.slice(0, 110)}${oneLine.length > 110 ? " …" : ""}`);
  }
  if (status.unjudged.length > 20) {
    console.log(`    ${DIM}+${status.unjudged.length - 20} more — --json for the full question set${RESET}`);
  }
  return 0;
}

/**
 * `claims render <file> [--apply]` — write each block's verdict beside it.
 *
 * DRY-RUN IS THE DEFAULT, inverting `rollup`'s posture on purpose. `rollup` writes
 * a file it OWNS; this writes into a file a PERSON wrote — the constitution doc is 420 lines of
 * authored prose the caller did not write. The repo already sets this
 * precedent for anything editing what it does not own (`verify`, `bootstrap`), and
 * rule:safety-flag-needs-a-test requires the write path be provably unreachable
 * without the flag.
 *
 * IT TAKES ONE EXPLICIT PATH AND NEVER WALKS. No --all, no glob, no discovery. A
 * command that edits authored prose must not be able to find files on its own; the
 * blast radius of a bug is then exactly the one file the caller named.
 *
 * A hand-edited marker REFUSES (exit 3) rather than being overwritten: a marker
 * disagreeing with the store means someone recorded an opinion in the rendered
 * output instead of in the judgment. Regenerating over it deletes that opinion and
 * teaches people the file lies.
 */
async function renderSub(rest, json) {
  const apply = rest.includes("--apply");
  const file = rest.find((a) => !a.startsWith("--"));
  if (!file) {
    const msg = "usage: propagate claims render <file> [--apply] [--json]";
    if (json) console.log(JSON.stringify({ error: msg }));
    else console.error(msg);
    return 2;
  }
  const abs = path.resolve(file);
  const status = await renderStatus(abs);

  if (status.error) {
    // could-not-run, never 'nothing to render'.
    const msg = abs + ": " + status.error;
    if (json) console.log(JSON.stringify({ error: msg, file: abs }));
    else console.error(msg);
    return 2;
  }

  if (status.handEdited.length > 0) {
    if (json) {
      console.log(JSON.stringify({ status: "hand-edited", file: abs, handEdited: status.handEdited }, null, 2));
    } else {
      console.error(RED + "hand-edited marker(s)" + RESET + " in " + shortPath(abs) + " — nothing written.");
      for (const h of status.handEdited) {
        console.error("    L" + h.line + "  found:    " + h.found);
        console.error("           expected: " + h.expected);
      }
      console.error("\n  A marker is GENERATED from the verdict store. If the store is wrong, fix it");
      console.error("  with `propagate claims judge` — editing the marker records an opinion where");
      console.error("  nothing will ever read it.");
    }
    return 3;
  }

  const summary = {
    file: abs, added: status.added, updated: status.updated,
    removed: status.removed, unchanged: status.unchanged, applied: false,
  };

  if (status.nothingJudged) {
    // NOT "current". Nothing has been judged, so there is nothing to render —
    // a different fact, and the one a path-spelling bug hid behind "current".
    if (json) console.log(JSON.stringify({ ...summary, status: "nothing-judged", judgeable: status.judgeable }, null, 2));
    else {
      console.log(
        YELLOW + "nothing judged" + RESET + " — " + shortPath(abs) + " has " + status.judgeable +
          " judgeable block(s) and 0 verdicts. Nothing to render.",
      );
      console.log("  " + DIM + "`propagate claims judge " + shortPath(abs) + "` lists what is awaiting judgment." + RESET);
    }
    return 0;
  }

  if (status.unchanged) {
    if (json) console.log(JSON.stringify({ ...summary, status: "current", verdicts: status.verdicts }, null, 2));
    else console.log(GREEN + "current" + RESET + " — " + shortPath(abs) + " markers match the store (" + status.verdicts + " verdict(s)).");
    return 0;
  }

  if (!apply) {
    if (json) console.log(JSON.stringify({ ...summary, status: "would-change" }, null, 2));
    else {
      console.log(YELLOW + "would change" + RESET + " " + shortPath(abs) + " — +" + status.added +
        " marker(s), " + status.removed + " removed. Nothing written.");
      console.log("  " + DIM + "re-run with --apply to write." + RESET);
    }
    return 0;
  }

  const { writeFileSync } = await import("node:fs");
  writeFileSync(abs, status.text);
  summary.applied = true;
  if (json) console.log(JSON.stringify({ ...summary, status: "applied" }, null, 2));
  else console.log(GREEN + "wrote" + RESET + " " + shortPath(abs) + " — +" + status.added + ", " + status.removed + " removed.");
  return 0;
}

/**
 * `claims contradict <authored-file>` — hold an authored claim against a derived fact.
 *
 * READ-ONLY. It writes nothing, ever: it derives the facts, pairs them with the
 * claims that could be about them, and reports which pairs nobody has ruled on.
 * The judgment is the caller's — propagate carries no model.
 *
 * Three counts, and the third is the one a simpler design would drop. `unpaired`
 * means a claim names no workspace, so nothing in the derived picture can confirm
 * or refute it. That is not a pass and not a failure; it is the honest statement
 * that this claim is outside what any derivation can check, and most
 * constitutional prose is legitimately in that category.
 */
async function contradictSub(rest, json) {
  const file = rest.find((a) => !a.startsWith("--"));
  if (!file) {
    const msg = "usage: propagate claims contradict <authored-file> [--json]";
    if (json) console.log(JSON.stringify({ error: msg }));
    else console.error(msg);
    return 2;
  }
  const abs = path.resolve(file);

  let roll;
  try {
    roll = rollup({ searchRoots: SEARCH_ROOTS });
  } catch (err) {
    // could-not-run: the derived half is unavailable, so NOTHING can be said
    // about contradictions. Never reported as 'no contradictions found'.
    const msg = "could not derive the rollup: " + err.message;
    if (json) console.log(JSON.stringify({ error: msg }));
    else console.error(msg);
    return 2;
  }

  const status = await contradictStatus(abs, roll);
  if (status.error) {
    const msg = abs + ": " + status.error;
    if (json) console.log(JSON.stringify({ error: msg, file: abs }));
    else console.error(msg);
    return 2;
  }

  if (json) {
    console.log(JSON.stringify({
      file: abs,
      facts: status.factCount,
      counts: { judged: status.judged.length, unjudged: status.unjudged.length, unpaired: status.unpaired.length },
      questions: status.unjudged.map((q) => ({
        pair_sha: q.pairSha,
        block_sha: q.claim.sha,
        against: q.fact.sha,
        claim: q.claim.text,
        fact: q.fact.text,
        startLine: q.claim.startLine,
      })),
    }, null, 2));
    return 0;
  }

  console.log(BOLD + "# claims contradict" + RESET + "  " + DIM + shortPath(abs) + RESET);
  console.log(
    "  " + status.factCount + " derived fact(s) · " + status.judged.length + " pair(s) judged · " +
      status.unjudged.length + " awaiting judgment · " + status.unpaired.length + " claim(s) unpaired",
  );
  if (status.unpaired.length > 0) {
    console.log(
      "  " + DIM + "unpaired = names no workspace, so no derived fact can confirm or refute it — " +
        "not a pass" + RESET,
    );
  }
  if (status.unjudged.length === 0) {
    console.log("\n  nothing awaiting judgment.");
    return 0;
  }
  console.log("\n  " + YELLOW + "awaiting judgment (" + status.unjudged.length + ")" + RESET);
  for (const q of status.unjudged.slice(0, 15)) {
    const claimLine = q.claim.text.replace(/\s+/gu, " ").trim().slice(0, 96);
    console.log("    " + DIM + "L" + q.claim.startLine + RESET + "  claim: " + claimLine);
    console.log("           fact:  " + q.fact.text);
  }
  if (status.unjudged.length > 15) {
    console.log("    " + DIM + "+" + (status.unjudged.length - 15) + " more — --json for the full set" + RESET);
  }
  return 0;
}
