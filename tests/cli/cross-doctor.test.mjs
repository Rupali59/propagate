import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkCrossRepo } from "../../cli.mjs";
import { __setPartnerRootsForTest } from "../../lib/edges/cross-repo.mjs";

test("checkCrossRepo flags a missing external target", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "xdoc-"));
  const mb = path.join(parent, "Motherboard"); await mkdir(mb, { recursive: true });
  await writeFile(path.join(mb, "motherboard.json"), "{}");
  const vk = path.join(parent, "Vipin Kaushik"); await mkdir(vk, { recursive: true });
  await writeFile(path.join(vk, ".propagates-cross.yml"), `
platform_contracts:
  - watch: ../Motherboard/motherboard.json
    kind: contract
    why: real target present
    for: x.ts
  - watch: ../Motherboard/GONE.json
    kind: contract
    why: dead target
    for: y.ts
`);
  __setPartnerRootsForTest([realpathSync(mb)]);
  const res = await checkCrossRepo([parent]);
  assert.equal(res.missing, 1, "one dead external target detected");
  assert.equal(res.edges, 2);
  assert.equal(res.sidecars, 1, "the corpus is reported, not just the verdict (N68)");
});

// ─────────────────────────────────────────────────────────────────────────
// N68 — the check's CORPUS, which is the half that failed silently.
//
// On 2026-09-14 doctor printed `✓ cross-repo edges resolve  4 edges, 0 missing`
// while 7 dead edges sat in a sidecar the walk never opened, because it stopped
// descending at the first one it found. The verdict was true of what it looked
// at and false of the tree. A count of edges cannot express that; a count of
// FILES SCANNED can.
// ─────────────────────────────────────────────────────────────────────────

test("checkCrossRepo reaches a sidecar nested under another, and says how many it opened (N68)", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "xdoc-nest-"));
  const mb = path.join(parent, "Motherboard"); await mkdir(mb, { recursive: true });
  await writeFile(path.join(mb, "motherboard.json"), "{}");

  const ws = path.join(parent, "Workspace"); await mkdir(ws, { recursive: true });
  await writeFile(path.join(ws, ".propagates-cross.yml"), `
platform_contracts:
  - watch: ../Motherboard/motherboard.json
    kind: contract
    why: the OUTER sidecar, which used to end the walk
    for: outer.ts
`);
  // Exactly the shape of Vipin Kaushik/astro-studio: a project sidecar beneath
  // a workspace that has one, carrying an edge to a target that is not there.
  const proj = path.join(ws, "project"); await mkdir(proj, { recursive: true });
  await writeFile(path.join(proj, ".propagates-cross.yml"), `
platform_contracts:
  - watch: ../../Motherboard/ALSO-GONE.json
    kind: contract
    why: the nested sidecar, invisible before N68
    for: inner.ts
`);

  __setPartnerRootsForTest([realpathSync(mb)]);
  const res = await checkCrossRepo([parent]);

  assert.equal(res.sidecars, 2, "BOTH sidecars must be opened — this is the regression guard");
  assert.equal(res.edges, 2, "and both their edges counted");
  assert.equal(res.missing, 1, "the nested sidecar's dead target must be visible to doctor");
  assert.equal(res.unreadable, 0);
});

test("an unparseable sidecar is counted as unreadable, never as clean (N68)", async () => {
  // "Looked and found nothing" vs "could not look" must not share an output.
  const parent = await mkdtemp(path.join(tmpdir(), "xdoc-bad-"));
  const ws = path.join(parent, "Workspace"); await mkdir(ws, { recursive: true });
  await writeFile(path.join(ws, ".propagates-cross.yml"), "platform_contracts: [ : : not yaml\n");

  __setPartnerRootsForTest([]);
  const res = await checkCrossRepo([parent]);

  assert.equal(res.unreadable, 1, "a sidecar that cannot be parsed is reported, not skipped in silence");
  assert.equal(res.sidecars, 0, "and it does not inflate the scanned count");
});
