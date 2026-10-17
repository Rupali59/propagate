/**
 * machinery.mjs -- the data behind `GET /api/machinery` (dashboard Phase 2).
 *
 * One block per "machinery and work" source -- claims, rules, caps, skills, backlog, goals --
 * each `{status:"ok"|"error", reason, count, of, label, top}`. `count` is the headline figure
 * for that source (what its CLI command would lead with); `top` is one line of detail.
 *
 * THE LIBRARIES, NOT THE CLI. Every source calls the function behind the command
 * (`claimsCheck`, `checkRules`+`ruleCoverage`, `capsReport`, `scanSkills`, `backlog`,
 * `parseGoalsFile`) in-process. The CLI arms print and call process.exit; shelling out to them
 * would cost a node start each and parse text.
 *
 * ABSENCE IS ATTRIBUTABLE (rule:discernment-checks 2 and 6). A source that throws is
 * `status:"error"` with its message, never a 0. So is a source that RAN BUT LOOKED AT NOTHING --
 * measured 2026-10-17: with no configured roots, claims/caps/backlog/goals each return a clean
 * `0` (claims: 0 files checked, 0 findings) which would read as "all clear". The `blind()` guard
 * in each source turns that into an error that says what was not read.
 *
 * ONE COMPUTATION FEEDS THE TILE AND THE VIEW (dashboard Phase 4a). The four sources that have a page
 * of their own (claims, rules, caps, skills) return `detail` beside the headline figure: the rows the
 * page lists. The `count` is DERIVED FROM THOSE ROWS by the shape functions below, and `GET /api/claims`
 * (and /rules, /caps, /skills) reads the same cached computation as `GET /api/machinery`, so a tile and
 * its page cannot disagree -- not by a bug and not by two reads a minute apart.
 *
 * PHASE 4b adds backlog and goals to that set (their pages list the items and the goals AND plans), and a seventh,
 * PAGE-ONLY source, `history`: the last RECORDED release, monitor and doctor results. It has no tile, so it is not in
 * MACHINERY_KEYS (the Overview shows six tiles and the tile payload stays six blocks); it rides the same cached run
 * and is read through `readDetail("history")`. It never RUNS release, monitor or doctor: it reads what each one left on disk.
 *
 * Nothing here writes. The sources are the same reads the CLI does.
 */

import path from "node:path";

/**
 * How long the whole response is reused. Measured 2026-10-17 (CLI wall time, including the node
 * start): claims ~1.2 s, skills ~1.6 s, rules 0.16 s, caps 0.35 s, backlog 0.34 s, goals 0.32 s.
 * Two of the six are slow and none of them changes second to second (they read the tree's docs,
 * not the ledger), so a minute turns a page that re-polls into one real computation. Longer would
 * show a fixed file as still broken for too long after the person fixed it.
 */
export const MACHINERY_TTL_MS = 60_000;

/** The six, in the order the Overview shows them. */
export const MACHINERY_KEYS = ["claims", "rules", "caps", "skills", "backlog", "goals"];

/** A source that ran and looked at nothing is a failure to read, not a clean result. */
function blind(what) {
  throw new Error(`${what} -- it ran and looked at nothing, which is not the same as nothing being wrong`);
}

const short = (f) => String(f ?? "").replace(/^.*\/GitHub\//, "");
const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + "…" : String(s));

/** Days without a use after which a used skill counts as dormant. A stated constant: the CLI has no such word. */
export const DORMANT_DAYS = 90;

const rel = (f) => String(f ?? "");
const num = (n) => (typeof n === "number" && isFinite(n) ? n : null);

/**
 * Shape functions: library output in, `{count, of, label, top, detail}` out. Pure, so a test feeds a
 * fixture and the production loaders below feed the real libraries through the SAME function.
 * `count` is computed from `detail.rows`, never from a second field of the library result.
 */
export function shapeClaims(r, labels = {}, describe = (f) => JSON.stringify(f)) {
  const rows = r.findings.map((f, i) => {
    const claim = f.check === "expired-date" ? `${f.marker}${f.approx ? " ~" : " "}${f.dateText}`
      : f.check === "footer-stale" ? String(f.footer)
      : f.check === "rotted-citation" ? String(f.branch ?? f.citedPath ?? (f.citedLine != null ? "line " + f.citedLine : f.subtype ?? ""))
      : f.check === "dead-concept-token" ? String(f.token)
      : f.check === "price-literal-drift" ? String(f.label)
      : "";
    const line = num(f.line);
    return {
      id: `${f.check}|${rel(f.file)}|${line ?? ""}|${i}`,
      kind: f.check, kindLabel: labels[f.check] ?? f.check, file: rel(f.file), line, owner: f.owner ?? null,
      claim, message: describe(f), historical: f.looksHistorical === true,
    };
  });
  const byKind = new Map();
  for (const x of rows) byKind.set(x.kind, (byKind.get(x.kind) ?? 0) + 1);
  const kinds = [...byKind].sort((a, b) => b[1] - a[1]).map(([kind, count]) => ({ kind, label: labels[kind] ?? kind, count }));
  const unread = (r.files?.unreadable?.length ?? 0) + (r.sidecars?.unreadable?.length ?? 0);
  const cov = r.coverage ?? {};
  return {
    count: rows.length,
    label: "findings",
    top: (kinds.slice(0, 2).map((k) => `${k.count} ${k.kind}`).join(" · ") || "no findings") + ` · ${cov.filesChecked} files checked` + (unread ? ` · ${unread} unreadable` : ""),
    detail: { rows, kinds, summary: { findings: rows.length, filesChecked: cov.filesChecked ?? 0, sidecarsChecked: cov.sidecarsChecked ?? 0, sourceEdges: cov.sourceEdges ?? 0, globsSkipped: cov.globsSkipped ?? 0, unreadable: unread } },
  };
}

export function shapeRules(res, cov) {
  const covBy = new Map(cov.map((c) => [c.id, c]));
  const hitsBy = (list) => {
    const m = new Map();
    for (const f of list) {
      const line = Array.isArray(f.hits) && f.hits.length ? f.hits[0] : (num(f.line) ?? null);
      (m.get(f.rule) ?? m.set(f.rule, []).get(f.rule)).push({ file: rel(f.file), line });
    }
    return m;
  };
  const restated = hitsBy(res.findings);
  const excused = hitsBy(res.referencedRestatements ?? []);
  const rows = res.rules.map((r) => {
    const c = covBy.get(r.id) ?? { matched: 0, referenced: 0, status: "unexercised" };
    const restatedIn = restated.get(r.id) ?? [];
    return {
      id: r.id, scope: r.scope ?? null, file: rel(r.__file), coverage: c.status,
      // Restated is the louder word and wins the display; `coverage` keeps the other fact.
      status: restatedIn.length ? "restated" : c.status,
      referenced: c.referenced ?? 0, matched: c.matched ?? 0,
      restatedIn, excusedIn: excused.get(r.id) ?? [],
    };
  });
  const unexercised = rows.filter((x) => x.coverage === "unexercised").length;
  const restatedCount = rows.reduce((n, x) => n + x.restatedIn.length, 0);
  const excusedCount = rows.reduce((n, x) => n + x.excusedIn.length, 0);
  return {
    count: unexercised + restatedCount,
    of: rows.length,
    label: "rules to look at",
    top: `${unexercised} unexercised · ${restatedCount} restated` + (excusedCount ? ` · ${excusedCount} more restate one they also cite` : ""),
    detail: { rows, summary: { rules: rows.length, adopted: rows.filter((x) => x.coverage === "adopted").length, firing: rows.filter((x) => x.coverage === "firing").length,
      unexercised, restated: restatedCount, restatedRules: rows.filter((x) => x.restatedIn.length).length, excused: excusedCount, filesScanned: res.filesScanned ?? 0 } },
  };
}

export function shapeCaps(r) {
  const keep = r.records.filter((x) => x.status === "over" || x.status === "yellow" || x.status === "exempt");
  const rows = keep.map((x) => ({
    id: rel(x.file), file: rel(x.file), kind: x.kind ?? null, scope: x.scope ?? null, project: x.project ?? null, metric: x.metric ?? "lines",
    actual: num(x.actual), cap: num(x.cap), ratio: num(x.cap) > 0 && num(x.actual) != null ? x.actual / x.cap : null, status: x.status,
  }));
  const over = rows.filter((x) => x.status === "over");
  const worst = [...over].sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0))[0];
  return {
    count: over.length,
    of: r.totals.measured,
    label: "files over cap",
    top: worst ? `worst ${worst.ratio.toFixed(1)}x · ${short(worst.file)}` : "none over cap",
    detail: { rows, summary: { measured: r.totals.measured, over: over.length, yellow: rows.filter((x) => x.status === "yellow").length, exempt: rows.filter((x) => x.status === "exempt").length,
      skippedStubs: r.totals.skippedStubs ?? 0, excessLines: r.totals.excessLines ?? 0 } },
  };
}

export function shapeSkills(scan, tx, now = Date.now(), neverMeans = "zero in skillUsage AND zero in transcripts") {
  const rows = scan.skills.map((s) => {
    const last = num(s.lastUsedAt);
    const status = s.neverInvoked ? "never invoked" : last != null && now - last > DORMANT_DAYS * 86_400_000 ? "dormant" : "active";
    const p = s.provenance;
    return {
      id: s.id, installer: s.installer ?? null, provenance: p ? (p.source ?? p.sourceUrl ?? null) : null,
      uses: num(s.usageCount) ?? 0, transcripts: num(s.transcriptCount) ?? 0, lastUsedAt: last, status,
    };
  });
  const never = rows.filter((x) => x.status === "never invoked").length;
  const best = scan.skills.filter((s) => s.usageCount > 0).sort((a, b) => b.usageCount - a.usageCount)[0];
  return {
    count: never,
    of: rows.length,
    label: "never invoked",
    top: (best ? `most used ${best.id} (${best.usageCount})` : "none used")
      + (tx.scanned ? "" : " · transcript probe unavailable, so this rests on the usage counter alone"),
    detail: { rows, summary: { total: rows.length, neverInvoked: never, dormant: rows.filter((x) => x.status === "dormant").length, dormantDays: DORMANT_DAYS,
      transcriptProbe: !!tx.scanned, neverInvokedMeans: neverMeans, orphanUsageKeys: scan.orphanUsageKeys?.length ?? 0 } },
  };
}

/* ── Phase 4b: Backlog ─────────────────────────────────────────────────────────────────────────────────── */

/** The file kind an item came from, derived from the register's own name: the ranked items carry a `format`, not a kind. */
const BACKLOG_KIND_BY_FILE = { "STATE.md": ["state", "STATE.md live section"], "TODOS.md": ["todo", "TODOS.md"], "ISSUES.md": ["issue", "ISSUES.md"] };
export function backlogKind(file) {
  const base = String(file ?? "").split("/").pop();
  return (BACKLOG_KIND_BY_FILE[base] ?? ["other", "another register"])[0];
}
const BACKLOG_KIND_LABEL = { state: "STATE.md", todo: "TODOS.md", issue: "ISSUES.md", other: "other" };

const oneLine = (t) => String(t ?? "").replace(/\*\*/g, "").replace(/\s+/g, " ").trim();

/**
 * Library output (`backlog()`) in, `{count, of, label, top, detail}` out. The ROWS are the ranked items and nothing
 * else: handovers are sections with a discharge state, not task lines, and the library keeps them out of `ranked`
 * on purpose ("putting 'Four repos carry uncommitted fixes' beside 'TM-015 Daily sky timelapse video' would rank
 * them together"). They are summarised, never mixed into the rows. `count` (the tile) is DERIVED from the rows.
 */
export function shapeBacklog(r, caveat = () => null) {
  const items = r.ranked ?? [];
  const rows = items.map((i, n) => {
    const pri = typeof i.priority === "number" && isFinite(i.priority) ? i.priority : null;
    return {
      id: `${rel(i.file)}|${num(i.line) ?? ""}|${n}`,
      ref: typeof i.id === "string" && i.id ? i.id : null, priority: pri, text: oneLine(i.text), file: rel(i.file), line: num(i.line), kind: backlogKind(i.file),
      section: i.section ?? null, alsoIn: Math.max(0, (Array.isArray(i.sources) ? i.sources.length : 1) - 1),
    };
  });
  const byPriority = { P0: 0, P1: 0, P2: 0, P3: 0, none: 0 };
  for (const x of rows) byPriority[x.priority === null ? "none" : "P" + x.priority] = (byPriority[x.priority === null ? "none" : "P" + x.priority] ?? 0) + 1;
  const byKind = new Map();
  for (const x of rows) byKind.set(x.kind, (byKind.get(x.kind) ?? 0) + 1);
  const kinds = [...byKind].sort((a, b) => b[1] - a[1]).map(([kind, count]) => ({ kind, label: BACKLOG_KIND_LABEL[kind] ?? kind, count }));
  const first = rows.find((x) => x.priority !== null);
  const cav = caveat(byPriority.none, rows.length);
  const hos = (r.handovers?.files ?? []).flatMap((f) => f.sections ?? []);
  return {
    count: byPriority.none,
    of: rows.length,
    label: "items with no priority",
    top: first ? `top: P${first.priority} ${clip(first.text, 70)}` : `${(r.totals?.stateFilesRead ?? 0) + (r.totals?.todoFilesRead ?? 0) + (r.totals?.issueFilesRead ?? 0)} files read`,
    detail: { rows, kinds, summary: {
      items: rows.length, files: new Set(rows.map((x) => x.file)).size,
      filesRead: { state: r.totals?.stateFilesRead ?? 0, todo: r.totals?.todoFilesRead ?? 0, issue: r.totals?.issueFilesRead ?? 0 },
      byPriority, caveat: cav ? `${cav.head} — ${cav.tail}` : null,
      mergedDuplicates: r.mergedCount ?? 0, unparsedFiles: r.totals?.unparsedFiles ?? 0,
      handovers: { sections: hos.length, open: hos.filter((x) => x.status === "open").length },
      delegatedRegisters: (r.totals?.delegated ?? []).length,
    } },
  };
}

/* ── Phase 4b: Goals and Plans ─────────────────────────────────────────────────────────────────────────── */

/**
 * Parsed GOALS.md files in, rows out. A file the reader could not understand is a ROW with its reason (status
 * "unreadable"), never dropped and never zero goals. The tile's `count` (open goals) is derived from the rows;
 * `of` is the goals actually read, so an unreadable file does not inflate the denominator.
 */
export function shapeGoalRows(files) {
  const rows = [];
  for (const f of files) {
    if (f.unread) {
      rows.push({ id: `${rel(f.file)}|unread`, file: rel(f.file), n: null, title: null, status: "unreadable", derivation: null, command: null, reason: f.reason ?? "the file could not be read" });
      continue;
    }
    f.entries.forEach((e, i) => rows.push({
      id: `${rel(f.file)}|${e.n}|${i}`, file: rel(f.file), n: num(e.n) ?? e.n ?? null, title: String(e.title ?? ""),
      status: e.status === "open" || e.status === "closed" ? e.status : "unknown",
      derivation: e.derivation === "claimed" || e.derivation === "waived" ? e.derivation : "none",
      command: e.derivation === "claimed" && e.command ? String(e.command) : null, reason: null,
    }));
  }
  return rows;
}

/** The plan words the page shows. `live` = cited by a hub seed ("linked"); `finished` is split by HOW it was found finished. */
export function planStatusWord(p) {
  if (p.unreadable) return "unreadable";
  if (p.state === "live") return "linked";
  if (p.state === "finished") return p.finishedBy === "archive-dir" ? "archived" : "finished";
  return "undeclared";
}

/**
 * One `checkPlans` report (one root) in, `{ok, rows, summary}` or `{ok:false, error}` out. An invalid root is an
 * error with its reason; a valid root with no plan is `ok` with 0 rows and the number of files scanned, so the page
 * can say "scanned 50 files, none is a plan" rather than a bare empty table.
 */
export function shapePlans(report) {
  const r = report?.results?.[0];
  if (!r) return { ok: false, error: "plans check returned no result for its root" };
  if (!r.ok) return { ok: false, error: `${r.reason ?? "invalid root"}${r.detail ? ": " + r.detail : ""} (${r.root})` };
  const rows = (r.plans ?? []).map((p, i) => ({
    id: `${rel(p.file)}|${i}`, file: rel(p.file), unreadable: p.unreadable === true,
    date: p.authoredDate?.date ?? null, dateSource: p.authoredDate?.source ?? null,
    status: planStatusWord(p), reason: p.unreadable ? String(p.reason ?? "unreadable") : String(p.why ?? ""),
    statusPhrase: p.statusPhrase ?? null, grade: p.unreadable ? null : (p.grade ?? null), gated: p.gated === true,
  }));
  const by = {};
  for (const x of rows) by[x.status] = (by[x.status] ?? 0) + 1;
  return { ok: true, rows, summary: { root: rel(r.root), scanned: r.scanned ?? 0, plans: rows.length, byStatus: by, excluded: (r.excluded ?? []).length, notFullyWalked: (r.dropped ?? []).length } };
}

export function shapeGoals(files, plans) {
  const rows = shapeGoalRows(files);
  const read = rows.filter((x) => x.status !== "unreadable");
  const open = read.filter((x) => x.status === "open").length;
  const closed = read.filter((x) => x.status === "closed").length;
  const unread = rows.length - read.length;
  const uncheckable = read.filter((x) => x.derivation === "none").length;
  return {
    count: open,
    of: read.length,
    label: "open goals",
    top: `${files.length} files` + (unread ? ` · ${unread} unreadable` : "") + (uncheckable ? ` · ${uncheckable} cannot be checked` : "") + (closed ? ` · ${closed} closed` : ""),
    detail: { rows, plans, summary: { files: files.length, unreadable: unread, goals: read.length, open, closed, unknown: read.length - open - closed,
      claimed: read.filter((x) => x.derivation === "claimed").length, waived: read.filter((x) => x.derivation === "waived").length, uncheckable } },
  };
}

/* ── Phase 4b: History (page-only) ─────────────────────────────────────────────────────────────────────── */

/**
 * Rows kept per history table. Monitor logs one line per 1800 s run, so 20 rows is about ten hours: enough to see
 * whether it is running on schedule and what it last found, without paging through the 5,000 lines the log holds.
 */
export const HISTORY_ROWS = 20;

/** The command each history part offers when nothing (or not enough) is recorded. Read-only forms where one exists. */
export const HISTORY_COMMANDS = {
  doctor: "propagate doctor",
  monitor: "propagate monitor --dry-run",
  release: "propagate release --check",
};

const MONITOR_LINE = /^(\S+) ran=1 rows=(\d+) actionable=(\d+) notified=(\d+) suppressed=(\d+) ms=(\d+)(?: error=("(?:[^"\\]|\\.)*"))?(?: run=(\S+))?$/;
/** One `logRun` line in, a row out, or null when the line is not the shape `logRun` writes. */
export function parseMonitorLine(line) {
  const m = MONITOR_LINE.exec(String(line));
  if (!m) return null;
  let error = null;
  if (m[7]) { try { error = JSON.parse(m[7]); } catch { error = m[7]; } }
  return { at: m[1], rows: Number(m[2]), actionable: Number(m[3]), notified: Number(m[4]), suppressed: Number(m[5]), ms: Number(m[6]), error, runId: m[8] ?? null, raw: String(line) };
}

const part = (key, over) => ({ key, title: { doctor: "Doctor", monitor: "Monitor", release: "Release check" }[key], command: HISTORY_COMMANDS[key],
  status: "none", at: null, outcome: null, reason: null, note: null, rows: [], summary: {}, ...over });

/** Doctor: the snapshot `monitor` writes after each run. `snap` is `readSnapshot()`'s own result. */
export function shapeDoctorHistory(snap) {
  const note = "Doctor is run by `propagate monitor`, which saves its answer after each run; this is that saved answer, not a run the page started.";
  if (!snap) return part("doctor", { status: "error", reason: "the doctor snapshot reader gave no result", note });
  if (snap.ok === false && snap.payload?.error) {
    return part("doctor", { status: "failed", at: snap.payload.generatedAt ?? null, reason: snap.reason, note,
      summary: { lastGoodAt: snap.payload.lastGoodAt ?? null }, outcome: "the last run failed" });
  }
  if (snap.ok === false) {
    const never = /^no snapshot yet/.test(String(snap.reason));
    return part("doctor", never ? { status: "none", reason: "no recorded run — " + snap.reason, note } : { status: "error", reason: String(snap.reason ?? "the snapshot could not be read"), note });
  }
  const sections = snap.payload?.sections;
  if (!Array.isArray(sections) || sections.length === 0) {
    return part("doctor", { status: "error", reason: "the snapshot is present but holds no sections, so there is nothing to show (it is not a clean run)", note });
  }
  const t = snap.payload.totals ?? {};
  const n = (k) => (typeof t[k] === "number" ? t[k] : null);
  const rows = sections.map((s, i) => ({ id: `${i}|${s.name}`, name: String(s.name), pass: s.pass ?? 0, warn: s.warn ?? 0, fail: s.fail ?? 0, accepted: s.accepted ?? 0 }));
  return part("doctor", {
    status: "recorded", at: snap.payload.generatedAt ?? null, note, rows,
    outcome: `${n("fail") ?? "?"} fail · ${n("warn") ?? "?"} warn · ${n("accepted") ?? "?"} accepted · ${n("pass") ?? "?"} pass`,
    summary: { sections: rows.length, problems: snap.payload.problems ?? null, failing: (n("fail") ?? 0) > 0 },
  });
}

/** Monitor: the last `HISTORY_ROWS` lines of `monitor.log`. `log` is `{exists, lines:[string], reason?}`. */
export function shapeMonitorHistory(log, limit = HISTORY_ROWS) {
  const note = "monitor.log holds one line per run that reached its logging step. A dry run, and a run that died before logging, leave no line.";
  if (!log) return part("monitor", { status: "error", reason: "the monitor log reader gave no result", note });
  if (log.reason) return part("monitor", { status: "error", reason: log.reason, note });
  if (!log.exists) return part("monitor", { status: "none", reason: "no recorded run — there is no monitor.log, so monitor has never run here", note });
  const parsed = log.lines.map(parseMonitorLine);
  const good = parsed.filter(Boolean);
  const unparsed = parsed.length - good.length;
  // A log with lines and no readable run is a reader that does not understand the file, not a quiet monitor.
  if (parsed.length > 0 && good.length === 0) {
    return part("monitor", { status: "error", reason: `monitor.log has ${parsed.length} lines and none match the format logRun writes — the scan has gone blind, it has not found nothing`, note });
  }
  if (parsed.length === 0) return part("monitor", { status: "none", reason: "no recorded run — monitor.log exists and is empty", note });
  const last = good[good.length - 1];
  const rows = good.slice(-limit).reverse().map((x, i) => ({ id: `${x.at}|${x.runId ?? i}`, at: x.at, rows: x.rows, actionable: x.actionable, notified: x.notified, suppressed: x.suppressed, ms: x.ms, error: x.error, runId: x.runId, raw: x.raw }));
  return part("monitor", {
    status: "recorded", at: last.at, note, rows,
    outcome: last.error ? `could not look: ${last.error}` : `${last.actionable} actionable · ${last.notified} notified · ${last.suppressed} suppressed`,
    summary: { runs: good.length, notifiedRuns: good.filter((x) => x.notified > 0).length, couldNotLook: good.filter((x) => x.error).length, unparsedLines: unparsed, shown: rows.length, limit },
  });
}

/**
 * Release. `release --check` records its per-gate result in `release-checks.jsonl` (lib/core/release-record.mjs); the
 * generic command ledger (`runs`, `readRuns().runs`) keeps only the exit status and duration. Both are read:
 *  - a recorded run gives its overall result and every gate (status, detail);
 *  - a ledger run with no recorded run beside it stays listed as "exit status only", labelled with WHY it has no gate result
 *    (before the file existed, or the run ended before its gates finished, or it was a usage error);
 *  - a corrupt line in the file is a row of its own with its reason, never skipped.
 * `checks` is `readReleaseChecks()`'s result, `{reason}` when it could not be read, or undefined when the caller passes
 * none (then the page is the ledger-only view it was before the file existed).
 */
const LEDGER_ONLY = "Which gate passed or failed is not recorded: `release --check` writes no result of its own. The command ledger keeps only the exit status (ok = exit 0 = READY; error = BLOCKED, INCOMPLETE or a usage error, which it cannot tell apart) and the duration.";
const RECORDED_SINCE = "2026-10-17";
/** A ledger row is written at process exit and a record at the end of the gates: the same run when the record is the earlier and within this. */
const SAME_RUN_MS = 30000;
export function shapeReleaseHistory(runs, limit = HISTORY_ROWS, checks = undefined) {
  const hasChecks = checks !== undefined;
  const recorded = hasChecks && Array.isArray(checks?.checks) ? checks.checks : [];
  const bad = hasChecks ? (Array.isArray(checks?.bad) ? checks.bad.map((b) => ({ line: b.line, reason: b.reason })) : checks?.reason ? [{ line: null, reason: "release-checks.jsonl could not be read: " + checks.reason }] : []) : [];
  if (!Array.isArray(runs) && !recorded.length && !bad.length) return part("release", { status: "error", reason: runs?.reason ?? "the command ledger reader gave no result", note: LEDGER_ONLY });
  const ledger = Array.isArray(runs) ? runs.filter((r) => r && r.command === "release" && typeof r.ts === "string") : [];
  const firstRecorded = recorded.length ? recorded[0].ts : null;
  const tms = (iso) => Date.parse(iso);
  const covered = (r) => recorded.some((c) => { const d = tms(r.ts) - tms(c.ts); return d >= 0 && d <= SAME_RUN_MS; });
  const ledgerOnly = ledger.filter((r) => !covered(r)).sort((x, y) => (x.ts < y.ts ? -1 : x.ts > y.ts ? 1 : 0));
  if (!recorded.length && !ledgerOnly.length && !bad.length) {
    return part("release", { status: "none", reason: hasChecks ? "no recorded run — neither release-checks.jsonl nor the command ledger holds a release run" : "no recorded run — the command ledger holds no release run, and release --check does not persist its result", note: hasChecks ? null : LEDGER_ONLY, summary: {}, bad });
  }
  const rows = [
    ...recorded.map((c) => ({ id: `${c.ts}|rec`, at: c.ts, recorded: true, overall: c.overall, outcome: c.exitCode === 0 ? "ok" : "error", exitCode: c.exitCode ?? null, version: c.version ?? null, gates: c.gates.map((g) => ({ name: g.name, status: g.status, detail: g.detail ?? g.reason ?? null })), ms: null, origin: null })),
    ...ledgerOnly.map((r, i) => ({ id: `${r.ts}|${i}`, at: r.ts, recorded: false, outcome: r.outcome ?? null, ms: num(r.duration_ms), origin: r.origin ?? null,
      why: firstRecorded && r.ts >= firstRecorded ? "exit status only: no gate result was recorded for this run (it ended before its gates finished, or it was a usage error)" : `exit status only: it ran before gate results were recorded (${RECORDED_SINCE})` })),
  ].sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0));
  const shown = rows.slice(0, limit);
  const last = recorded.length ? recorded[recorded.length - 1] : null;
  const lastLedger = ledgerOnly.length ? ledgerOnly[ledgerOnly.length - 1] : null;
  const summary = !hasChecks ? { runs: ledgerOnly.length, nonZero: rows.filter((r) => r.outcome !== "ok").length, shown: shown.length, limit, gateResultsRecorded: false } : { runs: recorded.length + ledgerOnly.length, recorded: recorded.length, ledgerOnly: ledgerOnly.length, unreadableLines: bad.length, nonZero: rows.filter((r) => r.outcome !== "ok").length, shown: shown.length, limit, gateResultsRecorded: recorded.length > 0 };
  const gatesOf = (c) => c.gates.map((g) => ({ name: g.name, status: g.status, detail: g.detail ?? g.reason ?? null }));
  if (last && (!lastLedger || last.ts >= lastLedger.ts)) {
    return part("release", { status: "recorded", at: last.ts, rows: shown, bad, summary,
      outcome: `${String(last.overall).toUpperCase()}${last.version ? " · v" + last.version : ""}`,
      gates: gatesOf(last),
      note: ledgerOnly.length ? "Runs marked \"exit status only\" have no gate result; they are listed from the command ledger." : null });
  }
  const base = lastLedger
    ? (lastLedger.outcome === "ok" ? "exited 0 (READY)" : lastLedger.outcome === "error" ? "exited non-zero (BLOCKED, INCOMPLETE or a usage error)" : lastLedger.outcome ? `exited non-zero (${lastLedger.outcome})` : "outcome not recorded")
    : null;
  return part("release", {
    status: "partial", at: lastLedger ? lastLedger.ts : null, rows: shown, bad, summary,
    note: LEDGER_ONLY,
    outcome: base ?? (bad.length ? "no readable result" : null),
    ...(last ? { gates: gatesOf(last) } : {}),
  });
}

export function shapeHistory({ doctor, monitor, release, releaseChecks }) {
  const parts = [shapeDoctorHistory(doctor), shapeMonitorHistory(monitor), shapeReleaseHistory(release, HISTORY_ROWS, releaseChecks)];
  return { detail: { parts, summary: { withARecord: parts.filter((p) => p.status === "recorded" || p.status === "partial" || p.status === "failed").length, of: parts.length, limit: HISTORY_ROWS } } };
}

/** The default sources. Imports are lazy so a server that never serves this route never loads them. */
export const defaultSources = {
  async claims() {
    const { claimsCheck } = await import("../claims/check.mjs");
    const { describe, CHECK_LABELS } = await import("../../commands/claims.mjs");
    const { WORKSPACES } = await import("../core/config.mjs");
    const r = await claimsCheck({ workspaces: WORKSPACES });
    if (!r.coverage || !r.coverage.filesChecked) blind("claims check read 0 files");
    return shapeClaims(r, CHECK_LABELS, describe);
  },

  async rules() {
    const { checkRules, ruleCoverage } = await import("../rules/rules-check.mjs");
    const { RULES_DIR, SEARCH_ROOTS } = await import("../core/config.mjs");
    const { CLAUDE_GLOBAL_CLAUDE_MD } = await import("../core/paths.mjs");
    const g = CLAUDE_GLOBAL_CLAUDE_MD;
    const res = checkRules({ rulesDir: RULES_DIR, roots: SEARCH_ROOTS, extra: [g], exclude: [g] });
    // `diagnostic` is the check's own word for "did not run" (no rules, roots missing, nothing scanned).
    if (res.diagnostic !== "ok") blind(`rules check did not run (${res.diagnostic})`);
    const cov = ruleCoverage({ rulesDir: RULES_DIR, roots: SEARCH_ROOTS, extra: [g] });
    return shapeRules(res, cov);
  },

  async caps() {
    const { capsReport } = await import("./caps.mjs");
    const r = capsReport();
    if (r.scopeDegraded) throw new Error(`caps could not place the files: ${r.scopeDegraded}`);
    if (!r.totals.measured) blind("caps measured 0 files");
    return shapeCaps(r);
  },

  async skills() {
    const { scanSkills, summarize, probeTranscripts, NEVER_INVOKED_MEANS } = await import("../skills/skills-scan.mjs");
    const tx = probeTranscripts();
    const scan = scanSkills({ transcripts: tx.byName });
    if (scan.error) throw new Error(`cannot read ${scan.skillsDir}: ${scan.error}`);
    const sum = summarize(scan);
    if (!sum.total) blind("skills found 0 skills");
    return shapeSkills(scan, tx, Date.now(), NEVER_INVOKED_MEANS);
  },

  async backlog() {
    const { backlog, priorityCaveat } = await import("./backlog.mjs");
    const r = backlog();
    const files = (r.totals?.stateFilesRead ?? 0) + (r.totals?.todoFilesRead ?? 0) + (r.totals?.issueFilesRead ?? 0);
    if (!files) blind("backlog found 0 STATE, TODOS or ISSUES files");
    return shapeBacklog(r, priorityCaveat);
  },

  async goals() {
    const { parseGoalsFile } = await import("./goals.mjs");
    const { discoverBacklogFiles } = await import("./backlog.mjs");
    const files = (discoverBacklogFiles().goalsMd ?? []).map(parseGoalsFile);
    if (!files.length) blind("goals found no GOALS.md");
    // Plans ride the Goals page. A failure there is carried INSIDE the detail (the page shows it where the plans table
    // would be); it must not take the goals tile down with it, and the goals tile never depends on plans.
    let plans;
    try {
      const { checkPlans } = await import("./plans.mjs");
      const root = path.resolve(import.meta.dirname, "../..");
      plans = shapePlans(checkPlans([{ path: root, external: false }]));
      if (plans.ok && !plans.summary.scanned) plans = { ok: false, error: `plans check scanned 0 markdown files under ${root} -- it ran and looked at nothing` };
    } catch (err) {
      plans = { ok: false, error: String(err?.message ?? err) };
    }
    return shapeGoals(files, plans);
  },

  /** Page-only. Reads what release, monitor and doctor LEFT ON DISK; runs none of them. */
  async history() {
    // Each part settles on its own: a part that cannot be read is an error STATE on that part, with its reason,
    // and never takes the other two down or reads as "nothing recorded".
    const part = async (fn) => { try { return { v: await fn() }; } catch (err) { return { err: String(err?.message ?? err) }; } };
    const [doctor, monitor, release, releaseChecks] = await Promise.all([
      part(async () => (await import("./doctor/snapshot.mjs")).readSnapshot()),
      part(async () => {
        const { MONITOR_LOG } = await import("./monitor.mjs");
        const { existsSync, readFileSync } = await import("node:fs");
        if (!existsSync(MONITOR_LOG)) return { exists: false, lines: [] };
        return { exists: true, lines: readFileSync(MONITOR_LOG, "utf8").split("\n").filter(Boolean) };
      }),
      part(async () => (await (await import("../core/runs.mjs")).readRuns()).runs),
      // The per-gate record `release --check` leaves of its own (lib/core/release-record.mjs), from the env-aware state dir.
      part(async () => (await import("../core/release-record.mjs")).readReleaseChecks({ stateDir: (await import("../core/paths.mjs")).stateDir() })),
    ]);
    return shapeHistory({
      doctor: doctor.err ? { ok: false, reason: "doctor snapshot could not be read: " + doctor.err } : doctor.v,
      monitor: monitor.err ? { reason: "monitor.log could not be read: " + monitor.err } : monitor.v,
      release: release.err ? { reason: "the command ledger could not be read: " + release.err } : release.v,
      releaseChecks: releaseChecks.err ? { reason: releaseChecks.err } : releaseChecks.v,
    });
  },
};

/** One source, settled into a block. A throw becomes `error` with its message; nothing becomes 0. */
export function toBlock(settled) {
  if (settled.status === "rejected") {
    const reason = String(settled.reason?.message ?? settled.reason ?? "the source gave no reason");
    return { status: "error", reason, count: null, of: null, label: null, top: null };
  }
  const v = settled.value ?? {};
  if (typeof v.count !== "number") {
    return { status: "error", reason: "the source returned no count", count: null, of: null, label: null, top: null };
  }
  return { status: "ok", reason: null, count: v.count, of: typeof v.of === "number" ? v.of : null, label: v.label ?? "", top: v.top ?? "" };
}

/** The six tile sources that have a page, and so carry `detail`. (Phase 4a: the first four; Phase 4b: backlog and goals.) */
export const DETAIL_KEYS = ["claims", "rules", "caps", "skills", "backlog", "goals"];

/** Sources with a page and NO tile. They ride the same cached run but are not blocks of the tile payload. */
export const PAGE_ONLY_KEYS = ["history"];

/**
 * All six in parallel; each settles on its own. Returns the tile payload; the row detail of the four
 * paged sources rides along as a NON-ENUMERABLE `details` map, so `JSON.stringify` of the tile payload
 * stays small and the views read the very same computation (`createMachinery().readDetail`).
 */
export async function computeMachinery(sources = defaultSources) {
  // The page-only sources run in the same parallel batch (one cached run for everything). A source an injected map
  // does not define is simply not run and is reported as "not configured" on its page, never as an empty one.
  const pageKeys = PAGE_ONLY_KEYS.filter((k) => typeof sources[k] === "function");
  const [settled, pageSettled] = await Promise.all([
    Promise.allSettled(MACHINERY_KEYS.map((k) => Promise.resolve().then(() => sources[k]()))),
    Promise.allSettled(pageKeys.map((k) => Promise.resolve().then(() => sources[k]()))),
  ]);
  const out = { ok: true, generatedAt: new Date().toISOString(), ttlMs: MACHINERY_TTL_MS };
  MACHINERY_KEYS.forEach((k, i) => { out[k] = toBlock(settled[i]); });
  const details = {};
  MACHINERY_KEYS.forEach((k, i) => {
    const v = settled[i].status === "fulfilled" ? settled[i].value : null;
    if (DETAIL_KEYS.includes(k) && out[k].status === "ok" && v && v.detail) details[k] = v.detail;
  });
  // A page-only source's failure is kept beside its detail, so its page can show the reason.
  const pageFailures = {};
  pageKeys.forEach((k, i) => {
    const r = pageSettled[i];
    if (r.status === "rejected") pageFailures[k] = String(r.reason?.message ?? r.reason ?? "the source gave no reason");
    else if (r.value && r.value.detail) details[k] = r.value.detail;
    else pageFailures[k] = "the source returned no rows";
  });
  Object.defineProperty(out, "details", { value: details, enumerable: false });
  Object.defineProperty(out, "pageFailures", { value: pageFailures, enumerable: false });
  return out;
}

/**
 * The cached reader a server holds. `read()` returns the SAME object inside `ttlMs`, and
 * concurrent callers on a cold cache share one computation (two tabs must not start twelve
 * reads). A response in which every source failed is not kept: caching "nothing worked" for a
 * minute would hold a person on an outage the next try might not have.
 */
export function createMachinery({ sources = defaultSources, ttlMs = MACHINERY_TTL_MS, now = Date.now } = {}) {
  let held = null;     // { at, value }
  let inflight = null;
  const read = async ({ fresh = false } = {}) => {
    // `fresh` skips the held value (the header refresh button: a person who asked for new numbers
    // must not get a minute-old answer back). It still joins a computation already in flight.
    if (!fresh && held && now() - held.at < ttlMs) return held.value;
    if (inflight) return inflight;
    inflight = computeMachinery(sources).then((value) => {
      if (MACHINERY_KEYS.some((k) => value[k].status === "ok")) held = { at: now(), value };
      return value;
    }).finally(() => { inflight = null; });
    return inflight;
  };
  return {
    read,
    /**
     * One page's data, from the SAME computation as the tile. `{ok:true, ...detail, headline}` or
     * `{ok:false, error}` when that source failed -- a failed source is its reason, never an empty table.
     */
    async readDetail(key, opts = {}) {
      if (PAGE_ONLY_KEYS.includes(key)) {
        const all = await read(opts);
        if (all.details[key]) return { ok: true, generatedAt: all.generatedAt, ttlMs: all.ttlMs, headline: null, ...all.details[key] };
        return { ok: false, error: all.pageFailures[key] ?? `the ${key} source is not configured` };
      }
      if (!DETAIL_KEYS.includes(key)) return { ok: false, error: `no such view: ${key}` };
      const all = await read(opts);
      const b = all[key];
      if (b.status !== "ok") return { ok: false, error: b.reason || "the source gave no reason" };
      const d = all.details[key];
      if (!d) return { ok: false, error: `the ${key} source returned a count but no rows` };
      return { ok: true, generatedAt: all.generatedAt, ttlMs: all.ttlMs, headline: { count: b.count, of: b.of, label: b.label }, ...d };
    },
  };
}
