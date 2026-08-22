/**
 * graph-index.mjs — a queryable graph projection over the state ledger.
 *
 * WHY THIS EXISTS. propagate already computes a DAG (`lib/graph.mjs`: Tarjan SCC
 * condensation, longest-path-from-root layering, transitive `blockedBy`) but it
 * lives only in memory, and `index.db` — which IS a derived projection with the
 * right discipline — does not contain a single edge. So "what can this file
 * reach", "which decisions bind it", "how often does this edge break" have no
 * answer you can query. This closes that.
 *
 * WHAT IT IS NOT. Not a source of truth. The append-only event store and the
 * git-versioned `.propagates.yml` sidecars stay authoritative; this is a
 * projection of them. That is the whole safety argument — see REBUILD SEMANTICS.
 *
 * REBUILD SEMANTICS (inherited from lib/index-db.mjs, deliberately identical):
 * full re-derivation every time, DROP + CREATE every table, no incremental
 * logic. Because it is disposable it cannot become the thing that drifts, and
 * an engine that dies is a migration rather than data loss. Two consecutive
 * rebuilds must produce byte-identical output; everything below is sorted to
 * make that true rather than true-by-luck.
 *
 * ENGINE-AGNOSTIC ON PURPOSE. The expensive, correctness-critical part is
 * extraction, not storage. `emitSqlite` and `emitCypher` consume the same
 * in-memory model, so Kùzu or Neo4j can be judged against real queries without
 * betting the projection on either. Kùzu was archived 2025-10-10 (Apple
 * acquisition, 0.11.3 final), DuckPGQ is explicitly not production-ready, and
 * Neo4j embedded is Enterprise-only — no engine has earned a hard dependency.
 *
 * READ-ONLY over the corpus: this module never writes a ledger, a sidecar,
 * STATE.md or DECISIONS.md. The only thing it writes is its own db / .cypher.
 *
 * THE PARSER TRAP THIS FILE AVOIDS. `lib/index-db.mjs:190-194` has its own
 * `Affects:` parser — a bold-only regex plus a naive comma split — which N12's
 * fix never reached. It still produces live rows like `'portfolio (gdoc'` and
 * `'globals.css)'`. Decision archaeology built on that returns garbage, so this
 * module uses `lib/decisions.mjs`'s `parseDecisions()` (bare + bold forms,
 * `normalizeAffectsToken`) and nothing else. Do not "simplify" it back.
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";

import { reconcile } from "../edges/reconcile.mjs";
import { buildGraph, blockedBy } from "./graph.mjs";
import { readEvents } from "../edges/events.mjs";
import { parseDecisions } from "../report/decisions.mjs";

/** Node kinds. `file` covers anything an edge can point at; `decision` is a DECISIONS.md entry. */
export const NODE_KINDS = Object.freeze(["file", "project", "decision"]);

/**
 * Edge kinds, chosen so a property-graph engine can map `kind` -> relationship
 * type with no translation layer.
 *   DECLARES — a declared coupling from a sidecar. Carries the reconcile state.
 *   AFFECTS  — a decision to a target named in its `Affects:` line.
 *   BLOCKS   — derived: an unsettled upstream that gates verifying this edge.
 */
export const EDGE_KINDS = Object.freeze(["DECLARES", "AFFECTS", "IN", "BLOCKS"]);

const SCHEMA_SQL = `
CREATE TABLE node (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL,
  kind TEXT NOT NULL,
  path TEXT,
  workspace TEXT,
  layer INTEGER,
  scc TEXT,
  in_deg INTEGER,
  out_deg INTEGER
);
CREATE UNIQUE INDEX idx_node_key ON node(key);
CREATE INDEX idx_node_kind ON node(kind);
CREATE INDEX idx_node_path ON node(path);

CREATE TABLE edge (
  src INTEGER NOT NULL,
  dst INTEGER NOT NULL,
  kind TEXT NOT NULL,
  state TEXT,
  edge_id TEXT,
  why TEXT,
  glob TEXT
);
CREATE INDEX idx_edge_src ON edge(src);
CREATE INDEX idx_edge_dst ON edge(dst);
CREATE INDEX idx_edge_kind ON edge(kind);
CREATE INDEX idx_edge_edge_id ON edge(edge_id);

-- Drift history. Events are facts about an edge over time, not graph nodes;
-- keeping them in their own table avoids inflating the DAG with 1k+ leaves.
--
-- Full-rebuild engine (see REBUILD SEMANTICS above): DROP + CREATE every
-- time, so adding columns here is free and needs no migration for the live
-- store. by/observed_on_ref/source_content/downstream_content were present
-- on every event and previously dropped on ingest; observed_at_commit/
-- observed_on_branch/observed_dirty/by_kind are additive fields a sibling
-- lane (W1) is introducing and are absent (SQL NULL, never a fabricated
-- default) on every event minted before that landed. The four downstream_*
-- columns are the same story one lane later (2026-08-22): an edge has two
-- ends, and until then only the SOURCE end's ref/commit/branch/dirty was
-- recorded. They are NULL on all 1,912 events minted before that, which is
-- a different fact from "resolution failed" (also NULL here, but carrying
-- downstream_on_ref_error in the JSONL) and from "working-tree".
CREATE TABLE event (
  event_id TEXT,
  edge_id TEXT,
  node_id TEXT,
  disposition TEXT,
  ts TEXT,
  reason TEXT,
  by TEXT,
  observed_on_ref TEXT,
  source_content TEXT,
  downstream_content TEXT,
  observed_at_commit TEXT,
  observed_on_branch TEXT,
  observed_dirty INTEGER,
  by_kind TEXT,
  downstream_on_ref TEXT,
  downstream_at_commit TEXT,
  downstream_on_branch TEXT,
  downstream_dirty INTEGER
);
CREATE INDEX idx_event_edge_id ON event(edge_id);
CREATE INDEX idx_event_ts ON event(ts);
CREATE INDEX idx_event_event_id ON event(event_id);

-- Files in a docs tree that no sidecar names — propagate defect C1's blind spot.
CREATE TABLE coverage_gap (
  path TEXT,
  reason TEXT
);

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

const TABLES = ["node", "edge", "event", "coverage_gap", "meta"];

/**
 * DECISIONS.md lives at `docs/DECISIONS.md` in most repos here and at the root
 * in a few. Both are checked per workspace; missing ones are skipped, and the
 * resulting count lands in stats so "zero decisions" is visibly a finding rather
 * than a silent pass.
 */
function defaultDecisionsFiles(workspaces) {
  const out = [];
  for (const w of workspaces) {
    for (const rel of ["docs/DECISIONS.md", "DECISIONS.md"]) {
      const p = path.join(w.root, rel);
      if (existsSync(p)) out.push(p);
    }
  }
  return out;
}

/**
 * Derive the whole model in memory. Pure with respect to the corpus: reads, never writes.
 *
 * @param {Array<{root: string}>} workspaces - as returned by discoverWorkspacesSync
 * @param {{decisionsFiles?: string[]}} opts
 */
export async function buildModel(workspaces, opts = {}) {
  const { rows } = await reconcile(workspaces);
  const graph = buildGraph(rows, { workspaceRoots: workspaces.map((w) => w.root) });

  // ── nodes ────────────────────────────────────────────────────────────────
  // Sorted by key so ids are stable across rebuilds. An unsorted Map iteration
  // would still be *correct* but not byte-identical, and the invariant this
  // projection rests on is byte-identical rebuild.
  const nodes = [];
  const idOf = new Map();
  const fileKeys = [...graph.nodes.keys()].sort();
  for (const abs of fileKeys) {
    const n = graph.nodes.get(abs);
    const key = `file:${abs}`;
    idOf.set(key, nodes.length + 1);
    nodes.push({
      id: nodes.length + 1,
      key,
      kind: "file",
      path: abs,
      workspace: n.workspace ?? null,
      layer: n.layer ?? null,
      scc: n.scc == null ? null : String(n.scc),
      in_deg: n.inDeg ?? 0,
      out_deg: n.outDeg ?? 0,
    });
  }

  // ── projects ─────────────────────────────────────────────────────────────
  // `Affects:` names PROJECTS, not files — measured: the live tokens are
  // `marketing-intel`, `vipinkaushik`, `ssjk-mb`, `portfolio`, while node
  // .workspace holds workspace roots like "Vipin Kaushik". Linking a decision
  // straight to a file therefore resolves almost nothing (442 of 445 on the
  // first attempt). A project tier is the join both sides actually share:
  //   (:Decision)-[:AFFECTS]->(:Project)<-[:IN]-(:File)
  const roots = workspaces.map((w) => w.root).sort((a, b) => b.length - a.length);
  const projectOf = (abs) => {
    const root = roots.find((r) => abs === r || abs.startsWith(r + path.sep));
    if (!root) return null;
    const rel = abs.slice(root.length).replace(/^[/\\]/, "");
    const first = rel.split(path.sep)[0];
    // A file directly under the root belongs to the workspace itself.
    return first && rel.includes(path.sep) ? first : path.basename(root);
  };
  const projectNames = [...new Set(fileKeys.map(projectOf).filter(Boolean))].sort();
  for (const pn of projectNames) {
    const key = `project:${pn}`;
    idOf.set(key, nodes.length + 1);
    nodes.push({
      id: nodes.length + 1, key, kind: "project", path: null,
      workspace: null, layer: null, scc: null, in_deg: 0, out_deg: 0,
    });
  }

  // ── decisions ────────────────────────────────────────────────────────────
  // Uses lib/decisions.mjs — see the header. `key` from parseDecisions is
  // already collision-guarded (`date:sha8(affectsRaw)[#n]`), so it is a sound
  // node identity without inventing a second scheme.
  const decisionEdges = [];
  const decisionsFiles = (opts.decisionsFiles || defaultDecisionsFiles(workspaces)).slice().sort();
  for (const file of decisionsFiles) {
    if (!existsSync(file)) continue;
    let entries;
    try {
      entries = parseDecisions(readFileSync(file, "utf8"));
    } catch {
      continue; // unreadable is not undeclared; the count below makes it visible
    }
    for (const e of entries) {
      const key = `decision:${e.key}`;
      if (idOf.has(key)) continue;
      idOf.set(key, nodes.length + 1);
      nodes.push({
        id: nodes.length + 1,
        key,
        kind: "decision",
        path: file,
        workspace: null,
        layer: null,
        scc: null,
        in_deg: 0,
        out_deg: e.tokens.length,
      });
      for (const tok of e.tokens) decisionEdges.push({ from: key, token: tok, title: e.title, date: e.date });
    }
  }

  // ── edges ────────────────────────────────────────────────────────────────
  const edges = [];
  for (const e of graph.edges) {
    const s = idOf.get(`file:${e.from}`);
    const d = idOf.get(`file:${e.to}`);
    if (!s || !d) continue;
    edges.push({
      src: s, dst: d, kind: "DECLARES", state: e.state,
      edge_id: e.edge_id, why: e.why ?? null, glob: e.glob ?? null,
    });
  }

  // IN: file -> project. The join that makes archaeology answerable.
  for (const abs of fileKeys) {
    const pn = projectOf(abs);
    if (!pn) continue;
    const s = idOf.get(`file:${abs}`), d = idOf.get(`project:${pn}`);
    if (s && d) edges.push({ src: s, dst: d, kind: "IN", state: null, edge_id: null, why: null, glob: null });
  }

  // AFFECTS: decision -> project, matched case-insensitively (tokens are
  // lowercase, directories are not). An unmatched token is recorded as
  // UNRESOLVED_TARGET rather than dropped — `portfolio` and `hub` name no
  // directory and honestly do not resolve; that is a finding about the
  // vocabulary, not a bug to paper over.
  const projByLower = new Map(projectNames.map((p) => [p.toLowerCase(), p]));
  for (const de of decisionEdges) {
    const src = idOf.get(de.from);
    if (!src) continue;
    const pn = projByLower.get(de.token.toLowerCase());
    const dst = pn ? idOf.get(`project:${pn}`) : null;
    if (dst) edges.push({ src, dst, kind: "AFFECTS", state: null, edge_id: null, why: de.token, glob: null });
    else edges.push({ src, dst: src, kind: "AFFECTS", state: "UNRESOLVED_TARGET", edge_id: null, why: de.token, glob: null });
  }

  // BLOCKS: the ordering guard, persisted. blockedBy() already walks ancestors
  // with a visited set, so a cycle cannot hang this.
  for (const e of graph.edges) {
    let blockers = [];
    try {
      blockers = blockedBy(graph, e.edge_id) || [];
    } catch {
      blockers = [];
    }
    for (const b of blockers) {
      const bid = b?.edge_id ?? b;
      const upstream = graph.edges.find((x) => x.edge_id === bid);
      if (!upstream) continue;
      const s = idOf.get(`file:${upstream.from}`);
      const d = idOf.get(`file:${e.from}`);
      if (s && d && s !== d) {
        edges.push({ src: s, dst: d, kind: "BLOCKS", state: upstream.state, edge_id: bid, why: null, glob: null });
      }
    }
  }

  // ── events ───────────────────────────────────────────────────────────────
  // `malformed` is carried into stats, never dropped: a line the reader cannot
  // parse must be counted and visible (N1 — a computed-and-discarded count once
  // hid a real row for two months).
  const { events: rawEvents, malformed: eventsMalformed } = await readEvents({});
  const events = rawEvents
    .map((e) => ({
      // events.mjs stamps the field as `event_id` (events.mjs:276), not `id` —
      // `e.id` was always undefined, which is why every indexed event had a
      // NULL event_id (docs/plans/status-temporal-plum.md §5).
      event_id: e.event_id ?? null,
      edge_id: e.edge_id ?? null,
      node_id: e.node_id ?? null,
      disposition: e.disposition ?? null,
      ts: e.ts ?? null,
      reason: e.reason ?? null,
      by: e.by ?? null,
      observed_on_ref: e.observed_on_ref ?? null,
      downstream_on_ref: e.downstream_on_ref ?? null,
      source_content: e.source_content ?? null,
      downstream_content: e.downstream_content ?? null,
      // W1's fields, additive on newer events only — absent on every event
      // minted before that lane landed. Absent must stay SQL NULL, never a
      // fabricated default (rule:discernment-checks §2). observed_dirty is
      // stored as 0/1 because node:sqlite/SQLite have no boolean type; `??`
      // (not `||`) so an explicit `false` still maps to 0, not null.
      observed_at_commit: e.observed_at_commit ?? null,
      observed_on_branch: e.observed_on_branch ?? null,
      observed_dirty: e.observed_dirty == null ? null : e.observed_dirty ? 1 : 0,
      by_kind: e.by_kind ?? null,
      // The downstream half of the same pair (2026-08-22). Same NULL
      // discipline, same 0/1 boolean encoding — deliberately mapped
      // separately from the source half rather than derived from it, so a
      // round trip that aliased the two columns fails loudly instead of
      // reporting the source's ref twice.
      downstream_at_commit: e.downstream_at_commit ?? null,
      downstream_on_branch: e.downstream_on_branch ?? null,
      downstream_dirty: e.downstream_dirty == null ? null : e.downstream_dirty ? 1 : 0,
    }))
    .sort((a, b) => `${a.edge_id}|${a.ts}|${a.event_id}`.localeCompare(`${b.edge_id}|${b.ts}|${b.event_id}`));

  edges.sort((a, b) =>
    `${a.src}|${a.dst}|${a.kind}|${a.edge_id ?? ""}|${a.why ?? ""}`.localeCompare(
      `${b.src}|${b.dst}|${b.kind}|${b.edge_id ?? ""}|${b.why ?? ""}`,
    ),
  );

  return {
    nodes,
    edges,
    events,
    coverageGaps: [],
    stats: {
      nodes: nodes.length,
      files: fileKeys.length,
      decisions: nodes.length - fileKeys.length,
      edges: edges.length,
      declares: edges.filter((e) => e.kind === "DECLARES").length,
      affects: edges.filter((e) => e.kind === "AFFECTS").length,
      inProject: edges.filter((e) => e.kind === "IN").length,
      projects: projectNames.length,
      blocks: edges.filter((e) => e.kind === "BLOCKS").length,
      unresolvedAffects: edges.filter((e) => e.state === "UNRESOLVED_TARGET").length,
      events: events.length,
      eventsMalformed,
      decisionsFiles: decisionsFiles.length,
      graphNodes: graph.stats.nodes,
      graphEdges: graph.stats.edges,
    },
  };
}

/** DROP + CREATE, then insert. Never incremental — see REBUILD SEMANTICS. */
export function emitSqlite(model, dbPath) {
  if (existsSync(dbPath)) rmSync(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = OFF;");
  for (const t of TABLES) db.exec(`DROP TABLE IF EXISTS ${t};`);
  db.exec(SCHEMA_SQL);

  const insNode = db.prepare(
    "INSERT INTO node (id,key,kind,path,workspace,layer,scc,in_deg,out_deg) VALUES (?,?,?,?,?,?,?,?,?)",
  );
  for (const n of model.nodes)
    insNode.run(n.id, n.key, n.kind, n.path, n.workspace, n.layer, n.scc, n.in_deg, n.out_deg);

  const insEdge = db.prepare("INSERT INTO edge (src,dst,kind,state,edge_id,why,glob) VALUES (?,?,?,?,?,?,?)");
  for (const e of model.edges) insEdge.run(e.src, e.dst, e.kind, e.state, e.edge_id, e.why, e.glob);

  const insEvent = db.prepare(
    "INSERT INTO event (event_id,edge_id,node_id,disposition,ts,reason,by,observed_on_ref," +
      "source_content,downstream_content,observed_at_commit,observed_on_branch,observed_dirty,by_kind," +
      "downstream_on_ref,downstream_at_commit,downstream_on_branch,downstream_dirty) " +
      "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  for (const e of model.events)
    insEvent.run(
      e.event_id,
      e.edge_id,
      e.node_id,
      e.disposition,
      e.ts,
      e.reason,
      e.by,
      e.observed_on_ref,
      e.source_content,
      e.downstream_content,
      e.observed_at_commit,
      e.observed_on_branch,
      e.observed_dirty,
      e.by_kind,
      e.downstream_on_ref,
      e.downstream_at_commit,
      e.downstream_on_branch,
      e.downstream_dirty,
    );

  const insGap = db.prepare("INSERT INTO coverage_gap (path,reason) VALUES (?,?)");
  for (const g of model.coverageGaps) insGap.run(g.path, g.reason);

  // Deliberately NO generatedAt timestamp: it would make two rebuilds of the
  // same corpus differ, destroying the byte-identical property this rests on.
  const insMeta = db.prepare("INSERT INTO meta (key,value) VALUES (?,?)");
  for (const [k, v] of Object.entries(model.stats).sort(([a], [b]) => a.localeCompare(b)))
    insMeta.run(k, String(v));

  db.exec(VIEWS_SQL);
  db.close();
  return dbPath;
}

/**
 * The four query classes, as views. Recursive CTEs give transitive closure at
 * this scale without an engine; each is the SQL twin of a Cypher path query.
 */
const VIEWS_SQL = `
-- 1. Blast radius: everything a file can reach through declared couplings.
CREATE VIEW v_blast_radius AS
WITH RECURSIVE reach(origin, id, depth) AS (
  SELECT n.id, n.id, 0 FROM node n WHERE n.kind = 'file'
  UNION
  SELECT r.origin, e.dst, r.depth + 1
  FROM reach r JOIN edge e ON e.src = r.id AND e.kind = 'DECLARES'
  WHERE r.depth < 16
)
SELECT o.path AS origin_path, d.path AS reached_path, MIN(r.depth) AS depth
FROM reach r JOIN node o ON o.id = r.origin JOIN node d ON d.id = r.id
WHERE r.depth > 0 GROUP BY r.origin, r.id;

-- 2. Decision archaeology: which decisions bind a file, via the project tier.
--    (:Decision)-[:AFFECTS]->(:Project)<-[:IN]-(:File)
CREATE VIEW v_archaeology AS
SELECT f.path AS file_path, p.key AS project_key, d.key AS decision_key,
       d.path AS decision_file, a.why AS affects_token
FROM edge a
JOIN node d ON d.id = a.src AND d.kind = 'decision'
JOIN node p ON p.id = a.dst AND p.kind = 'project'
JOIN edge i ON i.dst = p.id AND i.kind = 'IN'
JOIN node f ON f.id = i.src
WHERE a.kind = 'AFFECTS' AND (a.state IS NULL OR a.state <> 'UNRESOLVED_TARGET');

-- 3. Drift history: every recorded disposition for an edge, newest first.
--    event_id is exposed so a specific event can be cited (joined back to),
--    not just aggregated into "this edge's history" — that was the whole
--    defect: event_id was NULL on every row before the join was fixed.
CREATE VIEW v_edge_history AS
SELECT ev.event_id, ev.edge_id, ev.ts, ev.disposition, ev.reason,
       ev.by, ev.observed_on_ref, ev.source_content, ev.downstream_content,
       ev.observed_at_commit, ev.observed_on_branch, ev.observed_dirty, ev.by_kind,
       ev.downstream_on_ref, ev.downstream_at_commit, ev.downstream_on_branch,
       ev.downstream_dirty,
       s.path AS source_path, t.path AS downstream_path
FROM event ev
LEFT JOIN edge e ON e.edge_id = ev.edge_id AND e.kind = 'DECLARES'
LEFT JOIN node s ON s.id = e.src
LEFT JOIN node t ON t.id = e.dst
ORDER BY ev.edge_id, ev.ts DESC;

-- 4. Coverage: declared-nowhere, plus Affects tokens that resolve to no file.
CREATE VIEW v_coverage_gap AS
SELECT path, reason FROM coverage_gap
UNION ALL
SELECT n.path, 'affects token resolves to no node: ' || e.why
FROM edge e JOIN node n ON n.id = e.src
WHERE e.state = 'UNRESOLVED_TARGET';
`;

/**
 * Same model, emitted as a Cypher load script. This is the experiment that
 * decides whether an engine is worth a dependency — run the four queries in
 * Cypher against Kùzu or Neo4j and compare with the views above.
 */
export function emitCypher(model) {
  const esc = (v) => (v == null ? "null" : `'${String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`);
  const out = [];
  out.push("// propagate graph projection — generated by lib/graph-index.mjs");
  out.push("// Derived and disposable: re-emit rather than mutate.");
  for (const n of model.nodes) {
    const label = n.kind === "decision" ? "Decision" : "File";
    out.push(
      `CREATE (:${label} {key:${esc(n.key)}, path:${esc(n.path)}, workspace:${esc(n.workspace)}, ` +
        `layer:${n.layer ?? "null"}, scc:${esc(n.scc)}, inDeg:${n.in_deg}, outDeg:${n.out_deg}});`,
    );
  }
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  for (const e of model.edges) {
    const s = byId.get(e.src), d = byId.get(e.dst);
    if (!s || !d) continue;
    out.push(
      `MATCH (a {key:${esc(s.key)}}), (b {key:${esc(d.key)}}) ` +
        `CREATE (a)-[:${e.kind} {state:${esc(e.state)}, edgeId:${esc(e.edge_id)}, why:${esc(e.why)}}]->(b);`,
    );
  }
  for (const ev of model.events) {
    out.push(
      `CREATE (:Event {eventId:${esc(ev.event_id)}, edgeId:${esc(ev.edge_id)}, ` +
        `disposition:${esc(ev.disposition)}, ts:${esc(ev.ts)}, reason:${esc(ev.reason)}});`,
    );
  }
  return out.join("\n") + "\n";
}
