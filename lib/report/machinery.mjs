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

/** The default sources. Imports are lazy so a server that never serves this route never loads them. */
export const defaultSources = {
  async claims() {
    const { claimsCheck } = await import("../claims/check.mjs");
    const { WORKSPACES } = await import("../core/config.mjs");
    const r = await claimsCheck({ workspaces: WORKSPACES });
    if (!r.coverage || !r.coverage.filesChecked) blind("claims check read 0 files");
    const byCheck = new Map();
    for (const f of r.findings) byCheck.set(f.check, (byCheck.get(f.check) ?? 0) + 1);
    const top = [...byCheck].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([c, n]) => `${n} ${c}`).join(" · ");
    const unread = (r.files?.unreadable?.length ?? 0) + (r.sidecars?.unreadable?.length ?? 0);
    return {
      count: r.findings.length,
      label: "findings",
      top: (top || "no findings") + ` · ${r.coverage.filesChecked} files checked` + (unread ? ` · ${unread} unreadable` : ""),
    };
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
    const unexercised = cov.filter((c) => c.status === "unexercised").length;
    const restated = res.findings.length;
    const excused = res.referencedRestatements?.length ?? 0;
    return {
      count: unexercised + restated,
      of: res.rules.length,
      label: "rules to look at",
      top: `${unexercised} unexercised · ${restated} restated` + (excused ? ` · ${excused} more restate one they also cite` : ""),
    };
  },

  async caps() {
    const { capsReport } = await import("./caps.mjs");
    const r = capsReport();
    if (r.scopeDegraded) throw new Error(`caps could not place the files: ${r.scopeDegraded}`);
    if (!r.totals.measured) blind("caps measured 0 files");
    const worst = r.records.filter((x) => x.status === "over").sort((a, b) => b.actual / b.cap - a.actual / a.cap)[0];
    return {
      count: r.totals.over,
      of: r.totals.measured,
      label: "files over cap",
      top: worst ? `worst ${(worst.actual / worst.cap).toFixed(1)}x · ${short(worst.file)}` : "none over cap",
    };
  },

  async skills() {
    const { scanSkills, summarize, probeTranscripts } = await import("../skills/skills-scan.mjs");
    const tx = probeTranscripts();
    const scan = scanSkills({ transcripts: tx.byName });
    if (scan.error) throw new Error(`cannot read ${scan.skillsDir}: ${scan.error}`);
    const sum = summarize(scan);
    if (!sum.total) blind("skills found 0 skills");
    const best = scan.skills.filter((s) => s.usageCount > 0).sort((a, b) => b.usageCount - a.usageCount)[0];
    return {
      count: sum.neverInvoked,
      of: sum.total,
      label: "never invoked",
      top: (best ? `most used ${best.id} (${best.usageCount})` : "none used")
        + (tx.scanned ? "" : " · transcript probe unavailable, so this rests on the usage counter alone"),
    };
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

/** All six in parallel; each settles on its own. */
export async function computeMachinery(sources = defaultSources) {
  const settled = await Promise.allSettled(MACHINERY_KEYS.map((k) => Promise.resolve().then(() => sources[k]())));
  const out = { ok: true, generatedAt: new Date().toISOString(), ttlMs: MACHINERY_TTL_MS };
  MACHINERY_KEYS.forEach((k, i) => { out[k] = toBlock(settled[i]); });
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
  return {
    // `fresh` skips the held value (the header refresh button: a person who asked for new numbers
    // must not get a minute-old answer back). It still joins a computation already in flight.
    async read({ fresh = false } = {}) {
      if (!fresh && held && now() - held.at < ttlMs) return held.value;
      if (inflight) return inflight;
      inflight = computeMachinery(sources).then((value) => {
        if (MACHINERY_KEYS.some((k) => value[k].status === "ok")) held = { at: now(), value };
        return value;
      }).finally(() => { inflight = null; });
      return inflight;
    },
  };
}
