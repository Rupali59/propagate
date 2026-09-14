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
import os from "node:os";
import { RESET, DIM, RED, YELLOW, GREEN, BOLD } from "./ansi.mjs";
import { claimsCheck } from "../lib/claims/check.mjs";
import { judgeStatus, asQuestions } from "../lib/claims/judge.mjs";
import { renderStatus } from "../lib/claims/render.mjs";
import { contradictStatus } from "../lib/claims/contradict.mjs";
import { restateStatus, asQuestions as asRestateQuestions } from "../lib/claims/restate.mjs";
import { appendClaim, dryValidateClaim, CLAIM_FINDINGS } from "../lib/claims/store.mjs";
import { appendRunStart, appendRunEnd, RUN_OUTCOMES } from "../lib/claims/runs.mjs";
import { rollup } from "../lib/report/rollup.mjs";
import { checkRules } from "../lib/rules/rules-check.mjs";
import { WORKSPACES, SEARCH_ROOTS, RULES_DIR, shortPath } from "../lib/core/config.mjs";

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
  if (sub === "restate") return restateSub(argv.slice(1), json);
  if (sub === "verdict") return verdictSub(argv.slice(1), json);
  if (sub === "answer") return answerSub(argv.slice(1), json);

  if (sub !== "check") {
    const msg =
      `unknown claims subcommand: ${sub ?? "(none)"}\n` +
      `usage: propagate claims check [--json]\n` +
      `       propagate claims judge <file> [--json]\n` +
      `       propagate claims render <file> [--apply] [--json]\n` +
      `       propagate claims contradict <authored-file> [--json]\n` +
      `       propagate claims restate [--json]\n` +
      `       propagate claims answer <file> start [--json]\n` +
      `       propagate claims answer <file> end --run <id> --outcome <${RUN_OUTCOMES.join("|")}> [--reason ...] [--json]`;
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

  // `expired-date` is the one check whose findings are CANDIDATES rather than
  // defects, and this tree's dominant idiom — "this line said X until <date>" —
  // matches its shape. Reporting the split is what `lib/claims/check.mjs`'s
  // HISTORICAL_RECORD_RE comment promises ("prints how many look historical")
  // and, until 2026-09-10, silently did not: 71 of 71 rendered identically while
  // 68 carried the past-tense shape. Nothing is filtered here — `claims judge`
  // decides. This only stops a reader mistaking 71 candidates for 71 defects.
  const ec = result.expiredDateCandidates;
  if (ec && ec.total > 0) {
    // Every number on this line is a FINDING count. It briefly subtracted a
    // scanned-LINE counter from a finding total and published "17 not
    // past-tense" where the like-for-like answer was 48.
    console.log(
      `\n  ${DIM}expired-date are CANDIDATES, not defects: ${ec.total} finding(s), ` +
        `${ec.looksHistorical} match the past-tense "was X until <date>" shape, ` +
        `${ec.notHistorical} do not. Nothing suppressed — \`claims judge\` decides.${RESET}`,
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
        unanswerable: status.unanswerable.length,
        structure: status.structure.length,
        orphaned: status.orphaned.length,
      },
      runs: status.runs,
      questions: asQuestions(status),
    }, null, 2));
    return 0;
  }

  console.log(`${BOLD}# claims judge${RESET}  ${DIM}${shortPath(abs)}${RESET}`);
  // The exact phrase "unjudged, N run(s)" is load-bearing: a client with no
  // brain and no answering run ever attempted must read as
  // "N unjudged, 0 run(s)" and NEVER "0 findings" — those are different facts
  // (`rule:discernment-checks` §2), and this line is the one place that
  // distinction has to survive contact with a human reader.
  const runWord = status.runs.count === 1 ? "run" : "runs";
  console.log(
    `  ${status.judged.length} judged · ${status.unjudged.length} unjudged, ${status.runs.count} ${runWord} · ` +
      `${status.unanswerable.length} unanswerable · ${status.structure.length} structure (not claims) · ` +
      `${status.orphaned.length} orphaned verdict(s)`,
  );
  if (!status.storeExists) {
    // Distinct from an empty store. Nothing has ever been judged anywhere, which
    // is a different fact from "this file has not been judged".
    console.log(`  ${DIM}no verdict store yet — nothing has been judged anywhere${RESET}`);
  }
  if (status.runs.status === "crashed") {
    console.log(
      `  ${YELLOW}latest answering run for this file has no end record${RESET} ${DIM}— started, never resolved (crash or still in flight); unjudged blocks read as unanswerable until an "end" is recorded${RESET}`,
    );
  } else if (status.runs.status === "completed" && status.runs.outcome !== "ok") {
    console.log(
      `  ${YELLOW}latest answering run ended "${status.runs.outcome}"${RESET} ${DIM}— unjudged blocks read as unanswerable, not unjudged${RESET}`,
    );
  }
  if (status.orphaned.length > 0) {
    console.log(
      `\n  ${YELLOW}orphaned (${status.orphaned.length})${RESET} ${DIM}— verdicts whose block no longer exists in this file; re-judge or drop, never archive${RESET}`,
    );
  }
  if (status.unanswerable.length > 0) {
    console.log(`\n  ${YELLOW}unanswerable (${status.unanswerable.length})${RESET} ${DIM}— a prior answering run tried and could not; still a question, not a pass${RESET}`);
    for (const b of status.unanswerable.slice(0, 20)) {
      const oneLine = b.text.replace(/\s+/gu, " ").trim();
      console.log(`    ${DIM}${b.sha.slice(0, 12)} L${b.startLine}${RESET}  ${oneLine.slice(0, 110)}${oneLine.length > 110 ? " …" : ""}`);
    }
    if (status.unanswerable.length > 20) {
      console.log(`    ${DIM}+${status.unanswerable.length - 20} more — --json for the full question set${RESET}`);
    }
  }
  if (status.unjudged.length === 0) {
    console.log(`\n  nothing else awaiting judgment in this file.`);
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
 * `claims answer <file> start|end` — record an answering-RUN attempt, never a
 * verdict. This is what makes `unanswerable` possible at all: propagate never
 * probes whether a judge is alive (Premise 1), so the only way it can ever
 * know "something tried and could not" is a record the CALLER writes.
 *
 * `start` must be invoked before any answering work begins (Reviewer Concern
 * 2) — a run that crashes after `start` but before `end` is reported by
 * `claims judge` as `crashed`, distinguishable from `never` (no attempt) and
 * from a deliberate `no-brain`/`error` outcome. `end` requires the `run_id`
 * `start` printed, so the two records are correlated without guessing which
 * start belongs to which end.
 *
 * CALLS THE CLI SURFACE, NOT THE LIBRARY DIRECTLY — the answering skill lives
 * outside propagate (open question in the plan) and must not import `lib/`;
 * this subcommand is its only door in, matching the same posture `claims
 * check`/`judge`/`contradict` already take.
 */
async function answerSub(rest, json) {
  const mode = rest.find((a) => a === "start" || a === "end");
  const file = rest.find((a) => !a.startsWith("--") && a !== "start" && a !== "end");
  const usage =
    `usage: propagate claims answer <file> start [--json]\n` +
    `       propagate claims answer <file> end --run <id> --outcome <${RUN_OUTCOMES.join("|")}> [--reason ...] [--json]`;

  if (!file || !mode) {
    if (json) console.log(JSON.stringify({ error: usage }));
    else console.error(usage);
    return 2;
  }
  const abs = path.resolve(file);

  if (mode === "start") {
    const { run_id } = await appendRunStart(abs);
    if (json) console.log(JSON.stringify({ file: abs, run_id, phase: "start" }, null, 2));
    else console.log(`${GREEN}started${RESET} run ${run_id} for ${shortPath(abs)} — pass this id to \`claims answer ${file} end --run ${run_id} ...\` when done.`);
    return 0;
  }

  // mode === "end"
  const runIdx = rest.indexOf("--run");
  const outcomeIdx = rest.indexOf("--outcome");
  const reasonIdx = rest.indexOf("--reason");
  const run_id = runIdx >= 0 ? rest[runIdx + 1] : undefined;
  const outcome = outcomeIdx >= 0 ? rest[outcomeIdx + 1] : undefined;
  const reason = reasonIdx >= 0 ? rest[reasonIdx + 1] : undefined;

  if (!run_id || !outcome) {
    if (json) console.log(JSON.stringify({ error: usage }));
    else console.error(usage);
    return 2;
  }

  try {
    await appendRunEnd(abs, run_id, outcome, { reason });
  } catch (err) {
    // A rejected write (bad outcome, missing reason on no-brain/error) is a
    // caller mistake, not "nothing to record" — exit 2, same posture as every
    // other usage error in this file.
    if (json) console.log(JSON.stringify({ error: err.message }));
    else console.error(err.message);
    return 2;
  }

  if (json) console.log(JSON.stringify({ file: abs, run_id, phase: "end", outcome }, null, 2));
  else console.log(`${GREEN}recorded${RESET} run ${run_id} for ${shortPath(abs)} — outcome "${outcome}".`);
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

/**
 * `claims restate` — Phase 2a: hold each rule's own text against the copy of
 * it a `CLAUDE.md` restates.
 *
 * THE CORPUS IS HANDED TO US, NOT SEARCHED FOR. `checkRules`'s
 * `referencedRestatements` already names every (rule, file) pair that both
 * matches a rule's fingerprint AND cites it — the population the parent
 * detector excuses and never checks further (docs/ISSUES.md N35). No ranking,
 * no threshold: this command takes exactly that list and asks one question per
 * pair. The silent set (a restatement with no citation) is Phase 2b and is
 * out of scope here.
 *
 * READ-ONLY, same posture as `claims contradict`: it derives, it pairs, it
 * reports which pairs await judgment. It writes nothing and decides nothing —
 * propagate carries no model.
 *
 * Takes no file argument, unlike `contradict` — the corpus spans every
 * `CLAUDE.md` under `SEARCH_ROOTS` at once (tool-priority alone names 11), so
 * there is no single "authored file" to scope this to.
 */
async function restateSub(rest, json) {
  // Same carve-out `rulesCmd` (cli.mjs) makes: the global CLAUDE.md is the
  // rules' former home and legitimately contains every fingerprint, so it is
  // scanned for overrides but excluded from findings.
  const globalMd = path.join(os.homedir(), ".claude", "CLAUDE.md");
  let res;
  try {
    res = checkRules({ rulesDir: RULES_DIR, roots: SEARCH_ROOTS, extra: [globalMd], exclude: [globalMd] });
  } catch (err) {
    const msg = "could not run the rules check: " + err.message;
    if (json) console.log(JSON.stringify({ error: msg }));
    else console.error(msg);
    return 2;
  }

  if (res.diagnostic !== "ok") {
    // could-not-run, never "nothing to restate" — same posture as every other
    // could-not-derive path in this file.
    const why = {
      "no-rules": `no rules found in ${RULES_DIR}`,
      "roots-missing": `configured root(s) do not exist: ${res.missing.join(", ")}`,
      "no-files-scanned": `roots exist but contain no CLAUDE.md — nothing was checked`,
    }[res.diagnostic] ?? res.diagnostic;
    const msg = "rules check did not run: " + why;
    if (json) console.log(JSON.stringify({ error: msg }));
    else console.error(msg);
    return 2;
  }

  const status = await restateStatus(res.referencedRestatements, res.rules);

  if (json) {
    console.log(JSON.stringify({
      corpus: status.corpusCount,
      facts: status.factCount,
      counts: { judged: status.judged.length, unjudged: status.unjudged.length, unpaired: status.unpaired.length },
      unpaired: status.unpaired,
      questions: asRestateQuestions(status),
    }, null, 2));
    return 0;
  }

  console.log(BOLD + "# claims restate" + RESET + "  " + DIM + "(the excused set — cites AND restates)" + RESET);
  console.log(
    "  " + status.corpusCount + " pair(s) handed to us · " + status.factCount + " distinct rule fact(s) · " +
      status.judged.length + " judged · " + status.unjudged.length + " awaiting judgment · " +
      status.unpaired.length + " unpaired",
  );
  if (status.unpaired.length > 0) {
    console.log(
      "\n  " + YELLOW + "unpaired (" + status.unpaired.length + ")" + RESET +
        " " + DIM + "— could not be checked, not a pass" + RESET,
    );
    for (const u of status.unpaired) {
      console.log("    " + DIM + u.rule + RESET + "  " + shortPath(u.file) + ":" + u.line);
      console.log("      " + u.reason);
    }
  }
  if (status.unjudged.length === 0) {
    console.log("\n  nothing awaiting judgment.");
    return 0;
  }
  console.log("\n  " + YELLOW + "awaiting judgment (" + status.unjudged.length + ")" + RESET);
  for (const p of status.unjudged) {
    console.log("    " + DIM + p.rule + RESET + "  " + shortPath(p.file) + ":" + p.claim.startLine);
    console.log("      claim: " + p.claim.text.replace(/\s+/gu, " ").trim().slice(0, 96));
  }
  return 0;
}


/**
 * `claims verdict` — the write path the judgment lane was missing.
 *
 * WHY THIS EXISTS. `claims restate` poses questions and `claims judge` reports
 * which blocks await one, but until now NOTHING could record an answer: there
 * was no `appendClaim` caller anywhere in `commands/`. A lane that poses
 * questions nobody can answer does not converge — every run re-reports the same
 * 15 entries forever, which is a worklist that reads as coverage.
 *
 * VERDICTS ARRIVE ON STDIN, and the caller is outside the tool. That is the
 * whole architecture, stated in `judge.mjs`: propagate poses the question and
 * stores the answer; the judge is whoever is calling. So this reads JSON and
 * writes it — it does not decide anything, contains no model, and makes no
 * network call.
 *
 * DRY RUN BY DEFAULT, `--apply` TO WRITE. The house posture, and it is not
 * decoration: `rule:safety-flag-needs-a-test` records three separate incidents
 * in this tree where a command documented as a preview wrote to an append-only
 * store anyway, the worst costing 11 spurious events and 3 silently-closed
 * worklist items. Validation runs identically on both paths, so the preview
 * cannot promise a write that `--apply` then rejects.
 *
 * Accepts a JSON array or JSONL, because both are what a caller naturally has.
 */
async function verdictSub(rest, json) {
  const apply = rest.includes("--apply");
  const usage =
    `usage: propagate claims verdict [--apply] [--json]  < verdicts.json\n` +
    `       stdin: a JSON array, or one JSON object per line. Each needs\n` +
    `       {file, block_sha, kind} and, to record a judgement,\n` +
    `       {against, finding} together — finding one of: ${CLAIM_FINDINGS.join(", ")}`;

  let raw = "";
  try {
    for await (const chunk of process.stdin) raw += chunk;
  } catch (err) {
    if (json) console.log(JSON.stringify({ error: `could not read stdin: ${err.message}` }));
    else console.error(`could not read stdin: ${err.message}`);
    return 2;
  }
  if (!raw.trim()) {
    if (json) console.log(JSON.stringify({ error: usage }));
    else console.error(usage);
    return 2;
  }

  // Array or JSONL, and a parse failure names the line rather than dying with
  // "Unexpected token" — absence of a usable input is attributable too.
  let verdicts;
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try { verdicts = JSON.parse(trimmed); } catch (err) {
      const msg = `stdin is not valid JSON: ${err.message}`;
      if (json) console.log(JSON.stringify({ error: msg })); else console.error(msg);
      return 2;
    }
  } else {
    verdicts = [];
    const lines = trimmed.split("\n").filter((l) => l.trim());
    for (const [i, line] of lines.entries()) {
      try { verdicts.push(JSON.parse(line)); } catch (err) {
        const msg = `stdin line ${i + 1} is not valid JSON: ${err.message}`;
        if (json) console.log(JSON.stringify({ error: msg })); else console.error(msg);
        return 2;
      }
    }
  }
  if (!Array.isArray(verdicts)) verdicts = [verdicts];

  // Validate EVERY verdict before writing ANY. A partial write to an
  // append-only store cannot be taken back, so a batch with one bad row is
  // refused whole rather than half-applied.
  const refused = [];
  verdicts.forEach((v, i) => {
    const why = dryValidateClaim(v);
    if (why) refused.push({ index: i, file: v?.file ?? null, error: why });
  });

  if (refused.length) {
    if (json) console.log(JSON.stringify({ applied: 0, refused }, null, 2));
    else {
      console.error(`${RED}refused ${refused.length} of ${verdicts.length}${RESET} — nothing written`);
      for (const r of refused) console.error(`  [${r.index}] ${r.file ?? "(no file)"}: ${r.error}`);
    }
    return 2;
  }

  if (!apply) {
    if (json) console.log(JSON.stringify({ applied: 0, wouldWrite: verdicts.length, dryRun: true }, null, 2));
    else {
      console.log(`${BOLD}would write ${verdicts.length} verdict(s)${RESET} ${DIM}— nothing has been written${RESET}`);
      for (const v of verdicts) {
        console.log(`  ${DIM}${v.finding ?? "(no finding)"}${RESET}  ${shortPath(v.file)}  ${DIM}${String(v.block_sha).slice(0, 12)}${RESET}`);
      }
      console.log(`\n  ${DIM}pass ${RESET}${BOLD}--apply${RESET}${DIM} to write these to the claim store${RESET}`);
    }
    return 0;
  }

  const written = [];
  for (const v of verdicts) {
    const stamped = await appendClaim(v);
    written.push({ claim_id: stamped?.claim_id ?? null, file: v.file, finding: v.finding ?? null });
  }
  if (json) console.log(JSON.stringify({ applied: written.length, written }, null, 2));
  else {
    console.log(`${GREEN}wrote ${written.length} verdict(s)${RESET}`);
    for (const w of written) console.log(`  ${w.finding ?? "(no finding)"}  ${shortPath(w.file)}  ${DIM}${w.claim_id ?? ""}${RESET}`);
  }
  return 0;
}
