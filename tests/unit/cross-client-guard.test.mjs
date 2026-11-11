// propagate#117: the client-isolation guard over ordinary cross-repo edges.
//
// Fixtures are LITERAL rows and workspace arrays on purpose. Do not refactor them
// onto a shared builder: a builder that only emits valid rows is exactly how a guard
// becomes unreachable from its own suite (rule:mutate-behind-the-fixture-builder).
// Workspace names are invented.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { crossClientViolations, legacyCrossEntries } from "../../lib/edges/cross-repo.mjs";
import { Reporter } from "../../lib/report/doctor/reporter.mjs";
import { checkCrossRepoEdges } from "../../lib/report/doctor/cross.mjs";

const HUB = "/hub-x";
const WS = [
  { root: "/hub-x/clientA" }, { root: "/hub-x/clientB" }, { root: "/hub-x/clientC" },
  { root: "/hub-x/clientD" }, { root: "/hub-x/clientE" }, { root: "/hub-x/clientF" },
  { root: "/hub-x/clientG" }, { root: "/hub-x/clientH" }, { root: "/hub-x/clientI" },
  { root: "/hub-x/clientJ" },
  { root: "/hub-x/clientA/nested-svc" }, // a workspace nested inside clientA: still owned by clientA
];
const PLATFORM = ["/hub-x/platformP"];
const row = (id, src, dst) => ({ edge_id: id, sameRepo: false, source: { path: src }, downstream: { path: dst } });

test("hub-to-client edge passes", () => {
  const r = crossClientViolations(
    [row("e1", "/hub-x/CLAUDE.md", "/hub-x/clientA/docs/x.md"), row("e1b", "/hub-x/clientB/a.md", "/hub-x/scripts/b.md")],
    { hubRoot: HUB, workspaces: WS, platformRoots: PLATFORM },
  );
  assert.equal(r.blind, null);
  assert.equal(r.violations.length, 0);
  assert.equal(r.examined, 2);
});

test("a client to its own nested workspace passes", () => {
  const r = crossClientViolations(
    [row("e2", "/hub-x/clientA/app/a.md", "/hub-x/clientA/nested-svc/b.md")],
    { hubRoot: HUB, workspaces: WS, platformRoots: PLATFORM },
  );
  assert.equal(r.violations.length, 0);
});

test("client A to client B fails and names both", () => {
  const r = crossClientViolations(
    [row("e3", "/hub-x/clientA/a.md", "/hub-x/clientB/b.md")],
    { hubRoot: HUB, workspaces: WS, platformRoots: PLATFORM },
  );
  assert.equal(r.violations.length, 1);
  assert.equal(r.violations[0].ownerA, "/hub-x/clientA");
  assert.equal(r.violations[0].ownerB, "/hub-x/clientB");
  assert.equal(r.violations[0].edge_id, "e3");
});

test("client A to a platform root passes (either end)", () => {
  const r = crossClientViolations(
    [
      row("e4", "/hub-x/clientA/a.md", "/hub-x/clientB/platformP-nested/b.md"),
      row("e5", "/hub-x/clientB/b.md", "/hub-x/clientC/c.md"),
    ],
    // platform root deliberately placed INSIDE a client so the exemption, not the owner test, is what passes e4
    { hubRoot: HUB, workspaces: WS, platformRoots: ["/hub-x/clientB/platformP-nested"] },
  );
  assert.deepEqual(r.violations.map((v) => v.edge_id), ["e5"], "only the edge with no platform end fails");
});

test("a platform root that contains the hub is dropped, so it exempts nothing", () => {
  const r = crossClientViolations(
    [row("e6", "/hub-x/clientA/a.md", "/hub-x/clientB/b.md")],
    { hubRoot: HUB, workspaces: WS, platformRoots: ["/"] },
  );
  assert.equal(r.violations.length, 1);
});

test("same-repo rows are not examined", () => {
  const r = crossClientViolations(
    [
      { edge_id: "s", sameRepo: true, source: { path: "/hub-x/clientA/a" }, downstream: { path: "/hub-x/clientB/b" } },
      row("e7", "/hub-x/CLAUDE.md", "/hub-x/clientA/x"),
    ],
    { hubRoot: HUB, workspaces: WS, platformRoots: PLATFORM },
  );
  assert.equal(r.examined, 1);
  assert.equal(r.violations.length, 0);
});

test("an empty corpus is a blind scan, not a pass", () => {
  const none = crossClientViolations([], { hubRoot: HUB, workspaces: WS, platformRoots: PLATFORM });
  assert.match(none.blind, /scan has gone blind/);
  const noCross = crossClientViolations(
    [{ edge_id: "s", sameRepo: true, source: { path: "/a" }, downstream: { path: "/b" } }],
    { hubRoot: HUB, workspaces: WS, platformRoots: PLATFORM },
  );
  assert.match(noCross.blind, /0 cross-repo rows among 1/);
  const fewWs = crossClientViolations([row("e", "/hub-x/CLAUDE.md", "/hub-x/clientA/x")], { hubRoot: HUB, workspaces: WS.slice(0, 3), platformRoots: [] });
  assert.match(fewWs.blind, /only 3 workspace/);
});

test("doctor: a blind scan is inconclusive and votes; a violation fails; a clean scan passes", () => {
  const base = { hubRoot: HUB, workspaces: WS, platformRoots: PLATFORM, searchRoots: [] };
  const blind = new Reporter();
  checkCrossRepoEdges({ ...base, reporter: blind, rows: [] });
  assert.equal(blind.entries.find((e) => e.label === "cross-client edges").kind, "inconclusive");
  assert.equal(blind.problems, 1);

  const bad = new Reporter();
  checkCrossRepoEdges({ ...base, reporter: bad, rows: [row("e", "/hub-x/clientA/a", "/hub-x/clientB/b")] });
  assert.equal(bad.entries.find((e) => e.label === "cross-client edge").kind, "fail");

  const ok = new Reporter();
  checkCrossRepoEdges({ ...base, reporter: ok, rows: [row("e", "/hub-x/CLAUDE.md", "/hub-x/clientB/b")] });
  const line = ok.entries.find((e) => e.label === "cross-client edges");
  assert.equal(line.kind, "pass");
  assert.match(line.detail, /^1 cross-repo edges examined/);
});

test("doctor: a tree with fewer than two client workspaces has nothing to guard, and does not vote", () => {
  const rep = new Reporter();
  checkCrossRepoEdges({
    reporter: rep, rows: [], hubRoot: HUB, workspaces: [{ root: "/hub-x/clientA" }], platformRoots: [], searchRoots: [],
  });
  const line = rep.entries.find((e) => e.label === "cross-client edges");
  assert.equal(line.kind, "info");
  assert.equal(rep.problems, 0);
});

// Legacy .propagates-cross.yml: every entry fails; an absent file adds no failing line.
test("legacy .propagates-cross.yml entries fail with the move instruction; absent file is clean", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "legacy-cross-"));
  const ws = path.join(parent, "clientZ"); await mkdir(ws, { recursive: true });
  await writeFile(path.join(ws, ".propagates-cross.yml"), `
platform_contracts:
  - source: svc/motherboard.json
    kind: contract
    why: a push entry left behind
    affects:
      - { path: ../Platform/registration.go, why: the platform file it feeds }
  - watch: ../Platform/registration.go
    kind: contract
    why: a pull entry left behind
    for: svc/index.js
`);
  const rep = new Reporter();
  checkCrossRepoEdges({ reporter: rep, rows: [], hubRoot: null, workspaces: [], platformRoots: [], searchRoots: [parent] });
  const fails = rep.entries.filter((e) => e.kind === "fail");
  assert.equal(fails.length, 2, "one failure per entry");
  for (const f of fails) assert.equal(f.label, "legacy .propagates-cross.yml entry");
  for (const f of fails) assert.match(f.detail, /move it to \.propagates\.yml \(propagate#117\)/);
  assert.equal(rep.problems, 2);

  const clean = await mkdtemp(path.join(tmpdir(), "legacy-cross-none-"));
  await mkdir(path.join(clean, "clientY"), { recursive: true });
  const rep2 = new Reporter();
  checkCrossRepoEdges({ reporter: rep2, rows: [], hubRoot: null, workspaces: [], platformRoots: [], searchRoots: [clean] });
  assert.equal(rep2.entries.filter((e) => e.kind === "fail").length, 0);
  assert.equal(legacyCrossEntries([clean]).entries.length, 0);
});
