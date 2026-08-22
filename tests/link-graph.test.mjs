import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildLinkGraph } from "../lib/link-graph.mjs";
import { discover } from "../lib/discovery.mjs";
import { loadConfig } from "../lib/config.mjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "fixtures", "sample-repo");

const rel = (abs) => path.relative(REPO, abs).split(path.sep).join("/");
const HOME = mkdtempSync(path.join(tmpdir(), "cd-h-"));
const cfgFor = (r) => loadConfig(r, { home: HOME });
const discoverDocs = (r, o = {}) => {
  const c = cfgFor(r);
  const f = discover(r, c);
  return o.withExclusions ? { docs: f.docs, excluded: { count: 0, dirs: ["fixtures"] } } : f.docs;
};
const graph = () => { const c = cfgFor(REPO); return buildLinkGraph(REPO, { docs: discover(REPO, c).docs, cfg: c }); };

test("discovers every markdown file in the fixture", () => {
  assert.equal(discoverDocs(REPO).length, 13);
});

test("markdown links produce inbound edges — the form propagate's extractor cannot see", () => {
  const g = graph();
  const arch = g.nodes.get(path.join(REPO, "docs/ARCHITECTURE.md"));
  // STATE.md links it as [architecture](./docs/ARCHITECTURE.md); docs/README.md as ./ARCHITECTURE.md
  assert.deepEqual(arch.inbound.map(rel).sort(), ["STATE.md", "docs/README.md"]);
  assert.equal(arch.inDegree, 2);
});

test("backticked paths also produce inbound edges, resolved against repo root", () => {
  const g = graph();
  const dec = g.nodes.get(path.join(REPO, "docs/DECISIONS.md"));
  // STATE.md `docs/DECISIONS.md` (root-relative) + docs/README.md link + ARCHITECTURE backtick
  assert.deepEqual(dec.inbound.map(rel).sort(), ["STATE.md", "docs/ARCHITECTURE.md", "docs/README.md"]);
});

test("orphans are exactly the zero-inbound docs, excluding the hub itself", () => {
  const g = graph();
  assert.deepEqual(g.orphans.map(rel).sort(), ["docs/plans/2026-01-02-orphan.md"]);
});

test("the hub is not reported as its own orphan", () => {
  const g = graph();
  assert.ok(g.seeds.map(rel).includes("STATE.md"));
  assert.ok(!g.orphans.map(rel).includes("STATE.md"));
});

test("a mutually-linked island has inDegree > 0 yet is detached from the hub", () => {
  const g = graph();
  const a = g.nodes.get(path.join(REPO, "docs/cluster/a.md"));
  assert.equal(a.inDegree, 1, "in-degree alone would call this healthy");
  assert.equal(a.hubDistance, null, "but it is unreachable from STATE.md");
  assert.deepEqual(g.detached.map(rel).sort(), ["docs/cluster/a.md", "docs/cluster/b.md"]);
});

test("hubDistance is MINIMUM hops from any seed, not out-depth (propagate GOTCHAS G45)", () => {
  const g = graph();
  const at = (p) => g.nodes.get(path.join(REPO, p)).hubDistance;
  // Every entry point is a seed, so each sits at 0 — that is the fix for repos whose real
  // hub is docs/README.md or CLAUDE.md rather than STATE.md (correct in 1 of 7 surveyed).
  assert.equal(at("STATE.md"), 0);
  assert.equal(at("docs/README.md"), 0, "docs/README.md is itself a seed under multi-root BFS");
  assert.equal(at("docs/design/DESIGN.md"), 1, "one hop from the nearest seed, not two from STATE.md");
  // The island stays unreachable — distance is from seeds, never invented.
  assert.equal(at("docs/cluster/a.md"), null);
});

test("citations that resolve nowhere are reported as dangling, both link and backtick forms", () => {
  const g = graph();
  const from = path.join(REPO, "docs/specs/api.md");
  const cites = g.dangling.filter((d) => d.from === from).map((d) => d.cites).sort();
  assert.deepEqual(cites, ["./gone.md", "docs/nope.md"]);
});

test("a doc citing its own filename does not self-certify", () => {
  const g = graph();
  for (const [abs, node] of g.nodes) assert.ok(!node.inbound.includes(abs), `${rel(abs)} cites itself`);
});

test("a citation resolving outside the repo is ambiguous, never counted as an edge", () => {
  const g = graph();
  assert.deepEqual(
    g.ambiguous.map((a) => [rel(a.from), a.cites]),
    [["docs/cluster/a.md", "../../../DECISIONS.md"]],
  );
  // DECISIONS.md must NOT have gained an inbound edge from the island.
  const dec = g.nodes.get(path.join(REPO, "docs/DECISIONS.md"));
  assert.ok(!dec.inbound.map(rel).includes("docs/cluster/a.md"));
  assert.equal(dec.inDegree, 3);
});

test("a self-citation is not an inbound edge", () => {
  const g = graph();
  const api = g.nodes.get(path.join(REPO, "docs/specs/api.md"));
  assert.deepEqual(api.inbound.map(rel).sort(), ["docs/README.md", "docs/design/DESIGN.md"]);
  assert.equal(api.inDegree, 2, "the self-citation must not inflate this to 3");
});

test("a backticked path with a leading ../ is a citation", () => {
  const g = graph();
  const state = g.nodes.get(path.join(REPO, "STATE.md"));
  assert.deepEqual(state.inbound.map(rel), ["docs/plans/2026-01-03-sibling.md"],
    "`../../STATE.md` was not seen — propagate's CITED_PATH requires an alphanumeric first char");
});

test("a bare backticked basename resolves against the citing doc's own directory", () => {
  const g = graph();
  const sib = g.nodes.get(path.join(REPO, "docs/plans/2026-01-03-sibling.md"));
  assert.deepEqual(sib.inbound.map(rel), ["docs/plans/2026-01-01-active.md"],
    "`2026-01-03-sibling.md` was not seen — CITED_PATH requires a slash");
  assert.equal(sib.hubDistance, 2, "and so it is reachable, not an island");
});

test("a backticked label inside a markdown link is not a second, ambiguous citation", () => {
  const g = graph();
  // STATE.md writes [`2026-01-01-active.md`](./docs/plans/2026-01-01-active.md).
  assert.deepEqual(g.ambiguous.map((a) => a.cites), ["../../../DECISIONS.md"]);
  assert.equal(g.nodes.get(path.join(REPO, "docs/plans/2026-01-01-active.md")).inDegree, 1);
});

test("a citation resolving to a real file outside the repo is external, not a defect", () => {
  const g = graph();
  assert.deepEqual(
    g.external.map((e) => [rel(e.from), e.cites]),
    [["docs/design/DESIGN.md", "../../../PLAYBOOK.md"]],
  );
  // It must not be double-counted as dangling or ambiguous.
  assert.ok(!g.dangling.some((d) => d.cites.includes("PLAYBOOK")));
  assert.ok(!g.ambiguous.some((a) => a.cites.includes("PLAYBOOK")));
});

test("the skill's own test tree is not mistaken for its documentation", () => {
  const skillRoot = path.join(HERE, "..");
  const rels = discoverDocs(skillRoot).map((d) => path.relative(skillRoot, d).split(path.sep).join("/"));
  assert.ok(rels.includes("STATE.md") && rels.includes("docs/GOTCHAS.md"));
  assert.ok(rels.every((r) => !r.startsWith("tests/")), `test tree leaked: ${rels.filter((r) => r.startsWith("tests/"))}`);
  assert.ok(rels.every((r) => !r.includes("node_modules")));
});

test("root agent-context entry points are exempt from ORPHAN, not silently dropped", () => {
  const g = graph();
  const node = (p) => g.nodes.get(path.join(REPO, p));
  assert.equal(node("CLAUDE.md").isEntryPoint, true);
  assert.equal(node("README.md").isEntryPoint, true);
  assert.ok(!g.orphans.map(rel).includes("CLAUDE.md"),
    "CLAUDE.md/GEMINI.md/AGENTS.md are read by tooling, not cited by docs");
  // Exempt is not invisible: still discovered, still graphed.
  assert.ok(discoverDocs(REPO).some((d) => rel(d) === "CLAUDE.md"));
  // A docs/README.md is NOT a root entry point — an index is something that should be cited.
  assert.equal(node("docs/README.md").isEntryPoint, false);
  assert.deepEqual(g.orphans.map(rel).sort(), ["docs/plans/2026-01-02-orphan.md"]);
});

test("a docs index that seeds reachability but nothing links is UNLINKED-INDEX, not silently ok", () => {
  // docs/README.md is a legitimate starting point (it is the real hub in VipinKaushik and
  // propagate), so it must seed the BFS. But "the docs index and nothing points at it" is a
  // true finding — making it a seed must not swallow it.
  const g = graph();
  const n = g.nodes.get(path.join(REPO, "docs/README.md"));
  assert.equal(n.isSeed, true, "still a seed — reachability is correct");
  assert.equal(n.inDegree, 1, "the sample repo does link it");
  assert.ok(g.unlinkedSeeds !== undefined, "the finding must exist as a reported list");
  assert.deepEqual(g.unlinkedSeeds.map(rel), [], "and be empty when every seed is linked");
});
