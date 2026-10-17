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
 * Nothing here writes. The sources are the same reads the CLI does.
 */

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
    const { backlog } = await import("./backlog.mjs");
    const r = backlog();
    const files = (r.totals?.stateFilesRead ?? 0) + (r.totals?.todoFilesRead ?? 0) + (r.totals?.issueFilesRead ?? 0);
    if (!files) blind("backlog found 0 STATE, TODOS or ISSUES files");
    const items = r.ranked ?? [];
    const unranked = items.filter((i) => i.priority === null || i.priority === undefined || i.priority === "").length;
    const first = items.find((i) => i.priority !== null && i.priority !== undefined && i.priority !== "");
    return {
      count: unranked,
      of: items.length,
      label: "items with no priority",
      top: first ? `top: P${first.priority} ${clip(String(first.text).replace(/\*\*/g, ""), 70)}` : `${files} files read`,
    };
  },

  async goals() {
    const { parseGoalsFile, goalCounts } = await import("./goals.mjs");
    const { discoverBacklogFiles } = await import("./backlog.mjs");
    const files = (discoverBacklogFiles().goalsMd ?? []).map(parseGoalsFile);
    if (!files.length) blind("goals found no GOALS.md");
    const c = goalCounts(files);
    return {
      count: c.open,
      of: c.total,
      label: "open goals",
      top: `${c.files} files` + (c.unread ? ` · ${c.unread} unreadable` : "") + (c.uncheckable ? ` · ${c.uncheckable} cannot be checked` : "") + (c.closed ? ` · ${c.closed} closed` : ""),
    };
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

/** The four sources that have a page, and so carry `detail`. */
export const DETAIL_KEYS = ["claims", "rules", "caps", "skills"];

/**
 * All six in parallel; each settles on its own. Returns the tile payload; the row detail of the four
 * paged sources rides along as a NON-ENUMERABLE `details` map, so `JSON.stringify` of the tile payload
 * stays small and the views read the very same computation (`createMachinery().readDetail`).
 */
export async function computeMachinery(sources = defaultSources) {
  const settled = await Promise.allSettled(MACHINERY_KEYS.map((k) => Promise.resolve().then(() => sources[k]())));
  const out = { ok: true, generatedAt: new Date().toISOString(), ttlMs: MACHINERY_TTL_MS };
  MACHINERY_KEYS.forEach((k, i) => { out[k] = toBlock(settled[i]); });
  const details = {};
  MACHINERY_KEYS.forEach((k, i) => {
    const v = settled[i].status === "fulfilled" ? settled[i].value : null;
    if (DETAIL_KEYS.includes(k) && out[k].status === "ok" && v && v.detail) details[k] = v.detail;
  });
  Object.defineProperty(out, "details", { value: details, enumerable: false });
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
