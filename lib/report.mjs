/**
 * The format that answers "how does this work" without reading code.
 *
 * Section order is deliberate: reference and architecture FIRST, because that is what a
 * methodology or architecture question reaches for. Plans and triage last — they are the
 * debt, not the answer. marketing-intel's docs/ARCHITECTURE.md is the worked example: 478
 * lines, the biggest doc in the repo, one inbound edge, six weeks stale. Any format that
 * buries it under twelve dated plans has failed at the job.
 */

import path from "node:path";
import { stalenessRule } from "./taxonomy.mjs";
import { ageDays } from "./evidence.mjs";

const SECTIONS = [
  { title: "Reference & architecture", kinds: ["functionality-spec", "page-spec", "ops", "design"],
    note: "must never go stale silently" },
  { title: "State & decisions", kinds: ["state", "decision-log"], note: "state rots fastest; decisions are append-only" },
  { title: "Routers", kinds: ["router"], note: "route to other docs; must not restate them" },
  { title: "Plans", kinds: ["plan"], note: "stale by design — the question is whether a state is declared" },
  { title: "Undeclared", kinds: [null], note: "the residue is where the taxonomy is wrong — a value, never a silence" },
];

/** Declared-dead docs still contribute edges; they are listed apart so the live sections are
 *  about live documents, and so the archive is visibly drainable rather than invisible. */
const NOT_LIVE = ["archived", "superseded"];

/** One doc's verdict. Kind decides which question is even asked. */
export function verdict(row, staleDays, hubless = false) {
  const rule = stalenessRule(row.kind);
  const age = ageDays(row.lastTouched?.date);
  // The hub is the root of the reachability question, so it cannot be its own orphan.
  // Without this the table flagged STATE.md and disagreed with the header count — two
  // numbers for one fact, in one document (rule:discernment-checks §5).
  if (row.isUnlinkedSeed) {
    return { flag: "UNLINKED-INDEX", why: "routes to other docs, but nothing routes to it" };
  }
  if (row.isHub) return { flag: "ok", why: "entry point / seed" };
  // An entry point is opened directly, not cited. Zero in-degree is correct for it.
  if (row.isEntryPoint) return { flag: "ok", why: "entry point — read directly, not cited" };
  // Declared dead: exempt from grading, never from parsing. Grading it would re-report a
  // decision someone already made, and the archive would never look done.
  if (row.status === "archived") return { flag: "archived", why: `declared archived (${row.statusSource})` };
  if (row.status === "superseded") return { flag: "superseded", why: `declared superseded (${row.statusSource})` };
  if (row.status === "unknown") return { flag: "BAD-STATUS", why: row.statusWhy ?? "unrecognised status value" };
  // With no reachable hub, "orphan" would be true of nearly every doc and mean nothing.
  if (hubless) return { flag: "no-hub", why: "not graded — no reachable entry point" };
  if (row.inDegree === 0) return { flag: "ORPHAN", why: "nothing cites it" };
  if (row.hubDistance === null) return { flag: "DETACHED", why: `cited only from outside the ${row.hubName} tree` };
  if (rule === "declared-state" && row.declaredState?.state === "undeclared") {
    return { flag: "NO-STATE", why: row.declaredState.why };
  }
  if (rule === "age" && age !== null && age > staleDays) return { flag: "STALE", why: `${age}d since last change` };
  return { flag: "ok", why: age === null ? "age unknown" : `${age}d` };
}

const pad = (s, n) => String(s).padEnd(n);

export function renderMarkdown(result) {
  const { root, rows, graph, staleDays, counts } = result;
  const L = [];
  L.push(`# Doc map — \`${path.basename(root)}\``);
  L.push("");
  if (result.excluded?.count) {
    L.push(`*${result.excluded.count} file(s) excluded as test data or scratch: ${result.excluded.dirs.join(", ")}*`);
    L.push("");
  }
  L.push(`*discovery: ${result.discovery.describe} · taxonomy: ${result.taxonomyNote}*`);
  L.push("");
  if (graph.hubless) {
    L.push(`> **hub: ${graph.hubReason}.** Orphan and detached grading is SUPPRESSED — with no`);
    L.push(`> reachable entry point every document would read as an orphan, which is a confident`);
    L.push(`> wrong answer. Set \`hubSeeds\` in \`.curate-docs.yml\`, or link an entry point to something.`);
    L.push("");
  }
  L.push(
    `${counts.docs} markdown files · hub \`${graph.hubReason}\` · ` +
      `**${counts.orphans} orphan**, **${counts.detached} detached**, ` +
      `**${counts.dangling} dangling citation${counts.dangling === 1 ? "" : "s"}**, ` +
      `${counts.unmerged} unmerged, ${counts.ambiguous} ambiguous, ${counts.external} external · ` +
      `${counts.archived} declared not-live${counts.unknownStatus ? `, **${counts.unknownStatus} bad status**` : ""} · ` +
      `stale threshold ${staleDays}d`,
  );
  if (result.provenanceCapped) {
    L.push("");
    L.push(`*Provenance gathered for the first 60 flagged docs; ${result.provenanceCapped} more were not looked up (4 git calls each).*`);
  }
  L.push("");
  L.push("> Report only. Nothing here has been written to the repo. The verdict for an orphan");
  L.push("> is to declare a state — active, archived, or superseded — not to add a link.");

  const live = rows.filter((r) => !NOT_LIVE.includes(r.status));
  for (const s of SECTIONS) {
    const inSection = live.filter((r) => s.kinds.includes(r.kind));
    if (!inSection.length) continue;
    L.push("", `## ${s.title}`, `*${s.note}*`, "");
    L.push("| Doc | in | hops | last change | verdict |");
    L.push("|---|---:|---:|---|---|");
    for (const r of inSection.sort((a, b) => b.inDegree - a.inDegree || a.rel.localeCompare(b.rel))) {
      const when = r.lastTouched?.date ? r.lastTouched.date.slice(0, 10) : "unknown";
      const via = r.lastTouched?.via === "mtime" ? " *(mtime — untracked)*" : "";
      const v = r.verdict.flag === "ok" ? `ok · ${r.verdict.why}` : `**${r.verdict.flag}** — ${r.verdict.why}`;
      L.push(`| \`${r.rel}\` | ${r.inDegree} | ${r.hubDistance ?? "—"} | ${when}${via} | ${v} |`);
    }
  }

  if (graph.relinkable?.length) {
    L.push("", "## Citations that lost their path", "",
      "*The basename resolves to exactly one document, at a path the citation does not name — the signature of a moved file. Reported, never auto-linked.*", "");
    L.push("| From | Cites | Probably |"); L.push("|---|---|---|");
    for (const r of graph.relinkable) {
      L.push(`| \`${path.relative(root, r.from).split(path.sep).join("/")}\` | \`${r.cites}\` | \`${path.relative(root, r.suggest).split(path.sep).join("/")}\` |`);
    }
  }

  const triage = rows.filter((r) => ["ORPHAN", "DETACHED", "NO-STATE", "BAD-STATUS", "UNLINKED-INDEX"].includes(r.verdict.flag));
  L.push("", "## Needs triage", "");
  if (!triage.length) {
    L.push("None. Every doc has a caller reachable from the hub and every plan declares a state.");
  } else {
    L.push(`${triage.length} document${triage.length === 1 ? "" : "s"}. One decision each, recorded IN the file:`);
    L.push("```");
    L.push("curate-docs impact <doc>                                   # first: what breaks?");
    L.push("curate-docs state  <doc> --set archived --because shipped --apply");
    L.push("```");
    L.push("**active** (cite it from an entry point) · **archived** (`--because shipped|dropped`) ·");
    L.push("**superseded** (`--superseded-by <path>`). Declaring is the archival act — moving the file");
    L.push("breaks every relative link it owns, and buys nothing once the state is in the frontmatter.", "");
    for (const r of triage) {
      L.push(`### \`${r.rel}\` — ${r.verdict.flag}`);
      L.push(`- kind **${r.kind ?? "undeclared"}** (${r.kindSource}) · ${r.verdict.why}`);
      const i = r.evidence?.introducedBy;
      L.push(
        i?.status === "ok"
          ? `- added ${i.date.slice(0, 10)} by ${i.author} — "${i.subject}"`
          : `- introducing commit: ${i?.status ?? "unknown"}`,
      );
      const b = r.evidence?.branches;
      if (b?.status === "ok" && b.branches.length) L.push(`- on branches: ${b.branches.slice(0, 6).join(", ")}`);
      else L.push(`- branches: ${b?.status ?? "unknown"}`);
      const d = r.evidence?.declaredIn;
      if (d?.hits?.length) L.push(`- named by path in: ${d.hits.map((h) => h.where).join(", ")}`);
      else if (d?.weak?.length) L.push(`- basename only (weak, may be a different file) in: ${d.weak.map((h) => h.where).join(", ")}`);
      else L.push(`- named in no sidecar, ledger, STATE or DECISIONS (${d?.searched ?? 0} sources searched)`);
      if (r.outbound?.length) L.push(`- it cites: ${r.outbound.slice(0, 5).join(", ")}`);
      L.push("");
    }
  }

  const notLive = rows.filter((r) => NOT_LIVE.includes(r.status));
  if (notLive.length) {
    L.push("", "## Declared not live", "",
      "*Still parsed, still contributing edges — exempt from grading, never from the graph. Drain when salvaged.*", "");
    L.push("| Doc | status | declared by | in |"); L.push("|---|---|---|---:|");
    for (const r of notLive) L.push(`| \`${r.rel}\` | ${r.status} | ${r.statusSource} | ${r.inDegree} |`);
  }

  if (graph.unmerged?.length) {
    L.push("", "## Cited early — present on another branch", "",
      `*Absent here, present on a ref this branch has not merged. NOT a broken link: deleting the citation would delete a correct forward reference. ${graph.branchScan?.refsChecked ?? 0} ref(s) searched.*`, "");
    L.push("| From | Cites | Lives on |"); L.push("|---|---|---|");
    for (const u of graph.unmerged) {
      L.push(`| \`${path.relative(root, u.from).split(path.sep).join("/")}\` | \`${u.cites}\` | ${u.refs.map((r) => `\`${r}\``).join(", ")} |`);
    }
  }

  if (graph.dangling.length) {
    L.push("## Dangling citations", "", "*Cited from a doc, absent from disk.*", "");
    L.push("| From | Cites |"); L.push("|---|---|");
    for (const d of graph.dangling) {
      L.push(`| \`${path.relative(root, d.from).split(path.sep).join("/")}\` | \`${d.cites}\` |`);
    }
    L.push("");
  }
  if (graph.ambiguous.length) {
    L.push("## Ambiguous citations", "",
      "*A basename that exists, at a path that does not resolve. Not counted as an edge — a wrong relative path is a defect, not a link.*", "");
    L.push("| From | Cites | Possibly |"); L.push("|---|---|---|");
    for (const a of graph.ambiguous) {
      const cands = a.candidates.map((c) => path.relative(root, c).split(path.sep).join("/")).join(", ");
      L.push(`| \`${path.relative(root, a.from).split(path.sep).join("/")}\` | \`${a.cites}\` | ${cands} |`);
    }
  }
  return L.join("\n") + "\n";
}

export { SECTIONS };
